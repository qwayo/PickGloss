'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { clampWindow, cropPixels, resizePanel, fitWindow, placeMenu, placeSelectionEntry } = require('../../src/windows/geometry.cjs');

test('划词入口居中放在鼠标下方，支持负坐标屏幕并仅在边缘避让', () => {
  const size = { width: 34, height: 34 }, area = { x: -1440, y: -100, width: 1440, height: 900 };
  assert.deepEqual(placeSelectionEntry({ x: -500, y: 100 }, size, area), { x: -517, y: 112, ...size });
  assert.deepEqual(placeSelectionEntry({ x: -1438, y: 100 }, size, area), { x: -1440, y: 112, ...size });
  const bottom = placeSelectionEntry({ x: -5, y: 790 }, size, area);
  assert.equal(bottom.x, -34); assert.equal(bottom.y + bottom.height, 778);
});
test('负坐标显示器的右下角入口保持在工作区内', () => {
  const area = {x:-1920,y:0,width:1920,height:1040};
  const result = clampWindow({x:-5,y:1038},{width:430,height:650},area);
  assert.ok(result.x >= area.x && result.x + result.width <= 0);
  assert.ok(result.y >= 0 && result.y + result.height <= 1040);
});
test('截图以真实图像尺寸映射 150% 缩放，保留框选像素', () => {
  assert.deepEqual(cropPixels({x:100,y:60,width:200,height:100},{width:1280,height:720},{width:1920,height:1080}),{x:150,y:90,width:300,height:150});
});
test('越界与非数值框选被拒绝', () => {
  for (const rect of [{x:-1,y:0,width:20,height:20},{x:0,y:0,width:Infinity,height:20},{x:95,y:10,width:20,height:20}]) assert.throws(()=>cropPixels(rect,{width:100,height:100},{width:150,height:150}));
});

test('右侧展开保留右边缘，收回小窗可逆且不会翻到屏幕中央', () => {
  const area={x:0,y:0,width:1440,height:900}, original={x:1200,y:80,width:215,height:345};
  const expanded=resizePanel(original,{width:860,height:690},area);
  assert.deepEqual(expanded,{x:555,y:80,width:860,height:690});
  assert.deepEqual(resizePanel(expanded,{width:215,height:345},area),original);
});

test('左侧和负坐标显示器保留就近边缘，垂直方向只作最小避让', () => {
  const area={x:-1440,y:-100,width:1440,height:900};
  assert.deepEqual(resizePanel({x:-1400,y:500,width:215,height:300},{width:860,height:690},area),{x:-1400,y:110,width:860,height:690});
  assert.deepEqual(resizePanel({x:-235,y:0,width:215,height:345},{width:860,height:690},area),{x:-880,y:0,width:860,height:690});
});

test('工作区比阅读预设小也不越界，不重新应用鼠标偏移', () => {
  const area={x:0,y:0,width:800,height:600};
  assert.deepEqual(resizePanel({x:40,y:35,width:215,height:345},{width:860,height:690},area),{x:0,y:0,width:800,height:600});
});

test('恢复窗口只作最小避让，保留工作区内部的自由位置', () => {
  const area = { x: -1440, y: -80, width: 1440, height: 900 };
  const original = { x: -1200, y: 110, width: 300, height: 483 };
  assert.deepEqual(fitWindow(original, area), original);
  assert.deepEqual(fitWindow({ x: 5000, y: 3000, width: 300, height: 483 }, area), { x: -300, y: 337, width: 300, height: 483 });
  assert.deepEqual(fitWindow({ x: -4000, y: -2000, width: 2000, height: 1200 }, area), area);
});

test('自定义菜单在入口附近翻向并留在当前工作区，负坐标和小屏幕同样有效', () => {
  const area = { x: -1440, y: -80, width: 1440, height: 900 };
  const top = placeMenu({ x: -1400, y: 0, width: 48, height: 48 }, { width: 272, height: 548 }, area);
  assert.deepEqual(top, { bounds: { x: -1346, y: 0, width: 272, height: 548 }, origin: 'top-left' });
  const bottom = placeMenu({ x: -80, y: 750, width: 48, height: 48 }, { width: 272, height: 548 }, area);
  assert.deepEqual(bottom, { bounds: { x: -358, y: 250, width: 272, height: 548 }, origin: 'bottom-right' });
  const small = placeMenu({ x: 170, y: 130, width: 48, height: 48 }, { width: 272, height: 548 }, { x: 0, y: 0, width: 220, height: 180 });
  assert.deepEqual(small.bounds, { x: 0, y: 0, width: 220, height: 180 });
});
