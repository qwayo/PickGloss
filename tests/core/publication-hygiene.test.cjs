'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const script = path.join(__dirname, '../../scripts/check-publication-hygiene.cjs');

async function initFixture(files) {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'pickgloss-publication-'));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(fixture, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, 'utf8');
  }
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: fixture, windowsHide: true });
  spawnSync('git', ['add', '-A'], { cwd: fixture, windowsHide: true });
  spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'fixture'], { cwd: fixture, windowsHide: true });
  return fixture;
}

async function addScanner(fixture) {
  const scripts = path.join(fixture, 'scripts');
  await fs.mkdir(scripts, { recursive: true });
  await fs.copyFile(script, path.join(scripts, 'check-publication-hygiene.cjs'));
}

function runScanner(fixture) {
  return spawnSync(process.execPath, [path.join(fixture, 'scripts', 'check-publication-hygiene.cjs')], {
    cwd: fixture, encoding: 'utf8', windowsHide: true,
  });
}

test('公开前扫描脚本可以执行且许可证缺失时明确失败', async () => {
  const fixture = await initFixture({ 'README.md': '没有许可证' });
  await addScanner(fixture);
  const result = runScanner(fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /缺少根目录 LICENSE/);
  await fs.rm(fixture, { recursive: true, force: true });
});

test('公开前扫描脚本不把示例邮箱或常见说明文本当成凭据', async () => {
  const fixture = await initFixture({ 'README.md': 'API Key 请勿提交。', 'LICENSE': 'MIT' });
  await addScanner(fixture);
  const result = runScanner(fixture);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /公开前工作树检查通过/);
  await fs.rm(fixture, { recursive: true, force: true });
});

test('公开前扫描脚本也会检查尚未提交但未被忽略的文件', async () => {
  const fixture = await initFixture({ 'README.md': '公开说明', 'LICENSE': 'MIT' });
  await addScanner(fixture);
  await fs.writeFile(path.join(fixture, 'scratch.txt'), 'C:\\Users\\someone\\private.txt', 'utf8');
  const result = runScanner(fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /scratch\.txt/);
  await fs.rm(fixture, { recursive: true, force: true });
});
