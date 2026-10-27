'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function create(options) {
  const context = vm.createContext({ setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../src/renderer/settings-autosave.js'), 'utf8').replace(/^export /gm, '') + '\nglobalThis.create=createSettingsAutosave;', context);
  return context.create(options);
}
test('快速编辑只保存最新字段，独立字段串行写入并可立即刷新读回', async () => {
  const written = [], disk = {};
  let active = 0;
  const ui = create({ persist: async payload => { assert.equal(active++, 0); await Promise.resolve(); Object.assign(disk, payload); written.push(payload); active--; return { ok: true }; } });
  const first = ui.schedule('name', { name: '第一版' }), last = ui.schedule('name', { name: '第二版' });
  const other = ui.schedule('enabled', { enabled: true });
  assert.equal(await ui.flush(), true);
  assert.ok((await first).ok && (await last).ok && (await other).ok);
  assert.deepEqual(written, [{ name: '第二版' }, { enabled: true }]);
  assert.deepEqual(disk, { name: '第二版', enabled: true });
});
test('写入期间新输入不会被旧成功响应标为已保存，最终值仍落盘', async () => {
  let release, calls = 0;
  const ui = create({ persist: async payload => { if (++calls === 1) await new Promise(resolve => { release = resolve; }); return { ok: true, value: payload }; } });
  const first = ui.commit('name', { name: '旧值' });
  const second = ui.schedule('name', { name: '新值' });
  release(); await first;
  assert.equal(ui.status('name').status, 'pending');
  await ui.flush(); assert.ok((await second).ok); assert.equal(calls, 2); assert.equal(ui.status('name').status, 'saved');
});
test('失败不假报保存，刷新前flush返回失败，重试不需要重新输入', async () => {
  let fail = true, current;
  const ui = create({ persist: async payload => fail ? { ok: false, error: '模拟写盘失败' } : (current = payload, { ok: true }) });
  const result = await ui.commit('enabled', { enabled: true });
  assert.equal(result.ok, false); assert.equal(await ui.flush(), false); assert.equal(ui.status('enabled').status, 'error');
  fail = false; assert.ok((await ui.retry('enabled')).ok); assert.equal(await ui.flush(), true); assert.deepEqual(current, { enabled: true });
});
test('离开页面立即flush尚在防抖中的值，关闭后不会有迟到写入', async () => {
  const writes = [];
  const ui = create({ persist: async payload => (writes.push(payload), { ok: true }), delay: 60000 });
  const pending = ui.schedule('value', () => ({ value: '最终值' }));
  await ui.flush(); assert.ok((await pending).ok); assert.equal(writes.length, 1);
  const abandoned = ui.schedule('value', { value: '未提交值' }); ui.dispose();
  assert.equal((await abandoned).ok, false); assert.equal(writes.length, 1);
});

test('后台失败可定位且不会因其他成功项被清除，显式恢复后才能解除退出阻断', async () => {
  const ui = create({ persist: async payload => payload.invalid ? { ok: false, error: '地址无效' } : { ok: true } });
  await ui.commit('service:text:custom', { invalid: true });
  await ui.commit('service:text:mimo', { model: '有效模型' });
  assert.deepEqual(Array.from(ui.failedKeys()), ['service:text:custom']);
  assert.equal(ui.summary(), '部分更改未保存'); assert.equal(await ui.flush(), false);
  assert.equal(ui.discardFailure('service:text:mimo'), false, '不能清除成功配置的状态');
  assert.equal(ui.discardFailure('service:text:custom'), true);
  assert.deepEqual(Array.from(ui.failedKeys()), []); assert.equal(await ui.flush(), true);
});

test('输入失焦仅加速待保存快照，不重试失败或清除错误恢复入口', async () => {
  let writes = 0;
  const ui = create({ persist: async () => (++writes, { ok: false, error: '模拟地址无效' }), delay: 60000 });
  const submitted = ui.schedule('service:text:custom', { value: '无效地址' });
  ui.expedite('service:text:custom'); await submitted;
  ui.expedite('service:text:custom');
  assert.equal(writes, 1); assert.equal(ui.status('service:text:custom').status, 'error');
  assert.equal(ui.failedKeys().length, 1);
});
