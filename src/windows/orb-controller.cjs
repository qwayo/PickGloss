'use strict';

const ORB_WIDTH = 48;
const ORB_HEIGHT = 48;
const EDGE_BAR_SIZE = 12;
const EDGE_SNAP_DISTANCE = 12;
const QUIET_DELAY_MS = 15_000;
const COLLAPSE_DELAY_MS = 1_000;

const copyBounds = bounds => ({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
const sameBounds = (a, b) => !!a && !!b && ['x', 'y', 'width', 'height'].every(key => a[key] === b[key]);
const validPoint = point => point && Number.isFinite(point.x) && Number.isFinite(point.y);

/**
 * 主进程的悬浮球原生窗口控制器。
 * onPosition 只收到完整展开态的左上角；桌面布局变化时由宿主调用 refresh()。
 * configure、hover、setMenuOpen、drag 和 refresh 都会同步更新窗口并发布状态。
 */
function createOrbController({ win, screen, onPosition = () => {}, onState = () => {}, clock = globalThis } = {}) {
  if (!win || typeof win.getBounds !== 'function' || typeof win.setBounds !== 'function') {
    throw new TypeError('悬浮球控制器需要可读写窗口边界的原生窗口。');
  }
  if (!screen) throw new TypeError('悬浮球控制器需要屏幕服务。');

  const setTimer = clock.setTimeout?.bind(clock) || setTimeout;
  const clearTimer = clock.clearTimeout?.bind(clock) || clearTimeout;
  let quietTimer = null;
  let collapseTimer = null;
  let disposed = false;
  let dragging = false;
  let hovering = false;
  let menuOpen = false;
  let dimmed = false;
  let collapsed = false;
  let edge = null;
  let quietFadeEnabled = true;
  let edgeCollapseEnabled = true;
  let reducedMotion = false;
  let dragOrigin = null;
  let expandedBounds = normalizeExpanded(win.getBounds());

  function normalizeExpanded(bounds) {
    return {
      x: Math.round(Number.isFinite(bounds?.x) ? bounds.x : 0),
      y: Math.round(Number.isFinite(bounds?.y) ? bounds.y : 0),
      width: ORB_WIDTH,
      height: ORB_HEIGHT,
    };
  }

  function alive() {
    return !disposed && !(typeof win.isDestroyed === 'function' && win.isDestroyed());
  }

  function state() {
    return { dimmed, collapsed, edge, expanded: !collapsed, dragging, menuOpen, reducedMotion };
  }

  function publish() {
    if (disposed) return;
    try { onState(state()); } catch { /* 狀態回呼失敗不能阻斷原生窗口控制。 */ }
  }

  function setBounds(bounds) {
    if (!alive()) return false;
    const current = win.getBounds();
    if (sameBounds(current, bounds)) return false;
    win.setBounds(copyBounds(bounds));
    return true;
  }

  function clearQuietTimer() {
    if (quietTimer !== null) clearTimer(quietTimer);
    quietTimer = null;
  }

  function clearCollapseTimer() {
    if (collapseTimer !== null) clearTimer(collapseTimer);
    collapseTimer = null;
  }

  function canFade() {
    return alive() && quietFadeEnabled && !hovering && !dragging && !menuOpen;
  }

  function scheduleQuietFade() {
    clearQuietTimer();
    if (!canFade()) return;
    quietTimer = setTimer(() => {
      quietTimer = null;
      if (!canFade()) return;
      if (!dimmed) { dimmed = true; publish(); }
    }, QUIET_DELAY_MS);
  }

  function resetQuietFade() {
    clearQuietTimer();
    if (dimmed) { dimmed = false; publish(); }
    scheduleQuietFade();
  }

  function workAreaFor(bounds, point) {
    let display = null;
    try {
      if (validPoint(point) && typeof screen.getDisplayNearestPoint === 'function') {
        display = screen.getDisplayNearestPoint(point);
      }
    } catch { /* 退回窗口范围查找。 */ }
    if (!display) {
      try { display = screen.getDisplayMatching?.(bounds); } catch { /* 使用主屏回退。 */ }
    }
    if (!display) {
      try { display = screen.getPrimaryDisplay?.(); } catch { /* 没有可用主屏。 */ }
    }
    const area = display?.workArea || display?.bounds;
    if (area && [area.x, area.y, area.width, area.height].every(Number.isFinite) && area.width > 0 && area.height > 0) {
      return { x: area.x, y: area.y, width: area.width, height: area.height };
    }
    return null;
  }

  function fit(bounds, area) {
    if (!area) return normalizeExpanded(bounds);
    const width = Math.min(ORB_WIDTH, area.width);
    const height = Math.min(ORB_HEIGHT, area.height);
    return {
      x: Math.round(Math.max(area.x, Math.min(bounds.x, area.x + area.width - width))),
      y: Math.round(Math.max(area.y, Math.min(bounds.y, area.y + area.height - height))),
      width,
      height,
    };
  }

  function edgeDistances(bounds, area) {
    if (!area) return [];
    return [
      { edge: 'left', distance: Math.abs(bounds.x - area.x) },
      { edge: 'right', distance: Math.abs(area.x + area.width - (bounds.x + bounds.width)) },
      { edge: 'top', distance: Math.abs(bounds.y - area.y) },
      { edge: 'bottom', distance: Math.abs(area.y + area.height - (bounds.y + bounds.height)) },
    ];
  }

  function nearestEdge(bounds, area) {
    const candidates = edgeDistances(bounds, area).sort((a, b) => a.distance - b.distance);
    return candidates[0]?.distance <= EDGE_SNAP_DISTANCE ? candidates[0].edge : null;
  }

  function snapExpandedToEdge(bounds, area, nextEdge) {
    if (!area || !nextEdge) return copyBounds(bounds);
    const result = fit(bounds, area);
    if (nextEdge === 'left') result.x = area.x;
    if (nextEdge === 'right') result.x = Math.round(area.x + area.width - result.width);
    if (nextEdge === 'top') result.y = area.y;
    if (nextEdge === 'bottom') result.y = Math.round(area.y + area.height - result.height);
    return result;
  }

  function collapsedBounds(nextEdge) {
    const area = workAreaFor(expandedBounds, {
      x: expandedBounds.x + expandedBounds.width / 2,
      y: expandedBounds.y + expandedBounds.height / 2,
    });
    const full = fit(expandedBounds, area);
    if (!nextEdge || !area) return full;
    if (nextEdge === 'left') return { ...full, x: area.x, width: Math.min(EDGE_BAR_SIZE, area.width) };
    if (nextEdge === 'right') return { ...full, x: Math.round(area.x + area.width - Math.min(EDGE_BAR_SIZE, area.width)), width: Math.min(EDGE_BAR_SIZE, area.width) };
    if (nextEdge === 'top') return { ...full, y: area.y, height: Math.min(EDGE_BAR_SIZE, area.height) };
    if (nextEdge === 'bottom') return { ...full, y: Math.round(area.y + area.height - Math.min(EDGE_BAR_SIZE, area.height)), height: Math.min(EDGE_BAR_SIZE, area.height) };
    return full;
  }

  // 原生窗口可能把 12 DIP 收边请求夹到更大的最小客户区。按窗口实际尺寸回锚，
  // 避免右侧或下侧多出的客户区被推到 workArea 之外。
  function keepCollapsedInsideArea(bounds, area, nextEdge) {
    if (!area) return copyBounds(bounds);
    const width = Math.min(bounds.width, area.width);
    const height = Math.min(bounds.height, area.height);
    const result = { ...bounds, width, height };
    if (nextEdge === 'left') result.x = area.x;
    else if (nextEdge === 'right') result.x = Math.round(area.x + area.width - width);
    else result.x = Math.round(Math.max(area.x, Math.min(bounds.x, area.x + area.width - width)));
    if (nextEdge === 'top') result.y = area.y;
    else if (nextEdge === 'bottom') result.y = Math.round(area.y + area.height - height);
    else result.y = Math.round(Math.max(area.y, Math.min(bounds.y, area.y + area.height - height)));
    return result;
  }

  function expandNative() {
    if (!alive()) return;
    if (collapsed) {
      setBounds(expandedBounds);
      collapsed = false;
    }
  }

  function shouldCollapse() {
    return alive() && edgeCollapseEnabled && !!edge && !hovering && !dragging && !menuOpen;
  }

  function collapseNow() {
    collapseTimer = null;
    if (!shouldCollapse() || collapsed) return;
    setBounds(collapsedBounds(edge));
    const area = workAreaFor(expandedBounds, {
      x: expandedBounds.x + expandedBounds.width / 2,
      y: expandedBounds.y + expandedBounds.height / 2,
    });
    let actualBounds = win.getBounds();
    for (let attempt = 0; attempt < 3; attempt++) {
      const anchored = keepCollapsedInsideArea(actualBounds, area, edge);
      if (sameBounds(actualBounds, anchored)) break;
      setBounds(anchored);
      actualBounds = win.getBounds();
    }
    collapsed = true;
    publish();
  }

  function scheduleCollapse() {
    clearCollapseTimer();
    if (!shouldCollapse() || collapsed) return;
    collapseTimer = setTimer(collapseNow, COLLAPSE_DELAY_MS);
  }

  function updateQuietEligibility() {
    if (canFade()) scheduleQuietFade();
    else clearQuietTimer();
  }

  function configure(options = {}) {
    if (!alive()) return state();
    const previousEdgeEnabled = edgeCollapseEnabled;
    if (typeof options.quietFadeEnabled === 'boolean') quietFadeEnabled = options.quietFadeEnabled;
    if (typeof options.edgeCollapseEnabled === 'boolean') edgeCollapseEnabled = options.edgeCollapseEnabled;
    if (typeof options.reducedMotion === 'boolean') reducedMotion = options.reducedMotion;

    if (!edgeCollapseEnabled) {
      clearCollapseTimer();
      expandNative();
      edge = null;
    } else if (!previousEdgeEnabled && !dragging && !collapsed) {
      const area = workAreaFor(expandedBounds, {
        x: expandedBounds.x + expandedBounds.width / 2,
        y: expandedBounds.y + expandedBounds.height / 2,
      });
      const nextEdge = nearestEdge(expandedBounds, area);
      if (nextEdge) {
        edge = nextEdge;
        expandedBounds = snapExpandedToEdge(expandedBounds, area, edge);
        setBounds(expandedBounds);
        scheduleCollapse();
      }
    }

    if (!quietFadeEnabled) {
      clearQuietTimer();
      dimmed = false;
    } else if (!canFade()) {
      clearQuietTimer();
      dimmed = false;
    } else {
      scheduleQuietFade();
    }
    publish();
    return state();
  }

  function hover(active) {
    if (!alive()) return state();
    hovering = active === true;
    if (hovering) {
      clearCollapseTimer();
      expandNative();
      resetQuietFade();
    } else {
      scheduleCollapse();
      if (canFade()) scheduleQuietFade();
      else clearQuietTimer();
    }
    publish();
    return state();
  }

  function setMenuOpen(active) {
    if (!alive()) return state();
    menuOpen = active === true;
    if (menuOpen) {
      clearCollapseTimer();
      expandNative();
      clearQuietTimer();
      if (dimmed) dimmed = false;
    } else {
      scheduleCollapse();
      updateQuietEligibility();
    }
    publish();
    return state();
  }

  function drag(payload = {}) {
    if (!alive()) return false;
    const { phase, x, y } = payload;
    if (!['start', 'move', 'end'].includes(phase) || ![x, y].every(value => Number.isFinite(value) && Math.abs(value) <= 100_000)) {
      throw new Error('悬浮球拖动坐标无效。');
    }
    if (phase === 'start') {
      clearQuietTimer(); clearCollapseTimer();
      expandNative();
      dragging = true;
      dimmed = false;
      dragOrigin = { x, y, bounds: copyBounds(expandedBounds) };
      publish();
      return true;
    }
    if (!dragging || !dragOrigin) return false;

    const moved = {
      ...dragOrigin.bounds,
      x: Math.round(dragOrigin.bounds.x + x - dragOrigin.x),
      y: Math.round(dragOrigin.bounds.y + y - dragOrigin.y),
    };
    setBounds(moved);
    if (phase === 'move') return true;

    const area = workAreaFor(moved, { x, y });
    let finalBounds = fit(moved, area);
    edge = edgeCollapseEnabled ? nearestEdge(finalBounds, area) : null;
    if (edge) finalBounds = snapExpandedToEdge(finalBounds, area, edge);
    expandedBounds = normalizeExpanded(finalBounds);
    setBounds(expandedBounds);
    dragging = false;
    dragOrigin = null;
    const persisted = { x: expandedBounds.x, y: expandedBounds.y };
    try { onPosition(persisted); } catch { /* 位置未能持久化不应让拖动状态卡住。 */ }

    if (edge && !hovering && !menuOpen) scheduleCollapse();
    else publish();
    updateQuietEligibility();
    return true;
  }

  function refresh() {
    if (!alive()) return state();
    clearQuietTimer(); clearCollapseTimer();
    dragging = false; dragOrigin = null;
    const center = { x: expandedBounds.x + expandedBounds.width / 2, y: expandedBounds.y + expandedBounds.height / 2 };
    const area = workAreaFor(expandedBounds, center);
    const previous = copyBounds(expandedBounds);
    expandedBounds = fit(expandedBounds, area);
    if (!sameBounds(previous, expandedBounds)) {
      try { onPosition({ x: expandedBounds.x, y: expandedBounds.y }); } catch { /* 恢复仍继续。 */ }
    }
    edge = edgeCollapseEnabled ? nearestEdge(expandedBounds, area) : null;
    collapsed = false;
    setBounds(expandedBounds);
    if (edge && !hovering && !menuOpen) scheduleCollapse();
    else publish();
    updateQuietEligibility();
    return state();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    clearQuietTimer(); clearCollapseTimer();
    dragging = false; dragOrigin = null;
  }

  const initialArea = workAreaFor(expandedBounds, {
    x: expandedBounds.x + expandedBounds.width / 2,
    y: expandedBounds.y + expandedBounds.height / 2,
  });
  setBounds(expandedBounds);
  edge = edgeCollapseEnabled ? nearestEdge(expandedBounds, initialArea) : null;
  if (edge) {
    expandedBounds = snapExpandedToEdge(expandedBounds, initialArea, edge);
    setBounds(expandedBounds);
    scheduleCollapse();
  }
  publish();
  scheduleQuietFade();
  return { configure, drag, hover, setMenuOpen, refresh, dispose };
}

module.exports = {
  createOrbController,
  ORB_WIDTH,
  ORB_HEIGHT,
  EDGE_BAR_SIZE,
  EDGE_SNAP_DISTANCE,
  QUIET_DELAY_MS,
  COLLAPSE_DELAY_MS,
};
