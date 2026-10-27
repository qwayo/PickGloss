'use strict';
// 隐藏界面检查独立于原生实屏入口；普通 Windows CI 可执行。
const path = require('node:path');
const { runSteps } = require('./checked-runner.cjs');
const root = path.resolve(__dirname, '..');
const outputIndex = process.argv.indexOf('--output-dir');
const output = outputIndex < 0 ? path.join(root, 'output', 'verification', `ui-${Date.now()}`) : path.resolve(process.argv[outputIndex + 1]);
const electron = require('electron');
runSteps([
  { name: '唯一点击与诊断夹具', command: electron, args: [path.join(__dirname, 'check-ui-driver.cjs')] },
  { name: '300×483 紧凑界面与服务设置', command: electron, args: [path.join(__dirname, 'check-ai-services-ui.cjs'), '--width', '300', '--height', '483', '--output-dir', path.join(output, 'services')] },
  { name: '正式桌面模块隐藏检查', command: electron, args: [path.join(__dirname, 'check-floating-ui.cjs'), '--output-dir', path.join(output, 'floating')] },
], { cwd: root, logFile: path.join(output, '受检日志.txt') }).catch(error => { console.error(error.message); process.exitCode = 1; });
