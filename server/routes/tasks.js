/**
 * Task tracker + new-hire onboarding.
 *
 * The status sync is the important part: a caretaker's `status` and the legacy
 * `active` boolean are two fields for one concept, so they are ALWAYS written
 * together in the same transaction. Anything that updates one updates both.
 */
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import multer from 'multer';
import db, { DB_PATH } from '../db.js';
import { summarise, complete } from '../aiService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Uploads live NEXT TO the database, not in the repo.
 *
 * When BILLING_DB points at a copy (e.g. /tmp/hha24/verify4100.db) the files go
 * to /tmp/hha24/task_uploads/, so an isolated test never writes into the live
 * data directory. Without this, pointing BILLING_DB at a copy isolates the rows
 * but not the files.
 */
const UPLOAD_DIR = path.join(path.dirname(DB_PATH), 'task_uploads');
/**
 * Path stored in the DB.
 *
 * Normally repo-relative (`data/task_uploads/x.pdf`) so the API can serve it as
 * a URL. When BILLING_DB lives outside the repo the relative path would escape
 * with `../..`, which no route can serve — so store the absolute path instead
 * and let the caller treat it as a filesystem path.
 */
const REPO_ROOT = path.join(__dirname, '..', '..');
const storedPathFor = (filename) => {
  const abs = path.join(UPLOAD_DIR, filename);
  const rel = path.relative(REPO_ROOT, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return abs.split(path.sep).join('/');
  return rel.split(path.sep).join('/');
};
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

const router = express.Router();

/** The standard onboarding documents, in the order they should be worked. */
export const NEW_HIRE_CHECKLIST = [
  'Background Check Clearance',
  'Fingerprinting Completion',
  'PCA/CFSS Worker Certificate',
  'NPI Letter',
];

const safeName = (v) => String(v ?? 'document').replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80);

/**
 * Extract text from an uploaded document, or null. Never throws.
 *
 * Real PDFs go through pdf-parse. Anything that is not a PDF is decoded as
 * UTF-8 when it looks like plain text, so a .txt resume or a pasted note works
 * too — the wizard accept list offers images as well, but without OCR those
 * will (correctly) fail with "could not read any text".
 */
async function pdfText(buffer) {
  const head = buffer.subarray(0, 5).toString('latin1');
  const looksPdf = head.startsWith('%PDF');

  if (!looksPdf) {
    const asText = buffer.toString('utf8');
    // printable ratio: reject binary junk that only happens to decode
    const printable = (asText.match(/[\t\n\r\x20-\x7E\u00A0-\uFFFF]/g) || []).length;
    if (asText.trim() && printable / asText.length > 0.9) return asText;
    return null;
  }

  try {
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: buffer });
    try {
      const { text } = await parser.getText();
      return text ?? null;
    } finally {
      await parser.destroy().catch(() => {});
    }
  } catch (err) {
    console.warn(`[tasks] pdf text extraction failed: ${err.message}`);
    return null;
  }
}

/** A 10-digit NPI, labelled or bare. */
export function extractNpi(text) {
  if (!text) return null;
  const labelled = text.match(
    /(?:NPI|National\s+Provider\s+Identifier)[^0-9]{0,40}(\d{10})/i
  );
  if (labelled) return labelled[1];
  const bare = text.match(/\b(1\d{9})\b/);
  return bare ? bare[1] : null;
}

/** GET /api/tasks — every task with its checklist progress. */
router.get('/', (req, res) => {
  const tasks = db
    .prepare(
      `SELECT t.*,
              c.first_name AS caretaker_first,
              c.last_name  AS caretaker_last,
              c.status     AS caretaker_status,
              (SELECT COUNT(*) FROM task_checklist_items i
                WHERE i.task_id = t.id AND i.agency_id = t.agency_id) AS total_items,
              (SELECT COUNT(*) FROM task_checklist_items i
                WHERE i.task_id = t.id AND i.is_completed = 1
                  AND i.agency_id = t.agency_id) AS completed_items
         FROM tasks t
         LEFT JOIN caretakers c ON c.id = t.caretaker_id AND c.agency_id = t.agency_id
        WHERE t.agency_id = @agency
        ORDER BY (t.status = 'completed'), t.due_date IS NULL, t.due_date, t.id DESC`
    )
    .all({ agency: req.agencyId });

  res.json({
    tasks: tasks.map((t) => ({
      ...t,
      progress: t.total_items ? t.completed_items / t.total_items : 0,
      items: db
        .prepare(
          `SELECT id, label, is_completed, document_path, completed_at, sort_order
             FROM task_checklist_items WHERE task_id = ? AND agency_id = ?
             ORDER BY sort_order, id`
        )
        .all(t.id, req.agencyId),
    })),
  });
});

