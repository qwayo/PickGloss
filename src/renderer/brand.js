import glyphs from './assets/brand-glyphs.js';

// 正式界面的选区与释义气泡标志共用相同矢量数据。
export function brand({ small = false, tile = false, selection = false } = {}) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', tile ? '0 0 64 64' : '0 0 32 32');
  svg.setAttribute('class', tile ? 'brand brand-tile' : 'brand');
  svg.setAttribute('aria-hidden', 'true');
  if (tile) {
    const rect = document.createElementNS(ns, 'rect');
    for (const [key, value] of Object.entries({ width: 64, height: 64, rx: selection ? 22 : 16, class: 'brand-background' })) rect.setAttribute(key, value);
    svg.append(rect);
  }
  const group = document.createElementNS(ns, 'g');
  group.setAttribute('class', 'brand-ink');
  if (tile) group.setAttribute('transform', small ? 'translate(6 6) scale(1.625)' : 'translate(8 8) scale(1.5)');
  (selection ? glyphs.selection : small ? glyphs.small : glyphs.standard).forEach((d, i) => {
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill-rule', i === 2 ? 'evenodd' : 'nonzero');
    group.append(path);
  });
  svg.append(group);
  return svg;
}
