'use strict';
import { runPdf2Img } from './pdf2img.js';
import { pdfToDocxBlob, compressPdfToBlob } from './word-compress.js';

const $ = (s) => document.querySelector(s);
// 浏览器直开（无 Electron preload）时提供演示桩，便于 UI 预览/截图
const api = window.pdfmate || {
  send: () => {},
  invoke: async (ch) => {
    if (ch === 'engine:status') return { active: 'office', detect: {}, elevated: false, setting: 'auto' };
    if (ch === 'queue:getState') return { jobs: [], paused: false, engine: 'office' };
    if (ch === 'history:list') return [];
    return null;
  },
  on: () => {}
};
const params = new URLSearchParams(location.search);
const DEMO = params.has('demo');
const SMOKE = params.has('smoke');

// ---------- 状态 ----------
const state = {
  mode: 'to-pdf',
  preset: 'print',
  pageSize: 'auto',
  outMode: 'source',
  outDirCustom: '',
  fmt: 'png',
  zip: true,
  imgMerge: false,
  items: [],        // 暂存区 {path,name,kind}
  jobs: [],         // 队列快照
  paused: false,
  engine: null
};

const KIND_META = {
  office: { tile: 'unknown', label: 'Office' },
  image: { tile: 'img', label: '图片' },
  pdf: { tile: 'pdf', label: 'PDF' }
};
function tileClass(name) {
  const e = name.toLowerCase().split('.').pop();
  if (['docx', 'doc', 'rtf', 'txt'].includes(e)) return 'word';
  if (['xlsx', 'xls', 'csv'].includes(e)) return 'excel';
  if (['pptx', 'ppt', 'pps', 'ppsx'].includes(e)) return 'ppt';
  if (['jpg', 'jpeg', 'png'].includes(e)) return 'img';
  if (e === 'pdf') return 'pdf';
  return 'unknown';
}
function kindOf(name) {
  const e = '.' + name.toLowerCase().split('.').pop();
  if (['.docx', '.doc', '.rtf', '.txt', '.xlsx', '.xls', '.csv', '.pptx', '.ppt', '.pps', '.ppsx'].includes(e)) return 'office';
  if (['.jpg', '.jpeg', '.png'].includes(e)) return 'image';
  if (e === '.pdf') return 'pdf';
  return null;
}

// ---------- 窗口控制 ----------
$('#btnMin').onclick = () => api.send('win:minimize');
$('#btnMax').onclick = () => api.send('win:maximize');
$('#btnClose').onclick = () => api.send('win:close');

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
function esc(s) { const d = document.createElement('i'); d.textContent = s; return d.innerHTML; }
function fmtBytes(n) {
  if (n == null) return '';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}
const PRESET_MAP = {
  print: { pdf2imgDpi: 150, quality: 0.85 },
  archive: { pdf2imgDpi: 300, quality: 0.95 },
  min: { pdf2imgDpi: 96, quality: 0.7 }
};

// ---------- 暂存区 ----------
function addPaths(paths) {
  let added = 0, skipped = 0;
  for (const p of paths) {
    const name = p.split(/[\\/]/).pop();
    const kind = kindOf(name);
    if (!kind) { skipped++; continue; }
    if (state.mode === 'to-pdf' && kind === 'pdf') { skipped++; continue; }
    if (state.mode === 'pdf2img' && kind !== 'pdf') { skipped++; continue; }
    if (state.items.some(i => i.path === p)) { skipped++; continue; }
    state.items.push({ path: p, name, kind });
    added++;
  }
  if (skipped) toast('部分文件未加入', `${skipped} 个文件与当前模式不符或已存在`);
  renderItems();
}
function removeItem(path) {
  state.items = state.items.filter(i => i.path !== path);
  renderItems();
}
function moveItem(path, dir) {
  const idx = state.items.findIndex(i => i.path === path);
  const to = idx + dir;
  if (idx < 0 || to < 0 || to >= state.items.length) return;
  const [it] = state.items.splice(idx, 1);
  state.items.splice(to, 0, it);
  renderItems();
}

