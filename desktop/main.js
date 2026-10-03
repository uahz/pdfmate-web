'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { Store } = require('./lib/store');
const { Queue } = require('./lib/queue');
const engines = require('./lib/engines');
const { ensureDir, parsePageRange } = require('./lib/util');

const SMOKE = process.argv.includes('--smoke');
const DEMO_SHOT = process.argv.includes('--demo-shot');
if (DEMO_SHOT) {
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
}
let win = null;
let store, queue;
let lastSnapshot = null;
let updateTimer = null;

// 渲染端写盘令牌：pdf2img:prepare 签发，限定只能写入登记目录内的纯文件名
const writeTokens = new Map(); // token -> { dir, expires }
const TOKEN_TTL = 60 * 60 * 1000;
const SAFE_NAME_RE = /^[^\\/:*?"<>|\x00-\x1f]+$/;

function issueToken(dir) {
  const token = crypto.randomBytes(12).toString('hex');
  writeTokens.set(token, { dir: path.resolve(dir), expires: Date.now() + TOKEN_TTL });
  return token;
}
function resolveInTokenDir(token, name) {
  const t = writeTokens.get(token);
  if (!t || Date.now() > t.expires) throw new Error('写盘令牌无效或已过期');
  if (!SAFE_NAME_RE.test(name) || name.includes('..')) throw new Error('非法文件名');
  const target = path.resolve(t.dir, name);
  if (target !== t.dir && !target.startsWith(t.dir + path.sep)) throw new Error('路径越界');
  return target;
}

app.setAppUserModelId('com.pdfmate.app');
const gotLock = app.requestSingleInstanceLock();
if (!gotLock && !SMOKE) { app.quit(); }

// 收集命令行传入的文件路径（右键菜单 / 拖到快捷方式 / second-instance）
function filesFromArgv(argv) {
  return argv.slice(1).filter(a => {
    try { return fs.existsSync(a) && fs.statSync(a).isFile(); } catch { return false; }
  });
}

app.on('second-instance', (_e, argv) => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
    const files = filesFromArgv(argv);
    if (files.length) win.webContents.send('files:add', files);
  }
});

function createWindow() {
  const bounds = (store.settings.windowBounds) || {};
  win = new BrowserWindow({
    width: bounds.width || 1440,
    height: bounds.height || 900,
    minWidth: 1160,
    minHeight: 720,
    frame: false,
    show: !SMOKE,
    backgroundColor: '#0B1226',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'),
    SMOKE ? { query: { smoke: '1' } }
      : DEMO_SHOT ? { query: { demo: '1' } }
      : undefined);
  win.on('ready-to-show', () => { if (!SMOKE && !DEMO_SHOT) win.show(); });
  win.webContents.on('console-message', (_e, _lv, message, line, sourceId) => {
    if ((SMOKE || DEMO_SHOT) && message) console.log('[RENDERER ' + (sourceId || '?').split(/[\\/]/).pop() + ':' + line + '] ' + message);
  });
  win.webContents.on('preload-error', (_e, p, err) => console.log('[PRELOAD_ERROR]', p, String(err)));
  win.webContents.on('did-fail-load', (_e, code, desc) => { if (SMOKE || DEMO_SHOT) console.log('[LOAD_FAIL]', code, desc); });
  // 右键菜单 / 命令行传入的文件
  const argFiles = filesFromArgv(process.argv);
  if (argFiles.length) {
    win.webContents.once('did-finish-load', () => win.webContents.send('files:add', argFiles));
  }
  if (DEMO_SHOT) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const img = await win.webContents.capturePage();
          fs.writeFileSync(path.join(__dirname, 'ui-preview.png'), img.toPNG());
          console.log('DEMO_SHOT saved: ui-preview.png');
        } catch (e) { console.error('DEMO_SHOT fail', e); }
        app.exit(0);
      }, 1500);
    });
  }
  const saveBounds = () => { if (!win.isDestroyed() && !SMOKE) store.saveSettings({ windowBounds: win.getBounds() }); };
  win.on('resized', saveBounds);
  win.on('moved', saveBounds);
  win.on('closed', () => { win = null; });
}

