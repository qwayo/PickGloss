'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createShortcutController, DEFAULT_SHORTCUTS } = require('../../src/core/shortcuts.cjs');

function editor({ controller, save = async () => ({ ok: true }), onDiscard = () => {}, deferFrom = Number.POSITIVE_INFINITY, initial = {} } = {}) {
  const documentEvents = new Map(), windowEvents = new Map(), calls = [];
  class Element {
    constructor(tag) {
      this.tag = tag; this.children = []; this.dataset = {}; this.attrs = {}; this.events = {}; this.disabled = false; this.hidden = false;
      this.classList = { toggle: (name, active) => { this.classes ||= new Set(); active ? this.classes.add(name) : this.classes.delete(name); } };
    }
    append(...items) { this.children.push(...items); }
    addEventListener(name, callback) { (this.events[name] ||= []).push(callback); }
    setAttribute(name, value) { this.attrs[name] = value; }
    focus() {}
    click() { return this.events.click?.[0]({}); }
  }
  const listen = map => (name, callback) => { const entries = map.get(name) || []; entries.push(callback); map.set(name, entries); };
  const unlisten = map => (name, callback) => map.set(name, (map.get(name) || []).filter(item => item !== callback));
  let resolveStart, hostRecording = false, starts = 0;
  const startGate = new Promise(resolve => { resolveStart = resolve; });
  const context = { document: { createElement: tag => new Element(tag), addEventListener: listen(documentEvents), removeEventListener: unlisten(documentEvents) }, window: { addEventListener: listen(windowEvents), removeEventListener: unlisten(windowEvents) } };
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/shortcuts.js'), 'utf8');
  vm.runInContext(source.replace(/^export /gm, '') + '\nglobalThis.createEditor=createShortcutsUI;', context);
  const ui = context.createEditor({ invoke: async (_action, payload) => {
    calls.push(payload.active); hostRecording = payload.active;
    if (controller) await controller.setRecording(payload.active);
    if (payload.active && ++starts >= deferFrom) await startGate;
    return { ok: true };
  }, save, onDiscard });
  ui.receive(initial, { shortcuts: { enabled: true, recording: false, bindings: {} } });
  const container = new Element('main'); ui.mount(container);
  function find(predicate, node = container) {
    if (predicate(node)) return node;
    for (const child of node.children || []) { const found = find(predicate, child); if (found) return found; }
  }
  const findField = field => find(node => node.dataset?.field === `shortcut-${field}`);
  const allButtons = () => {
    const result = [];
    const visit = node => { if (node.tag === 'button') result.push(node); for (const child of node.children || []) visit(child); };
    visit(container); return result;
  };
  return {
    ui, calls, resolveStart: () => resolveStart(), button: findField,
    clearButton: field => find(node => node.className === 'shortcut-clear' && node.attrs['aria-label'] === `清除${({ paste: '粘贴文字', capture: '截图框选', history: '会话历史', appearance: '外观与主题', 'toggle-pin': '置顶 / 取消置顶', 'toggle-wide': '展开 / 收窄', 'toggle-orb': '显示 / 隐藏悬浮球', 'close-panel': '收起解释窗口', 'toggle-selection': '暂停 / 开启划词', stop: '停止回答' })[field]}快捷键`),
    actionButton: label => find(node => node.tag === 'button' && node.textContent === label),
    notice: () => find(node => node.className === 'shortcut-notice'),
    buttons: allButtons,
    key: (type, properties) => { for (const listener of documentEvents.get(type) || []) listener({ preventDefault() {}, stopImmediatePropagation() {}, ...properties }); },
    blur: () => { for (const listener of windowEvents.get('blur') || []) listener(); },
    get hostRecording() { return hostRecording; },
  };
}
const flushMicrotasks = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  for (let i = 0; i < 30 && !predicate(); i++) await flushMicrotasks();
  assert.ok(predicate(), '异步操作应在有限微任务内到达预期状态');
}
const key = (letter, code = `Key${letter.toUpperCase()}`) => ({ key: letter, code, ctrlKey: true, altKey: true });
const defaultShortcuts = { ...DEFAULT_SHORTCUTS };

test('录制开始回执尚未到达时失焦，迟到成功也恢复宿主热键', async () => {
  const page = editor({ deferFrom: 1 }), pending = page.button('history').click();
  await flushMicrotasks(); assert.equal(page.hostRecording, true);
  page.blur(); page.resolveStart(); await pending; await flushMicrotasks();
  assert.equal(page.hostRecording, false);
  assert.notEqual(page.button('history').attrs['aria-pressed'], 'true');
  assert.ok(page.calls.includes(false)); page.ui.dispose();
});

