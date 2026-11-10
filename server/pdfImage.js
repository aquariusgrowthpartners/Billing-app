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

/** Copy Page 3 through the final page into one standalone Vision PDF. */
export async function extractPdfPages(buffer, startPage = 3) {
  const src = await PDFDocument.load(buffer);
  const total = src.getPageCount();
  const first = Math.min(Math.max(Number(startPage) || 1, 1), total);
  const indices = Array.from({ length: total - first + 1 }, (_, index) => first - 1 + index);
  const out = await PDFDocument.create();
  const pages = await out.copyPages(src, indices);
  for (const page of pages) {
    page.setRotation(degrees(0));
    out.addPage(page);
  }
  console.log(
    `[VISION-SLICE] Extracted pages ${first} to ${total} for Vision processing.`
  );
  return Buffer.from(await out.save());
}
