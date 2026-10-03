'use strict';
// 批量任务队列：并发调度、分块、重试、暂停/取消、进度事件
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');
const { extKind, officeKind, ensureDir, uniquePath } = require('./util');
const { imagePageBytes, imagesToOnePdf, mergePdfBytes } = require('./pdfops');
const engines = require('./engines');

const IMG_CONCURRENCY = 4;

class Queue extends EventEmitter {
  constructor({ settings, history, userDataDir }) {
    super();
    this.settings = settings;
    this.history = history;
    this.userDataDir = userDataDir;
    this.detect = engines.detectEngines();
    this.batches = [];        // {id, mode, jobs[], params, outDir, mergedName, createdAt}
    this.jobs = [];           // flat, ordered
    this.paused = false;
    this.cancelAllFlag = false;
    this.running = false;
    this.activeChild = null;  // 当前引擎子进程（取消时 kill）
    this._seq = 0;
    this._tmpDirs = new Set();
  }

  newId() { return `j${Date.now().toString(36)}-${(++this._seq).toString(36)}`; }

  engineName() { return engines.resolveEngine(this.detect, this.settings.engine); }

  // ---------- 对外入口 ----------
  addBatch({ mode, items, params = {}, outDir, mergedName }) {
    if (!items || !items.length) return null;
    const batch = {
      id: this.newId(),
      mode,                    // to-pdf | img-merge | merge | pdf2img
      params,
      outDir,                  // null => 每个文件同源目录
      mergedName: mergedName || '合并文档',
      createdAt: Date.now(),
      jobs: items.map((it, idx) => ({
        id: this.newId(),
        batchId: null,
        src: it.path,
        name: path.basename(it.path),
        kind: it.kind,
        order: idx,
        status: 'queued',      // queued|running|await-render|done|error|canceled
        progress: 0,
        outPath: null,
        pages: null,
        error: null,
        engine: null,
        startedAt: null,
        finishedAt: null
      }))
    };
    batch.jobs.forEach(j => { j.batchId = batch.id; });
    this.batches.push(batch);
    this.jobs.push(...batch.jobs);
    this._emit();
    this._pump();
    return batch.id;
  }

  pause() { this.paused = true; this._emit(); }
  resume() { this.paused = false; this._pump(); this._emit(); }

  cancelAll() {
    this.cancelAllFlag = true;
    if (this.activeChild) { try { process.kill(-this.activeChild.pid); } catch {} try { this.activeChild.kill(); } catch {} }
    for (const j of this.jobs) {
      if (['queued', 'await-render'].includes(j.status)) { j.status = 'canceled'; j.error = '已取消'; }
    }
    this._emit();
  }

  retryFailed() {
    for (const j of this.jobs) {
      if (j.status === 'error') { j.status = 'queued'; j.error = null; j.progress = 0; }
    }
    this._emit();
    this._pump();
  }

  clearFinished() {
    this.jobs = this.jobs.filter(j => !['done', 'error', 'canceled', 'skipped'].includes(j.status));
    this.batches = this.batches.filter(b => b.jobs.some(j => this.jobs.includes(j)));
    this._emit();
  }

  // ---------- 调度 ----------
  _snapshot() {
    return {
      paused: this.paused,
      engine: this.engineName(),
      jobs: this.jobs.map(j => ({
        id: j.id, name: j.name, kind: j.kind, mode: this._modeOf(j), order: j.order,
        status: j.status, progress: j.progress, error: j.error,
        engine: j.engine, pages: j.pages, src: j.src, outPath: j.outPath
      }))
    };
  }
  _modeOf(j) { const b = this.batches.find(b => b.id === j.batchId); return b ? b.mode : ''; }

  _emit() { this.emit('update', this._snapshot()); }

  _pump() {
    if (this.running || this.paused) return;
    const batch = this.batches.find(b => b.jobs.some(j => j.status === 'queued' || j.status === 'await-render'));
    if (!batch) { this.running = false; this._maybeReport(); return; }
    this.running = true;
    this._runBatch(batch).catch(e => {
      for (const j of batch.jobs) if (j.status === 'queued' || j.status === 'running' || j.status === 'await-render') { j.status = 'error'; j.error = String(e && e.message || e); }
    }).finally(() => {
      this.running = false;
      this._emit();
      this._maybeReport(batch);
      if (!this.cancelAllFlag) setImmediate(() => this._pump());
    });
  }

