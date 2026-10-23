'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { BrowserWindow, Menu, Tray, nativeImage, nativeTheme, systemPreferences, desktopCapturer, screen, utilityProcess, app, ipcMain } = require('electron');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
// 两种默认尺寸保持独立；用户自定义尺寸与位置由主进程持久化。
const DEFAULT_PANEL_SIZES = Object.freeze({
  compact: Object.freeze({ width: 300, height: 483 }),
  reading: Object.freeze({ width: 860, height: 690 }),
});
const { clampWindow, cropPixels, resizePanel, fitWindow, placeMenu, placeSelectionEntry } = require('./geometry.cjs');

function createDesktop({ onAction, onSelection, onStatus, onWindowState }) {
  const windows = new Map();
  const html = path.join(__dirname, '..', 'renderer', 'index.html');
  const htmlUrl = pathToFileURL(html).href;
  const preload = path.join(__dirname, '..', 'preload.cjs');
  const assets = path.join(__dirname, '..', 'renderer', 'assets');
  let tray, worker, pending, heartbeatTimer, lastHeartbeat = 0, workerRestarts = 0;
  let closing = false, capture = null, pinned = false, wide = false, showOrb = true;
  let selectionGeneration = 0, selectionEntry = 0, pausedSelection = false;
  let cancellationId = 0, pendingCancellation = null;
  const panelSizes = { compact: { ...DEFAULT_PANEL_SIZES.compact }, reading: { ...DEFAULT_PANEL_SIZES.reading } };
  let panelTransition = null, animation = null, animationTimer = null, orbDrag = null;
  let panelPosition = null, orbPosition = null, geometryTimer = null;
  let revision = 0, savedRevision = 0, submittedRevision = -1, persistence = Promise.resolve(true);
  let appearance = { current: { mode: 'light', material: 'solid' }, reducedMotion: false };
  let appearanceDark = false, reducedMotion = false, appearanceMaterial = 'solid', lastState = null;
  let menuGeneration = 0, menuWanted = false, menuLoaded = false, menuHideTimer = null, menuOrigin = 'top-left';
  let menuAnchor = null, menuHeight = 452;
  const programmedSizes = new WeakMap();
  const windowMaterials = new WeakMap();
  const deliveredCaptureIds = new WeakMap();
  let captureReadyTimer = null;
  // Windows 11 由 DWM 同时裁切背景材质和内容；透明分层窗口、HRGN 都会禁用系统抗锯齿圆角。
  const nativeRoundedFrame = process.platform === 'win32' && Number(os.release().split('.')[2]) >= 22000;
  let layoutSerial = 0;

  function captureState() {
    if (!capture?.image) return null;
    // 全尺寸 JPEG 仅用于背景预览，编码一次；原始 NativeImage 保留，裁剪仍输出原像素 PNG。
    if (!capture.imageData) capture.imageData = 'data:image/jpeg;base64,' + capture.image.toJPEG(92).toString('base64');
    return { id: capture.id, imageData: capture.imageData, width: capture.display.bounds.width, height: capture.display.bounds.height };
  }

  function surfaceFor(event) {
    const kind = [...windows].find(([,win]) => win.webContents.id === event.sender.id)?.[0];
    return kind && event.senderFrame === event.sender.mainFrame && event.senderFrame.url.startsWith(htmlUrl + '?') ? kind : null;
  }

  function surfaceState(kind, win, state, forceImage = false) {
    if (kind === 'selection') return { ...state, capture: null, selectionEntry };
    if (kind !== 'capture') return { ...state, capture: null };
    const image = captureState();
    if (!image) { deliveredCaptureIds.delete(win.webContents); return { ...state, capture: null }; }
    if (!forceImage && deliveredCaptureIds.get(win.webContents) === image.id) {
      return { ...state, capture: { id: image.id, width: image.width, height: image.height } };
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
    lastState = { ...state, capture: state.capture ? { id: state.capture.id, width: state.capture.width, height: state.capture.height } : null };
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
    if (kind !== 'panel') return;
    let material = appearance.current?.material === 'glass' && glassSupported() && typeof win.setBackgroundMaterial === 'function' ? 'glass' : 'solid';
    if (windowMaterials.get(win) !== material) {
      try { win.setBackgroundMaterial?.(material === 'glass' ? 'acrylic' : 'none'); }
      catch { material = 'solid'; try { win.setBackgroundMaterial?.('none'); } catch {} }
      windowMaterials.set(win, material);
    }
    // 只让背景层透明，不让文字与控件随整窗 opacity 变淡。系统材质没有可设置的高斯半径。
    win.setOpacity?.(1);
    // DWM 在同一原生圆角内合成实色与 acrylic；旧系统仅用透明画布绘制 CSS 圆角。
    const base = appearanceDark ? '#252525' : '#ffffff', current = appearance.current || {};
    const mono = current.accent === '#000000' && current.tint === '#bfc2c8';
    const paper = !current.tint || mono ? base : '#' + [1,3,5].map(i => Math.round(parseInt(current.tint.slice(i, i + 2), 16) * .06 + parseInt(base.slice(i, i + 2), 16) * .94).toString(16).padStart(2, '0')).join('');
    win.setBackgroundColor?.(nativeRoundedFrame && material === 'solid' ? paper : '#00000000');
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
    if (phase === 'start') { orbDrag = { x, y, bounds: { ...win.getBounds() } }; return true; }
    if (!orbDrag) return false;
    const bounds = { ...orbDrag.bounds, x: Math.round(orbDrag.bounds.x + x - orbDrag.x), y: Math.round(orbDrag.bounds.y + y - orbDrag.y) };
    win.setBounds(bounds);
    rememberWindow('orb', win);
    // 拖动过程不广播状态，保证 renderer 中的 pointer capture 不被重绘打断。
    if (phase === 'end') {
      orbDrag = null;
      win.setBounds(fitWindow(bounds, screen.getDisplayMatching(bounds).workArea));
      rememberWindow('orb', win);
    }
    return true;
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
    win.setAlwaysOnTop(true, 'pop-up-menu');
    windows.set(kind, win);
    const previousMaterial = appearanceMaterial;
    applyWindowAppearance(kind, win);
    if (appearanceMaterial !== previousMaterial) onStatus({ appearanceMaterial });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.webContents.on('will-attach-webview', event => event.preventDefault());
    win.on('closed', () => {if(windows.get(kind)===win)windows.delete(kind); if (animation?.win === win) stopAnimation(); if (kind === 'orb') orbDrag = null;});
    win.webContents.on('did-finish-load', () => { if (lastState && !win.isDestroyed()) win.webContents.send('pickgloss:state', surfaceState(kind, win, lastState)); });
    win.webContents.on('render-process-gone', () => {
      if(kind==='capture')cancelCapture();
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
    win = windowFor('panel', { ...bounds, transparent: !nativeRoundedFrame, thickFrame: nativeRoundedFrame, backgroundColor: '#00000000', resizable: true, minWidth: 215, minHeight: 260, hasShadow: true, roundedCorners: true });
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
    win.webContents.on('before-input-event', (event, input) => { if (input.key === 'Escape' && !lastState?.status?.shortcuts?.recording) { event.preventDefault(); win.hide(); } });
    return win;
  }

  function openPanel(point, options = {}) {
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
      win.on('move', () => rememberWindow('orb', win));
      rememberWindow('orb', win);
      win.once('ready-to-show', () => { if (showOrb && !capture) win.showInactive(); });
    } else if (!capture) win.showInactive();
  }

  function dismiss(cancelWorker = false) {
    pending = null; windows.get('selection')?.hide();
    if (cancelWorker && worker) {
      pendingCancellation = ++cancellationId;
      worker.postMessage({ type: 'cancel-pending', requestId: pendingCancellation });
    }
  }

  function showSelection(data) {
    if (capture || pausedSelection) return;
    const point = screen.screenToDipPoint(data.point);
    for (const win of windows.values()) {
      if (!win.isVisible()) continue;
      const b = win.getBounds();
      if (point.x >= b.x && point.y >= b.y && point.x <= b.x + b.width && point.y <= b.y + b.height) return;
    }
    pending = { ...data, dipPoint: point }; selectionEntry++;
    let win = windows.get('selection');
    if (!win) win = windowFor('selection', { width: 34, height: 34, transparent: true, backgroundColor: '#00000000', resizable: false, focusable: false, hasShadow: false });
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
    const menu = Menu.buildFromTemplate([
      { label: '粘贴文字', click: () => onAction('navigate', {view:'paste'}) },
      { label: '截图框选    Alt+Shift+S', click: () => onAction('start-capture') },
      { label: '会话历史', click: () => onAction('open-history') },
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
    const sourceWin = windows.get(source);
    const cursor = screen.getCursorScreenPoint();
    let anchor = { ...cursor, width: 1, height: 1 };
    if (sourceWin && !sourceWin.isDestroyed()) {
      const b = sourceWin.getBounds();
      anchor = source === 'panel' ? { x: b.x + b.width - 44, y: b.y + 6, width: 32, height: 32 } : b;
    }
    menuAnchor = anchor;
    const placement = placeMenu(anchor, { width: 240, height: menuHeight }, screen.getDisplayNearestPoint({ x: anchor.x, y: anchor.y }).workArea);
    menuOrigin = placement.origin; menuWanted = true; menuGeneration++;
    let win = windows.get('menu');
    if (!win || win.isDestroyed()) {
      menuLoaded = false;
      win = windowFor('menu', { ...placement.bounds, transparent: true, backgroundColor: '#00000000', resizable: false, focusable: true, hasShadow: false, webPreferences: { backgroundThrottling: false } });
      win.on('blur', () => {
        closeMenu();
        // 点回解释窗口只关闭菜单；点击其他应用时继续遵守未固定窗口的失焦规则。
        setTimeout(() => { const currentPanel = windows.get('panel'); if (!pinned && !capture && !menuWanted && currentPanel && BrowserWindow.getFocusedWindow?.() !== currentPanel) currentPanel.hide(); }, 0);
      });
      win.webContents.on('before-input-event', (event, input) => { if (input.key === 'Escape') { event.preventDefault(); closeMenu(); } });
      win.on('closed', () => { if (windows.get('menu') && windows.get('menu') !== win) return; menuLoaded = false; menuWanted = false; clearTimeout(menuHideTimer); });
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

  function closeMenu(payload = {}) {
    if (payload.generation !== undefined && payload.generation !== menuGeneration) return false;
    const win = windows.get('menu');
    if (payload.finished === true) {
      if (menuWanted || payload.generation !== menuGeneration) return false;
      clearTimeout(menuHideTimer); menuHideTimer = null; win?.hide(); return true;
    }
    if (!menuWanted) return false;
    menuWanted = false; onStatus({ menuOpen: false, menuGeneration, menuOrigin });
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
    pausedSelection = !enabled; selectionGeneration++; pendingCancellation = null; dismiss();
    if (worker) { worker.postMessage({type:'stop'}); worker.kill(); worker = null; }
    clearInterval(heartbeatTimer);
    if (!enabled) { onStatus({selection:'划词入口已关闭'}); return; }
    const binary = app.isPackaged ? path.join(process.resourcesPath,'native','ContextProbe.exe') : path.join(app.getAppPath(),'build','native','ContextProbe.exe');
    if (!fs.existsSync(binary)) { onStatus({selection:'段落验证助手未构建，可使用粘贴或截图'}); return; }
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
    win = windowFor('capture', { ...display.bounds, transparent: false, resizable: false, focusable: true, enableLargerThanScreen: true, webPreferences: { backgroundThrottling: false } });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.webContents.on('before-input-event', (event, input) => { if (input.key === 'Escape') { event.preventDefault(); cancelCapture(); } });
    return win;
  }

  async function beginCapture() {
    if (capture) return false;
    closeMenu(); windows.get('menu')?.hide();
    orbDrag = null;
    const display=screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const previous=[...windows.entries()].filter(([kind,win])=>kind!=='capture' && win.isVisible()).map(([key])=>key);
    const expected = capture = { id: randomUUID(), previous, display, image: null, imageData: null };
    // 空 renderer 的加载与窗口退隐及屏幕读取并行，取消后复用空窗口，不保留旧图。
    try {
      captureWindow(display); dismiss(true);
      for(const win of windows.values()) win.hide();
      await new Promise(resolve=>setTimeout(resolve,160));
      if (capture !== expected) return false;
      const sources=await desktopCapturer.getSources({types:['screen'],thumbnailSize:{width:Math.round(display.bounds.width*display.scaleFactor),height:Math.round(display.bounds.height*display.scaleFactor)},fetchWindowIcons:false});
      if (capture !== expected) return false;
      const source=sources.find(s=>s.display_id===String(display.id)) || (sources.length===1?sources[0]:null);
      if (!source || source.thumbnail.isEmpty()) throw new Error('未能读取当前屏幕，请重试截图。');
      capture.image=source.thumbnail;
      clearTimeout(captureReadyTimer);
      captureReadyTimer = setTimeout(() => { if (capture === expected) { cancelCapture(); onStatus({ error: '截图预览未能及时准备，请重新截图。' }); } }, 5000);
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
    const previous=capture.previous; capture=null; clearCaptureWindow();
    for(const key of previous) { if(key==='selection')continue; const win=windows.get(key); if(win&&!win.isDestroyed()) key==='panel'?win.show():win.showInactive(); }
  }

  function finishCapture(rect) {
    if (!capture?.image) throw new Error('截图已取消，请重新框选。');
    const pixelRect=cropPixels(rect,capture.display.bounds,capture.image.getSize());
    const imageData=capture.image.crop(pixelRect).toDataURL();
    capture=null; clearCaptureWindow(); if(showOrb) setOrb(true);
    return imageData;
  }

  function authorize(event, action) {
    const kind=surfaceFor(event);
    if (!kind) return false;
    if(kind==='panel') return !['capture-done','capture-cancel','capture-ready','selection-open','orb-drag','menu-ready','menu-close'].includes(action);
    if(kind==='orb' && action==='orb-activate') return true;
    return ({orb:['bootstrap','menu','orb-drag','open-latest-session'], menu:['bootstrap','menu-ready','menu-close','navigate','pin','wide','open-history','open-settings','open-appearance','open-shortcuts','shortcut-command','show-orb','toggle-selection','start-capture','quit'], selection:['bootstrap','selection-open'],capture:['bootstrap','capture-ready','capture-done','capture-cancel']}[kind]||[]).includes(action);
  }

  return { initTray, openPanel, startSelection, setOrb, menu, closeMenu, menuReady, beginCapture, cancelCapture, finishCapture, captureReady, authorize, stateFor,
    restoreWindowState, getWindowState, flushWindowState, setAppearance, dragOrb,
    async acceptSelection() {
      const data=pending;if(!data)throw new Error('选区入口已过期，请重新划词。');dismiss(true);
      if(data.type==='selection-too-long')onStatus({error:'本次读取的文字超过 12000 个字符，请缩短选区后重试，或手动粘贴精简后的内容。',errorId:randomUUID()});
      else await onSelection(data);
      openPanel(data.dipPoint);
    },
    captureState, broadcast,
    hidePanel() {windows.get('panel')?.hide();},
    isPanelVisible() { const win=windows.get('panel');return Boolean(win&&!win.isDestroyed()&&win.isVisible()); },
    setPinned(value) { pinned = !!value; windows.get('panel')?.setAlwaysOnTop(true, 'pop-up-menu'); },
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
    dispose() {closing=true;selectionGeneration++;capture=null;clearInterval(heartbeatTimer);clearTimeout(geometryTimer);clearTimeout(menuHideTimer);clearTimeout(captureReadyTimer);stopAnimation();nativeTheme?.removeListener('updated',refreshAppearance);screen.removeListener?.('display-removed',recoverVisibleWindows);screen.removeListener?.('display-metrics-changed',recoverVisibleWindows);worker?.postMessage({type:'stop'});worker?.kill();tray?.destroy();ipcMain.removeListener('pickgloss:layout-ready',layoutReady);for(const win of windows.values())win.destroy();}
  };
}
module.exports={createDesktop};
