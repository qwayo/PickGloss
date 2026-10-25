'use strict';
// 正式桌面模块 + 虚构解释会话；只捕获自己的窗口和纯色背景，不启动划词或真实宿主。
const electron = require('electron');
const { app, BrowserWindow, ipcMain, screen, nativeTheme, nativeImage } = electron;
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { quoteJavaScriptString } = require('./javascript-string.cjs');
const { createUiDriver } = require('./ui-driver.cjs');
const { sampleEdges } = require('./native-edge-samples.cjs');
const outputArg = process.argv.indexOf('--output-dir');
const output = path.resolve(outputArg < 0 ? path.join(__dirname, '../output/verification', `native-${Date.now()}`) : process.argv[outputArg + 1]);
app.setPath('userData', path.join(os.tmpdir(), `pickgloss-native-edges-${process.pid}`));
app.on('window-all-closed', () => {});
const made = [];
let desktop, background, panel;
const state = { view: 'explain', history: [], pinned: false, wide: false, settings: { text: { baseUrl: 'http://127.0.0.1/v1', model: '隔离边缘检查', hasKey: true }, prefs: { appearance: {} } }, status: {}, session: {
  id: '隔离边缘检查', kind: 'text', text: '虚构材料', context: '仅检查自有测试窗口的最终合成边缘。', activeMode: 'context', threads: {
    context: { draft: '', status: 'complete', messages: [{ id: '虚构回答', role: 'assistant', status: 'complete', content: '这是一条隔离验证用的虚构回答。' }] },
    independent: { draft: '', status: 'idle', messages: [] }, visual: { draft: '', status: 'idle', messages: [] },
  },
} };
const report = { 通过: false, 覆盖: 'Windows CopyFromScreen 最终合成；仅自有测试窗及背景', 系统: os.release(), Electron: process.versions.electron, 参数: { 逻辑宽: 300, 逻辑高: 483, 原生圆角DIP: 8, 普通边差阈值: 6, 光条红通道阈值: 200 }, 场景: [], 回归检出: [], 未覆盖: ['其他机器、其他 DPI 和锁屏桌面'] };
const emit = () => desktop?.broadcast(state);
const evaluate = code => panel.webContents.executeJavaScript(code);
const driver = createUiDriver(evaluate);
class TrackedWindow extends BrowserWindow {
  constructor(options) { super({ ...options, webPreferences: { ...options.webPreferences, backgroundThrottling: false } }); made.push(this); }
}
const forbidden = () => { throw Error('隔离边缘检查禁止访问剪贴板、采集、托盘和外部进程'); };
ipcMain.handle('pickgloss:action', async (event, action) => {
  if (action === 'bootstrap') return { ok: true, value: desktop.stateFor(event, state) };
  if (action === 'set-draft') return { ok: true };
  return { ok: false, error: '隔离检查未授权此动作' };
});
function handle(win) { const bytes = win.getNativeWindowHandle(); return String(bytes.length === 8 ? bytes.readBigUInt64LE() : bytes.readUInt32LE()); }
async function capture(name, pinned) {
  panel.moveTop(); panel.focus();
  await delay(180);
  const imagePath = path.join(output, `${name}.png`);
  const captured = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'capture-owned-window.ps1'), '-PanelHandle', handle(panel), '-BackgroundHandle', handle(background), '-OwnerPid', String(process.pid), '-OutputPath', imagePath], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (captured.error || captured.status !== 0) throw Error(`实屏捕获失败：${captured.stderr || captured.error?.code}`);
  const rect = JSON.parse(captured.stdout.trim()), image = nativeImage.createFromPath(imagePath);
  assert.equal(image.isEmpty(), false, '实屏图片必须能解码');
  const { width, height } = image.getSize(), bitmap = image.toBitmap();
  assert.equal(width, rect.width, '图片宽度必须匹配实际物理矩形');
  assert.equal(height, rect.height, '图片高度必须匹配实际物理矩形');
  const display = screen.getDisplayMatching(panel.getBounds());
  const pixel = (x, y) => { const offset = (y * width + x) * 4; return [bitmap[offset + 2], bitmap[offset + 1], bitmap[offset]]; };
  const result = sampleEdges({ width, height, pixel, scale: display.scaleFactor, pinned, client: rect.client });
  const layout = await evaluate('({dpr:devicePixelRatio,material:document.documentElement.dataset.material,native:document.documentElement.classList.contains("native-rounded-frame")})');
  return { 名称: name, 图片: path.basename(imagePath), 实际矩形: rect, 逻辑矩形: panel.getBounds(), DPI: display.scaleFactor * 96, 缩放: display.scaleFactor, 请求材质: state.settings.prefs.appearance.current.material, 实际界面: layout, 原生边色: panel.getAccentColor(), ...result };
}
function cleanup() {
  desktop?.dispose();
  for (const win of [background, ...made]) if (win && !win.isDestroyed()) win.destroy();
  report.自有窗口已关闭 = [background, ...made].every(win => !win || win.isDestroyed());
}
app.whenReady().then(async () => {
  const watchdog = setTimeout(() => { cleanup(); console.error('原生实屏检查超时；窗口已关闭'); app.exit(1); }, 240000);
  try {
    await fs.mkdir(output, { recursive: true });
    if (process.platform !== 'win32' || Number(os.release().split('.')[2]) < 22000) throw Error('当前系统不支持待验证的 Windows 11 DWM 路径，原生实屏未覆盖');
    report.材质能力 = { 版本支持磨砂: Number(os.release().split('.')[2]) >= 22621, 减少透明: nativeTheme.prefersReducedTransparency, 高对比: nativeTheme.shouldUseHighContrastColors, 强制颜色: nativeTheme.inForcedColorsMode };
    const area = screen.getPrimaryDisplay().workArea;
    report.主屏DPI = screen.getPrimaryDisplay().scaleFactor * 96;
    assert.ok(area.width >= 340 && area.height >= 523, '桌面工作区无法容纳测试窗口，未覆盖');
    const target = path.resolve(__dirname, '../src/windows/desktop.cjs'), loaded = new Module(target, module);
    loaded.filename = target; loaded.paths = Module._nodeModulePaths(path.dirname(target));
    loaded.require = name => name === 'electron' ? { ...electron, BrowserWindow: TrackedWindow, clipboard: new Proxy({}, { get: () => forbidden }), Tray: class { constructor() { forbidden(); } }, utilityProcess: { fork: forbidden }, desktopCapturer: { getSources: forbidden } } : Module.prototype.require.call(loaded, name);
    loaded._compile(await fs.readFile(target, 'utf8'), target);
    desktop = loaded.exports.createDesktop({ onAction: forbidden, onSelection: forbidden, onStatus(patch) { Object.assign(state.status, patch); emit(); } });
    desktop.restoreWindowState({ panel: { x: area.x + 20, y: area.y + 20 } });
    background = new BrowserWindow({ x: area.x, y: area.y, width: 340, height: 523, frame: false, show: false, backgroundColor: '#7a3460', focusable: false, webPreferences: { sandbox: true } });
    // 所有窗口使用独立会话；网络请求一律取消。
    background.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
    await background.loadURL('data:text/html,<style>html,body{margin:0;background:%237a3460;height:100%}</style>');
    background.setAlwaysOnTop(true, 'pop-up-menu'); background.showInactive();
    desktop.setWide(false); panel = made[0];
    desktop.openPanel(); emit();
    await driver.waitFor('Boolean(document.querySelector(".message"))', '正式渲染器与虚构会话就绪');
    if (process.argv.includes('--inject-capture-failure')) throw Error('受控实屏失败：用于验证非零退出与窗口清理');
    for (const mode of ['dark', 'light']) for (const material of ['solid', 'glass']) for (const pin of ['idle', 'orange', 'none']) {
      state.settings.prefs.appearance = { current: { mode, material }, pinOutline: pin === 'none' ? 'none' : 'orange' };
      state.pinned = pin !== 'idle'; desktop.setAppearance(state.settings.prefs.appearance); desktop.setPinned(state.pinned); desktop.openPanel(); emit();
      await driver.waitFor(`document.documentElement.dataset.appearance===${quoteJavaScriptString(mode)} && document.documentElement.dataset.pinOutline===${quoteJavaScriptString(pin === 'none' ? 'none' : 'orange')} && document.querySelector('.panel').classList.contains('is-pinned')===${state.pinned}`, '主题与描边状态同步', { stage: `${mode}-${material}-${pin}` });
      await evaluate('Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))');
      const result = await capture(`${mode}-${material}-${pin}`, pin === 'orange');
      report.场景.push(result);
      if (material !== result.实际界面.material) report.未覆盖.push(`${result.名称} 请求的磨砂回退为 ${result.实际界面.material}，磨砂未覆盖`);
      assert.equal(result.passed, true, `${result.名称} 边缘采样失败`);
    }
    // 仅改变自有测试窗的 CSS；正式源码和用户实例保持原状。
    for (const [name, pinned, css] of [
      ['普通外缘灰线', false, '.panel{border-color:rgb(85,85,85)!important}'],
      ['重复裁切与底板凸出', true, '.panel{border-radius:12px!important;overflow:hidden!important}'],
    ]) {
      state.settings.prefs.appearance = { current: { mode: 'dark', material: 'solid' }, pinOutline: 'orange' };
      state.pinned = pinned; desktop.setAppearance(state.settings.prefs.appearance); desktop.setPinned(pinned); emit();
      await delay(220);
      const key = await panel.webContents.insertCSS(css);
      try {
        const result = await capture(`受控回归-${name}`, pinned);
        report.回归检出.push(result);
        assert.equal(result.passed, false, `工具没有检出${name}`);
      } finally { await panel.webContents.removeInsertedCSS(key); }
    }
    report.通过 = true;
    console.log(`原生实屏边缘检查通过：${report.场景.length} 个场景、${report.回归检出.length} 类受控回归；DPI ${report.场景[0].DPI}；报告 ${output}`);
  } catch (error) { report.错误 = error.message; console.error(error.message); }
  finally {
    clearTimeout(watchdog); cleanup();
    try { await fs.writeFile(path.join(output, '原生边缘检查.json'), JSON.stringify(report, null, 2), 'utf8'); }
    catch { console.error('原生边缘检查报告写入失败，不能判定为通过'); app.exit(1); return; }
    app.exit(report.通过 ? 0 : 1);
  }
});
