'use strict';
// PDF→图片渲染（pdf.js，Chromium Canvas，DPI 分档）
import * as pdfjs from '../node_modules/pdfjs-dist/build/pdf.min.mjs';

let workerReady = false;
export async function ensurePdfJs() {
  if (!workerReady) {
    const worker = new Worker(
      new URL('../node_modules/pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url),
      { type: 'module' }
    );
    pdfjs.GlobalWorkerOptions.workerPort = worker;
    workerReady = true;
  }
  return pdfjs;
}

export async function runPdf2Img({ bytes, pages, dpi, format, quality, cmaps, stdFonts, onPage }) {
  ensurePdfJs();
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(bytes),
    cMapUrl: cmaps || null,
    cMapPacked: true,
    standardFontDataUrl: stdFonts || null
  }).promise;

  const scale = (dpi || 150) / 72;
  for (const pageNum of pages) {
    const page = await doc.getPage(pageNum);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    const mime = format === 'jpeg' ? 'image/jpeg' : 'image/png';
    const blob = await new Promise(r => canvas.toBlob(r, mime, format === 'jpeg' ? (quality || 0.92) : undefined));
    canvas.width = 0; canvas.height = 0;
    if (onPage) await onPage(pageNum, blob);
    page.cleanup();
  }
  await doc.destroy();
}
