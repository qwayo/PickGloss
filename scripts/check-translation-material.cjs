'use strict';
// 只显示和捕获本进程的测试窗口，核对正式翻译工具条的系统亚克力与紧凑状态。
const electron = require('electron');
const { app, ipcMain, nativeImage, screen, BrowserWindow } = electron;
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');
const { createUiDriver } = require('./ui-driver.cjs');
const { quoteJavaScriptString } = require('./javascript-string.cjs');
const { translationOptions, TRANSLATION_LANGUAGES } = require('../src/core/translation.cjs');
const run = promisify(execFile);
const injectSmallClip = process.argv.includes('--inject-small-clip');
const outputIndex = process.argv.indexOf('--output-dir');
const output = outputIndex < 0
  ? path.resolve(__dirname, `../output/verification/2026-10-26-translation-material${injectSmallClip ? '-small-clip-fault' : ''}`)
  : path.resolve(process.argv[outputIndex + 1]);
app.setPath('userData', path.join(os.tmpdir(), `pickgloss-translation-material-${process.pid}`));
app.on('window-all-closed', () => {});
const windows = [], remote = [], failures = [], materialControllers = new Map();
class OwnedWindow extends BrowserWindow {
  constructor(options) { super(options); this.requestedOptions = options; windows.push(this); }
  loadFile(file, options) { this.kind = options?.query?.window; return super.loadFile(file, options); }
  setBackgroundMaterial(value) { this.appliedMaterial = value; return super.setBackgroundMaterial(value); }
}
let desktop, background, controls, state;
const evaluate = code => controls.webContents.executeJavaScript(code);
const driver = createUiDriver(evaluate);
const handleOf = win => {
  const value = win.getNativeWindowHandle(); return String(value.length === 8 ? value.readBigUInt64LE() : value.readUInt32LE());
};
function broadcast() {
  if (state?.translation && controls) {
    const item = state.translation;
    item.layout = desktop.showTranslation(item.placement, item.options.displayMode,
      { activate: false, extraHeight: item.status === 'failed' ? 56 : item.status === 'complete' && (item.method === 'vision' || item.unchangedCount) ? 20 : 0 });
  }
  desktop.broadcast(state);
}
async function settle() { await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); }
async function capture(name) {
  await settle();
  const target = path.join(output, `${name}.png`);
  const info = materialControllers.get(controls)?.getBackdropInfo();
  const materialArgs = info?.visible ? ['-MaterialHandle', info.handle, '-MaterialPid', String(info.pid)] : [];
  const result = await run(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'capture-owned-window.ps1'),
      '-PanelHandle', handleOf(controls), '-BackgroundHandle', handleOf(background), '-OwnerPid', String(process.pid), '-OutputPath', target, ...materialArgs],
    { windowsHide: true, timeout: 15000 });
  const metrics = JSON.parse(result.stdout.trim());
  const image = nativeImage.createFromBuffer(await fs.readFile(target));
  const size = image.getSize(), bytes = image.toBitmap();
  const pixel = (Math.max(0, size.height - 40) * size.width + Math.floor(size.width / 2)) * 4;
  const rgb = (x, y) => { const offset = (y * size.width + x) * 4; return [bytes[offset + 2], bytes[offset + 1], bytes[offset]]; };
  const scale = screen.getDisplayMatching(controls.getBounds()).scaleFactor, dx = Math.round(2 * scale), dy = Math.round(3 * scale);
  const corners = [[0, 0, dx, dy], [size.width - 1, 0, size.width - 1 - dx, dy], [0, size.height - 1, dx, size.height - 1 - dy], [size.width - 1, size.height - 1, size.width - 1 - dx, size.height - 1 - dy]]
    // 竖条纹按同一列比较，避免背景窗口自身边框与 DPI 取整改变条纹相位。
    .map(([_x, y, innerX, innerY]) => ({ background: rgb(innerX, y), outsideCurve: rgb(innerX, innerY) }));
  return { metrics, sample: [bytes[pixel + 2], bytes[pixel + 1], bytes[pixel]], corners, file: path.basename(target) };
}
ipcMain.handle('pickgloss:action', async (event, action, payload = {}) => {
  try {
    assert.ok(desktop.authorize(event, action), '动作必须来自正式授权窗口');
    if (action === 'bootstrap') return { ok: true, value: desktop.stateFor(event, state) };
    if (action === 'set-translation-options') {
      state.translation.options = translationOptions({ ...state.translation.options, ...payload.options });
      state.translation.layout = desktop.showTranslation(state.translation.placement, state.translation.options.displayMode);
    } else if (action === 'set-translation-preferences') {
      state.settings.prefs.screenshotTranslation = translationOptions({ ...state.settings.prefs.screenshotTranslation, ...payload.options });
    } else if (action === 'close-translation') { desktop.hideTranslation(); state.translation = null; }
    else if (!['retry-translation', 'copy-translation', 'start-capture', 'open-settings'].includes(action)) throw Error('测试未支持此动作');
    broadcast(); return { ok: true };
  } catch { return { ok: false, error: '隔离界面检查未完成。' }; }
});

