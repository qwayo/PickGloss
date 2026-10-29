const EDGES = Object.freeze(['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']);
let gestureSequence = 0;

function screenPoint(event, fallback) {
  const x = Number.isFinite(event?.screenX) ? event.screenX : fallback?.x;
  const y = Number.isFinite(event?.screenY) ? event.screenY : fallback?.y;
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

function createToken(view) {
  if (typeof view.crypto?.randomUUID === 'function') return view.crypto.randomUUID();
  return `${Date.now().toString(36)}-${++gestureSequence}`;
}

/**
 * 在独立于应用内容的透明层管理面板缩放手势，并串行发送带令牌的坐标。
 * 每次手势先确认 start，再发送每帧最新 move，最后只发送一次 end。
 */
export function mountPanelResize({ root = document.body, invoke } = {}) {
  if (!root?.ownerDocument || typeof root.appendChild !== 'function') throw new TypeError('面板缩放层需要一个文档节点。');
  if (typeof invoke !== 'function') throw new TypeError('面板缩放层需要主进程调用函数。');

  const doc = root.ownerDocument, view = doc.defaultView;
  if (!view) throw new TypeError('面板缩放层需要一个活动文档窗口。');
  const requestFrame = view.requestAnimationFrame?.bind(view) || (callback => view.setTimeout(callback, 16));
  const cancelFrame = view.cancelAnimationFrame?.bind(view) || view.clearTimeout.bind(view);
  const layer = doc.createElement('div');
  layer.className = 'panel-resize-layer';
  layer.setAttribute('aria-hidden', 'true');
  const grips = new Map();
  let active = null, raf = 0, disposed = false;
  let pendingStart = null, pendingMove = null, pendingEnd = null, sending = false;

  function finishActive(token) {
    if (active?.token !== token) return;
    active = null;
    pendingMove = pendingMove?.token === token ? null : pendingMove;
    pendingEnd = pendingEnd?.token === token ? null : pendingEnd;
    pendingStart = pendingStart?.token === token ? null : pendingStart;
  }

  function failGesture(token) {
    if (!active || active.token !== token || active.ending) return;
    active.ending = true;
    if (raf) { cancelFrame(raf); raf = 0; }
    pendingMove = null;
    pendingEnd = { phase: 'end', edge: active.edge, ...active.point, token };
    try {
      if (active.handle.hasPointerCapture?.(active.pointerId)) active.handle.releasePointerCapture(active.pointerId);
    } catch { /* 捕获已被浏览器收回时仍需结束主进程手势。 */ }
  }

  function scheduleSend() {
    if (sending || disposed) return;
    sending = true;
    void (async () => {
      try {
        while (pendingStart || pendingMove || pendingEnd) {
          const payload = pendingStart || pendingMove || pendingEnd;
          if (payload === pendingStart) pendingStart = null;
          else if (payload === pendingMove) pendingMove = null;
          else pendingEnd = null;
          try {
            const result = await invoke(payload);
            if (result === false || result?.ok === false || result?.value === false) throw new Error('主进程未接受面板缩放消息。');
          }
          catch { failGesture(payload.token); }
          if (payload.phase === 'end') finishActive(payload.token);
        }
      } finally {
        sending = false;
        if (pendingStart || pendingMove || pendingEnd) scheduleSend();
      }
    })();
  }

  function flushMove(token) {
    if (raf) { cancelFrame(raf); raf = 0; }
    if (!active || active.token !== token || !active.latestMove) return;
    pendingMove = active.latestMove;
    active.latestMove = null;
    scheduleSend();
  }

  function endGesture(event, pointerId = event?.pointerId) {
    if (!active || active.ending || (pointerId !== undefined && pointerId !== active.pointerId)) return;
    const gesture = active, point = screenPoint(event, gesture.point) || gesture.point;
    gesture.point = point; gesture.ending = true;
    flushMove(gesture.token);
    pendingEnd = { phase: 'end', edge: gesture.edge, ...point, token: gesture.token };
    try {
      if (gesture.handle.hasPointerCapture?.(gesture.pointerId)) gesture.handle.releasePointerCapture(gesture.pointerId);
    } catch { /* 已自动释放的指针捕获无需再次处理。 */ }
    scheduleSend();
  }

  function onPointerDown(event) {
    if (disposed || active || event.button !== 0 || event.isPrimary === false) return;
    const point = screenPoint(event);
    if (!point) return;
    event.preventDefault(); event.stopPropagation();
    const handle = event.currentTarget, edge = handle.dataset.edge, token = createToken(view);
    const gesture = { token, edge, handle, pointerId: event.pointerId, point, latestMove: null, ending: false };
    active = gesture;
    try { handle.setPointerCapture(event.pointerId); }
    catch {
      active = null;
      return;
    }
    pendingStart = { phase: 'start', edge, ...point, token };
    scheduleSend();
  }

  function onPointerMove(event) {
    if (!active || active.ending || event.pointerId !== active.pointerId) return;
    const point = screenPoint(event, active.point);
    if (!point) return;
    event.preventDefault(); event.stopPropagation();
    active.point = point;
    active.latestMove = { phase: 'move', edge: active.edge, ...point, token: active.token };
    if (!raf) {
      const token = active.token;
      raf = requestFrame(() => { raf = 0; flushMove(token); });
    }
  }

  function onPointerEnd(event) { endGesture(event); }
  function onLostPointerCapture(event) { endGesture(event); }
  function onWindowBlur() { endGesture(null, active?.pointerId); }
  function onVisibilityChange() { if (doc.hidden) endGesture(null, active?.pointerId); }

  for (const edge of EDGES) {
    const grip = doc.createElement('div');
    grip.className = `panel-resize-grip panel-resize-grip-${edge}`;
    grip.dataset.edge = edge;
    grip.setAttribute('aria-hidden', 'true');
    grip.addEventListener('pointerdown', onPointerDown);
    grip.addEventListener('pointermove', onPointerMove);
    grip.addEventListener('pointerup', onPointerEnd);
    grip.addEventListener('pointercancel', onPointerEnd);
    grip.addEventListener('lostpointercapture', onLostPointerCapture);
    layer.appendChild(grip);
    grips.set(edge, grip);
  }
  root.appendChild(layer);
  view.addEventListener('blur', onWindowBlur);
  doc.addEventListener('visibilitychange', onVisibilityChange);

  return {
    dispose() {
      if (disposed) return;
      if (active) endGesture(null, active.pointerId);
      disposed = true;
      if (raf) { cancelFrame(raf); raf = 0; }
      view.removeEventListener('blur', onWindowBlur);
      doc.removeEventListener('visibilitychange', onVisibilityChange);
      for (const grip of grips.values()) {
        grip.removeEventListener('pointerdown', onPointerDown);
        grip.removeEventListener('pointermove', onPointerMove);
        grip.removeEventListener('pointerup', onPointerEnd);
        grip.removeEventListener('pointercancel', onPointerEnd);
        grip.removeEventListener('lostpointercapture', onLostPointerCapture);
      }
      layer.remove();
    },
  };
}