function renderItems() {
  const list = $('#joblist');
  const jobs = state.jobs;
  const total = state.items.length + jobs.length;
  if (!total) { list.innerHTML = '<div class="fempty">队列空空如也，拖入文件开始吧</div>'; updateStats(); return; }
  let html = '';
  for (const it of state.items) {
    html += `<div class="frow">
      <div class="tile ${tileClass(it.name)}">${tileLabel(it.name)}</div>
      <div><div class="fname">${esc(it.name)}</div><div class="fmeta">${esc(modeHint(it.kind))}</div></div>
      <div class="right">
        ${state.mode === 'merge' ? `<span class="link" data-mv="-1" data-p="${esc(it.path)}">上移</span><span class="link" data-mv="1" data-p="${esc(it.path)}">下移</span>` : ''}
        <span class="pill queue"><i class="dot"></i>待转换</span>
        <span class="link" data-rm="${esc(it.path)}">移除</span>
      </div></div>`;
  }
  for (const j of jobs) {
    let right = '';
    if (j.status === 'running' || j.status === 'await-render') {
      right = `<div class="progress"><i style="width:${Math.round(j.progress * 100)}%"></i></div><span class="pct">${Math.round(j.progress * 100)}%</span><span class="pill run"><i class="dot"></i>${j.status === 'await-render' ? '渲染中' : '转换中'}</span>`;
    } else if (j.status === 'done') {
      right = `<span class="pill ok"><i class="dot"></i>完成</span><span class="link" data-open="${esc(j.outPath || j.src)}">打开</span>`;
    } else if (j.status === 'error') {
      right = `<span class="pill err"><i class="dot"></i>${esc(j.error || '失败')}</span>`;
    } else if (j.status === 'canceled') {
      right = `<span class="pill queue"><i class="dot"></i>已取消</span>`;
    } else {
      right = `<span class="pill queue"><i class="dot"></i>排队中</span>`;
    }
    html += `<div class="frow">
      <div class="tile ${tileClass(j.name)}">${tileLabel(j.name)}</div>
      <div><div class="fname">${esc(j.name)}</div><div class="fmeta">${esc(j.engine || '')}${j.pages ? ' · ' + j.pages + ' 页' : ''}</div></div>
      <div class="right">${right}</div></div>`;
  }
  list.innerHTML = html;
  list.querySelectorAll('[data-rm]').forEach(el => el.onclick = () => removeItem(el.dataset.rm));
  list.querySelectorAll('[data-mv]').forEach(el => el.onclick = () => moveItem(el.dataset.p, parseInt(el.dataset.mv, 10)));
  list.querySelectorAll('[data-open]').forEach(el => el.onclick = () => api.send('open:path', el.dataset.open));
  updateStats();
}
function tileLabel(name) {
  const c = tileClass(name);
  return c === 'pdf' ? 'PDF' : c === 'word' ? 'W' : c === 'excel' ? 'X' : c === 'ppt' ? 'P' : c === 'img' ? '图' : '?';
}
function modeHint(kind) {
  if (state.mode === 'pdf2img') return 'PDF → 图片';
  if (state.mode === 'to-docx') return 'PDF → Word（数字版文本还原）';
  if (state.mode === 'split') return kind === 'pdf' ? '拆分为多个 PDF' : '';
  if (state.mode === 'compress') return kind === 'pdf' ? '压缩为更小的 PDF' : '';
  if (state.mode === 'merge') return kind === 'office' ? '引擎转 PDF 后合并' : kind === 'image' ? '作为一页并入' : '直接并入';
  return kind === 'office' ? (state.engine === 'office' ? 'Office 引擎 → PDF' : 'LibreOffice → PDF') : '图片 → PDF';
}

function updateStats() {
  const running = state.jobs.filter(j => ['running', 'await-render'].includes(j.status)).length;
  const done = state.jobs.filter(j => j.status === 'done').length;
  const total = state.jobs.length;
  $('#goCount').textContent = `· ${state.mode === 'merge' ? '合并 ' + state.items.length + ' 个文件' : state.items.length + ' 个文件'}`;
  if (total && (running || done)) {
    $('#statText').innerHTML = `<b>已完成 ${done}</b> · 转换中 ${running} · 排队 ${total - done - running}`;
    $('#statBar').style.width = Math.round((done / total) * 100) + '%';
    $('#btnPause').style.display = '';
    $('#btnCancel').style.display = '';
    $('#btnPause').textContent = state.paused ? '继续' : '暂停';
    $('#statSpeed').textContent = state.paused ? '已暂停' : '';
  } else {
    $('#statText').textContent = state.items.length
      ? `已添加 ${state.items.length} 个文件 · 引擎：${engineLabel()}`
      : `就绪 · 引擎：${engineLabel()}`;
    $('#statBar').style.width = '0%';
    $('#btnPause').style.display = 'none';
    $('#btnCancel').style.display = 'none';
    $('#statSpeed').textContent = '';
  }
}
function engineLabel() {
  if (state.engine === 'office') return 'MS Office';
  if (state.engine === 'soffice') return 'LibreOffice';
  return '未检测到';
}

