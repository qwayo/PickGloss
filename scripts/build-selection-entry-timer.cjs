'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const framework = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
const target = path.join(root, 'build', 'entry-timer');
fs.mkdirSync(target, { recursive: true });
const references = ['UIAutomationClient.dll', 'UIAutomationTypes.dll', 'WindowsBase.dll']
  .map(name => '/reference:' + path.join(framework, 'WPF', name));
const args = ['/nologo', '/target:exe', '/platform:x64', '/optimize+',
  '/out:' + path.join(target, 'SelectionEntryTimer.exe'),
  '/reference:' + path.join(framework, 'System.Web.Extensions.dll'),
  ...references, path.join(__dirname, 'selection-entry-timer.cs')];
const result = spawnSync(path.join(framework, 'csc.exe'), args, { encoding: 'utf8', windowsHide: true });
if (result.status !== 0) { console.error(result.stdout || result.stderr || '未找到 Windows .NET Framework 编译器。'); process.exit(1); }
console.log('入口计时器已构建：' + path.join(target, 'SelectionEntryTimer.exe'));
