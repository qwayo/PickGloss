'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

function clock(quantum = 0, timerDelays = []) {
  let next = 0, now = 0, timerIndex = 0;
  const timers = new Map();
  return { now: () => now,
    elapse(ms) { now += ms; },
    setTimeout(fn, delay = 0) { const at = now + delay, observed = timerDelays[timerIndex++]; timers.set(++next, { fn, at: observed !== undefined ? now + Math.max(delay, observed) : quantum ? Math.ceil(at / quantum) * quantum : at }); return next; }, clearTimeout(id) { timers.delete(id); },
    advance(ms) {
      const end = now + ms;
      while (true) {
        const first = [...timers].filter(([,timer]) => timer.at <= end).sort((a,b) => a[1].at - b[1].at)[0];
        if (!first) break;
        now = first[1].at; timers.delete(first[0]); first[1].fn();
      }
      now = Math.max(now, end);
    },
    fire() { for (const [id, timer] of [...timers]) { timers.delete(id); now = Math.max(now, timer.at); timer.fn(); } } };
}

// 使用真实桌面模块和假窗口，不创建 Electron 或访问用户桌面。
function desktopHarness({ loading = false, animate = false, blurOnHide = false, onWindowState, onSelection, onSelectionContext, windowsBuild = 26100, materialError = false, frameHelperMissing = false, timerQuantum = 0, timerDelays = [], nativeCost = 0, getSources, nativeCapture = null, dipScale = 1, sourceFactory } = {}) {
  const made = [], messages = [], statuses = [], selections = [], selectionUpdates = [], commands = [], actions = [], trays = [], menus = [], ipcMain = new EventEmitter(), time = clock(timerQuantum, timerDelays);
  const nativeTheme = Object.assign(new EventEmitter(), { shouldUseDarkColors: false, shouldUseDarkColorsForSystemIntegratedUI: false, themeSource: 'system' });
  const animationSettings = { prefersReducedMotion: !animate, shouldRenderRichAnimation: true };
  let workArea = { x: 0, y: 0, width: 1440, height: 900 }, focused = null;
  const worker = Object.assign(new EventEmitter(), { postMessage(value) { commands.push(value); }, kill() {} });
  class Window extends EventEmitter {
    static getAllWindows() { return made; }
    static getFocusedWindow() { return focused; }
    constructor(options) {
      super(); this.options = options; this.background = options.backgroundColor; this.destroyed = false; this.loading = loading; this.loads = 0; this.frames = []; this.frameTimes = []; this.bounds = { x: 0, y: 0, width: options.width, height: options.height, ...options };
      this.bounds = { x: this.bounds.x, y: this.bounds.y, width: this.bounds.width, height: this.bounds.height };
      this.webContents = Object.assign(new EventEmitter(), {
        id: made.length + 1, mainFrame: {}, isLoading: () => this.loading, setWindowOpenHandler() {},
        send: (...args) => { messages.push(args); this.messages.push(args); }, getOSProcessId: () => 10 + made.length,
      });
      this.messages = [];
      made.push(this);
    }
    loadFile(file, options) { this.loads++; this.kind = options.query.window; this.webContents.mainFrame.url = require('node:url').pathToFileURL(file).href + '?window=' + this.kind; return Promise.resolve(); }
    isDestroyed() { return this.destroyed; }
    setBounds(bounds) { const before = this.bounds; this.bounds = { ...bounds }; this.frames.push({ ...bounds }); this.frameTimes.push(time.now()); if (bounds.x !== before.x || bounds.y !== before.y) this.emit('move'); if (bounds.width !== before.width || bounds.height !== before.height) this.emit('resize'); time.elapse(nativeCost); }
    getBounds() { return this.bounds; }
    setOpacity(value) { this.opacity = value; }
    setBackgroundMaterial(value) { if (materialError && value === 'acrylic') throw new Error('测试系统不支持材质'); this.material = value; }
    setBackgroundColor(value) { this.background = value; }
    setAccentColor(value) { this.accent = value; }
    setShape(rects) { this.shape = rects; }
    setAlwaysOnTop(value, level) { this.alwaysOnTop = value; this.alwaysOnTopLevel = level; }
    setIgnoreMouseEvents(value) { this.ignoresMouse = value; }
    show() { const changed = !this.visible; this.visible = true; if (changed) this.emit('show'); } showInactive() { this.show(); } focus() { if (focused !== this) { const previous = focused; focused = this; previous?.emit('blur'); } } hide() { const changed = this.visible; this.visible = false; if (changed) this.emit('hide'); if (blurOnHide && focused === this) { focused = null; this.emit('blur'); } }
    isVisible() { return Boolean(this.visible); }
    isFocused() { return focused === this; }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  class FakeTray extends EventEmitter {
    constructor(image) { super(); this.image = image; trays.push(this); }
    popUpContextMenu(menu) { this.popupMenus ||= []; this.popupMenus.push(menu); }
    setImage(image) { this.image = image; } setToolTip(value) { this.tooltip = value; } destroy() {}
  }
  const display = () => ({ id: 1, bounds: workArea, workArea, scaleFactor: 2 });
  const electron = { BrowserWindow: Window, ipcMain, nativeTheme, desktopCapturer: { getSources: getSources || (async () => []) }, systemPreferences: { getAnimationSettings: () => animationSettings },
    Menu: { buildFromTemplate(template) { menus.push(template); return { template, popup() {} }; } }, Tray: FakeTray, nativeImage: { createFromPath: value => value,
      createFromBitmap: (_bytes, size) => ({ isEmpty: () => false, getSize: () => size, toJPEG: () => Buffer.from('虚构原生预览'), crop: () => ({ toDataURL: () => 'data:image/png;base64,虚构原生裁剪' }) }) },
    utilityProcess: { fork: () => worker }, app: { getAppPath: () => '测试程序目录' }, screen: Object.assign(new EventEmitter(), {
    getCursorScreenPoint: () => ({ x: 500, y: 300 }),
    getDisplayMatching: display, getPrimaryDisplay: display, getAllDisplays: () => [display()],
    getDisplayNearestPoint: display,
    screenToDipPoint: point => ({ x: Math.round(point.x / dipScale), y: Math.round(point.y / dipScale) }),
    dipToScreenRect: (_window, rect) => ({ x: rect.x * 2, y: rect.y * 2, width: rect.width * 2, height: rect.height * 2 }),
  }) };
  const target = path.join(__dirname, '../../src/windows/desktop.cjs'), mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(target, 'utf8'), {
    module: mod, exports: mod.exports, __dirname: path.dirname(target),
    require: name => name === 'electron' ? electron : name === 'node:perf_hooks' ? { performance: { now: time.now } } : name === 'node:os' ? { release: () => '10.0.' + windowsBuild } : name === 'node:fs' ? { ...fs, existsSync: () => true } : name === './window-appearance.cjs' ? {
      createWindowAppearance(win, options) {
        win.clipRadius = options.clipRadius;
        let ready = !(frameHelperMissing || materialError && options.clipRadius);
        let frame = null;
        win.frameReady = () => !!frame?.isReady;
        win.failFrame = () => { frame?.dispose(); options.onError(); };
        if (!ready) return null;
        frame = { get isReady() { return ready; }, setBackdrop(value) { win.backdropEnabled = value; }, apply(value) { win.nativeBorder = value; },
          dispose() { ready = false; win.backdropEnabled = false; } };
        return frame;
      },
    } : name === './screen-capture.cjs' ? { createScreenCapture: () => null } : name.startsWith('./') ? require(path.resolve(path.dirname(target), name)) : require(name),
    process: { pid: 1, platform: 'win32' }, Date: { now: time.now }, AbortController,
    ...time, clearInterval() {}, setInterval() {},
  });
  const desktop = mod.exports.createDesktop({ captureFactory: () => nativeCapture, sourceFactory, onAction: (...args) => actions.push(args), onSelection: data => { selections.push(data);return onSelection?.(data); },
    onSelectionContext: data => { selectionUpdates.push(data);return onSelectionContext?.(data); }, onStatus: value => statuses.push(value), onWindowState });
  desktop.setAppearance({ current: { mode: 'light', material: 'solid' }, reducedMotion: false }); statuses.length = 0;
  return { desktop, made, messages, statuses, selections, selectionUpdates, commands, worker, ipcMain, time, nativeTheme, animationSettings, trays, menus, actions,
    focusOutside() { const previous = focused; focused = null; previous?.emit('blur'); },
    changeDisplay(area) { workArea = area; electron.screen.emit('display-metrics-changed'); } };
}

test('桌面窗口显式使用原生置顶层级，固定状态切换不退回默认层级', () => {
  const { desktop, made, worker } = desktopHarness();
  desktop.openPanel(); desktop.setOrb(true);
  made.find(win => win.kind === 'orb').emit('ready-to-show');
  desktop.startSelection(true);
  worker.emit('message', { type: 'selection', text: '虚构选区', point: { x: 700, y: 300 } });
  desktop.menu({ source: 'panel' });
  for (const kind of ['panel', 'orb', 'selection', 'menu']) {
    const win = made.find(value => value.kind === kind);
    assert.ok(win, `${kind} 应创建窗口`);
    assert.equal(win.alwaysOnTop, true, `${kind} 不能只依赖构造选项置顶`);
    assert.equal(win.alwaysOnTopLevel, 'pop-up-menu', `${kind} 应设置能生效的原生层级`);
  }
  for (const pinned of [true, false]) {
    desktop.setPinned(pinned);
    assert.equal(made.find(win => win.kind === 'panel').alwaysOnTopLevel, 'pop-up-menu');
  }
});

test('Windows 11 主窗使用透明 14 DIP 裁切和独立背景助手，不创建第二扇光晕窗', () => {
  const { desktop, made } = desktopHarness(); desktop.openPanel(); const panel = made[0];
  for (const mode of ['light', 'dark']) for (const material of ['solid', 'glass']) {
    desktop.setAppearance({ current: { mode, material }, pinOutline: 'blue' });
    assert.equal(panel.options.transparent, true, 'CSS 内容与助手背景使用透明客户区');
    assert.equal(panel.options.thickFrame, false, '不再叠加系统非客户区边框');
    assert.equal(panel.options.roundedCorners, false, '圆角由助手背景按同一半径裁切');
    assert.equal(panel.clipRadius, 14);
    assert.equal(panel.frameReady(), true);
    assert.equal(panel.material, 'none', 'BrowserWindow 不再自行合成矩形亚克力');
    assert.equal(panel.backdropEnabled, material === 'glass');
    assert.equal(panel.nativeBorder, 'none');
    assert.equal(panel.background, '#00000000');
    assert.equal(panel.shape, undefined, '像素区域会禁用 DWM 的抗锯齿圆角');
  }
  desktop.setPinned(true); assert.equal(made.length, 1, '边缘光晕必须与主页面共用绘制表面');
});

test('悬浮球只获得最新会话入口权限，不接受任意会话、设置和布局修改', () => {
  const { desktop, made } = desktopHarness(); desktop.setOrb(true); const win = made[0];
  const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
  assert.equal(desktop.authorize(event, 'open-latest-session'), true);
  assert.equal(desktop.authorize(event, 'orb-activate'), true);
  for (const action of ['open-session','save-settings','wide','set-draft']) assert.equal(desktop.authorize(event, action), false);
});

test('重复唤回相同位置尺寸的窗口不再写入原生边界',()=>{
  const {desktop,made}=desktopHarness();desktop.openPanel();const panel=made[0];
  const original={...panel.getBounds()},writes=panel.frames.length;
  for(let i=0;i<30;i++)desktop.openPanel();
  assert.equal(panel.frames.length,writes,'避免原生边框反复取整导致每次扩大');
  assert.deepEqual({...panel.getBounds()},original);
});

test('旧系统保留 CSS 圆角透明画布，禁用不受支持的系统磨砂', () => {
  const { desktop, made, statuses } = desktopHarness({ windowsBuild: 19045 });
  desktop.setAppearance({ current: { mode: 'dark', material: 'glass' } }); desktop.openPanel();
  assert.equal(made[0].options.transparent, true); assert.equal(made[0].material, 'none');
  assert.equal(made[0].shape, undefined); assert.equal(statuses.at(-1).appearanceMaterial, 'solid');
});

test('磨砂与纯色都由透明主窗和 14 DIP 助手背景呈现，不使用原生不透明边色', () => {
  const { desktop, made } = desktopHarness(); desktop.openPanel(); const panel = made[0];
  desktop.setAppearance({ current: { mode: 'dark', material: 'glass' }, pinOutline: 'orange' });
  assert.equal(panel.material, 'none'); assert.equal(panel.backdropEnabled, true); assert.equal(panel.frameReady(), true);
  assert.equal(panel.nativeBorder, 'none'); assert.equal(panel.clipRadius, 14); assert.equal(panel.options.transparent, true);
  desktop.setPinned(true); assert.equal(panel.nativeBorder, 'none');
  desktop.setAppearance({ current: { mode: 'dark', material: 'glass' }, pinOutline: 'none' });
  assert.equal(panel.nativeBorder, 'none'); assert.equal(panel.backdropEnabled, true);
  desktop.setAppearance({ current: { mode: 'dark', material: 'solid' }, pinOutline: 'none' });
  assert.equal(panel.nativeBorder, 'none'); assert.equal(panel.backdropEnabled, false); assert.equal(panel.material, 'none');
});

