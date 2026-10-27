'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createStore } = require('../../src/core/store.cjs');
const { DEFAULT_SHORTCUTS } = require('../../src/core/shortcuts.cjs');

async function harness(t, { isolated = false, blocked = [], initial = {} } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), isolated ? 'pickgloss-verification-' : 'pickgloss-shortcut-actions-'));
  if (isolated) await fs.writeFile(path.join(directory, 'verification.marker'), 'PickGloss 隔离验证目录\n', { flag: 'wx' });
  const store = createStore({ directory: path.join(directory, 'data') }); await store.init(); await store.saveSettings(initial);
  const calls = { registers: [], unregisters: [], pin: [], wide: [], captures: 0, hidden: 0, menu: [], menuClosed: [], quit: 0, aborted: 0, projected: 0 };
  const registered = new Map([['Ctrl+F1', () => {}]]), unavailable = new Set(blocked);
  let options, handler;
  const globalShortcut = {
    register(accelerator, callback) { calls.registers.push(accelerator); if (registered.has(accelerator) || unavailable.has(accelerator)) return false; registered.set(accelerator, callback); return true; },
    unregister(accelerator) { calls.unregisters.push(accelerator); registered.delete(accelerator); },
    registerAll() { assert.fail('不能批量修改其它模块快捷键'); }, unregisterAll() { assert.fail('不能注销其它模块快捷键'); },
  };
  const desktop = { openPanel() {}, captureState: () => null, broadcast() {}, initTray() {}, prepareCapture() {}, setOrb() {}, startSelection() {}, setAppearance() {},
    restoreWindowState: () => false, setPinned: value => calls.pin.push(value), setWide: value => calls.wide.push(value), hidePanel: () => calls.hidden++,
    beginCapture: async () => calls.captures++, menu: payload => calls.menu.push(payload), menuReady: payload => payload,
    closeMenu: payload => { calls.menuClosed.push(payload); return true; }, flushDrafts: async () => true, flushWindowState: async () => true, dispose() {},
    authorize: (event, action) => action !== 'shortcut-recording' || event.panel === true,
    stateFor: (_event, value) => { calls.projected++; return { ...value, projected: true }; },
  };
  const app = { setPath() {}, getPath: () => directory, setName() {}, setAppUserModelId() {}, on() {}, requestSingleInstanceLock: () => true,
    whenReady: () => new Promise(() => {}), quit: () => calls.quit++ };
  const electron = { app, globalShortcut, ipcMain: { handle: (_channel, callback) => { handler = callback; } },
    session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } } };
  const source = path.join(__dirname, '../../src/main.cjs');
  const context = { require: name => name === 'electron' ? electron : name === './core/store.cjs' ? { createStore: () => store } :
    name === './windows/desktop.cjs' ? { createDesktop: value => { options = value; return desktop; } } : name.startsWith('./') ? require(path.join(path.dirname(source), name)) : require(name),
    process: { argv: isolated ? [`--verification-data-dir=${directory}`] : [], env: {}, pid: 1, platform: 'win32' }, URL, structuredClone, AbortController, setTimeout, clearTimeout,
    abortTest: () => calls.aborted++ };
  vm.createContext(context);
  vm.runInContext(await fs.readFile(source, 'utf8') + '\nglobalThis.audit={start,handle,state,quit,seedJob:(id,mode)=>jobs.set(id+":"+mode,{abort:{abort:abortTest},promise:Promise.resolve()}),cleanup:async()=>{clearTimeout(emitTimer);await shortcuts?.dispose();}};', context);
  t.after(() => context.audit.cleanup()); await context.audit.start();
  return { ...context.audit, store, calls, registered, unavailable, options, desktop, ipc: (...args) => handler(...args) };
}

