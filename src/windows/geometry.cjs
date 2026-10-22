'use strict';

// Electron 窗口使用 DIP，屏幕截图使用像素；两套坐标只在边界转换。
function clampWindow(point, size, workArea) {
  const width = Math.min(size.width, workArea.width);
  const height = Math.min(size.height, workArea.height);
  const x = point.x + width > workArea.x + workArea.width ? point.x - width - 12 : point.x + 12;
  const y = point.y + height > workArea.y + workArea.height ? point.y - height - 12 : point.y + 14;
  return { x: Math.round(Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - width))),
    y: Math.round(Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - height))), width, height };
}

function cropPixels(rect, viewport, imageSize) {
  if (![rect?.x, rect?.y, rect?.width, rect?.height].every(Number.isFinite)) throw new Error('框选范围无效。');
  if (rect.x < 0 || rect.y < 0 || rect.width < 4 || rect.height < 4 ||
      rect.x + rect.width > viewport.width + 1 || rect.y + rect.height > viewport.height + 1) throw new Error('请在当前屏幕内框选至少 4 × 4 的区域。');
  const x = Math.floor(rect.x * imageSize.width / viewport.width);
  const y = Math.floor(rect.y * imageSize.height / viewport.height);
  const right = Math.min(imageSize.width, Math.ceil((rect.x + rect.width) * imageSize.width / viewport.width));
  const bottom = Math.min(imageSize.height, Math.ceil((rect.y + rect.height) * imageSize.height / viewport.height));
  return { x, y, width: right - x, height: bottom - y };
}

// 调整已有窗口时保留最近的屏幕边缘，不能套用鼠标旁首次打开的翻转规则。
function resizePanel(bounds, size, workArea) {
  const width = Math.min(size.width, workArea.width);
  const height = Math.min(size.height, workArea.height);
  const right = bounds.x + bounds.width;
  const keepRight = workArea.x + workArea.width - right < bounds.x - workArea.x;
  const x = keepRight ? right - width : bounds.x;
  return {
    x: Math.round(Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - width))),
    y: Math.round(Math.max(workArea.y, Math.min(bounds.y, workArea.y + workArea.height - height))),
    width, height,
  };
}

// 只在恢复、显示器变化或切换布局时避让边界；日常拖动不吸附屏幕边缘。
function fitWindow(bounds, workArea) {
  const width = Math.min(bounds.width, workArea.width);
  const height = Math.min(bounds.height, workArea.height);
  return {
    x: Math.round(Math.max(workArea.x, Math.min(bounds.x, workArea.x + workArea.width - width))),
    y: Math.round(Math.max(workArea.y, Math.min(bounds.y, workArea.y + workArea.height - height))),
    width: Math.round(width), height: Math.round(height),
  };
}

function placeMenu(anchor, size, workArea) {
  const width = Math.min(size.width, workArea.width), height = Math.min(size.height, workArea.height);
  const opensLeft = anchor.x + anchor.width + 6 + width > workArea.x + workArea.width;
  const opensUp = anchor.y + height > workArea.y + workArea.height;
  const bounds = fitWindow({ x: opensLeft ? anchor.x - width - 6 : anchor.x + anchor.width + 6,
    y: opensUp ? anchor.y + anchor.height - height : anchor.y, width, height }, workArea);
  return { bounds, origin: `${opensUp ? 'bottom' : 'top'}-${opensLeft ? 'right' : 'left'}` };
}

// 划词入口在松开点正下方居中；仅在屏幕底部放不下时翻到上方。
function placeSelectionEntry(point, size, workArea) {
  const below = point.y + 12;
  return fitWindow({ x: point.x - size.width / 2,
    y: below + size.height <= workArea.y + workArea.height ? below : point.y - size.height - 12,
    ...size }, workArea);
}

module.exports = { clampWindow, cropPixels, resizePanel, fitWindow, placeMenu, placeSelectionEntry };