test('窗口外观助手缺失或退出时回退纯色，避免留下无法去除的不透明磨砂边框', () => {
  for (const missing of [false, true]) {
    const { desktop, made, statuses } = desktopHarness({ frameHelperMissing: missing });
    desktop.setAppearance({ current: { mode: 'dark', material: 'glass' } }); desktop.openPanel();
    const panel = made[0];
    assert.equal(panel.options.transparent, true); assert.equal(panel.options.thickFrame, false); assert.equal(panel.clipRadius, 14);
    if (!missing) { assert.equal(panel.frameReady(), true); assert.equal(panel.backdropEnabled, true); panel.failFrame(); }
    assert.equal(panel.material, 'none'); assert.equal(panel.background, '#00000000');
    assert.equal(panel.frameReady(), false); assert.notEqual(panel.backdropEnabled, true, '助手缺失或退出后不能继续绘制磨砂背景');
    assert.equal(statuses.at(-1).appearanceMaterial, 'solid');
  }
});

test('恢复默认同时清除两种自定义尺寸，并保持当前布局和靠边位置', () => {
  const {desktop,made}=desktopHarness();
  desktop.openPanel();const win=made[0];
  win.setBounds({x:1100,y:100,width:340,height:520});
  desktop.setWide(true);
  win.setBounds({x:490,y:60,width:950,height:750});
  assert.equal(desktop.resetPanelSize(),true);
  assert.deepEqual({...win.getBounds()},{x:580,y:60,width:860,height:690});
  desktop.setWide(false);
  assert.equal(win.getBounds().width,300);assert.equal(win.getBounds().height,483);
  desktop.setWide(false);
  win.setBounds({x:1100,y:120,width:340,height:520});
  assert.equal(desktop.resetPanelSize(),false);
  assert.deepEqual({...win.getBounds()},{x:1140,y:120,width:300,height:483});
  desktop.setWide(true);
  assert.equal(win.getBounds().width,860);assert.equal(win.getBounds().height,690);
  assert.equal(desktop.resetPanelSize(),true);
  assert.equal(win.getBounds().width,860);
});

test('阅读切换往返恢复小窗位置，自由调整尺寸和历史导航不会重置布局', () => {
  const {desktop,made}=desktopHarness();
  desktop.openPanel();
  const win=made[0];
  win.setBounds({x:600,y:420,width:300,height:400});
  const original={...win.getBounds()};
  desktop.setWide(true);
  assert.equal(win.getBounds().width,860);
  desktop.setWide(false);
  assert.deepEqual({...win.getBounds()},original);
  desktop.openPanel();
  assert.deepEqual({...win.getBounds()},original);
  desktop.setWide(true);
  win.setBounds({x:400,y:100,width:950,height:700});
  desktop.setWide(false);
  assert.equal(win.getBounds().width,300);
  desktop.setWide(true);
  assert.equal(win.getBounds().width,950);
  assert.equal(win.getBounds().height,700);
});

test('右侧展开后原生位置回报发生一像素偏差，收回仍回到原来小窗位置', () => {
  for (const key of ['x','y','width','height']) for (const delta of [-1,1]) {
    const { desktop, made } = desktopHarness(); desktop.openPanel(); const win = made[0];
    const original = { x: 780, y: 100, width: 300, height: 483 }; win.setBounds(original);
    desktop.setWide(true);
    // 模拟原生落位回报，并非用户拖动的 will-move 或拉伸的 will-resize。
    win.setBounds({ ...win.getBounds(), [key]: win.getBounds()[key] + delta });
    desktop.setWide(false);
    assert.deepEqual({ ...win.getBounds() }, original, '不能按展开后的左边缘重新推算小窗位置');
    assert.equal(desktop.getWindowState().sizes.reading.width, 860, '取整不能改变阅读视图记忆尺寸');
  }
});

test('展开后主动拖到左侧，收缩仍尊重用户新摆放的位置', () => {
  const { desktop, made } = desktopHarness(); desktop.openPanel(); const win = made[0];
  win.setBounds({ x: 780, y: 100, width: 300, height: 483 }); desktop.setWide(true);
  const moved = { ...win.getBounds(), x: 40, y: 80 };
  win.emit('will-move', { preventDefault() {} }, moved); win.setBounds(moved);
  desktop.setWide(false); assert.equal(win.getBounds().x, 40); assert.equal(win.getBounds().y, 80);
});

test('新选区定位重置旧往返位置，固定窗口的新选区仍保留原位置', () => {
  for (const pinned of [false,true]) {
    const { desktop, made } = desktopHarness(); desktop.openPanel(); const win = made[0];
    win.setBounds({ x: 780, y: 100, width: 300, height: 483 }); desktop.setPinned(pinned); desktop.setWide(true);
    desktop.openPanel({ x: 20, y: 20 }); desktop.setWide(false);
    assert.equal(win.getBounds().x, pinned ? 780 : 32);
  }
});

test('手动越过阅读分界同步布局，收回小窗后再次展开恢复阅读自定义尺寸', () => {
  const { desktop, made, statuses } = desktopHarness();
  desktop.openPanel(); const win = made[0];
  win.emit('will-resize'); win.setBounds({ x: 117, y: 83, width: 335, height: 510 });
  win.emit('will-resize'); win.setBounds({ x: 117, y: 83, width: 950, height: 720 });
  assert.equal(desktop.getWindowState().wide, true);
  assert.deepEqual({ ...statuses.at(-1) }, { wide: true, windowTransitioning: false });
  assert.deepEqual({ ...desktop.getWindowState().sizes.compact }, { width: 335, height: 510 });
  assert.deepEqual({ ...desktop.getWindowState().sizes.reading }, { width: 950, height: 720 });
  desktop.setWide(false);
  assert.equal(win.getBounds().width, 335); assert.equal(win.getBounds().height, 510);
  assert.equal(desktop.getWindowState().wide, false);
  desktop.setWide(true);
  assert.equal(win.getBounds().width, 950); assert.equal(win.getBounds().height, 720);
  win.emit('will-resize'); win.setBounds({ x: 117, y: 83, width: 639, height: 600 });
  assert.equal(desktop.getWindowState().wide, false);
  assert.deepEqual({ ...statuses.at(-1) }, { wide: false, windowTransitioning: false });
  desktop.setWide(true); assert.equal(win.getBounds().width, 950);
  desktop.setWide(false); assert.equal(win.getBounds().width, 639);
});

test('不足阅读分界的工作区保留程序目标布局，按钮仍可返回小窗', () => {
  const { desktop, made, statuses, changeDisplay } = desktopHarness();
  changeDisplay({ x: 0, y: 0, width: 600, height: 800 });
  desktop.openPanel(); const win = made[0];
  desktop.setWide(true);
  assert.equal(win.getBounds().width, 600);
  assert.equal(desktop.getWindowState().wide, true);
  assert.equal(statuses.at(-1).wide, true);
  assert.equal(desktop.getWindowState().sizes.reading.width, 860);
  desktop.setWide(false);
  assert.equal(win.getBounds().width, 300); assert.equal(desktop.getWindowState().wide, false);
  desktop.setWide(true);
  assert.equal(win.getBounds().width, 600); assert.equal(desktop.getWindowState().wide, true);
  assert.equal(desktop.getWindowState().sizes.reading.width, 860);
});

test('窗口位置与两种自定义尺寸跨重启恢复，固定窗口的新划词保持原位', async () => {
  const saved = [];
  const first = desktopHarness({ onWindowState: async value => saved.push(JSON.parse(JSON.stringify(value))) });
  first.desktop.openPanel();
  const win = first.made[0];
  win.setBounds({ x: 117, y: 83, width: 335, height: 510 });
  first.desktop.setWide(true);
  win.setBounds({ x: 137, y: 93, width: 930, height: 720 });
  first.desktop.setOrb(true);
  const orb = first.made.find(item => item.kind === 'orb');
  const orbOrigin = { ...orb.getBounds() };
  first.desktop.dragOrb({ phase: 'start', x: orbOrigin.x + 20, y: orbOrigin.y + 20 });
  first.desktop.dragOrb({ phase: 'end', x: 341, y: 231 });
  assert.deepEqual({ ...orb.getBounds() }, { x: 321, y: 211, width: 48, height: 48 });
  assert.equal(await first.desktop.flushWindowState(), true);
  const second = desktopHarness();
  assert.equal(second.desktop.restoreWindowState(saved.at(-1)), true);
  second.desktop.openPanel(); second.desktop.setOrb(true);
  const restored = second.made.find(item => item.kind === 'panel');
  assert.deepEqual({ ...restored.getBounds() }, { x: 137, y: 93, width: 930, height: 720 });
  assert.deepEqual({ ...second.desktop.getWindowState().orb }, { x: 321, y: 211 });
  second.desktop.setPinned(true); second.desktop.openPanel({ x: 1250, y: 600 });
  assert.deepEqual({ ...restored.getBounds() }, { x: 137, y: 93, width: 930, height: 720 });
  second.desktop.setPinned(false); second.desktop.openPanel({ x: 1250, y: 600 });
  assert.notEqual(restored.getBounds().x, 137);
  second.desktop.setWide(false);
  assert.equal(restored.getBounds().width, 335); assert.equal(restored.getBounds().height, 510);
  const manual = { ...restored.getBounds() }; second.desktop.openPanel();
  assert.deepEqual({ ...restored.getBounds() }, manual);
});

test('恢复离屏位置和工作区变化时窗口可见，不覆盖较大屏幕上的自定义尺寸', () => {
  const { desktop, made, changeDisplay } = desktopHarness();
  desktop.restoreWindowState({ orb: { x: 5000, y: 4000 }, panel: { x: 5000, y: 4000 }, wide: true,
    sizes: { compact: { width: 335, height: 510 }, reading: { width: 1200, height: 780 } } });
  desktop.openPanel(); desktop.setOrb(true);
  changeDisplay({ x: -800, y: -50, width: 800, height: 600 });
  assert.deepEqual({ ...made[0].getBounds() }, { x: -800, y: -50, width: 800, height: 600 });
  assert.equal(desktop.getWindowState().sizes.reading.width, 1200);
  assert.equal(desktop.getWindowState().sizes.reading.height, 780);
  const orb = made.find(item => item.kind === 'orb').getBounds();
  assert.ok(orb.x >= -800 && orb.x + orb.width <= 0 && orb.y >= -50 && orb.y + orb.height <= 550);
  changeDisplay({ x: 0, y: 0, width: 1600, height: 1000 });
  desktop.setWide(false); desktop.setWide(true);
  assert.equal(made[0].getBounds().width, 1200); assert.equal(made[0].getBounds().height, 780);
});

test('展开先等旧文字退出绘制，再一次提交目标尺寸；反向不保存过渡尺寸', async () => {
  const writes = [];
  const { desktop, made, time, ipcMain, statuses } = desktopHarness({ animate: true, onWindowState: async value => writes.push(JSON.parse(JSON.stringify(value))) });
  desktop.openPanel(); const win = made[0]; win.setBounds({ x: 1010, y: 150, width: 335, height: 510 });
  const compact = { ...win.getBounds() }; win.frames.length = 0;
  desktop.setWide(true);
  const prepare = win.messages.filter(([channel]) => channel === 'pickgloss:layout').at(-1)[1];
  assert.equal(prepare.phase, 'prepare'); assert.deepEqual({ ...win.getBounds() }, compact);
  const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
  ipcMain.emit('pickgloss:layout-ready', { ...event, senderFrame: {} }, prepare.id);
  assert.equal(win.frames.length, 0, '子框架不能确认布局');
  ipcMain.emit('pickgloss:layout-ready', event, prepare.id);
  assert.equal(win.frames.length, 1); assert.equal(win.getBounds().width, 860);
  assert.equal(statuses.at(-1).windowTransitioning, false);
  desktop.setWide(false); desktop.setWide(true); desktop.setWide(false); time.advance(150);
  assert.deepEqual({ ...win.getBounds() }, compact);
  assert.equal(await desktop.flushWindowState(), true);
  for (const write of writes) { assert.equal(write.sizes.compact.width, 335); assert.equal(write.sizes.reading.width, 860); }
});

test('快捷命令唤回与迟到布局确认不能先跳到旧目标', () => {
  const { desktop, made, ipcMain, time } = desktopHarness({ animate: true }); desktop.openPanel(); const win = made[0];
  desktop.setWide(true); const old = win.messages.filter(([c]) => c === 'pickgloss:layout').at(-1)[1];
  desktop.openPanel(undefined, { preserveTransition: true }); assert.equal(win.getBounds().width, 300);
  desktop.setWide(false);
  ipcMain.emit('pickgloss:layout-ready', { sender: win.webContents, senderFrame: win.webContents.mainFrame }, old.id);
  assert.equal(win.getBounds().width, 300); time.advance(150); assert.equal(win.getBounds().width, 300);
});

