'use strict';
// 从 DWM 可见边界采样，包含独立系统边色；只跳过圆角和窗外阴影。
function sampleEdges({ width, height, pixel, scale, pinned, nativeBorder, client = { left: 0, top: 0, width, height } }) {
  const distance = (a, b) => Math.max(...a.map((value, i) => Math.abs(value - b[i])));
  const points = (fraction, depth, bounds = { left: 0, top: 0, width, height }) => [
    ['左缘', bounds.left + depth, bounds.top + Math.floor(bounds.height * fraction)],
    ['右缘', bounds.left + bounds.width - 1 - depth, bounds.top + Math.floor(bounds.height * fraction)],
    ['上缘', bounds.left + Math.floor(bounds.width * fraction), bounds.top + depth],
    ['底缘', bounds.left + Math.floor(bounds.width * fraction), bounds.top + bounds.height - 1 - depth],
  ];
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
    const outerSamples = [], referenceDepth = Math.max(4, Math.round(2.4 * scale));
    // NONE 会留下透明非客户区；原生助手确认设置 NONE 后，表面从客户区开始。
    const visible = nativeBorder?.suppressed === true ? client : undefined;
    for (const fraction of [.3, .5, .7]) {
      const references = points(fraction, referenceDepth, visible);
      for (const [index, [edge, x, y]] of points(fraction, 1, visible).entries()) {
        const [, rx, ry] = references[index], actual = pixel(x, y), reference = pixel(rx, ry);
        outerSamples.push({ edge, fraction, actual, reference, delta: distance(actual, reference) });
      }
    }
    return { passed: samples.every(sample => sample.delta <= 6) && outerSamples.every(sample => sample.delta <= 8),
      method: '包含独立系统边色；原生设置成功应答为 NONE 时检查客户区表面，否则检查完整 DWM 外缘。顶部始终覆盖系统实体黑边；外侧 1 物理像素与内侧表面最大通道差不超过 8', samples, outerSamples };
  }
  const straightEdges = [], expectedBandWidth = Math.round(3 * scale);
  for (const fraction of [.3, .5, .7]) {
    const samples = new Map(points(fraction, 0).map(([edge]) => [edge, []]));
    for (let depth = 0; depth < Math.ceil(10 * scale); depth++) {
      for (const [edge, x, y] of points(fraction, depth)) samples.get(edge).push(pixel(x, y));
    }
    for (const [edge, pixels] of samples) {
      // 原生边色与页面颜色在最终屏幕合成后可能不同；只接受邻近暖橙的平坦内侧色作为第二参考。
      const candidate = pixels[Math.floor(expectedBandWidth / 2)];
      const strokeColors = candidate[0] >= 200 && distance(candidate, [220, 135, 61]) <= 24 ? [[220, 135, 61], candidate] : [[220, 135, 61]];
      let bandWidth = 0;
      while (bandWidth < pixels.length && strokeColors.some(color => distance(pixels[bandWidth], color) <= 6)) bandWidth++;
      straightEdges.push({ edge, fraction, width: bandWidth, strokeColors, pixels });
    }
  }
  const widths = straightEdges.map(edge => edge.width), widthSpread = Math.max(...widths) - Math.min(...widths);
  // 贴合的内发光从实体光条后立即衰减；先退回纸面、再突然变暖表示二者之间留缝。
  const glowSamples = straightEdges.map(({ edge, fraction, width: band, strokeColors, pixels }) => {
    // 只取紧邻光条的 3 DIP，避免更内侧的顶部固定按钮背景干扰柔光衰减。
    const profile = pixels.slice(band, band + Math.max(4, Math.round(3 * scale)))
      .map((rgb, offset) => ({ depth: band + offset, rgb, fromStroke: Math.min(...strokeColors.map(color => distance(rgb, color))) }));
    let furthest = 0, rebound = 0;
    for (const sample of profile) { rebound = Math.max(rebound, furthest - sample.fromStroke); furthest = Math.max(furthest, sample.fromStroke); }
    const decay = furthest - (profile[0]?.fromStroke ?? 0);
    return { edge, fraction, rebound, decay, passed: profile.length >= 4 && rebound <= 6 && decay >= 10, profile };
  });
  const glowContact = { passed: glowSamples.every(sample => sample.passed), method: '实体光条后的首个像素立即接上柔光，再向内衰减；不得先回到纸面后再起光。最大反向跳变 6，衰减幅度至少 10 个通道值', samples: glowSamples };
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
  return { passed: corners.every(corner => corner.count > 0 && corner.dark === 0) && widths.every(value => Math.abs(value - expectedBandWidth) <= 1) && widthSpread <= 1 && glowContact.passed,
    method: '默认暖橙光条同时检查四角暗纹、约 3 DIP 实体厚度与内发光贴合；使用相邻实体色校准原生和页面色差，四边厚度最大差不超过 1 物理像素', straightEdges, expectedBandWidth, widthSpread, glowContact, corners };
}
module.exports = { sampleEdges };
