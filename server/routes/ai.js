/**
 * AI-adjacent file endpoints.
 *
 * The RA verification response is intentionally a stub for now: the upload is
 * validated here, but no document is sent to a model yet.
 */
import express from 'express';
import multer from 'multer';

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
});

function allowedFile(file) {
  const name = String(file?.originalname ?? '');
  return (
    file?.mimetype === 'application/pdf' ||
    String(file?.mimetype ?? '').startsWith('image/') ||
    /\.(pdf|png|jpe?g|webp|heic|heif)$/i.test(name)
  );
}

/**
 * Build the structured prompt that a future model call will receive.
 * Kept server-side so the Azure request shape stays out of the client.
 */
function buildVerificationPrompt(rawText) {
  return [
    'You are verifying a home-care Remittance Advice (RA) against the agency records.',
    'Return valid JSON with this shape:',
    '{"status":"verified"|"failed","discrepancies":[{"field":"...","expected":"...","found":"..."}]}',
    'Only flag discrepancies supported by the extracted text.',
    '',
    'RAW RA TEXT:',
    rawText.slice(0, 16000),
  ].join('\n');
}

/** POST /api/ai/verify-ra — multipart field name: file */
router.post('/verify-ra', (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) {
      const message =
        err.code === 'LIMIT_FILE_SIZE'
          ? 'That file is larger than the 15 MB limit.'
          : 'The file could not be uploaded.';
      return res.status(400).json({ error: message });
    }
    if (!req.file) return res.status(400).json({ error: 'Choose a PDF or image to verify.' });
    if (!allowedFile(req.file)) {
      return res.status(400).json({ error: 'Upload a PDF or image file.' });
    }

    const file = {
      name: req.file.originalname,
      mime: req.file.mimetype,
      size: req.file.size,
    };

    if (req.file.mimetype !== 'application/pdf' && !/\.pdf$/i.test(file.name)) {
      return res.status(422).json({
        error: 'Image OCR is not enabled yet. Upload the RA as a PDF for text extraction.',
        file,
      });
    }

    let rawText = '';
    try {
      const { PDFParse } = await import('pdf-parse');
      const parser = new PDFParse({ data: req.file.buffer });
      try {
        const result = await parser.getText();
        rawText = String(result?.text ?? '').trim();
      } finally {
        await parser.destroy?.();
      }
    } catch (parseError) {
      console.warn(`[ai] RA extraction failed: ${parseError.message}`);
      return res.status(422).json({ error: 'Could not read any text from that PDF.', file });
    }

    if (!rawText) {
      return res.status(422).json({ error: 'The PDF contains no extractable text.', file });
    }

    res.json({
      status: 'extracted',
      raw_text: rawText,
      ai_prompt: buildVerificationPrompt(rawText),
      file,
      checked_at: new Date().toISOString(),
    });
  });
});

export default router;
