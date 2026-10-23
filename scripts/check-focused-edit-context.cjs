'use strict';
// 先在目标单段编辑控件中选词，再运行此只读命令；不点击界面、不复制、不输出用户正文。
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const helper = path.resolve(process.argv[2] || path.join(root, 'build/native/ContextProbe.exe'));
const source = path.join(root, 'tests/fixtures/focused-edit-context.cs');
const output = path.join(root, '.scratch/focused-edit-context', new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex'));
const framework = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
let exitCode = 2;
const report = { description: '只读真实前台编辑控件与原生助手；证据仅包含状态、长度和哈希，不包含正文。', results: [] };
fs.mkdirSync(output, { recursive: true });
try {
  if (process.platform !== 'win32') throw new Error('该检查需要 Windows。');
  report.helper = helper; report.helperSha256 = hash(helper); report.checkerSha256 = hash(source);
  const binary = path.join(output, 'FocusedEditContext.exe');
  const compile = spawnSync(path.join(framework, 'csc.exe'), ['/nologo', '/codepage:65001', '/target:exe', '/platform:x64', '/out:' + binary, '/reference:' + path.join(framework, 'System.Web.Extensions.dll'), ...['UIAutomationClient.dll', 'UIAutomationTypes.dll', 'WindowsBase.dll'].map(name => '/reference:' + path.join(framework, 'WPF', name)), source], { encoding: 'utf8', windowsHide: true });
  if (compile.error || compile.status !== 0) throw new Error('只读原生检查器编译失败。');
  const run = spawnSync(binary, [helper], { encoding: 'utf8', windowsHide: true, timeout: 8000, maxBuffer: 65536 });
  if (run.error || ![0, 1, 2].includes(run.status)) throw new Error('只读原生检查器未完成。');
  report.results.push(JSON.parse(run.stdout.trim())); exitCode = run.status;
} catch (error) { report.error = error.message; }
report.exitCode = exitCode;
fs.writeFileSync(path.join(output, 'evidence.json'), JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify(report.results[0] || { verdict: '前置条件不足', error: report.error }));
console.log('只读证据：' + path.join(output, 'evidence.json'));
process.exitCode = exitCode;
