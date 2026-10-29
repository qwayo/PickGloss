import glyphs from './assets/brand-glyphs.js';

// 正式界面的选区与释义气泡标志共用相同矢量数据。
export function brand({ small = false, tile = false, selection = false } = {}) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  const selectionTile = tile && selection;
  svg.setAttribute('viewBox', selectionTile ? '0 0 26 26' : tile ? '0 0 64 64' : '0 0 32 32');
  svg.setAttribute('class', selectionTile ? 'brand brand-tile brand-selection' : tile ? 'brand brand-tile' : 'brand');
  svg.setAttribute('aria-hidden', 'true');
  if (tile && !selectionTile) {
    const rect = document.createElementNS(ns, 'rect');
    const shell = { width: 64, height: 64, rx: 16 };
    for (const [key, value] of Object.entries({ ...shell, class: 'brand-background' })) rect.setAttribute(key, value);
    svg.append(rect);
  }
  const group = document.createElementNS(ns, 'g');
  group.setAttribute('class', 'brand-ink');
  // 悬空四角沿用已选原型：20 像素字形居中，外围仅留反色护边。
  if (selectionTile) group.setAttribute('transform', `translate(${13 - 15 * (20 / 22)} ${13 - 15 * (20 / 22)}) scale(${20 / 22})`);
  else if (tile) group.setAttribute('transform', small ? 'translate(6 6) scale(1.625)' : 'translate(8 8) scale(1.5)');
  (selection ? glyphs.selection : small ? glyphs.small : glyphs.standard).forEach((d, i) => {
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill-rule', i === 2 ? 'evenodd' : 'nonzero');
    group.append(path);
  });
  svg.append(group);
  return svg;
}