test('快捷功能复用当前窗口与会话，一键置顶产生唯一反馈而bootstrap不重放', async t => {
  const app = await harness(t);
  await app.handle('shortcut-command', { command: 'toggle-pin' });
  const first = (await app.state()).pinFeedback;
  assert.equal(first.enabled, true); assert.deepEqual(app.calls.pin, [true]);
  const bootstrap = await app.handle('bootstrap');
  assert.equal(bootstrap.pinFeedback, null); assert.equal(bootstrap.pinFeedbackBaseline, first.id);
  await app.handle('pin', { pinned: true }); assert.equal((await app.state()).pinFeedback.id, first.id);
  await app.handle('shortcut-command', { command: 'toggle-pin' });
  assert.equal((await app.state()).pinFeedback.enabled, false); assert.notEqual((await app.state()).pinFeedback.id, first.id);
  assert.equal((await app.handle('bootstrap')).pinFeedbackBaseline, (await app.state()).pinFeedback.id);
  await app.handle('shortcut-command', { command: 'toggle-wide' }); assert.deepEqual(app.calls.wide, [true]);
  const { id } = await app.handle('new-text', { text: '供快捷功能保留的材料' });
  app.seedJob(id, 'context'); await app.handle('shortcut-command', { command: 'stop' }); assert.equal(app.calls.aborted, 1);
  await app.handle('shortcut-command', { command: 'history' }); assert.equal((await app.state()).view, 'history');
  await app.handle('shortcut-command', { command: 'appearance' }); assert.equal((await app.state()).settingsSection, 'appearance');
  await app.handle('shortcut-command', { command: 'paste' }); assert.equal((await app.state()).view, 'paste');
  assert.equal((await app.state()).session.id, id);
  await app.handle('shortcut-command', { command: 'capture' }); assert.equal(app.calls.captures, 1);
  await app.handle('shortcut-command', { command: 'toggle-orb' }); assert.equal((await app.state()).settings.prefs.showOrb, false);
  await app.handle('shortcut-command', { command: 'toggle-selection' }); assert.equal((await app.state()).settings.prefs.selectionEnabled, false);
  await app.handle('shortcut-command', { command: 'close-panel' }); assert.equal(app.calls.hidden, 1);
  await assert.rejects(app.handle('shortcut-command', { command: 'quit' }), /快捷功能不存在/);
  await assert.rejects(app.handle('shortcut-command', { command: 'paste', extra: true }), /快捷功能不存在/);
});

test('快捷键注册占用或磁盘失败不会保存新设置，原快捷键仍有效', async t => {
  const app = await harness(t);
  await app.handle('open-shortcuts'); app.unavailable.add('Ctrl+G');
  await assert.rejects(app.handle('save-settings', { prefs: { shortcuts: { ...DEFAULT_SHORTCUTS, paste: 'Ctrl+G' } } }), /无法注册/);
  assert.deepEqual((await app.store.getSettings()).prefs.shortcuts, DEFAULT_SHORTCUTS);
  assert.equal((await app.state()).status.shortcuts.bindings.paste.activeAccelerator, DEFAULT_SHORTCUTS.paste);
  app.unavailable.clear(); const save = app.store.saveSettings;
  app.store.saveSettings = async () => { throw new Error('虚构磁盘失败'); };
  await assert.rejects(app.handle('save-settings', { prefs: { shortcuts: { ...DEFAULT_SHORTCUTS, paste: 'Ctrl+G' } } }), /虚构磁盘失败/);
  assert.equal(app.registered.has('Ctrl+G'), false); assert.equal(app.registered.has(DEFAULT_SHORTCUTS.paste), true);
  app.store.saveSettings = save;
  await app.handle('save-settings', { prefs: { shortcuts: { ...DEFAULT_SHORTCUTS, paste: 'control+g' }, pinSound: false } });
  const state = await app.state(); assert.equal(state.view, 'settings'); assert.equal(state.settingsSection, 'shortcuts');
  assert.equal(state.settings.prefs.shortcuts.paste, 'Ctrl+G'); assert.equal(state.settings.prefs.pinSound, false);
  assert.equal(state.status.shortcuts.bindings.paste.registered, true);
  const count = app.calls.registers.length;
  await app.handle('save-settings', { text: { model: '仅更新模型' } }); assert.equal(app.calls.registers.length, count);
});

test('启动快捷键失败如实报告，保存其它设置不会重复抢占未变快捷键', async t => {
  const app = await harness(t, { blocked: [DEFAULT_SHORTCUTS.capture] });
  assert.match((await app.state()).status.shortcuts.error, /无法注册/);
  const count = app.calls.registers.length;
  await app.handle('save-settings', { prefs: { pinSound: false } });
  assert.equal(app.calls.registers.length, count); assert.equal((await app.state()).settings.prefs.pinSound, false);
});

