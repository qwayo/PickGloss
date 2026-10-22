'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const framework = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
const benchmark = process.argv.includes('--benchmark');
const target = path.join(root, 'build', benchmark ? 'native-benchmark' : 'native');
fs.mkdirSync(target, { recursive: true });
const references = ['UIAutomationClient.dll', 'UIAutomationTypes.dll', 'WindowsBase.dll'].map(name => '/reference:' + path.join(framework, 'WPF', name));
// 跟随实验保留在诊断目录；正式构建使用已回退的单次段落读取助手。
const source = benchmark ? path.join(root, 'prototypes', 'windows-capture', 'desktop-follow-diagnostics', 'ContextProbe-follow.cs') : path.join(root, 'src', 'windows', 'ContextProbe.cs');
const args = ['/nologo', '/target:exe', '/platform:x64', '/optimize+', '/out:' + path.join(target, 'ContextProbe.exe'), '/reference:' + path.join(framework, 'System.Web.Extensions.dll'), ...references, source];
if (benchmark) args.push('/define:TRACKING_BENCHMARK');
const result = spawnSync(path.join(framework, 'csc.exe'), args, { encoding: 'utf8', windowsHide: true });
if (result.status !== 0) { console.error(result.stdout || result.stderr || '未找到 Windows .NET Framework 编译器。'); process.exit(1); }
console.log('UIA 段落验证助手已构建。');
