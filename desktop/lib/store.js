'use strict';
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULT_SETTINGS = {
  engine: 'auto',            // auto | office | soffice
  outDirMode: 'source',      // source | custom
  outDirCustom: '',
  preset: 'print',           // print | archive | min
  imgPageSize: 'auto',       // auto | a4
  imgMergeToOne: false,      // to-pdf 模式下多图是否合并为一个 PDF
  pdf2imgFormat: 'png',      // png | jpeg
  pdf2imgDpi: 150,
  pdf2imgZip: true,
  windowBounds: null
};

class Store {
  constructor() {
    this.dir = path.join(app.getPath('userData'));
    fs.mkdirSync(this.dir, { recursive: true });
    this.settingsPath = path.join(this.dir, 'settings.json');
    this.historyPath = path.join(this.dir, 'history.json');
    this.settings = { ...DEFAULT_SETTINGS, ...this._read(this.settingsPath) };
    this.history = this._read(this.historyPath) || [];
  }
  _read(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
  _write(p, data) { fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8'); }
  saveSettings(patch) {
    this.settings = { ...this.settings, ...patch };
    this._write(this.settingsPath, this.settings);
    return this.settings;
  }
  addHistory(entries) {
    // entries: [{src, out, mode, status, engine, pages, durationMs, error}]
    this.history = [...entries, ...this.history].slice(0, 1000);
    this._write(this.historyPath, this.history);
  }
  clearHistory() { this.history = []; this._write(this.historyPath, this.history); }
}

module.exports = { Store, DEFAULT_SETTINGS };
