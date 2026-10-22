'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_SHORTCUTS, normalizeAccelerator, shortcutsShape, createShortcutController } = require('../../src/core/shortcuts.cjs');

function registry() {
  const callbacks = new Map(), unavailable = new Set(), registered = [], removed = [];
  return { callbacks, unavailable, registered, removed,
    register(key, callback) { registered.push(key); if (callbacks.has(key) || unavailable.has(key)) return false; callbacks.set(key, callback); return true; },
    unregister(key) { removed.push(key); callbacks.delete(key); },
  };
}

test('快捷键规范化等价修饰键和顺序，重复命令组合被拒绝', () => {
  assert.equal(normalizeAccelerator(' shift + control + option + g '), 'Ctrl+Alt+Shift+G');
  assert.equal(normalizeAccelerator('Win+Ctrl+f12'), 'Ctrl+Super+F12');
  assert.equal(normalizeAccelerator('CmdOrCtrl+ArrowLeft'), 'Ctrl+Left');
  assert.equal(normalizeAccelerator('  '), '');
  const shortcuts = { ...DEFAULT_SHORTCUTS, paste: 'ctrl+alt+g', capture: 'Option+Control+G' };
  assert.throws(() => shortcutsShape(shortcuts), { code: 'INVALID_INPUT' });
  for (const value of ['A', 'Shift+A', 'Ctrl', 'Ctrl++G', 'Ctrl+G+H', 'Ctrl+Control+G', 'Ctrl+Escape', 'Esc', 'Ctrl+F25', 'Ctrl+constructor', 'Ctrl+__proto__', 'Ctrl+任意代码', null]) {
    assert.throws(() => normalizeAccelerator(value), { code: 'INVALID_INPUT' });
  }
  assert.throws(() => shortcutsShape({ ...DEFAULT_SHORTCUTS, unknown: 'Ctrl+K' }), { code: 'INVALID_INPUT' });
  assert.throws(() => shortcutsShape({ paste: 'Ctrl+K' }), { code: 'INVALID_INPUT' });
});

test('注册新快捷键失败时撤销本次预检，原有快捷键和其它模块注册保持可用', async () => {
  const globalShortcut = registry(), commands = [], statuses = [];
  globalShortcut.callbacks.set('Ctrl+F1', () => {});
  const controller = createShortcutController({ globalShortcut, onCommand: value => commands.push(value), onStatus: value => statuses.push(value) });
  await controller.apply(DEFAULT_SHORTCUTS);
  const next = { ...DEFAULT_SHORTCUTS, paste: 'Ctrl+G', capture: 'Ctrl+S' };
  globalShortcut.unavailable.add('Ctrl+S'); let persisted = false;
  await assert.rejects(controller.apply(next, async () => { persisted = true; }), { code: 'SHORTCUT_UNAVAILABLE' });
  assert.equal(persisted, false); assert.equal(globalShortcut.callbacks.has('Ctrl+G'), false);
  globalShortcut.callbacks.get('Alt+Shift+G')(); assert.deepEqual(commands, ['paste']);
  assert.equal(controller.snapshot().bindings.paste.activeAccelerator, 'Alt+Shift+G');
  assert.equal(controller.snapshot().bindings.capture.registered, false);
  assert.match(statuses.at(-1).error, /无法注册/);
  await controller.dispose(); assert.deepEqual([...globalShortcut.callbacks.keys()], ['Ctrl+F1']);
});

test('存储失败撤销新增注册，命令互换无需注销已持有的组合', async () => {
  const globalShortcut = registry(), commands = [];
  const controller = createShortcutController({ globalShortcut, onCommand: command => commands.push(command) });
  await controller.apply(DEFAULT_SHORTCUTS);
  await assert.rejects(controller.apply({ ...DEFAULT_SHORTCUTS, paste: 'Ctrl+G' }, async () => { throw new Error('虚构写盘失败'); }), /虚构写盘失败/);
  assert.equal(globalShortcut.callbacks.has('Ctrl+G'), false); assert.equal(globalShortcut.callbacks.has('Alt+Shift+G'), true);
  const registered = globalShortcut.registered.length, removed = globalShortcut.removed.length;
  await controller.apply({ ...DEFAULT_SHORTCUTS, paste: DEFAULT_SHORTCUTS.capture, capture: DEFAULT_SHORTCUTS.paste });
  assert.equal(globalShortcut.registered.length, registered); assert.equal(globalShortcut.removed.length, removed);
  globalShortcut.callbacks.get('Alt+Shift+G')(); assert.deepEqual(commands, ['capture']);
  await controller.dispose();
});

test('快捷键未变时仅保存数据，清空组合只注销本控制器对应按键', async () => {
  const globalShortcut = registry(); const controller = createShortcutController({ globalShortcut, onCommand() {} });
  await controller.apply(DEFAULT_SHORTCUTS); const count = globalShortcut.registered.length;
  let persisted = 0; await controller.apply(DEFAULT_SHORTCUTS, async () => persisted++);
  assert.equal(persisted, 1); assert.equal(globalShortcut.registered.length, count);
  await controller.apply({ ...DEFAULT_SHORTCUTS, capture: '' });
  assert.deepEqual(globalShortcut.removed, ['Alt+Shift+S']); assert.equal(controller.snapshot().bindings.capture.registered, false);
  await controller.dispose();
});

