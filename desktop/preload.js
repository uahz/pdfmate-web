'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const SEND_OK = new Set([
  'win:minimize', 'win:maximize', 'win:close',
  'queue:pause', 'queue:resume', 'queue:cancelAll', 'open:path',
  'pdf2img:progress', 'smoke:rendererResult'
]);
const INVOKE_OK = new Set([
  'dialog:openFiles', 'dialog:openFolder', 'engine:status',
  'settings:get', 'settings:set', 'history:list', 'history:clear',
  'queue:getState', 'queue:add', 'queue:retryFailed', 'queue:clearFinished',
  'fs:readBytes', 'fs:writeBytes', 'fs:probeDir', 'open:dir',
  'pdf2img:prepare', 'pdf2img:zip', 'pdf2img:done', 'smoke:getContext', 'smoke:saveSample'
]);
const ON_OK = new Set(['queue:update', 'render:request', 'notify', 'files:add']);

contextBridge.exposeInMainWorld('pdfmate', {
  send: (ch, ...args) => { if (SEND_OK.has(ch)) ipcRenderer.send(ch, ...args); },
  invoke: (ch, ...args) => {
    if (!INVOKE_OK.has(ch)) return Promise.reject(new Error('BAD_CHANNEL'));
    return ipcRenderer.invoke(ch, ...args);
  },
  on: (ch, cb) => {
    if (!ON_OK.has(ch)) return;
    ipcRenderer.on(ch, (_e, payload) => cb(payload));
  }
});
