'use strict';
const EDGES = new Set(['n','ne','e','se','s','sw','w','nw']);

// 用一次手势的起点计算四边，避免连续 move 重复累计位移。
function panelResizeBounds(initial, edge, dx, dy) {
  if (!EDGES.has(edge) || ![dx,dy,initial?.x,initial?.y,initial?.width,initial?.height].every(Number.isFinite)) throw new Error('窗口拉伸参数无效。');
  const next = { ...initial };
  if (edge.includes('e') || edge.includes('w')) next.width = Math.round(Math.max(215, Math.min(8192, initial.width + (edge.includes('w') ? -dx : dx))));
  if (edge.includes('s') || edge.includes('n')) next.height = Math.round(Math.max(260, Math.min(8192, initial.height + (edge.includes('n') ? -dy : dy))));
  if (edge.includes('w')) next.x = initial.x + initial.width - next.width;
  if (edge.includes('n')) next.y = initial.y + initial.height - next.height;
  return next;
}

function validResizePayload(value) {
  return value && ['start','move','end'].includes(value.phase) && EDGES.has(value.edge) &&
    typeof value.token === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value.token) &&
    [value.x,value.y].every(number => Number.isFinite(number) && Math.abs(number) <= 100000);
}
module.exports = { panelResizeBounds, validResizePayload };
