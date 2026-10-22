'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('真实 Electron 宿主用虚构密钥和本机服务验证加密及重定向边界', () => {
  const root = path.join(__dirname, '../..');
  const result = spawnSync(require('electron'), ['scripts/check-ai-host.cjs'], {
    cwd: root, encoding: 'utf8', timeout: 30000, windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    windowsEncryption: true, plaintextHidden: true, electronLocalRequest: true, redirectBlocked: true,
  });
});
