'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Element {
  constructor(tag, ownerDocument) {
    this.tag = tag; this.ownerDocument = ownerDocument; this.children = []; this.parentNode = null;
    this.dataset = {}; this.attrs = {}; this.events = new Map(); this.captured = new Set(); this.className = '';
  }
  setAttribute(key, value) { this.attrs[key] = String(value); }
  getAttribute(key) { return this.attrs[key] ?? null; }
  addEventListener(type, callback) { const listeners = this.events.get(type) || []; listeners.push(callback); this.events.set(type, listeners); }
  removeEventListener(type, callback) { this.events.set(type, (this.events.get(type) || []).filter(value => value !== callback)); }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; }
  setPointerCapture(id) { this.captured.add(id); }
  hasPointerCapture(id) { return this.captured.has(id); }
  releasePointerCapture(id) { this.captured.delete(id); }
  dispatch(type, properties = {}) {
    const event = { type, currentTarget: this, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.propagationStopped = true; }, ...properties };
    for (const callback of [...(this.events.get(type) || [])]) callback(event);
    return event;
  }
}

function loadPanelResize() {
  const frames = new Map(), documentEvents = new Map(), windowEvents = new Map();
  let frameId = 0, tokenId = 0;
  const view = {
    crypto: { randomUUID: () => `token-${++tokenId}` },
    requestAnimationFrame(callback) { const id = ++frameId; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    addEventListener(type, callback) { const listeners = windowEvents.get(type) || []; listeners.push(callback); windowEvents.set(type, listeners); },
    removeEventListener(type, callback) { windowEvents.set(type, (windowEvents.get(type) || []).filter(value => value !== callback)); },
    dispatch(type) { for (const callback of [...(windowEvents.get(type) || [])]) callback({ type }); },
  };
  const doc = {
    defaultView: view, hidden: false,
    createElement: tag => new Element(tag, doc),
    addEventListener(type, callback) { const listeners = documentEvents.get(type) || []; listeners.push(callback); documentEvents.set(type, listeners); },
    removeEventListener(type, callback) { documentEvents.set(type, (documentEvents.get(type) || []).filter(value => value !== callback)); },
    dispatch(type) { for (const callback of [...(documentEvents.get(type) || [])]) callback({ type }); },
  };
  const context = vm.createContext({ document: doc });
  const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/panel-resize.js'), 'utf8');
  vm.runInContext(source.replace(/^export /gm, '') + '\nglobalThis.mountPanelResize=mountPanelResize;', context);
  return {
    doc, view, frames, mountPanelResize: context.mountPanelResize,
    flushFrames() { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(); },
  };
}

async function settle() {
  for (let index = 0; index < 4; index++) await Promise.resolve();
  await new Promise(resolve => setImmediate(resolve));
}

function mount(harness, invoke = () => ({ ok: true })) {
  const root = new Element('body', harness.doc);
  const panelResize = harness.mountPanelResize({ root, invoke });
  const layer = root.children[0];
  const grips = new Map(layer.children.map(grip => [grip.dataset.edge, grip]));
  return { root, layer, grips, panelResize };
}

test('固定透明层独立于会话内容创建八个方向，卸载时移除', () => {
  const harness = loadPanelResize(), mounted = mount(harness);
  assert.equal(mounted.root.children.length, 1);
  assert.equal(mounted.layer.getAttribute('aria-hidden'), 'true');
  assert.deepEqual([...mounted.grips.keys()], ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']);
  mounted.panelResize.dispose();
  assert.equal(mounted.root.children.length, 0);
});

test('鼠标手势发送逻辑屏幕坐标、令牌一致，动画帧内 move 只发送最新点', async () => {
  const harness = loadPanelResize(), calls = [], mounted = mount(harness, payload => { calls.push(payload); return { ok: true }; });
  const grip = mounted.grips.get('se');
  const ignored = grip.dispatch('pointerdown', { button: 2, pointerId: 2, screenX: 100, screenY: 200 });
  assert.equal(ignored.defaultPrevented, undefined);
  const down = grip.dispatch('pointerdown', { button: 0, isPrimary: true, pointerId: 3, screenX: 100, screenY: 200 });
  await settle();
  assert.equal(down.defaultPrevented, true); assert.equal(grip.hasPointerCapture(3), true);
  grip.dispatch('pointermove', { pointerId: 3, screenX: 103, screenY: 205 });
  grip.dispatch('pointermove', { pointerId: 3, screenX: 117, screenY: 223 });
  assert.equal(calls.filter(call => call.phase === 'move').length, 0, '帧回调前不应发送 move');
  harness.flushFrames(); await settle();
  grip.dispatch('pointerup', { pointerId: 3, screenX: 120, screenY: 230 }); await settle();
  const actual = JSON.parse(JSON.stringify(calls));
  assert.deepEqual(actual.map(call => call.phase), ['start', 'move', 'end']);
  assert.deepEqual(actual.map(({ x, y }) => [x, y]), [[100, 200], [117, 223], [120, 230]]);
  assert.ok(actual.every(call => call.edge === 'se' && call.token === 'token-1'));
  assert.equal(grip.hasPointerCapture(3), false);
  mounted.panelResize.dispose();
});

test('start、合并后的 move 与 end 经过串行 IPC，慢请求不会累积中间点', async () => {
  const harness = loadPanelResize(), calls = [], releases = [];
  let activeCalls = 0, maximumActiveCalls = 0;
  const mounted = mount(harness, payload => {
    calls.push(payload);
    activeCalls++; maximumActiveCalls = Math.max(maximumActiveCalls, activeCalls);
    return new Promise(resolve => releases.push(() => { activeCalls--; resolve({ ok: true }); }));
  });
  const grip = mounted.grips.get('e');
  grip.dispatch('pointerdown', { button: 0, pointerId: 4, screenX: 200, screenY: 300 }); await settle();
  grip.dispatch('pointermove', { pointerId: 4, screenX: 205, screenY: 300 });
  grip.dispatch('pointermove', { pointerId: 4, screenX: 215, screenY: 300 });
  harness.flushFrames();
  grip.dispatch('pointermove', { pointerId: 4, screenX: 225, screenY: 300 });
  harness.flushFrames();
  grip.dispatch('pointerup', { pointerId: 4, screenX: 230, screenY: 300 }); await settle();
  assert.deepEqual(calls.map(call => call.phase), ['start'], 'start 未返回前不能并发发送 move/end');
  releases[0](); await settle();
  assert.deepEqual(calls.map(call => call.phase), ['start', 'move']);
  assert.equal(calls[1].x, 225, '较慢 IPC 期间只保留最新坐标');
  releases[1](); await settle();
  assert.deepEqual(calls.map(call => call.phase), ['start', 'move', 'end']);
  releases[2](); await settle();
  assert.equal(maximumActiveCalls, 1);
  mounted.panelResize.dispose();
});

test('取消、失焦和丢失捕获各自只结束一次手势，主进程拒绝也不会锁住下一次', async () => {
  const harness = loadPanelResize(), calls = [];
  let failStart = true;
  const mounted = mount(harness, payload => {
    calls.push(payload);
    if (payload.phase === 'start' && failStart) { failStart = false; return Promise.reject(new Error('故障注入')); }
    return { ok: true };
  });
  const grip = mounted.grips.get('nw');
  grip.dispatch('pointerdown', { button: 0, pointerId: 5, screenX: 40, screenY: 60 }); await settle();
  assert.deepEqual(calls.map(call => call.phase), ['start', 'end'], 'start 失败后尽力发送 end');
  grip.dispatch('pointerdown', { button: 0, pointerId: 6, screenX: 50, screenY: 70 }); await settle();
  grip.dispatch('pointercancel', { pointerId: 6, screenX: 49, screenY: 69 }); await settle();
  grip.dispatch('lostpointercapture', { pointerId: 6 }); await settle();
  assert.deepEqual(calls.slice(2).map(call => call.phase), ['start', 'end']);
  grip.dispatch('pointerdown', { button: 0, pointerId: 7, screenX: 60, screenY: 80 }); await settle();
  harness.view.dispatch('blur'); await settle();
  assert.deepEqual(calls.slice(4).map(call => call.phase), ['start', 'end']);
  assert.ok(calls.every(call => call.edge === 'nw'));
  mounted.panelResize.dispose();
});

test('识别 IPC 成功信封内的明确拒绝并结束该手势', async () => {
  const harness = loadPanelResize(), calls = [];
  const mounted = mount(harness, payload => {
    calls.push(payload);
    return payload.phase === 'start' ? { ok: true, value: false } : { ok: true, value: true };
  });
  mounted.grips.get('e').dispatch('pointerdown', { button: 0, pointerId: 8, screenX: 200, screenY: 300 });
  await settle();
  assert.deepEqual(calls.map(call => call.phase), ['start', 'end'], '主进程返回值 false 不应被外层 ok 信封掩盖');
  mounted.panelResize.dispose();
});