test('普通打开与带新选区的打开继续完成现有动画，不受保留过渡选项影响', () => {
  const { desktop, made, time } = desktopHarness({ animate: true });
  desktop.openPanel(); const win = made[0];
  desktop.setWide(true); time.advance(80); desktop.openPanel(); assert.equal(win.getBounds().width, 860);
  desktop.setWide(false); time.advance(80); desktop.openPanel({ x: 50, y: 60 }, { preserveTransition: true });
  assert.deepEqual({ ...win.getBounds() }, { x: 62, y: 74, width: 300, height: 483 });
});

test('粗计时、原生调用耗时与提前唤醒均不再触发逐帧原生缩放', () => {
  for (const options of [{}, { timerQuantum: 15.625, nativeCost: 2 }, { timerQuantum: 15.625, timerDelays: [15.625, 8, 20.5], nativeCost: 2 }]) {
    const { desktop, made, time } = desktopHarness({ animate: true, ...options }); desktop.openPanel(); const win = made[0];
    win.frames.length = 0; desktop.setWide(true); time.advance(370);
    assert.equal(win.frames.length, 1); assert.equal(win.getBounds().width, 860);
  }
});

test('手动移动或调整尺寸会清理窗口动画，用户尺寸保持独立', async () => {
  const { desktop, made, time } = desktopHarness({ animate: true });
  desktop.openPanel(); const win = made[0];
  desktop.setWide(true); time.advance(80);
  const event = { prevented: false, preventDefault() { this.prevented = true; } };
  win.emit('will-move', event, { ...win.getBounds(), x: 123, y: 87 });
  assert.equal(event.prevented, true);
  time.advance(500);
  assert.deepEqual({ ...win.getBounds() }, { x: 123, y: 87, width: 860, height: 690 });
  desktop.setWide(false); time.advance(80);
  win.emit('will-resize'); win.setBounds({ x: 133, y: 97, width: 420, height: 610 }); time.advance(500);
  assert.deepEqual({ ...win.getBounds() }, { x: 133, y: 97, width: 420, height: 610 });
  assert.equal(desktop.getWindowState().sizes.compact.width, 420);
  assert.equal(desktop.getWindowState().sizes.reading.width, 860);
  assert.equal(await desktop.flushWindowState(), true);
});

test('系统或应用减少动态效果时直接完成原生窗口切换', () => {
  const { desktop, made, time, animationSettings } = desktopHarness({ animate: true });
  desktop.openPanel(); animationSettings.prefersReducedMotion = true;
  desktop.setWide(true); assert.equal(made[0].getBounds().width, 860);
  animationSettings.prefersReducedMotion = false;
  desktop.setAppearance({ current: { mode: 'dark', material: 'solid' }, reducedMotion: true });
  desktop.setWide(false); assert.equal(made[0].getBounds().width, 300);
  time.advance(500); assert.equal(made[0].getBounds().width, 300);
});

test('窗口写盘防抖且串行，失败保留内存并在退出刷新时重试', async () => {
  let fail = true, release;
  const writes = [];
  const { desktop, made, time, statuses } = desktopHarness({ onWindowState: async value => {
    writes.push(JSON.parse(JSON.stringify(value)));
    if (fail) throw new Error('测试写入失败');
    if (release === undefined) await new Promise(resolve => { release = resolve; });
  } });
  desktop.openPanel(); const win = made[0];
  win.setBounds({ x: 101, y: 77, width: 340, height: 520 });
  win.setBounds({ x: 131, y: 97, width: 360, height: 540 });
  time.advance(219); await Promise.resolve(); assert.equal(writes.length, 0);
  time.advance(1); await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes.length, 1); assert.match(statuses.at(-1).error, /暂未写入磁盘/);
  assert.equal(desktop.getWindowState().sizes.compact.width, 360);
  fail = false;
  const pending = desktop.flushWindowState(); await new Promise(resolve => setImmediate(resolve));
  win.setBounds({ x: 151, y: 107, width: 370, height: 550 });
  assert.equal(writes.length, 2); release(); assert.equal(await pending, true);
  assert.equal(await desktop.flushWindowState(), true);
  assert.equal(writes.at(-1).sizes.compact.width, 370);
});

test('悬浮球拖动依据原生起始位置计算，拒绝非数值与越界输入且只授权悬浮球', () => {
  const { desktop, made, statuses, messages } = desktopHarness();
  desktop.setOrb(true); desktop.openPanel();
  const orb = made.find(item => item.kind === 'orb'), panel = made.find(item => item.kind === 'panel');
  const origin = { ...orb.getBounds() };
  assert.equal(desktop.dragOrb({ phase: 'move', x: 1000, y: 500 }), false);
  desktop.dragOrb({ phase: 'start', x: origin.x + 30, y: origin.y + 30 });
  const statusCount = statuses.length, messageCount = messages.length;
  desktop.dragOrb({ phase: 'move', x: origin.x - 103, y: origin.y - 57 });
  assert.equal(orb.getBounds().x, origin.x - 133); assert.equal(orb.getBounds().y, origin.y - 87);
  assert.deepEqual({ ...desktop.getWindowState().orb }, { x: origin.x, y: origin.y }, '拖动过程不持久化临时位置');
  desktop.dragOrb({ phase: 'move', x: origin.x - 93, y: origin.y - 47 });
  assert.equal(orb.getBounds().x, origin.x - 123, '多次 move 不能累计同一段位移');
  assert.equal(statuses.length, statusCount, 'move 不重复发布悬浮球状态'); assert.equal(messages.length, messageCount, 'move 不广播全局窗口状态');
  assert.ok(statuses.every(status => Object.keys(status).length === 1 && status.orbState), '悬浮球状态不混入全局状态');
  for (const x of [NaN, Infinity, '1', 100001, -5000]) assert.throws(() => desktop.dragOrb({ phase: 'move', x, y: 10 }));
  assert.throws(() => desktop.dragOrb({ phase: 'unknown', x: 1, y: 1 }));
  const event = win => ({ sender: win.webContents, senderFrame: win.webContents.mainFrame });
  assert.equal(desktop.authorize(event(orb), 'orb-drag'), true);
  assert.equal(desktop.authorize(event(panel), 'orb-drag'), false);
  assert.equal(desktop.authorize({ sender: orb.webContents, senderFrame: { url: orb.webContents.mainFrame.url } }, 'orb-drag'), false);
  desktop.dragOrb({ phase: 'end', x: 701, y: 501 });
  assert.deepEqual({ ...desktop.getWindowState().orb }, { x: 671, y: 471 }, '松手后保存最终展开位置');
  assert.equal(desktop.dragOrb({ phase: 'move', x: 703, y: 503 }), false);
});

test('原生主题跟随系统，托盘使用系统任务栏明暗并提供外观菜单', () => {
  const { desktop, made, nativeTheme, statuses, trays, menus, actions } = desktopHarness();
  desktop.openPanel(); desktop.setOrb(true); desktop.initTray();
  const win = made[0];
  desktop.setAppearance({ current: { mode: 'system', material: 'glass', tint: '#bfc2c8', opacity: 82, blur: 26 }, reducedMotion: false });
  assert.equal(win.material, 'none'); assert.equal(win.opacity, 1); assert.equal(win.background, '#00000000');
  assert.equal(win.clipRadius, 14); assert.equal(win.frameReady(), true); assert.equal(win.backdropEnabled, true);
  nativeTheme.shouldUseDarkColors = true; nativeTheme.shouldUseDarkColorsForSystemIntegratedUI = true; nativeTheme.emit('updated');
  assert.equal(statuses.at(-1).appearanceDark, true); assert.equal(statuses.at(-1).appearanceMaterial, 'glass');
  assert.match(trays[0].image, /pickgloss-tray-dark\.png$/); assert.equal(trays[0].tooltip, 'PickGloss');
  nativeTheme.shouldUseDarkColorsForSystemIntegratedUI = false; nativeTheme.emit('updated');
  assert.match(trays[0].image, /pickgloss-tray-light\.png$/);
  desktop.setAppearance({ current: { mode: 'dark', material: 'solid' }, reducedMotion: false });
  assert.equal(win.material, 'none'); assert.equal(win.background, '#00000000'); assert.equal(win.opacity, 1); assert.equal(win.options.transparent, true);
  assert.equal(win.backdropEnabled, false);
  assert.equal(made.find(item => item.kind === 'orb').options.transparent, true);
  assert.equal(win.options.title, 'PickGloss'); assert.match(win.options.icon, /pickgloss-app\.png$/);
  trays[0].emit('click');
  assert.equal(trays[0].popupMenus.length, 1, '左键应使用所属托盘的原生弹出入口');
  assert.equal(trays[0].popupMenus[0].template, menus[0]);
  menus[0].find(item => item.label === '外观与主题').click();
  assert.deepEqual(actions.at(-1), ['open-appearance']);
  trays[0].emit('right-click');
  assert.equal(trays[0].popupMenus.length, 2, '右键应使用所属托盘的原生弹出入口');
  assert.equal(trays[0].popupMenus[1].template, menus[1]);
});

test('托盘菜单显示当前截图快捷键并提供常规设置入口', () => {
  const { desktop, trays, menus, actions } = desktopHarness();
  desktop.broadcast({ settings: { prefs: { shortcuts: { capture: 'Ctrl+Shift+S' } } } });
  desktop.initTray(); trays[0].emit('click');
  const screenshotItem = menus[0].find(item => item.label.startsWith('截图框选'));
  assert.equal(screenshotItem.label, '截图框选    Ctrl+Shift+S');
  screenshotItem.click(); assert.deepEqual(actions.at(-1), ['start-capture']);
  menus[0].find(item => item.label === '常规设置').click();
  assert.equal(actions.at(-1)[0], 'open-settings'); assert.equal(actions.at(-1)[1].section, 'general');

  desktop.broadcast({ settings: { prefs: { shortcuts: { capture: 'F8' } } } });
  trays[0].emit('right-click');
  assert.equal(menus[1].find(item => item.label.startsWith('截图框选')).label, '截图框选    F8');

  desktop.broadcast({ settings: { prefs: { shortcuts: { capture: '' } } } });
  trays[0].emit('click');
  assert.equal(menus[2].find(item => item.label.startsWith('截图框选')).label, '截图框选');
});

test('置顶与无描边均不创建独立光晕窗，窗口显示和尺寸始终归主窗', () => {
  const { desktop, made, time } = desktopHarness({ animate: true }); desktop.openPanel(); const win = made[0];
  for (const pinOutline of ['blue', 'none', 'orange']) {
    desktop.setAppearance({ current: { mode: 'dark', material: 'glass' }, pinOutline }); desktop.setPinned(true);
    desktop.setWide(true); time.advance(150); assert.equal(win.getBounds().width, 860);
    desktop.setWide(false); time.advance(150); assert.equal(win.getBounds().width, 300);
    assert.equal(made.length, 1); assert.equal(win.isVisible(), true);
  }
  desktop.setPinned(false); desktop.dispose(); time.advance(500); assert.equal(made.length, 1);
});

test('悬浮球与划词入口保留阴影空间，菜单首次等 renderer 就绪后显示', () => {
  const { desktop, made, statuses, worker } = desktopHarness({ loading: true });
  desktop.setOrb(true); assert.equal(made[0].options.width, 48); assert.equal(made[0].options.height, 48);
  desktop.startSelection(true); worker.emit('message', { type: 'selection', text: '虚构选区', point: { x: 40, y: 70 } });
  const selection = made.find(win => win.kind === 'selection');
  assert.equal(selection.options.width, 34); assert.equal(selection.options.height, 34);
  desktop.menu({ source: 'orb' });
  const menu = made.find(win => win.kind === 'menu'), generation = statuses.at(-1).menuGeneration;
  assert.equal(menu.options.transparent, true); assert.equal(menu.options.width, 240); assert.equal(menu.options.height, 452);
  assert.equal(menu.isVisible(), false);
  assert.equal(statuses.at(-1).menuOpen, false);
  assert.equal(statuses.at(-1).menuOrigin, 'bottom-right');
  assert.equal(desktop.menuReady({ generation: generation - 1 }), false);
  assert.equal(desktop.menuReady({ generation }), true);
  assert.equal(menu.isVisible(), true); assert.equal(statuses.at(-1).menuOpen, true);
  assert.equal(menu.options.webPreferences.autoplayPolicy, 'no-user-gesture-required');
  assert.equal(menu.options.webPreferences.backgroundThrottling, false); assert.equal(menu.options.webPreferences.sandbox, true); assert.equal(menu.options.webPreferences.contextIsolation, true);
});

test('菜单渲染器崩溃后解除悬浮球暂停，重新允许贴边收起和静默淡化', () => {
  const { desktop, made, statuses, time } = desktopHarness();
  desktop.restoreWindowState({ orb: { x: 0, y: 200 } });
  desktop.setOrb(true);
  const orb = made.find(win => win.kind === 'orb');
  time.advance(1000);
  assert.equal(orb.getBounds().width, 12);
  desktop.menu({ source: 'orb' });
  assert.equal(orb.getBounds().width, 48);
  assert.equal(statuses.filter(value => value.orbState).at(-1).orbState.menuOpen, true);
  made.find(win => win.kind === 'menu').webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  time.advance(16000);
  const state = statuses.filter(value => value.orbState).at(-1).orbState;
  assert.equal(state.menuOpen, false);
  assert.equal(state.collapsed, true);
  assert.equal(state.dimmed, true);
  assert.equal(orb.getBounds().width, 12);
});

