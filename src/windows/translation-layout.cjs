'use strict';

const MAX_TRANSLATION_HEIGHT = 480;
const MIN_TRANSLATION_HEIGHT = 1;

// 覆盖图和控制区使用两个原生窗口，控制区优先放在选区外。
function translationLayout(placement, displayMode = 'overlay', { extraHeight = 0, contentHeight, workArea } = {}) {
  const { region, displayBounds: area } = placement;
  if (![region?.x, region?.y, region?.width, region?.height, area?.x, area?.y, area?.width, area?.height].every(Number.isFinite) || region.width <= 0 || region.height <= 0 || area.width <= 0 || area.height <= 0) throw new Error('截图翻译的屏幕位置无效。');
  const controlArea = [workArea?.x, workArea?.y, workArea?.width, workArea?.height].every(Number.isFinite) && workArea.width > 0 && workArea.height > 0 ? workArea : area;
  const width = Math.min(controlArea.width, 280);
  let x = Math.max(controlArea.x, Math.min(region.x, controlArea.x + controlArea.width - width));
  const requestedHeight = Number.isFinite(contentHeight)
    ? contentHeight
    : displayMode === 'compare' ? 144 : 112 + Math.max(0, Math.min(56, Number(extraHeight) || 0));
  const controlHeight = Math.min(controlArea.height, MAX_TRANSLATION_HEIGHT, Math.max(MIN_TRANSLATION_HEIGHT, requestedHeight));
  let controlY = region.y + region.height + 6;
  if (controlY + controlHeight > controlArea.y + controlArea.height) {
    if (region.y - controlHeight - 6 >= controlArea.y) controlY = region.y - controlHeight - 6;
    else {
      controlY = Math.max(controlArea.y, Math.min(region.y, controlArea.y + controlArea.height - controlHeight));
      if (region.x + region.width + 6 + width <= controlArea.x + controlArea.width) x = region.x + region.width + 6;
      else if (region.x - width - 6 >= controlArea.x) x = region.x - width - 6;
    }
  }
  const bounds = { x: Math.floor(region.x), y: Math.floor(region.y), width: Math.ceil(region.x + region.width) - Math.floor(region.x), height: Math.ceil(region.y + region.height) - Math.floor(region.y) };
  return { bounds, image: { left: region.x - bounds.x, top: region.y - bounds.y, width: region.width, height: region.height },
    controlBounds: { x: Math.round(x), y: Math.floor(controlY), width: Math.ceil(width), height: Math.ceil(controlHeight) },
    controls: { left: 0, top: 0, width, height: controlHeight } };
}

module.exports = { MAX_TRANSLATION_HEIGHT, translationLayout };
