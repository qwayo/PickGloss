'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createStore } = require('../../src/core/store.cjs');
const { defaultAppearance, defaultWindowGeometry } = require('../../src/core/appearance.cjs');

async function harness(t, timers = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pickgloss-appearance-actions-'));
  const store = createStore({ directory }); await store.init();
  const calls = { orb: [], orbPreferences: [], hover: [], selection: [], appearance: [], broadcasts: 0, quit: 0, disposed: 0, restored: null };
  let options, handler;
  const desktop = {
    captureState: () => null, broadcast: () => calls.broadcasts++, openPanel() {}, initTray() {}, prepareCapture() {},
    setOrb: value => calls.orb.push(value), startSelection: value => calls.selection.push(value),
    setOrbPreferences: prefs => calls.orbPreferences.push({ quietFadeEnabled: prefs.orbQuietFade !== false, edgeCollapseEnabled: prefs.orbEdgeCollapse !== false }),
    hoverOrb: active => calls.hover.push(active),
    setAppearance: value => calls.appearance.push(value), restoreWindowState: geometry => { calls.restored = geometry; return geometry.wide; },
    flushDrafts: async () => true, flushWindowState: async () => true, dispose: () => calls.disposed++,
    authorize: (event, action) => action !== 'orb-drag' || event.orb === true,
    dragOrb: payload => ({ phase: payload.phase, moved: true }),
  };
  const app = { setPath() {}, getPath: () => directory, setName() {}, setAppUserModelId() {}, on() {},
    requestSingleInstanceLock: () => true, whenReady: () => new Promise(() => {}), quit: () => calls.quit++ };
  const electron = { app, ipcMain: { handle: (_channel, callback) => { handler = callback; } },
    globalShortcut: { register: () => true, unregister() {}, unregisterAll() {} },
    session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } } };
  const target = path.join(__dirname, '../../src/main.cjs');
  const context = { require: name => name === 'electron' ? electron : name === './core/store.cjs' ? { createStore: () => store } :
    name === './windows/desktop.cjs' ? { createDesktop: value => { options = value; return desktop; } } :
      name.startsWith('./') ? require(path.join(path.dirname(target), name)) : require(name),
    process: { argv: [], env: {}, pid: 1, platform: 'win32' }, URL, structuredClone, AbortController, setTimeout, clearTimeout, ...timers };
  vm.createContext(context);
  vm.runInContext(await fs.readFile(target, 'utf8') + '\nglobalThis.audit={start,handle,state,quit,cleanup:()=>clearTimeout(emitTimer)};', context);
  t.after(() => context.audit.cleanup());
  await context.audit.start();
  return { ...context.audit, store, calls, desktop, options, ipc: (...args) => handler(...args) };
}

test('外观独立保存留在外观页，不重新启停悬浮球或划词监听', async t => {
  const app = await harness(t);
  await app.handle('open-appearance');
  const appearance = defaultAppearance(); appearance.current.material = 'glass';
  await app.handle('save-settings', { prefs: { appearance } });
  const state = await app.state();
  assert.equal(state.view, 'settings'); assert.equal(state.settingsSection, 'appearance');
  assert.equal(app.calls.appearance.length, 2);
  assert.deepEqual(app.calls.orb, [true]); assert.deepEqual(app.calls.selection, [true]);
  await app.handle('save-settings', { prefs: { appearance, showOrb: false } });
  assert.deepEqual(app.calls.orb, [true, false]); assert.equal(app.calls.appearance.length, 2);
  await app.handle('open-settings');
  assert.equal((await app.state()).settingsSection, 'service');
  await app.handle('save-settings', { text: { model: '测试模型' }, prefs: { selectionEnabled: false } });
  assert.equal((await app.state()).view, 'paste'); assert.deepEqual(app.calls.selection, [true, false]);
  assert.equal('apiKey' in (await app.state()).settings.text, false);
});

test('悬浮球静默淡化和贴边设置默认开启，并按保存值下发到控制器', async t => {
  const app = await harness(t);
  assert.deepEqual(app.calls.orbPreferences.at(-1), { quietFadeEnabled: true, edgeCollapseEnabled: true });
  await app.handle('save-settings', { prefs: { orbQuietFade: false, orbEdgeCollapse: true } });
  assert.deepEqual(app.calls.orbPreferences.at(-1), { quietFadeEnabled: false, edgeCollapseEnabled: true });
  await app.handle('save-settings', { prefs: { orbQuietFade: true, orbEdgeCollapse: false } });
  assert.deepEqual(app.calls.orbPreferences.at(-1), { quietFadeEnabled: true, edgeCollapseEnabled: false });
});

