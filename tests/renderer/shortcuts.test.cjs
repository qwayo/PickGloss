'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createShortcutController, DEFAULT_SHORTCUTS } = require('../../src/core/shortcuts.cjs');

function editor({ controller, save = async () => ({ ok: true }), deferFrom = 1 } = {}) {
  const documentEvents = new Map(), windowEvents = new Map(), calls = [];
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.attrs = {}; this.events = {}; this.classList = { toggle() {} }; }
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
  }, save });
  ui.receive({}, { shortcuts: { enabled: true, recording: false, bindings: {} } });
  const container = new Element('main'); ui.mount(container);
  function find(field, node = container) { if (node.dataset?.field === field) return node; for (const child of node.children || []) { const found = find(field, child); if (found) return found; } }
  function withClass(name, node = container) { if (node.className?.split(' ').includes(name)) return node; for (const child of node.children || []) { const found = withClass(name, child); if (found) return found; } }
  return { ui, calls, resolveStart: () => resolveStart(), button: field => find(`shortcut-${field}`), saveButton: () => withClass('primary'), notice: () => withClass('shortcut-notice'),
    key: (type, properties) => { for (const listener of documentEvents.get(type) || []) listener({ preventDefault() {}, stopImmediatePropagation() {}, ...properties }); },
    blur: () => { for (const listener of windowEvents.get('blur') || []) listener(); }, get hostRecording() { return hostRecording; } };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('录制开始回执尚未到达时失焦，迟到成功也恢复宿主热键', async () => {
  const page = editor(), pending = page.button('history').click();
  await flush(); assert.equal(page.hostRecording, true);
  page.blur(); page.resolveStart(); await pending; await flush();
  assert.equal(page.hostRecording, false);
  assert.notEqual(page.button('history').attrs['aria-pressed'], 'true');
  assert.ok(page.calls.includes(false)); page.ui.dispose();
});

test('录制开始回执尚未到达时卸载，迟到成功不能遗留暂停状态', async () => {
  const page = editor(), pending = page.button('history').click();
  await flush(); page.ui.dispose(); page.resolveStart(); await pending; await flush();
  assert.equal(page.hostRecording, false);
});

test('取消旧录制并开始新功能时，旧回执不会取消后续有效录制', async () => {
  const page = editor(), first = page.button('history').click();
  await flush(); page.blur(); const second = page.button('appearance').click();
  page.resolveStart(); await first; await second; await flush();
  assert.equal(page.hostRecording, true);
  assert.equal(page.button('appearance').attrs['aria-pressed'], 'true');
  await page.ui.endRecording(); assert.equal(page.hostRecording, false); page.ui.dispose();
});

test('录制回执与恢复未完成时禁用保存，强制提交也等待并通过真实注册预检', async () => {
  const registered = new Set(), unavailable = new Set();
  const controller = createShortcutController({ globalShortcut: {
    register(key) { if (registered.has(key) || unavailable.has(key)) return false; registered.add(key); return true; },
    unregister(key) { registered.delete(key); },
  }, onCommand() {} });
  await controller.apply(DEFAULT_SHORTCUTS); let persisted = false, saveCalls = 0;
  const page = editor({ controller, deferFrom: 2, save: async payload => {
    saveCalls++;
    try { await controller.apply(payload.shortcuts, async () => { persisted = true; }); return { ok: true }; }
    catch (error) { return { ok: false, error: error.message }; }
  } });
  await page.button('history').click();
  const key = { key: 'h', code: 'KeyH', ctrlKey: true, altKey: true };
  page.key('keydown', key); page.key('keyup', key); await page.ui.endRecording(); await flush();
  assert.equal(page.saveButton().disabled, false);
  const pending = page.button('appearance').click(); await flush(); page.blur();
  assert.equal(controller.snapshot().recording, true);
  assert.equal(page.saveButton().disabled, true, '等待恢复期间不能提前启用保存');
  const saving = page.saveButton().click(); await flush();
  assert.equal(saveCalls, 0, '即使强制触发提交，也必须等录制队列结束');
  unavailable.add('Ctrl+Alt+H'); page.resolveStart(); await pending; await saving;
  assert.equal(controller.snapshot().recording, false); assert.equal(saveCalls, 1);
  assert.equal(persisted, false); assert.match(page.notice().textContent, /无法注册/);
  assert.match(page.button('history').textContent, /H/);
  page.ui.dispose(); await controller.dispose();
});
