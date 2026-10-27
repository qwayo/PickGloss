'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const DEFAULT = { mode: 'dark', material: 'solid', accent: '#000000', tint: '#bfc2c8', opacity: 82, blur: 26 };

class Element {
  constructor(tag) {
    this.tag = tag; this.children = []; this.parentNode = null; this.dataset = {}; this.attrs = {}; this.events = {};
    this.style = { properties: {}, setProperty: (key, value) => { this.style.properties[key] = value; } };
    this.classList = { toggle: (name, active) => { this.classes ||= new Set(); active ? this.classes.add(name) : this.classes.delete(name); } };
    this.disabled = false; this.hidden = false; this.value = ''; this.textContent = ''; this.checked = false;
  }
  append(...items) { for (const item of items) { if (item && typeof item === 'object') item.parentNode = this; this.children.push(item); } }
  prepend(...items) { for (const item of items) if (item && typeof item === 'object') item.parentNode = this; this.children.unshift(...items); }
  replaceChildren(...items) { this.children.forEach(child => { if (child?.parentNode === this) child.parentNode = null; }); this.children = []; this.append(...items); }
  addEventListener(name, callback) { (this.events[name] ||= []).push(callback); }
  removeEventListener(name, callback) { this.events[name] = (this.events[name] || []).filter(item => item !== callback); }
  dispatch(name, properties = {}) { for (const callback of this.events[name] || []) callback({ preventDefault() {}, ...properties }); }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return this.attrs[name]; }
  focus() { this.focused = true; }
  click() { if (!this.disabled) this.dispatch('click'); }
  remove() { if (!this.parentNode) return; this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; }
  contains(target) { return this === target || this.children.some(child => child?.contains?.(target)); }
  querySelectorAll(selector) {
    const result = [];
    const visit = node => { for (const child of node.children || []) { if (selector === 'button' && child?.tag === 'button') result.push(child); visit(child); } };
    visit(this); return result;
  }
  getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 100 }; }
  setPointerCapture() {}
  hasPointerCapture() { return false; }
  releasePointerCapture() {}
}

const listen = map => (name, callback) => { const entries = map.get(name) || []; entries.push(callback); map.set(name, entries); };
const unlisten = map => (name, callback) => map.set(name, (map.get(name) || []).filter(item => item !== callback));
const media = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

function page({ appearance, save, refresh = () => {}, onReducedMotion = () => {} } = {}) {
  const documentEvents = new Map(), windowEvents = new Map(), writes = [];
  const documentElement = new Element('html'); documentElement.dataset = {};
  const document = {
    hidden: false, documentElement,
    createElement: tag => new Element(tag), createElementNS: (_ns, tag) => new Element(tag),
    addEventListener: listen(documentEvents), removeEventListener: unlisten(documentEvents),
  };
  const window = {
    matchMedia: media, crypto: { randomUUID: () => 'preset-new' },
    addEventListener: listen(windowEvents), removeEventListener: unlisten(windowEvents),
  };
  const context = { document, window, setTimeout, clearTimeout, console };
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/appearance.js'), 'utf8');
  vm.runInContext(source.replace(/^export /gm, '') + '\nglobalThis.createAppearanceUI=createAppearanceUI;', context);
  let ui;
  const saveFn = save || (async snapshot => ({ ok: true, value: { prefs: { appearance: structuredClone(snapshot) } } }));
  const wrappedSave = async snapshot => { if (!save) writes.push(structuredClone(snapshot)); return saveFn(snapshot); };
  const container = new Element('main');
  ui = context.createAppearanceUI({ save: wrappedSave, refresh: () => refresh(ui), onReducedMotion });
  ui.receive(appearance || { current: DEFAULT, active: 'default', presets: [], reducedMotion: false, pinOutline: 'orange' }, {});
  ui.mount(container);
  const find = (predicate, node = container) => {
    if (predicate(node)) return node;
    for (const child of node.children || []) { const found = child && find(predicate, child); if (found) return found; }
  };
  const field = name => find(node => node.dataset?.field === `appearance-${name}`);
  return { ui, writes, container, document, window, documentEvents, windowEvents, field, find };
}

async function until(predicate, message = '异步保存应在有限时间内完成') {
  for (let i = 0; i < 100 && !predicate(); i += 1) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(predicate(), message);
}

test('减少动态效果的状态回声不重复通知宿主，避免在尺寸提交前覆盖阅读锚点', () => {
  let notified = 0;
  const appearance = { current: DEFAULT, active: 'default', presets: [], reducedMotion: false, pinOutline: 'orange' };
  const editor = page({ appearance, onReducedMotion: () => { notified++; } });
  editor.ui.receive(appearance, { reducedMotion: true });
  assert.equal(notified, 1);
  editor.ui.receive(appearance, { reducedMotion: true, windowTransitioning: true });
  editor.ui.receive(appearance, { reducedMotion: true, windowTransitioning: false });
  assert.equal(notified, 1, '同一减少动态效果状态的回声不能清除宿主已经捕获的阅读锚点');
  editor.ui.receive(appearance, { reducedMotion: false });
  editor.ui.receive(appearance, { reducedMotion: true });
  assert.equal(notified, 2, '再次进入减少动态效果仍应停止当前动画');
  editor.ui.dispose();
});

