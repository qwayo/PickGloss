'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { translationLayout } = require('../../src/windows/translation-layout.cjs');

test('多屏负坐标与小选区保持原位，控制区避让屏幕边界', () => {
  const displayBounds = { x: -1536, y: -100, width: 1536, height: 864 };
  for (const region of [{ x: -1500, y: -80, width: 75.6, height: 34.4 }, { x: -300, y: 650, width: 180, height: 80 }, { x: -1536, y: -100, width: 1536, height: 864 }]) {
    for (const mode of ['overlay', 'compare']) {
      const layout = translationLayout({ region, displayBounds }, mode);
      assert.equal(layout.bounds.x + layout.image.left, region.x);
      assert.equal(layout.bounds.y + layout.image.top, region.y);
      assert.equal(layout.image.width, region.width);
      assert.ok(layout.bounds.x >= displayBounds.x && layout.bounds.y >= displayBounds.y);
      assert.ok(layout.bounds.x + layout.bounds.width <= 0 && layout.bounds.y + layout.bounds.height <= 764);
    }
  }
});

test('对照控制窗按原文译文测量高度收缩、增长并限制在合理上限', () => {
  const placement = { region: { x: 30, y: 40, width: 20, height: 20 }, displayBounds: { x: 0, y: 0, width: 900, height: 700 } };
  const short = translationLayout(placement, 'compare', { contentHeight: 184 });
  const long = translationLayout(placement, 'compare', { contentHeight: 900 });
  assert.equal(short.controlBounds.height, 184, '短文应按自然内容高度收缩');
  assert.equal(long.controlBounds.height, 480, '长文增长后受 480 CSS 像素上限约束');
  const smallDisplay = translationLayout({ ...placement, displayBounds: { ...placement.displayBounds, height: 220 } }, 'compare', { contentHeight: 480 });
  assert.equal(smallDisplay.controlBounds.height, 220, '屏幕不足时窗口不得超过显示器高度');
  const taskbarArea = { x: 0, y: 0, width: 900, height: 210 };
  const workAreaLimited = translationLayout(placement, 'compare', { contentHeight: 480, workArea: taskbarArea });
  assert.equal(workAreaLimited.controlBounds.height, 210, '初次创建也按当前工作区限高');
  assert.ok(workAreaLimited.controlBounds.y + workAreaLimited.controlBounds.height <= taskbarArea.height, '控制窗避开工作区底部');
  assert.equal(workAreaLimited.bounds.height, placement.region.height, '工作区限高不改变原位截图覆盖尺寸');
});
