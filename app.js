'use strict';
/* PDFMate Web · 全本地转换逻辑（浏览器内完成，无任何网络上传） */
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

// ---------- 工具 ----------
function toast(title, text, type = 'info') {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<b style="color:${type === 'err' ? 'var(--err)' : type === 'ok' ? 'var(--ok)' : 'var(--brand-600)'}"></b><span></span>`;
  el.querySelector('b').textContent = title;
  el.querySelector('span').textContent = text || '';
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 4200);
}
function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}
function esc(s) { const d = document.createElement('i'); d.textContent = s; return d.innerHTML; }
function imgKind(file) {
  const n = file.name.toLowerCase();
  return n.endsWith('.jpg') || n.endsWith('.jpeg') ? 'jpg' : n.endsWith('.png') ? 'png' : null;
}
function isJpg(b) { return b[0] === 0xff && b[1] === 0xd8; }
function isPng(b) { return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47; }
function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
function parseRange(spec, total) {
  if (!spec || !spec.trim()) return Array.from({ length: total }, (_, i) => i + 1);
  const set = new Set();
  for (const part of spec.split(',')) {
    const m = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) throw new Error('页码格式不正确：' + part.trim());
    let a = +m[1], b = m[2] ? +m[2] : a;
    if (a < 1 || b < a) throw new Error('页码范围不正确：' + part.trim());
    b = Math.min(b, total);
    for (let i = a; i <= b; i++) set.add(i);
  }
  const list = [...set].sort((x, y) => x - y);
  if (!list.length) throw new Error('页码范围为空');
  return list;
}
// 拖拽 + 点击选择通用绑定
function bindDrop(dropEl, inputEl, cb) {
  dropEl.addEventListener('click', () => inputEl.click());
  ['dragover', 'dragenter'].forEach(ev => dropEl.addEventListener(ev, e => { e.preventDefault(); dropEl.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach(ev => dropEl.addEventListener(ev, e => { e.preventDefault(); dropEl.classList.remove('drag'); }));
  dropEl.addEventListener('drop', e => {
    const files = [...(e.dataTransfer.files || [])];
    if (files.length) cb(files);
  });
  inputEl.addEventListener('change', () => { cb([...inputEl.files]); inputEl.value = ''; });
}
function bindSeg(id, cb) {
  $(id).addEventListener('click', (e) => {
    const t = e.target.closest('[data-v]');
    if (!t) return;
    $$(id + ' span').forEach(s => s.classList.toggle('on', s === t));
    cb(t.dataset.v);
  });
}

// ---------- 工具页切换 ----------
$$('.nav .chip[data-tool]').forEach(chip => {
  chip.addEventListener('click', () => {
    $$('.nav .chip[data-tool]').forEach(c => c.classList.toggle('on', c === chip));
    ['img2pdf', 'pdf2img', 'merge'].forEach(id => { $('#tool-' + id).hidden = id !== chip.dataset.tool; });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
});

// ---------- pdf.js worker（跨域脚本转本地 Blob，规避跨域 Worker 限制） ----------
async function ensurePdfJs() {
  if (!window.pdfjsLib) throw new Error('pdf.js 加载失败，请检查网络（首次需加载转换库）');
  if (!window.pdfjsLib.GlobalWorkerOptions.workerSrc) {
    const res = await fetch('https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js');
    const code = await res.text();
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
  }
  return window.pdfjsLib;
}

// ---------- 图片 → PDF ----------
const imgFiles = [];
let imgMode = 'one', imgPage = 'auto';
bindSeg('#imgMode', v => imgMode = v);
bindSeg('#imgPage', v => imgPage = v);

function renderImgList() {
  const box = $('#imgList');
  if (!imgFiles.length) { box.innerHTML = ''; return; }
  box.innerHTML = imgFiles.map((f, i) => `
    <div class="frow">
      <img class="thumb" src="${f._url}" alt="">
      <div><div class="fn">${esc(f.name)}</div><div class="fm">${fmtBytes(f.size)}</div></div>
      <div class="right">
        <span class="link" data-mv="-1" data-i="${i}">上移</span><span class="link" data-mv="1" data-i="${i}">下移</span>
        <span class="link" data-rm="${i}">移除</span>
      </div>
    </div>`).join('');
  box.querySelectorAll('[data-rm]').forEach(el => el.onclick = () => {
    const f = imgFiles.splice(+el.dataset.rm, 1)[0];
    if (f._url) URL.revokeObjectURL(f._url);
    renderImgList();
  });
  box.querySelectorAll('[data-mv]').forEach(el => el.onclick = () => {
    const i = +el.dataset.mv, idx = +el.dataset.i, to = idx + i;
    if (to < 0 || to >= imgFiles.length) return;
    const [it] = imgFiles.splice(idx, 1);
    imgFiles.splice(to, 0, it);
    renderImgList();
  });
}
function addImgFiles(files) {
  for (const f of files) {
    if (!imgKind(f)) { toast('跳过不支持的文件', f.name + '（仅支持 JPG / PNG）', 'err'); continue; }
    f._url = URL.createObjectURL(f);
    imgFiles.push(f);
  }
  renderImgList();
}
bindDrop($('#imgDrop'), $('#imgInput'), addImgFiles);

async function imagePageBytes(bytes, pageSize) {
  const { PDFDocument } = PDFLib;
  const doc = await PDFDocument.create();
  let img;
  if (isJpg(bytes)) img = await doc.embedJpg(bytes);
  else if (isPng(bytes)) img = await doc.embedPng(bytes);
  else throw new Error('图片解码失败（仅支持 JPG/PNG）');
  let pw, ph, w, h;
  if (pageSize === 'a4') {
    pw = 595.28; ph = 841.89;
    const m = 24, s = Math.min((pw - m * 2) / img.width, (ph - m * 2) / img.height);
    w = img.width * s; h = img.height * s;
  } else {
    pw = Math.max(1, Math.round(img.width * 0.75));
    ph = Math.max(1, Math.round(img.height * 0.75));
    w = pw; h = ph;
  }
  const page = doc.addPage([pw, ph]);
  page.drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
  return doc.save();
}
$('#imgGo').onclick = async () => {
  if (!imgFiles.length) { toast('暂无图片', '请先拖入或选择图片'); return; }
  const btn = $('#imgGo'); btn.disabled = true; $('#imgHint').textContent = '转换中…';
  try {
    if (imgMode === 'each') {
      for (const f of imgFiles) {
        const bytes = await imagePageBytes(new Uint8Array(await f.arrayBuffer()), imgPage);
        saveBlob(new Blob([bytes], { type: 'application/pdf' }), f.name.replace(/\.(jpe?g|png)$/i, '') + '.pdf');
      }
      $('#imgHint').textContent = `已导出 ${imgFiles.length} 个 PDF`;
      toast('转换完成', `已下载 ${imgFiles.length} 个 PDF`, 'ok');
    } else {
      const { PDFDocument } = PDFLib;
      const merged = await PDFDocument.create();
      for (const f of imgFiles) {
        const single = await PDFDocument.load(await imagePageBytes(new Uint8Array(await f.arrayBuffer()), imgPage));
        (await merged.copyPages(single, single.getPageIndices())).forEach(p => merged.addPage(p));
      }
      const bytes = await merged.save();
      saveBlob(new Blob([bytes], { type: 'application/pdf' }), '图片合并.pdf');
      $('#imgHint').textContent = `共 ${imgFiles.length} 页`;
      toast('转换完成', '图片合并.pdf 已下载', 'ok');
    }
  } catch (e) {
    toast('转换失败', String(e && e.message || e), 'err');
    $('#imgHint').textContent = '';
  }
  btn.disabled = false;
};

// ---------- PDF → 图片 ----------
let pdfFile = null;
let dpi = 150, fmt = 'png', zipMode = 'zip';
bindSeg('#dpiSeg', v => dpi = +v);
bindSeg('#fmtSeg', v => fmt = v);
bindSeg('#zipSeg', v => zipMode = v);

function renderPdfList() {
  $('#pdfList').innerHTML = pdfFile ? `
    <div class="frow">
      <div class="tile pdf">PDF</div>
      <div><div class="fn">${esc(pdfFile.name)}</div><div class="fm">${fmtBytes(pdfFile.size)}</div></div>
      <div class="right"><span class="link" data-rm>移除</span></div>
    </div>` : '';
  const rm = $('#pdfList [data-rm]');
  if (rm) rm.onclick = () => { pdfFile = null; renderPdfList(); };
}
bindDrop($('#pdfDrop'), $('#pdfInput'), (files) => {
  const f = files[0];
  if (!f || !f.name.toLowerCase().endsWith('.pdf')) { toast('请选择 PDF 文件', '', 'err'); return; }
  pdfFile = f; renderPdfList();
});

$('#pdfGo').onclick = async () => {
  if (!pdfFile) { toast('暂无 PDF', '请先拖入或选择 PDF 文件'); return; }
  const btn = $('#pdfGo'); btn.disabled = true;
  const prog = $('#pdfProg'); prog.style.display = ''; prog.firstElementChild.style.width = '0%';
  $('#pdfHint').textContent = '渲染中…';
  try {
    const pdfjs = await ensurePdfJs();
    const doc = await pdfjs.getDocument({ data: new Uint8Array(await pdfFile.arrayBuffer()) }).promise;
    const pages = parseRange($('#pageRange').value, doc.numPages);
    const base = pdfFile.name.replace(/\.pdf$/i, '');
    const outName = `${base}_images.${zipMode === 'zip' ? 'zip' : 'zip'}`;
    let zip = zipMode === 'zip' ? new JSZip() : null;
    const blobs = [];
    for (let i = 0; i < pages.length; i++) {
      const pageNum = pages[i];
      const page = await doc.getPage(pageNum);
      const viewport = page.getViewport({ scale: dpi / 72 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      const blob = await new Promise(r => canvas.toBlob(r, fmt === 'jpeg' ? 'image/jpeg' : 'image/png', fmt === 'jpeg' ? 0.92 : undefined));
      if (zip) zip.file(`${base}_p${String(pageNum).padStart(4, '0')}.${fmt === 'jpeg' ? 'jpg' : 'png'}`, blob);
      else blobs.push({ name: `${base}_p${String(pageNum).padStart(4, '0')}.${fmt === 'jpeg' ? 'jpg' : 'png'}`, blob });
      prog.firstElementChild.style.width = Math.round(((i + 1) / pages.length) * 100) + '%';
      page.cleanup();
    }
    await doc.destroy();
    if (zip) {
      const zipped = await zip.generateAsync({ type: 'blob' });
      saveBlob(zipped, outName);
    } else {
      for (const b of blobs) { saveBlob(b.blob, b.name); await new Promise(r => setTimeout(r, 350)); }
    }
    $('#pdfHint').textContent = `已导出 ${pages.length} 张图片`;
    toast('转换完成', `已导出 ${pages.length} 张图片（${dpi}DPI）`, 'ok');
  } catch (e) {
    toast('转换失败', String(e && e.message || e), 'err');
    $('#pdfHint').textContent = '';
  }
  btn.disabled = false;
  setTimeout(() => { prog.style.display = 'none'; }, 1200);
};

// ---------- 合并 PDF ----------
const mergeItems = [];
function renderMergeList() {
  const box = $('#mergeList');
  box.innerHTML = mergeItems.map((f, i) => `
    <div class="frow">
      <div class="tile ${f.name.toLowerCase().endsWith('.pdf') ? 'pdf' : 'img'}">${f.name.toLowerCase().endsWith('.pdf') ? 'PDF' : '图'}</div>
      <div><div class="fn">${esc(f.name)}</div><div class="fm">${fmtBytes(f.size)}</div></div>
      <div class="right">
        <span class="link" data-mv="-1" data-i="${i}">上移</span><span class="link" data-mv="1" data-i="${i}">下移</span>
        <span class="link" data-rm="${i}">移除</span>
      </div>
    </div>`).join('');
  box.querySelectorAll('[data-rm]').forEach(el => el.onclick = () => { mergeItems.splice(+el.dataset.rm, 1); renderMergeList(); });
  box.querySelectorAll('[data-mv]').forEach(el => el.onclick = () => {
    const i = +el.dataset.mv, idx = +el.dataset.i, to = idx + i;
    if (to < 0 || to >= mergeItems.length) return;
    const [it] = mergeItems.splice(idx, 1);
    mergeItems.splice(to, 0, it);
    renderMergeList();
  });
}
bindDrop($('#mergeDrop'), $('#mergeInput'), (files) => {
  for (const f of files) {
    const ok = f.name.toLowerCase().endsWith('.pdf') || imgKind(f);
    if (!ok) { toast('跳过不支持的文件', f.name + '（网页版支持 PDF / JPG / PNG）', 'err'); continue; }
    mergeItems.push(f);
  }
  renderMergeList();
});
$('#mergeGo').onclick = async () => {
  if (mergeItems.length < 2) { toast('至少需要 2 个文件', '拖入两个及以上 PDF / 图片'); return; }
  const btn = $('#mergeGo'); btn.disabled = true; $('#mergeHint').textContent = '合并中…';
  try {
    const { PDFDocument } = PDFLib;
    const merged = await PDFDocument.create();
    for (const f of mergeItems) {
      const bytes = new Uint8Array(await f.arrayBuffer());
      if (f.name.toLowerCase().endsWith('.pdf')) {
        const src = await PDFDocument.load(bytes);
        (await merged.copyPages(src, src.getPageIndices())).forEach(p => merged.addPage(p));
      } else {
        const single = await PDFDocument.load(await imagePageBytes(bytes, 'auto'));
        (await merged.copyPages(single, single.getPageIndices())).forEach(p => merged.addPage(p));
      }
    }
    const out = await merged.save();
    const name = ($('#mergeName').value || '合并文档').replace(/[\\/:*?"<>|]/g, '') + '.pdf';
    saveBlob(new Blob([out], { type: 'application/pdf' }), name);
    $('#mergeHint').textContent = `共 ${merged.getPageCount()} 页`;
    toast('合并完成', name + '（' + merged.getPageCount() + ' 页）已下载', 'ok');
  } catch (e) {
    toast('合并失败', String(e && e.message || e) + '（加密 PDF 无法合并）', 'err');
    $('#mergeHint').textContent = '';
  }
  btn.disabled = false;
};

// ---------- 桌面版下载链接（GitHub Release） ----------
const RELEASE = 'https://github.com/' + (window.__PDFMATE_REPO || 'uahz/pdfmate-web') + '/releases/latest';
$('#dlDesktop').href = RELEASE;
$('#dlDesktop2').href = RELEASE;

// ---------- PWA ----------
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
