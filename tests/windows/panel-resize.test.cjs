'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { panelResizeBounds, validResizePayload } = require('../../src/windows/panel-resize.cjs');

test('八个拉伸方向保持对侧边界，位移始终相对于本次手势起点', () => {
  const start = Object.freeze({ x: -600, y: 100, width: 400, height: 500 });
  for (const edge of ['n','ne','e','se','s','sw','w','nw']) {
    const result = panelResizeBounds(start, edge, 30, 20);
    if (edge.includes('w')) assert.equal(result.x + result.width, start.x + start.width);
    else assert.equal(result.x, start.x);
    if (edge.includes('n')) assert.equal(result.y + result.height, start.y + start.height);
    else assert.equal(result.y, start.y);
    assert.deepEqual(panelResizeBounds(start, edge, 30, 20), result);
  }
  assert.deepEqual(panelResizeBounds(start, 'se', 30, 20), { x: -600, y: 100, width: 430, height: 520 });
});

test('拉伸受原有最小尺寸和持久化上限约束，北西角达到下限时保持对侧位置', () => {
  const start = { x: 100, y: 80, width: 300, height: 483 };
  assert.deepEqual(panelResizeBounds(start, 'nw', 200, 400), { x: 185, y: 303, width: 215, height: 260 });
  assert.deepEqual(panelResizeBounds(start, 'se', 100000, 100000), { x: 100, y: 80, width: 8192, height: 8192 });
  assert.throws(() => panelResizeBounds(start, 'other', 0, 0));
});

test('拉伸请求必须带合法方向、本次手势令牌及有限屏幕坐标', () => {
  const start = { phase: 'start', edge: 'se', token: 'resize-1', x: -200, y: 300 };
  assert.equal(validResizePayload(start), true);
  for (const patch of [{ phase: 'other' }, { edge: 'other' }, { token: '' }, { token: '<任意脚本>' }, { x: Infinity }, { y: '300' }, { x: 100001 }]) {
    assert.equal(validResizePayload({ ...start, ...patch }), false);
  }
});
