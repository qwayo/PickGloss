'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { nativeBuildOptions } = require('../../scripts/build-native.cjs');

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
