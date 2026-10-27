'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loginOptions, applyLoginSetting } = require('../../src/windows/startup.cjs');

test('便携包自启动使用自身路径及后台参数，开发路径保留引号', () => {
  const packaged = loginOptions({ app: { isPackaged: true }, execPath: 'E:\\测试 路径\\PickGloss.exe' }, true);
  assert.deepEqual(packaged, { path: 'E:\\测试 路径\\PickGloss.exe', args: ['--autostart'], openAtLogin: true, enabled: true });
  assert.equal(Object.hasOwn(packaged, 'name'), false, '登录项使用主进程 AppUserModelId 作为默认名称，保证写入与读回匹配');
  const development = loginOptions({ app: { isPackaged: false, getAppPath: () => 'E:\\开发 路径\\PickGloss' }, execPath: 'electron.exe' }, false);
  assert.deepEqual(development.args, ['"E:\\开发 路径\\PickGloss"', '--autostart']);
  assert.equal(development.openAtLogin, false);
});

test('隔离验证不调用登录项接口，原生失败保留系统原因', () => {
  let calls = 0;
  const app = { isPackaged: true, getLoginItemSettings: () => ({ openAtLogin: false, executableWillLaunchAtLogin: false }), setLoginItemSettings() { calls++; throw Error('ERROR_ACCESS_DENIED'); } };
  applyLoginSetting({ app, isolated: true }, true);
  assert.equal(calls, 0);
  assert.throws(() => applyLoginSetting({ app }, true), error => /无法更新 Windows/.test(error.message) && /ERROR_ACCESS_DENIED/.test(error.message) && /无法确认已恢复/.test(error.message));
  assert.equal(calls, 2, '更新失败后尝试回滚；回滚也失败时必须如实提示');
});

test('登录项接口静默失败时检查实际状态并恢复先前设置', () => {
  const writes = [];
  const app = { isPackaged: true, getLoginItemSettings: () => ({ openAtLogin: false, executableWillLaunchAtLogin: false }), setLoginItemSettings: value => writes.push(value) };
  assert.throws(() => applyLoginSetting({ app }, true), /无法更新 Windows/);
  assert.equal(writes.length, 2); assert.equal(writes[0].openAtLogin, true); assert.equal(writes[1].openAtLogin, false);
});

test('原生登录项异常保留真实原因，并恢复之前的登录状态', () => {
  let enabled = false;
  const writes = [];
  const app = { isPackaged: true,
    getLoginItemSettings: () => ({ openAtLogin: enabled, executableWillLaunchAtLogin: enabled }),
    setLoginItemSettings(value) {
      writes.push(value.openAtLogin);
      enabled = value.openAtLogin;
      if (value.openAtLogin) throw new Error('ERROR_ACCESS_DENIED');
    },
  };
  assert.throws(() => applyLoginSetting({ app }, true), error => /ERROR_ACCESS_DENIED/.test(error.message));
  assert.deepEqual(writes, [true, false]);
  assert.equal(enabled, false);
});