test('录制开始回执尚未到达时卸载，迟到成功不能遗留暂停状态', async () => {
  const page = editor({ deferFrom: 1 }), pending = page.button('history').click();
  await flushMicrotasks(); page.ui.dispose(); page.resolveStart(); await pending; await flushMicrotasks();
  assert.equal(page.hostRecording, false);
});

test('取消旧录制并开始新功能时，旧回执不会取消后续有效录制', async () => {
  const page = editor({ deferFrom: 2 }), first = page.button('history').click();
  await flushMicrotasks(); page.blur(); const second = page.button('appearance').click();
  page.resolveStart(); await first; await second; await flushMicrotasks();
  assert.equal(page.hostRecording, true);
  assert.equal(page.button('appearance').attrs['aria-pressed'], 'true');
  await page.ui.endRecording(); assert.equal(page.hostRecording, false); page.ui.dispose();
});

test('完整组合键在释放后自动保存，单独按修饰键不保存且提供恢复已保存值入口', async () => {
  const writes = [], page = editor({ save: async payload => { writes.push(payload); return { ok: true }; } });
  await page.button('history').click();
  page.key('keydown', { key: 'Control', code: 'ControlLeft', ctrlKey: true });
  page.key('keydown', { key: 'Alt', code: 'AltLeft', ctrlKey: true, altKey: true });
  assert.equal(writes.length, 0);
  page.key('keydown', key('h'));
  assert.equal(writes.length, 0, '完整按键在录制释放握手完成前不写入');
  page.key('keyup', key('h'));
  await page.ui.flush();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].shortcuts.history, 'Ctrl+Alt+H');
  assert.equal(page.notice().textContent, '快捷键已自动保存');
  assert.equal(page.buttons().some(item => /^(保存|撤销)$/.test(item.textContent)), false);
  assert.ok(page.actionButton('恢复已保存值'));
  page.ui.dispose();
});

test('快捷键冲突保留原值并就地提示，且不会调用保存', async () => {
  let writes = 0;
  const page = editor({ save: async () => { writes++; return { ok: true }; } });
  await page.button('history').click();
  page.key('keydown', { key: 's', code: 'KeyS', ctrlKey: true, altKey: false, shiftKey: true });
  assert.match(page.notice().textContent, /已用于“截图框选”/);
  page.key('keyup', { key: 's', code: 'KeyS', ctrlKey: true, altKey: false, shiftKey: true });
  await page.ui.flush();
  assert.equal(writes, 0);
  assert.equal(page.button('history').textContent, '未设置');
  page.ui.dispose();
});

test('宿主注册失败显示未保存，保留新输入并允许重录重试', async () => {
  const registered = new Set(), unavailable = new Set();
  const controller = createShortcutController({ globalShortcut: {
    register(accelerator) { if (registered.has(accelerator) || unavailable.has(accelerator)) return false; registered.add(accelerator); return true; },
    unregister(accelerator) { registered.delete(accelerator); },
  }, onCommand() {} });
  await controller.apply(DEFAULT_SHORTCUTS);
  unavailable.add('Ctrl+Alt+H');
  let persisted = false, writes = 0;
  const page = editor({ controller, save: async payload => {
    writes++;
    try { await controller.apply(payload.shortcuts, async () => { persisted = true; }); return { ok: true }; }
    catch (error) { return { ok: false, error: error.message }; }
  } });
  await page.button('history').click();
  page.key('keydown', key('h')); page.key('keyup', key('h'));
  const result = await page.ui.flush();
  assert.equal(result.ok, false);
  assert.equal(persisted, false);
  assert.equal(writes, 1);
  assert.match(page.notice().textContent, /未保存：.*无法注册/);
  assert.match(page.button('history').textContent, /H/);
  assert.equal(page.buttons().some(item => /^(保存|撤销)$/.test(item.textContent)), false);

  unavailable.delete('Ctrl+Alt+H');
  await page.button('history').click();
  page.key('keydown', key('h')); page.key('keyup', key('h'));
  assert.equal((await page.ui.flush()).ok, true);
  assert.equal(writes, 2, '重新录入相同组合键会重试自动保存');
  assert.equal(persisted, true);
  page.ui.dispose(); await controller.dispose();
});

