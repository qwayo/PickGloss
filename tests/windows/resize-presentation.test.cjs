'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { findLayoutCommitPaint, selectAnswerTitleInk } = require('../../scripts/resize-presentation-analysis.cjs');
const frame = (at, width, pixelReading) => ({ at, size: { width }, pixelReading });
const transition = { commitAt: 2786, motionEnd: 2770, targetWidth: 860, fromReading: false, toReading: true };

test('绘制延迟时按实际终态排版定位提交，不能豁免时间更近的旧排版帧', () => {
  const frames = [frame(2774, 842, false), frame(2793, 858, false), frame(2798, 860, true)];
  const result = findLayoutCommitPaint(frames, transition);
  assert.equal(result.index, 2);
  assert.equal(result.distance, 7);
});

test('中途提前切换或窗口尚未到位的排版仍由连续性检查检出', () => {
  const frames = [frame(2730, 800, false), frame(2740, 820, true), frame(2774, 842, false), frame(2798, 860, true)];
  assert.equal(findLayoutCommitPaint(frames, transition).index, 3, '只能豁免终态提交，不能豁免中途跳变');
  assert.equal(findLayoutCommitPaint(frames.slice(0, 3), transition), null);
  assert.equal(findLayoutCommitPaint([frame(2750, 858, false), frame(2760, 860, true)], transition), null);
});

test('无可确认的排版变化时不豁免任何像素跳变', () => {
  assert.equal(findLayoutCommitPaint([frame(2774, 858, false), frame(2793, 860, false)], transition), null);
  assert.equal(findLayoutCommitPaint([frame(2774, 858, null), frame(2793, 860, true)], transition), null);
});

test('磨砂窗口收窄裁短回答时，继续跟踪标题而非改选左栏标签', () => {
  const columns = new Uint16Array(302);
  columns[23] = 98; columns[254] = 24; columns[274] = 75;
  const ink = selectAnswerTitleInk(columns);
  assert.equal(ink.minX, 274);
  assert.equal(ink.count, 75);
  assert.equal(ink.wholeBand.minX, 23, '原始取样仍须保留标签证据');
  columns.fill(0); columns[19] = 21; columns[39] = 272;
  assert.equal(selectAnswerTitleInk(columns).minX, 39, '真正回到小窗时识别左侧回答');
});