test('悬浮球进入和离开通过新增 hoverOrb 接口通知控制器', async t => {
  const app = await harness(t);
  await app.handle('orb-hover', { active: true });
  await app.handle('orb-hover', { active: false });
  assert.deepEqual(app.calls.hover, [true, false]);
});

test('主进程恢复窗口状态，持久回调保留随后保存的外观并同步原生阅读状态', async t => {
  const app = await harness(t);
  assert.deepEqual(app.calls.restored, defaultWindowGeometry());
  const appearance = defaultAppearance(); appearance.current.mode = 'system';
  const geometry = defaultWindowGeometry(); geometry.panel = { x: -800, y: 120 }; geometry.wide = true;
  await Promise.all([app.options.onWindowState(geometry), app.handle('save-settings', { prefs: { appearance } })]);
  app.options.onStatus({ wide: true, appearanceDark: false, reducedMotion: true, appearanceMaterial: 'solid' });
  const state = await app.state();
  assert.equal(state.wide, true); assert.equal(state.status.appearanceDark, false);
  assert.equal(state.status.appearanceMaterial, 'solid'); assert.equal(state.status.reducedMotion, true);
  assert.deepEqual(state.settings.prefs.windowGeometry, geometry); assert.deepEqual(state.settings.prefs.appearance, appearance);
});

test('悬浮球拖动直接返回结果且不广播状态，其它窗口请求被拒绝', async t => {
  const app = await harness(t), before = app.calls.broadcasts;
  const result = await app.ipc({ orb: true }, 'orb-drag', { phase: 'move', x: 10, y: 20 });
  assert.equal(result.ok, true); assert.equal(result.value.moved, true);
  assert.equal(app.calls.broadcasts, before);
  assert.equal((await app.ipc({ orb: false }, 'orb-drag', { phase: 'move', x: 10, y: 20 })).ok, false);
  assert.equal(app.calls.broadcasts, before);
});

test('窗口状态写盘失败或异常时取消退出，恢复后允许重试', async t => {
  const app = await harness(t);
  app.desktop.flushWindowState = async () => false;
  await app.quit(); assert.equal(app.calls.quit, 0); assert.equal(app.calls.disposed, 0);
  assert.match((await app.state()).status.error, /窗口位置或尺寸尚未保存/);
  app.desktop.flushWindowState = async () => { throw new Error('虚构磁盘故障'); };
  await app.quit(); assert.equal(app.calls.quit, 0);
  app.desktop.flushWindowState = async () => true;
  await app.quit(); assert.equal(app.calls.quit, 1); assert.equal(app.calls.disposed, 1);
});

test('退出前已有待广播计时器，任一保存失败取消退出后仍能安排状态广播', async t => {
  for (const failure of ['草稿', '窗口', '会话']) await t.test(failure, async t => {
    const pending = new Map(); let sequence = 0;
    const app = await harness(t, {
      setTimeout: callback => { const id = ++sequence; pending.set(id, callback); return id; },
      clearTimeout: id => pending.delete(id),
    });
    if (failure === '草稿') app.desktop.flushDrafts = async () => false;
    if (failure === '窗口') app.desktop.flushWindowState = async () => false;
    if (failure === '会话') {
      await app.handle('new-text', { text: '仅用于退出恢复验证的材料' });
      app.store.updateSession = async () => { throw new Error('虚构会话写盘故障'); };
    }
    app.options.onStatus({ selection: '退出前待广播状态' });
    assert.equal(pending.size, 1);
    await app.quit();
    assert.equal(app.calls.quit, 0); assert.equal(pending.size, 0);
    const before = app.calls.broadcasts;
    app.options.onStatus({ selection: '退出取消后的新状态' });
    assert.equal(pending.size, 1, '取消退出后必须能够重新安排广播');
    const callback = pending.values().next().value; pending.clear(); callback();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(app.calls.broadcasts, before + 1);
  });
});

test('预加载仅开放外观与悬浮球拖动、悬停接口', async () => {
  const calls = []; let bridge;
  const context = { require: () => ({ contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
    ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve({ ok: true }); } } }) };
  vm.createContext(context);
  vm.runInContext(await fs.readFile(path.join(__dirname, '../../src/preload.cjs'), 'utf8'), context);
  await bridge.invoke('open-appearance'); await bridge.invoke('orb-drag', { phase: 'start', x: 0, y: 0 });
  await bridge.invoke('orb-hover', { active: true });
  assert.equal(calls.length, 3); assert.equal(calls[0][1], 'open-appearance'); assert.equal(calls[1][1], 'orb-drag'); assert.equal(calls[2][1], 'orb-hover');
  assert.equal((await bridge.invoke('任意未授权动作')).ok, false); assert.equal(calls.length, 3);
});
