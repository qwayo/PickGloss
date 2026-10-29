'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { sampleCornerFootprint, sampleEdges } = require('../../scripts/native-edge-samples.cjs');

// 取自 250% 实屏直边剖面：实体色带始终等宽，柔光与色带之间的纸面像素单独构成缺陷。
function fixture(light, gaps = {}, rendererColor) {
  const base = light ? [255, 255, 255] : [37, 37, 37];
  const glow = light ? [[243,215,190],[243,218,197],[245,224,204],[247,227,208],[248,230,214],[248,234,220],[250,236,226],[250,240,230],[250,242,234],[252,244,238]]
    : [[97,69,44],[91,66,45],[85,64,44],[81,61,42],[75,57,41],[69,55,41],[65,51,41],[60,50,40],[56,48,40],[54,46,40]];
  return sampleEdges({ width: 100, height: 120, scale: 2.5, pinned: true, pixel(x, y) {
    const [edge, depth] = [['左缘', x], ['右缘', 99 - x], ['上缘', y], ['底缘', 119 - y]].sort((a, b) => a[1] - b[1])[0];
    if (depth < 8) return depth < 3 || !rendererColor ? [220, 135, 61] : rendererColor;
    const offset = depth - 8 - (gaps[edge] || 0);
    return offset < 0 ? base : glow[Math.min(offset, glow.length - 1)];
  } });
}

test('明暗色内发光紧接实体光条后衰减时通过贴合检查', () => {
  for (const light of [false, true]) assert.equal(fixture(light).glowContact.passed, true);
});

test('原生与页面实体橙色略有差异时仍按完整色带定位柔光起点', () => {
  for (const light of [false, true]) {
    const result = fixture(light, {}, [208, 139, 76]);
    assert.ok(result.straightEdges.every(edge => edge.width === 8));
    assert.equal(result.glowContact.passed, true);
    assert.equal(fixture(light, { 左缘: 2, 底缘: 1 }, [208, 139, 76]).glowContact.passed, false);
  }
});

test('边框归零后的 2 DIP 叠画仍不能冒充 3 DIP 实体光条', () => {
  const width = 200, height = 240, scale = 2.5, radius = 14 * scale, band = 5;
  const stroke = [208, 139, 76], base = [50, 40, 47], background = [122, 52, 96];
  const glow = [[180,122,71],[150,105,65],[120,88,59],[90,72,53],[65,55,45],[50,43,40],[50,40,47]];
  const result = sampleEdges({ width, height, scale, pinned: true, cornerRadiusDip: 14, cornerBackground: background, pixel(x, y) {
    const nearX = Math.min(x + .5, width - .5 - x), nearY = Math.min(y + .5, height - .5 - y);
    const edgeDistance = Math.hypot(Math.max(0, radius - nearX), Math.max(0, radius - nearY));
    if (edgeDistance > radius) return background;
    const depth = radius - edgeDistance;
    if (depth <= band) return stroke;
    if (depth <= band + glow.length) return glow[Math.min(Math.floor(depth - band), glow.length - 1)];
    return base;
  } });
  assert.equal(result.expectedBandWidth, 8, '250% 缩放下 3 DIP 原生带应量得 8 个物理像素');
  assert.ok(result.straightEdges.every(edge => edge.width === band), '控制样本保留连续的 5 像素细描边');
  assert.equal(result.glowContact.passed, true, '该细带与内光接触，失败只能来自描边不足 3 DIP');
  assert.equal(result.corners.every(corner => corner.dark === 0), true, '控制样本的外圆角描边连续');
  assert.equal(result.cornerFootprint.passed, true, '控制样本仍保留 14 DIP 外圆角');
  assert.equal(result.passed, false, '即使接触、圆角和背景均正确，5 像素实体带仍必须失败');
});

test('实体光条等宽时，仍能检出左侧两像素和底部一像素的纸面缝隙', () => {
  for (const light of [false, true]) {
    const result = fixture(light, { 左缘: 2, 底缘: 1 });
    assert.equal(result.widthSpread, 0, '等宽不能证明柔光贴合');
    assert.equal(result.glowContact.passed, false);
    assert.deepEqual([...new Set(result.glowContact.samples.filter(sample => !sample.passed).map(sample => sample.edge))].sort(), ['左缘', '底缘'].sort());
  }
});

test('实屏采样点能区分 8 与 14 DIP 的外圆角，并验证外角露出自有背景', () => {
  const width = 200, height = 240, scale = 2.5, background = [122, 52, 96];
  const footprint = radiusDip => sampleCornerFootprint({ width, height, scale, radiusDip, background, pixel(x, y) {
    const nearestX = x < width / 2 ? x : width - 1 - x;
    const nearestY = y < height / 2 ? y : height - 1 - y;
    return Math.hypot(radiusDip * scale - (nearestX + .5), radiusDip * scale - (nearestY + .5)) < radiusDip * scale ? [37, 37, 37] : background;
  } });
  assert.equal(footprint(8).passed, false, '系统默认圆角在 3.5 DIP 对角点仍露出窗口表面');
  const rounded = footprint(14);
  assert.equal(rounded.passed, true, '目标 14 DIP 圆角在四个取样点露出测试背景');
  assert.deepEqual(rounded.samples.map(sample => sample.corner), ['左上', '右上', '左下', '右下']);
});

test('磨砂外沿通道色差超过 2 时单独检出透明描边带', () => {
  const sample = maxOuterDelta => sampleEdges({ width: 100, height: 120, scale: 2.5, pinned: false, nativeBorder: { suppressed: true }, maxOuterDelta,
    client: { left: 0, top: 0, width: 100, height: 120 }, pixel(x, y) {
      const depth = Math.min(x, 99 - x, y, 119 - y);
      if (depth === 1) return [51, 41, 48];
      if (depth >= 4) return [56, 46, 52];
      return [52, 42, 49];
    } });
  assert.equal(sample(8).outerBand.passed, true, '旧阈值容许未着色的边带通过');
  const fixed = sample(2);
  assert.equal(fixed.outerBand.passed, false, '磨砂路径把边带差限制在两个通道值');
  assert.equal(fixed.outerBand.maxDelta, 5);
});

test('14 DIP 固定描边的圆弧接受实测橙色抗锯齿并拒绝纸面缝隙', () => {
  const width = 100, height = 120, scale = 2.5, stroke = [208, 139, 76], antialias = [180, 122, 71], base = [50, 40, 47];
  const sample = withGap => sampleEdges({ width, height, scale, pinned: true, cornerRadiusDip: 14, pixel(x, y) {
    const corners = [[x, y], [width - 1 - x, y], [x, height - 1 - y], [width - 1 - x, height - 1 - y]];
    const atArc = corners.some(([cx, cy]) => {
      const radius = 14 * scale, distanceFromCenter = Math.hypot(radius - (cx + .5), radius - (cy + .5));
      return distanceFromCenter >= radius - 2 * scale && distanceFromCenter <= radius - .8 * scale;
    });
    if (atArc) return withGap ? base : antialias;
    const depth = Math.min(x, width - 1 - x, y, height - 1 - y);
    return depth < 7 ? stroke : base;
  } });
  const clean = sample(false);
  assert.equal(clean.corners.every(corner => corner.dark === 0), true, '实测边色与圆弧抗锯齿混色仍能识别为连续描边');
  const gap = sample(true);
  assert.ok(gap.corners.some(corner => corner.dark > 0), '圆弧处回到纸面色仍会被检出');
});
