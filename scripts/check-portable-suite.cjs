'use strict';
const path = require('node:path');
const { runSteps } = require('./checked-runner.cjs');
const output = path.resolve(process.argv[2] || '');
const script = name => path.join(__dirname, name);
runSteps([
  { name: '冻结包字节清单与 ZIP 摘要', command: process.execPath, args: [script('verify-package.cjs'), output] },
  { name: '真实 EXE 保存失败阻断', command: process.execPath, args: [script('check-portable.cjs'), output, '--inject-save-failure'] },
  { name: '真实 EXE 本机模型贯通', command: process.execPath, args: [script('check-portable.cjs'), output] },
], { logFile: path.join(output, '便携验证日志.txt') }).catch(error => { console.error(error.message); process.exitCode = 1; });
