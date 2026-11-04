'use strict';
// 无前台依赖的原生范围提供方回归；使用虚构段落和确定性 UIA 范围模型。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const framework = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319');
const output = path.join(root, '.scratch/paragraph-context', new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex'));
const source = path.join(root, 'src/windows/ContextProbe.cs');
const fixture = path.join(root, 'tests/fixtures/paragraph-context-provider.cs');
const report = { description: '确定性原生范围提供方场景；不创建窗口、不依赖前台，也不接触用户文本。', sourceSha256: crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex'), results: [] };
fs.mkdirSync(output, { recursive: true });
let exitCode = 2;
try {
  if (process.platform !== 'win32') throw new Error('原生范围提供方回归需要 Windows。');
  const binary = path.join(output, 'ParagraphContextTests.exe');
  const references = ['System.Web.Extensions.dll', 'WPF/UIAutomationClient.dll', 'WPF/UIAutomationTypes.dll', 'WPF/WindowsBase.dll'];
  const args = ['/nologo', '/codepage:65001', '/target:exe', '/platform:x64', '/optimize+', '/main:ContextParagraphTests', '/out:' + binary,
    ...references.map(name => '/reference:' + path.join(framework, name)), source, fixture];
  const compile = spawnSync(path.join(framework, 'csc.exe'), args, { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  if (compile.error || compile.status !== 0) throw new Error('原生范围提供方编译失败：' + (compile.error?.message || compile.stdout || compile.stderr));
  const run = spawnSync(binary, [], { encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 65536 });
  fs.writeFileSync(path.join(output, '范围提供方输出.txt'), run.stdout || '', 'utf8');
  if (run.error || run.status !== 0) throw new Error('原生范围提供方检查失败：' + (run.stdout || run.stderr || run.status));
  report.results = (run.stdout || '').trim().split(/\r?\n/);
  if ((run.stdout.match(/^通过：/gm) || []).length !== 22 || (run.stdout.match(/^失败：/gm) || []).length !== 0) throw new Error('确定性原生范围场景未完整通过。');
  exitCode = 0;
} catch (error) { report.error = error.message; }
report.exitCode = exitCode;
fs.writeFileSync(path.join(output, 'evidence.json'), JSON.stringify(report, null, 2), 'utf8');
for (const row of report.results) console.log(row);
if (report.error) console.error(report.error);
console.log('确定性范围证据：' + path.join(output, 'evidence.json'));
process.exitCode = exitCode;
