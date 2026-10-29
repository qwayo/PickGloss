'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createOrbController, QUIET_DELAY_MS, COLLAPSE_DELAY_MS } = require('../../src/windows/orb-controller.cjs');

class FakeClock {
  constructor() { this.now = 0; this.nextId = 1; this.timers = new Map(); }
  setTimeout(callback, delay) {
    const id = this.nextId++;
    this.timers.set(id, { callback, due: this.now + delay });
    return id;
  }
  clearTimeout(id) { this.timers.delete(id); }
  advance(ms) {
    const limit = this.now + ms;
    while (true) {
      const due = [...this.timers.entries()].filter(([, timer]) => timer.due <= limit).sort((a, b) => a[1].due - b[1].due)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.now = due[1].due;
      due[1].callback();
    }
    this.now = limit;
  }
  get pendingCount() { return this.timers.size; }
}

function display(bounds, workArea = bounds, id = 'display') { return { id, bounds: { ...bounds }, workArea: { ...workArea } }; }

function createRig({ bounds = { x: 100, y: 100, width: 48, height: 48 }, displays = [display({ x: 0, y: 0, width: 1000, height: 800 })], minNativeSize = { width: 1, height: 1 } } = {}) {
  const clock = new FakeClock(), positions = [], states = [], nativeWrites = [];
  const win = {
    bounds: { ...bounds },
    getBounds() { return { ...this.bounds }; },
    setBounds(value) { this.bounds = { ...value, width: Math.max(value.width, minNativeSize.width), height: Math.max(value.height, minNativeSize.height) }; nativeWrites.push({ ...this.bounds }); },
    isDestroyed() { return false; },
  };
  const inside = (point, rect) => point.x >= rect.x && point.x < rect.x + rect.width && point.y >= rect.y && point.y < rect.y + rect.height;
  const distanceTo = (point, rect) => {
    const dx = Math.max(rect.x - point.x, 0, point.x - (rect.x + rect.width));
    const dy = Math.max(rect.y - point.y, 0, point.y - (rect.y + rect.height));
    return Math.hypot(dx, dy);
  };
  const screen = {
    getAllDisplays: () => displays,
    getPrimaryDisplay: () => displays[0],
    getDisplayNearestPoint(point) { return displays.find(item => inside(point, item.bounds)) || [...displays].sort((a, b) => distanceTo(point, a.bounds) - distanceTo(point, b.bounds))[0]; },
    getDisplayMatching(rect) {
      const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      return displays.find(item => inside(center, item.bounds)) || this.getDisplayNearestPoint(center);
    },
  };
  const controller = createOrbController({ win, screen, clock, onPosition: value => positions.push({ ...value }), onState: value => states.push({ ...value }) });
  return { controller, win, screen, clock, positions, states, nativeWrites, setDisplays(value) { displays = value; } };
}

test('静默淡化在 15 秒后作用于整球，移入立刻恢复并重新计时', () => {
  const rig = createRig();
  rig.clock.advance(QUIET_DELAY_MS - 1);
  assert.equal(rig.states.at(-1).dimmed, false);
  rig.clock.advance(1);
  assert.equal(rig.states.at(-1).dimmed, true);
  rig.controller.hover(true);
  assert.equal(rig.states.at(-1).dimmed, false);
  rig.clock.advance(QUIET_DELAY_MS * 2);
  assert.equal(rig.states.at(-1).dimmed, false, '悬停期间不应再次淡化');
  rig.controller.hover(false);
  rig.clock.advance(QUIET_DELAY_MS - 1);
  assert.equal(rig.states.at(-1).dimmed, false);
  rig.clock.advance(1);
  assert.equal(rig.states.at(-1).dimmed, true);
  rig.controller.dispose();
});

test('菜单打开期间暂停静默淡化和贴边收回，关闭后恢复计时', () => {
  const rig = createRig();
  rig.controller.drag({ phase: 'start', x: 120, y: 120 });
  rig.controller.drag({ phase: 'move', x: -30, y: 120 });
  rig.controller.drag({ phase: 'end', x: -30, y: 120 });
  rig.clock.advance(COLLAPSE_DELAY_MS);
  assert.equal(rig.states.at(-1).collapsed, true);
  rig.controller.setMenuOpen(true);
  assert.equal(rig.states.at(-1).collapsed, false);
  rig.clock.advance(QUIET_DELAY_MS * 2);
  assert.equal(rig.states.at(-1).dimmed, false);
  rig.controller.setMenuOpen(false);
  rig.controller.hover(false);
  rig.clock.advance(COLLAPSE_DELAY_MS);
  assert.equal(rig.states.at(-1).collapsed, true);
  rig.clock.advance(QUIET_DELAY_MS - COLLAPSE_DELAY_MS);
  assert.equal(rig.states.at(-1).dimmed, true);
  rig.controller.dispose();
});

