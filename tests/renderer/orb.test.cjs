'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Element {
  constructor(tag, ownerDocument) {
    this.tag = tag; this.ownerDocument = ownerDocument; this.children = []; this.parentNode = null;
    this.attrs = {}; this.events = new Map(); this.classes = new Set(); this.captured = new Set();
    this.style = { values: {}, setProperty: (key, value) => { this.style.values[key] = value; }, removeProperty: key => { delete this.style.values[key]; } };
    this.classList = {
      add: name => this.classes.add(name),
      remove: name => this.classes.delete(name),
      contains: name => this.classes.has(name),
      toggle: (name, force) => { const active = force === undefined ? !this.classes.has(name) : !!force; active ? this.classes.add(name) : this.classes.delete(name); return active; },
    };
  }
  set className(value) { this.classes = new Set(String(value).split(/\s+/).filter(Boolean)); }
  get className() { return [...this.classes].join(' '); }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return this.attrs[name] ?? null; }
  addEventListener(name, callback) { const values = this.events.get(name) || []; values.push(callback); this.events.set(name, values); }
  append(...children) { for (const child of children) { child.parentNode = this; this.children.push(child); } }
  replaceChildren(...children) { for (const child of this.children) child.parentNode = null; this.children = []; this.append(...children); }
  removeChild(child) { this.children = this.children.filter(value => value !== child); child.parentNode = null; }
  setPointerCapture(id) { this.captured.add(id); }
  hasPointerCapture(id) { return this.captured.has(id); }
  releasePointerCapture(id) { this.captured.delete(id); }
  dispatch(name, properties = {}) {
    const event = { type: name, preventDefault() { this.defaultPrevented = true; }, ...properties };
    for (const callback of this.events.get(name) || []) callback(event);
    return event;
  }
}

function loadOrb() {
  const doc = { createElement: tag => new Element(tag, doc) };
  const context = { document: doc };
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/orb.js'), 'utf8');
  vm.runInContext(source.replace(/^export /gm, '') + '\nglobalThis.mountOrb=mountOrb;', context);
  return { mountOrb: context.mountOrb, doc };
}

test('悬浮球使用注入的标准品牌标志，点击与右键动作保持独立', () => {
  const { mountOrb, doc } = loadOrb(), root = new Element('div', doc), calls = [];
  const brand = doc.createElement('svg');
  const orb = mountOrb({ root, createBrand: () => brand, onActivate: () => calls.push('activate'), onMenu: () => calls.push('menu') });
  assert.equal(root.children.length, 1);
  assert.equal(orb.element.classList.contains('orb'), true);
  assert.equal(brand.classList.contains('orb-brand'), true);
  assert.equal(orb.element.children[0], brand);
  assert.match(orb.element.getAttribute('aria-label'), /右键打开菜单/);
  orb.element.dispatch('click');
  const contextMenu = orb.element.dispatch('contextmenu');
  assert.equal(contextMenu.defaultPrevented, true);
  assert.deepEqual(calls, ['activate', 'menu']);
  orb.update({ action: 'capture', dimmed: true, reducedMotion: true });
  assert.match(orb.element.title, /截图框选/);
  assert.equal(orb.element.classList.contains('is-dimmed'), true);
  assert.equal(orb.element.classList.contains('is-reduced-motion'), true);
  orb.dispose();
  assert.equal(root.children.length, 0);
});

test('拖动在 5 像素阈值后跟随指针，收尾不误触发左键', async () => {
  const { mountOrb, doc } = loadOrb(), root = new Element('div', doc), dragCalls = [], clicks = [];
  let nextFrame = 1; const frames = new Map(), timers = [];
  const orb = mountOrb({
    root,
    createBrand: () => doc.createElement('svg'),
    onActivate: () => clicks.push('activate'),
    onDrag: payload => dragCalls.push(payload),
    requestFrame: callback => { const id = nextFrame++; frames.set(id, callback); return id; },
    cancelFrame: id => frames.delete(id),
    setTimer: (callback, delay) => { timers.push({ callback, delay }); return timers.length; },
  });
  const button = orb.element;
  button.dispatch('pointerdown', { button: 0, pointerId: 7, screenX: 100, screenY: 100 });
  button.dispatch('pointermove', { pointerId: 7, screenX: 103, screenY: 103 });
  assert.equal(dragCalls.length, 0, '阈值内仍按点击处理');
  button.dispatch('pointermove', { pointerId: 7, screenX: 105, screenY: 100 });
  button.dispatch('pointermove', { pointerId: 7, screenX: 120, screenY: 130 });
  assert.equal(button.classList.contains('is-dragging'), true);
  const frame = frames.values().next().value; frames.clear(); frame();
  button.dispatch('pointerup', { pointerId: 7, screenX: 125, screenY: 135 });
  button.dispatch('click');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(dragCalls)), [
    { phase: 'start', x: 100, y: 100 },
    { phase: 'move', x: 120, y: 130 },
    { phase: 'end', x: 125, y: 135 },
  ]);
  assert.deepEqual(clicks, []);
  assert.equal(timers[0].delay, 0);
  timers[0].callback();
  button.dispatch('click');
  assert.deepEqual(clicks, ['activate']);
  orb.dispose();
});

test('悬停回调、四边展开状态与减少动态效果状态可独立更新', () => {
  const { mountOrb, doc } = loadOrb(), root = new Element('div', doc), hover = [];
  const orb = mountOrb({ root, createBrand: () => doc.createElement('svg'), onHover: active => hover.push(active) });
  orb.element.dispatch('pointerenter');
  orb.update({ collapsed: true, expanded: false, edge: 'top', dimmed: true, reducedMotion: true });
  assert.equal(orb.element.classList.contains('is-collapsed'), true);
  assert.equal(orb.element.classList.contains('edge-top'), true);
  assert.equal(orb.element.classList.contains('edge-left'), false);
  assert.equal(orb.element.classList.contains('is-dimmed'), true);
  assert.equal(orb.element.classList.contains('is-reduced-motion'), true);
  orb.element.dispatch('pointerleave');
  assert.deepEqual(hover, [true, false]);
  orb.dispose();
});
