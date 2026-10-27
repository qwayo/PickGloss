'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { selectChecks } = require('../../scripts/change-check-plan.cjs');
const { changedFiles, buildSteps } = require('../../scripts/check-changes.cjs');
const ids = (files, options) => selectChecks(files, options).map(check => check.id);

test('改动选择：专项、共享依赖与版本打包边界', () => {
  assert.deepEqual(ids(['docs/engineering-verification.md']), []);
  assert.deepEqual(ids(['src/core/history.cjs']), ['ui', 'history']);
  assert.deepEqual(ids(['src/renderer/settings-autosave.js']), ['ui', 'settings']);
  assert.deepEqual(ids(['src/renderer/translation.js']), ['ui', 'translation']);
  for (const file of ['src/renderer/app.js', 'src/renderer/styles.css', 'src/preload.cjs', 'src/core/store.cjs', 'scripts/check-changes.cjs']) {
    assert.deepEqual(ids([file]), ['ui', 'settings', 'history', 'translation'], file);
  }
  for (const file of ['package.json', 'package-lock.json', 'scripts/verify-package.cjs', 'scripts/build-native.cjs', 'src/windows/ScreenCapture.cs']) {
    assert.ok(ids([file]).includes('package'), file);
  }
  assert.deepEqual(ids(['src\\windows\\ocr.ps1']), ['ui', 'translation']);
  assert.ok(ids(['src/windows/startup.cjs']).includes('settings'));
  assert.deepEqual(ids([], { forcePackage: true }), ['package']);
  assert.deepEqual(ids([], { uiAll: true }), ['ui', 'settings', 'history', 'translation']);
  assert.deepEqual(ids([], { all: true }), ['ui', 'settings', 'history', 'translation', 'package']);
});

test('改动发现：已提交、暂存删除和重命名、未暂存及未跟踪文件都进入选择', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pickgloss-change-plan-'));
  const git = args => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git(['init', '-q']);
  git(['config', 'user.name', '隔离验证']); git(['config', 'user.email', 'fixture@example.invalid']);
  fs.writeFileSync(path.join(cwd, '原文件'), '原内容'); fs.writeFileSync(path.join(cwd, '已删除'), '删除前');
  fs.writeFileSync(path.join(cwd, '暂存后还原工作文件'), '基线内容');
  git(['add', '.']); git(['commit', '-qm', '隔离基线']);
  const base = git(['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(cwd, '已提交'), '提交内容'); git(['add', '.']); git(['commit', '-qm', '隔离改动']);
  git(['mv', '原文件', '新文件']);
  fs.renameSync(path.join(cwd, '已删除'), path.join(cwd, '.git', '恢复备份'));
  git(['add', '-u']);
  fs.appendFileSync(path.join(cwd, '已提交'), '未暂存内容');
  fs.writeFileSync(path.join(cwd, '暂存后还原工作文件'), '暂存内容'); git(['add', '暂存后还原工作文件']);
  fs.writeFileSync(path.join(cwd, '暂存后还原工作文件'), '基线内容');
  fs.writeFileSync(path.join(cwd, '未跟踪'), '新增内容');
  assert.deepEqual(changedFiles(base, cwd).sort(), ['原文件', '已删除', '已提交', '新文件', '未跟踪', '暂存后还原工作文件'].sort());
  assert.throws(() => changedFiles('不存在的基线', cwd));
});

test('能力边界：隐藏检查不会声称获焦或 OCR 已通过，交互入口选择独立专项', () => {
  const selected = selectChecks(['src/renderer/app.js']);
  const hidden = buildSteps(selected, { output: '隔离报告', interactive: false, ocr: false });
  assert.equal(hidden.steps[0].id, 'native-build', '正式桌面专项前必须先准备相同目录的原生助手');
  assert.equal(hidden.uncovered.length, 2);
  assert.ok(hidden.steps.some(step => step.args.includes('--ui-only')));
  assert.ok(hidden.steps.some(step => step.args.includes('--normal-motion')));
  assert.ok(hidden.steps.some(step => step.args.includes('--reduced-motion') && step.args.includes('--anchor-only')));
  assert.ok(hidden.steps.every(step => !step.args.includes('--visible') && !step.args.includes('--native-ocr')));
  const local = buildSteps(selected, { output: '隔离报告', interactive: true, ocr: true });
  assert.equal(local.uncovered.length, 0);
  assert.ok(local.steps.some(step => step.args.includes('--visible')));
  assert.equal(local.steps.find(step => step.args.includes('--visible')).windowsHide, false, '获焦专项不能继承隐藏进程窗口选项');
  assert.ok(local.steps.filter(step => !step.args.includes('--visible')).every(step => step.windowsHide !== false));
  assert.ok(local.steps.some(step => step.args.includes('--native-ocr')));
  const release = buildSteps(selectChecks(['package.json']), { output: '隔离报告' });
  assert.ok(release.steps.some(step => step.args[0].endsWith('package.cjs')));
});