test('菜单按内容高度收紧，只接纳本轮尺寸并在小屏幕内避让', () => {
  const { desktop, made, statuses, changeDisplay } = desktopHarness(); desktop.menu();
  const win = made[0], generation = statuses.at(-1).menuGeneration;
  assert.equal(desktop.menuReady({ generation, height: 434 }), true); assert.equal(win.getBounds().height, 434);
  const count = statuses.length;
  desktop.menuReady({ generation, height: 434 }); assert.equal(statuses.length, count, '相同测量不循环广播');
  for (const height of [NaN, Infinity, 0, 100000]) { desktop.menuReady({ generation, height }); assert.equal(win.getBounds().height, 434); }
  desktop.closeMenu(); desktop.menu();
  assert.equal(desktop.menuReady({ generation, height: 500 }), false, '旧菜单的迟到测量不能改变新窗口');
  changeDisplay({ x: 0, y: 0, width: 320, height: 220 }); desktop.menu();
  desktop.menuReady({ generation: statuses.at(-1).menuGeneration, height: 434 });
  assert.equal(win.getBounds().height, 220); assert.ok(win.getBounds().y >= 0);
});

test('菜单关闭等待动画确认，快速重新打开拒绝旧确认，Esc和失焦都有关闭兜底', () => {
  const { desktop, made, statuses, time } = desktopHarness({ animate: true });
  desktop.menu(); const win = made[0];
  const first = statuses.at(-1).menuGeneration; desktop.menuReady({ generation: first });
  desktop.closeMenu(); assert.equal(win.isVisible(), true);
  time.advance(110); assert.equal(win.isVisible(), true);
  desktop.menu(); const second = statuses.at(-1).menuGeneration;
  assert.ok(second > first); assert.equal(win.isVisible(), true);
  assert.equal(desktop.closeMenu({ generation: first, finished: true }), false);
  time.advance(300); assert.equal(win.isVisible(), true);
  const event = { prevented: false, preventDefault() { this.prevented = true; } };
  win.webContents.emit('before-input-event', event, { key: 'Escape', type: 'keyDown' });
  assert.equal(event.prevented, true); assert.equal(statuses.at(-1).menuOpen, false);
  assert.equal(desktop.closeMenu({ generation: second, finished: true }), true); assert.equal(win.isVisible(), false);
  desktop.menu(); win.emit('blur'); time.advance(250); assert.equal(win.isVisible(), false);
});

test('菜单 X 和 Esc 关闭后窗口失焦，不连带隐藏解释窗', () => {
  for (const closeBy of ['X', 'Esc']) {
    const { desktop, made, statuses, time } = desktopHarness({ blurOnHide: true });
    desktop.openPanel();
    const panel = made.find(win => win.kind === 'panel');
    desktop.menu({ source: 'panel' });
    const menu = made.find(win => win.kind === 'menu'), generation = statuses.at(-1).menuGeneration;
    desktop.menuReady({ generation });
    assert.equal(panel.isVisible(), true);

    if (closeBy === 'X') desktop.closeMenu({ generation });
    else {
      const event = { prevented: false, preventDefault() { this.prevented = true; } };
      menu.webContents.emit('before-input-event', event, { key: 'Escape', type: 'keyDown' });
      assert.equal(event.prevented, true);
    }

    time.advance(250);
    assert.equal(menu.isVisible(), false, `${closeBy} 应关闭菜单`);
    assert.equal(panel.isVisible(), true, `${closeBy} 不应连带隐藏解释窗`);
  }
});

test('菜单因点击其他窗口而失焦时，仍按未固定状态隐藏解释窗', () => {
  const { desktop, made, statuses, time } = desktopHarness();
  desktop.openPanel();
  const panel = made.find(win => win.kind === 'panel');
  desktop.menu({ source: 'panel' });
  const menu = made.find(win => win.kind === 'menu');
  desktop.menuReady({ generation: statuses.at(-1).menuGeneration });

  menu.emit('blur');
  time.advance(0);
  assert.equal(statuses.at(-1).menuOpen, false);
  assert.equal(panel.isVisible(), false);
});

test('显式关闭菜单后仍会响应下一次外部点击，固定窗口继续可见', () => {
  for (const pinned of [false, true]) for (const closeBy of ['X', 'Esc']) for (const finished of [false, true]) {
    const { desktop, made, statuses, time, focusOutside } = desktopHarness({ blurOnHide: true, animate: true });
    desktop.openPanel(); desktop.setPinned(pinned);
    const panel = made.find(win => win.kind === 'panel');
    desktop.menu({ source: 'panel' });
    const menu = made.find(win => win.kind === 'menu'), generation = statuses.at(-1).menuGeneration;
    desktop.menuReady({ generation });
    if (closeBy === 'X') desktop.closeMenu({ generation });
    else menu.webContents.emit('before-input-event', { preventDefault() {} }, { key: 'Escape', type: 'keyDown' });
    if (finished) { desktop.closeMenu({ generation, finished: true }); time.advance(250); }
    assert.equal(panel.isVisible(), true, '关闭菜单当下保留解释窗');
    focusOutside(); time.advance(300);
    assert.equal(panel.isVisible(), pinned, `${closeBy} 后${finished ? '动画结束' : '动画期间'}点击外部必须遵守固定状态`);
  }
});

test('Esc 收起菜单交回焦点后，抬键不能继续关闭解释窗', () => {
  const { desktop, made, statuses, time } = desktopHarness({ blurOnHide: true });
  desktop.openPanel(); const panel = made.find(win => win.kind === 'panel');
  desktop.menu({ source: 'panel' }); const menu = made.find(win => win.kind === 'menu');
  desktop.menuReady({ generation: statuses.at(-1).menuGeneration });
  menu.webContents.emit('before-input-event', { preventDefault() {} }, { key: 'Escape', type: 'keyDown' });
  panel.webContents.emit('before-input-event', { preventDefault() {} }, { key: 'Escape', type: 'keyUp' });
  time.advance(300);
  assert.equal(panel.isVisible(), true, '同一次 Esc 的抬键不能穿透关闭解释窗');
});

test('菜单初次加载期间关闭不会迟到重开，点击回主窗只关闭菜单', () => {
  const { desktop, made, statuses, time } = desktopHarness({ loading: true });
  desktop.openPanel(); const panel = made[0]; desktop.menu({ source: 'panel' });
  const first = statuses.at(-1).menuGeneration;
  desktop.closeMenu(); assert.equal(desktop.menuReady({ generation: first }), false);
  const menu = made.find(win => win.kind === 'menu'); menu.loading = false; menu.webContents.emit('did-finish-load');
  assert.equal(menu.isVisible(), false);
  desktop.menu({ source: 'panel' }); const second = statuses.at(-1).menuGeneration;
  assert.equal(desktop.menuReady({ generation: second }), true);
  assert.equal(panel.isVisible(), true, '打开菜单时主窗失焦不能隐藏');
  panel.focus(); time.advance(0);
  assert.equal(panel.isVisible(), true); assert.equal(statuses.at(-1).menuOpen, false);
});

test('菜单 surface 只授权有限动作，快捷键录制期间主窗 Esc 交给页面', () => {
  const { desktop, made } = desktopHarness(); desktop.openPanel(); desktop.menu();
  const panel = made.find(win => win.kind === 'panel'), menu = made.find(win => win.kind === 'menu');
  const eventFor = win => ({ sender: win.webContents, senderFrame: win.webContents.mainFrame });
  for (const action of ['bootstrap','menu-ready','menu-close','navigate','pin','wide','open-history','open-settings','open-appearance','open-shortcuts','shortcut-command','show-orb','toggle-selection','start-capture','quit']) assert.equal(desktop.authorize(eventFor(menu), action), true, action);
  for (const action of ['orb-drag','save-settings','new-text','start-explanation','copy-answer','shortcut-recording']) assert.equal(desktop.authorize(eventFor(menu), action), false, action);
  assert.equal(desktop.authorize(eventFor(panel), 'menu-ready'), false);
  assert.equal(desktop.authorize(eventFor(panel), 'shortcut-recording'), true);
  desktop.broadcast({ status: { shortcuts: { recording: true } } });
  const event = { prevented: false, preventDefault() { this.prevented = true; } };
  panel.webContents.emit('before-input-event', event, { key: 'Escape', type: 'keyDown' });
  assert.equal(event.prevented, false); assert.equal(panel.isVisible(), true);
  desktop.setPinned(false); assert.equal(panel.alwaysOnTop, true);
});

test('不支持磨砂或系统减少透明时关闭助手背景并回退 CSS 实色，迟到加载仍收到状态', () => {
  for (const options of [{ windowsBuild: 19045 }, { materialError: true }, {}]) {
    const { desktop, made, nativeTheme, statuses, messages } = desktopHarness({ ...options, loading: true });
    if (!Object.keys(options).length) nativeTheme.prefersReducedTransparency = true;
    desktop.setAppearance({ current: { mode: 'light', material: 'glass' }, reducedMotion: false });
    desktop.openPanel(); desktop.setOrb(true);
    const panel = made[0];
    assert.equal(panel.material, 'none'); assert.equal(panel.background, '#00000000'); assert.equal(panel.options.transparent, true);
    assert.notEqual(panel.backdropEnabled, true, '不支持磨砂时不能留下助手背景');
    if (options.windowsBuild === 19045) assert.equal(panel.clipRadius, undefined, '旧系统使用 CSS 圆角，不创建裁切助手');
    else { assert.equal(panel.clipRadius, 14); assert.equal(panel.frameReady(), options.materialError !== true); }
    assert.ok(statuses.some(status => status.appearanceMaterial === 'solid'), '当前主窗回退状态应单独广播');
    const state = { settings: { prefs: { appearance: { current: { mode: 'dark' } } } } };
    desktop.broadcast(state); assert.equal(messages.length, 0);
    for (const win of made) { win.loading = false; win.webContents.emit('did-finish-load'); }
    assert.equal(messages.length, 2);
    desktop.broadcast(state); assert.equal(messages.length, 4);
    for (const message of messages) { assert.equal(message[1].settings, state.settings); assert.equal(message[1].capture, null); }
  }
});

test('翻译控制窗独立使用亚克力，不改变主窗口或原位覆盖的材质', () => {
  const { desktop, made, nativeTheme } = desktopHarness();
  desktop.setAppearance({ current: { mode: 'dark', material: 'solid' } }); desktop.openPanel();
  const placement = { region: { x: 100, y: 100, width: 200, height: 100 }, displayBounds: { x: 0, y: 0, width: 1440, height: 900 } };
  desktop.showTranslation(placement, 'overlay');
  const controls = made.find(win => win.kind === 'translation'), overlay = made.find(win => win.kind === 'translation-overlay');
  assert.equal(controls.backdropEnabled, true); assert.equal(controls.options.transparent, true);
  assert.equal(controls.clipRadius, 14); assert.equal(controls.nativeBorder, 'none'); assert.equal(controls.options.hasShadow, false);
  assert.equal(controls.material, undefined, '透明控件窗不能再启用矩形系统背景');
  assert.equal(made.find(win => win.kind === 'panel').material, 'none');
  assert.equal(overlay.material, undefined, '截图覆盖不得添加背景材质');
  const event = { sender: controls.webContents, senderFrame: controls.webContents.mainFrame };
  const state = { status: { appearanceMaterial: 'solid' }, settings: {} };
  assert.equal(desktop.stateFor(event, state).status.appearanceMaterial, 'glass');
  assert.equal(desktop.authorize(event, 'translation-content-height'), true, '仅控制窗可反馈翻译内容高度');
  const overlayEvent = { sender: overlay.webContents, senderFrame: overlay.webContents.mainFrame };
  assert.equal(desktop.authorize(overlayEvent, 'translation-content-height'), false, '截图覆盖窗不能调整控制窗');
  const panel = made.find(win => win.kind === 'panel');
  assert.equal(desktop.authorize({ sender: panel.webContents, senderFrame: panel.webContents.mainFrame }, 'translation-content-height'), false, '主面板不能调整翻译控制窗');
  assert.equal(state.status.appearanceMaterial, 'solid', '独立材质状态不能反写主窗口状态');
  nativeTheme.prefersReducedTransparency = true; nativeTheme.emit('updated');
  assert.equal(controls.backdropEnabled, false); assert.equal(controls.background, '#00000000');
  assert.equal(desktop.stateFor(event, state).status.appearanceMaterial, 'solid');
});