function broadcast(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function scheduleUpdate(snapshot) {
  lastSnapshot = snapshot;
  if (updateTimer) return;
  updateTimer = setTimeout(() => {
    updateTimer = null;
    broadcast('queue:update', lastSnapshot);
  }, 80);
}

function isElevated() {
  try {
    const r = spawnSync('whoami', ['/groups'], { encoding: 'utf8', windowsHide: true });
    return /S-1-16-12288/.test(r.stdout || '');
  } catch { return false; }
}

function registerIpc() {
  // 窗口控制
  ipcMain.on('win:minimize', () => win && win.minimize());
  ipcMain.on('win:maximize', () => win && (win.isMaximized() ? win.unmaximize() : win.maximize()));
  ipcMain.on('win:close', () => win && win.close());

  // 对话框
  ipcMain.handle('dialog:openFiles', async () => {
    const r = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '支持的文件', extensions: ['docx', 'doc', 'rtf', 'txt', 'xlsx', 'xls', 'csv', 'pptx', 'ppt', 'pps', 'ppsx', 'jpg', 'jpeg', 'png', 'pdf'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    });
    return r.canceled ? [] : r.filePaths;
  });
  ipcMain.handle('dialog:openFolder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });

  // 引擎与设置
  ipcMain.handle('engine:status', () => {
    queue.detect = engines.detectEngines();
    return { detect: queue.detect, active: queue.engineName(), setting: store.settings.engine, elevated: isElevated() };
  });
  ipcMain.handle('settings:get', () => store.settings);
  ipcMain.handle('settings:set', (_e, patch) => {
    store.saveSettings(patch || {});
    queue.settings = store.settings; // 队列实时读取最新引擎设置
    return store.settings;
  });
  ipcMain.handle('history:list', () => store.history);
  ipcMain.handle('history:clear', () => { store.clearHistory(); return true; });

  // 队列
  ipcMain.handle('queue:getState', () => lastSnapshot || { jobs: [], paused: false, engine: queue.engineName() });
  ipcMain.handle('queue:add', (_e, batch) => queue.addBatch(batch));
  ipcMain.on('queue:pause', () => queue.pause());
  ipcMain.on('queue:resume', () => queue.resume());
  ipcMain.on('queue:cancelAll', () => queue.cancelAll());
  ipcMain.handle('queue:retryFailed', () => { queue.retryFailed(); return true; });
  ipcMain.handle('queue:clearFinished', () => { queue.clearFinished(); return true; });

  // 文件系统
  ipcMain.handle('fs:readBytes', async (_e, p) => {
    const st = await fs.promises.stat(p);
    if (!st.isFile()) throw new Error('NOT_A_FILE');
    const buf = await fs.promises.readFile(p);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  });
  ipcMain.handle('fs:writeBytes', async (_e, token, name, data) => {
    const target = resolveInTokenDir(token, name);
    await fs.promises.writeFile(target, Buffer.from(new Uint8Array(data)));
    return target;
  });
  ipcMain.handle('fs:probeDir', async (_e, p) => {
    try { const st = await fs.promises.stat(p); return st.isDirectory(); } catch { return false; }
  });
  ipcMain.on('open:path', (_e, p) => {
    try { shell.showItemInFolder(p); } catch {}
  });
  ipcMain.handle('open:dir', async (_e, p) => { await shell.openPath(p); return true; });

  // PDF→图片（渲染端驱动；主进程签发写盘令牌）
  ipcMain.on('pdf2img:progress', (_e, { jobId, page, total }) => queue.renderProgress(jobId, page, total));
  ipcMain.handle('pdf2img:done', (_e, { jobId, ok, outPath, pages, error }) => {
    queue.renderDone(jobId, { ok, outPath, pages, error });
    return true;
  });
  ipcMain.handle('pdf2img:prepare', async (_e, { src, outDir, dpi, format, quality, range, zip }) => {
    const buf = await fs.promises.readFile(src);
    const { pdfPageCount } = require('./lib/pdfops');
    const total = await pdfPageCount(new Uint8Array(buf));
    const pages = parsePageRange(range, total) || Array.from({ length: total }, (_, i) => i + 1);
    const dir = zip
      ? path.join(path.dirname(outDir || src), path.basename(src, path.extname(src)) + '_images')
      : (outDir || path.dirname(src));
    ensureDir(dir);
    const token = issueToken(dir);
    const prefix = path.basename(src, path.extname(src));
    return { token, total, pages, dir, prefix, src };
  });
  ipcMain.handle('pdf2img:zip', async (_e, { token }) => {
    const t = writeTokens.get(token);
    if (!t || Date.now() > t.expires) throw new Error('写盘令牌无效或已过期');
    const archiver = require('archiver');
    const zipPath = t.dir + '.zip';
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(zipPath);
      const archive = archiver('zip', { zlib: { level: zlib.constants.Z_BEST_SPEED } });
      output.on('close', resolve);
      archive.on('error', reject);
      archive.pipe(output);
      archive.directory(t.dir, path.basename(t.dir));
      archive.finalize();
    });
    return zipPath;
  });

  // 烟雾测试桥
  ipcMain.on('smoke:rendererResult', (_e, result) => {
    global.__smokeRendererResult = result;
  });
  ipcMain.handle('smoke:getContext', () => global.__smokeCtx || null);
  ipcMain.handle('smoke:saveSample', async (_e, name, data) => {
    if (!SAFE_NAME_RE.test(name) || name.includes('..')) throw new Error('非法文件名');
    const dir = path.resolve(global.__smokeCtx.samplesDir);
    const target = path.resolve(dir, name);
    if (!target.startsWith(dir + path.sep)) throw new Error('路径越界');
    await fs.promises.writeFile(target, Buffer.from(new Uint8Array(data)));
    return target;
  });
}

