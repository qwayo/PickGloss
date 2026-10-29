'use strict';
// 检查 14 DIP 圆角应当露出自有背景的位置，区分系统默认 8 DIP 裁切。
function sampleCornerFootprint({ width, height, pixel, scale, radiusDip, background, probeDip = 3.5, tolerance = 10 }) {
  if (!Number.isFinite(radiusDip) || radiusDip <= 0 || !Array.isArray(background) || background.length !== 3) return null;
  const probe = Math.round(probeDip * scale);
  const distance = (a, b) => Math.max(...a.map((value, index) => Math.abs(value - b[index])));
  const samples = [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]].map(([x, y], index) => {
    const actualX = x === 0 ? probe : x - probe, actualY = y === 0 ? probe : y - probe;
    const actual = pixel(actualX, actualY), delta = distance(actual, background);
    return { corner: ['左上', '右上', '左下', '右下'][index], x: actualX, y: actualY, actual, background, delta };
  });
  const probeIsOutside = (radiusDip - probeDip) * Math.SQRT2 > radiusDip;
  return { passed: probeIsOutside && samples.every(sample => sample.delta <= tolerance), radiusDip, scale, probeDip, probeIsOutside, tolerance, samples };
}

// 从 DWM 可见边界采样，包含独立系统边色与外圆角；只跳过窗外阴影。
function sampleEdges({ width, height, pixel, scale, pinned, nativeBorder, client = { left: 0, top: 0, width, height },
  cornerRadiusDip, cornerBackground, maxOuterDelta = 8 }) {
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
    const cornerFootprint = sampleCornerFootprint({ width, height, pixel, scale, radiusDip: cornerRadiusDip, background: cornerBackground });
    const outerBand = { passed: outerSamples.every(sample => sample.delta <= maxOuterDelta), maxDelta: Math.max(...outerSamples.map(sample => sample.delta)), maxDeltaAllowed: maxOuterDelta };
    return { passed: samples.every(sample => sample.delta <= 6) && outerBand.passed && (cornerFootprint?.passed ?? true),
      method: '包含独立系统边色；检查 14 DIP 轮廓内的实屏客户区边缘、四个外圆角及 NONE 以外的系统边色。', samples, outerSamples, outerBand, cornerFootprint };
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
  const measuredStrokeColors = straightEdges.filter(edge => edge.strokeColors.length > 1).map(edge => edge.strokeColors.at(-1));
  const strokeCandidates = measuredStrokeColors.length ? measuredStrokeColors : straightEdges.map(edge => edge.strokeColors.at(-1));
  const cornerStrokeColor = [0, 1, 2].map(channel => Math.round(strokeCandidates.reduce((sum, color) => sum + color[channel], 0) / strokeCandidates.length));
  // 贴合的内发光从实体光条后立即衰减；先退回纸面、再突然变暖表示二者之间留缝。
  const glowSamples = straightEdges.map(({ edge, fraction, width: band, strokeColors, pixels }) => {
    // 只采样实体光条内侧紧邻的 2 DIP，避免采样窗延伸到顶部固定按钮的填充背景。
    const profile = pixels.slice(band, band + Math.max(4, Math.round(2 * scale)))
      .map((rgb, offset) => ({ depth: band + offset, rgb, fromStroke: Math.min(...strokeColors.map(color => distance(rgb, color))) }));
    let furthest = 0, rebound = 0;
    for (const sample of profile) { rebound = Math.max(rebound, furthest - sample.fromStroke); furthest = Math.max(furthest, sample.fromStroke); }
    const decay = furthest - (profile[0]?.fromStroke ?? 0);
    return { edge, fraction, rebound, decay, passed: profile.length >= 4 && rebound <= 6 && decay >= 10, profile };
  });
  const glowContact = { passed: glowSamples.every(sample => sample.passed), method: '实体光条后的首个像素立即接上柔光，再向内衰减；不得先回到纸面后再起光。最大反向跳变 6，衰减幅度至少 10 个通道值', samples: glowSamples };
  const radius = (cornerRadiusDip ?? 8) * scale, corners = [];
  for (const [flipX, flipY] of [[false, false], [true, false], [false, true], [true, true]]) {
    const samples = [];
    for (let y = 0; y < Math.ceil(radius); y++) for (let x = 0; x < Math.ceil(radius); x++) {
      const r = Math.hypot(radius - (x + .5), radius - (y + .5));
      if (r < radius - 2 * scale || r > radius - .8 * scale) continue;
      const px = flipX ? width - 1 - x : x, py = flipY ? height - 1 - y : y;
      const rgb = pixel(px, py);
      // 14 DIP 的圆弧有一列抗锯齿像素会与纸面混色；按实测直边色判断它是否仍属于描边。
      samples.push({ x: px, y: py, rgb, strokeDelta: distance(rgb, cornerStrokeColor), dark: distance(rgb, cornerStrokeColor) > 32 });
    }
    corners.push({ corner: `${flipY ? '下' : '上'}${flipX ? '右' : '左'}`, count: samples.length, dark: samples.filter(sample => sample.dark).length, samples });
  }
  const cornerFootprint = sampleCornerFootprint({ width, height, pixel, scale, radiusDip: cornerRadiusDip, background: cornerBackground });
  return { passed: corners.every(corner => corner.count > 0 && corner.dark === 0) && widths.every(value => Math.abs(value - expectedBandWidth) <= 1) && widthSpread <= 1 && glowContact.passed && (cornerFootprint?.passed ?? true),
    method: '默认暖橙光条同时检查四角描边颜色、约 3 DIP 实体厚度、内发光贴合与 14 DIP 外圆角；按实测直边描边色容纳圆弧抗锯齿', straightEdges, expectedBandWidth, widthSpread, glowContact, corners, cornerStrokeColor, cornerStrokeTolerance: 32, cornerFootprint };
}
module.exports = { sampleCornerFootprint, sampleEdges };
