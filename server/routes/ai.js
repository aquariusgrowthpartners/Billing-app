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

/** POST /api/ai/verify-ra — multipart field name: file */
router.post('/verify-ra', (req, res) => {
  upload.single('file')(req, res, (err) => {
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

    res.json({
      status: 'verified',
      discrepancies: [],
      file: {
        name: req.file.originalname,
        mime: req.file.mimetype,
        size: req.file.size,
      },
      checked_at: new Date().toISOString(),
    });
  });
});

export default router;