test('没有待保存更改时，失焦和离页 flush 不重绘或再次进入保存', async () => {
  let refreshed = 0;
  const editor = page({ refresh: () => { refreshed++; } });
  await editor.ui.flush();
  editor.field('opacity').dispatch('blur');
  await editor.ui.flush();
  assert.equal(editor.writes.length, 0);
  assert.equal(refreshed, 0, '空 flush 不能触发重绘，否则焦点恢复会再次触发失焦保存');
  editor.field('opacity').value = '90'; editor.field('opacity').dispatch('input');
  await editor.ui.flush();
  assert.equal(refreshed, 1, '真实修改完成后仍通知宿主读回');
  editor.field('opacity').dispatch('blur');
  await editor.ui.flush();
  assert.equal(refreshed, 1, '已保存后失焦也不重绘');
  editor.ui.dispose();
});

test('颜色即时预览并自动更新活动新增预设，保存后读回主进程快照', async () => {
  const stored = { current: { ...DEFAULT, accent: '#123456' }, active: 'preset-1', presets: [{ id: 'preset-1', name: '海雾', values: { ...DEFAULT, accent: '#123456' } }], reducedMotion: false, pinOutline: 'orange' };
  const saved = [];
  const editor = page({ appearance: structuredClone(stored), save: async snapshot => {
    saved.push(structuredClone(snapshot));
    Object.assign(stored, structuredClone(snapshot));
    return { ok: true, value: { prefs: { appearance: structuredClone(stored) } } };
  }, refresh: ui => ui.receive(structuredClone(stored), {}) });
  const hex = editor.field('accent-hex'); hex.value = '#a1b2c3'; hex.dispatch('input');
  assert.equal(editor.document.documentElement.style.properties['--accent'], '#a1b2c3', '有效颜色先于保存回执立即预览');
  await editor.ui.flush();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].current.accent, '#a1b2c3');
  assert.equal(stored.current.accent, '#a1b2c3');
  assert.equal(stored.presets[0].values.accent, '#a1b2c3', '编辑活动新增预设时同步 values');
  assert.equal(editor.field('accent-hex').value, '#a1b2c3', 'refresh 读回不会覆盖或丢失已提交输入');
  editor.ui.dispose();
});

test('保存期间连续编辑会串行保存最新快照', async () => {
  const writes = [], resolves = []; let active = 0, maxActive = 0;
  const editor = page({ save: snapshot => {
    writes.push(structuredClone(snapshot)); active += 1; maxActive = Math.max(maxActive, active);
    return new Promise(resolve => resolves.push(result => { active -= 1; resolve(result); }));
  } });
  const opacity = editor.field('opacity'); opacity.value = '89'; opacity.dispatch('input');
  const saving = editor.ui.flush(); await until(() => writes.length === 1);
  opacity.value = '93'; opacity.dispatch('input');
  editor.field('blur').value = '31'; editor.field('blur').dispatch('input');
  resolves[0]({ ok: true });
  await until(() => writes.length === 2);
  assert.equal(writes[1].current.opacity, 93);
  assert.equal(writes[1].current.blur, 31);
  resolves[1]({ ok: true });
  assert.equal((await saving).ok, true);
  assert.equal(maxActive, 1, '不会并行写入过时快照');
  editor.ui.dispose();
});

test('写入失败保留输入并可显式重试', async () => {
  let attempts = 0;
  const editor = page({ save: async snapshot => {
    attempts += 1;
    return attempts === 1 ? { ok: false, error: '磁盘暂不可用' } : { ok: true, value: { appearance: snapshot } };
  } });
  const blur = editor.field('blur'); blur.value = '37'; blur.dispatch('input');
  assert.equal((await editor.ui.flush()).ok, false);
  assert.equal(Number(blur.value), 37);
  assert.match(editor.find(node => node.className === 'appearance-notice').textContent, /输入已保留/);
  editor.find(node => node.className === 'appearance-retry').click();
  assert.equal((await editor.ui.flush()).ok, true);
  assert.equal(attempts, 2);
  assert.equal(Number(blur.value), 37);
  editor.ui.dispose();
});

test('非法十六进制不会写盘，修正后有效值自动保存', async () => {
  const editor = page();
  const hex = editor.field('accent-hex'); hex.value = '#12zzzz'; hex.dispatch('input');
  assert.equal((await editor.ui.flush()).ok, false);
  assert.equal(editor.writes.length, 0);
  assert.equal(hex.attrs['aria-invalid'], 'true');
  hex.value = '#abcdef'; hex.dispatch('input');
  assert.equal((await editor.ui.flush()).ok, true);
  assert.equal(editor.writes.length, 1);
  assert.equal(editor.writes[0].current.accent, '#abcdef');
  editor.ui.dispose();
});

