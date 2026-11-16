'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { distributionFileName } = require('../src/core/distribution.cjs');

(async () => {
  const output = path.resolve(process.argv[2] || '');
  const manifest = JSON.parse(await fs.readFile(path.join(output, 'candidate-manifest.json'), 'utf8'));
  const portable = process.argv[3] === '--portable';
  const smokeRoot = portable ? await fs.mkdtemp(path.join(os.tmpdir(), 'pickgloss-exe-smoke-')) : os.tmpdir();
  const executable = portable ? path.join(smokeRoot, '拾译 PickGloss.exe') : path.join(output, manifest.packageDirectory, 'PickGloss.exe');
  if (portable) await fs.copyFile(path.join(output, distributionFileName('portable', manifest.version)), executable);
  const child = spawn(executable, ['--smoke-test'], { cwd: path.dirname(executable), windowsHide: true, stdio: 'ignore',
    env: { ...process.env, TEMP: smokeRoot, TMP: smokeRoot } });
  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('包内宿主检查超时。')); }, portable ? 90_000 : 20_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
  assert.equal(exitCode, 0, '包内宿主检查必须正常退出');
  const smokeDirectories = portable ? (await fs.readdir(smokeRoot)).filter(entry => /^pickgloss-smoke-\d+$/.test(entry)) : [`pickgloss-smoke-${child.pid}`];
  assert.equal(smokeDirectories.length, 1, '应启动一个 Electron 主进程');
  const smokePath = path.join(smokeRoot, smokeDirectories[0], 'smoke.json');
  const result = JSON.parse(await fs.readFile(smokePath, 'utf8'));
  if (portable) {
    assert.equal(result.distribution, 'portable');
    assert.equal(result.startupExecutable, executable, '开机启动候选路径应为用户打开的外层 EXE');
  }
  assert.equal(result.rendererLoaded, true);
  assert.equal(result.rendererBridge, true);
  assert.equal(result.selectionWorker, true);
  assert.equal(result.encryptionAvailable, true);
  assert.deepEqual(result.shortcutErrors, []);
  const report = { candidateId: manifest.candidateId, sourceFingerprint: manifest.sourceFingerprint,
    packageFingerprint: manifest.packageFingerprint, runAt: new Date().toISOString(), executable, smokePath,
    exitCode, windows: result.windows, displayCount: result.displayCount,
    rendererLoaded: result.rendererLoaded, rendererBridge: result.rendererBridge,
    selectionWorker: result.selectionWorker, encryptionAvailable: result.encryptionAvailable,
    shortcutErrors: result.shortcutErrors, selection: result.selection, distribution: result.distribution ?? null,
    scope: '包内 Windows 宿主与正常退出检查；未在真实应用内采集材料或调用模型' };
  const reportPath = path.join(output, portable ? '单 EXE 宿主启动退出结果.json' : '宿主启动退出结果.json');
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(`包内宿主检查通过：${manifest.candidateId}；窗口 ${result.windows}；显示器 ${result.displayCount}；报告 ${reportPath}`);
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