function wireQueue() {
  queue.on('update', scheduleUpdate);
  queue.on('render-request', ({ job, batch }) => {
    broadcast('render:request', {
      jobId: job.id,
      kind: batch.mode,
      src: job.src,
      dpi: batch.params.pdf2imgDpi || 150,
      format: batch.params.pdf2imgFormat || 'png',
      quality: batch.params.pdf2imgQuality || 0.92,
      range: batch.params.pdf2imgRange || '',
      zip: batch.params.pdf2imgZip !== false,
      compressLevel: batch.params.compressLevel || 'standard',
      outDir: batch.outDir || null
    });
  });
  queue.on('batch-done', ({ done, failed, total }) => {
    broadcast('notify', { type: done && !failed ? 'ok' : (failed ? 'err' : 'info'), title: '批次完成', text: `成功 ${done} · 失败 ${failed} · 共 ${total}` });
  });
  queue.on('engine-fallback', ({ to, reason }) => {
    store.saveSettings({ engine: to });
    queue.settings = store.settings;
    broadcast('notify', { type: 'warn', title: '已切换备用引擎（' + (to === 'soffice' ? 'LibreOffice' : to) + '）', text: reason });
  });
}

app.whenReady().then(async () => {
  store = new Store();
  queue = new Queue({ settings: store.settings, history: store, userDataDir: app.getPath('userData') });
  wireQueue();
  registerIpc();
  createWindow();

  if (SMOKE) {
    const { runSmoke } = require('./smoke');
    try {
      const report = await runSmoke({ app, queue, store, win, engines });
      const out = path.join(__dirname, 'smoke-report.json');
      fs.writeFileSync(out, JSON.stringify(report, null, 2), 'utf8');
      console.log('SMOKE_RESULT ' + JSON.stringify({ pass: report.pass, failed: report.steps.filter(s => !s.pass).length, report: out }));
      for (const s of report.steps) console.log(`  [${s.pass ? 'PASS' : 'FAIL'}] ${s.name} ${s.detail || ''}`);
      app.exit(report.pass ? 0 : 1);
    } catch (e) {
      console.error('SMOKE_FATAL', e);
      app.exit(2);
    }
  }
});

app.on('window-all-closed', () => {
  if (queue) queue.cleanupAll();
  if (!SMOKE) app.quit();
});
