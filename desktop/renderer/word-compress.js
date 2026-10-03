'use strict';
// PDF→Word（数字版文本还原）与 PDF 压缩（图像有损重编码）
// 依赖 index.html 引入的全局库：window.docx（docx UMD）、window.PDFLib（pdf-lib UMD）
import { ensurePdfJs } from './pdf2img.js';
import { extractPdfLines, linesToParagraphs } from './lib-text.js';

export async function pdfToDocxBlob({ bytes, pages, cmaps, stdFonts, onProgress }) {
  const pageLines = await extractPdfLines(bytes, pages, cmaps, stdFonts, onProgress);
  const paras = linesToParagraphs(pageLines);
  if (!paras.length) throw new Error('未提取到文本（可能是扫描件，OCR 将在 v2.0 提供）');

  const D = window.docx;
  if (!D) throw new Error('docx 库未加载');
  const children = paras.map(p => {
    const sizeHalf = Math.max(16, Math.round(p.size * 2)); // half-points
    return new D.Paragraph({
      children: [new D.TextRun({ text: p.text, size: sizeHalf, bold: !!p.heading })],
      spacing: { after: 160, line: 276 }
    });
  });
  const doc = new D.Document({ sections: [{ properties: {}, children }] });
  const blob = await D.Packer.toBlob(doc);
  return blob;
}

export async function compressPdfToBlob({ bytes, pages, dpi, quality, cmaps, stdFonts, onProgress }) {
  const pdfjs = await ensurePdfJs();
  const src = await pdfjs.getDocument({
    data: new Uint8Array(bytes),
    cMapUrl: cmaps || null,
    cMapPacked: true,
    standardFontDataUrl: stdFonts || null
  }).promise;
  const PDFLib = window.PDFLib;
  if (!PDFLib) throw new Error('pdf-lib 库未加载');
  const out = await PDFLib.PDFDocument.create();

  for (let i = 0; i < pages.length; i++) {
    const pageNum = pages[i];
    const page = await src.getPage(pageNum);
    const viewport = page.getViewport({ scale: (dpi || 120) / 72 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', quality || 0.6));
    const ab = await blob.arrayBuffer();
    const img = await out.embedJpg(ab);
    const wpt = canvas.width * 72 / (dpi || 120);
    const hpt = canvas.height * 72 / (dpi || 120);
    const np = out.addPage([wpt, hpt]);
    np.drawImage(img, { x: 0, y: 0, width: wpt, height: hpt });
    canvas.width = 0; canvas.height = 0;
    page.cleanup();
    if (onProgress) onProgress(i + 1, pages.length);
  }
  await src.destroy();
  const outBytes = await out.save();
  return new Blob([outBytes], { type: 'application/pdf' });
}