test('明暗模式、材质、置顶描边和减少动态效果也自动保存', async () => {
  const editor = page();
  editor.find(node => node.dataset?.mode === 'light').click();
  editor.find(node => node.dataset?.material === 'glass').click();
  editor.find(node => node.dataset?.pinOutline === 'silver').click();
  const motion = editor.field('reduced-motion'); motion.checked = true; motion.dispatch('change');
  assert.equal((await editor.ui.flush()).ok, true);
  const latest = editor.writes.at(-1);
  assert.equal(latest.current.mode, 'light');
  assert.equal(latest.current.material, 'glass');
  assert.equal(latest.pinOutline, 'silver');
  assert.equal(latest.reducedMotion, true);
  editor.ui.dispose();
});

test('默认配色不被写入预设，删除活动预设保留当前颜色', async () => {
  const first = page();
  const defaultButton = first.find(node => node.dataset?.preset === 'default'); defaultButton.click();
  const tint = first.field('tint-hex'); tint.value = '#102030'; tint.dispatch('input');
  await first.ui.flush();
  assert.equal(first.writes.at(-1).presets.length, 0);
  assert.equal(first.writes.at(-1).active, 'default');
  assert.equal(first.writes.at(-1).current.tint, '#102030');
  first.ui.dispose();

  const initial = { current: { ...DEFAULT, accent: '#234567' }, active: 'p1', presets: [{ id: 'p1', name: '夜色', values: { ...DEFAULT, accent: '#234567' } }], reducedMotion: false, pinOutline: 'orange' };
  const second = page({ appearance: initial });
  const manage = second.find(node => node.className === 'appearance-compact-icon' && node.attrs['aria-label'] === '多选删除配色');
  manage.click();
  assert.equal(second.find(node => node.dataset?.preset === 'default').disabled, true);
  second.find(node => node.dataset?.preset === 'p1').click();
  second.find(node => node.className === 'appearance-compact-icon is-danger').click();
  second.find(node => node.tag === 'button' && node.textContent === '确认删除').click();
  await second.ui.flush();
  assert.equal(second.writes.at(-1).presets.length, 0);
  assert.equal(second.writes.at(-1).active, 'default');
  assert.equal(second.writes.at(-1).current.accent, '#234567');
  second.ui.dispose();
});

test('删除保存失败时预设仍可见，取消后重试不会误删', async () => {
  const initial = { current: { ...DEFAULT, accent: '#234567' }, active: 'p1', presets: [{ id: 'p1', name: '夜色', values: { ...DEFAULT, accent: '#234567' } }], reducedMotion: false, pinOutline: 'orange' };
  let attempts = 0; const snapshots = [];
  const editor = page({ appearance: initial, save: async snapshot => {
    snapshots.push(structuredClone(snapshot));
    attempts += 1;
    return attempts === 1 ? { ok: false, error: '写入失败' } : { ok: true, value: { appearance: snapshot } };
  } });
  editor.find(node => node.className === 'appearance-compact-icon' && node.attrs['aria-label'] === '多选删除配色').click();
  editor.find(node => node.dataset?.preset === 'p1').click();
  editor.find(node => node.className === 'appearance-compact-icon is-danger').click();
  editor.find(node => node.tag === 'button' && node.textContent === '确认删除').click();
  assert.equal((await editor.ui.flush()).ok, false);
  assert.ok(editor.find(node => node.dataset?.preset === 'p1'), '失败时保留原预设与选择界面');
  editor.find(node => node.tag === 'button' && node.textContent === '取消').click();
  assert.equal((await editor.ui.flush()).ok, true);
  assert.equal(snapshots[1].presets.length, 1, '取消后重新写入的快照仍包含原预设');
  editor.ui.dispose();
});

test('新预设名称只是草稿，点击“添加预设”后才创建资源', async () => {
  const editor = page();
  const name = editor.field('name'); name.value = '雨夜银灰'; name.dispatch('input');
  assert.equal(editor.writes.length, 0, '输入名称不会逐字符创建预设或触发写入');
  const actions = editor.container.querySelectorAll('button');
  assert.equal(actions.some(button => !button.hidden && /保存设置|保存快捷键|撤销|更新当前/.test(button.textContent)), false);
  editor.find(node => node.className === 'appearance-primary').click();
  await editor.ui.flush();
  assert.equal(editor.writes.at(-1).presets.length, 1);
  assert.equal(editor.writes.at(-1).presets[0].name, '雨夜银灰');
  assert.equal(name.value, '');
  editor.ui.dispose();
});

test('防抖到期自动写入，dispose 前的 flush 会提交未完成更改并清理生命周期监听', async () => {
  const editor = page();
  const blur = editor.field('blur'); blur.value = '35'; blur.dispatch('input');
  await until(() => editor.writes.length === 1, '防抖计时器应自动触发写入');
  blur.value = '36'; blur.dispatch('input');
  editor.ui.dispose();
  await until(() => editor.writes.length === 2, 'dispose 会立即 flush 尚未开始的最新快照');
  assert.equal(editor.writes[1].current.blur, 36);
  assert.equal((editor.documentEvents.get('visibilitychange') || []).length, 0);
  assert.equal((editor.windowEvents.get('pagehide') || []).length, 0);
  assert.equal((editor.windowEvents.get('beforeunload') || []).length, 0);
});
