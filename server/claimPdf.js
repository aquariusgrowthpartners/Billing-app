/**
 * Builds a claim summary PDF with pdfkit.
 *
 * Everything on the page comes from data already stored against the claim, so
 * the document can be regenerated at any time and will always match the
 * database. Uses pdfkit's built-in standard fonts, so there are no font files
 * to ship.
 */
import PDFDocument from 'pdfkit';

const MARGIN = 50;
const INK = '#1b2130';
const MUTED = '#6b7280';
const RULE = '#d7dbe2';
const ACCENT = '#1f5fd6';

const money = (n) =>
  `$${(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** '2026-10-05' -> 'Oct 5, 2026' (no timezone drift: parsed as local parts). */
function prettyDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return String(iso);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[m - 1]} ${d}, ${y}`;
}

function minutesLabel(total) {
  const t = Math.max(0, Math.trunc(Number(total) || 0));
  const h = Math.floor(t / 60);
  const m = t % 60;
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/**
 * Caretaker for one day. Older entries have no caretaker recorded, so the PDF
 * prints blanks for them rather than inventing a name.
 */
function caretakerName(entry) {
  const name = `${entry?.caretaker_first_name ?? ''} ${entry?.caretaker_last_name ?? ''}`.trim();
  return name;
}

function caretakerNpi(entry) {
  return entry?.caretaker_npi ?? '';
}

/** Unique caretakers who worked the period, for the closing summary. */
function uniqueCaretakers(entries) {
  const map = new Map();
  for (const e of entries) {
    const name = caretakerName(e);
    if (!name) continue;
    if (!map.has(name)) map.set(name, { name, npi: caretakerNpi(e) });
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Single rate if every day agrees, otherwise a clear "varies" marker. */
function rateLabel(entries) {
  const rates = [...new Set(entries.map((e) => Number(e.rate_per_unit)).filter((r) => Number.isFinite(r)))];
  if (!rates.length) return '—';
  if (rates.length === 1) return `${money(rates[0])} per unit`;
  return `${rates.length} rates (see daily breakdown)`;
}

/**
 * @returns {Promise<Buffer>} the finished PDF
 */
export function buildClaimPdf({ claim, client, agreement, caseManager = null, entries = [] }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: MARGIN, info: {
      Title: claim.claim_name ?? `Claim ${claim.id}`,
      Author: 'Billing Calendar',
      Subject: 'Claim summary',
    } });

    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const pageWidth = doc.page.width - MARGIN * 2;
    const right = MARGIN + pageWidth;

    /* ------------------------------------------------------------ header */

    doc.fillColor(INK).font('Helvetica-Bold').fontSize(18).text('CLAIM SUMMARY', MARGIN, MARGIN);
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(MUTED)
      .text(`Generated ${prettyDate(new Date().toISOString().slice(0, 10))}`, MARGIN, MARGIN + 4, {
        width: pageWidth,
        align: 'right',
      });

    doc
      .font('Helvetica-Bold')
      .fontSize(11)
      .fillColor(ACCENT)
      .text(claim.claim_name ?? `Claim #${claim.id}`, MARGIN, MARGIN + 24);

    let y = MARGIN + 44;
    doc.moveTo(MARGIN, y).lineTo(right, y).strokeColor(RULE).lineWidth(1).stroke();
    y += 16;

    /* ------------------------------------------------------- info blocks */

    const columnGap = 24;
    const colWidth = (pageWidth - columnGap) / 2;
    const leftX = MARGIN;
    const rightX = MARGIN + colWidth + columnGap;

    function block(title, rows, x, top, width) {
      let cy = top;
      doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTED).text(title.toUpperCase(), x, cy, { width });
      cy += 14;
      for (const [label, value] of rows) {
        doc.font('Helvetica').fontSize(9.5).fillColor(MUTED).text(label, x, cy, { width: width * 0.42 });
        doc
          .font('Helvetica-Bold')
          .fontSize(9.5)
          .fillColor(INK)
          .text(String(value ?? '—'), x + width * 0.42, cy, { width: width * 0.58 });
        cy += 14;
      }
      return cy;
    }

    // Left column: client, then their case manager directly beneath.
    let leftY = block(
      'Client',
      [
        ['Name', `${client?.first_name ?? ''} ${client?.last_name ?? ''}`.trim()],
        ['Date of birth', prettyDate(client?.dob)],
        ['MA number', client?.ma_number ?? '—'],
      ],
      leftX,
      y,
      colWidth
    );

    if (caseManager) {
      const cmRows = [
        ['Name', `${caseManager.first_name ?? ''} ${caseManager.last_name ?? ''}`.trim()],
      ];
      if (caseManager.organization) cmRows.push(['Organization', caseManager.organization]);
      if (caseManager.email) cmRows.push(['Email', caseManager.email]);
      if (caseManager.phone) cmRows.push(['Phone', caseManager.phone]);
      leftY = block('Case manager', cmRows, leftX, leftY + 12, colWidth);
    }

    const periodBottom = block(
      'Claim period',
      [
        ['From', prettyDate(claim.period_start)],
        ['To', prettyDate(claim.period_end)],
        ['Status', claim.status ?? '—'],
      ],
      leftX,
      leftY + 12,
      colWidth
    );

    // Right column: agreement terms and money.
    let rightY = block(
      'Agreement',
      [
        ['Agreement #', agreement?.agreement_number ?? '—'],
        ['Service code', agreement?.service_code ?? '—'],
        ['Payer', agreement?.payer_name ?? '—'],
      ],
      rightX,
      y,
      colWidth
    );

    rightY = block(
      'Totals',
      [
        ['Total units', claim.total_units ?? 0],
        ['Rate per unit', rateLabel(entries)],
        ['Total dollars', money(claim.total_dollars)],
      ],
      rightX,
      rightY + 12,
      colWidth
    );

    y = Math.max(periodBottom, rightY) + 18;

    /* ---------------------------------------------------- daily breakdown */

    doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTED).text('DAILY BREAKDOWN', MARGIN, y);
    y += 16;

    const cols = [
      { key: 'date', label: 'Date', width: pageWidth * 0.17, align: 'left' },
      { key: 'caretaker', label: 'Caretaker', width: pageWidth * 0.23, align: 'left' },
      { key: 'npi', label: 'NPI', width: pageWidth * 0.16, align: 'left' },
      { key: 'minutes', label: 'Minutes', width: pageWidth * 0.14, align: 'right' },
      { key: 'units', label: 'Units', width: pageWidth * 0.12, align: 'right' },
      { key: 'dollars', label: 'Dollars', width: pageWidth * 0.18, align: 'right' },
    ];

    function drawRow(values, { bold = false, fill = INK } = {}) {
      let x = MARGIN;
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.5).fillColor(fill);
      cols.forEach((c) => {
        doc.text(String(values[c.key] ?? ''), x, y, { width: c.width, align: c.align });
        x += c.width;
      });
      y += 15;
    }

    // Header row
    doc.moveTo(MARGIN, y - 4).lineTo(right, y - 4).strokeColor(RULE).stroke();
    drawRow(
      Object.fromEntries(cols.map((c) => [c.key, c.label])),
      { bold: true, fill: MUTED }
    );
    doc.moveTo(MARGIN, y - 4).lineTo(right, y - 4).strokeColor(RULE).stroke();

    let totalMinutes = 0;
    for (const e of entries) {
      if (y > doc.page.height - MARGIN - 70) {
        doc.addPage();
        y = MARGIN;
      }
      totalMinutes += Number(e.minutes_worked) || 0;
      drawRow({
        date: prettyDate(e.work_date),
        // Blank for entries recorded before caretakers existed.
        caretaker: caretakerName(e),
        npi: caretakerNpi(e),
        minutes: minutesLabel(e.minutes_worked),
        units: e.units ?? 0,
        dollars: money(e.dollars),
      });
    }

    if (!entries.length) {
      doc.font('Helvetica-Oblique').fontSize(9.5).fillColor(MUTED).text('No day entries on this claim.', MARGIN, y);
      y += 15;
    }

    doc.moveTo(MARGIN, y - 4).lineTo(right, y - 4).strokeColor(RULE).stroke();
    drawRow(
      {
        date: 'TOTAL',
        minutes: minutesLabel(totalMinutes),
        units: claim.total_units ?? 0,
        dollars: money(claim.total_dollars),
      },
      { bold: true }
    );

    /* ------------------------------------------------- caretaker summary */

    const crew = uniqueCaretakers(entries);
    y += 8;
    if (y > doc.page.height - MARGIN - 90) {
      doc.addPage();
      y = MARGIN;
    }
    doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTED).text('CARETAKERS IN THIS PERIOD', MARGIN, y);
    y += 15;

    if (crew.length) {
      for (const person of crew) {
        doc.font('Helvetica-Bold').fontSize(9.5).fillColor(INK).text(person.name, MARGIN, y, { width: pageWidth * 0.5 });
        doc
          .font('Helvetica')
          .fontSize(9.5)
          .fillColor(MUTED)
          .text(person.npi ? `NPI ${person.npi}` : 'NPI not recorded', MARGIN + pageWidth * 0.5, y, {
            width: pageWidth * 0.5,
          });
        y += 14;
      }
    } else {
      doc
        .font('Helvetica-Oblique')
        .fontSize(9.5)
        .fillColor(MUTED)
        .text('No caretaker was recorded for these days.', MARGIN, y);
      y += 14;
    }

    const unnamed = entries.filter((e) => !caretakerName(e)).length;
    if (unnamed > 0 && crew.length > 0) {
      doc
        .font('Helvetica')
        .fontSize(8.5)
        .fillColor(MUTED)
        .text(
          `${unnamed} day${unnamed === 1 ? '' : 's'} in this period have no caretaker recorded.`,
          MARGIN,
          y,
          { width: pageWidth }
        );
      y += 12;
    }

    /* ------------------------------------------------------------- footer */

    const footY = doc.page.height - MARGIN - 26;
    doc.moveTo(MARGIN, footY).lineTo(right, footY).strokeColor(RULE).stroke();
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(MUTED)
      .text(
        claim.claim_name ?? '',
        MARGIN,
        footY + 8,
        { width: pageWidth, align: 'left' }
      );

    doc.end();
  });
}

export default buildClaimPdf;
