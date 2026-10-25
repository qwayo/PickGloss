'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runSteps, compareText } = require('../../scripts/checked-runner.cjs');
const runner = path.resolve(__dirname, '../../scripts/checked-runner.cjs');
const command = (name, code) => ({ name, command: process.execPath, args: ['-e', code] });
function scenario(failed, shell) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickgloss-checked-'));
  const markers = ['提交', '合并', '发布'];
  const plan = { logFile: '日志.txt', steps: [failed, ...markers.map(name => command(`${name}替身`, `require("fs").writeFileSync("${name}标记", "禁止越过失败")`))] };
  fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(plan), 'utf8');
  const args = shell ? ['-NoProfile', '-NonInteractive', '-Command', '& $env:PG_TEST_NODE $env:PG_TEST_RUNNER $env:PG_TEST_PLAN; exit $LASTEXITCODE'] : [runner, path.join(dir, 'plan.json')];
  const result = spawnSync(shell || process.execPath, args, { cwd: dir, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, PG_TEST_NODE: process.execPath, PG_TEST_RUNNER: runner, PG_TEST_PLAN: path.join(dir, 'plan.json') } });
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  for (const name of markers) assert.equal(fs.existsSync(path.join(dir, `${name}标记`)), false);
  assert.match(fs.readFileSync(path.join(dir, '日志.txt'), 'utf8'), /失败：前置/);
}
for (const [name, failed] of [
  ['非零退出', command('前置', 'process.exit(7)')],
  ['程序不存在', { name: '前置', command: 'pickgloss-no-such-command', args: [] }],
  ['断言失败', { name: '前置', assertText: { actual: '真实差异', expected: '期望内容', normalizeEol: true } }],
]) test(`受检运行器：${name} 阻断后续提交替身`, () => {
  scenario(failed);
  if (process.platform === 'win32') scenario(failed, 'powershell.exe');
});
test('受检运行器：成功顺序、中文及特殊字符、UTF-8 日志和脱敏', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickgloss-checked-success-'));
  let output = '';
  await runSteps([
    command('第一步', 'console.log("中文 ℹ 第一项"); console.log("apiKey=夹具秘密")'),
    command('第二步', 'console.log(process.env.PYTHONUTF8+":"+process.env.PYTHONIOENCODING)'),
  ], { logFile: path.join(dir, '日志.txt'), write: value => { output += value; } });
  assert.match(output, /中文 ℹ 第一项/);
  assert.match(output, /1:utf-8/);
  assert.ok(output.indexOf('通过：第一步') < output.indexOf('开始：第二步'));
  assert.doesNotMatch(output, /夹具秘密/);
  assert.equal(fs.readFileSync(path.join(dir, '日志.txt'), 'utf8'), output);
});
test('受检运行器：函数断言异常立即停止', async () => {
  let sideEffect = false;
  await assert.rejects(runSteps([{ name: '断言', run() { assert.fail('不能泄露的正文'); } }, { run() { sideEffect = true; } }], { write() {} }), /断言失败/);
  assert.equal(sideEffect, false);
});
test('文本比较只按明确选项转换 CRLF，保留其他真实差异', () => {
  compareText('中文\r\nℹ', '中文\nℹ', true);
  assert.throws(() => compareText('a\r\n', 'a\n'));
  assert.throws(() => compareText('a \r\n', 'a\n', true));
});
test('Windows shell 启动受检入口仍按 UTF-8 输出中文、特殊字符及 Python 摘要', { skip: process.platform !== 'win32' }, () => {
  for (const shell of ['powershell.exe', 'pwsh.exe']) {
    const available = spawnSync(shell, ['-NoProfile', '-Command', 'exit 0'], { windowsHide: true });
    if (available.error?.code === 'ENOENT') continue;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickgloss-checked-shell-'));
    fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify({ logFile: '日志.txt', steps: [
      command('中文输出', 'console.log("中文 ℹ");'),
      { name: 'Python 摘要', command: 'python', args: ['-c', 'print("中文 Python ℹ")'], env: { PYTHONIOENCODING: 'gbk' } },
    ] }), 'utf8');
    const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); & $env:PG_TEST_NODE $env:PG_TEST_RUNNER $env:PG_TEST_PLAN; exit $LASTEXITCODE'], {
      encoding: 'utf8', windowsHide: true, env: { ...process.env, PG_TEST_NODE: process.execPath, PG_TEST_RUNNER: runner, PG_TEST_PLAN: path.join(dir, 'plan.json') },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /中文 ℹ/);
    assert.match(result.stdout, /中文 Python ℹ/);
    compareText(fs.readFileSync(path.join(dir, '日志.txt'), 'utf8'), result.stdout, true);
  }
});
