'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('显式隔离启动把真实 Electron 的设置写入指定临时目录', () => {
  const isolated = path.join(os.tmpdir(), `pickgloss-verification-${process.pid}-${Date.now()}`);
  const fakeLocalAppData = path.join(isolated, '未使用的系统目录');
  const result = spawnSync(require('electron'), ['.', '--smoke-test', `--verification-data-dir=${isolated}`], {
    cwd: path.join(__dirname, '../..'), encoding: 'utf8', timeout: 30000, windowsHide: true,
    env: { ...process.env, LOCALAPPDATA: fakeLocalAppData },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(path.join(isolated, 'data', 'settings.json')), true, '隔离目录应包含真实存储文件');
  assert.equal(fs.existsSync(path.join(fakeLocalAppData, 'PickGloss')), false, '测试不得写入普通启动的数据目录');
});
