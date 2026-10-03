'use strict';
const path = require('path');
const fs = require('fs');

const OFFICE_EXT = new Set(['.docx', '.doc', '.rtf', '.txt', '.xlsx', '.xls', '.csv', '.pptx', '.ppt', '.pps', '.ppsx']);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png']);
const PDF_EXT = new Set(['.pdf']);

function extKind(name) {
  const e = path.extname(name).toLowerCase();
  if (OFFICE_EXT.has(e)) return 'office';
  if (IMAGE_EXT.has(e)) return 'image';
  if (PDF_EXT.has(e)) return 'pdf';
  return null;
}

function officeKind(name) {
  const e = path.extname(name).toLowerCase();
  if (/^\.(docx|doc|rtf|txt)$/.test(e)) return 'word';
  if (/^\.(xlsx|xls|csv)$/.test(e)) return 'excel';
  if (/^\.(pptx|ppt|pps|ppsx)$/.test(e)) return 'ppt';
  return null;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function uniquePath(outPath) {
  if (!fs.existsSync(outPath)) return outPath;
  const dir = path.dirname(outPath);
  const ext = path.extname(outPath);
  const base = path.basename(outPath, ext);
  for (let i = 1; i < 999; i++) {
    const p = path.join(dir, `${base}-${i}${ext}`);
    if (!fs.existsSync(p)) return p;
  }
  return path.join(dir, `${base}-${Date.now()}${ext}`);
}

function formatBytes(n) {
  if (n == null) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function parsePageRange(spec, total) {
  // "1-3,5" -> [1,2,3,5] (1-based). null/'' -> all pages.
  if (!spec || !spec.trim()) return null;
  const pages = new Set();
  for (const part of spec.split(',')) {
    const seg = part.trim();
    if (!seg) continue;
    const m = seg.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) throw new Error(`页码格式不正确：${seg}`);
    let a = parseInt(m[1], 10), b = m[2] ? parseInt(m[2], 10) : a;
    if (a < 1 || b < a) throw new Error(`页码范围不正确：${seg}`);
    b = Math.min(b, total);
    for (let i = a; i <= b; i++) pages.add(i);
  }
  const list = [...pages].sort((x, y) => x - y);
  if (!list.length) throw new Error('页码范围为空');
  return list;
}

module.exports = { extKind, officeKind, ensureDir, uniquePath, formatBytes, parsePageRange };
