'use strict';
// 构建并运行固定虚构材料的真实 Windows 混合选区复现；不会触碰其他窗口或剪贴板。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const framework = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319');
const output = path.join(root, '.scratch/mixed-selection-20261024');
const electron = require('electron');
const onlyOption = process.argv.find(value => value.startsWith('--only='));
const holdOption = process.argv.find(value => value.startsWith('--hold='));
const repeatOption = process.argv.find(value => value.startsWith('--repeat='));
const dragOption = process.argv.find(value => value.startsWith('--drag-ms='));
fs.mkdirSync(output, { recursive: true });

function compile(name, source, references = []) {
  const target = path.join(output, name + '.exe');
  const args = ['/nologo', '/codepage:65001', '/target:exe', '/platform:x64', '/optimize+', '/out:' + target,
    ...references.map(value => '/reference:' + path.join(framework, value)), source];
  const result = spawnSync(path.join(framework, 'csc.exe'), args, { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(name + ' 编译失败：' + (result.error?.message || result.stdout || result.stderr));
  return target;
}

let report = {
  description: '真实 selection-hook、真实 Chromium 普通 DOM 鼠标拖选与原生 UIA 复核；页面只含固定虚构材料。',
  sourceSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'src/windows/ContextProbe.cs'))).digest('hex'),
  results: [],
};
let exitCode = 2;
try {
  if (process.platform !== 'win32') throw new Error('真实混合选区复现需要 Windows。');
  const helper = compile('ContextProbe', path.join(root, 'src/windows/ContextProbe.cs'), [
    'System.Web.Extensions.dll', 'WPF/UIAutomationClient.dll', 'WPF/UIAutomationTypes.dll', 'WPF/WindowsBase.dll',
  ]);
  const input = compile('MixedSelectionInput', path.join(root, 'tests/fixtures/mixed-selection-input.cs'));
  const fixture = path.join(root, 'tests/fixtures/mixed-selection-chromium.cjs');
  const repetitions = repeatOption ? Number(repeatOption.slice(9)) : 1;
  const fixtureArgs = [fixture, helper, input, onlyOption ? onlyOption.slice(7) : '', holdOption ? holdOption.slice(7) : '', String(repetitions), dragOption ? dragOption.slice(10) : '18'];
  const run = spawnSync(electron, fixtureArgs, { cwd: root, encoding: 'utf8', windowsHide: false, timeout: 150000, maxBuffer: 2 * 1024 * 1024 });
  fs.writeFileSync(path.join(output, '原生拖选输出.json'), run.stdout || '', 'utf8');
  if (run.error || run.status !== 0) throw new Error('混选夹具未完成：' + (run.error?.message || run.stderr || run.status));
  const data = JSON.parse(run.stdout.trim().split(/\r?\n/).at(-1));
  report = { ...report, ...data, sourceSha256: report.sourceSha256 };
  const expectedNames = onlyOption ? [onlyOption.slice(7)] : ['单块纯文字对照', '正文与命令块混选', '标题与封面混选', '正文加内联图片保留两侧换行', '纯图片不得产生文字选区', '正文与 Unicode 表情混选'];
  const expected = Array.from({ length: repetitions }, (_, pass) => expectedNames.map(name => repetitions > 1 ? `${name}（第${pass + 1}次）` : name)).flat();
  if (!Array.isArray(report.results) || report.results.length !== expected.length || report.results.some((row, index) => row.name !== expected[index])) {
    throw new Error('夹具没有完成全部固定材料对照。');
  }
  const preconditionFailure = report.results.some(row => row.inputExitCode !== 0 || !row.domMatchesExpectedText);
  exitCode = preconditionFailure ? 2 : report.results.some(row => row.verdict !== '通过') ? 1 : 0;
} catch (error) { report.error = error.message; }
report.exitCode = exitCode;
fs.writeFileSync(path.join(output, 'evidence.json'), JSON.stringify(report, null, 2), 'utf8');
for (const row of report.results || []) {
  const hookText = row.hookEvent?.text ? `；Hook=${JSON.stringify(row.hookEvent.text)}` : '；Hook 无文字事件';
  const captured = row.workerSelection ? `；worker文字=${JSON.stringify(row.workerSelection.text)}` : '；worker未发布选区';
  console.log(`${row.verdict}：${row.name}${hookText}${captured}`);
}
if (report.error) console.error(report.error);
console.log('原生证据：' + path.join(output, 'evidence.json'));
process.exitCode = exitCode;
