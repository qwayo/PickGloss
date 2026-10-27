'use strict';
// 只记录布局和能力信息，不保存图片内容、说明或用户路径。
function previewSnapshot() {
  const body = document.querySelector('.recognition-preview');
  const image = body?.querySelector('.preview-image');
  const actions = body?.querySelector('.form-actions');
  const rect = node => node ? Object.fromEntries(['x', 'y', 'width', 'height', 'top', 'bottom', 'left', 'right'].map(key => [key, node.getBoundingClientRect()[key]])) : null;
  return {
    image: image ? { complete: image.complete, width: image.naturalWidth, height: image.naturalHeight, rect: rect(image) } : null,
    fonts: document.fonts.status,
    font: body ? getComputedStyle(body).font : null,
    animations: document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => ({ state: a.playState, time: a.currentTime, timing: a.effect.getComputedTiming(), target: a.effect.target?.className })),
    viewport: { width: innerWidth, height: innerHeight, scale: devicePixelRatio, zoom: document.querySelector('#app')?.style.zoom },
    theme: document.documentElement.dataset.appearance,
    material: document.documentElement.dataset.material,
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    preparing: document.documentElement.classList.contains('layout-preparing'),
    body: body ? { rect: rect(body), height: body.clientHeight, scrollHeight: body.scrollHeight, scrollTop: body.scrollTop } : null,
    actions: rect(actions),
    fits: Boolean(body && actions && body.scrollHeight <= body.clientHeight + 1 && actions.getBoundingClientRect().bottom <= body.getBoundingClientRect().bottom),
  };
}
module.exports = { previewSnapshot };
