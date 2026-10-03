'use strict';
// 转换引擎层：双引擎策略
//  - office：MS Office COM（还原度最高，需本机装有 Office，通过 PowerShell 桥调用）
//  - soffice：LibreOffice headless（自动检测，多实例以 profile 隔离）
// 安全约定：所有子进程一律使用参数数组（shell=false），不拼接命令字符串。
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { ensureDir } = require('./util');

const PS_BRIDGE = path.join(__dirname, '..', 'engines', 'run-office.ps1');
const ENGINES_DIR = path.dirname(PS_BRIDGE);
const MAKE_SAMPLES_PS1 = path.join(ENGINES_DIR, 'make-samples.ps1');
const PROBE_PS1 = path.join(ENGINES_DIR, 'probe-office.ps1');

// ---------- Office COM 健康探测（异步，防批量任务被卡死） ----------
let probeCache = { ts: 0, ok: false, error: null };
const PROBE_TTL_OK = 5 * 60 * 1000;
const PROBE_TTL_FAIL = 10 * 60 * 1000;

function probeOfficeCached() {
  const ttl = probeCache.ok ? PROBE_TTL_OK : PROBE_TTL_FAIL;
  if (Date.now() - probeCache.ts < ttl) return probeCache;
  return null;
}

function probeOffice(timeoutMs = 30000) {
  return new Promise((resolve) => {
    const cached = probeOfficeCached();
    if (cached) return resolve(cached);
    const child = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PROBE_PS1
    ], { windowsHide: true });
    let out = '';
    let done = false;
    const timer = setTimeout(() => {
      if (done) return; done = true;
      killTree(child.pid);
      probeCache = { ts: Date.now(), ok: false, error: 'PROBE_TIMEOUT' };
      resolve(probeCache);
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.on('exit', () => {
      if (done) return; done = true; clearTimeout(timer);
      const m = out.match(/^(OK|ERR)\|(.+)$/m);
      if (m && m[1] === 'OK') {
        probeCache = { ts: Date.now(), ok: true, error: null };
      } else {
        let msg = 'COM UNKNOWN';
        if (m) { try { msg = Buffer.from(m[2], 'base64').toString('utf8'); } catch {} }
        probeCache = { ts: Date.now(), ok: false, error: msg };
      }
      resolve(probeCache);
    });
    child.on('error', () => {
      if (done) return; done = true; clearTimeout(timer);
      probeCache = { ts: Date.now(), ok: false, error: 'PROBE_SPAWN_FAILED' };
      resolve(probeCache);
    });
  });
}

function probeMessage(error) {
  const e = String(error || '');
  if (e === 'PROBE_TIMEOUT') return 'Office 引擎无响应（可能被首次运行/激活对话框阻塞）。请先手动打开一次 Word/Excel 完成初始设置后重试；若已安装 LibreOffice，将自动改用它。';
  if (e.includes('0x80040154')) return 'Office COM 类未注册（Office 可能是商店版或未完整安装）。';
  if (e.includes('0x80080005') || e.toLowerCase().includes('server execution')) return 'Office 服务启动失败（常由管理员权限运行引起，请以普通方式启动应用）。';
  return 'Office 引擎探测失败：' + e;
}

const REG_KEYS = {
  word: 'HKEY_CLASSES_ROOT\\Word.Application\\CurVer',
  excel: 'HKEY_CLASSES_ROOT\\Excel.Application\\CurVer',
  ppt: 'HKEY_CLASSES_ROOT\\PowerPoint.Application\\CurVer'
};

function _regQuery(key) {
  const r = spawnSync('reg', ['query', key, '/ve'], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0 || !r.stdout) return null;
  const m = r.stdout.match(/REG_SZ\s+(\S+)/);
  return m ? m[1] : null;
}

function detectEngines() {
  const word = _regQuery(REG_KEYS.word);
  const excel = _regQuery(REG_KEYS.excel);
  const ppt = _regQuery(REG_KEYS.ppt);
  let soffice = null;
  const candidates = [
    'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
    'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'LibreOffice', 'program', 'soffice.exe')
  ];
  for (const c of candidates) { if (fs.existsSync(c)) { soffice = c; break; } }
  return { office: { word, excel, ppt, available: !!(word && excel) }, soffice };
}

function resolveEngine(detect, setting) {
  if (setting === 'office') return detect.office.available ? 'office' : null;
  if (setting === 'soffice') return detect.soffice ? 'soffice' : null;
  // auto：优先 LibreOffice（无头、确定性、不受首次运行对话框影响）；
  // 需要 Office 原生还原度时可在设置中将引擎改为 office（带超时保护与健康探测）。
  if (detect.soffice) return 'soffice';
  if (detect.office.available) return 'office';
  return null;
}

function killTree(pid) {
  if (!pid) return;
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
}

