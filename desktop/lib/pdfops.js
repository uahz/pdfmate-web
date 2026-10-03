'use strict';
const { PDFDocument } = require('pdf-lib');

const A4 = [595.28, 841.89];

function isJpg(bytes) { return bytes[0] === 0xff && bytes[1] === 0xd8; }
function isPng(bytes) { return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47; }

// 单图 -> 单页 PDF 字节
async function imagePageBytes(bytes, { pageSize = 'auto' } = {}) {
  const doc = await PDFDocument.create();
  let img;
  if (isJpg(bytes)) img = await doc.embedJpg(bytes);
  else if (isPng(bytes)) img = await doc.embedPng(bytes);
  else throw new Error('IMAGE_DECODE_FAILED');

  let pw, ph;
  if (pageSize === 'a4') {
    [pw, ph] = A4;
    const margin = 24;
    const maxW = pw - margin * 2, maxH = ph - margin * 2;
    const scale = Math.min(maxW / img.width, maxH / img.height, 1e9);
    const w = img.width * scale, h = img.height * scale;
    const page = doc.addPage(A4);
    page.drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
  } else {
    // auto：按图像像素 @96dpi 换算 pt（1px = 0.75pt）
    pw = Math.max(1, Math.round(img.width * 0.75));
    ph = Math.max(1, Math.round(img.height * 0.75));
    const page = doc.addPage([pw, ph]);
    page.drawImage(img, { x: 0, y: 0, width: pw, height: ph });
  }
  const out = await doc.save();
  return out;
}

// 多图 -> 一个 PDF（按顺序，每图一页）
async function imagesToOnePdf(bytesList, opts) {
  const merged = await PDFDocument.create();
  for (const bytes of bytesList) {
    let img;
    if (isJpg(bytes)) img = await merged.embedJpg(bytes);
    else if (isPng(bytes)) img = await merged.embedPng(bytes);
    else throw new Error('IMAGE_DECODE_FAILED');
    let pw, ph, w, h;
    if (opts && opts.pageSize === 'a4') {
      [pw, ph] = A4;
      const margin = 24;
      const scale = Math.min((pw - margin * 2) / img.width, (ph - margin * 2) / img.height);
      w = img.width * scale; h = img.height * scale;
    } else {
      pw = Math.max(1, Math.round(img.width * 0.75));
      ph = Math.max(1, Math.round(img.height * 0.75));
      w = pw; h = ph;
    }
    const page = merged.addPage([pw, ph]);
    page.drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
  }
  return merged.save();
}

// 多个 PDF 字节按顺序合并
async function mergePdfBytes(bytesList) {
  const merged = await PDFDocument.create();
  let pages = 0;
  for (const bytes of bytesList) {
    const src = await PDFDocument.load(bytes, { ignoreEncryption: false });
    const copied = await merged.copyPages(src, src.getPageIndices());
    copied.forEach((p) => merged.addPage(p));
    pages += copied.length;
  }
  const out = await merged.save();
  return { bytes: out, pages };
}

async function pdfPageCount(bytes) {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  return doc.getPageCount();
}

module.exports = { imagePageBytes, imagesToOnePdf, mergePdfBytes, pdfPageCount, isJpg, isPng };