/**
 * POST /api/tasks/new-hire
 *
 * Creates the caretaker and the onboarding task together. A new hire starts
 * Pending / inactive and only becomes Active when the last document lands.
 */
router.post('/new-hire', (req, res) => {
  const b = req.body ?? {};
  const first = String(b.first_name ?? '').trim();
  const last = String(b.last_name ?? '').trim();
  if (!first || !last) {
    return res.status(400).json({ error: 'First and last name are required.' });
  }

  try {
    const result = db.transaction(() => {
      const ct = db
        .prepare(
          `INSERT INTO caretakers
             (first_name, last_name, dob, ssn, dl_number, npi_number,
              street_address, city, state, zip, phone,
              status, active, agency_id)
           VALUES (@first, @last, @dob, @ssn, @dl, @npi,
                   @street, @city, @state, @zip, @phone,
                   'Pending', 0, @agency)`
        )
        .run({
          first,
          last,
          dob: b.dob || null,
          ssn: b.ssn || null,
          dl: b.dl_number || null,
          npi: b.npi_number || null,
          street: b.street_address || null,
          city: b.city || null,
          state: b.state || null,
          zip: b.zip || null,
          phone: b.phone || null,
          agency: req.agencyId,
        });
      const caretakerId = Number(ct.lastInsertRowid);

      const task = db
        .prepare(
          `INSERT INTO tasks (title, type, status, due_date, caretaker_id, agency_id)
           VALUES (@title, 'new_hire', 'pending', @due, @ct, @agency)`
        )
        .run({
          title: `New hire — ${first} ${last}`,
          due: b.due_date || null,
          ct: caretakerId,
          agency: req.agencyId,
        });
      const taskId = Number(task.lastInsertRowid);

      const ins = db.prepare(
        `INSERT INTO task_checklist_items (task_id, label, is_completed, sort_order, agency_id)
         VALUES (?, ?, 0, ?, ?)`
      );
      NEW_HIRE_CHECKLIST.forEach((label, i) => ins.run(taskId, label, i, req.agencyId));

      return { caretakerId, taskId };
    })();

    res.status(201).json({
      task_id: result.taskId,
      caretaker_id: result.caretakerId,
      checklist: NEW_HIRE_CHECKLIST,
    });
  } catch (err) {
    console.error(`[tasks] new-hire failed: ${err.message}`);
    res.status(500).json({ error: 'Could not create the onboarding task', detail: err.message });
  }
});

/**
 * POST /api/tasks/:taskId/items/:itemId/upload
 *
 * Attaching the final document is what activates the caretaker, so the
 * completion check runs inside the same transaction as the file update.
 */