// ---------- Office COM 桥 ----------
// paths 分块调用 PowerShell（每块一个 PS 进程、复用同一组 Office 实例），
// 每个文件回传一行 OK|name / ERR|name|msg。
function officeConvertChunk(paths, outDir, timeoutMs, onSpawn) {
  return new Promise((resolve) => {
    const listFile = path.join(outDir, `pm-list-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.lst`);
    // UTF-16LE with BOM：保证中文路径可被 PowerShell 正确读取
    fs.writeFileSync(listFile, '\ufeff' + paths.join('\r\n'), 'utf16le');
    const child = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS_BRIDGE,
      '-ListFile', listFile, '-OutDir', outDir
    ], { windowsHide: true });

    const results = new Map();
    let buf = '';
    if (onSpawn) onSpawn(child);

    const timer = setTimeout(() => {
      killTree(child.pid);
      resolve({ results, timedOut: true });
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        // 行格式：OK|name  或  ERR|name|HRESULT|base64(UTF8 message)
        const m = line.match(/^(OK|ERR)\|(.+?)(?:\|(?:(.*)))?$/);
        if (!m) continue;
        const [, status, name, rest] = m;
        if (name === 'DONE') continue;
        let error = null;
        if (status === 'ERR') {
          error = rest || 'CONVERT_FAILED';
          const parts = String(rest || '').split('|');
          if (parts.length >= 2) {
            try { error = 'COM ' + parts[0] + ': ' + Buffer.from(parts[1], 'base64').toString('utf8'); } catch {}
          }
        }
        results.set(name, { ok: status === 'OK', error });
      }
    });
    child.on('exit', () => {
      clearTimeout(timer);
      try { fs.unlinkSync(listFile); } catch {}
      resolve({ results, timedOut: false });
    });
    child.on('error', () => {
      clearTimeout(timer);
      try { fs.unlinkSync(listFile); } catch {}
      for (const p of paths) results.set(path.basename(p, path.extname(p)), { ok: false, error: 'ENGINE_SPAWN_FAILED' });
      resolve({ results, timedOut: false });
    });
  });
}

async function officeConvert(paths, outDir, { chunkSize = 15, timeoutBaseMs = 90000, perFileMs = 20000, onProgress, shouldCancel } = {}) {
  ensureDir(outDir);
  const all = [];
  for (let i = 0; i < paths.length; i += chunkSize) {
    if (shouldCancel && shouldCancel()) {
      for (const p of paths.slice(i)) all.push({ src: p, ok: false, error: 'CANCELED' });
      break;
    }
    const chunk = paths.slice(i, i + chunkSize);
    const timeout = timeoutBaseMs + chunk.length * perFileMs;
    const { results, timedOut } = await officeConvertChunk(chunk, outDir, timeout);
    for (const p of chunk) {
      const name = path.basename(p, path.extname(p));
      const r = results.get(name);
      if (r && r.ok) {
        const out = path.join(outDir, name + '.pdf');
        all.push({ src: p, ok: fs.existsSync(out), out, error: r.ok ? null : 'NO_OUTPUT' });
      } else {
        all.push({ src: p, ok: false, error: timedOut ? 'CONVERT_TIMEOUT' : (r ? mapComError(r.error) : 'CONVERT_FAILED') });
      }
      if (onProgress) onProgress(p, all[all.length - 1]);
    }
  }
  return all;
}

function mapComError(code) {
  const c = String(code || '').toUpperCase();
  if (c.includes('FILE_NOT_FOUND')) return '文件不存在或无法访问';
  if (c.includes('UNSUPPORTED')) return '不支持的文件类型';
  if (c.includes('NO_OUTPUT')) return '引擎未生成输出文件';
  if (c.includes('TIMEOUT')) return '转换超时';
  if (c.includes('CANNOT') || c.includes('OPEN')) return '文件无法打开（可能已损坏或被占用）';
  if (c.includes('PASSWORD') || c.includes('ENCRYPT')) return '文件已加密，请先解锁';
  return '转换失败（引擎错误）';
}

// ---------- LibreOffice 桥 ----------
let loSlot = 0;
async function sofficeConvert(paths, outDir, { sofficePath, profileDir, format = 'pdf', onProgress, shouldCancel } = {}) {
  ensureDir(outDir);
  const slot = (loSlot = (loSlot + 1) % 2);
  const profile = '-env:UserInstallation=file:///' + path.join(profileDir, 'slot' + slot).replace(/\\/g, '/');
  const args = ['--headless', '--norestore', profile, '--convert-to', format, '--outdir', outDir, ...paths];
  return new Promise((resolve) => {
    const child = spawn(sofficePath, args, { windowsHide: true });
    let done = false;
    const timer = setTimeout(() => {
      killTree(child.pid);
      finish(true);
    }, 120000 + paths.length * 30000);
    function finish(timedOut) {
      if (done) return; done = true; clearTimeout(timer);
      const ext = format.startsWith('docx') ? 'docx' : format.startsWith('xlsx') ? 'xlsx' : 'pdf';
      const results = paths.map((p) => {
        if (shouldCancel && shouldCancel()) return { src: p, ok: false, error: 'CANCELED' };
        const out = path.join(outDir, path.basename(p, path.extname(p)) + '.' + ext);
        const ok = !timedOut && fs.existsSync(out);
        return { src: p, ok, out: ok ? out : null, error: ok ? null : (timedOut ? '转换超时' : '转换失败（引擎错误）') };
      });
      resolve(results);
    }
    child.on('exit', () => finish(false));
    child.on('error', () => finish(false));
  });
}

module.exports = { detectEngines, resolveEngine, officeConvert, sofficeConvert, mapComError, MAKE_SAMPLES_PS1, probeOffice, probeMessage };