test('并发快捷键和独立偏好保存串行完成，不用旧快照恢复刚更新的组合', async t => {
  const app = await harness(t);
  await app.handle('open-shortcuts');
  await Promise.all([
    app.handle('save-settings', { prefs: { shortcuts: { ...DEFAULT_SHORTCUTS, paste: 'Ctrl+G' } } }),
    app.handle('save-settings', { prefs: { pinSound: false } }),
    app.options.onWindowState({ orb: null, panel: { x: -500, y: 100 }, sizes: { compact: { width: 300, height: 483 }, reading: { width: 860, height: 690 } }, wide: false }),
  ]);
  const state = await app.state();
  assert.equal(state.settings.prefs.shortcuts.paste, 'Ctrl+G'); assert.equal(state.settings.prefs.pinSound, false);
  assert.equal(state.settings.prefs.windowGeometry.panel.x, -500);
  assert.equal(app.registered.has('Ctrl+G'), true); assert.equal(app.registered.has(DEFAULT_SHORTCUTS.paste), false);
  app.registered.get(DEFAULT_SHORTCUTS['toggle-pin'])();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await app.state()).pinned, true);
});

test('快捷键录制仅设置页可启动，离开或关闭时恢复；非panel不能请求录制', async t => {
  const app = await harness(t);
  await assert.rejects(app.handle('shortcut-recording', { active: true }), /先打开快捷键设置/);
  await app.handle('open-shortcuts');
  assert.equal((await app.ipc({ panel: false }, 'shortcut-recording', { active: true })).ok, false);
  assert.equal((await app.ipc({ panel: true }, 'shortcut-recording', { active: true })).ok, true);
  assert.equal((await app.state()).status.shortcuts.recording, true); assert.equal(app.registered.size, 1);
  await app.handle('open-appearance'); assert.equal((await app.state()).status.shortcuts.recording, false);
  assert.equal(app.registered.has(DEFAULT_SHORTCUTS.paste), true);
  await app.handle('open-shortcuts'); await app.handle('shortcut-recording', { active: true });
  await app.handle('close'); assert.equal((await app.state()).status.shortcuts.recording, false);
});

test('宿主收到录制中的保存请求也先实际预检，占用时设置不落盘', async t => {
  const app = await harness(t); await app.handle('open-shortcuts');
  await app.handle('shortcut-recording', { active: true }); app.unavailable.add('Ctrl+Alt+H');
  await assert.rejects(app.handle('save-settings', { prefs: { shortcuts: { ...DEFAULT_SHORTCUTS, history: 'Ctrl+Alt+H' } } }), /无法注册/);
  assert.deepEqual((await app.store.getSettings()).prefs.shortcuts, DEFAULT_SHORTCUTS);
  assert.equal((await app.state()).status.shortcuts.recording, false);
  assert.equal(app.registered.has(DEFAULT_SHORTCUTS.paste), true);
});

test('菜单协议透传来源和代次，bootstrap裁剪仅作用于状态返回', async t => {
  const app = await harness(t);
  await app.handle('menu', { source: 'panel' }); assert.equal(app.calls.menu.at(-1).source, 'panel');
  const ready = await app.handle('menu-ready', { generation: 7 }); assert.equal(ready.generation, 7);
  await app.handle('menu-close', { generation: 7, finished: true }); assert.equal(app.calls.menuClosed.at(-1).generation, 7);
  const state = await app.ipc({ panel: true }, 'bootstrap', {}); assert.equal(state.value.projected, true); assert.equal(app.calls.projected, 1);
  await app.ipc({ panel: true }, 'save-settings', { prefs: { pinSound: false } }); assert.equal(app.calls.projected, 1);
});

test('隔离模式保存快捷键读回但没有真实注册，退出只清理本控制器注册', async t => {
  const app = await harness(t, { isolated: true });
  await app.handle('open-shortcuts'); await app.handle('save-settings', { prefs: { shortcuts: { ...DEFAULT_SHORTCUTS, paste: 'Ctrl+G' } } });
  assert.deepEqual(app.calls.registers, []); assert.equal((await app.state()).settings.prefs.shortcuts.paste, 'Ctrl+G');
  assert.equal((await app.state()).status.shortcuts.enabled, false); assert.match((await app.state()).status.shortcuts.reason, /隔离验证/);
  await app.quit(); assert.equal(app.calls.quit, 1); assert.equal(app.registered.has('Ctrl+F1'), true);
});