// ---------- 模式与参数 ----------
$('#modeSeg').addEventListener('click', (e) => {
  const t = e.target.closest('[data-mode]');
  if (!t) return;
  state.mode = t.dataset.mode;
  $('#modeSeg').querySelectorAll('span').forEach(s => s.classList.toggle('on', s === t));
  const pdfOnly = ['pdf2img', 'to-docx', 'split', 'compress'].includes(state.mode);
  $('#pdf2imgGroup').style.display = state.mode === 'pdf2img' ? '' : 'none';
  $('#docxGroup').style.display = state.mode === 'to-docx' ? '' : 'none';
  $('#splitGroup').style.display = state.mode === 'split' ? '' : 'none';
  $('#compressGroup').style.display = state.mode === 'compress' ? '' : 'none';
  $('#mergeNameGroup').style.display = state.mode === 'merge' ? '' : 'none';
  const imageModes = ['to-pdf', 'merge'];
  $('#pageSizeGroup').style.display = imageModes.includes(state.mode) ? '' : 'none';
  // 模式切换后清理不符的暂存文件
  const before = state.items.length;
  state.items = state.items.filter(i => {
    if (pdfOnly) return i.kind === 'pdf';
    if (state.mode === 'to-pdf') return i.kind !== 'pdf';
    return true;
  });
  if (state.items.length !== before) toast('已过滤', `${before - state.items.length} 个文件与新模式不符，已移出暂存区`);
  renderItems();
});
let splitMode = 'each';
$('#splitSeg').addEventListener('click', (e) => {
  const t = e.target.closest('[data-v]');
  if (!t) return;
  splitMode = t.dataset.v;
  $('#splitSeg').querySelectorAll('span').forEach(s => s.classList.toggle('on', s === t));
  $('#splitEvery').style.display = splitMode === 'every' ? '' : 'none';
  $('#splitRanges').style.display = splitMode === 'ranges' ? '' : 'none';
});
let compressLevel = 'standard';
$('#compSeg').addEventListener('click', (e) => {
  const t = e.target.closest('[data-v]');
  if (!t) return;
  compressLevel = t.dataset.v;
  $('#compSeg').querySelectorAll('span').forEach(s => s.classList.toggle('on', s === t));
});
$('#presetChips').addEventListener('click', (e) => {
  const t = e.target.closest('[data-preset]');
  if (!t) return;
  state.preset = t.dataset.preset;
  $('#presetChips').querySelectorAll('.chip').forEach(c => c.classList.toggle('on', c === t));
});
$('#pageSeg').addEventListener('click', (e) => {
  const t = e.target.closest('[data-ps]');
  if (!t) return;
  state.pageSize = t.dataset.ps;
  $('#pageSeg').querySelectorAll('span').forEach(s => s.classList.toggle('on', s === t));
});
$('#fmtSeg').addEventListener('click', (e) => {
  const t = e.target.closest('[data-fmt]');
  if (!t) return;
  state.fmt = t.dataset.fmt;
  $('#fmtSeg').querySelectorAll('span').forEach(s => s.classList.toggle('on', s === t));
});
$('#swZip').onclick = () => { state.zip = !state.zip; $('#swZip').classList.toggle('on', state.zip); };
$('#swImgMerge').onclick = () => { state.imgMerge = !state.imgMerge; $('#swImgMerge').classList.toggle('on', state.imgMerge); };
$('#outChips').addEventListener('click', async (e) => {
  const t = e.target.closest('[data-out]');
  if (!t) return;
  if (t.dataset.out === 'custom') {
    const dir = await api.invoke('dialog:openFolder');
    if (!dir) return;
    state.outDirCustom = dir;
    $('#outDirLabel').textContent = dir;
    $('#outDirLabel').style.display = '';
  }
  state.outMode = t.dataset.out;
  $('#outChips').querySelectorAll('.chip').forEach(c => c.classList.toggle('on', c === t));
});