router.post('/:taskId/items/:itemId/upload', upload.single('file'), async (req, res) => {
  const taskId = Number(req.params.taskId);
  const itemId = Number(req.params.itemId);
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const item = db
    .prepare(
      'SELECT * FROM task_checklist_items WHERE id = ? AND task_id = ? AND agency_id = ?'
    )
    .get(itemId, taskId, req.agencyId);
  if (!item) return res.status(404).json({ error: 'Checklist item not found' });
  const task = db
    .prepare('SELECT * FROM tasks WHERE id = ? AND agency_id = ?')
    .get(taskId, req.agencyId);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const filename = `${taskId}_${itemId}_${stamp}_${safeName(req.file.originalname)}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, filename), req.file.buffer);
  const storedPath = storedPathFor(filename);

  /*
   * An NPI letter is the one document that carries data we want, so read it
   * before the transaction. Extraction failure is logged and ignored: the file
   * is still uploaded and the item still completes.
   */
  let npiFound = null;
  if (/npi/i.test(item.label)) {
    const text = await pdfText(req.file.buffer);
    npiFound = extractNpi(text);
    if (!npiFound) console.warn(`[tasks] no NPI found in ${req.file.originalname}`);
  }

  let activated = false;

  try {
    db.transaction(() => {
      db.prepare(
        `UPDATE task_checklist_items
            SET is_completed = 1, document_path = ?, completed_at = datetime('now')
          WHERE id = ? AND agency_id = ?`
      ).run(storedPath, itemId, req.agencyId);

      if (npiFound && task.caretaker_id) {
        db.prepare('UPDATE caretakers SET npi_number = ? WHERE id = ? AND agency_id = ?').run(
          npiFound,
          task.caretaker_id,
          req.agencyId
        );
      }

      const remaining = db
        .prepare(
          'SELECT COUNT(*) n FROM task_checklist_items WHERE task_id = ? AND is_completed = 0 AND agency_id = ?'
        )
        .get(taskId, req.agencyId).n;

      if (remaining === 0) {
        db.prepare("UPDATE tasks SET status = 'completed' WHERE id = ? AND agency_id = ?").run(
          taskId,
          req.agencyId
        );
        if (task.caretaker_id) {
          // status and active must move together or they drift
          db.prepare(
            "UPDATE caretakers SET status = 'Active', active = 1 WHERE id = ? AND agency_id = ?"
          ).run(task.caretaker_id, req.agencyId);
          activated = true;
        }
      }
    })();
  } catch (err) {
    console.error(`[tasks] upload failed: ${err.message}`);
    return res.status(500).json({ error: 'Upload failed', detail: err.message });
  }

  res.json({
    item_id: itemId,
    document_path: storedPath,
    npi_number: npiFound,
    task_completed: remaining_all_done(db, taskId, req.agencyId),
    caretaker_activated: activated,
  });
});

/**
 * POST /api/tasks/general
 *
 * A standalone task with no caretaker. If a document is attached its text is
 * summarised — via OpenAI when a key exists, locally otherwise.
 */
router.post('/general', upload.single('file'), async (req, res) => {
  const b = req.body ?? {};
  const title = String(b.title ?? '').trim();
  if (!title) return res.status(400).json({ error: 'A title is required.' });

  let storedPath = null;
  let summary = null;
  let summarySource = null;

  if (req.file) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const filename = `general_${stamp}_${safeName(req.file.originalname)}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, filename), req.file.buffer);
    storedPath = storedPathFor(filename);

    const text = await pdfText(req.file.buffer);
    if (text) {
      const r = await summarise(text);
      summary = r.summary;
      summarySource = r.source;
    }
  }

  try {
    const info = db
      .prepare(
        `INSERT INTO tasks (title, type, status, due_date, caretaker_id, ai_summary, agency_id)
         VALUES (@title, 'general', 'pending', @due, NULL, @summary, @agency)`
      )
      .run({ title, due: b.due_date || null, summary, agency: req.agencyId });
    const taskId = Number(info.lastInsertRowid);

    if (storedPath) {
      db.prepare(
        `INSERT INTO task_checklist_items
           (task_id, label, is_completed, document_path, completed_at, sort_order, agency_id)
         VALUES (?, ?, 1, ?, datetime('now'), 0, ?)`
      ).run(taskId, b.notes?.trim() || 'Attached document', storedPath, req.agencyId);
    }

    res.status(201).json({
      task_id: taskId,
      ai_summary: summary,
      summary_source: summarySource,
      document_path: storedPath,
    });
  } catch (err) {
    console.error(`[tasks] general task failed: ${err.message}`);
    res.status(500).json({ error: 'Could not create the task', detail: err.message });
  }
});

/** True when the task has no outstanding items. */
function remaining_all_done(database, taskId, agencyId) {
  return (
    database
      .prepare(
        'SELECT COUNT(*) n FROM task_checklist_items WHERE task_id = ? AND is_completed = 0 AND agency_id = ?'
      )
      .get(taskId, agencyId).n === 0
  );
}


/**
 * POST /api/tasks/parse-new-hire
 *
 * Reads an ID or resume and returns structured fields for the wizard.
 *
 * The model is asked for JSON only, but models wrap JSON in prose or fences
 * constantly, so the response is parsed defensively: find the first {...} block
 * and validate the keys we care about. A parse failure returns an empty field
 * set rather than a 500 — a blank form is recoverable, an error is not.
 */
const NEW_HIRE_FIELDS = [
  'first_name', 'last_name', 'dob', 'ssn', 'dl_number',
  'street_address', 'city', 'state', 'zip',
];

router.post('/parse-new-hire', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const text = await pdfText(req.file.buffer);
  if (!text || !text.trim()) {
    return res.status(422).json({
      error: 'Could not read any text from that file. If it is a scan, try a PDF with a text layer.',
    });
  }

  const prompt = [
    'Extract the following info from this document and return ONLY a JSON object with keys:',
    'first_name, last_name, dob, ssn, dl_number, street_address, city, state, zip.',
    'If missing, leave blank. Use ISO dates (YYYY-MM-DD) for dob. No prose, no markdown fences.',
    '',
    text.slice(0, 12000),
  ].join('\n');

  const { text: raw, source } = await complete(prompt, {
    system: 'You extract structured data from documents. Reply with JSON only.',
    timeoutMs: 20000,
  });

  const fields = Object.fromEntries(NEW_HIRE_FIELDS.map((k) => [k, '']));

  const match = String(raw ?? '').match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      for (const k of NEW_HIRE_FIELDS) {
        const v = parsed?.[k];
        if (v != null && String(v).trim()) fields[k] = String(v).trim();
      }
    } catch (err) {
      console.warn(`[tasks] parse-new-hire JSON failed: ${err.message}`);
    }
  }

  res.json({ fields, source, extracted_any: Object.values(fields).some(Boolean) });
});

export default router;