  _maybeReport(batch) {
    const list = batch ? [batch] : this.batches;
    for (const b of list) {
      if (b._reported) continue;
      const active = b.jobs.filter(j => ['queued', 'running', 'await-render'].includes(j.status));
      if (b.jobs.length && active.length === 0) {
        b._reported = true;
        const done = b.jobs.filter(j => j.status === 'done').length;
        const failed = b.jobs.filter(j => j.status === 'error').length;
        this.history.addHistory(b.jobs.map(j => ({
          src: j.src, out: j.outPath, mode: b.mode, status: j.status,
          engine: j.engine, pages: j.pages, error: j.error,
          durationMs: j.finishedAt && j.startedAt ? j.finishedAt - j.startedAt : null,
          at: j.finishedAt || Date.now()
        })));
        this.emit('batch-done', { batchId: b.id, done, failed, total: b.jobs.length, jobs: b.jobs });
      }
    }
  }

  async _runBatch(batch) {
    const jobs = batch.jobs;
    if (batch.mode === 'to-pdf') {
      // Office 文件分块走引擎；图片并发走 pdf-lib
      const officeJobs = jobs.filter(j => j.kind === 'office' && j.status === 'queued');
      const imageJobs = jobs.filter(j => j.kind === 'image' && j.status === 'queued');
      const pdfJobs = jobs.filter(j => j.kind === 'pdf' && j.status === 'queued');

      if (pdfJobs.length) {
        for (const j of pdfJobs) { j.status = 'error'; j.error = 'PDF 文件无需转换，请在「PDF 转图片」或「合并」模式中使用'; }
        this._emit();
      }

      const engine = this.engineName();
      const imgTasks = [];
      if (batch.params.imgMergeToOne && imageJobs.length > 0) {
        // 多图合一：作为单一任务处理
        imgTasks.push({ merged: true, jobs: imageJobs });
      } else {
        for (const j of imageJobs) imgTasks.push({ merged: false, jobs: [j] });
      }

      await Promise.all([
        this._runOfficeGroup(officeJobs, batch),
        this._runImageTasks(imgTasks, batch)
      ]);
    } else if (batch.mode === 'img-merge') {
      await this._runImageTasks([{ merged: true, jobs: jobs.filter(j => j.kind === 'image' && j.status === 'queued') }], batch);
    } else if (batch.mode === 'merge') {
      await this._runMerge(batch);
    } else if (batch.mode === 'pdf2img') {
      for (const j of jobs.filter(j => j.status === 'queued')) {
        j.status = 'await-render';
        j.engine = 'pdfium(pdf.js)';
        this._emit();
        this.emit('render-request', { job: j, batch });
        // 渲染端完成后回调 _finishRenderJob
        await new Promise((resolve) => {
          const h = (data) => {
            if (data.jobId !== j.id) return;
            this.removeListener('render-done', h);
            resolve();
          };
          this.on('render-done', h);
        });
      }
    }
  }

  _outDirFor(batch, src) {
    return batch.outDir || path.dirname(src);
  }

  async _runOfficeGroup(jobs, batch) {
    if (!jobs.length) return;
    let engineTag = this.engineName();
    if (!engineTag) {
      for (const j of jobs) { j.status = 'error'; j.error = '未检测到可用转换引擎（需要 MS Office 或 LibreOffice）'; }
      this._emit();
      return;
    }
    // COM 健康探测：无响应时自动降级 LibreOffice，避免批量任务卡死
    if (engineTag === 'office') {
      const probe = await engines.probeOffice();
      if (!probe.ok) {
        if (this.detect.soffice) {
          engineTag = 'soffice';
          this.emit('engine-fallback', { from: 'office', to: 'soffice', reason: engines.probeMessage(probe.error) });
        } else {
          for (const j of jobs) { j.status = 'error'; j.error = engines.probeMessage(probe.error); j.engine = 'MS Office COM'; }
          this._emit();
          return;
        }
      }
    }
    for (const j of jobs) { j.engine = engineTag === 'office' ? 'MS Office COM' : 'LibreOffice'; j.status = 'running'; j.startedAt = Date.now(); }
    this._emit();

    const firstOut = this._outDirFor(batch, jobs[0].src);
    // 分块共享同一个临时目录，避免同名冲突；结束后把成品搬到各自目标目录
    const tmpOut = path.join(this.userDataDir, 'convert-tmp', batch.id);
    ensureDir(tmpOut);
    this._tmpDirs.add(tmpOut);

    const paths = jobs.map(j => j.src);
    // 分块转换：同一块内 basename 必须唯一（LibreOffice 按源文件名输出，重名会互相覆盖）
    const chunks = [];
    let cur = [];
    let seen = new Set();
    for (const p of paths) {
      const b = path.basename(p).toLowerCase();
      if (seen.has(b)) { chunks.push(cur); cur = []; seen = new Set(); }
      seen.add(b);
      cur.push(p);
    }
    if (cur.length) chunks.push(cur);

    const results = [];
    for (const chunk of chunks) {
      const r = engineTag === 'office'
        ? await engines.officeConvert(chunk, tmpOut, {
            onSpawn: (child) => { this.activeChild = child; },
            shouldCancel: () => this.cancelAllFlag
          })
        : await engines.sofficeConvert(chunk, tmpOut, {
            sofficePath: this.detect.soffice,
            profileDir: path.join(this.userDataDir, 'lo-profiles'),
            shouldCancel: () => this.cancelAllFlag
          });
      results.push(...r);
    }

    this.activeChild = null;
    for (const j of jobs) {
      const r = results.find(r => path.resolve(r.src) === path.resolve(j.src));
      j.finishedAt = Date.now();
      if (r && r.ok) {
        const destDir = this._outDirFor(batch, j.src);
        ensureDir(destDir);
        const dest = uniquePath(path.join(destDir, path.basename(r.out)));
        fs.copyFileSync(r.out, dest);
        j.outPath = dest;
        j.status = 'done';
        j.progress = 1;
      } else {
        j.status = this.cancelAllFlag && (!r || r.error === 'CANCELED') ? 'canceled' : 'error';
        j.error = r ? r.error : '转换失败';
      }
    }
    this._cleanupTmp(tmpOut);
    this._emit();
  }

