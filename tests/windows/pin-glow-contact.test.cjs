'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { sampleEdges } = require('../../scripts/native-edge-samples.cjs');

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

test('实体光条等宽时，仍能检出左侧两像素和底部一像素的纸面缝隙', () => {
  for (const light of [false, true]) {
    const result = fixture(light, { 左缘: 2, 底缘: 1 });
    assert.equal(result.widthSpread, 0, '等宽不能证明柔光贴合');
    assert.equal(result.glowContact.passed, false);
    assert.deepEqual([...new Set(result.glowContact.samples.filter(sample => !sample.passed).map(sample => sample.edge))].sort(), ['左缘', '底缘'].sort());
  }
});
