/**
 * 挂载独立的悬浮球入口。品牌、左键、右键、拖动和悬停行为都由宿主注入。
 * update 接收控制器状态及 action（chat 或 capture）；dispose 会解除挂载并清理未完成拖动。
 */
export function mountOrb({
  root,
  createBrand,
  onActivate = () => {},
  onMenu = () => {},
  onDrag = () => {},
  onHover = () => {},
  requestFrame = callback => requestAnimationFrame(callback),
  cancelFrame = handle => cancelAnimationFrame(handle),
  setTimer = (callback, delay) => setTimeout(callback, delay),
} = {}) {
  if (!root || typeof root.replaceChildren !== 'function') throw new TypeError('悬浮球界面需要根节点。');
  if (typeof createBrand !== 'function') throw new TypeError('悬浮球界面需要标准品牌标志工厂。');

  const doc = root.ownerDocument || document;
  const surface = doc.createElement('main');
  surface.className = 'orb-surface';
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = 'orb';
  button.setAttribute('aria-label', '打开或关闭最新会话；右键打开菜单，拖动移动悬浮球');
  button.title = button.getAttribute('aria-label');
  button.setAttribute('draggable', 'false');
  const glyph = createBrand();
  glyph.classList?.add('orb-brand');
  glyph.setAttribute?.('aria-hidden', 'true');
  button.append(glyph);
  surface.append(button);
  root.replaceChildren(surface);

  let gesture = null;
  let suppressClick = false;
  let moveFrame = null;
  let latestPoint = null;
  let hovered = false;
  let disposed = false;
  let dragQueue = Promise.resolve();

  function sendDrag(payload) {
    dragQueue = dragQueue.then(() => onDrag(payload)).catch(() => {});
    return dragQueue;
  }

  function notifyHover(active) {
    if (hovered === active || disposed) return;
    hovered = active;
    try { onHover(active); } catch { /* 悬停回呼失败不能中断指针事件。 */ }
  }

  function onPointerDown(event) {
    if (event.button !== 0 || disposed) return;
    suppressClick = false;
    gesture = { id: event.pointerId, x: event.screenX, y: event.screenY, dragging: false };
    notifyHover(true);
    button.setPointerCapture?.(event.pointerId);
  }

  function onPointerMove(event) {
    if (!gesture || event.pointerId !== gesture.id || disposed) return;
    if (!gesture.dragging && Math.hypot(event.screenX - gesture.x, event.screenY - gesture.y) >= 5) {
      gesture.dragging = true;
      suppressClick = true;
      button.classList.add('is-dragging');
      void sendDrag({ phase: 'start', x: gesture.x, y: gesture.y });
    }
    if (!gesture.dragging) return;
    button.style.setProperty('--drag-tilt', `${Math.max(-9, Math.min(9, (event.screenX - gesture.x) * 0.1))}deg`);
    latestPoint = { x: event.screenX, y: event.screenY };
    if (moveFrame === null) {
      moveFrame = requestFrame(() => {
        moveFrame = null;
        if (latestPoint) void sendDrag({ phase: 'move', ...latestPoint });
      });
    }
  }

  function onPointerEnd(event) {
    if (!gesture || event.pointerId !== gesture.id || disposed) return;
    const current = gesture;
    const didDrag = current.dragging;
    gesture = null;
    if (moveFrame !== null) { cancelFrame(moveFrame); moveFrame = null; }
    button.classList.remove('is-dragging');
    button.style.removeProperty('--drag-tilt');
    if (didDrag) {
      const point = event.type === 'pointerup'
        ? { x: event.screenX, y: event.screenY }
        : latestPoint || { x: current.x, y: current.y };
      latestPoint = null;
      void sendDrag({ phase: 'end', ...point });
      setTimer(() => { suppressClick = false; }, 0);
    }
    if (button.hasPointerCapture?.(event.pointerId)) button.releasePointerCapture?.(event.pointerId);
  }

  button.addEventListener('click', event => {
    if (disposed) return;
    if (suppressClick) { suppressClick = false; event.preventDefault(); return; }
    onActivate();
  });
  button.addEventListener('contextmenu', event => {
    if (disposed) return;
    event.preventDefault();
    onMenu();
  });
  button.addEventListener('pointerenter', () => notifyHover(true));
  button.addEventListener('pointerleave', () => notifyHover(false));
  button.addEventListener('pointerdown', onPointerDown);
  button.addEventListener('pointermove', onPointerMove);
  button.addEventListener('pointerup', onPointerEnd);
  button.addEventListener('pointercancel', onPointerEnd);
  button.addEventListener('lostpointercapture', event => { if (gesture) onPointerEnd(event); });

  function update(options = {}) {
    if (disposed) return;
    const action = options.action === 'capture' ? '截图框选；右键打开菜单，拖动移动悬浮球' : '打开或关闭最新会话；右键打开菜单，拖动移动悬浮球';
    button.title = action;
    button.setAttribute('aria-label', action);
    button.classList.toggle('is-dimmed', options.dimmed === true);
    button.classList.toggle('is-collapsed', options.collapsed === true);
    button.classList.toggle('is-expanded', options.expanded === true);
    button.classList.toggle('is-dragging', options.dragging === true || !!gesture?.dragging);
    button.classList.toggle('is-reduced-motion', options.reducedMotion === true);
    for (const direction of ['left', 'right', 'top', 'bottom']) {
      button.classList.toggle(`edge-${direction}`, options.edge === direction);
    }
  }

  function dispose() {
    if (disposed) return;
    notifyHover(false);
    disposed = true;
    if (moveFrame !== null) { cancelFrame(moveFrame); moveFrame = null; }
    if (gesture) {
      if (button.hasPointerCapture?.(gesture.id)) button.releasePointerCapture?.(gesture.id);
      gesture = null;
    }
    button.replaceChildren();
    if (surface.parentNode === root) root.removeChild(surface);
  }

  return { update, dispose, element: button };
}
