'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { nativeBuildOptions, translationSourceBuildArgs, browserContextBuildArgs } = require('../../scripts/build-native.cjs');

test('原生构建保持正式与基准默认目录，自定义目录支持空格和两种参数形式', () => {
  const root = path.resolve('固定项目');
  assert.equal(nativeBuildOptions([], root).target, path.join(root, 'build/native'));
  assert.equal(nativeBuildOptions(['--benchmark'], root).target, path.join(root, 'build/native-benchmark'));
  const output = path.resolve('独立输出 目录');
  assert.deepEqual(nativeBuildOptions(['--output-dir', output]), { benchmark: false, target: output });
  assert.deepEqual(nativeBuildOptions(['--output-dir=' + output, '--benchmark']), { benchmark: true, target: output });
});

test('原生构建拒绝缺失、重复与拼写错误的目录参数，避免落到默认输出', () => {
  for (const args of [['--output-dir'], ['--output-dir='], ['--output-dir', '--benchmark'],
    ['--output-dir', '一个目录', '--output-dir=另一个目录'], ['--out-dir', '错误参数']]) {
    assert.throws(() => nativeBuildOptions(args), Error);
  }
});

test('截图来源窗口助手使用 x64 WinForms 编译器目标及 JSON 序列化引用', () => {
  const framework = path.resolve('固定 Framework64');
  const target = path.resolve('原生输出目录');
  const root = path.resolve('固定项目');
  assert.deepEqual(translationSourceBuildArgs(framework, target, root), [
    '/nologo', '/target:winexe', '/platform:x64', '/optimize+',
    '/out:' + path.join(target, 'TranslationSource.exe'),
    '/reference:' + path.join(framework, 'System.Windows.Forms.dll'),
    '/reference:' + path.join(framework, 'System.Web.Extensions.dll'),
    path.join(root, 'src/windows/TranslationSource.cs'),
  ]);
});

test('页面归属助手独立构建，仅引用UIA程序集并保持隐藏窗口目标', () => {
  const framework = path.resolve('固定 Framework64'), target = path.resolve('独立原生目录'), root = path.resolve('固定项目');
  assert.deepEqual(browserContextBuildArgs(framework, target, root), [
    '/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/out:' + path.join(target, 'BrowserContext.exe'),
    ...['UIAutomationClient.dll', 'UIAutomationTypes.dll', 'WindowsBase.dll'].map(name => '/reference:' + path.join(framework, 'WPF', name)),
    path.join(root, 'src/windows/BrowserContext.cs'),
  ]);
});
