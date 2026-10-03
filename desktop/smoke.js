'use strict';
// 端到端烟雾测试：electron . --smoke
// 覆盖：引擎检测 → 样例生成(COM) → 渲染端Canvas出图 → Office批量转PDF → 图片→PDF → 多格式合并 → PDF→图片(渲染端pdf.js)
const path = require('path');
const fs = require('fs');
const { PDFDocument } = require('pdf-lib');
const { pdfPageCount } = require('./lib/pdfops');
const { ensureDir } = require('./lib/util');
const engines = require('./lib/engines');

const BATCH_TIMEOUT = 180000;

// 路径边界：所有基于 samplesDir 的派生路径必须落在其内部
function inRoot(root, rel) {
  const target = path.resolve(root, rel);
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error('路径越界');
  return target;
}

function waitBatchDone(queue, batchId) {
  return new Promise((resolve, reject) => {
    const h = (d) => {
      if (d.batchId !== batchId) return;
      queue.removeListener('batch-done', h);
      resolve(d);
    };
    queue.on('batch-done', h);
    setTimeout(() => { queue.removeListener('batch-done', h); reject(new Error('批次超时')); }, BATCH_TIMEOUT);
  });
}

async function runSmoke({ app, queue, win }) {
  const steps = [];
  const t0 = Date.now();
  async function step(name, fn) {
    try {
      const detail = await fn();
      steps.push({ name, pass: true, detail: detail || '' });
      console.log('  [ok] ' + name + (detail ? ' — ' + detail : ''));
    } catch (e) {
      steps.push({ name, pass: false, detail: String(e && e.message || e) });
      console.log('  [FAIL] ' + name + ' — ' + String(e && e.message || e));
    }
  }
  const tempRoot = path.resolve(app.getPath('temp'));
  const samplesDir = path.resolve(tempRoot, 'pdfmate-smoke-' + Date.now());
  if (!samplesDir.startsWith(tempRoot + path.sep)) throw new Error('路径越界');
  ensureDir(samplesDir);
  global.__smokeCtx = { samplesDir };

  // 0. 等窗口加载
  await new Promise((resolve) => {
    if (win && !win.isDestroyed()) {
      if (win.webContents.isLoading()) win.webContents.once('did-finish-load', resolve);
      else resolve();
    } else resolve();
  });
  await new Promise(r => setTimeout(r, 400));

  await step('引擎检测', async () => {
    const det = engines.detectEngines();
    if (!det.office.available) throw new Error('MS Office COM 不可用');
    return `Word=${det.office.word}`;
  });

  await step('样例生成（LibreOffice 无头转换）', async () => {
    if (!engines.detectEngines().soffice) throw new Error('LibreOffice 未安装，无法生成样例');
    fs.writeFileSync(inRoot(samplesDir, 'sample.txt'), 'PDFMate smoke text sample.\nLine two for Writer engine.');
    fs.writeFileSync(inRoot(samplesDir, 'sample.csv'), 'Quarter,Revenue\nQ1,1024\nQ2,2048\n');
    // txt -> docx，csv -> xlsx：得到真实的 Office 格式样例
    const d = await engines.sofficeConvert([inRoot(samplesDir, 'sample.txt')], samplesDir,
      { sofficePath: engines.detectEngines().soffice, profileDir: inRoot(samplesDir, 'lo-profiles'), format: 'docx' });
    const x = await engines.sofficeConvert([inRoot(samplesDir, 'sample.csv')], samplesDir,
      { sofficePath: engines.detectEngines().soffice, profileDir: inRoot(samplesDir, 'lo-profiles'), format: 'xlsx' });
    if (!fs.existsSync(inRoot(samplesDir, 'sample.docx'))) throw new Error('docx 生成失败: ' + JSON.stringify(d.map(r => r.error)));
    if (!fs.existsSync(inRoot(samplesDir, 'sample.xlsx'))) throw new Error('xlsx 生成失败: ' + JSON.stringify(x.map(r => r.error)));
    return 'docx + xlsx + txt/csv';
  });

  await step('渲染端 Canvas → sample.png', async () => {
    const p = await win.webContents.executeJavaScript('window.__smokeMakePng()');
    if (!p || !fs.existsSync(p)) throw new Error('渲染端未生成样例图片');
    return p;
  });

  const out1 = inRoot(samplesDir, 'out1');
  await step('Office 批量转 PDF（txt/docx/xlsx）', async () => {
    const items = ['sample.txt', 'sample.docx', 'sample.xlsx'].map(f => ({
      path: inRoot(samplesDir, f), kind: 'office'
    }));
    const bid = queue.addBatch({ mode: 'to-pdf', items, outDir: out1, params: {} });
    const done = await waitBatchDone(queue, bid);
    const oks = done.jobs.filter(j => j.status === 'done');
    if (oks.length !== 3) throw new Error('成功 ' + oks.length + '/3：' + JSON.stringify(done.jobs.map(j => j.error)));
    for (const j of oks) {
      const n = await pdfPageCount(new Uint8Array(fs.readFileSync(j.outPath)));
      if (n < 1) throw new Error('PDF 页数为 0: ' + j.outPath);
    }
    return '3 个 PDF 输出于 ' + out1;
  });

  const out2 = inRoot(samplesDir, 'out2');
  await step('图片 → PDF（img-merge）', async () => {
    const bid = queue.addBatch({
      mode: 'img-merge',
      items: [{ path: inRoot(samplesDir, 'sample.png'), kind: 'image' }],
      outDir: out2, mergedName: 'smoke-image', params: {}
    });
    const done = await waitBatchDone(queue, bid);
    const j = done.jobs[0];
    if (j.status !== 'done') throw new Error(j.error);
    const n = await pdfPageCount(new Uint8Array(fs.readFileSync(j.outPath)));
    if (n !== 1) throw new Error('页数应为 1，实际 ' + n);
    return j.outPath;
  });

  // 基准 PDF（2 页，pdf-lib 直出）
  const basePdf = inRoot(samplesDir, 'base.pdf');
  {
    const doc = await PDFDocument.create();
    for (let i = 1; i <= 2; i++) {
      const page = doc.addPage([420, 300]);
      page.drawText('PDFMate base page ' + i, { x: 40, y: 150, size: 20 });
    }
    fs.writeFileSync(basePdf, Buffer.from(await doc.save()));
  }

  let mergedPath = null;
  const out3 = inRoot(samplesDir, 'out3');
  await step('多格式合并（PDF + docx + png）', async () => {
    const bid = queue.addBatch({
      mode: 'merge',
      items: [
        { path: basePdf, kind: 'pdf' },
        { path: inRoot(samplesDir, 'sample.docx'), kind: 'office' },
        { path: inRoot(samplesDir, 'sample.png'), kind: 'image' }
      ],
      outDir: out3, mergedName: 'smoke-merged', params: {}
    });
    const done = await waitBatchDone(queue, bid);
    const mainJob = done.jobs[0];
    if (mainJob.status !== 'done') throw new Error(mainJob.error);
    mergedPath = mainJob.outPath;
    const n = await pdfPageCount(new Uint8Array(fs.readFileSync(mergedPath)));
    if (n < 4) throw new Error('合并页数应 ≥4，实际 ' + n);
    return mergedPath + '（' + n + ' 页）';
  });

  const out4 = inRoot(samplesDir, 'out4');
  await step('PDF → 图片（pdf.js 渲染 + ZIP）', async () => {
    if (!mergedPath) throw new Error('缺少合并产物');
    const bid = queue.addBatch({
      mode: 'pdf2img',
      items: [{ path: mergedPath, kind: 'pdf' }],
      outDir: out4,
      params: { pdf2imgDpi: 96, pdf2imgFormat: 'png', pdf2imgQuality: 0.9, pdf2imgZip: true, pdf2imgRange: '' }
    });
    const done = await waitBatchDone(queue, bid);
    const j = done.jobs[0];
    if (j.status !== 'done') throw new Error(j.error);
    const zipPath = j.outPath;
    if (!zipPath || !fs.existsSync(zipPath)) throw new Error('ZIP 未生成');
    const pagesDir = zipPath.replace(/\.zip$/, '');
    if (!pagesDir.startsWith(samplesDir + path.sep)) throw new Error('路径越界');
    const pngs = fs.readdirSync(pagesDir).filter(f => f.endsWith('.png'));
    if (pngs.length < 4) throw new Error('PNG 数量应 ≥4，实际 ' + pngs.length);
    const size = fs.statSync(path.join(pagesDir, pngs[0])).size;
    if (size < 1000) throw new Error('首页 PNG 过小，疑似空白渲染');
    return pngs.length + ' 页 PNG + ' + path.basename(zipPath);
  });

  let docxPath = null;
  const out5 = inRoot(samplesDir, 'out5');
  await step('PDF → Word（渲染端提取 + docx 生成）', async () => {
    if (!mergedPath) throw new Error('缺少合并产物');
    const bid = queue.addBatch({ mode: 'to-docx', items: [{ path: mergedPath, kind: 'pdf' }], outDir: out5, params: {} });
    const done = await waitBatchDone(queue, bid);
    const j = done.jobs[0];
    if (j.status !== 'done') throw new Error(j.error);
    docxPath = j.outPath;
    if (!docxPath || !fs.existsSync(docxPath)) throw new Error('DOCX 未生成');
    const buf = fs.readFileSync(docxPath);
    if (!(buf[0] === 0x50 && buf[1] === 0x4B)) throw new Error('DOCX 不是有效 ZIP 容器');
    if (!buf.includes(Buffer.from('word/document.xml'))) throw new Error('DOCX 缺少 word/document.xml');
    return docxPath + '（' + buf.length + 'B）';
  });

  const out6 = inRoot(samplesDir, 'out6');
  await step('拆分（每页一个 PDF）', async () => {
    if (!mergedPath) throw new Error('缺少合并产物');
    const bid = queue.addBatch({ mode: 'split', items: [{ path: mergedPath, kind: 'pdf' }], outDir: out6, params: { splitMode: 'each' } });
    const done = await waitBatchDone(queue, bid);
    const j = done.jobs[0];
    if (j.status !== 'done') throw new Error(j.error);
    const dir = path.dirname(j.outPath);
    if (!dir.startsWith(samplesDir + path.sep)) throw new Error('路径越界');
    const parts = fs.readdirSync(dir).filter(f => f.startsWith('smoke-merged_part')).length;
    if (parts < 4) throw new Error('拆分份数应 ≥4，实际 ' + parts);
    return parts + ' 份';
  });

  const out7 = inRoot(samplesDir, 'out7');
  await step('压缩（逐页重编码）', async () => {
    if (!mergedPath) throw new Error('缺少合并产物');
    const before = fs.statSync(mergedPath).size;
    const bid = queue.addBatch({ mode: 'compress', items: [{ path: mergedPath, kind: 'pdf' }], outDir: out7, params: { compressLevel: 'min' } });
    const done = await waitBatchDone(queue, bid);
    const j = done.jobs[0];
    if (j.status !== 'done') throw new Error(j.error);
    const after = fs.statSync(j.outPath).size;
    const n = await pdfPageCount(new Uint8Array(fs.readFileSync(j.outPath)));
    if (n !== 4) throw new Error('压缩后页数应 =4，实际 ' + n);
    return 'size ' + before + 'B → ' + after + 'B（' + Math.round(after / before * 100) + '%）';
  });

  const pass = steps.every(s => s.pass);
  return { pass, durationMs: Date.now() - t0, samplesDir, steps };
}

module.exports = { runSmoke };