test('翻译控制窗在旧系统、材质错误或外观助手失效时使用可读备用表面', () => {
  for (const options of [{ windowsBuild: 19045 }, { materialError: true }, { frameHelperMissing: true }]) {
    const { desktop, made } = desktopHarness(options);
    const placement = { region: { x: 100, y: 100, width: 200, height: 100 }, displayBounds: { x: 0, y: 0, width: 1440, height: 900 } };
    desktop.showTranslation(placement, 'overlay');
    const controls = made.find(win => win.kind === 'translation');
    assert.equal(controls.material, undefined);
    assert.equal(controls.background, '#00000000', '备用实色由 CSS 圆角表面绘制，不能填充整块原生窗口');
    const event = { sender: controls.webContents, senderFrame: controls.webContents.mainFrame };
    assert.equal(desktop.stateFor(event, { status: {} }).status.appearanceMaterial, 'solid');
  }
});

test('覆盖译文固定在原选区，独立移动控制窗口不带动覆盖且切换对照保留控制位置', () => {
  const { desktop, made } = desktopHarness();
  const placement = { region: { x: 240, y: 200, width: 360, height: 180 }, displayBounds: { x: 0, y: 0, width: 1440, height: 900 } };
  desktop.showTranslation(placement, 'overlay');
  const overlay = made.find(win => win.kind === 'translation-overlay');
  const controls = made.find(win => win.kind === 'translation');
  assert.ok(overlay, '原位覆盖必须使用独立窗口'); assert.ok(controls);
  const eventFor = win => ({ sender: win.webContents, senderFrame: win.webContents.mainFrame });
  assert.equal(desktop.authorize(eventFor(controls), 'set-translation-preferences'), true, '控制窗可保存语言选择');
  assert.equal(desktop.authorize(eventFor(controls), 'open-link'), true, '控制窗可打开用户点击的联网来源');
  assert.equal(desktop.authorize(eventFor(overlay), 'open-link'), false, '只读覆盖窗不能打开外链');
  assert.equal(desktop.authorize(eventFor(overlay), 'set-translation-preferences'), false, '只读覆盖窗不能修改语言默认值');
  const before = { ...overlay.getBounds() };
  controls.setBounds({ ...controls.getBounds(), x: 780, y: 480 });
  assert.deepEqual({ ...overlay.getBounds() }, before);
  desktop.showTranslation(placement, 'compare');
  assert.deepEqual({ ...overlay.getBounds() }, before);
  assert.equal(controls.getBounds().x, 780); assert.equal(controls.getBounds().y, 480);
  assert.equal(overlay.options.movable, false); assert.equal(overlay.options.focusable, false);
  assert.equal(overlay.ignoresMouse, true, '覆盖图不能挡住原软件交互');
  desktop.hideTranslation(); assert.equal(overlay.isVisible(), false); assert.equal(controls.isVisible(), false);
});

test('翻译状态调整高度不重新显示隐藏窗口或夺取其他窗口的焦点', () => {
  const { desktop, made, focusOutside } = desktopHarness();
  const placement = { region: { x: 240, y: 200, width: 200, height: 80 }, displayBounds: { x: 0, y: 0, width: 1440, height: 900 } };
  desktop.showTranslation(placement, 'overlay');
  const controls = made.find(win => win.kind === 'translation');
  const before = { ...controls.getBounds() }; focusOutside();
  desktop.showTranslation(placement, 'overlay', { extraHeight: 20, activate: false });
  assert.equal(controls.isFocused(), false); assert.ok(controls.getBounds().height > before.height);
  assert.equal(controls.getBounds().x, before.x); assert.equal(controls.getBounds().y, before.y);
  desktop.hideTranslation();
  desktop.showTranslation(placement, 'overlay', { activate: false });
  assert.equal(controls.isVisible(), false); assert.equal(controls.isFocused(), false);
  assert.equal(controls.getBounds().height, before.height);
});

test('覆盖译文离开截图来源后隐藏，返回时恢复且后台结果不把它带到其他应用', () => {
  let notify;
  const { desktop, made, focusOutside } = desktopHarness({ sourceFactory: ({ onChange }) => {
    notify = onChange;
    return { capture: async () => null, bind: () => 7, clear() {}, dispose() {} };
  } });
  const placement = { sourceBinding: true, source: { handle: '99', pid: 42, bounds: { x: 100, y: 100, width: 1000, height: 700 } },
    region: { x: 240, y: 200, width: 200, height: 80 }, displayBounds: { x: 0, y: 0, width: 1440, height: 900 } };
  desktop.showTranslation(placement, 'overlay');
  const overlay = made.find(win => win.kind === 'translation-overlay'), controls = made.find(win => win.kind === 'translation');
  notify?.({ binding: 7, state: 'active' });
  focusOutside();
  notify?.({ binding: 7, state: 'inactive' });
  assert.equal(overlay.isVisible(), false, '切到其他应用或桌面后不能继续覆盖');
  assert.equal(controls.isVisible(), false, '控制窗应随来源一起隐藏');
  desktop.showTranslation(placement, 'overlay', { extraHeight: 20, activate: false });
  assert.equal(overlay.isVisible(), false, '后台翻译完成不能重显覆盖');
  notify?.({ binding: 6, state: 'active' });
  assert.equal(overlay.isVisible(), false, '过期来源事件不能恢复新结果');
  notify?.({ binding: 7, state: 'active' });
  assert.equal(overlay.isVisible(), true); assert.equal(controls.isVisible(), true);
  assert.equal(controls.isFocused(), false, '恢复来源时不得抢走原软件焦点');
  desktop.hideTranslation();
  notify?.({ binding: 7, state: 'active' });
  assert.equal(overlay.isVisible(), false, '关闭后迟到事件不得重显');
});

test('截图来源移动后停止旧位置覆盖，来源关闭后关闭本次翻译', () => {
  let notify;
  const { desktop, made, actions } = desktopHarness({ sourceFactory: ({ onChange }) => {
    notify = onChange; return { capture: async () => null, bind: () => 8, clear() {}, dispose() {} };
  } });
  const placement = { sourceBinding: true, source: { handle: '99', pid: 42, bounds: { x: 100, y: 100, width: 1000, height: 700 } },
    region: { x: 240, y: 200, width: 200, height: 80 }, displayBounds: { x: 0, y: 0, width: 1440, height: 900 } };
  desktop.showTranslation(placement, 'overlay');
  const overlay = made.find(win => win.kind === 'translation-overlay');
  notify?.({ binding: 8, state: 'active' });
  notify?.({ binding: 8, state: 'moved' });
  assert.equal(overlay.isVisible(), false, '移动来源后不能覆盖旧坐标');
  assert.ok(actions.some(([name]) => name === 'translation-source-invalid'), '应保留对照译文并报告旧位置失效');
  notify?.({ binding: 8, state: 'active' });
  assert.equal(overlay.isVisible(), false, '旧位置失效后返回来源也不能恢复覆盖');
});

test('页面先失效、覆盖renderer后加载完成时，迟到显示回调不能复活旧覆盖', () => {
  let notify;
  const { desktop, made, actions } = desktopHarness({ loading: true, sourceFactory: ({ onChange }) => {
    notify = onChange; return { capture: async () => null, bind: () => 17, clear() {}, dispose() {} };
  } });
  const placement = { sourceBinding: true, source: { handle: '99', pid: 42, bounds: { x: 100, y: 100, width: 1000, height: 700 } },
    region: { x: 240, y: 200, width: 200, height: 80 }, displayBounds: { x: 0, y: 0, width: 1440, height: 900 } };
  desktop.showTranslation(placement, 'overlay', { activate: false, controlsPinned: true });
  const overlay = made.find(win => win.kind === 'translation-overlay'), controls = made.find(win => win.kind === 'translation');
  notify({ binding: 17, state: 'active', windowActive: true });
  notify({ binding: 17, state: 'context-invalid', windowActive: true });
  overlay.loading = false; overlay.webContents.emit('did-finish-load');
  controls.loading = false; controls.webContents.emit('did-finish-load');
  assert.equal(overlay.isVisible(), false, '导航后旧的加载回调不能重显覆盖');
  assert.equal(controls.isVisible(), true, '置顶菜单仍然保留');
  assert.ok(actions.some(([name, payload]) => name === 'translation-source-invalid' && payload.reason === 'context-invalid'));
  desktop.dispose();
});

test('新截图期间仍处理旧来源失效，取消框选不能恢复跨应用或已经关闭的覆盖', async () => {
  for (const state of ['inactive','closed','moved','unavailable']) {
    let notify;
    const image = { isEmpty: () => false, toJPEG: () => Buffer.from('固定测试图像') };
    const { desktop, made, time, actions } = desktopHarness({
      getSources: async () => [{ display_id: '1', thumbnail: image }],
      sourceFactory: ({ onChange }) => { notify = onChange; return { capture: async () => null, bind: () => 9, clear() {}, dispose() {} }; },
    });
    const placement = { sourceBinding: true, source: { handle: '99', pid: 42, bounds: { x: 100, y: 100, width: 1000, height: 700 } },
      region: { x: 240, y: 200, width: 200, height: 80 }, displayBounds: { x: 0, y: 0, width: 1440, height: 900 } };
    desktop.showTranslation(placement, 'overlay'); notify({ binding: 9, state: 'active' });
    const pending = desktop.beginCapture({ mode: 'explain' });
    notify({ binding: 9, state });
    await new Promise(resolve => setImmediate(resolve));
    time.advance(50); await pending;
    desktop.cancelCapture();
    assert.equal(made.find(win => win.kind === 'translation-overlay').isVisible(), false, `${state} 后取消截图不能重显旧覆盖`);
    if (state === 'inactive' || state === 'closed') assert.equal(made.find(win => win.kind === 'translation').isVisible(), false);
    if (state === 'closed') assert.ok(actions.some(([action]) => action === 'translation-source-closed'));
    if (state === 'moved' || state === 'unavailable') assert.ok(actions.some(([action]) => action === 'translation-source-invalid'));
    desktop.dispose();
  }
});

test('截图开始为识图但最终翻译仍恢复来源，恢复期间取消不会提交下一张截图', async () => {
  let release, restoreSignal, calls = 0;
  const source = { handle: '99', pid: 42, bounds: { x: 0, y: 0, width: 2880, height: 1800 } };
  const image = { isEmpty: () => false, getSize: () => ({ width: 1440, height: 900 }), toJPEG: () => Buffer.from('固定测试图像') };
  const { desktop } = desktopHarness({ getSources: async () => [{ display_id: '1', thumbnail: image }],
    sourceFactory: () => ({ capture: async () => source, restore(_source, { signal }) {
      calls++; restoreSignal = signal; return new Promise(resolve => { release = resolve; });
    }, clear() {}, dispose() {} }) });
  await desktop.beginCapture({ mode: 'explain' });
  // 初始模式可在框选工具栏切换，因此来源快照也必须在识图入口预先采集。
  const pending = desktop.restoreCaptureSource({ x: 100, y: 100, width: 100, height: 60 });
  assert.equal(calls, 1);
  desktop.cancelCapture(); assert.equal(restoreSignal.aborted, true);
  await desktop.beginCapture({ mode: 'translate' });
  release(true);
  await assert.rejects(pending, /取消或更新/);
  assert.ok(desktop.captureState(), '下一张截图仍保留，不被旧提交裁剪或清空');
  desktop.dispose();
});

test('首次来源绑定回复前已经切走，返回来源只恢复译文而不抢焦点', () => {
  let notify;
  const { desktop, made, focusOutside } = desktopHarness({ sourceFactory: ({ onChange }) => {
    notify = onChange; return { capture: async () => null, bind: () => 12, clear() {}, dispose() {} };
  } });
  const placement = { sourceBinding: true, source: { handle: '99', pid: 42, bounds: { x: 100, y: 100, width: 1000, height: 700 } },
    region: { x: 240, y: 200, width: 200, height: 80 }, displayBounds: { x: 0, y: 0, width: 1440, height: 900 } };
  desktop.showTranslation(placement, 'overlay');
  notify({ binding: 12, state: 'inactive' }); focusOutside();
  notify({ binding: 12, state: 'active' });
  const controls = made.find(win => win.kind === 'translation');
  assert.equal(controls.isVisible(), true); assert.equal(controls.isFocused(), false);
  desktop.dispose();
});

test('透明主窗的手动拖边进入原有尺寸记忆，过期手势不能覆盖新拉伸', async () => {
  const { desktop, made } = desktopHarness(); desktop.openPanel();
  const win = made.find(value => value.kind === 'panel'), before = { ...win.getBounds() };
  assert.equal(desktop.resizePanel({ phase: 'start', edge: 'e', token: 'resize-1', x: 300, y: 200 }), true);
  desktop.resizePanel({ phase: 'move', edge: 'e', token: 'resize-1', x: 340, y: 200 });
  assert.equal(win.getBounds().width, before.width + 40);
  desktop.resizePanel({ phase: 'start', edge: 's', token: 'resize-2', x: 340, y: 200 });
  assert.equal(desktop.resizePanel({ phase: 'end', edge: 'e', token: 'resize-1', x: 400, y: 200 }), false);
  desktop.resizePanel({ phase: 'end', edge: 's', token: 'resize-2', x: 340, y: 230 });
  assert.equal(win.getBounds().width, before.width + 40); assert.equal(win.getBounds().height, before.height + 30);
  assert.equal(desktop.getWindowState().sizes.compact.width, before.width + 40);
  const event = value => ({ sender: value.webContents, senderFrame: value.webContents.mainFrame });
  assert.equal(desktop.authorize(event(win), 'panel-resize'), true);
  desktop.setOrb(true); const orb = made.find(value => value.kind === 'orb');
  assert.equal(desktop.authorize(event(orb), 'panel-resize'), false);
  assert.throws(() => desktop.resizePanel({ phase: 'start', edge: 'e', token: 'bad', x: Infinity, y: 200 }), /请求无效/);
  desktop.dispose();
});

