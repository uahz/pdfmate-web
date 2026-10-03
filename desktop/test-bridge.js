'use strict';
// 引擎桥直连诊断：node test-bridge.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const engines = require('./lib/engines');

(async () => {
  const dir = path.join(os.tmpdir(), 'pm-bridge-test');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'hello.txt'), 'hello pdfmate');
  const outDir = path.join(dir, 'out');
  fs.mkdirSync(outDir, { recursive: true });

  console.log('--- probe ---');
  console.log(JSON.stringify(await engines.probeOffice()));

  console.log('--- convert txt via bridge ---');
  const r = await engines.officeConvert([path.join(dir, 'hello.txt')], outDir, {});
  console.log(JSON.stringify(r, null, 2));

  console.log('--- make samples via spawnSync ---');
  const m = spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    engines.MAKE_SAMPLES_PS1, '-OutDir', dir
  ], { windowsHide: true, timeout: 90000 });
  console.log('status=', m.status);
  console.log('stdout=', JSON.stringify(m.stdout));
  console.log('stderr=', JSON.stringify(m.stderr));
  console.log('docx exists=', fs.existsSync(path.join(dir, 'sample.docx')));
})();