app.whenReady().then(async () => {
  const report = { 通过: false, 系统版本: os.release(), 覆盖: '正式桌面模块、正式渲染器、自有背景之上的实际 DWM 合成', 场景: [] };
  let failure;
  const timeout = setTimeout(() => { for (const win of windows) if (!win.isDestroyed()) win.destroy(); background?.destroy(); app.exit(1); }, 60000);
  try {
    await fs.mkdir(output, { recursive: true });
    const area = screen.getPrimaryDisplay().workArea;
    report.缩放 = screen.getPrimaryDisplay().scaleFactor;
    const html = '<style>html,body{margin:0;width:100%;height:100%;background:#226d9d}body{font:24px Segoe UI;color:#fff;background-image:repeating-linear-gradient(90deg,#000 0px,#000 4px,#fff 4px,#fff 8px)}main{padding:26px}</style><main>PickGloss</main>';
    background = new BrowserWindow({ x: area.x + 20, y: area.y + 20, width: Math.min(820, area.width - 40), height: Math.min(560, area.height - 40),
      show: false, frame: false, skipTaskbar: true, alwaysOnTop: true, webPreferences: { sandbox: true, backgroundThrottling: false } });
    await background.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    background.setAlwaysOnTop(true, 'pop-up-menu'); background.showInactive();
    const originalLoad = Module._load;
    Module._load = function(name, ...args) {
      if (name === 'electron') return { ...electron, BrowserWindow: OwnedWindow };
      const result = originalLoad.call(this, name, ...args);
      if (name === './window-appearance.cjs') return { ...result, createWindowAppearance(win, options) {
        const controller = result.createWindowAppearance(win, injectSmallClip && options.clipRadius ? { ...options, clipRadius: 8 } : options);
        materialControllers.set(win, controller); return controller;
      } };
      return result;
    };
    try { desktop = require('../src/windows/desktop.cjs').createDesktop({ captureFactory: () => null,
      onAction() {}, onStatus(patch) { if (state) Object.assign(state.status, patch); }, onWindowState() {} }); }
    finally { Module._load = originalLoad; }
    const placement = { region: { x: area.x + 160, y: area.y + 75, width: 190, height: 45 }, displayBounds: area };
    const imageData = nativeImage.createFromBuffer(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC1kAAAAASUVORK5CYII=', 'base64')).resize({ width: 190, height: 45 }).toDataURL();
    state = { view: 'paste', history: [], session: null, status: {}, translationLanguages: TRANSLATION_LANGUAGES,
      settings: { text: {}, prefs: { screenshotTranslation: translationOptions(), appearance: { current: { mode: 'dark', material: 'solid', accent: '#000000', tint: '#bfc2c8' } } } },
      translation: { id: '材质检查', imageData, placement, options: translationOptions(), status: 'complete', method: 'windows-ocr', fallbackReason: '', width: 190, height: 45,
        warning: '', unchangedCount: 0, rotationAdjusted: false, blocks: [{ id: 0, text: 'Quark', translation: '夸克', x: 0, y: 0, width: 190, height: 45 }] } };
    desktop.setAppearance(state.settings.prefs.appearance);
    state.translation.layout = desktop.showTranslation(placement, 'overlay');
    controls = windows.find(win => win.kind === 'translation');
    controls.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => { remote.push(details.url); callback({ cancel: true }); });
    for (const win of windows) win.webContents.on('console-message', (...args) => { const detail = args[1]; if (typeof detail === 'object' ? detail.level === 'error' : detail >= 2) failures.push('渲染器错误'); });
    broadcast();
    await driver.waitFor('document.querySelector(".translation-status")?.textContent.includes("完成")', '紧凑翻译菜单加载');
    const supported = Number(os.release().split('.')[2]) >= 22621 && !electron.nativeTheme.prefersReducedTransparency && !electron.nativeTheme.shouldUseHighContrastColors && !electron.nativeTheme.inForcedColorsMode;
    if (supported) {
      const deadline = Date.now() + 6000;
      while (!materialControllers.get(controls)?.getBackdropInfo()?.visible && Date.now() < deadline) await delay(10);
      assert.equal(materialControllers.get(controls)?.isReady, true, '原生背景助手应完成握手');
      assert.equal(materialControllers.get(controls)?.getBackdropInfo()?.visible, true, '只读助手返回的自有背景窗必须可见');
      broadcast(); await driver.waitFor('document.documentElement.dataset.material==="glass"', '亚克力就绪后切换透明表面');
    }
    assert.equal(controls.appliedMaterial, undefined, '透明控件窗不得启用整块矩形系统背景');
    report.系统材质 = supported ? '实时圆角背景' : '实色备用表面';
    const striped = await capture('圆角裁切-条纹'); report.场景.push(striped);
    if (supported) for (const [index, corner] of striped.corners.entries()) {
      assert.ok(corner.background.reduce((sum, value, channel) => sum + Math.abs(value - corner.outsideCurve[channel]), 0) < 60, `第${index + 1}个大圆角外不得残留矩形模糊背景`);
    }
    await background.webContents.executeJavaScript('document.body.style.backgroundImage="none";document.body.style.backgroundColor="#226d9d"');
    const darkBlue = await capture('深色-本地OCR'); report.场景.push(darkBlue);
    await background.webContents.executeJavaScript('document.body.style.backgroundImage="none";document.body.style.backgroundColor="#b47728"');
    const darkAmber = await capture('深色-背景变化'); report.场景.push(darkAmber);
    if (supported) assert.ok(darkBlue.sample.reduce((sum, value, index) => sum + Math.abs(value - darkAmber.sample[index]), 0) > 3, '亚克力应随背后自有背景变化');
    assert.equal(await evaluate('document.querySelector(".translation-controls").scrollWidth > document.querySelector(".translation-controls").clientWidth'), false, '紧凑控件不横向溢出');
    for (const [mode, fallbackReason, name] of [['dark', 'unavailable', '深色-识图回退'], ['light', 'quality', '浅色-识图回退']]) {
      state.settings.prefs.appearance.current.mode = mode; desktop.setAppearance(state.settings.prefs.appearance);
      Object.assign(state.translation, { method: 'vision', fallbackReason, warning: '整区覆盖，可切换对照。', status: 'translating' }); broadcast();
      await driver.waitFor(`document.querySelector('.translation-status').textContent.includes(${quoteJavaScriptString(fallbackReason === 'quality' ? 'OCR 不清晰' : 'OCR 失败')})`, '识图切换状态');
      report.场景.push(await capture(name));
    }
    Object.assign(state.translation, { status: 'complete', method: 'windows-ocr', fallbackReason: '', warning: '', blocks: [
      { id: 0, text: 'Quark', translation: '夸克', x: 0, y: 0, width: 190, height: 45 }, { id: 1, text: 'Genshin', translation: '原神', x: 0, y: 0, width: 190, height: 45 } ] }); broadcast();
    await driver.click('对照');
    await driver.waitFor('document.querySelectorAll(".translation-pair").length===2', '紧凑对照显示完整文本');
    report.场景.push(await capture('浅色-对照'));
    await driver.click('覆盖');
    Object.assign(state.translation, { status: 'failed', method: 'vision', error: '识图请求失败，请检查模型后重试。' }); broadcast();
    await driver.waitFor('document.querySelector(".translation-error")?.textContent.includes("检查模型")', '失败原因仍可见', { allowErrors: true });
    report.场景.push(await capture('浅色-失败提示'));
    assert.equal(remote.length, 0); assert.equal(failures.length, 0);
    report.通过 = true;
    console.log(`翻译工具条检查通过：${report.系统材质}、深浅色、实际背景透色、大圆角、对照及失败提示；证据 ${output}`);
  } catch (error) { failure = error; report.错误 = error.message; console.error(error.stack); }
  finally {
    clearTimeout(timeout); desktop?.dispose(); for (const win of windows) if (!win.isDestroyed()) win.destroy(); background?.destroy();
    await fs.writeFile(path.join(output, '翻译工具条材质检查.json'), JSON.stringify(report, null, 2), 'utf8'); app.exit(failure ? 1 : 0);
  }
});