test('拖动松手在四条边 12 DIP 内贴边收起，保存完整悬浮球位置（含负坐标屏幕）', () => {
  const area = { x: -1600, y: -200, width: 1600, height: 900 };
  const cases = [
    { edge: 'left', start: { x: -480, y: 20 }, end: { x: -1580, y: 200 }, expanded: { x: -1600, y: 180 }, collapsed: { x: -1600, y: 180, width: 12, height: 48 } },
    { edge: 'right', start: { x: -480, y: 20 }, end: { x: -28, y: 160 }, expanded: { x: -48, y: 140 }, collapsed: { x: -12, y: 140, width: 12, height: 48 } },
    { edge: 'top', start: { x: -480, y: 20 }, end: { x: -400, y: -190 }, expanded: { x: -420, y: -200 }, collapsed: { x: -420, y: -200, width: 48, height: 12 } },
    { edge: 'bottom', start: { x: -480, y: 20 }, end: { x: -400, y: 690 }, expanded: { x: -420, y: 652 }, collapsed: { x: -420, y: 688, width: 48, height: 12 } },
  ];
  for (const item of cases) {
    const rig = createRig({ bounds: { x: -500, y: 0, width: 48, height: 48 }, displays: [display(area)] });
    rig.controller.drag({ phase: 'start', ...item.start });
    rig.controller.drag({ phase: 'move', ...item.end });
    rig.controller.drag({ phase: 'end', ...item.end });
    rig.clock.advance(COLLAPSE_DELAY_MS);
    assert.equal(rig.states.at(-1).edge, item.edge, item.edge);
    assert.equal(rig.states.at(-1).collapsed, true, item.edge);
    assert.deepEqual(rig.positions.at(-1), { x: item.expanded.x, y: item.expanded.y }, item.edge);
    assert.deepEqual(rig.win.getBounds(), item.collapsed, item.edge);
    assert.ok(rig.win.getBounds().x >= area.x && rig.win.getBounds().y >= area.y, '边界支持负桌面坐标');
    rig.controller.dispose();
  }
});

test('原生窄窗被放大时仍把四边条入口锚在 workArea 内', () => {
  const area = { x: 0, y: 0, width: 1000, height: 800 };
  const cases = [
    { edge: 'left', end: { x: -30, y: 120 }, expected: { x: 0, y: 100, width: 31, height: 48 } },
    { edge: 'right', end: { x: 972, y: 120 }, expected: { x: 969, y: 100, width: 31, height: 48 } },
    { edge: 'top', end: { x: 120, y: -30 }, expected: { x: 100, y: 0, width: 48, height: 36 } },
    { edge: 'bottom', end: { x: 120, y: 772 }, expected: { x: 100, y: 764, width: 48, height: 36 } },
  ];
  for (const item of cases) {
    const rig = createRig({ displays: [display(area)], minNativeSize: { width: 31, height: 36 } });
    rig.controller.drag({ phase: 'start', x: 120, y: 120 });
    rig.controller.drag({ phase: 'move', ...item.end });
    rig.controller.drag({ phase: 'end', ...item.end });
    rig.clock.advance(COLLAPSE_DELAY_MS);
    assert.equal(rig.states.at(-1).edge, item.edge);
    assert.deepEqual(rig.win.getBounds(), item.expected, item.edge);
    assert.ok(rig.win.getBounds().x >= area.x && rig.win.getBounds().x + rig.win.getBounds().width <= area.x + area.width, `${item.edge} 窗口横向必须留在 workArea`);
    assert.ok(rig.win.getBounds().y >= area.y && rig.win.getBounds().y + rig.win.getBounds().height <= area.y + area.height, `${item.edge} 窗口纵向必须留在 workArea`);
    rig.controller.hover(true);
    assert.equal(rig.win.getBounds().width, 48, `${item.edge} 悬停仍展开`);
    rig.controller.dispose();
  }
});

test('离边超过阈值时保持自由悬浮；关闭贴边收起会恢复展开尺寸', () => {
  const rig = createRig();
  rig.controller.drag({ phase: 'start', x: 120, y: 120 });
  rig.controller.drag({ phase: 'move', x: 300, y: 300 });
  rig.controller.drag({ phase: 'end', x: 300, y: 300 });
  assert.equal(rig.states.at(-1).collapsed, false);
  assert.equal(rig.states.at(-1).edge, null);
  assert.deepEqual(rig.win.getBounds(), { x: 280, y: 280, width: 48, height: 48 });

  rig.controller.configure({ edgeCollapseEnabled: false });
  rig.controller.drag({ phase: 'start', x: 300, y: 300 });
  rig.controller.drag({ phase: 'move', x: 30, y: 30 });
  rig.controller.drag({ phase: 'end', x: 30, y: 30 });
  assert.equal(rig.states.at(-1).edge, null);
  assert.equal(rig.states.at(-1).collapsed, false);
  assert.equal(rig.win.getBounds().width, 48);
  assert.equal(rig.positions.at(-1).x, 10);
  rig.controller.dispose();
});