test('内容高度反馈保留拖动位置，不聚焦或重显窗口、不移动覆盖层且不保存偏好', () => {
  let settingsWrites = 0;
  const { desktop, made, focusOutside } = desktopHarness({ onWindowState: async () => { settingsWrites++; } });
  const placement = { region: { x: 240, y: 200, width: 200, height: 80 }, displayBounds: { x: 0, y: 0, width: 1440, height: 900 } };
  desktop.showTranslation(placement, 'compare');
  const controls = made.find(win => win.kind === 'translation'), overlay = made.find(win => win.kind === 'translation-overlay');
  controls.setBounds({ ...controls.getBounds(), x: 780, y: 480 });
  const position = { x: controls.getBounds().x, y: controls.getBounds().y }, overlayBounds = { ...overlay.getBounds() };
  focusOutside();
  assert.ok(desktop.resizeTranslationHeight(placement, 360));
  assert.deepEqual({ x: controls.getBounds().x, y: controls.getBounds().y }, position, '拖动后只变更高度');
  assert.equal(controls.getBounds().height, 360);
  assert.deepEqual({ ...overlay.getBounds() }, overlayBounds, '高度变化不移动原位截图覆盖');
  assert.equal(controls.isVisible(), true, '已显示窗口保持当前显示状态');
  assert.equal(controls.isFocused(), false, '测量反馈不能抢焦点');
  assert.equal(settingsWrites, 0, '临时内容尺寸不进入窗口偏好');
  desktop.hideTranslation();
  assert.equal(desktop.resizeTranslationHeight(placement, 420), null, '窗口关闭后迟到测量被忽略');
  assert.equal(controls.getBounds().height, 360);
});

test('翻译控制窗高度不超过当前工作区或 480 CSS 像素上限', () => {
  const harness = desktopHarness(), { desktop, made } = harness;
  const area = { x: 0, y: 0, width: 420, height: 220 };
  harness.changeDisplay(area);
  const placement = { region: { x: 60, y: 40, width: 100, height: 60 }, displayBounds: area };
  desktop.showTranslation(placement, 'compare');
  const controls = made.find(win => win.kind === 'translation');
  const small = desktop.resizeTranslationHeight(placement, 480);
  assert.equal(small.height, 220, '工作区较小时按工作区限高');
  assert.equal(controls.getBounds().height, 220);
  const fullHarness = desktopHarness(), full = { region: { x: 100, y: 100, width: 100, height: 50 }, displayBounds: { x: 0, y: 0, width: 1440, height: 900 } };
  fullHarness.desktop.showTranslation(full, 'compare');
  assert.equal(fullHarness.desktop.resizeTranslationHeight(full, 900).height, 480, '常规显示器仍受 480 CSS 像素上限约束');
  const narrowHarness = desktopHarness(), narrow = { region: { x: 100, y: 100, width: 100, height: 50 }, displayBounds: { x: 0, y: 0, width: 1440, height: 900 } };
  narrowHarness.desktop.showTranslation(narrow, 'compare');
  narrowHarness.changeDisplay({ x: 0, y: 0, width: 240, height: 900 });
  const narrowBounds = narrowHarness.desktop.resizeTranslationHeight(narrow, 360);
  assert.equal(narrowBounds.width, 240, '跨入更窄工作区时原生窗口宽度服从工作区');
  assert.equal(narrowBounds.height, 360);
});

test('截图界面可预热且不读取屏幕，无自有可见窗口时直接取图', async () => {
  let reads = 0;
  const image = { isEmpty: () => false, toJPEG: () => Buffer.from('虚构预览') };
  const { desktop, made, time } = desktopHarness({ getSources: async () => { reads++; return [{ display_id: '1', thumbnail: image }]; } });
  desktop.prepareCapture();
  const prepared = made.find(win => win.kind === 'capture');
  assert.ok(prepared); assert.equal(reads, 0); assert.equal(prepared.isVisible(), false);
  const pending = desktop.beginCapture();
  time.advance(0); await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 1, '没有可见自有窗口时，不应支付固定退隐等待');
  await pending; assert.equal(made.filter(win => win.kind === 'capture').length, 1);
});

test('来源页面核对期间并行加载空框选界面，取得可信来源前不读取屏幕', async () => {
  let resolveSource, reads = 0;
  const image = { isEmpty: () => false, toJPEG: () => Buffer.from('虚构预览') };
  const { desktop, made } = desktopHarness({
    sourceFactory: () => ({ capture: () => new Promise(resolve => { resolveSource = resolve; }), dispose() {} }),
    getSources: async () => { reads++; return [{ display_id: '1', thumbnail: image }]; },
  });
  const pending = desktop.beginCapture({ mode: 'translate' });
  assert.ok(made.find(win => win.kind === 'capture'), '来源检查与空 renderer 冷启动不得串行等待。');
  assert.equal(reads, 0, '并行准备不能把实际截图提前到来源快照之前。');
  resolveSource(null); await pending;
  assert.equal(reads, 1); desktop.dispose();
});

test('原生截图预热不采屏，采用物理显示器矩形并在销毁时停止助手', async () => {
  const calls = [];
  const reader = { async prepare() { calls.push('prepare'); }, async capture(rect) { calls.push({ ...rect }); return { bitmap: Buffer.alloc(2880 * 1800 * 4), width: 2880, height: 1800 }; }, dispose() { calls.push('dispose'); } };
  const { desktop } = desktopHarness({ nativeCapture: reader, getSources: async () => { throw Error('不应走后备'); } });
  desktop.prepareCapture(); assert.deepEqual(calls, ['prepare']);
  await desktop.beginCapture(); assert.deepEqual(calls[1], { x: 0, y: 0, width: 2880, height: 1800 });
  assert.equal(desktop.captureState().method, 'native');
  assert.match(desktop.finishCapture({ x: 10, y: 20, width: 100, height: 60 }), /虚构原生裁剪/);
  desktop.dispose(); assert.equal(calls.at(-1), 'dispose');
});

test('原生取图失败自动走现有采集，旧请求取消后不启动后备采集', async () => {
  let sources = 0, release;
  const image = { isEmpty: () => false, toJPEG: () => Buffer.from('虚构后备') };
  const reader = { async prepare() {}, async capture() { throw Error('模拟锁屏'); }, dispose() {} };
  const h = desktopHarness({ nativeCapture: reader, getSources: async () => { sources++; return [{ display_id: '1', thumbnail: image }]; } });
  await h.desktop.beginCapture(); assert.equal(sources, 1); assert.equal(h.desktop.captureState().method, 'electron');
  const late = desktopHarness({ nativeCapture: { ...reader, capture: () => new Promise((_resolve, reject) => { release = reject; }) }, getSources: async () => { sources++; return []; } });
  const pending = late.desktop.beginCapture(); await new Promise(resolve => setImmediate(resolve));
  late.desktop.cancelCapture(); release(Error('过期采集')); assert.equal(await pending, false); assert.equal(sources, 1);
});

test('截图隐藏自有窗口后只等三帧预算，不额外固定等待160毫秒', async () => {
  let reads = 0;
  const image = { isEmpty: () => false, toJPEG: () => Buffer.from('虚构预览') };
  const { desktop, time } = desktopHarness({ getSources: async () => { reads++; return [{ display_id: '1', thumbnail: image }]; } });
  desktop.openPanel(); const pending = desktop.beginCapture();
  time.advance(49); await new Promise(resolve => setImmediate(resolve)); assert.equal(reads, 0);
  time.advance(1); await new Promise(resolve => setImmediate(resolve)); assert.equal(reads, 1);
  await pending;
});

test('截图预览只编码一次并定向送给截图窗口，普通状态不重复发送整屏图', async () => {
  let encodes = 0, requests = 0, options, quality, crop;
  const image = { isEmpty: () => false, toJPEG: value => { quality = value; encodes++; return Buffer.from('虚构预览'); }, getSize: () => ({ width: 2880, height: 1800 }),
    crop: rect => { crop = rect; return { toDataURL: () => 'data:image/png;base64,虚构原像素裁剪' }; } };
  const { desktop, made, time } = desktopHarness({ getSources: async value => { requests++; options = value; return [{ display_id: '1', thumbnail: image }]; } });
  desktop.openPanel(); desktop.setOrb(true); desktop.broadcast({ status: {}, capture: null });
  const pending = desktop.beginCapture();
  const overlay = made.find(win => win.kind === 'capture'); assert.ok(overlay, '屏幕读取前先并行加载空截图 renderer');
  assert.equal(overlay.options.webPreferences.backgroundThrottling, false); assert.equal(overlay.options.webPreferences.nodeIntegration, false);
  assert.equal(overlay.options.thickFrame, false, '快速重复截图不能保留系统退隐动画');
  assert.equal(overlay.isVisible(), false); time.advance(160); assert.equal(await pending, true);
  const first = desktop.captureState(), again = desktop.captureState();
  assert.equal(first.id, again.id); assert.equal(encodes, 1); assert.equal(requests, 1);
  assert.equal(quality, 92); assert.match(first.imageData, /^data:image\/jpeg;base64,/);
  assert.equal(options.thumbnailSize.width, 2880); assert.equal(options.thumbnailSize.height, 1800);
  assert.equal(overlay.isVisible(), false, '解码 ACK 前不显示空白预览');
  desktop.broadcast({ status: {}, capture: first }); desktop.broadcast({ status: { error: '' }, capture: again });
  const overlays = overlay.messages.map(message => message[1]).filter(state => state.capture);
  assert.equal(overlays.filter(state => state.capture.imageData).length, 1);
  assert.equal(overlays.at(-1).capture.id, first.id); assert.equal(overlays.at(-1).capture.imageData, undefined);
  for (const win of made.filter(win => win.kind !== 'capture')) for (const message of win.messages) assert.equal(message[1].capture, null);
  const event = win => ({ sender: win.webContents, senderFrame: win.webContents.mainFrame });
  assert.equal(desktop.stateFor(event(overlay), { capture: null }).capture.imageData, first.imageData, '重新 bootstrap 可恢复完整预览');
  assert.equal(desktop.stateFor(event(made[0]), { capture: first }).capture, null);
  assert.equal(desktop.authorize(event(overlay), 'capture-ready'), true); assert.equal(desktop.authorize(event(made[0]), 'capture-ready'), false);
  assert.equal(desktop.captureReady({ id: '过期图像' }), false);
  assert.equal(desktop.captureReady({ id: first.id }), true); assert.equal(overlay.isVisible(), true);
  const cropped = desktop.finishCapture({ x: 10, y: 10, width: 40, height: 50 });
  assert.deepEqual({ ...crop }, { x: 20, y: 20, width: 80, height: 100 }); assert.match(cropped, /^data:image\/png;base64,/); assert.equal(encodes, 1);
  assert.equal(overlay.isVisible(), false); assert.equal(overlay.isDestroyed(), false); assert.equal(desktop.captureState(), null);
  assert.equal(overlay.messages.at(-1)[1].capture, null);
});

test('截图取消后复用隐藏窗口，新图必须使用新ID且迟到旧采集不会覆盖它', async () => {
  let release, queries = 0, encodes = 0;
  const image = { isEmpty: () => false, toJPEG: () => { encodes++; return Buffer.from('虚构新图'); } };
  const { desktop, made, time } = desktopHarness({ getSources: async () => { queries++; if (queries === 1) return new Promise(resolve => { release = resolve; }); return [{ display_id: '1', thumbnail: image }]; } });
  const old = desktop.beginCapture(); time.advance(160); await new Promise(resolve => setImmediate(resolve)); desktop.cancelCapture();
  const latest = desktop.beginCapture(); time.advance(160); assert.equal(await latest, true);
  const latestState = desktop.captureState(); release([{ display_id: '1', thumbnail: image }]); assert.equal(await old, false);
  assert.equal(desktop.captureState().id, latestState.id); assert.equal(encodes, 1);
  assert.equal(made.filter(win => win.kind === 'capture').length, 1);
  desktop.cancelCapture(); const third = desktop.beginCapture(); time.advance(160); await third;
  assert.notEqual(desktop.captureState().id, latestState.id); assert.equal(encodes, 2);
});

test('截图预览超时会恢复原窗口，截图 renderer 崩溃后下次重建', async () => {
  const image = { isEmpty: () => false, toJPEG: () => Buffer.from('虚构预览') };
  const { desktop, made, time, statuses } = desktopHarness({ getSources: async () => [{ display_id: '1', thumbnail: image }] });
  desktop.openPanel(); const panel = made[0];
  const first = desktop.beginCapture(); time.advance(160); await first;
  assert.equal(panel.isVisible(), false); time.advance(5000);
  assert.equal(desktop.captureState(), null); assert.equal(panel.isVisible(), true);
  assert.match(statuses.at(-1).error, /预览未能及时准备/);
  const second = desktop.beginCapture(); time.advance(160); await second;
  const crashed = made.find(win => win.kind === 'capture'); crashed.webContents.emit('render-process-gone');
  assert.equal(desktop.captureState(), null); assert.equal(crashed.isDestroyed(), true); assert.equal(panel.isVisible(), true);
  const third = desktop.beginCapture(); time.advance(160); await third;
  assert.equal(made.filter(win => win.kind === 'capture').length, 2);
  assert.ok(desktop.captureState());
});

