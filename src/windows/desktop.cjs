'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { BrowserWindow, Menu, Tray, nativeImage, nativeTheme, systemPreferences, desktopCapturer, screen, utilityProcess, app, ipcMain } = require('electron');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const PIN_OUTLINE_COLORS = Object.freeze({ orange: '#dc873d', amber: '#cf9f37', blue: '#5095e8', violet: '#a47ee2', mint: '#4db393', silver: '#a8b2c1' });
const { createWindowAppearance } = require('./window-appearance.cjs');
// 两种默认尺寸保持独立；用户自定义尺寸与位置由主进程持久化。
const DEFAULT_PANEL_SIZES = Object.freeze({
  compact: Object.freeze({ width: 300, height: 483 }),
  reading: Object.freeze({ width: 860, height: 690 }),
});
const { clampWindow, cropPixels, resizePanel, fitWindow, placeMenu, placeSelectionEntry } = require('./geometry.cjs');
const { MAX_TRANSLATION_HEIGHT, translationLayout } = require('./translation-layout.cjs');
const { createScreenCapture } = require('./screen-capture.cjs');
const { sourceForRegion } = require('./translation-source.cjs');
const { createTranslationTracker } = require('./translation-tracker.cjs');
const { createOrbController } = require('./orb-controller.cjs');
const { panelResizeBounds, validResizePayload } = require('./panel-resize.cjs');

