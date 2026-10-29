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
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');
const { quoteJavaScriptString } = require('./javascript-string.cjs');
const { createUiDriver } = require('./ui-driver.cjs');
const { sampleEdges } = require('./native-edge-samples.cjs');
const windowAppearance = require('../src/windows/window-appearance.cjs');
const run = promisify(execFile);
const outputArg = process.argv.indexOf('--output-dir');
const output = path.resolve(outputArg < 0 ? path.join(__dirname, '../output/verification', `native-${Date.now()}`) : process.argv[outputArg + 1]);
const replayArg = process.argv.indexOf('--replay-dir');
const replayDirectory = replayArg < 0 ? null : path.resolve(process.argv[replayArg + 1]);
app.setPath('userData', path.join(os.tmpdir(), `pickgloss-native-edges-${process.pid}`));
app.on('window-all-closed', () => {});
const made = [];
const appearanceControllers = new Map();
let desktop, background, panel;
const state = { view: 'explain', history: [], pinned: false, wide: false, settings: { text: { baseUrl: 'http://127.0.0.1/v1', model: '隔离边缘检查', hasKey: true }, prefs: { appearance: {} } }, status: {}, session: {
  id: '隔离边缘检查', kind: 'text', text: '虚构材料', context: '仅检查自有测试窗口的最终合成边缘。', activeMode: 'context', threads: {
    context: { draft: '', status: 'complete', messages: [{ id: '虚构回答', role: 'assistant', status: 'complete', content: '这是一条隔离验证用的虚构回答。' }] },
    independent: { draft: '', status: 'idle', messages: [] }, visual: { draft: '', status: 'idle', messages: [] },
  },
} };
const report = { 通过: false, 覆盖: 'Windows CopyFromScreen 最终合成；仅自有测试窗及背景', 系统: os.release(), Electron: process.versions.electron, 参数: { 逻辑宽: 300, 逻辑高: 483, 调整后逻辑宽: 321, 调整后逻辑高: 487, 目标外圆角DIP: 14, 圆角判定点DIP: 3.5, 圆角外背景: '#7a3460', 圆角最大背景合成差: 10, 客户区边差阈值: 6, 磨砂外缘最大差: 2, 外缘边差阈值: 8, 光条红通道阈值: 200, 四边厚度最大差物理像素: 1, 柔光允许最大反向跳变: 6, 柔光最小衰减幅度: 10 }, 场景: [], 回归检出: [], 未覆盖: ['其他机器、其他 DPI、真实鼠标拖边和锁屏桌面'] };
const emit = () => desktop?.broadcast(state);
const evaluate = code => panel.webContents.executeJavaScript(code);
const driver = createUiDriver(evaluate);
function sampleImage(image, { scale, pinned, client, nativeBorder, material }) {
  const { width, height } = image.getSize(), bitmap = image.toBitmap();
  const pixel = (x, y) => { const offset = (y * width + x) * 4; return [bitmap[offset + 2], bitmap[offset + 1], bitmap[offset]]; };
  // 系统亚克力外沿若多出一条未着色的透明带，会与内侧半透明纸面形成可见色差。
  return sampleEdges({ width, height, pixel, scale, pinned, client, nativeBorder, cornerRadiusDip: 14, cornerBackground: [122, 52, 96],
    maxOuterDelta: material === 'glass' && !pinned ? 2 : 8 });
}
class TrackedWindow extends BrowserWindow {
  constructor(options) { super({ ...options, webPreferences: { ...options.webPreferences, backgroundThrottling: false } }); made.push(this); }
}
const forbidden = () => { throw Error('隔离边缘检查禁止访问剪贴板、采集、托盘和外部进程'); };
ipcMain.handle('pickgloss:action', async (event, action, payload) => {
  if (action === 'bootstrap') return { ok: true, value: desktop.stateFor(event, state) };
  if (action === 'panel-resize') {
    if (!desktop.authorize(event, action)) return { ok: false, error: '隔离解释窗没有缩放授权' };
    return { ok: true, value: desktop.resizePanel(payload) };
  }
  if (action === 'set-draft') return { ok: true };
  return { ok: false, error: '隔离检查未授权此动作' };
});
function handle(win) { const bytes = win.getNativeWindowHandle(); return String(bytes.length === 8 ? bytes.readBigUInt64LE() : bytes.readUInt32LE()); }
async function inspectResizeHitTest(win) {
  try {
    const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'probe-panel-resize-hit-test.ps1'),
      '-WindowHandle', handle(win), '-OwnerPid', String(process.pid), '-SourcePath', path.join(__dirname, 'panel-resize-hit-test.cs')], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    const native = JSON.parse(result.stdout.trim());
    const renderer = await evaluate(`(()=>{const edges=['n','ne','e','se','s','sw','w','nw'],grips=edges.map(edge=>{const node=document.querySelector('.panel-resize-grip-'+edge),rect=node?.getBoundingClientRect();return {edge,present:Boolean(node),pointerEvents:node&&getComputedStyle(node).pointerEvents,width:rect?.width||0,height:rect?.height||0}});return {grips,passed:grips.length===8&&grips.every(grip=>grip.present&&grip.pointerEvents==='auto'&&grip.width>0&&grip.height>0)}})()`);
    return { ...native, rendererGrips: renderer, passed: native.passed && renderer.passed };
  } catch (error) { throw Error(`自有解释窗原生拖边命中查询失败：${error.stderr || error.message}`); }
}
async function inspectResizeDrag(win) {
  const grip = await evaluate(`(()=>{const node=document.querySelector('.panel-resize-grip-e'),rect=node?.getBoundingClientRect();return rect?{dpr:devicePixelRatio,rect:{left:rect.left,top:rect.top,width:rect.width,height:rect.height},pointerEvents:getComputedStyle(node).pointerEvents}:null})()`);
  if (!grip || grip.pointerEvents !== 'auto' || grip.rect.width <= 0 || grip.rect.height <= 0 || !Number.isFinite(grip.dpr)) {
    throw Error('正式渲染器没有可交互的自定义右侧缩放手柄');
  }
  const x = grip.rect.left + grip.rect.width / 2, y = grip.rect.top + grip.rect.height / 2;
  try {
    const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'probe-panel-resize-hit-test.ps1'),
      '-WindowHandle', handle(win), '-OwnerPid', String(process.pid), '-SourcePath', path.join(__dirname, 'panel-resize-hit-test.cs'),
      '-Custom', '-X', String(x), '-Y', String(y), '-Dpr', String(grip.dpr)], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    return { ...JSON.parse(result.stdout.trim()), grip };
  } catch (error) { throw Error(`自有解释窗右边缘拖动查询失败：${error.stderr || error.message}`); }
}
function glassEdgeContract(layout, pinned) {
  if (!layout?.panelStyle || layout.panelStyle.borderWidth !== '0px') return false;
  if (layout.material === 'glass' && layout.panelStyle.backgroundImage !== 'none') return false;
  const outlined = pinned && layout.pinOutline !== 'none';
  const stroke = layout.pinStrokeStyle, frameMatches = layout.native === true && layout.pinFrameStyle?.display === 'block' && layout.frame &&
    Math.abs(layout.frame.width - layout.panel.width) <= .05 && Math.abs(layout.frame.height - layout.panel.height) <= .05;
  if (!outlined) return layout.panelStyle.boxShadow === 'none' && stroke?.content === 'none' && layout.pinFrameStyle?.display !== 'block';
  const expectedWidth = Number.parseFloat(layout.frameCss?.['--native-pin-band'] || '3px'), actualWidth = Number.parseFloat(stroke?.borderWidth);
  const rendererStrokeMatches = stroke?.content !== 'none' && stroke?.borderStyle === 'solid' && Number.isFinite(actualWidth) &&
    Math.abs(actualWidth - expectedWidth) <= .01 && stroke.borderColor === layout.panelStyle.borderColor && stroke.borderRadius === layout.panelStyle.borderRadius;
  return frameMatches || rendererStrokeMatches;
}
async function capture(name, pinned, beforeSample, { allowStyleOverride = false } = {}) {
  panel.show(); panel.moveTop(); panel.focus();
  await delay(180);
  if (beforeSample) { await beforeSample(); await delay(80); }
  const imagePath = path.join(output, `${name}.png`);
  const backdrop = appearanceControllers.get(panel)?.getBackdropInfo() || null;
  if (state.settings.prefs.appearance.current.material === 'glass' && (!backdrop?.enabled || !backdrop.visible)) throw Error('磨砂截图缺少已启用、可见且归属已核验的自有材质窗');
  const materialArgs = backdrop?.visible ? ['-MaterialHandle', backdrop.handle, '-MaterialPid', String(backdrop.pid)] : [];
  const captured = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'capture-owned-window.ps1'), '-PanelHandle', handle(panel), '-BackgroundHandle', handle(background), '-OwnerPid', String(process.pid), '-OutputPath', imagePath, ...materialArgs], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (captured.error || captured.status !== 0) throw Error(`实屏捕获失败（自有主窗可见=${panel.isVisible()}，背景可见=${background.isVisible()}）：${captured.stderr || captured.error?.code}`);
  const rect = JSON.parse(captured.stdout.trim()), image = nativeImage.createFromPath(imagePath);
  assert.equal(image.isEmpty(), false, '实屏图片必须能解码');
  const { width, height } = image.getSize();
  assert.equal(width, rect.width, '图片宽度必须匹配实际物理矩形');
  assert.equal(height, rect.height, '图片高度必须匹配实际物理矩形');
  const display = screen.getDisplayMatching(panel.getBounds());
  const layout = await evaluate('(()=>{const root=document.documentElement,p=document.querySelector(".panel"),s=p&&getComputedStyle(p),stroke=p&&getComputedStyle(p,"::after"),frame=p?.querySelector(".native-pin-frame"),frameRect=frame?.getBoundingClientRect();return {dpr:devicePixelRatio,material:root.dataset.material,pinOutline:root.dataset.pinOutline,native:root.classList.contains("native-rounded-frame"),borderSuppressed:root.style.getPropertyValue("--native-border-suppressed")==="1",frameCss:Object.fromEntries([...root.style].filter(key=>key.startsWith("--native-")).map(key=>[key,root.style.getPropertyValue(key)])),viewport:{width:innerWidth,height:innerHeight},panel:p?.getBoundingClientRect().toJSON(),panelStyle:s&&{backgroundColor:s.backgroundColor,backgroundImage:s.backgroundImage,backgroundClip:s.backgroundClip,borderColor:s.borderColor,borderWidth:s.borderWidth,borderRadius:s.borderTopLeftRadius,boxShadow:s.boxShadow,overflow:s.overflow},pinStrokeStyle:stroke&&{content:stroke.content,borderWidth:stroke.borderTopWidth,borderStyle:stroke.borderTopStyle,borderColor:stroke.borderTopColor,borderRadius:stroke.borderTopLeftRadius},pinFrameStyle:frame&&{display:getComputedStyle(frame).display},frame:frameRect?.toJSON()}})()');
  const styleContract = glassEdgeContract(layout, pinned);
  if (!allowStyleOverride) assert.equal(styleContract, true, '所有面板状态必须使用零布局边框；有色光条须以原生测得厚度叠画');
  if (rect.nativeBorder.suppressed === null) { rect.nativeBorder.suppressed = layout.borderSuppressed; rect.nativeBorder.抑制状态来源 = 'DwmSetWindowAttribute 成功应答；当前系统不支持读回边色，仍以实屏像素检出黑边'; }
  const result = sampleImage(image, { scale: display.scaleFactor, pinned, client: rect.client, nativeBorder: rect.nativeBorder, material: layout.material });
  return { 名称: name, 图片: path.basename(imagePath), 固定描边: pinned, 材质窗: backdrop, 实际矩形: rect, 逻辑矩形: panel.getBounds(), DPI: display.scaleFactor * 96, 缩放: display.scaleFactor, 请求材质: state.settings.prefs.appearance.current.material, 实际界面: layout, 原生边色: panel.getAccentColor(), ...result,
    pixelPassed: result.passed, glassEdgeContract: styleContract, passed: result.passed && styleContract };
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
    if (replayDirectory) {
      const baseline = JSON.parse(await fs.readFile(path.join(replayDirectory, '原生边缘检查.json'), 'utf8'));
      for (const scene of baseline.场景) {
        const image = nativeImage.createFromPath(path.join(replayDirectory, scene.图片));
        assert.equal(image.isEmpty(), false, `${scene.名称} 基线图片必须能解码`);
        const pinned = scene.固定描边 ?? scene.名称.endsWith('-orange'), sampled = sampleImage(image, { scale: scene.缩放, pinned, client: scene.实际矩形.client, nativeBorder: scene.实际矩形.nativeBorder, material: scene.实际界面?.material });
        const styleContract = glassEdgeContract(scene.实际界面, pinned);
        report.场景.push({ ...scene, ...sampled, pixelPassed: sampled.passed, glassEdgeContract: styleContract, passed: sampled.passed && styleContract });
      }
      for (const scene of baseline.回归检出 || []) {
        const image = nativeImage.createFromPath(path.join(replayDirectory, scene.图片));
        assert.equal(image.isEmpty(), false, `${scene.名称} 受控回归图片必须能解码`);
        const pinned = scene.固定描边 ?? Boolean(scene.corners), sampled = sampleImage(image, { scale: scene.缩放, pinned, client: scene.实际矩形.client, nativeBorder: scene.实际矩形.nativeBorder, material: scene.实际界面?.material });
        const styleContract = glassEdgeContract(scene.实际界面, pinned);
        report.回归检出.push({ ...scene, ...sampled, pixelPassed: sampled.passed, glassEdgeContract: styleContract, passed: sampled.passed && styleContract });
      }
      report.覆盖 = '重放既有自有测试窗实屏图片；不创建窗口';
      report.基线目录 = replayDirectory;
      const failures = report.场景.filter(scene => !scene.passed);
      assert.equal(failures.length, 0, `边缘症状检出：${failures.map(scene => scene.名称).join('、')}`);
      assert.equal(report.回归检出.every(scene => !scene.passed), true, '重放必须仍能检出所有受控回归');
      report.通过 = true;
      console.log(`原生边缘图片重放通过：${report.场景.length} 个场景、${report.回归检出.length} 类受控回归；报告 ${output}`);
      return;
    }
    if (process.platform !== 'win32' || Number(os.release().split('.')[2]) < 22000) throw Error('当前系统不支持待验证的 Windows 11 DWM 路径，原生实屏未覆盖');
    report.材质能力 = { 版本支持磨砂: Number(os.release().split('.')[2]) >= 22621, 减少透明: nativeTheme.prefersReducedTransparency, 高对比: nativeTheme.shouldUseHighContrastColors, 强制颜色: nativeTheme.inForcedColorsMode };
    const area = screen.getPrimaryDisplay().workArea;
    report.主屏DPI = screen.getPrimaryDisplay().scaleFactor * 96;
    assert.ok(area.width >= 340 && area.height >= 523, '桌面工作区无法容纳测试窗口，未覆盖');
    const target = path.resolve(__dirname, '../src/windows/desktop.cjs'), loaded = new Module(target, module);
    loaded.filename = target; loaded.paths = Module._nodeModulePaths(path.dirname(target));
    loaded.require = name => {
      if (name === 'electron') return { ...electron, BrowserWindow: TrackedWindow, clipboard: new Proxy({}, { get: () => forbidden }), Tray: class { constructor() { forbidden(); } }, utilityProcess: { fork: forbidden }, desktopCapturer: { getSources: forbidden } };
      if (name === './window-appearance.cjs') return { ...windowAppearance, createWindowAppearance(win, options) {
        const controller = windowAppearance.createWindowAppearance(win, options); appearanceControllers.set(win, controller); return controller;
      } };
      return Module.prototype.require.call(loaded, name);
    };
    loaded._compile(await fs.readFile(target, 'utf8'), target);
    desktop = loaded.exports.createDesktop({ onAction: forbidden, onSelection: forbidden, onStatus(patch) { Object.assign(state.status, patch); emit(); } });
    desktop.restoreWindowState({ panel: { x: area.x + 20, y: area.y + 20 } });
    assert.ok(area.width >= 360 && area.height >= 540, '工作区无法在测试窗四周保留完整的自有背景余量，未覆盖');
    background = new BrowserWindow({ x: area.x, y: area.y, width: 360, height: 540, frame: false, show: false, backgroundColor: '#7a3460', focusable: false, webPreferences: { sandbox: true } });
    // 所有窗口使用独立会话；网络请求一律取消。
    background.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
    await background.loadURL('data:text/html,<style>html,body{margin:0;background:%237a3460;height:100%}</style>');
    background.setAlwaysOnTop(true, 'pop-up-menu'); background.showInactive();
    desktop.setWide(false); panel = made[0];
    desktop.openPanel(); emit();
    await driver.waitFor('Boolean(document.querySelector(".message"))', '正式渲染器与虚构会话就绪');
    report.窗口拉伸 = await inspectResizeHitTest(panel);
    if (process.argv.includes('--resize-drag-test')) {
      report.窗口实际拖边 = await inspectResizeDrag(panel);
      report.通过 = report.窗口实际拖边.passed;
      console.log(`自有解释窗真实右边缘拖动${report.通过 ? '通过' : '失效'}：${JSON.stringify(report.窗口实际拖边)}`);
      return;
    }
    if (process.argv.includes('--resize-hit-test')) {
      report.通过 = report.窗口拉伸.passed;
      console.log(`自有解释窗原生拖边命中${report.通过 ? '通过' : '失效'}：${JSON.stringify(report.窗口拉伸)}`);
      return;
    }
    if (process.argv.some(value => value === '--material-probe' || value.startsWith('--material-probe=') || value === '--material-probe-solid')) {
      const probeMaterial = process.argv.includes('--material-probe-solid') ? 'solid' : 'glass';
      state.settings.prefs.appearance = { current: { mode: 'dark', material: probeMaterial }, pinOutline: 'orange' };
      state.pinned = false; desktop.setAppearance(state.settings.prefs.appearance); desktop.setPinned(false); desktop.openPanel(); emit();
      await driver.waitFor(`document.documentElement.dataset.material===${quoteJavaScriptString(probeMaterial)}`, '隔离暗色表面就绪');
      if (process.argv.includes('--material-probe-resized')) {
        panel.setBounds({ ...panel.getBounds(), width: 321, height: 487 });
        await delay(250); emit();
      }
      const allProbes = [['当前样式', null], ['移除透明边框', 'html[data-material=glass] .panel{border:0!important}'],
        ['边框改为表面色', 'html[data-material=glass] .panel{border-color:var(--surface)!important}'],
        ['限制背景不绘制到边框下', 'html[data-material=glass] .panel{background-clip:padding-box!important}'],
        ['匹配原生客户区尺寸', 'html.panel-surface .panel{width:var(--native-client-width)!important;height:var(--native-client-height)!important}'],
        ['移除顶部内光', 'html[data-material=glass] .panel{box-shadow:none!important}'],
        ['移除径向染色', 'html[data-material=glass] .panel{background-image:none!important}']];
      const probeArg = process.argv.find(value => value.startsWith('--material-probe='));
      const selected = probeArg ? decodeURIComponent(probeArg.slice(probeArg.indexOf('=') + 1)) : null;
      if (selected === '重复') {
        report.材质探针 = [];
        for (let index = 0; index < 8; index++) report.材质探针.push(await capture(`材质探针-重复-${index + 1}`, false));
        report.通过 = true;
        const values = report.材质探针.map(probe => probe.outerBand.maxDelta);
        console.log(`磨砂边缘稳定性探针完成：maxOuterDelta=${values.join(',')}；材质窗 PID ${report.材质探针[0].材质窗?.pid}、14 DIP、可见 ${report.材质探针.every(probe => probe.材质窗?.visible)}`);
        return;
      }
      const probes = selected ? allProbes.filter(([name]) => name === '当前样式' || name === selected) : allProbes;
      if (selected && probes.length !== (selected === '当前样式' ? 1 : 2)) throw Error(`未知磨砂边缘探针：${selected}`);
      report.材质探针 = [];
      for (const [name, css] of probes) {
        const key = css ? await panel.webContents.insertCSS(css) : null;
        try { report.材质探针.push({ 名称: name, ...(await capture(`材质探针-${name}`, false)) }); }
        finally { if (key) await panel.webContents.removeInsertedCSS(key); }
      }
      report.通过 = true;
      console.log(`磨砂边缘因果探针完成：${report.材质探针.map(probe => `${probe.名称}=${probe.outerBand.maxDelta}`).join('，')}`);
      return;
    }
    if (process.argv.includes('--inject-capture-failure')) throw Error('受控实屏失败：用于验证非零退出与窗口清理');
    for (const mode of ['dark', 'light']) for (const material of ['solid', 'glass']) for (const pin of ['idle', 'orange', 'none']) {
      state.settings.prefs.appearance = { current: { mode, material }, pinOutline: pin === 'none' ? 'none' : 'orange' };
      state.pinned = pin !== 'idle'; desktop.setAppearance(state.settings.prefs.appearance); desktop.setPinned(state.pinned); desktop.openPanel(); emit();
      await driver.waitFor(`document.documentElement.dataset.appearance===${quoteJavaScriptString(mode)} && document.documentElement.dataset.material===${quoteJavaScriptString(material)} && document.documentElement.dataset.pinOutline===${quoteJavaScriptString(pin === 'none' ? 'none' : 'orange')} && document.querySelector('.panel').classList.contains('is-pinned')===${state.pinned} && (()=>{const root=document.documentElement,p=document.querySelector('.panel'),width=parseFloat(root.style.getPropertyValue('--native-client-width'));return !Number.isFinite(width)||Math.abs(p.getBoundingClientRect().width-width)<.02})()`, '主题、材质、窗口角点及物理客户区尺寸同步', { stage: `${mode}-${material}-${pin}` });
      await evaluate('Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))');
      const result = await capture(`${mode}-${material}-${pin}`, pin === 'orange');
      report.场景.push(result);
      if (material !== result.实际界面.material) report.未覆盖.push(`${result.名称} 请求的磨砂回退为 ${result.实际界面.material}，磨砂未覆盖`);
    }
    panel.setBounds({ ...panel.getBounds(), width: 321, height: 487 });
    for (const material of ['solid', 'glass']) for (const pin of ['idle', 'orange']) {
      state.settings.prefs.appearance = { current: { mode: 'dark', material }, pinOutline: 'orange' };
      state.pinned = pin === 'orange'; desktop.setAppearance(state.settings.prefs.appearance); desktop.setPinned(state.pinned); emit();
      await driver.waitFor(`document.documentElement.dataset.material===${quoteJavaScriptString(material)} && (()=>{const root=document.documentElement,p=document.querySelector('.panel'),width=parseFloat(root.style.getPropertyValue('--native-client-width'));return !Number.isFinite(width)||Math.abs(p.getBoundingClientRect().width-width)<.02})()`, '改尺寸后的材质与物理客户区尺寸同步');
      await delay(220);
      report.场景.push(await capture(`dark-${material}-${pin}-resized`, state.pinned));
    }
    const failures = report.场景.filter(scene => !scene.passed);
    assert.equal(failures.length, 0, `边缘症状检出：${failures.map(scene => scene.名称).join('、')}`);
    assert.equal(report.窗口拉伸.passed, true, `解释窗原生客户区/渲染器缩放手柄合同失效：${JSON.stringify(report.窗口拉伸)}`);
    // 仅改变自有测试窗的 CSS；正式源码和用户实例保持原状。
    for (const [name, pinned, css, material, beforeSample] of [
      ['普通外缘灰线', false, '.panel{border:1px solid rgb(85,85,85)!important}', 'solid'],
      ['重复裁切与底板凸出', true, '.panel{border-radius:12px!important;overflow:hidden!important}', 'solid'],
      ['固定描边单侧加宽', true, '.panel.is-pinned{border-left-width:2px!important}', 'solid'],
      ['移除固定描边柔光', true, '.panel.is-pinned::after{box-shadow:none!important}', 'solid'],
      ['恢复磨砂顶部内光线', false, 'html.panel-surface[data-material=glass] .panel{box-shadow:inset 0 1px 0 #ffffff20!important}', 'glass'],
      ['磨砂固定描边缩窄到 1 DIP', true, 'html.panel-surface[data-material=glass] .panel.is-pinned::after{border-width:1px!important}', 'glass'],
      ['恢复磨砂径向色带', false, 'html.panel-surface[data-material=glass] .panel{background-image:radial-gradient(ellipse at 0 0,rgba(255,0,255,.8),transparent 30%)!important}', 'glass'],
    ]) {
      state.settings.prefs.appearance = { current: { mode: 'dark', material }, pinOutline: 'orange' };
      state.pinned = pinned; desktop.setAppearance(state.settings.prefs.appearance); desktop.setPinned(pinned); emit();
      await delay(220);
      const key = css ? await panel.webContents.insertCSS(css) : null;
      try {
        const result = await capture(`受控回归-${name}`, pinned, beforeSample, { allowStyleOverride: true });
        report.回归检出.push(result);
        assert.equal(result.passed, false, `工具没有检出${name}`);
      } finally { if (key) await panel.webContents.removeInsertedCSS(key); }
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