test('划词入口以松开位置为水平中心，位于鼠标下方而不是右侧偏移', () => {
  const { desktop, made, worker } = desktopHarness(); desktop.startSelection(true);
  worker.emit('message', { type: 'selection', text: 'EXA', point: { x: 500, y: 300 } });
  const entry = made.find(win => win.kind === 'selection'), bounds = entry.getBounds();
  assert.equal(bounds.x + bounds.width / 2, 500);
  assert.equal(bounds.y, 312);
  assert.equal(bounds.width, 34); assert.equal(bounds.height, 34);
});

test('划词入口按各档 DPI 换算松开坐标，不使用 UIA 返回时的当前光标位置', () => {
  for (const dipScale of [1,1.25,1.5,2]) {
    const { desktop, made, worker } = desktopHarness({ dipScale }); desktop.startSelection(true);
    worker.emit('message', { type: 'selection', text: 'EXA', point: { x: 800 * dipScale, y: 300 * dipScale } });
    const bounds = made.find(win => win.kind === 'selection').getBounds();
    assert.equal(bounds.x + bounds.width / 2, 800); assert.equal(bounds.y, 312);
  }
});

test('划词入口不自动超时，点击后仍使用本次选区材料', async () => {
  const { desktop, made, selections, worker, time } = desktopHarness();
  desktop.startSelection(true);
  worker.emit('message', { type: 'selection', text: 'compound', context: 'Small changes compound over time.', point: { x: 500, y: 300 } });
  const entry = made[0], initialBounds = { ...entry.getBounds() };
  time.fire();
  assert.equal(entry.isVisible(), true, '经过原来的隐藏期限后仍应可点击');
  assert.deepEqual({ ...entry.getBounds() }, initialBounds);
  worker.emit('message', { type: 'pointer-down', point: { x: initialBounds.x + 8, y: initialBounds.y + 8 } });
  assert.equal(entry.isVisible(), true, '点击入口本身不能提前丢弃选区');
  await desktop.acceptSelection();
  assert.equal(selections.length, 1);
  assert.equal(selections[0].text, 'compound');
  assert.equal(selections[0].context, 'Small changes compound over time.');
  assert.equal(entry.isVisible(), false);
});

test('入口固定在屏幕原位置，原文滚动或离屏不移动和隐藏入口', async () => {
  const { desktop, made, selections, worker } = desktopHarness();
  desktop.startSelection(true);
  worker.emit('message', { type: 'selection', trackingId: 7, text: 'compound', context: 'Small changes compound over time.', point: { x: 500, y: 300 }, anchor: { visible: true, point: { x: 510, y: 310 } } });
  const entry = made[0], original = { ...entry.getBounds() };
  worker.emit('message', { type: 'selection-position', trackingId: 7, visible: true, point: { x: 510, y: 190 } });
  assert.deepEqual({ ...entry.getBounds() }, original);
  worker.emit('message', { type: 'selection-position', trackingId: 7, visible: false });
  assert.equal(entry.isVisible(), true);
  worker.emit('message', { type: 'selection-position', trackingId: 7, visible: true, point: { x: 510, y: 310 } });
  assert.equal(entry.isVisible(), true);
  assert.deepEqual({ ...entry.getBounds() }, original);
  await desktop.acceptSelection();
  assert.equal(selections.length, 1);
  assert.equal(selections[0].text, 'compound');
  assert.equal(selections[0].context, 'Small changes compound over time.');
});

test('入口取消或更换后，迟到的跟随消息不影响新入口', () => {
  const { desktop, made, worker } = desktopHarness();
  desktop.startSelection(true);
  worker.emit('message', { type: 'selection', trackingId: 1, text: 'compound', point: { x: 500, y: 300 } });
  worker.emit('message', { type: 'dismiss' });
  worker.emit('message', { type: 'selection-position', trackingId: 1, visible: true, point: { x: 50, y: 50 } });
  assert.equal(made[0].isVisible(), false);
  worker.emit('message', { type: 'selection', trackingId: 2, text: 'retain', point: { x: 800, y: 300 } });
  const current = { ...made[0].getBounds() };
  worker.emit('message', { type: 'selection-position', trackingId: 1, visible: true, point: { x: 50, y: 50 } });
  assert.deepEqual({ ...made[0].getBounds() }, current);
  worker.emit('message', { type: 'selection-ended', trackingId: 1 });
  assert.equal(made[0].isVisible(), true);
  worker.emit('message', { type: 'selection-ended', trackingId: 2 });
  assert.equal(made[0].isVisible(), true);
});

test('窗口加载期间更换选区，加载完成只显示最新入口', () => {
  const { desktop, made, worker } = desktopHarness({ loading: true });
  desktop.startSelection(true);
  worker.emit('message', { type: 'selection', trackingId: 3, text: 'compound', point: { x: 500, y: 300 }, anchor: { visible: true, point: { x: 510, y: 310 } } });
  worker.emit('message', { type: 'dismiss' });
  worker.emit('message', { type: 'selection', text: 'retain', point: { x: 800, y: 300 } });
  const entry = made[0]; entry.loading = false;
  entry.webContents.emit('did-finish-load');
  assert.equal(entry.isVisible(), true);
  assert.equal(entry.getBounds().x, 783);
  assert.equal(entry.getBounds().y, 312);
});

test('主动取消后旧入口失效，重新划词只解释最新材料', async () => {
  for (const cancel of [{ type: 'dismiss' }, { type: 'pointer-down', point: { x: 20, y: 20 } }]) {
    const { desktop, made, selections, worker } = desktopHarness();
    desktop.startSelection(true);
    worker.emit('message', { type: 'selection', text: 'compound', point: { x: 500, y: 300 } });
    worker.emit('message', cancel);
    assert.equal(made[0].isVisible(), false);
    await assert.rejects(desktop.acceptSelection(), /重新划词/);
    worker.emit('message', { type: 'selection', text: 'retain', point: { x: 800, y: 300 } });
    await desktop.acceptSelection();
    assert.equal(selections.length, 1);
    assert.equal(selections[0].text, 'retain');
  }
});

test('打开其他流程后迟到的旧选区不重开入口，新划词仍可接纳', async () => {
  const { desktop, made, selections, commands, worker } = desktopHarness();
  desktop.startSelection(true);
  desktop.openPanel();
  const cancel = commands.at(-1);
  assert.equal(cancel.type, 'cancel-pending');
  worker.emit('message', { type: 'selection', text: 'compound', point: { x: 150, y: 100 } });
  assert.equal(made.length, 2, '只保留提前加载的入口和面板');
  assert.equal(made.find(win => win.kind === 'selection').isVisible(), false, '旧材料不能显示提前加载的入口');
  worker.emit('message', { type: 'pending-cancelled', requestId: cancel.requestId });
  worker.emit('message', { type: 'selection', text: 'retain', point: { x: 150, y: 100 } });
  assert.equal(made.length, 2);
  await desktop.acceptSelection();
  assert.deepEqual(selections.map(item => item.text), ['retain']);
});

test('启用监听时隐藏加载划词入口，连续结果复用同一页面', () => {
  const {desktop,made,worker}=desktopHarness();
  desktop.startSelection(true);
  const entry=made.find(win=>win.kind==='selection');
  assert.ok(entry);assert.equal(entry.isVisible(),false);assert.equal(entry.loads,1);
  for(const word of ['第一份文字','第二份文字']) worker.emit('message',{type:'selection',text:word,point:{x:800,y:300}});
  assert.equal(made.length,1);assert.equal(entry.loads,1);assert.equal(entry.isVisible(),true);
});

test('点击前取得上下文时，入口提交同一份完整材料', async () => {
  const {desktop,worker,selections,selectionUpdates}=desktopHarness();desktop.startSelection(true);
  worker.emit('message',{type:'selection',requestId:1,text:'目标词',context:'',contextPending:true,point:{x:800,y:300}});
  worker.emit('message',{type:'selection-context',requestId:1,context:'这段包含目标词。',contextOrigin:'UIA 所在段落',reason:''});
  await desktop.acceptSelection();
  assert.equal(selections[0].context,'这段包含目标词。');assert.equal(selections[0].contextPending,false);
  assert.equal(selectionUpdates.length,0,'尚未建立会话时直接补到待提交材料');
});

test('点击后迟到上下文按请求归属回传，等待会话建立后才应用', async () => {
  let resolveSelection;
  const {desktop,worker,selections,selectionUpdates}=desktopHarness({onSelection:()=>new Promise(resolve=>{resolveSelection=resolve;})});
  desktop.startSelection(true);
  worker.emit('message',{type:'selection',requestId:4,text:'先确认的文字',context:'',contextPending:true,point:{x:800,y:300}});
  const accepting=desktop.acceptSelection();await Promise.resolve();
  worker.emit('message',{type:'selection-context',requestId:4,context:'迟到的原段落',contextOrigin:'UIA 所在段落',reason:''});
  await Promise.resolve();assert.equal(selectionUpdates.length,0);
  resolveSelection();await accepting;await new Promise(resolve=>setImmediate(resolve));
  assert.equal(selectionUpdates.length,1);assert.equal(selectionUpdates[0].requestId,selections[0].requestId);
  assert.equal(selectionUpdates[0].context,'迟到的原段落');
});

test('旧上下文不替换新入口，助手退出会结束已提交材料的等待', async () => {
  const {desktop,worker,commands,selections,selectionUpdates}=desktopHarness();desktop.startSelection(true);
  worker.emit('message',{type:'selection',requestId:1,text:'旧文字',context:'',contextPending:true,point:{x:800,y:300}});
  await desktop.acceptSelection();
  worker.emit('message',{type:'pending-cancelled',requestId:commands.at(-1).requestId});
  worker.emit('message',{type:'selection',requestId:2,text:'新文字',context:'',contextPending:true,point:{x:900,y:300}});
  worker.emit('message',{type:'selection-context',requestId:1,context:'旧段落',contextOrigin:'UIA 所在段落'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(selectionUpdates[0].requestId,selections[0].requestId);
  await desktop.acceptSelection();assert.equal(selections[1].text,'新文字');assert.equal(selections[1].context,'');
  worker.emit('exit');await new Promise(resolve=>setImmediate(resolve));
  assert.equal(selectionUpdates.length,2);assert.equal(selectionUpdates[1].requestId,selections[1].requestId);
  assert.match(selectionUpdates[1].reason,/退出/);assert.equal(selectionUpdates[1].contextPending,false);
});

test('点击超限划词入口只显示缩短提示，不创建解释会话或发送请求', async () => {
  const { desktop, made, statuses, selections, commands, worker } = desktopHarness();
  desktop.startSelection(true);
  worker.emit('message', { type: 'selection-too-long', point: { x: 500, y: 300 } });
  assert.equal(made.length, 1, '应保留划词入口');
  assert.equal(made[0].isVisible(), true);
  assert.equal(statuses.length, 0, '点击前不抢焦点或弹出提示');
  await desktop.acceptSelection();
  assert.equal(selections.length, 0);
  assert.equal(made.length, 2, '点击后才打开面板');
  assert.ok(statuses.some(item => /12000/.test(item.error) && /缩短/.test(item.error)));
  const firstId = statuses.at(-1).errorId;
  worker.emit('message', { type: 'pending-cancelled', requestId: commands.at(-1).requestId });
  worker.emit('message', { type: 'selection-too-long', point: { x: 200, y: 100 } });
  await desktop.acceptSelection();
  assert.notEqual(statuses.at(-1).errorId, firstId, '再次超限应能显示新的提示');
});

test('界面崩溃后托盘重建面板，迟到的旧窗口关闭不移除新实例', () => {
  const { desktop, made } = desktopHarness();
  desktop.openPanel();
  const old = made[0];
  old.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.equal(old.destroyed, true);
  desktop.openPanel();
  assert.equal(made.length, 2);
  assert.equal(made[1].loads, 1);
  old.emit('closed');
  desktop.openPanel();
  assert.equal(made.length, 2);
});

test('退出草稿确认只接受正确窗口主框架的本轮 ACK，超时返回失败', async () => {
  const { desktop, made, messages, ipcMain, time } = desktopHarness();
  desktop.openPanel();
  const pending = desktop.flushDrafts();
  const token = messages.at(-1)[1], webContents = made[0].webContents;
  ipcMain.emit('pickgloss:flushed', { sender: {}, senderFrame: {} }, token, true);
  assert.equal(ipcMain.listenerCount('pickgloss:flushed'), 1);
  ipcMain.emit('pickgloss:flushed', { sender: webContents, senderFrame: webContents.mainFrame }, token, true);
  assert.equal(await pending, true);
  assert.equal(ipcMain.listenerCount('pickgloss:flushed'), 0);
  const timeout = desktop.flushDrafts();
  time.fire();
  assert.equal(await timeout, false);
  assert.equal(ipcMain.listenerCount('pickgloss:flushed'), 0);
});

function mainHarness() {
  const events = new EventEmitter(), time = clock();
  const calls = { quit: 0, dispose: 0, open: 0, writes: 0, hide:0, capture:0 }, flags = { ack: true, save: true, visible:false, capturing:false };
  const app = { setPath() {}, getPath: () => '测试数据目录', setName() {}, setAppUserModelId() {},
    requestSingleInstanceLock: () => true, on: events.on.bind(events), whenReady: () => new Promise(() => {}), quit: () => calls.quit++ };
  const desktop = { flushDrafts: async () => flags.ack, flushWindowState: async () => true, restoreWindowState: () => false, setAppearance() {}, openPanel: () => {calls.open++;flags.visible=true;}, dispose: () => calls.dispose++, captureState: () => null,
    isPanelVisible:()=>flags.visible, hidePanel(){calls.hide++;flags.visible=false;}, async beginCapture(){if(flags.capturing)return false;flags.capturing=true;calls.capture++;return true;},
    broadcast() {}, initTray() {}, setOrb() {}, setOrbPreferences() {}, hoverOrb() {}, startSelection() {}, prepareCapture() {} };
  const persistedSettings = { prefs: { orbAction: 'chat' }, text: {}, vision: {} };
  const store = { init: async () => {}, getSettings: async () => structuredClone(persistedSettings),
    updateSession: async () => { calls.writes++; if (!flags.save) throw new Error('测试磁盘写入失败'); }, listSessions: async () => [] };
  const electron = { app, globalShortcut: { unregisterAll() {}, unregister() {}, register: () => true }, ipcMain: { handle() {} },
    session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } } };
  const target = path.join(__dirname, '../../src/main.cjs');
  const context = {
    require: name => name === 'electron' ? electron : name === './core/store.cjs' ? { createStore: () => store } :
      name === './windows/desktop.cjs' ? { createDesktop: () => desktop } : name === './core/shortcuts.cjs' ? require('../../src/core/shortcuts.cjs') : name === './core/history.cjs' ? require('../../src/core/history.cjs') : name.startsWith('./') ? {} : require(name),
    process: { argv: [], env: {}, pid: 1, platform: 'win32' }, ...time, structuredClone,
    auditStore: store, auditDesktop: desktop, auditSettings: persistedSettings,
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(target, 'utf8') + `
    store = auditStore; desktop = auditDesktop; settings = auditSettings; activeId = '测试会话';
    cache.set(activeId, {id: activeId, kind: 'text', threads: {}});
    globalThis.audit = {quit, start, handle, setOrbAction:value=>settings.prefs.orbAction=value, info: () => ({quitting, readyToExit, error: status.error, view, activeId})};
  `, context);
  return { ...context.audit, calls, flags, desktop, events, store };
}

