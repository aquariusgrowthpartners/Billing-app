/**
 * AI-adjacent file endpoints.
 *
 * RA verification is vision-first: PDFs are rasterised (first page) and sent
 * to Azure with the image, because RA letters are commonly scanned sideways.
 * The text completion functions in aiService.js are untouched.
 */
import express from 'express';
import multer from 'multer';
import { verifyRaDocument } from '../aiService.js';

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

async function pdfFirstPagePng(buffer) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { createCanvas } = await import('canvas');

  const doc = await getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
  }).promise;

  try {
    const page = await doc.getPage(1);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, viewport, background: '#ffffff' }).promise;
    return canvas.toBuffer('image/png');
  } finally {
    await doc.cleanup?.();
  }
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

    const isPdf =
      req.file.mimetype === 'application/pdf' || /\.pdf$/i.test(req.file.originalname);
    let pngBuffer;
    let mimeType;
    try {
      if (isPdf) {
        pngBuffer = await pdfFirstPagePng(req.file.buffer);
        mimeType = 'image/png';
      } else {
        pngBuffer = req.file.buffer;
        mimeType = req.file.mimetype || 'image/png';
      }
    } catch (renderError) {
      console.warn(`[ai] RA rasterise failed: ${renderError.message}`);
      return res.status(422).json({
        error: 'Could not render that RA. Try a different PDF or a clear image.',
      });
    }

    const result = await verifyRaDocument(
      pngBuffer.toString('base64'),
      mimeType,
      req.agencyId
    );

    if (result.error) {
      const status = result.error.includes('quota provisioning') ? 503 : 502;
      return res.status(status).json({ error: result.error });
    }

    // The frontend consumes the extracted records array directly.
    res.json(result.records);
  });
});

export default router;