test('收起条悬停立即展开，移出 1 秒收回；拖离边缘后不再吸附', () => {
  const rig = createRig();
  rig.controller.drag({ phase: 'start', x: 120, y: 120 });
  rig.controller.drag({ phase: 'move', x: -30, y: 120 });
  rig.controller.drag({ phase: 'end', x: -30, y: 120 });
  rig.clock.advance(COLLAPSE_DELAY_MS);
  assert.equal(rig.states.at(-1).collapsed, true);
  rig.controller.hover(true);
  assert.equal(rig.win.getBounds().width, 48);
  assert.equal(rig.states.at(-1).expanded, true);
  rig.controller.hover(false);
  rig.clock.advance(COLLAPSE_DELAY_MS - 1);
  assert.equal(rig.states.at(-1).collapsed, false);
  rig.controller.drag({ phase: 'start', x: 5, y: 120 });
  rig.controller.drag({ phase: 'move', x: 205, y: 220 });
  rig.controller.drag({ phase: 'end', x: 205, y: 220 });
  rig.clock.advance(COLLAPSE_DELAY_MS * 2);
  assert.equal(rig.states.at(-1).collapsed, false);
  assert.equal(rig.states.at(-1).edge, null);
  assert.deepEqual(rig.win.getBounds(), { x: 200, y: 200, width: 48, height: 48 });
  rig.controller.dispose();
});

test('静默淡化开关关闭时不淡化；减少动态效果随状态下发', () => {
  const rig = createRig();
  rig.controller.configure({ quietFadeEnabled: false, reducedMotion: true });
  rig.clock.advance(QUIET_DELAY_MS * 2);
  assert.equal(rig.states.at(-1).dimmed, false);
  assert.equal(rig.states.at(-1).reducedMotion, true);
  assert.equal(rig.clock.pendingCount, 0);
  rig.controller.configure({ quietFadeEnabled: true });
  rig.clock.advance(QUIET_DELAY_MS);
  assert.equal(rig.states.at(-1).dimmed, true);
  rig.controller.dispose();
});

test('刷新屏幕布局后可回到现有显示器，并只持久化完整位置', () => {
  const rig = createRig({
    bounds: { x: -1600, y: 10, width: 48, height: 48 },
    displays: [display({ x: -1600, y: 0, width: 1600, height: 900 }, undefined, 'old')],
  });
  rig.controller.drag({ phase: 'start', x: -1580, y: 30 });
  rig.controller.drag({ phase: 'move', x: -1740, y: 30 });
  rig.controller.drag({ phase: 'end', x: -1740, y: 30 });
  rig.clock.advance(COLLAPSE_DELAY_MS);
  assert.equal(rig.win.getBounds().width, 12);
  rig.setDisplays([display({ x: 0, y: 0, width: 1200, height: 700 }, undefined, 'new')]);
  rig.controller.refresh();
  rig.clock.advance(COLLAPSE_DELAY_MS);
  assert.ok(rig.win.getBounds().x >= 0 && rig.win.getBounds().x + rig.win.getBounds().width <= 1200);
  assert.ok(rig.win.getBounds().y >= 0 && rig.win.getBounds().y + rig.win.getBounds().height <= 700);
  assert.deepEqual(rig.positions.at(-1), { x: 0, y: 10 });
  assert.equal(rig.win.getBounds().width, 12, '显示器恢复后仍可按新边缘收起');
  rig.controller.dispose();
});

test('dispose 清理淡化与收回计时，后续屏幕和鼠标回调不再改窗口', () => {
  const rig = createRig();
  rig.controller.hover(true);
  rig.controller.hover(false);
  assert.ok(rig.clock.pendingCount > 0);
  const writes = rig.nativeWrites.length, states = rig.states.length;
  rig.controller.dispose();
  assert.equal(rig.clock.pendingCount, 0);
  rig.clock.advance(QUIET_DELAY_MS + COLLAPSE_DELAY_MS);
  rig.controller.hover(true); rig.controller.refresh();
  assert.equal(rig.nativeWrites.length, writes);
  assert.equal(rig.states.length, states);
});
