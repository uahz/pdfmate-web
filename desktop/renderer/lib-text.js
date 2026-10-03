'use strict';
// PDF 文本行提取（供 PDF→Word 使用）
import { ensurePdfJs } from './pdf2img.js';

// 从 PDF 提取逐页文本行：{pageNum, lines:[{size, text, x0}]}
export async function extractPdfLines(bytes, pages, cmaps, stdFonts, onProgress) {
  const pdfjs = await ensurePdfJs();
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(bytes),
    cMapUrl: cmaps || null,
    cMapPacked: true,
    standardFontDataUrl: stdFonts || null
  }).promise;

  const pageLines = [];
  for (const pageNum of pages) {
    const page = await doc.getPage(pageNum);
    const tc = await page.getTextContent();
    const rows = [];
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const x = it.transform[4];
      const y = it.transform[5];
      const size = Math.hypot(it.transform[2], it.transform[3]) || 12;
      let row = rows.find(r => Math.abs(r.y - y) <= Math.max(size, r.size) * 0.5);
      if (!row) { row = { y, size, items: [] }; rows.push(row); }
      if (size > row.size) row.size = size;
      row.items.push({ x, str: it.str, width: it.width || 0 });
    }
    rows.sort((a, b) => b.y - a.y);
    const lines = rows.map(r => {
      r.items.sort((a, b) => a.x - b.x);
      let text = '';
      let prevEnd = null;
      for (const it of r.items) {
        if (prevEnd !== null) {
          const gap = it.x - prevEnd;
          if (gap > r.size * 0.2) text += ' ';
        }
        text += it.str;
        prevEnd = it.x + (it.width || it.str.length * r.size * 0.5);
      }
      return { size: r.size, text: text.replace(/[ \t]+/g, ' ').trim(), x0: r.items.length ? r.items[0].x : 0 };
    }).filter(l => l.text);
    pageLines.push({ pageNum, lines });
    page.cleanup();
    if (onProgress) onProgress(pageNum);
  }
  await doc.destroy();
  return pageLines;
}

// 行 → 段落：页面切换/行距突增/标题字号 触发分段
export function linesToParagraphs(pageLines) {
  const all = [];
  for (const p of pageLines) {
    let prevY = null, prevSize = null;
    for (const l of p.lines) {
      const gap = prevY === null ? 0 : prevY - l.y;
      all.push({ ...l, page: p.pageNum, gap, prevSize });
      prevY = l.y; prevSize = l.size;
    }
  }
  const sizes = all.map(l => l.size).slice().sort((a, b) => a - b);
  const bodySize = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 12;
  const paras = [];
  let cur = null;
  for (const l of all) {
    const heading = l.size >= bodySize * 1.35;
    const pageBreak = cur && cur.page !== l.page;
    const bigGap = cur && !pageBreak && l.gap > Math.max(l.size, l.prevSize) * 1.6;
    if (!cur || pageBreak || heading || bigGap) {
      cur = { heading, size: l.size, page: l.page, parts: [] };
      paras.push(cur);
    }
    cur.parts.push(l.text);
  }
  // 拼接：CJK 相邻直接连，其余加空格
  return paras.map(p => {
    let text = '';
    for (const seg of p.parts) {
      if (!text) { text = seg; continue; }
      const a = text[text.length - 1], b2 = seg[0];
      const noSpace = /[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/.test(a) || /[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/.test(b2);
      text += (noSpace ? '' : ' ') + seg;
    }
    return { heading: p.heading, size: p.size, text };
  });
}
