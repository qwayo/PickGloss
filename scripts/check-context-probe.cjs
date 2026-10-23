'use strict';
// 独立原生回归：只打开自有虚构文本窗口，不进入默认单元测试。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const sourceIndex = process.argv.indexOf('--source');
const sourceOption = process.argv.find(value => value.startsWith('--source='));
if (sourceIndex >= 0 && (!process.argv[sourceIndex + 1] || process.argv[sourceIndex + 1].startsWith('--'))) {
  throw new Error('--source 后需要指定 C# 源码路径。');
}
const source = path.resolve(sourceOption ? sourceOption.slice(9) : sourceIndex >= 0 ? process.argv[sourceIndex + 1] : path.join(root, 'src/windows/ContextProbe.cs'));
const framework = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319');
const output = path.join(root, '.scratch/context-probe-regression', new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex'));
const fixture = path.join(root, 'tests/fixtures/context-probe-fixture.cs');
const chromium = process.argv.includes('--chromium');
const report = { description: `通过真实 Windows UIA 和自有 ${chromium ? 'Chromium' : 'WPF'} 虚构材料验证上下文助手；不代表记事本、QQ 或便携包人工验收。`, source, sourceSha256: crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex'), results: [] };
fs.mkdirSync(output, { recursive: true });
function compile(name, file, references) {
  const target = path.join(output, name + '.exe');
  const args = ['/nologo', '/codepage:65001', '/target:exe', '/platform:x64', '/optimize+', '/out:' + target,
    '/reference:' + path.join(framework, 'System.Web.Extensions.dll'),
    ...references.map(value => '/reference:' + path.join(framework, value)), file];
  const run = spawnSync(path.join(framework, 'csc.exe'), args, { encoding: 'utf8', windowsHide: true });
  if (run.error || run.status !== 0) throw new Error(name + ' 编译失败：' + (run.error?.message || run.stdout || run.stderr));
  return target;
}
function verify(row) {
  if (row.error || row.foreground !== true || row.response?.valid !== true) return { verdict: '前置条件不足', failure: row.error || '未取得前台窗口的预期选区。' };
  if (row.helperExitCode !== 0 || row.response.text !== row.expectedSelection) return { verdict: '失败', failure: '真实助手返回的选区或退出状态不符。' };
  const context = String(row.response.context || ''), reason = String(row.response.reason || '');
  if (row.rule === '取得上下文') {
    if (context !== row.expectedContext || reason) return { verdict: '失败', failure: '有效单段选区未返回完整且准确的上下文。' };
  } else if (row.rule === '不得混入邻段') {
    if (context !== row.expectedContext && !(context === '' && reason)) return { verdict: '失败', failure: '上下文混入邻段或无原因地丢弃。' };
  } else {
    if (context || !reason || (row.rule === '超限' && !reason.includes('6000')) || (row.rule === '跨段' && !reason.includes('段落'))) return { verdict: '失败', failure: '跨段或超限材料未被明确拒绝。' };
  }
  return { verdict: '通过' };
}
let exitCode = 2;
try {
  if (process.platform !== 'win32') throw new Error('原生回归需要 Windows。');
  const probe = compile('ContextProbe', source, ['WPF/UIAutomationClient.dll', 'WPF/UIAutomationTypes.dll', 'WPF/WindowsBase.dll']);
  const window = chromium ? require('electron') : compile('ContextProbeFixture', fixture, ['WPF/PresentationFramework.dll', 'WPF/PresentationCore.dll', 'WPF/WindowsBase.dll', 'System.Xaml.dll']);
  const args = chromium ? [path.join(root, 'tests/fixtures/context-probe-chromium.cjs'), probe, ...(process.argv.includes('--auto-start') ? ['--auto-start'] : [])] : [probe];
  const run = spawnSync(window, args, { encoding: 'utf8', windowsHide: !chromium, timeout: 60000, maxBuffer: 1024 * 1024 });
  fs.writeFileSync(path.join(output, '原生夹具输出.json'), run.stdout || '', 'utf8');
  if (run.error || run.status !== 0) throw new Error('原生夹具未完成：' + (run.error?.message || run.stderr || run.status));
  const data = JSON.parse(run.stdout.trim());
  const expectedCount = chromium ? 13 : 12;
  if (!Array.isArray(data.results) || data.results.length !== expectedCount) throw new Error(`原生夹具未完成全部 ${expectedCount} 个场景。`);
  report.results = data.results.map(row => ({ ...row, ...verify(row) }));
  exitCode = report.results.some(row => row.verdict === '前置条件不足') ? 2 : report.results.some(row => row.verdict === '失败') ? 1 : 0;
} catch (error) { report.error = error.message; }
report.exitCode = exitCode;
fs.writeFileSync(path.join(output, 'evidence.json'), JSON.stringify(report, null, 2), 'utf8');
for (const row of report.results) console.log(`${row.verdict}：${row.name}${row.failure ? '；' + row.failure : ''}`);
if (report.error) console.error(report.error);
console.log('原生证据：' + path.join(output, 'evidence.json'));
process.exitCode = exitCode;
