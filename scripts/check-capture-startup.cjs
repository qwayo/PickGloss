'use strict';

// 真实截图启动检查：仅在单屏上用自有纯色背景覆盖屏幕；不保存整屏图片或读取真实模型设置。
const electron = require('electron');
const { app, BrowserWindow, ipcMain, screen, desktopCapturer } = electron;
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { performance } = require('node:perf_hooks');
const { setTimeout: delay } = require('node:timers/promises');
const output = path.resolve(process.argv.find(value => value.startsWith('--report='))?.slice(9) || 'output/verification/2026-10-25-capture-startup.json');
const captureMethod = process.argv.find(value => value.startsWith('--capture='))?.slice(10) || 'electron';
const settleMs = Number(process.argv.find(value => value.startsWith('--settle-ms='))?.slice(12) || 350);
assert.ok(['electron', 'native'].includes(captureMethod), '采集方式仅接受 electron 或 native');
assert.ok(Number.isInteger(settleMs) && settleMs >= 0 && settleMs <= 1000, '轮次间等待必须为0至1000毫秒');
const report = { 通过: false, 采集方式: captureMethod, 覆盖: '单屏自有纯色背景、正式桌面模块和渲染器；只保存耗时及像素计数', 场景: [], 未覆盖: ['其他机器和刷新率、多显示器、私人软件画面、远端翻译请求耗时'] };
const made = [];
let background, backgroundColor, desktop, state, currentRun, capturedImage, capturedBitmap, failed = false;
app.setPath('userData', path.join(os.tmpdir(), 'pickgloss-capture-startup-' + process.pid));
app.on('window-all-closed', () => {});
class TrackedWindow extends BrowserWindow {
  constructor(options) { super(options); made.push(this); }
  loadFile(file, options) { this.testKind = options?.query?.window; return super.loadFile(file, options); }
}
const forbidden = () => { throw Error('截图启动检查不访问剪贴板、真实配置、划词或托盘'); };
function emit() { desktop.broadcast({ ...state, capture: desktop.captureState() }); }
ipcMain.handle('pickgloss:action', async (event, action, payload) => {
  if (!desktop.authorize(event, action)) return { ok: false, error: '窗口无此权限' };
  if (action === 'bootstrap') return { ok: true, value: desktop.stateFor(event, { ...state, capture: desktop.captureState() }) };
  if (action === 'capture-ready') {
    const accepted = desktop.captureReady(payload);
    if (accepted && currentRun) currentRun.可框选毫秒 = performance.now() - currentRun.started;
    return { ok: true, value: accepted };
  }
  return { ok: false, error: '此检查仅允许加载与截图就绪' };
});
async function until(check, description, timeout = 6000) {
  const start = performance.now();
  while (performance.now() - start < timeout) { if (await check()) return; await delay(10); }
  throw Error(description + '超时');
}
function ownedPixels(image) {
  // 所有像素应来自已覆盖屏幕的纯色背景；窗口残影、任务栏或第三方遮挡都会失败。
  const bytes = image.toBitmap(); let unexpected = 0;
  for (let offset = 0; offset < bytes.length; offset += 4) {
    if (Math.abs(bytes[offset] - backgroundColor[0]) > 2 || Math.abs(bytes[offset + 1] - backgroundColor[1]) > 2 || Math.abs(bytes[offset + 2] - backgroundColor[2]) > 2) unexpected++;
  }
  return { 异色像素: unexpected, 像素总数: bytes.length / 4, 异色比例: unexpected / (bytes.length / 4) };
}
async function createDesktop(controlDelay) {
  const target = path.resolve(__dirname, '../src/windows/desktop.cjs');
  const source = await fs.readFile(target, 'utf8');
  assert.ok(source.includes('setTimeout(resolve,50)'), '对照只调整当前退隐预算');
  const loaded = new Module(target, module); loaded.filename = target; loaded.paths = Module._nodeModulePaths(path.dirname(target));
  loaded.require = name => name === 'electron' ? { ...electron, BrowserWindow: TrackedWindow,
    clipboard: new Proxy({}, { get: () => forbidden }), Tray: class { constructor() { forbidden(); } }, utilityProcess: { fork: forbidden },
    desktopCapturer: { async getSources(options) {
      assert.equal(captureMethod, 'electron', '原生测速不能无提示地走 Electron 后备');
      assert.equal(screen.getAllDisplays().length, 1, '多屏时不启动整屏验证');
      assert.equal(background.isVisible(), true, '自有背景必须可见');
      const start = performance.now(); currentRun.到取图毫秒 = start - currentRun.started;
      const sources = await desktopCapturer.getSources(options);
      currentRun.真实取图毫秒 = performance.now() - start;
      capturedImage = sources.find(item => item.display_id === String(screen.getPrimaryDisplay().id))?.thumbnail;
      assert.ok(capturedImage && !capturedImage.isEmpty());
      return sources;
    } },
  } : name === './screen-capture.cjs' ? captureMethod === 'electron' ? { createScreenCapture: () => null } : {
    createScreenCapture() {
      const reader = Module.prototype.require.call(loaded, name).createScreenCapture();
      assert.ok(reader, '原生助手必须已构建');
      const capture = reader.capture.bind(reader);
      reader.capture = async rect => {
        const start = performance.now(); currentRun.到取图毫秒 = start - currentRun.started;
        const result = await capture(rect);
        currentRun.真实取图毫秒 = performance.now() - start;
        currentRun.助手内部毫秒 = result.nativeMilliseconds;
        capturedBitmap = result; return result;
      };
      return reader;
    },
  } : Module.prototype.require.call(loaded, name);
  loaded._compile(controlDelay === 160 ? source.replace('setTimeout(resolve,50)', 'setTimeout(resolve,160)') : source, target);
  return loaded.exports.createDesktop({ onAction: forbidden, onSelection: forbidden, onStatus(patch) { Object.assign(state.status, patch); emit(); } });
}
function cleanup() {
  desktop?.dispose(); background?.destroy();
  for (const win of made) if (!win.isDestroyed()) win.destroy();
}
app.whenReady().then(async () => {
  const timeout = setTimeout(() => { cleanup(); console.error('截图启动检查超时，自有窗口已关闭'); app.exit(1); }, 55000);
  try {
    assert.equal(screen.getAllDisplays().length, 1, '本检查只支持单屏，避免采入其他显示器');
    const display = screen.getPrimaryDisplay(); report.屏幕 = { 逻辑宽: display.bounds.width, 逻辑高: display.bounds.height, 缩放: display.scaleFactor };
    background = new BrowserWindow({ ...display.bounds, show: false, frame: false, thickFrame: false, roundedCorners: false, resizable: false, hasShadow: false, enableLargerThanScreen: true, skipTaskbar: true, focusable: false, backgroundColor: '#154972', webPreferences: { sandbox: true, backgroundThrottling: false } });
    background.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
    await background.loadURL('data:text/html,<style>html,body{margin:0;background:%23154972;width:100%;height:100%}</style>');
    background.setAlwaysOnTop(true, 'screen-saver'); background.showInactive();
    await delay(200);
    // 用真实采集路径校准系统色彩转换；仍要求整屏为同一已知蓝色，不能把未知画面当作基准。
    let calibrated = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      const reference = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(display.bounds.width * display.scaleFactor), height: Math.round(display.bounds.height * display.scaleFactor) }, fetchWindowIcons: false });
      const image = reference.find(value => value.display_id === String(display.id))?.thumbnail;
      assert.ok(image && !image.isEmpty()); backgroundColor = [...image.toBitmap().subarray(0, 3)];
      calibrated = backgroundColor.every((channel, index) => Math.abs(channel - [114, 73, 21][index]) <= 24) && ownedPixels(image).异色像素 === 0;
      if (calibrated) break;
      await delay(100);
    }
    report.背景物理通道 = backgroundColor; assert.ok(calibrated, '整屏校准必须是无遮挡、无边框的自有蓝色背景');
    for (const budget of [160, 50]) {
      state = { view: 'paste', session: null, history: [], settings: { text: {}, prefs: { appearance: { current: { mode: 'light', material: 'solid' } } } }, status: {} };
      desktop = await createDesktop(budget); desktop.setAppearance(state.settings.prefs.appearance);
      desktop.prepareCapture();
      await until(() => made.find(win => !win.isDestroyed() && win.testKind === 'capture')?.webContents.executeJavaScript('Boolean(document.querySelector(".capture-surface"))'), '空框选界面预热');
      const capture = made.find(win => !win.isDestroyed() && win.testKind === 'capture');
      const panel = (() => { desktop.openPanel(); return made.find(win => !win.isDestroyed() && win.testKind === 'panel'); })();
      state.pinned = true; desktop.setPinned(true);
      panel.setAlwaysOnTop(true, 'screen-saver');
      await until(() => !panel.webContents.isLoading(), '自有面板准备');
      emit(); await delay(200);
      for (const visible of [true, false]) for (let round = 1; round <= 3; round++) {
        if (visible) { panel.show(); panel.moveTop(); panel.focus(); } else panel.hide();
        background.moveTop(); if (visible) panel.moveTop();
        await delay(settleMs);
        assert.equal(panel.isVisible(), visible, '计时前自有面板必须符合场景的可见状态');
        currentRun = { 对照退隐毫秒: budget, 自有面板可见: visible, 轮次: round, started: performance.now() };
        await desktop.beginCapture(); emit();
        await until(() => Number.isFinite(currentRun.可框选毫秒), '真实框选就绪');
        // 核验放在计时结束之后，逐像素扫描不计入产品启动耗时。
        if (capturedBitmap) {
          capturedImage = electron.nativeImage.createFromBitmap(capturedBitmap.bitmap, { width: capturedBitmap.width, height: capturedBitmap.height }); capturedBitmap = null;
        }
        if (captureMethod === 'native' && report.场景.length === 0) {
          const bytes = capturedImage.toBitmap(), firstColor = [...bytes.subarray(0, 3)];
          assert.ok(firstColor.every((channel, index) => Math.abs(channel - [114, 73, 21][index]) <= 24), '原生采集首像素必须接近自有蓝色');
          backgroundColor = firstColor; report.原生背景物理通道 = backgroundColor;
        }
        Object.assign(currentRun, ownedPixels(capturedImage));
        if (currentRun.异色像素) {
          const bytes = capturedImage.toBitmap(), colors = new Map();
          for (let offset = 0; offset < bytes.length; offset += 16384) { const key = bytes.subarray(offset, offset + 4).join(','); colors.set(key, (colors.get(key) || 0) + 1); }
          report.失败场景 = { ...currentRun, 背景通道: backgroundColor, 主色: [...colors].sort((a,b) => b[1]-a[1]).slice(0,4) };
          console.error(JSON.stringify(report.失败场景));
        }
        capturedImage = null;
        assert.equal(currentRun.异色像素, 0, '截图包含非背景像素：可能有残影或外来窗口，本次不保存图像');
        assert.equal(desktop.captureState().method, captureMethod, '计时路径必须与声明的采集方式相同');
        assert.equal(capture.isVisible(), true); delete currentRun.started; report.场景.push(currentRun); currentRun = null;
        desktop.cancelCapture(); panel.hide();
      }
      desktop.dispose(); desktop = null;
    }
    report.通过 = true;
    console.log(JSON.stringify(report, null, 2));
  } catch (error) { failed = true; report.错误 = error.message; console.error(error.stack); }
  finally {
    clearTimeout(timeout); cleanup(); report.自有窗口已关闭 = made.every(win => win.isDestroyed()) && (!background || background.isDestroyed());
    await fs.mkdir(path.dirname(output), { recursive: true }); await fs.writeFile(output, JSON.stringify(report, null, 2), 'utf8');
    app.exit(failed ? 1 : 0);
  }
});
