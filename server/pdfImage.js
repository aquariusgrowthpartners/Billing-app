/**
 * Shared PDF orientation and page-to-image helpers used by RA verification and
 * its local test script.
 */
import { PDFDocument, degrees } from 'pdf-lib';

export async function normalizePdfRotation(buffer) {
  const pdf = await PDFDocument.load(buffer);
  let changed = false;
  for (const page of pdf.getPages()) {
    const rawAngle = page.getRotation()?.angle ?? 0;
    const angle = ((rawAngle % 360) + 360) % 360;
    if (angle !== 0) {
      console.log(`[PDF-ROTATION] Detected rotation: ${angle} degrees. Rotated to 0.`);
      page.setRotation(degrees(0));
      changed = true;
    }
  }
  return changed ? Buffer.from(await pdf.save()) : buffer;
}

export async function renderPdfPagePng(buffer, pageNumber = 3) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { createCanvas } = await import('canvas');
  const doc = await getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
  }).promise;
  try {
    const pageNo = Math.min(Math.max(Number(pageNumber) || 1, 1), doc.numPages);
    const page = await doc.getPage(pageNo);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, viewport, background: '#ffffff' }).promise;
    console.log(`[PDF-IMAGE] Rendered page ${pageNo} of ${doc.numPages} at ${canvas.width}x${canvas.height}.`);
    return canvas.toBuffer('image/png');
  } finally {
    await doc.cleanup?.();
  }
}

/** Keep only one page as a standalone PDF for Vision's input_file payload. */
export async function extractPdfPage(buffer, pageNumber = 3) {
  const src = await PDFDocument.load(buffer);
  const pageNo = Math.min(Math.max(Number(pageNumber) || 1, 1), src.getPageCount());
  const out = await PDFDocument.create();
  const [page] = await out.copyPages(src, [pageNo - 1]);
  page.setRotation(degrees(0));
  out.addPage(page);
  console.log(`[PDF-IMAGE] Extracted page ${pageNo} of ${src.getPageCount()} as a one-page PDF.`);
  return Buffer.from(await out.save());
}