// ---------- 添加文件 ----------
$('#btnAddFiles').onclick = async () => {
  const paths = await api.invoke('dialog:openFiles');
  if (paths && paths.length) addPaths(paths);
};
$('#btnAddFolder').onclick = async () => {
  const dir = await api.invoke('dialog:openFolder');
  if (!dir) return;
  const files = await scanDirShim(dir);
  if (!files.length) toast('文件夹为空', '未找到可处理的文件');
  else addPaths(files);
};
// 文件夹扫描：通过拖拽 API 或对话框均走这里（主进程无此通道，V1 用 dialog 的多选 + 拖拽递归）
async function scanDirShim() { return []; }
$('#dropzone').onclick = () => $('#fileInput').click();
$('#fileInput').onchange = () => {
  const paths = [...$('#fileInput').files].map(f => f.path).filter(Boolean);
  if (paths.length) addPaths(paths);
  $('#fileInput').value = '';
};
// 拖拽（含文件夹递归）
const dz = $('#dropzone');
['dragover', 'dragenter'].forEach(ev => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
dz.addEventListener('drop', async (e) => {
  const items = [...(e.dataTransfer.items || [])];
  const paths = [];
  const entries = items.map(i => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
  if (!entries.length) {
    for (const f of e.dataTransfer.files) if (f.path) paths.push(f.path);
  } else {
    for (const entry of entries) await walkEntry(entry, paths, 0);
  }
  if (paths.length) addPaths(paths);
  else toast('未获取到文件路径', '请改用「添加文件 / 添加文件夹」按钮');
});
async function walkEntry(entry, out, depth) {
  if (depth > 6) return;
  if (entry.isFile) {
    await new Promise(r => entry.file(f => { if (f.path) out.push(f.path); r(); }, r));
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    const readAll = () => new Promise(r => reader.readEntries(r, r));
    let batch;
    do {
      batch = await readAll();
      for (const en of batch) await walkEntry(en, out, depth + 1);
    } while (batch.length);
  }
}

// ---------- 开始转换 ----------
$('#go').onclick = async () => {
  if (!state.items.length) { toast('暂无文件', '请先拖入或选择要处理的文件'); return; }
  if (['merge'].includes(state.mode) && state.items.length < 2) { toast('文件不足', '合并模式至少需要 2 个文件'); return; }
  if (state.mode !== 'pdf2img' && !state.engine && state.items.some(i => i.kind === 'office')) {
    toast('未检测到转换引擎', '需要本机安装 MS Office 或 LibreOffice（见左侧提示）', 'err');
    return;
  }
  const preset = PRESET_MAP[state.preset];
  const batch = {
    mode: state.mode,
    outDir: state.outMode === 'custom' && state.outDirCustom ? state.outDirCustom : null,
    mergedName: (state.mode === 'merge' ? ($('#mergeName').value || '合并文档') : '图片合并'),
    params: {
      imgPageSize: state.pageSize,
      imgMergeToOne: state.mode === 'to-pdf' ? state.imgMerge : (state.mode === 'merge' ? true : false),
      pdf2imgDpi: preset.pdf2imgDpi,
      pdf2imgFormat: state.fmt,
      pdf2imgQuality: preset.quality,
      pdf2imgRange: $('#rangeInput').value.trim(),
      pdf2imgZip: state.zip,
      splitMode,
      splitEvery: $('#splitEvery').value.trim(),
      splitRanges: $('#splitRanges').value.trim(),
      compressLevel
    },
    items: state.items.map(i => ({ path: i.path, kind: i.kind }))
  };
  await api.invoke('queue:add', batch);
  state.items = [];
  renderItems();
  toast('已加入队列', '转换任务已开始，可在下方查看进度');
};

$('#btnPause').onclick = () => {
  if (state.paused) api.send('queue:resume'); else api.send('queue:pause');
};
$('#btnCancel').onclick = () => api.send('queue:cancelAll');

// ---------- 队列事件 ----------
api.on('queue:update', (snap) => {
  state.jobs = snap.jobs || [];
  state.paused = !!snap.paused;
  state.engine = snap.engine;
  renderItems();
  renderEngineFoot(snap.engine);
});
api.on('notify', (n) => toast(n.title, n.text, n.type));

api.on('render:request', (payload) => handleRenderRequest(payload));
const COMPRESS_LEVELS = { high: { dpi: 150, q: 0.75 }, standard: { dpi: 120, q: 0.6 }, min: { dpi: 96, q: 0.5 } };
async function handleRenderRequest(req) {
  try {
    const prep = await api.invoke('pdf2img:prepare', {
      src: req.src, outDir: req.outDir, dpi: req.dpi, format: req.format,
      quality: req.quality, range: req.range,
      zip: req.kind === 'pdf2img' ? req.zip : false
    });
    const cmaps = '../node_modules/pdfjs-dist/cmaps/', stdFonts = '../node_modules/pdfjs-dist/standard_fonts/';
    const progress = (p, t) => api.send('pdf2img:progress', { jobId: req.jobId, page: p, total: t });

    if (req.kind === 'to-docx') {
      const bytes = await api.invoke('fs:readBytes', req.src);
      const blob = await pdfToDocxBlob({ bytes, pages: prep.pages, cmaps, stdFonts, onProgress: progress });
      const name = prep.prefix + '.docx';
      await api.invoke('fs:writeBytes', prep.token, name, await blob.arrayBuffer());
      await api.invoke('pdf2img:done', { jobId: req.jobId, ok: true, outPath: prep.dir + '/' + name, pages: prep.pages.length });
      return;
    }
    if (req.kind === 'compress') {
      const lv = COMPRESS_LEVELS[req.compressLevel] || COMPRESS_LEVELS.standard;
      const bytes = await api.invoke('fs:readBytes', req.src);
      const blob = await compressPdfToBlob({ bytes, pages: prep.pages, dpi: lv.dpi, quality: lv.q, cmaps, stdFonts, onProgress: progress });
      const name = prep.prefix + '_compressed.pdf';
      await api.invoke('fs:writeBytes', prep.token, name, await blob.arrayBuffer());
      await api.invoke('pdf2img:done', { jobId: req.jobId, ok: true, outPath: prep.dir + '/' + name, pages: prep.pages.length });
      return;
    }
    // 默认：PDF → 图片（zip 参数仅适用于本模式）
    const ext = req.format === 'png' ? 'png' : 'jpg';
    const bytes = await api.invoke('fs:readBytes', req.src);
    await runPdf2Img({
      bytes,
      pages: prep.pages,
      dpi: req.dpi,
      format: req.format,
      quality: req.quality,
      cmaps, stdFonts,
      onPage: async (page, blob) => {
        const name = `${prep.prefix}_p${String(page).padStart(4, '0')}.${ext}`;
        const buf = await blob.arrayBuffer();
        await api.invoke('fs:writeBytes', prep.token, name, buf);
        progress(page, prep.pages.length);
      }
    });
    let outPath = prep.dir;
    if (req.zip) outPath = await api.invoke('pdf2img:zip', { token: prep.token });
    await api.invoke('pdf2img:done', { jobId: req.jobId, ok: true, outPath, pages: prep.pages.length });
  } catch (e) {
    await api.invoke('pdf2img:done', { jobId: req.jobId, ok: false, error: String(e && e.message || e) });
  }
}

// 右键菜单 / 命令行传入文件
api.on('files:add', (paths) => { if (paths && paths.length) addPaths(paths); });

// ---------- 引擎状态 ----------
function setBanner(text) {
  const b = $('#banner');
  if (!text) { b.classList.remove('warn'); b.style.display = 'none'; b.innerHTML = ''; return; }
  b.classList.add('warn');
  b.innerHTML = '⚠ ' + esc(text);
}
async function refreshEngine() {
  const st = await api.invoke('engine:status');
  state.engine = st.active;
  renderEngineFoot(st.active);
  updateStats();
  const foot = $('#engineFoot');
  if (st.elevated) {
    setBanner('当前以管理员身份运行：Office 转换引擎可能无法启动（COM 限制）。建议关闭后以普通方式重新打开 PDFMate；已安装 LibreOffice 时会自动改用备用引擎。');
  } else {
    setBanner(null);
  }
  if (!st.active) {
    foot.classList.add('warn');
    $('#engineTitle').textContent = '未检测到转换引擎';
    $('#engineDetail').textContent = '安装 MS Office 或 LibreOffice 后重启应用';
  } else if (st.active === 'office') {
    foot.classList.remove('warn');
    $('#engineTitle').textContent = '转换引擎已就绪';
    $('#engineDetail').textContent = 'MS Office COM · 还原度优先';
  } else {
    foot.classList.remove('warn');
    $('#engineTitle').textContent = '转换引擎已就绪';
    $('#engineDetail').textContent = 'LibreOffice headless';
  }
}
function renderEngineFoot(engine) { state.engine = engine; updateStats(); }

// ---------- 完成报告 ----------
api.on('queue:update', (() => {
  let reported = new Set();
  return (snap) => {
    // 批次完成检测：无 running 且出现新 done/error
    const active = snap.jobs.filter(j => ['running', 'await-render', 'queued'].includes(j.status)).length;
    if (!active && snap.jobs.length) {
      const key = snap.jobs.map(j => j.id + j.status).join('|');
      if (!reported.has(key) && snap.jobs.some(j => j.status === 'done')) {
        reported.add(key);
        showReport(snap.jobs);
      }
    }
  };
})());
function showReport(jobs) {
  const ok = jobs.filter(j => j.status === 'done');
  const fail = jobs.filter(j => ['error', 'canceled'].includes(j.status));
  $('#rpOk').textContent = ok.length;
  $('#rpFail').textContent = fail.length;
  $('#reportTitle').textContent = fail.length ? '转换完成（部分失败）' : '转换完成';
  $('#reportList').innerHTML = jobs.map(j => `
    <div class="mrow"><span style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(j.name)}</span>
    <b style="color:${j.status === 'done' ? 'var(--ok)' : 'var(--err)'};font-size:12px">${j.status === 'done' ? '✓ 成功' : esc(j.error || '失败')}</b></div>`).join('');
  $('#rpOpen').onclick = () => api.invoke('open:dir', (ok[0] || jobs[0]).outPath || (ok[0] || jobs[0]).src);
  $('#reportMask').classList.add('show');
}
$('#rpClose').onclick = () => $('#reportMask').classList.remove('show');

// ---------- 任务中心（历史） ----------
$('#histBadge').onclick = openHistory;
document.querySelector('[data-nav="history"]').onclick = openHistory;
async function openHistory() {
  const list = await api.invoke('history:list');
  $('#histBadge').textContent = list.length;
  $('#histList').innerHTML = list.length ? list.slice(0, 50).map(h => `
    <div class="mrow"><span style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(h.src.split(/[\\/]/).pop())}</span>
    <b style="color:${h.status === 'done' ? 'var(--ok)' : 'var(--err)'};font-size:12px">${h.status === 'done' ? '✓' : '✕'} ${h.status === 'done' ? new Date(h.at || Date.now()).toLocaleString() : esc(h.error || '')}</b></div>`).join('')
    : '<div class="fempty" style="height:80px">暂无历史记录</div>';
  $('#histMask').classList.add('show');
}
$('#histClose').onclick = () => $('#histMask').classList.remove('show');
$('#histClear').onclick = async () => { await api.invoke('history:clear'); $('#histBadge').textContent = 0; $('#histList').innerHTML = '<div class="fempty" style="height:80px">暂无历史记录</div>'; };

// ---------- 演示模式（UI 预览截图用） ----------
if (DEMO) {
  state.jobs = [
    { id: 'd1', name: '2026年度营销预算报告.docx', kind: 'office', status: 'done', progress: 1, engine: 'MS Office COM', pages: 12, src: '', outPath: '' },
    { id: 'd2', name: '客户提案_终版.pptx', kind: 'office', status: 'running', progress: 0.65, engine: 'MS Office COM', src: '' },
    { id: 'd3', name: 'Q3销售明细表.xlsx', kind: 'office', status: 'queued', progress: 0, engine: '', src: '' },
    { id: 'd4', name: '扫描件_租赁合同.jpg', kind: 'image', status: 'queued', progress: 0, engine: '', src: '' },
    { id: 'd5', name: '产品白皮书.pdf', kind: 'pdf', status: 'error', progress: 0, error: '已加密', src: '' }
  ];
  renderItems();
  $('#engineTitle').textContent = '转换引擎已就绪';
  $('#engineDetail').textContent = 'MS Office COM · 已预热';
  state.engine = 'office';
  updateStats();
}

// ---------- 烟雾测试钩子 ----------
if (SMOKE) {
  window.__smokeMakePng = async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 480; canvas.height = 320;
    const ctx = canvas.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 480, 320);
    g.addColorStop(0, '#4F7CFF'); g.addColorStop(1, '#6C5CFF');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 480, 320);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 42px sans-serif';
    ctx.fillText('PDFMate Smoke', 40, 170);
    const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
    return api.invoke('smoke:saveSample', 'sample.png', await blob.arrayBuffer());
  };
}

// ---------- 启动 ----------
refreshEngine();
if (!DEMO) {
  api.invoke('queue:getState').then((snap) => {
    state.jobs = snap.jobs || [];
    state.paused = !!snap.paused;
    state.engine = snap.engine;
    renderItems();
    renderEngineFoot(snap.engine);
  });
}