function createDesktop({ onAction, onSelection, onSelectionContext, onStatus, onWindowState, captureFactory = createScreenCapture, sourceFactory }) {
  const windows = new Map();
  let translationBinding = null;
  let translationControlsPinned = false;
  let orbController = null;
  let panelResize = null;
  let orbPreferences = { quietFadeEnabled: true, edgeCollapseEnabled: true };
  const sourceWatcher = sourceFactory || typeof BrowserWindow.prototype.getNativeWindowHandle === 'function'
    ? (sourceFactory || createTranslationTracker)({ onChange: sourceChanged }) : null;
  const html = path.join(__dirname, '..', 'renderer', 'index.html');
  const htmlUrl = pathToFileURL(html).href;
  const preload = path.join(__dirname, '..', 'preload.cjs');
  const assets = path.join(__dirname, '..', 'renderer', 'assets');
  let tray, worker, pending, heartbeatTimer, lastHeartbeat = 0, workerRestarts = 0;
  let closing = false, capture = null, pinned = false, wide = false, showOrb = true;
  let selectionGeneration = 0, selectionEntry = 0, pausedSelection = false;
  let cancellationId = 0, pendingCancellation = null;
  const selectionContexts = new Map();
  const panelSizes = { compact: { ...DEFAULT_PANEL_SIZES.compact }, reading: { ...DEFAULT_PANEL_SIZES.reading } };
  let panelTransition = null, animation = null, animationTimer = null, orbDrag = null;
  let panelPosition = null, orbPosition = null, geometryTimer = null;
  let revision = 0, savedRevision = 0, submittedRevision = -1, persistence = Promise.resolve(true);
  let appearance = { current: { mode: 'light', material: 'solid' }, reducedMotion: false };
  let appearanceDark = false, reducedMotion = false, appearanceMaterial = 'solid', lastState = null;
  let menuGeneration = 0, menuWanted = false, menuLoaded = false, menuHideTimer = null, menuOrigin = 'top-left', menuCloseReason = null;
  let menuAnchor = null, menuHeight = 452;
  const programmedSizes = new WeakMap();
  const windowMaterials = new WeakMap();
  const windowAppearances = new WeakMap(), windowAccentColors = new WeakMap();
  const deliveredCaptureIds = new WeakMap();
  let captureReadyTimer = null;
  let translationPlacement = null;
  let captureReader = null;
  // 主窗与 OCR 工具条共用透明内容和 14 DIP 背景裁切，不再叠加 DWM 的 8 DIP 非客户区。
  const clippedPanelFrame = process.platform === 'win32' && Number(os.release().split('.')[2]) >= 22000;
  const nativeRoundedFrame = false;
  let layoutSerial = 0;

  function captureState() {
    if (!capture?.image) return null;
    // 全尺寸 JPEG 仅用于背景预览，编码一次；原始 NativeImage 保留，裁剪仍输出原像素 PNG。
    if (!capture.imageData) capture.imageData = 'data:image/jpeg;base64,' + capture.image.toJPEG(92).toString('base64');
    return { id: capture.id, mode: capture.mode, method: capture.method, imageData: capture.imageData, width: capture.display.bounds.width, height: capture.display.bounds.height };
  }

  function surfaceFor(event) {
    const kind = [...windows].find(([,win]) => win.webContents.id === event.sender.id)?.[0];
    return kind && event.senderFrame === event.sender.mainFrame && event.senderFrame.url.startsWith(htmlUrl + '?') ? kind : null;
  }

  function surfaceState(kind, win, state, forceImage = false) {
    if (kind === 'translation' || kind === 'translation-overlay') return { ...state,
      status: kind === 'translation' ? { ...state.status, appearanceMaterial: windowMaterials.get(win) || 'solid', nativeRoundedFrame: false } : state.status,
      session: null, history: [], capture: null };
    state = { ...state, translation: null };
    if (kind === 'selection') return { ...state, capture: null, selectionEntry };
    if (kind !== 'capture') return { ...state, capture: null };
    const image = captureState();
    if (!image) { deliveredCaptureIds.delete(win.webContents); return { ...state, capture: null }; }
    if (!forceImage && deliveredCaptureIds.get(win.webContents) === image.id) {
      return { ...state, capture: { id: image.id, mode: image.mode, width: image.width, height: image.height } };
    }
    deliveredCaptureIds.set(win.webContents, image.id);
    return { ...state, capture: image };
  }

  function stateFor(event, state) {
    const kind = surfaceFor(event), win = windows.get(kind);
    return win ? surfaceState(kind, win, state, true) : { ...state, capture: null };
  }

  function broadcast(state) {
    // 内存中只保留状态元数据，整屏图像仅归本次截图所有。
    lastState = { ...state, capture: state.capture ? { id: state.capture.id, mode: state.capture.mode, width: state.capture.width, height: state.capture.height } : null };
    for (const [kind, win] of windows) if (!win.isDestroyed() && !win.webContents.isLoading()) win.webContents.send('pickgloss:state', surfaceState(kind, win, state));
  }

  function setWindowBounds(win, bounds) {
    const current = win.getBounds();
    // 原生边框在非整数缩放下可能对相同的 DIP 尺寸再次取整，重复唤回不能重复写入。
    if (['x','y','width','height'].every(key => current[key] === bounds[key])) return;
    programmedSizes.set(win, { width: bounds.width, height: bounds.height });
    win.setBounds(bounds);
  }

  function getWindowState() {
    return { orb: orbPosition && { ...orbPosition }, panel: panelPosition && { ...panelPosition },
      sizes: { compact: { ...panelSizes.compact }, reading: { ...panelSizes.reading } }, wide };
  }

  function persistWindowState() {
    if (!onWindowState || revision === savedRevision || revision === submittedRevision) return persistence;
    const snapshot = getWindowState(), writingRevision = revision;
    submittedRevision = writingRevision;
    persistence = persistence.then(async () => {
      try { await onWindowState(snapshot); savedRevision = writingRevision; return true; }
      catch { if (submittedRevision === writingRevision) submittedRevision = -1; onStatus({ error: '窗口位置与尺寸暂未写入磁盘，已保留本次调整；稍后将重试。' }); return false; }
    });
    return persistence;
  }

  function queueWindowState() {
    revision++;
    clearTimeout(geometryTimer);
    if (onWindowState) geometryTimer = setTimeout(() => { geometryTimer = null; void persistWindowState(); }, 220);
  }

  async function flushWindowState() {
    clearTimeout(geometryTimer); geometryTimer = null;
    if (animation) finishAnimation();
    await persistence;
    if (!onWindowState) return true;
    while (revision !== savedRevision) if (!(await persistWindowState())) return false;
    return true;
  }

  function rememberWindow(kind, win, rememberSize = true) {
    if (win.isDestroyed() || (kind === 'panel' && animation)) return;
    const bounds = win.getBounds();
    if (kind === 'panel') {
      panelPosition = { x: bounds.x, y: bounds.y };
      if (rememberSize) panelSizes[wide ? 'reading' : 'compact'] = { width: bounds.width, height: bounds.height };
    } else if (kind === 'orb') orbPosition = { x: bounds.x, y: bounds.y };
    else return;
    queueWindowState();
  }

  function stopAnimation(notify = true, committed = false) {
    const running = !!animation;
    if (animation && !committed && !animation.win.isDestroyed()) animation.win.webContents.send('pickgloss:layout', { phase: 'cancel', id: animation.id });
    clearTimeout(animationTimer); animationTimer = null; animation = null;
    if (running && notify) onStatus({ wide, windowTransitioning: false });
  }

  function finishAnimation() {
    const current = animation;
    if (!current) return;
    // 最后一帧仍保持抑制，避免同步 resize 回调记录动画尺寸。
    if (!current.win.isDestroyed()) {
      setWindowBounds(current.win, current.target);
      current.win.webContents.send('pickgloss:layout', { phase: 'commit', id: current.id });
    }
    stopAnimation(true, true);
    if (!current.win.isDestroyed()) rememberWindow('panel', current.win, false);
  }

  function animatePanel(win, target) {
    stopAnimation(false);
    if (reducedMotion) { setWindowBounds(win, target); rememberWindow('panel', win, false); onStatus({ wide, windowTransitioning: false }); return; }
    const current = animation = { win, target, id: ++layoutSerial };
    // 先让旧文字退出绘制，再一次提交目标尺寸；不再逐帧让 Win32 和 Chromium 同时重排。
    win.webContents.send('pickgloss:layout', { phase: 'prepare', id: current.id });
    // renderer 尚未载入或退出时仍能完成切换；过期 ACK 不得影响新切换。
    animationTimer = setTimeout(() => { if (animation === current) finishAnimation(); }, 100);
  }

  function layoutReady(event, id) {
    if (!animation || animation.id !== id || event.sender !== animation.win.webContents || event.senderFrame !== event.sender.mainFrame) return;
    finishAnimation();
  }
  ipcMain.on('pickgloss:layout-ready', layoutReady);

  function restoreWindowState(geometry) {
    stopAnimation(); panelTransition = null;
    const position = value => value && [value.x, value.y].every(n => Number.isFinite(n) && Math.abs(n) <= 100000)
      ? { x: Math.round(value.x), y: Math.round(value.y) } : null;
    panelPosition = position(geometry?.panel); orbPosition = position(geometry?.orb);
    for (const mode of ['compact', 'reading']) {
      const value = geometry?.sizes?.[mode];
      panelSizes[mode] = value && Number.isFinite(value.width) && value.width >= 215 && value.width <= 8192 &&
        Number.isFinite(value.height) && value.height >= 180 && value.height <= 8192
        ? { width: Math.round(value.width), height: Math.round(value.height) } : { ...DEFAULT_PANEL_SIZES[mode] };
    }
    wide = geometry?.wide === true;
    for (const kind of ['panel', 'orb']) {
      const win = windows.get(kind);
      if (!win || win.isDestroyed()) continue;
      const point = kind === 'panel' ? panelPosition : orbPosition;
      const bounds = { ...win.getBounds(), ...(point || {}), ...(kind === 'panel' ? panelSizes[wide ? 'reading' : 'compact'] : {}) };
      setWindowBounds(win, fitWindow(bounds, screen.getDisplayMatching(bounds).workArea));
      rememberWindow(kind, win, false);
    }
    return wide;
  }

  function recoverVisibleWindows() {
    if (animation) finishAnimation();
    if (capture) cancelCapture();
    closeMenu();
    orbDrag = null;
    for (const kind of ['panel', 'orb']) {
      const win = windows.get(kind);
      if (!win || win.isDestroyed()) continue;
      if (kind === 'orb' && orbController) { orbController.refresh(); continue; }
      const bounds = win.getBounds();
      setWindowBounds(win, fitWindow(bounds, screen.getDisplayMatching(bounds).workArea));
      rememberWindow(kind, win, false);
    }
  }

  function updateTray() {
    if (!tray) return;
    const darkTaskbar = nativeTheme?.shouldUseDarkColorsForSystemIntegratedUI ?? nativeTheme?.shouldUseDarkColors ?? false;
    const image = nativeImage.createFromPath(path.join(assets, darkTaskbar ? 'pickgloss-tray-dark.png' : 'pickgloss-tray-light.png'));
    tray.setImage(image);
  }

  function glassSupported() {
    return process.platform === 'win32' && Number(os.release().split('.')[2]) >= 22621 &&
      !nativeTheme?.prefersReducedTransparency && !nativeTheme?.shouldUseHighContrastColors && !nativeTheme?.inForcedColorsMode;
  }

  function applyWindowAppearance(kind, win) {
    // 悬浮球和划词入口始终使用透明窗口，截图框选保持自己的不透明画布。
    if (kind === 'translation') {
      if (!windowAppearances.has(win)) {
        const frame = createWindowAppearance(win, { clipRadius: 14,
          onReady() { if (!win.isDestroyed()) { applyWindowAppearance(kind, win); onStatus({ appearanceMaterial }); } },
          onError() {
            if (win.isDestroyed()) return;
            windowAppearances.set(win, null); applyWindowAppearance(kind, win); onStatus({ appearanceMaterial });
          } });
        windowAppearances.set(win, frame);
      }
      const frame = windowAppearances.get(win), requested = glassSupported();
      frame?.setBackdrop(requested);
      windowMaterials.set(win, requested && frame?.isReady ? 'glass' : 'solid');
      frame?.apply('none');
      // 透明控件窗保持透明；系统实时背景由助手按同一圆角裁切，备用底色由 CSS 绘制。
      return;
    }
    if (kind !== 'panel') return;
    if (clippedPanelFrame && !windowAppearances.has(win)) {
      const frame = createWindowAppearance(win, { clipRadius: 14,
        onReady() { if (!win.isDestroyed()) { applyWindowAppearance(kind, win); onStatus({ appearanceMaterial }); } },
        onError() {
        if (win.isDestroyed()) return;
        windowAppearances.set(win, null);
        applyWindowAppearance(kind, win);
        onStatus({ appearanceMaterial });
      } });
      windowAppearances.set(win, frame);
    }
    const frame = windowAppearances.get(win);
    const requested = appearance.current?.material === 'glass' && glassSupported();
    frame?.setBackdrop(requested);
    const material = requested && frame?.isReady ? 'glass' : 'solid';
    if (!windowMaterials.has(win)) win.setBackgroundMaterial?.('none');
    windowMaterials.set(win, material);
    // 只让背景层透明，不让文字与控件随整窗 opacity 变淡。系统材质没有可设置的高斯半径。
    win.setOpacity?.(1);
    // DWM 在同一原生圆角内合成实色与 acrylic；旧系统仅用透明画布绘制 CSS 圆角。
    win.setBackgroundColor?.('#00000000');
    frame?.apply('none');
    appearanceMaterial = material;
  }

  function systemPrefersReducedMotion() {
    try {
      const settings = systemPreferences?.getAnimationSettings();
      return settings?.prefersReducedMotion === true || settings?.shouldRenderRichAnimation === false;
    } catch { return false; }
  }

  function refreshAppearance() {
    const mode = appearance.current?.mode;
    appearanceDark = mode === 'dark' || (mode === 'system' && !!nativeTheme?.shouldUseDarkColors);
    reducedMotion = appearance.reducedMotion === true || systemPrefersReducedMotion();
    orbController?.configure({ ...orbPreferences, reducedMotion });
    appearanceMaterial = appearance.current?.material === 'glass' && glassSupported() ? 'glass' : 'solid';
    for (const [kind, win] of windows) if (!win.isDestroyed()) applyWindowAppearance(kind, win);
    if (reducedMotion && animation) finishAnimation();
    updateTray();
    onStatus({ appearanceDark, reducedMotion, appearanceMaterial, nativeRoundedFrame });
  }

  function setAppearance(value) {
    appearance = value && typeof value === 'object' ? value : { current: { mode: 'light', material: 'solid' } };
    const mode = appearance.current?.mode;
    if (nativeTheme && ['light', 'dark', 'system'].includes(mode) && nativeTheme.themeSource !== mode) nativeTheme.themeSource = mode;
    refreshAppearance();
  }

  function dragOrb(payload) {
    const win = windows.get('orb'), { phase, x, y } = payload || {};
    if (!win || win.isDestroyed() || !['start','move','end'].includes(phase) ||
      ![x,y].every(n => Number.isFinite(n) && Math.abs(n) <= 100000)) throw new Error('悬浮球拖动坐标无效。');
    const displays = screen.getAllDisplays?.();
    if (displays?.length && !displays.some(display => {
      const b = display.bounds || display.workArea;
      return x >= b.x - 256 && x <= b.x + b.width + 256 && y >= b.y - 256 && y <= b.y + b.height + 256;
    })) throw new Error('悬浮球拖动坐标不在当前屏幕范围。');
    return orbController?.drag(payload) || false;
  }

  nativeTheme?.on('updated', refreshAppearance);
  screen.on?.('display-removed', recoverVisibleWindows);
  screen.on?.('display-metrics-changed', recoverVisibleWindows);

  function windowFor(kind, options) {
    const { webPreferences = {}, ...browserOptions } = options || {};
    const win = new BrowserWindow({ width: 430, height: 650, show: false, frame: false, title: 'PickGloss', icon: path.join(assets, 'pickgloss-app.png'),
      backgroundColor: appearanceDark ? '#252525' : '#ffffff', autoHideMenuBar: true, skipTaskbar: true, alwaysOnTop: true,
      webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false, autoplayPolicy: 'no-user-gesture-required', ...webPreferences }, ...browserOptions });
    // 当前 Windows 运行时的默认层级可能仍落在普通窗口下；显式设置原生弹出层级。
    win.setAlwaysOnTop(browserOptions.alwaysOnTop !== false, browserOptions.alwaysOnTop === false ? undefined : 'pop-up-menu');
    windows.set(kind, win);
    const previousMaterial = appearanceMaterial;
    applyWindowAppearance(kind, win);
    if (appearanceMaterial !== previousMaterial) onStatus({ appearanceMaterial });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.webContents.on('will-attach-webview', event => event.preventDefault());
    win.on('closed', () => {if(windows.get(kind)===win)windows.delete(kind); if (animation?.win === win) stopAnimation(); if (kind === 'orb') { orbDrag = null; orbController?.dispose(); orbController = null; }});
    win.webContents.on('did-finish-load', () => { if (lastState && !win.isDestroyed()) win.webContents.send('pickgloss:state', surfaceState(kind, win, lastState)); });
    win.webContents.on('render-process-gone', () => {
      if(kind==='capture')cancelCapture();
      if(kind==='translation' || kind==='translation-overlay') {
        hideTranslation();
        if (lastState?.translation) onAction('close-translation', { id: lastState.translation.id });
      }
      if(!win.isDestroyed())win.destroy();
      onStatus({ error: '界面进程已退出，已保存的会话仍在。请从托盘重新打开 PickGloss。' });
    });
    void win.loadFile(html, { query: { window: kind } });
    return win;
  }

  function panel() {
    let win = windows.get('panel');
    if (win && !win.isDestroyed()) return win;
    const size = panelSizes[wide ? 'reading' : 'compact'];
    const bounds = panelPosition ? fitWindow({ ...panelPosition, ...size }, screen.getDisplayMatching({ ...panelPosition, ...size }).workArea) : size;
    win = windowFor('panel', { ...bounds, transparent: true, thickFrame: false, backgroundColor: '#00000000', resizable: false, minWidth: 215, minHeight: 260, hasShadow: false, roundedCorners: false });
    win.on('move', () => { rememberWindow('panel', win, false); });
    win.on('resize', () => {
      if (animation) return;
      const bounds = win.getBounds(), expected = programmedSizes.get(win);
      const manual = !expected || Math.abs(bounds.width - expected.width) > 1 || Math.abs(bounds.height - expected.height) > 1;
      // 只有用户调整才按实际宽度切换档位；程序避让较小工作区时仍保留目标布局。
      if (manual) {
        const actualWide = bounds.width >= 640;
        panelTransition = null;
        if (actualWide !== wide) {
          wide = actualWide;
          onStatus({ wide, windowTransitioning: false });
        }
      }
      rememberWindow('panel', win, manual);
    });
    win.on('will-move', (event, next) => {
      if (animation) {
        // 用户开始拖动时结束尺寸变形，保留用户拖动的目标位置。
        event.preventDefault();
        const target = animation.target; stopAnimation(); panelTransition = null;
        setWindowBounds(win, { ...target, x: next.x, y: next.y }); rememberWindow('panel', win, false);
      } else panelTransition = null;
    });
    win.on('will-resize', () => { stopAnimation(); programmedSizes.delete(win); panelTransition = null; });
    win.on('close', event => { if (!closing) { event.preventDefault(); win.hide(); } });
    win.on('blur', () => { if (!pinned && !capture && !menuWanted) win.hide(); });
    win.webContents.on('before-input-event', (event, input) => { if (input.type === 'keyDown' && input.key === 'Escape' && !lastState?.status?.shortcuts?.recording) { event.preventDefault(); win.hide(); } });
    return win;
  }

  function openPanel(point, options = {}) {
    panelResize = null;
    const existing = windows.get('panel');
    const win = panel();
    // 快捷命令先唤回窗口再反向切换时，保留当前帧，不提前完成或保存中间尺寸。
    if (!point && options.preserveTransition === true && animation?.win === win) {
      win.show(); win.focus(); dismiss(true); return;
    }
    if (animation) finishAnimation();
    if (point && !pinned) panelTransition = null;
    const anchor = point || screen.getCursorScreenPoint();
    const area = screen.getDisplayNearestPoint(anchor).workArea;
    const bounds = win.getBounds();
    const size = existing && !existing.isDestroyed() ? bounds : panelSizes[wide ? 'reading' : 'compact'];
    // 历史、设置和模式导航沿用用户摆好的窗口；新采集才在新的位置打开。
    setWindowBounds(win, (!point && (panelPosition || (existing && !existing.isDestroyed()))) || (pinned && panelPosition)
      ? fitWindow(bounds, screen.getDisplayMatching(bounds).workArea)
      : clampWindow(anchor, size, area));
    rememberWindow('panel', win, false);
    win.show(); win.focus(); dismiss(true);
  }

  function setOrb(visible) {
    showOrb = visible;
    let win = windows.get('orb');
    if (!visible) { orbDrag = null; win?.hide(); return; }
    if (!win) {
      const area = screen.getPrimaryDisplay().workArea;
      const initial = { width: 48, height: 48, ...(orbPosition || { x: area.x + area.width - 72, y: area.y + area.height - 76 }) };
      win = windowFor('orb', { ...fitWindow(initial, screen.getDisplayMatching(initial).workArea),
        transparent: true, backgroundColor: '#00000000', resizable: false, focusable: false, hasShadow: false });
      rememberWindow('orb', win);
      orbController = createOrbController({ win, screen, clock: { setTimeout, clearTimeout },
        onPosition(point) { orbPosition = { ...point }; queueWindowState(); },
        onState(orbState) { onStatus({ orbState }); } });
      orbController.configure({ ...orbPreferences, reducedMotion });
      orbController.refresh();
      win.once('ready-to-show', () => { if (showOrb && !capture) win.showInactive(); });
    } else if (!capture) win.showInactive();
  }

  function resizePanelGesture(payload) {
    if (!validResizePayload(payload)) throw new Error('窗口拉伸请求无效。');
    const win = windows.get('panel');
    if (!win || win.isDestroyed() || !win.isVisible() || capture) { panelResize = null; return false; }
    const { phase, edge, token, x, y } = payload;
    if (phase === 'start') {
      if (animation) finishAnimation();
      panelTransition = null;
      panelResize = { edge, token, x, y, bounds: { ...win.getBounds() } };
      return true;
    }
    if (!panelResize || panelResize.token !== token || panelResize.edge !== edge) return false;
    const next = panelResizeBounds(panelResize.bounds, edge, x - panelResize.x, y - panelResize.y);
    // 这是用户手动拉伸，必须进入原有尺寸记忆和单／双栏边界处理。
    programmedSizes.delete(win);
    const current = win.getBounds();
    if (['x','y','width','height'].some(key => current[key] !== next[key])) win.setBounds(next);
    if (phase === 'end') { panelResize = null; rememberWindow('panel', win); }
    return true;
  }

  function dismiss(cancelWorker = false) {
    if (pending?.requestId) {
      const record = selectionContexts.get(pending.requestId);
      if (record && !record.opened) selectionContexts.delete(pending.requestId);
    }
    pending = null; windows.get('selection')?.hide();
    if (cancelWorker && worker) {
      pendingCancellation = ++cancellationId;
      worker.postMessage({ type: 'cancel-pending', requestId: pendingCancellation });
    }
  }

  function selectionWindow() {
    const existing = windows.get('selection');
    if (existing && !existing.isDestroyed()) return existing;
    return windowFor('selection', { width: 34, height: 34, transparent: true, backgroundColor: '#00000000', resizable: false, focusable: false, hasShadow: false });
  }

  function finishSelectionContext(requestId, patch) {
    const record = selectionContexts.get(requestId);
    if (!record) return;
    selectionContexts.delete(requestId);
    const context = typeof patch.context === 'string' && patch.context.length <= 6000 ? patch.context : '';
    const update = { requestId, context, contextOrigin: context ? patch.contextOrigin || 'UIA 所在段落' : '',
      reason: typeof patch.reason === 'string' ? patch.reason : '', contextPending: false };
    Object.assign(record.data, update);
    if (record.opened) void Promise.resolve(record.acceptance).then(() => onSelectionContext?.(update)).catch(() => {
      onStatus({ error: '上下文暂未保存，已保留选定内容，可手动补充。' });
    });
  }

  function endSelectionContexts(reason) {
    for (const requestId of [...selectionContexts.keys()]) finishSelectionContext(requestId, { context: '', reason });
  }

  function showSelection(data) {
    if (capture || pausedSelection) return;
    const point = screen.screenToDipPoint(data.point);
    for (const win of windows.values()) {
      if (!win.isVisible()) continue;
      const b = win.getBounds();
      if (point.x >= b.x && point.y >= b.y && point.x <= b.x + b.width && point.y <= b.y + b.height) return;
    }
    dismiss();
    const requestId = data.requestId === undefined ? undefined : `${selectionGeneration}:${data.requestId}`;
    pending = { ...data, requestId, dipPoint: point }; selectionEntry++;
    if (pending.contextPending && requestId) {
      selectionContexts.set(requestId, { data: pending, opened: false, acceptance: null });
      while (selectionContexts.size > 32) finishSelectionContext(selectionContexts.keys().next().value, { context: '', reason: '上下文读取已结束，请手动补充或使用独立释义。' });
    }
    const win = selectionWindow();
    const expected = pending;
    const show = () => {
      if (pending !== expected) return;
      win.setBounds(placeSelectionEntry(point, {width:34,height:34}, screen.getDisplayNearestPoint(point).workArea));
      if (lastState) win.webContents.send('pickgloss:state', surfaceState('selection', win, lastState));
      win.showInactive();
    };
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', show); else show();
    // 保留最初的屏幕位置与材料，直到用户打开、取消或替换本次选区。
  }

  function nativeMenu() {
    const captureShortcut = lastState?.settings?.prefs?.shortcuts?.capture;
    const menu = Menu.buildFromTemplate([
      { label: '粘贴文字', click: () => onAction('navigate', {view:'paste'}) },
      { label: `截图框选${typeof captureShortcut === 'string' && captureShortcut ? `    ${captureShortcut}` : ''}`, click: () => onAction('start-capture') },
      { label: '会话历史', click: () => onAction('open-history') },
      { label: '常规设置', click: () => onAction('open-settings', { section: 'general' }) },
      { label: 'AI 服务设置', click: () => onAction('open-settings') },
      { label: '外观与主题', click: () => onAction('open-appearance') },
      { label: '快捷键设置', click: () => onAction('open-shortcuts') },
      { type: 'separator' },
      { label: showOrb ? '隐藏悬浮球' : '显示悬浮球', click: () => onAction('show-orb', {visible:!showOrb}) },
      { label: pausedSelection ? '开启划词入口' : '关闭划词入口', click: () => onAction('toggle-selection') },
      { type: 'separator' }, { label: '退出 PickGloss', click: () => onAction('quit') }
    ]);
    tray?.popUpContextMenu(menu);
  }

  function menu(payload = {}) {
    if (menuWanted) { closeMenu(); return false; }
    clearTimeout(menuHideTimer); menuHideTimer = null;
    const source = payload.source === 'panel' ? 'panel' : 'orb';
    if (source === 'orb') orbController?.setMenuOpen(true);
    const sourceWin = windows.get(source);
    const cursor = screen.getCursorScreenPoint();
    let anchor = { ...cursor, width: 1, height: 1 };
    if (sourceWin && !sourceWin.isDestroyed()) {
      const b = sourceWin.getBounds();
      anchor = source === 'panel' ? { x: b.x + b.width - 44, y: b.y + 6, width: 32, height: 32 } : b;
    }
    menuAnchor = anchor;
    const placement = placeMenu(anchor, { width: 240, height: menuHeight }, screen.getDisplayNearestPoint({ x: anchor.x, y: anchor.y }).workArea);
    menuOrigin = placement.origin; menuWanted = true; menuGeneration++; menuCloseReason = null;
    let win = windows.get('menu');
    if (!win || win.isDestroyed()) {
      menuLoaded = false;
      win = windowFor('menu', { ...placement.bounds, transparent: true, backgroundColor: '#00000000', resizable: false, focusable: true, hasShadow: false, webPreferences: { backgroundThrottling: false } });
      win.on('blur', () => {
        if (menuWanted) closeMenu({}, 'blur');
        if (menuCloseReason !== 'blur') return;
        // 仅真实失焦时，才按未固定窗口规则收起解释窗；显式 X/Esc 关闭不连带处理。
        setTimeout(() => { const currentPanel = windows.get('panel'); if (!pinned && !capture && !menuWanted && currentPanel && !currentPanel.isFocused()) currentPanel.hide(); }, 0);
      });
      win.webContents.on('before-input-event', (event, input) => { if (input.type === 'keyDown' && input.key === 'Escape') { event.preventDefault(); closeMenu(); } });
      win.on('closed', () => {
        if (windows.get('menu') && windows.get('menu') !== win) return;
        menuLoaded = false; menuWanted = false; clearTimeout(menuHideTimer); menuHideTimer = null;
        orbController?.setMenuOpen(false);
        onStatus({ menuOpen: false, menuGeneration, menuOrigin });
      });
    } else win.setBounds(placement.bounds);
    onStatus({ menuOpen: menuLoaded, menuGeneration, menuOrigin });
    if (menuLoaded) { win.show(); win.focus(); }
    return true;
  }

  function menuReady(payload = {}) {
    const win = windows.get('menu');
    if (!menuWanted || payload.generation !== menuGeneration || !win || win.isDestroyed()) return false;
    let resized = false;
    if (Number.isFinite(payload.height) && payload.height >= 120 && payload.height <= 1000 && menuAnchor) {
      menuHeight = Math.ceil(payload.height);
      const placement = placeMenu(menuAnchor, { width: 240, height: menuHeight }, screen.getDisplayNearestPoint(menuAnchor).workArea);
      const bounds = win.getBounds();
      if (['x','y','width','height'].some(key => bounds[key] !== placement.bounds[key])) { win.setBounds(placement.bounds); resized = true; }
      menuOrigin = placement.origin;
    }
    const first = !menuLoaded;
    menuLoaded = true;
    if (first) { win.show(); win.focus(); }
    if (first || resized) onStatus({ menuOpen: true, menuGeneration, menuOrigin });
    return true;
  }

  function closeMenu(payload = {}, reason = 'explicit') {
    if (payload.generation !== undefined && payload.generation !== menuGeneration) return false;
    const win = windows.get('menu');
    if (payload.finished === true) {
      if (menuWanted || payload.generation !== menuGeneration) return false;
      clearTimeout(menuHideTimer); menuHideTimer = null; win?.hide(); return true;
    }
    if (!menuWanted) return false;
    menuWanted = false; orbController?.setMenuOpen(false); menuCloseReason = reason; onStatus({ menuOpen: false, menuGeneration, menuOrigin });
    // 显式收起菜单后把焦点交回仍可见的解释窗，使下一次外部点击能正常触发失焦隐藏。
    const currentPanel = windows.get('panel');
    if (reason === 'explicit' && win?.isFocused() &&
        currentPanel && !currentPanel.isDestroyed() && currentPanel.isVisible()) currentPanel.focus();
    clearTimeout(menuHideTimer);
    const generation = menuGeneration;
    if (win?.isVisible()) menuHideTimer = setTimeout(() => { if (generation === menuGeneration && !menuWanted) win.hide(); menuHideTimer = null; }, reducedMotion ? 0 : 250);
    return true;
  }

  function initTray() {
    tray = new Tray(nativeImage.createFromPath(path.join(assets, 'pickgloss-tray-light.png')));
    updateTray();
    tray.setToolTip('PickGloss'); tray.on('click', nativeMenu); tray.on('right-click', nativeMenu); tray.on('double-click', () => onAction('open-history'));
  }

  function startSelection(enabled) {
    endSelectionContexts('划词监听已重新启动，本次上下文未能取得，请手动补充或使用独立释义。');
    pausedSelection = !enabled; selectionGeneration++; pendingCancellation = null; dismiss();
    if (worker) { worker.postMessage({type:'stop'}); worker.kill(); worker = null; }
    clearInterval(heartbeatTimer);
    if (!enabled) { onStatus({selection:'划词入口已关闭'}); return; }
    const binary = app.isPackaged ? path.join(process.resourcesPath,'native','ContextProbe.exe') : path.join(app.getAppPath(),'build','native','ContextProbe.exe');
    if (!fs.existsSync(binary)) { onStatus({selection:'段落验证助手未构建，可使用粘贴或截图'}); return; }
    // 隐藏加载入口页面，首次有效选区只需定位并显示。
    selectionWindow();
    const generation = selectionGeneration;
    const pids = [process.pid, ...BrowserWindow.getAllWindows().map(w=>w.webContents.getOSProcessId())].join(',');
    const child = utilityProcess.fork(path.join(__dirname,'selection-worker.cjs'), [binary,pids], {stdio:'ignore',serviceName:'PickGloss 选区监听'});
    worker = child; lastHeartbeat=Date.now();
    child.on('message', data => {
      if (generation !== selectionGeneration) return;
      if (data.type === 'pending-cancelled') {
        if (data.requestId === pendingCancellation) pendingCancellation = null;
        return;
      }
      if (data.type === 'selection-context') {
        finishSelectionContext(`${generation}:${data.requestId}`, data);
        return;
      }
      if (generation !== selectionGeneration || capture) return;
      if (pendingCancellation && (data.type === 'selection' || data.type === 'selection-too-long')) return;
      if (data.type === 'heartbeat') lastHeartbeat=Date.now();
      else if (data.type === 'ready') onStatus({selection:data.running?'划词入口已开启 · 不使用自动复制':'选区监听未启动，可使用粘贴或截图'});
      else if (data.type === 'selection' || data.type === 'selection-too-long') showSelection(data);
      else if (data.type === 'dismiss') dismiss();
      else if (data.type === 'pointer-down') {
        const point = screen.screenToDipPoint(data.point), win=windows.get('selection');
        if (win?.isVisible()) { const b=win.getBounds(); if (point.x>=b.x&&point.x<=b.x+b.width&&point.y>=b.y&&point.y<=b.y+b.height) return; }
        dismiss();
      } else if (data.type === 'error' || data.type === 'probe-unavailable') onStatus({selection:'选区读取暂不可用，请使用粘贴或截图'});
    });
    child.on('exit', () => {
      if (generation !== selectionGeneration || closing) return;
      endSelectionContexts('划词助手已退出，本次上下文未能取得，请手动补充或使用独立释义。');
      worker=null; onStatus({selection:'选区监听已退出，可从托盘重新开启'});
    });
    heartbeatTimer=setInterval(()=>{
      if (!worker || Date.now()-lastHeartbeat<20000 || capture) return;
      if (workerRestarts++ < 2) startSelection(true);
      else { startSelection(false); onStatus({selection:'选区监听无响应，已暂停；请使用粘贴或截图'}); }
    },5000);
  }

  function captureWindow(display) {
    let win = windows.get('capture');
    if (win && !win.isDestroyed()) { win.setBounds(display.bounds); return win; }
    // 框选层不用系统尺寸框和退隐动画，否则紧接着再截图会采到上一层的淡出残影。
    win = windowFor('capture', { ...display.bounds, transparent: false, thickFrame: false, roundedCorners: false, hasShadow: false, resizable: false, focusable: true, enableLargerThanScreen: true, webPreferences: { backgroundThrottling: false } });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.webContents.on('before-input-event', (event, input) => { if (input.key === 'Escape') { event.preventDefault(); cancelCapture(); } });
    return win;
  }

  function prepareCapture() {
    // 只预热空界面，不提前截屏或保存用户画面。
    if (closing || capture) return;
    sourceWatcher?.prepare?.();
    captureWindow(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()));
    const reader = nativeCaptureReader();
    if (reader) void reader.prepare().catch(() => releaseCaptureReader(reader));
  }

  function nativeCaptureReader() {
    if (!captureReader) {
      try { captureReader = captureFactory(); } catch { captureReader = null; }
    }
    return captureReader;
  }

  function releaseCaptureReader(reader) {
    if (reader !== captureReader) return;
    captureReader = null; reader.dispose();
  }

  async function captureScreen(display, expected) {
    const reader = nativeCaptureReader();
    if (reader && typeof screen.dipToScreenRect === 'function') {
      try {
        const rect = screen.dipToScreenRect(null, display.bounds);
        const result = await reader.capture(rect);
        if (capture !== expected) return null;
        const image = nativeImage.createFromBitmap(result.bitmap, { width: result.width, height: result.height });
        if (image.isEmpty()) throw Error('原生取图无效');
        expected.method = 'native'; return image;
      } catch { releaseCaptureReader(reader); }
    }
    if (capture !== expected) return null;
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(display.bounds.width * display.scaleFactor), height: Math.round(display.bounds.height * display.scaleFactor) }, fetchWindowIcons: false });
    const source = sources.find(value => value.display_id === String(display.id)) || (sources.length === 1 ? sources[0] : null);
    expected.method = 'electron';
    return source?.thumbnail || null;
  }

  async function beginCapture({ mode = 'explain' } = {}) {
    if (capture) return false;
    const hidingVisibleWindow = [...windows].some(([kind, win]) => kind !== 'capture' && win.isVisible());
    closeMenu(); windows.get('menu')?.hide();
    orbDrag = null;
    const display=screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const previous=[...windows.entries()].filter(([kind,win])=>kind!=='capture' && win.isVisible()).map(([key])=>key);
    const expected = capture = { id: randomUUID(), mode, previous, display, image: null, imageData: null };
    // 空 renderer 的加载与窗口退隐及屏幕读取并行，取消后复用空窗口，不保留旧图。
    try {
      // 窗口保持隐藏，仅提前加载空界面；实际读屏仍等待来源页快照。
      captureWindow(display);
      // 在框选层夺取前台前确定来源；从本应用菜单触发时由助手使用最后的外部窗口。
      // 框选工具栏允许从识图切到翻译，两个入口都在夺取前台前保留来源元数据。
      expected.source = sourceWatcher ? await sourceWatcher.capture() || null : null;
      if (capture !== expected) { sourceWatcher?.cancelCapture?.(expected.source); return false; }
      dismiss(true);
      for(const win of windows.values()) win.hide();
      // 有窗口退隐时留三帧合成预算；托盘或快捷键唤起且无自有窗口时直接取图。
      if (hidingVisibleWindow) await new Promise(resolve=>setTimeout(resolve,50));
      if (capture !== expected) return false;
      const image = await captureScreen(display, expected);
      if (capture !== expected) return false;
      if (!image || image.isEmpty()) throw new Error('未能读取当前屏幕，请重试截图。');
      await sourceWatcher?.sealCapture?.(expected.source);
      if (capture !== expected) { sourceWatcher?.cancelCapture?.(expected.source); return false; }
      capture.image=image;
      clearTimeout(captureReadyTimer);
      captureReadyTimer = setTimeout(() => { if (capture === expected) {
        cancelCapture(); onStatus({ error: '截图预览未能及时准备，请重新截图。' });
      } }, 5000);
      if (lastState) broadcast(lastState);
      return true;
    } catch (error) { if (capture !== expected) return false; cancelCapture(); throw error; }
  }

  function captureReady(payload = {}) {
    const win = windows.get('capture');
    if (!capture?.image || payload.id !== capture.id || !win || win.isDestroyed()) return false;
    clearTimeout(captureReadyTimer); captureReadyTimer = null;
    win.show(); win.focus(); return true;
  }

  function clearCaptureWindow() {
    clearTimeout(captureReadyTimer); captureReadyTimer = null;
    windows.get('capture')?.hide();
    if (lastState) broadcast({ ...lastState, capture: null });
  }

  function cancelCapture() {
    if (!capture) return;
    capture.restoreAbort?.abort();
    sourceWatcher?.cancelCapture?.(capture.source);
    const previous=capture.previous; capture=null; clearCaptureWindow();
    for(const key of previous) {
      if(key==='selection')continue;
      if (key === 'translation' || key === 'translation-overlay') {
        if (!translationPlacement || translationBinding && (translationBinding.state !== 'active' && !(key === 'translation' && translationControlsPinned) || key === 'translation-overlay' && translationBinding.invalid)) continue;
      }
      const win=windows.get(key); if(win&&!win.isDestroyed()) key==='panel'?win.show():win.showInactive();
    }
  }

  function finishCaptureWithPlacement(rect, { bindSource = capture?.mode === 'translate' } = {}) {
    if (!capture?.image) throw new Error('截图已取消，请重新框选。');
    const size = capture.image.getSize(), display = capture.display;
    const pixelRect=cropPixels(rect,display.bounds,size);
    const imageData=capture.image.crop(pixelRect).toDataURL();
    const placement = { displayId: display.id, displayBounds: { ...display.bounds },
      region: { x: display.bounds.x + pixelRect.x * display.bounds.width / size.width,
        y: display.bounds.y + pixelRect.y * display.bounds.height / size.height,
        width: pixelRect.width * display.bounds.width / size.width, height: pixelRect.height * display.bounds.height / size.height } };
    if (bindSource) {
      placement.sourceBinding = true;
      try { placement.source = sourceForRegion(capture.source, screen.dipToScreenRect(null, placement.region)); }
      catch { placement.source = null; }
    }
    capture=null; clearCaptureWindow(); sourceWatcher?.prepare?.(); if(showOrb) setOrb(true);
    return { imageData, placement };
  }
  async function restoreCaptureSource(rect) {
    const expected = capture;
    if (!expected?.image) throw new Error('截图已取消，请重新框选。');
    if (!sourceWatcher?.restore) return false;
    const size = expected.image.getSize(), display = expected.display, pixels = cropPixels(rect, display.bounds, size);
    const region = { x: display.bounds.x + pixels.x * display.bounds.width / size.width,
      y: display.bounds.y + pixels.y * display.bounds.height / size.height,
      width: pixels.width * display.bounds.width / size.width, height: pixels.height * display.bounds.height / size.height };
    let source;
    try { source = sourceForRegion(expected.source, screen.dipToScreenRect(null, region)); } catch { return false; }
    if (!source) return false;
    const abort = expected.restoreAbort = new AbortController();
    let restored = false;
    try { restored = await sourceWatcher.restore(source, { capture: windows.get('capture'), signal: abort.signal }); } catch {}
    finally { if (expected.restoreAbort === abort) delete expected.restoreAbort; }
    if (capture !== expected) throw new Error('截图已取消或更新，请重新框选。');
    return restored;
  }
  function finishCapture(rect) { return finishCaptureWithPlacement(rect).imageData; }

  function showTranslation(placement, displayMode, { resetPosition = false, extraHeight = 0, contentHeight, controlsPinned = false, activate = true } = {}) {
    translationControlsPinned = controlsPinned === true;
    const workArea = screen.getDisplayMatching(placement.region).workArea;
    const layout = translationLayout(placement, displayMode, { extraHeight, contentHeight, workArea });
    let overlay = windows.get('translation-overlay');
    if (!overlay || overlay.isDestroyed()) {
      overlay = windowFor('translation-overlay', { ...layout.bounds, alwaysOnTop: false, transparent: true, backgroundColor: '#00000000', thickFrame: false, resizable: false, movable: false, focusable: false, hasShadow: false, webPreferences: { backgroundThrottling: false } });
      overlay.setIgnoreMouseEvents(true);
    } else setWindowBounds(overlay, layout.bounds);
    let win = windows.get('translation');
    if (!win || win.isDestroyed()) {
      win = windowFor('translation', { ...layout.controlBounds, alwaysOnTop: translationControlsPinned, transparent: true, backgroundColor: '#00000000', thickFrame: false, resizable: false, roundedCorners: false, hasShadow: false, webPreferences: { backgroundThrottling: false } });
      win.on('close', event => { if (!closing) { event.preventDefault(); hideTranslation(); if (lastState?.translation) onAction('close-translation', { id: lastState.translation.id }); } });
    } else {
      const bounds = resetPosition || translationPlacement !== placement ? layout.controlBounds : fitWindow({ ...win.getBounds(), width: layout.controlBounds.width, height: layout.controlBounds.height }, screen.getDisplayMatching(win.getBounds()).workArea);
      setWindowBounds(win, bounds);
    }
    translationPlacement = placement;
    win.setAlwaysOnTop(translationControlsPinned, translationControlsPinned ? 'pop-up-menu' : undefined);
    if (placement.sourceBinding && translationBinding?.placement !== placement) {
      sourceWatcher?.clear();
      translationBinding = { placement, state: 'pending', invalid: false, activate };
      translationBinding.binding = sourceWatcher?.bind(placement.source, { overlay, controls: win });
      if (!translationBinding.binding) {
        translationBinding.state = 'active'; translationBinding.invalid = true;
        if (placement.source) void Promise.resolve().then(() => onAction('translation-source-invalid', { placement, reason: 'unavailable' })).catch(() => {});
      }
    }
    const sourceActive = !placement.sourceBinding || translationBinding?.state === 'active';
    const mayShow = !capture && (sourceActive || translationControlsPinned);
    if (activate) for (const value of [overlay, win]) {
      const show = () => { if (!value.isDestroyed() && translationPlacement === placement && mayShow &&
          (value === win && translationControlsPinned || !placement.sourceBinding || translationBinding?.state === 'active') && !(value === overlay && translationBinding?.invalid)) {
        value === overlay ? value.showInactive() : value.show();
      } };
      if (value.webContents.isLoading()) value.webContents.once('did-finish-load', show); else show();
    }
    if (activate && mayShow) win.focus();
    const actualControlBounds = win.getBounds();
    layout.controlBounds = { ...actualControlBounds };
    layout.controls = { ...layout.controls, width: actualControlBounds.width, height: actualControlBounds.height };
    return layout;
  }

  function setTranslationControlsPinned(enabled) {
    if (typeof enabled !== 'boolean') throw new Error('翻译菜单置顶状态无效。');
    translationControlsPinned = enabled;
    const win = windows.get('translation');
    if (!translationPlacement || !win || win.isDestroyed()) return;
    win.setAlwaysOnTop(enabled, enabled ? 'pop-up-menu' : undefined);
    if (!capture && (enabled || !translationBinding || translationBinding.state === 'active')) win.showInactive();
    else win.hide();
  }

  function sourceChanged(value) {
    const bound = translationBinding;
    if (!bound || value.binding !== bound.binding || translationPlacement !== bound.placement) return;
    const overlay = windows.get('translation-overlay'), controls = windows.get('translation');
    if (value.state === 'closed') {
      hideTranslation();
      void Promise.resolve(onAction('translation-source-closed', { placement: bound.placement })).catch(() => {});
      return;
    }
    if (value.state === 'moved' || value.state === 'unavailable' || value.state === 'context-invalid') {
      bound.invalid = true; bound.activate = false; overlay?.hide();
      if (value.state === 'unavailable' || value.state === 'context-invalid') {
        bound.state = value.state === 'context-invalid' && value.windowActive === false ? 'inactive' : 'active';
        if (!capture && (bound.state === 'active' || translationControlsPinned)) controls?.showInactive();
      }
      void Promise.resolve(onAction('translation-source-invalid', { placement: bound.placement, reason: value.state })).catch(() => {});
      return;
    }
    bound.state = value.state;
    if (value.state !== 'active') {
      bound.activate = false; overlay?.hide();
      if (translationControlsPinned && !capture) controls?.showInactive(); else controls?.hide();
      return;
    }
    if (capture) return;
    for (const win of [overlay, controls]) {
      if (!win || win.isDestroyed() || win === overlay && bound.invalid) continue;
      const show = () => {
        const allowed = translationBinding === bound && bound.state === 'active' && !win.isDestroyed() && !capture && !(win === overlay && bound.invalid);
        if (!allowed) return;
        win.showInactive();
        if (win === controls && bound.activate) { bound.activate = false; win.focus(); }
      };
      if (win.webContents.isLoading()) {
        win.webContents.once('did-finish-load', show);
      } else show();
    }
  }

  function resizeTranslationHeight(placement, contentHeight) {
    if (translationPlacement !== placement) return null;
    const win = windows.get('translation');
    if (!win || win.isDestroyed()) return null;
    const current = win.getBounds(), workArea = screen.getDisplayMatching(current).workArea;
    const height = Math.min(workArea.height, MAX_TRANSLATION_HEIGHT, Math.max(1, Math.ceil(contentHeight)));
    setWindowBounds(win, fitWindow({ ...current, height }, workArea));
    return { ...win.getBounds() };
  }

  function hideTranslation() {
    translationControlsPinned = false;
    translationBinding = null; sourceWatcher?.clear();
    translationPlacement = null;
    windows.get('translation')?.setAlwaysOnTop(false); windows.get('translation')?.hide(); windows.get('translation-overlay')?.hide();
  }

  function authorize(event, action) {
    const kind=surfaceFor(event);
    if (!kind) return false;
    if(kind==='panel') return !['capture-done','capture-cancel','capture-ready','selection-open','orb-drag','orb-hover','menu-ready','menu-close','translation-content-height','translation-source-invalid','translation-source-closed','pin-translation-controls'].includes(action);
    if(kind==='translation') return ['bootstrap','close-translation','retry-translation','set-translation-options','set-translation-preferences','copy-translation','preview-translation-original','translation-content-height','pin-translation-controls','start-capture','open-settings','open-link'].includes(action);
    if(kind==='translation-overlay') return action==='bootstrap';
    if(kind==='orb' && action==='orb-activate') return true;
    return ({orb:['bootstrap','menu','orb-drag','orb-hover','open-latest-session'], menu:['bootstrap','menu-ready','menu-close','navigate','pin','wide','open-history','open-settings','open-appearance','open-shortcuts','shortcut-command','show-orb','toggle-selection','start-capture','quit'], selection:['bootstrap','selection-open'],capture:['bootstrap','capture-ready','capture-done','capture-cancel','set-translation-preferences']}[kind]||[]).includes(action);
  }

  return { initTray, openPanel, startSelection, setOrb, menu, closeMenu, menuReady, prepareCapture, beginCapture, cancelCapture, finishCapture, finishCaptureWithPlacement, restoreCaptureSource, showTranslation, resizeTranslationHeight,
    hideTranslation, setTranslationControlsPinned, captureReady, authorize, stateFor,
    restoreWindowState, getWindowState, flushWindowState, setAppearance, dragOrb, resizePanel: resizePanelGesture,
    setOrbPreferences(prefs) { orbPreferences = { quietFadeEnabled: prefs?.orbQuietFade !== false, edgeCollapseEnabled: prefs?.orbEdgeCollapse !== false }; orbController?.configure({ ...orbPreferences, reducedMotion }); },
    hoverOrb(active) { if (typeof active !== 'boolean') throw new Error('悬浮球悬停状态无效。'); orbController?.hover(active); },
    async acceptSelection() {
      const data=pending;if(!data)throw new Error('选区入口已过期，请重新划词。');
      const record = data.requestId && selectionContexts.get(data.requestId);
      if (record) record.opened = true;
      const acceptance = data.type === 'selection-too-long' ? null : Promise.resolve().then(() => onSelection(data));
      if (record) record.acceptance = acceptance;
      dismiss(true);
      if(data.type==='selection-too-long')onStatus({error:'本次读取的文字超过 12000 个字符，请缩短选区后重试，或手动粘贴精简后的内容。',errorId:randomUUID()});
      else {
        await acceptance;
      }
      openPanel(data.dipPoint);
    },
    captureState, broadcast,
    hidePanel() {windows.get('panel')?.hide();},
    isPanelVisible() { const win=windows.get('panel');return Boolean(win&&!win.isDestroyed()&&win.isVisible()); },
    setPinned(value) { pinned = !!value; const win = windows.get('panel'); if (win) { win.setAlwaysOnTop(true, 'pop-up-menu'); applyWindowAppearance('panel', win); } },
    resetPanelSize() {
      const win = panel(), bounds = win.getBounds();
      stopAnimation();
      panelSizes.compact = { ...DEFAULT_PANEL_SIZES.compact };
      panelSizes.reading = { ...DEFAULT_PANEL_SIZES.reading };
      panelTransition = null;
      setWindowBounds(win, resizePanel(bounds, panelSizes[wide ? 'reading' : 'compact'], screen.getDisplayMatching(bounds).workArea));
      rememberWindow('panel', win, false);
      return wide;
    },
    setWide(value) {
      panelResize = null;
      // Windows 的减少动画偏好可能在应用运行期间改变，每次切换前重新查询。
      const nextReduced = appearance.reducedMotion === true || systemPrefersReducedMotion();
      if (nextReduced !== reducedMotion) { reducedMotion = nextReduced; onStatus({ reducedMotion }); }
      const win = panel(), bounds = win.getBounds();
      const nextWide = !!value;
      if (nextWide === wide) return;
      const wasAnimating = !!animation;
      const expected = programmedSizes.get(win);
      if (!wasAnimating && (!expected || Math.abs(bounds.width - expected.width) > 1 || Math.abs(bounds.height - expected.height) > 1)) {
        panelSizes[wide ? 'reading' : 'compact'] = { width: bounds.width, height: bounds.height };
      }
      wide = !!value;
      const area = screen.getDisplayMatching(bounds).workArea;
      // 原生落位可能产生像素取整差异，不能据此丢掉原小窗位置并重新选择左右边缘。
      // 真正的用户拖动或拉伸已在 will-move／will-resize 中清除这份往返位置。
      const origin = !wide && panelTransition ? panelTransition.compact : bounds;
      const next = resizePanel(origin, panelSizes[wide ? 'reading' : 'compact'], area);
      // 收窄过程中仍保留小窗原位，连续反向不会拿中间帧作为下一次的返回位置。
      if (wide) panelTransition = { compact: wasAnimating && panelTransition ? panelTransition.compact : bounds, reading: next };
      onStatus({ wide, windowTransitioning: true });
      animatePanel(win, next);
      queueWindowState();
    },
    flushDrafts() {
      const win=windows.get('panel');if(!win||win.isDestroyed())return Promise.resolve(true);
      return new Promise(resolve=>{
        const token=randomUUID();
        const finish=ok=>{clearTimeout(timer);ipcMain.removeListener('pickgloss:flushed',listener);resolve(ok);};
        const listener=(event,replyToken,ok)=>{if(event.sender===win.webContents&&event.senderFrame===win.webContents.mainFrame&&replyToken===token)finish(ok===true);};
        const timer=setTimeout(()=>finish(false),3000);
        ipcMain.on('pickgloss:flushed',listener);win.webContents.send('pickgloss:flush',token);
      });
    },
    async smoke() {const win=panel();await new Promise(resolve=>{if(win.webContents.isLoading())win.webContents.once('did-finish-load',resolve);else resolve();});return {windows:windows.size,displayCount:screen.getAllDisplays().length,rendererLoaded:!win.webContents.isLoading(),selectionWorker:!!worker};},
    dispose() {closing=true;selectionGeneration++;capture=null;sourceWatcher?.dispose();if(captureReader)releaseCaptureReader(captureReader);clearInterval(heartbeatTimer);clearTimeout(geometryTimer);clearTimeout(menuHideTimer);clearTimeout(captureReadyTimer);stopAnimation();nativeTheme?.removeListener('updated',refreshAppearance);screen.removeListener?.('display-removed',recoverVisibleWindows);screen.removeListener?.('display-metrics-changed',recoverVisibleWindows);worker?.postMessage({type:'stop'});worker?.kill();tray?.destroy();ipcMain.removeListener('pickgloss:layout-ready',layoutReady);for(const win of windows.values())win.destroy();}
  };
}
module.exports={createDesktop};