  async _runImageTasks(tasks, batch) {
    let active = 0;
    const list = tasks.filter(t => t.jobs.length);
    await Promise.all(list.map(t => new Promise((resolve) => {
      const tryStart = () => {
        if (this.cancelAllFlag) { for (const j of t.jobs) if (j.status === 'queued') { j.status = 'canceled'; j.error = '已取消'; } return resolve(); }
        if (active >= IMG_CONCURRENCY) { setTimeout(tryStart, 60); return; }
        active++;
        this._runOneImageTask(t, batch).finally(() => { active--; resolve(); });
      };
      tryStart();
    })));
  }

  async _runOneImageTask(task, batch) {
    const jobs = task.jobs;
    for (const j of jobs) { j.status = 'running'; j.engine = 'pdf-lib'; j.startedAt = Date.now(); }
    this._emit();
    try {
      const bytesList = [];
      for (const j of jobs) {
        if (this.cancelAllFlag) throw new Error('CANCELED');
        bytesList.push(new Uint8Array(fs.readFileSync(j.src)));
      }
      const out = task.merged
        ? await imagesToOnePdf(bytesList, { pageSize: batch.params.imgPageSize || 'auto' })
        : await imagePageBytes(bytesList[0], { pageSize: batch.params.imgPageSize || 'auto' });
      for (const j of jobs) {
        const dir = this._outDirFor(batch, j.src);
        ensureDir(dir);
        const base = task.merged ? (batch.mergedName || '图片合并') : path.basename(j.src, path.extname(j.src));
        const dest = uniquePath(path.join(dir, base + '.pdf'));
        fs.writeFileSync(dest, Buffer.from(out));
        j.outPath = dest; j.status = 'done'; j.progress = 1; j.pages = task.merged ? jobs.length : 1; j.finishedAt = Date.now();
      }
    } catch (e) {
      const msg = String(e && e.message || e) === 'CANCELED' ? '已取消'
        : String(e && e.message || e) === 'IMAGE_DECODE_FAILED' ? '图片解码失败（V1 支持 JPG/PNG）' : String(e && e.message || e);
      for (const j of jobs) { j.status = msg === '已取消' ? 'canceled' : 'error'; j.error = msg; j.finishedAt = Date.now(); }
    }
    this._emit();
  }

