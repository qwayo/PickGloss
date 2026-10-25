'use strict';
// 采样硬边内侧，避开 DWM 抗锯齿最外沿、窗外阴影及窗内柔光区域。
function sampleEdges({ width, height, pixel, scale, pinned, client = { left: 0, top: 0, width, height } }) {
  const distance = (a, b) => Math.max(...a.map((value, i) => Math.abs(value - b[i])));
  if (!pinned) {
    const inset = Math.max(4, Math.round(2 * scale));
    const offsets = [...new Set([Math.max(1, Math.round(.4 * scale)), Math.max(1, Math.round(.8 * scale))])];
    const samples = [];
    for (const fraction of [.3, .5, .7]) for (const offset of offsets) {
      const x = client.left + Math.floor(client.width * fraction), y = client.top + Math.floor(client.height * fraction);
      const bottom = client.top + client.height - 1;
      for (const [edge, actual, reference] of [
        ['左缘', pixel(client.left + offset, y), pixel(client.left + inset, y)],
        ['底缘', pixel(x, bottom - offset), pixel(x, bottom - inset)],
      ]) samples.push({ edge, fraction, offset, actual, reference, delta: distance(actual, reference) });
    }
    return { passed: samples.every(sample => sample.delta <= 6), method: '从实际客户区边界向内采样左侧与底部，排除独立的系统边色；短距离最大通道差不超过 6', samples };
  }
  const radius = 8 * scale, corners = [];
  for (const [flipX, flipY] of [[false, false], [true, false], [false, true], [true, true]]) {
    const samples = [];
    for (let y = 0; y < Math.ceil(radius); y++) for (let x = 0; x < Math.ceil(radius); x++) {
      const r = Math.hypot(radius - (x + .5), radius - (y + .5));
      if (r < radius - 2 * scale || r > radius - .8 * scale) continue;
      const px = flipX ? width - 1 - x : x, py = flipY ? height - 1 - y : y;
      const rgb = pixel(px, py);
      samples.push({ x: px, y: py, rgb, dark: rgb[0] < 200 });
    }
    corners.push({ corner: `${flipY ? '下' : '上'}${flipX ? '右' : '左'}`, count: samples.length, dark: samples.filter(sample => sample.dark).length, samples });
  }
  return { passed: corners.every(corner => corner.count > 0 && corner.dark === 0), method: '默认暖橙硬光条环带：8 DIP 半径，内缩 0.8～2 DIP；红通道至少 200，四角均不得出现暗纹', corners };
}
module.exports = { sampleEdges };