test('放弃失败快捷键草稿只恢复已保存值，不重试保存或注册', async () => {
  let writes = 0, discards = 0;
  const saved = { ...defaultShortcuts, history: 'Ctrl+Alt+J' };
  const page = editor({ initial: { shortcuts: saved }, onDiscard: () => { discards++; }, save: async () => { writes++; return { ok: false, error: '快捷键被占用' }; } });
  await page.button('history').click();
  page.key('keydown', key('h')); page.key('keyup', key('h'));
  assert.equal((await page.ui.flush()).ok, false);
  assert.equal(page.button('history').textContent, 'Ctrl + Alt + H');
  assert.equal(writes, 1);
  assert.equal(typeof page.ui.discard, 'function');
  const restore = page.actionButton('恢复已保存值');
  assert.ok(restore); assert.equal(restore.hidden, false, '快捷键设置内应直接提供恢复入口');
  await restore.click();
  assert.equal(page.button('history').textContent, 'Ctrl + Alt + J');
  assert.equal(page.notice().textContent, '');
  assert.equal(writes, 1, '恢复已保存值不能再次保存或注册快捷键');
  assert.equal(discards, 1, '恢复已保存值会清除外层自动保存失败状态');
  assert.equal((await page.ui.flush()).ok, true);
  page.ui.dispose();
});

test('Esc 取消录制只恢复宿主快捷键，不保存', async () => {
  let writes = 0;
  const page = editor({ save: async () => { writes++; return { ok: true }; } });
  await page.button('history').click();
  page.key('keydown', { key: 'Escape', code: 'Escape' });
  await page.ui.flush();
  assert.equal(page.hostRecording, false);
  assert.equal(writes, 0);
  assert.equal(page.notice().textContent, '已取消录制');
  page.ui.dispose();
});

test('组合键录入后失焦会结束录制并自动保存', async () => {
  let writes = 0;
  const page = editor({ save: async payload => { writes++; assert.equal(payload.shortcuts.history, 'Ctrl+Alt+H'); return { ok: true }; } });
  await page.button('history').click();
  page.key('keydown', key('h'));
  page.blur();
  await page.ui.flush();
  assert.equal(page.hostRecording, false);
  assert.equal(writes, 1);
  page.ui.dispose();
});

test('清除和恢复默认都会各自自动保存', async () => {
  const writes = [], page = editor({ save: async payload => { writes.push(payload); return { ok: true }; } });
  await page.clearButton('capture').click();
  await page.ui.flush();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].shortcuts.capture, '');

  await page.actionButton('恢复默认').click();
  await page.ui.flush();
  assert.equal(writes.length, 2);
  assert.equal(writes[1].shortcuts.capture, DEFAULT_SHORTCUTS.capture);
  assert.equal(writes[1].shortcuts.history, DEFAULT_SHORTCUTS.history);
  page.ui.dispose();
});

test('保存期间的新录入和迟到 receive 不恢复旧草稿，版本按顺序写入', async () => {
  const writes = [], resolvers = [];
  const page = editor({ save: payload => { writes.push(payload); return new Promise(resolve => resolvers.push(resolve)); } });
  await page.button('history').click();
  page.key('keydown', key('h')); page.key('keyup', key('h'));
  await until(() => writes.length === 1);
  page.ui.receive({ shortcuts: { ...defaultShortcuts, history: 'Ctrl+Alt+J' } }, { shortcuts: { enabled: true, recording: false, bindings: {} } });
  assert.equal(page.button('history').textContent, 'Ctrl + Alt + H');

  await page.button('appearance').click();
  page.key('keydown', key('a')); page.key('keyup', key('a'));
  await flushMicrotasks();
  assert.equal(writes.length, 1, '上一笔保存未完成时不并发写入');
  resolvers[0]({ ok: true });
  await until(() => writes.length === 2);
  assert.equal(writes[0].shortcuts.history, 'Ctrl+Alt+H');
  assert.equal(writes[1].shortcuts.history, 'Ctrl+Alt+H');
  assert.equal(writes[1].shortcuts.appearance, 'Ctrl+Alt+A');
  resolvers[1]({ ok: true });
  await page.ui.flush();
  assert.equal(page.button('history').textContent, 'Ctrl + Alt + H');
  assert.equal(page.button('appearance').textContent, 'Ctrl + Alt + A');
  page.ui.dispose();
});

test('离开时 flush 等待已经开始的保存完成', async () => {
  let resolveSave, finished = false;
  const page = editor({ save: () => new Promise(resolve => { resolveSave = resolve; }) });
  await page.button('history').click();
  page.key('keydown', key('h')); page.key('keyup', key('h'));
  await until(() => typeof resolveSave === 'function');
  page.ui.dispose();
  const pending = page.ui.flush().then(result => { finished = true; return result; });
  await flushMicrotasks();
  assert.equal(finished, false);
  resolveSave({ ok: true });
  assert.equal((await pending).ok, true);
  assert.equal(finished, true);
});