  async _runMerge(batch) {
    const jobs = batch.jobs.filter(j => !['done'].includes(j.status));
    if (!jobs.length) return;
    let engine = this.engineName();
    if (engine === 'office') {
      const probe = await engines.probeOffice();
      if (!probe.ok) {
        if (this.detect.soffice) {
          engine = 'soffice';
          this.emit('engine-fallback', { from: 'office', to: 'soffice', reason: engines.probeMessage(probe.error) });
        } else {
          for (const j of jobs.filter(j => j.kind === 'office')) { j.status = 'error'; j.error = engines.probeMessage(probe.error); j.engine = 'MS Office COM'; }
        }
      }
    }
    const main = jobs[0];
    main.status = 'running'; main.engine = 'pdf-lib'; main.startedAt = Date.now();
    for (const j of jobs.slice(1)) { j.status = 'running'; j.progress = 0; j.engine = j.kind === 'office' ? (engine || '无') : 'pdf-lib'; }
    this._emit();

    // 1) Office 子项先经引擎转出临时 PDF
    const officeJobs = jobs.filter(j => j.kind === 'office');
    const tmpOut = path.join(this.userDataDir, 'convert-tmp', batch.id);
    ensureDir(tmpOut);
    this._tmpDirs.add(tmpOut);
    const converted = new Map(); // job -> pdf bytes
    if (officeJobs.length) {
      if (!engine) { for (const j of officeJobs) { j.status = 'error'; j.error = '未检测到可用转换引擎'; } this._emit(); }
      else {
        const results = engine === 'office'
          ? await engines.officeConvert(officeJobs.map(j => j.src), tmpOut, { onSpawn: c => { this.activeChild = c; }, shouldCancel: () => this.cancelAllFlag })
          : await engines.sofficeConvert(officeJobs.map(j => j.src), tmpOut, { sofficePath: this.detect.soffice, profileDir: path.join(this.userDataDir, 'lo-profiles'), shouldCancel: () => this.cancelAllFlag });
        this.activeChild = null;
        for (const j of officeJobs) {
          const r = results.find(r => path.resolve(r.src) === path.resolve(j.src));
          if (r && r.ok) { converted.set(j, new Uint8Array(fs.readFileSync(r.out))); j.progress = 1; }
          else { j.status = this.cancelAllFlag ? 'canceled' : 'error'; j.error = r ? r.error : '转换失败'; }
        }
      }
    }
    // 2) 图片子项 -> 单页 PDF 字节
    for (const j of jobs.filter(j => j.kind === 'image')) {
      if (j.status === 'error' || j.status === 'canceled') continue;
      if (this.cancelAllFlag) { j.status = 'canceled'; j.error = '已取消'; continue; }
      try { converted.set(j, await imagePageBytes(new Uint8Array(fs.readFileSync(j.src)), { pageSize: batch.params.imgPageSize || 'auto' })); j.progress = 1; }
      catch (e) { j.status = 'error'; j.error = '图片解码失败（V1 支持 JPG/PNG）'; }
    }
    // 3) 现有 PDF 直接读取
    for (const j of jobs.filter(j => j.kind === 'pdf')) {
      if (j.status === 'error' || j.status === 'canceled') continue;
      try { converted.set(j, new Uint8Array(fs.readFileSync(j.src))); j.progress = 1; }
      catch (e) { j.status = 'error'; j.error = 'PDF 无法读取（可能已加密）'; }
    }

    if (main.status !== 'running') { this._cleanupTmp(tmpOut); this._emit(); return; } // 主项失败/取消
    // 4) 合并
    try {
      if (this.cancelAllFlag) throw new Error('CANCELED');
      const ordered = jobs.map(j => converted.get(j)).filter(Boolean);
      if (ordered.length < 1) throw new Error('没有可合并的内容');
      const { bytes, pages } = await mergePdfBytes(ordered);
      const dir = this._outDirFor(batch, main.src);
      ensureDir(dir);
      const dest = uniquePath(path.join(dir, (batch.mergedName || '合并文档') + '.pdf'));
      fs.writeFileSync(dest, Buffer.from(bytes));
      main.outPath = dest; main.status = 'done'; main.progress = 1; main.pages = pages; main.finishedAt = Date.now();
      for (const j of jobs.slice(1)) if (j.status === 'running') { j.status = 'done'; j.progress = 1; j.finishedAt = Date.now(); }
    } catch (e) {
      const msg = String(e && e.message || e) === 'CANCELED' ? '已取消' : String(e && e.message || e);
      main.status = msg === '已取消' ? 'canceled' : 'error'; main.error = msg; main.finishedAt = Date.now();
      for (const j of jobs.slice(1)) if (j.status === 'running') { j.status = msg === '已取消' ? 'canceled' : 'skipped'; j.error = msg === '已取消' ? '已取消' : '合并中止'; }
    }
    this._cleanupTmp(tmpOut);
    this._emit();
  }

  // ---------- 渲染端 PDF→图片回调 ----------
  renderProgress(jobId, page, total) {
    const j = this.jobs.find(x => x.id === jobId);
    if (!j) return;
    j.progress = total ? page / total : 0;
    this.emit('update', this._snapshot());
  }
  renderDone(jobId, { ok, outPath, pages, error }) {
    const j = this.jobs.find(x => x.id === jobId);
    if (!j) return;
    j.finishedAt = Date.now();
    if (ok) { j.status = 'done'; j.progress = 1; j.outPath = outPath; j.pages = pages; }
    else { j.status = error === 'CANCELED' ? 'canceled' : 'error'; j.error = error || '渲染失败'; }
    this.emit('render-done', { jobId });
    this._emit();
  }

  _cleanupTmp(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    this._tmpDirs.delete(dir);
  }

  cleanupAll() { for (const d of [...this._tmpDirs]) this._cleanupTmp(d); }
}

module.exports = { Queue };