test('录制仅暂停本应用快捷键，保存先结束录制并实际注册新组合', async () => {
  const globalShortcut = registry(), timers = new Map(); let timerId = 0;
  globalShortcut.callbacks.set('Ctrl+F1', () => {});
  const controller = createShortcutController({ globalShortcut, onCommand() {}, setTimer: callback => { timers.set(++timerId, callback); return timerId; }, clearTimer: id => timers.delete(id) });
  await controller.apply(DEFAULT_SHORTCUTS); await controller.setRecording(true);
  assert.deepEqual([...globalShortcut.callbacks.keys()], ['Ctrl+F1']); assert.equal(controller.snapshot().recording, true);
  const count = globalShortcut.registered.length;
  await controller.apply({ ...DEFAULT_SHORTCUTS, paste: 'Ctrl+G' }); assert.ok(globalShortcut.registered.length > count);
  assert.equal(controller.snapshot().recording, false);
  await controller.setRecording(false); assert.equal(timers.size, 0);
  assert.equal(globalShortcut.callbacks.has('Ctrl+G'), true); assert.equal(globalShortcut.callbacks.has('Alt+Shift+G'), false);
  assert.equal(controller.snapshot().bindings.paste.registered, true); await controller.dispose();
});

test('录制中保存被占用的新组合仍须预检，失败不写盘并恢复旧组合', async () => {
  const globalShortcut = registry();
  const controller = createShortcutController({ globalShortcut, onCommand() {} });
  await controller.apply(DEFAULT_SHORTCUTS); await controller.setRecording(true);
  globalShortcut.unavailable.add('Ctrl+Alt+H'); let persisted = false;
  await assert.rejects(controller.apply({ ...DEFAULT_SHORTCUTS, history: 'Ctrl+Alt+H' }, async () => { persisted = true; }), { code: 'SHORTCUT_UNAVAILABLE' });
  assert.equal(persisted, false); assert.equal(controller.snapshot().recording, false);
  assert.equal(globalShortcut.callbacks.has(DEFAULT_SHORTCUTS.paste), true);
  assert.equal(controller.snapshot().bindings.history.registered, false);
  await controller.dispose();
});

test('录制超时会恢复快捷键，恢复时遇到占用如实报告未注册', async () => {
  const globalShortcut = registry(); let timeout;
  const controller = createShortcutController({ globalShortcut, onCommand() {}, setTimer: (callback, delay) => { assert.equal(delay, 25000); timeout = callback; return 1; }, clearTimer() {} });
  await controller.apply(DEFAULT_SHORTCUTS); await controller.setRecording(true);
  timeout(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(controller.snapshot().recording, false); assert.equal(controller.snapshot().bindings.paste.registered, true);
  await controller.setRecording(true); globalShortcut.unavailable.add(DEFAULT_SHORTCUTS.capture);
  await assert.rejects(controller.setRecording(false), { code: 'SHORTCUT_UNAVAILABLE' });
  assert.equal(controller.snapshot().recording, false); assert.equal(controller.snapshot().bindings.capture.registered, false);
  assert.match(controller.snapshot().error, /无法注册/); assert.equal(globalShortcut.callbacks.size, 0);
  await controller.dispose();
});

test('启动时自定义组合注册失败，录制恢复仍使用已保存的自定义设置', async () => {
  const globalShortcut = registry(), initial = { ...DEFAULT_SHORTCUTS, paste: 'Ctrl+G' };
  globalShortcut.unavailable.add('Ctrl+G');
  const controller = createShortcutController({ globalShortcut, initial, onCommand() {}, setTimer: () => 1, clearTimer() {} });
  await assert.rejects(controller.apply(initial), { code: 'SHORTCUT_UNAVAILABLE' });
  await controller.setRecording(true); globalShortcut.unavailable.clear(); await controller.setRecording(false);
  assert.equal(globalShortcut.callbacks.has('Ctrl+G'), true); assert.equal(globalShortcut.callbacks.has(DEFAULT_SHORTCUTS.paste), false);
  await controller.dispose();
});

test('隔离验证模式仍校验保存设置但不会调用全局快捷键注册', async () => {
  const controller = createShortcutController({ globalShortcut: { register() { assert.fail('隔离模式不能注册'); }, unregister() { assert.fail('隔离模式不能注销'); } }, isolated: true, onCommand() {} });
  let saved; await controller.apply(DEFAULT_SHORTCUTS, async next => { saved = next; });
  assert.deepEqual(saved, DEFAULT_SHORTCUTS); assert.equal(controller.snapshot().enabled, false);
  assert.match(controller.snapshot().reason, /隔离验证/);
  assert.equal(Object.values(controller.snapshot().bindings).some(value => value.registered), false);
  await controller.dispose();
});