test('悬浮球连续点击依次开关，不并发打开窗口；空历史回到文字识别', async()=>{
  const app=mainHarness();
  await Promise.all(Array.from({length:10},()=>app.handle('orb-activate')));
  assert.equal(app.calls.open,5);assert.equal(app.calls.hide,5);assert.equal(app.flags.visible,false);
  await app.handle('orb-activate');assert.equal(app.flags.visible,true);assert.equal(app.info().view,'paste');
});

test('悬浮球关闭前保存草稿，失败不隐藏且后续点击可重试', async()=>{
  const app=mainHarness();app.flags.visible=true;app.flags.ack=false;
  await assert.rejects(app.handle('orb-activate'),/有更改尚未保存/);
  assert.equal(app.calls.hide,0);assert.equal(app.flags.visible,true);
  app.flags.ack=true;await app.handle('orb-activate');assert.equal(app.calls.hide,1);
});

test('悬浮球快速再次点击会等待首次打开完成，不重入草稿保存',async()=>{
  const app=mainHarness();let release,waiting=0;
  app.desktop.flushDrafts=()=>{waiting++;return new Promise(resolve=>{release=resolve;});};
  const first=app.handle('orb-activate'),second=app.handle('orb-activate');
  await new Promise(resolve=>setImmediate(resolve));assert.equal(waiting,1);assert.equal(app.calls.open,0);
  release(true);await first;
  await new Promise(resolve=>setImmediate(resolve));assert.equal(waiting,2);assert.equal(app.calls.open,1);
  release(true);await second;assert.equal(app.calls.hide,1);assert.equal(app.flags.visible,false);
});

test('悬浮球截图模式只进入框选，连续点击不重建截图、不打开会话',async()=>{
  const app=mainHarness();app.setOrbAction('capture');
  await Promise.all(Array.from({length:8},()=>app.handle('orb-activate')));
  assert.equal(app.calls.capture,1);assert.equal(app.calls.open,0);assert.equal(app.calls.hide,0);
  app.flags.capturing=false;await app.handle('orb-activate');assert.equal(app.calls.capture,2);
});

test('退出前草稿未确认或最终写盘失败时保留进程，恢复后允许重试', async () => {
  const app = mainHarness();
  app.flags.ack = false;
  await app.quit();
  assert.equal(app.calls.quit, 0);
  assert.equal(app.calls.dispose, 0);
  assert.equal(app.info().quitting, false);
  assert.match(app.info().error, /有更改尚未保存/);
  app.flags.ack = true; app.flags.save = false;
  await app.quit();
  assert.equal(app.calls.quit, 0);
  assert.equal(app.calls.dispose, 0);
  assert.match(app.info().error, /未能写入磁盘/);
  app.flags.save = true;
  await app.quit();
  assert.equal(app.calls.quit, 1);
  assert.equal(app.calls.dispose, 1);
  assert.equal(app.info().readyToExit, true);
});

test('退出草稿确认抛错时取消退出，确认恢复后仍可重试', async () => {
  const app = mainHarness();
  app.desktop.flushDrafts = async () => { throw new Error('测试窗口确认异常'); };
  await app.quit();
  assert.equal(app.calls.quit, 0);
  assert.equal(app.calls.dispose, 0);
  assert.equal(app.info().quitting, false);
  assert.match(app.info().error, /有更改尚未保存/);
  app.desktop.flushDrafts = async () => true;
  await app.quit();
  assert.equal(app.calls.quit, 1);
  assert.equal(app.calls.dispose, 1);
});

test('退出仍在等待草稿 ACK 时，重复退出不能绕过保存', async () => {
  const app = mainHarness();
  await app.start();
  let release;
  app.desktop.flushDrafts = () => new Promise(resolve => { release = resolve; });
  const first = app.quit();
  const repeated = { prevented: false, preventDefault() { this.prevented = true; } };
  app.events.emit('before-quit', repeated);
  assert.equal(repeated.prevented, true);
  assert.equal(app.calls.quit, 0);
  assert.equal(app.calls.dispose, 0);
  release(true);
  await first;
  assert.equal(app.calls.quit, 1);
  const ready = { prevented: false, preventDefault() { this.prevented = true; } };
  app.events.emit('before-quit', ready);
  assert.equal(ready.prevented, false);
});

test('Windows 11 主窗跨主题保持透明的 14 DIP 裁切，不显示原生系统边色', () => {
  const { desktop, made } = desktopHarness(); desktop.openPanel(); const panel = made[0];
  for (const mode of ['dark', 'light', 'dark']) {
    desktop.setAppearance({ current: { mode, material: 'solid', accent: '#000000', tint: '#bfc2c8' } });
    assert.equal(panel.options.transparent, true);
    assert.equal(panel.options.thickFrame, false);
    assert.equal(panel.clipRadius, 14);
    assert.equal(panel.frameReady(), true);
    assert.equal(panel.material, 'none');
    assert.equal(panel.nativeBorder, 'none');
    assert.equal(panel.background, '#00000000');
    assert.equal(panel.shape, undefined, '不使用像素裁剪区域');
  }
});

test('固定与取消固定不改变透明裁切边界，轮廓颜色由页面绘制而非原生系统边框', () => {
  const { desktop, made } = desktopHarness(); desktop.openPanel(); const panel = made[0];
  desktop.setPinned(true);
  for (const [pinOutline, material] of [['blue', 'glass'], ['mint', 'solid'], ['none', 'glass']]) {
    desktop.setAppearance({ current: { mode: 'dark', material }, pinOutline });
    assert.equal(panel.nativeBorder, 'none');
    assert.equal(panel.options.transparent, true);
    assert.equal(panel.clipRadius, 14);
    assert.equal(panel.frameReady(), true);
    assert.equal(panel.backdropEnabled, material === 'glass');
  }
  desktop.setPinned(false);
  assert.equal(panel.nativeBorder, 'none');
  assert.equal(panel.options.transparent, true);
  assert.equal(panel.clipRadius, 14);
});

test('浏览器仍在前台但页面无法确认时，正式跟踪器与桌面联动必须显示对照菜单', async () => {
  const { createTranslationTracker } = require('../../src/windows/translation-tracker.cjs');
  let tracker, pageChanged, windowChanged;
  const source = { handle: '99', pid: 42, browserContextRequired: true, bounds: { x: 100, y: 100, width: 1000, height: 700 } };
  const { desktop, made, actions } = desktopHarness({ sourceFactory: ({ onChange }) => tracker = createTranslationTracker({ onChange,
    windowFactory(options) { windowChanged=options.onChange; return { capture: async()=>source, bind:()=>41, clear(){}, dispose(){} }; },
    browserFactory(options) { pageChanged=options.onChange; return { capture:async()=>({key:1,state:'active',revision:0}),
      checkpoint:async()=>({state:'active',revision:0}), dispose(){}, invalidate(){} }; },
  }) });
  const captured=await tracker.capture(); await tracker.sealCapture(captured);
  pageChanged({key:1,state:'inactive',reason:'unknown',revision:1});
  const placement={ sourceBinding:true,source:captured,region:{x:240,y:200,width:200,height:80},displayBounds:{x:0,y:0,width:1440,height:900} };
  desktop.showTranslation(placement,'overlay'); windowChanged({binding:41,state:'active'});
  assert.equal(made.find(win=>win.kind==='translation').isVisible(),true,'页面确认失败不能吞掉整个翻译菜单。');
  assert.equal(made.find(win=>win.kind==='translation-overlay').isVisible(),false,'未确认页面仍禁止显示旧覆盖。');
  assert.ok(actions.some(([name])=>name==='translation-source-invalid'),'交给正式主进程保留对照并显示来源提示。');
  windowChanged({binding:41,state:'inactive'});
  assert.equal(made.find(win=>win.kind==='translation').isVisible(),false,'来源真正离开前台时，未置顶菜单仍隐藏。');
  pageChanged({key:1,state:'active',reason:'tab',revision:2}); windowChanged({binding:41,state:'active'});
  assert.equal(made.find(win=>win.kind==='translation').isVisible(),true);
  assert.equal(made.find(win=>win.kind==='translation-overlay').isVisible(),false,'降级后迟到的页面确认不能复活旧覆盖。');
  desktop.dispose();
});

test('翻译菜单独立置顶，跨应用只保留菜单，取消后重新跟随来源', () => {
  let notify;
  const { desktop, made, focusOutside } = desktopHarness({ sourceFactory: ({ onChange }) => {
    notify = onChange; return { capture: async () => null, bind: () => 41, clear() {}, dispose() {} };
  } });
  const placement = { sourceBinding: true, source: { handle: '99', pid: 42, bounds: { x: 100, y: 100, width: 1000, height: 700 } },
    region: { x: 240, y: 200, width: 200, height: 80 }, displayBounds: { x: 0, y: 0, width: 1440, height: 900 } };
  desktop.showTranslation(placement, 'overlay');
  const overlay = made.find(win => win.kind === 'translation-overlay'), controls = made.find(win => win.kind === 'translation');
  notify({ binding: 41, state: 'active' });
  desktop.setTranslationControlsPinned(true);
  assert.equal(controls.alwaysOnTop, true);
  assert.equal(overlay.alwaysOnTop, false, '覆盖层不能获得系统置顶');
  focusOutside(); notify({ binding: 41, state: 'inactive' });
  assert.equal(controls.isVisible(), true, '固定菜单在来源失去前台后仍可见');
  assert.equal(controls.isFocused(), false, '菜单保持可见不能抢焦点');
  assert.equal(overlay.isVisible(), false, '覆盖层仍随来源隐藏');
  desktop.showTranslation(placement, 'overlay', { controlsPinned: true, activate: false });
  assert.equal(overlay.isVisible(), false, '后台翻译完成不能带出覆盖层');
  desktop.setTranslationControlsPinned(false);
  assert.equal(controls.alwaysOnTop, false);
  assert.equal(controls.isVisible(), false);
  notify({ binding: 41, state: 'active' });
  assert.equal(controls.isVisible(), true);
  assert.equal(overlay.isVisible(), true);
  desktop.hideTranslation(); notify({ binding: 41, state: 'active' });
  assert.equal(controls.isVisible(), false, '关闭后置顶也不能重新带出旧菜单');
});
