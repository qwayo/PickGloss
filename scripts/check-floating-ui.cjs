'use strict';
const { quoteJavaScriptString } = require('./javascript-string.cjs');
// 使用正式渲染器和桌面模块，隔离数据、模型、剪贴板、划词进程与托盘。
const electron = require('electron');
const { app, ipcMain } = electron;
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { createUiDriver } = require('./ui-driver.cjs');
const { previewSnapshot } = require('./preview-layout.cjs');
const { redact } = require('./checked-runner.cjs');
const root = path.resolve(process.argv.find(a => a.startsWith('--source-root='))?.slice(14) || path.join(__dirname, '..'));
const outputIndex = process.argv.indexOf('--output-dir');
const output = outputIndex < 0 ? path.resolve(__dirname, '../output/verification/floating-20261021') : path.resolve(process.argv[outputIndex + 1]);
const before = process.argv.includes('--before');
const preview = process.argv.includes('--preview');
// 隐藏离屏证据使用软件输出设备，避免 CI GPU 合成表面的复制与初始化差异。
if (!preview) app.disableHardwareAcceleration();
app.setPath('userData', path.join(os.tmpdir(), `pickgloss-floating-${process.pid}`));
const windows = [];
class TestWindow extends electron.BrowserWindow {
  constructor(options) { super({ ...options, show: false, webPreferences: { ...options.webPreferences, offscreen: !preview, backgroundThrottling: false } }); this.testOptions = options; windows.push(this);
    if (process.argv.includes('--capture-page-failure')) this.webContents.capturePage = async () => { throw Error('UnknownVizError'); };
  }
  show() {} showInactive() {} focus() {}
  setBounds(bounds) { this.resizeCalls ||= []; this.resizeCalls.push({ width: bounds.width, height: bounds.height }); super.setBounds(bounds); }
  setShape(rects) { this.testShape = rects; super.setShape(rects); }
  loadFile(file, options) {
    if (options?.query?.window === 'menu' && process.argv.includes('--menu-navigation-probe')) {
      let navigating = true;
      const execute = this.webContents.executeJavaScript.bind(this.webContents);
      // 隔离夹具模拟初始导航替换执行上下文；页面就绪后不再注入故障。
      this.webContents.executeJavaScript = (...args) => navigating ? Promise.reject(Error('隔离菜单导航期间执行上下文不可用')) : execute(...args);
      return delay(60).then(() => super.loadFile(file, options)).finally(() => { navigating = false; });
    }
    return super.loadFile(file, options);
  }
}
let desktop, panel, store, state, failSave = false, fixtureReducedMotion = false, currentPhase = '初始化';
const errors = [], checks = [], screenshots = [];
const evaluate = code => panel.webContents.executeJavaScript(code);
const driver = createUiDriver(evaluate, { timeoutMs: 7000, intervalMs: 10 });
async function until(predicate, label) {
  currentPhase = label;
  driver.phase(label);
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(10); }
  driver.phase(label);
  throw await driver.diagnose(label);
}
async function checkMenu() {
  desktop.menu({ source: 'panel' });
  const menu = windows.find(win => win.testOptions.webPreferences && win.webContents.getURL().includes('window=menu')) || windows.at(-1);
  await until(() => menu.webContents.getURL().includes('window=menu') && !menu.webContents.isLoadingMainFrame(), '菜单初始导航完成');
  await until(() => menu.webContents.executeJavaScript(`Boolean(document.querySelector('[data-menu-command="general-settings"]'))`), '快捷菜单常规设置入口');
  assert.notEqual(await menu.webContents.executeJavaScript(`document.querySelector('[data-menu-command="settings"] .icon').innerHTML`), await menu.webContents.executeJavaScript(`document.querySelector('[data-menu-command="general-settings"] .icon').innerHTML`), 'AI 图标与常规齿轮区分');
  await shot('快捷菜单-常规设置入口', menu);
  await menu.webContents.executeJavaScript(`document.querySelector('[data-menu-command="general-settings"]').click()`);
  await until(() => evaluate(`document.querySelector('[data-settings-section="general"]')?.hidden === false`), '菜单直达常规设置');
}
async function click(selector) {
  await driver.waitFor(`Boolean(document.querySelector(${quoteJavaScriptString(selector)})?.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}))`, '切换动画结束且控件可见', { stage: `点击控件 ${selector}`, allowErrors: true });
  await driver.click(undefined, { selector, stage: `点击控件 ${selector}` });
}
async function shot(name, win = panel) {
  currentPhase = `截图：${name}`; driver.phase(currentPhase);
  await win.webContents.executeJavaScript('Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))');
  await win.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  const offscreen = win.webContents.isOffscreen();
  const frame = offscreen ? await new Promise((resolve, reject) => {
    const finish = (error, bitmap) => { clearTimeout(timer); win.webContents.off('paint', painted); error ? reject(error) : resolve(bitmap); };
    const painted = (_event, _dirty, bitmap) => finish(bitmap?.isEmpty() === false ? null : Error('离屏绘制返回空画面'), bitmap);
    const timer = setTimeout(() => finish(Error('离屏重绘帧等待超时')), 5000);
    win.webContents.once('paint', painted);
    try { win.webContents.startPainting(); win.webContents.invalidate(); } catch (error) { finish(error); }
  }) : await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
  assert.equal(frame.isEmpty(), false, '截图证据必须包含真实画面');
  await fs.writeFile(path.join(output, `${before ? '修复前-' : ''}${name}.png`), frame.toPNG());
  screenshots.push({ 名称: name, 取证方式: offscreen ? '离屏重绘 paint 帧' : '页面截图', 像素尺寸: frame.getSize() });
  await fs.writeFile(path.join(output, '截图取证.json'), JSON.stringify(screenshots, null, 2));
}
function emit() { desktop.broadcast(state); }
async function checkPreviewLayouts() {
  const originalSession = state.session, originalVision = state.settings.vision;
  const rounds = Number(process.argv.find(arg => arg.startsWith('--preview-rounds='))?.split('=')[1] || 1);
  assert.ok(Number.isInteger(rounds) && rounds >= 1 && rounds <= 500, '采样轮数必须在 1 至 500 之间');
  const samples = [];
  const cpuRate = Number(process.argv.find(arg => arg.startsWith('--preview-cpu-rate='))?.split('=')[1] || 1);
  const imageDelay = Number(process.argv.find(arg => arg.startsWith('--preview-image-delay='))?.split('=')[1] || 0);
  const viewportHeight = Number(process.argv.find(arg => arg.startsWith('--preview-height='))?.split('=')[1] || 0);
  assert.ok(Number.isFinite(cpuRate) && cpuRate >= 1 && cpuRate <= 20, 'CPU 降速倍率必须在 1 至 20 之间');
  assert.ok(Number.isInteger(imageDelay) && imageDelay >= 0 && imageDelay <= 2000, '图片受控延迟必须在 0 至 2000 毫秒之间');
  assert.ok(Number.isInteger(viewportHeight) && (viewportHeight === 0 || viewportHeight >= 400 && viewportHeight <= 700), '探针视口高度必须在 400 至 700 之间');
  if (cpuRate !== 1) await panel.webContents.debugger.sendCommand('Emulation.setCPUThrottlingRate', { rate: cpuRate });
  if (viewportHeight) await panel.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: 300, height: viewportHeight, deviceScaleFactor: 1, mobile: false });
  if (imageDelay) await evaluate(`(()=>{const original=Element.prototype.setAttribute;Element.prototype.setAttribute=function(key,value){if(this instanceof HTMLImageElement&&key==='src'){setTimeout(()=>original.call(this,key,value),${imageDelay});return;}return original.call(this,key,value)}})()`);
  if (process.argv.includes('--preview-inject-overflow')) await panel.webContents.insertCSS('.recognition-preview .form-actions{margin-top:500px!important}');
  state.settings.vision = { baseUrl: 'http://127.0.0.1/v1', model: '隔离识图模型' };
  try {
    for (let round = 0; round < rounds; round++) for (const [width, height] of [[640,180],[180,640]]) {
      const imageData = await evaluate(`(()=>{const c=document.createElement('canvas');c.width=${width};c.height=${height};const x=c.getContext('2d');x.fillStyle='#e9edf2';x.fillRect(0,0,c.width,c.height);x.fillStyle='#252525';x.font='20px sans-serif';x.fillText('截图验证材料',16,40);return c.toDataURL('image/png')})()`);
      state.session = { ...originalSession, kind: 'image', imageData }; state.view = 'preview'; emit();
      await until(() => evaluate('Boolean(document.querySelector(".recognition-preview .preview-image"))'), '截图确认页');
      const snapshot = await evaluate(`(${previewSnapshot.toString()})()`);
      samples.push({ round, width, height, window: panel.getBounds(), expectedImage: snapshot.image?.width === width && snapshot.image?.height === height, ...snapshot });
      await fs.writeFile(path.join(output, '截图预览布局采样.json'), JSON.stringify({ conditions: { cpuRate, imageDelay, viewportHeight }, samples, failures: samples.filter(s => !s.fits).length }, null, 2));
      if (!process.argv.includes('--preview-probe')) assert.equal(snapshot.fits, true, `截图 ${width}×${height} 默认小窗完整显示`);
    }
    assert.equal(samples.filter(s => !s.fits).length, 0, '截图预览采样存在溢出，详见结构化报告');
  } finally { state.session = originalSession; state.settings.vision = originalVision; }
}
async function handle(action, payload = {}) {
  if (action === 'bootstrap') return state;
  if (action === 'save-settings') {
    if (failSave) throw Error('隔离验证写盘失败');
    state.settings = await store.saveSettings(payload); desktop.setAppearance(state.settings.prefs.appearance);
  } else if (action === 'pin') { state.pinned = payload.pinned; desktop.setPinned(payload.pinned); }
  else if (action === 'wide') { state.wide = payload.wide; desktop.setWide(payload.wide); }
  else if (action === 'navigate') state.view = payload.view;
  else if (action === 'set-draft') return;
  else if (action === 'orb-drag') return desktop.dragOrb(payload);
  else if (action === 'orb-hover') return desktop.hoverOrb(payload.active);
  else if (action === 'panel-resize') return desktop.resizePanel(payload);
  else if (action === 'menu-ready') return desktop.menuReady(payload);
  else if (action === 'menu-close') return desktop.closeMenu(payload);
  else if (action === 'open-settings') { desktop.closeMenu(); state.view = 'settings'; state.settingsSection = payload.section === 'general' ? 'general' : 'service'; }
  else throw Error(`隔离检查不支持动作：${action}`);
  emit(); return state.settings;
}
ipcMain.handle('pickgloss:action', async (_event, action, payload) => {
  try { return { ok: true, value: await handle(action, payload) }; }
  catch (error) { return { ok: false, error: error.message }; }
});
app.whenReady().then(async () => {
  const timeout = setTimeout(() => { desktop?.dispose(); app.exit(1); }, 60000);
  try {
    await fs.mkdir(output, { recursive: true });
    const { createStore } = require(path.join(root, 'src/core/store.cjs'));
    store = createStore({ directory: path.join(app.getPath('userData'), '隔离数据') }); await store.init();
    const session = await store.createSession({ text: 'compound', context: 'Small changes compound over time.', threads: { independent: { status: 'idle', draft: '', messages: [] }, visual: { status: 'idle', draft: '', messages: [] }, context: { status: 'done', draft: '', messages: [{ id: '回答', role: 'assistant', content: '## 逐渐累积\n\n微小的改变不断叠加，最终形成可见的进步。\n\n' + Array.from({ length: 10 }, (_, i) => `### 阅读段落 ${i + 1}\n\n坚持练习，把新知识与已有经验联系起来。`).join('\n\n'), status: 'complete' }] } } });
    state = { view: 'explain', session, settings: await store.getSettings(), history: [], pinned: false, wide: false, status: {} };
    const target = path.join(root, 'src/windows/desktop.cjs'), loaded = new Module(target, module);
    loaded.filename = target; loaded.paths = module.paths;
    const forbidden = () => { throw Error('隔离检查禁止访问桌面采集和托盘'); };
    loaded.require = name => name === 'electron' ? { ...electron, BrowserWindow: TestWindow,
      systemPreferences: { ...electron.systemPreferences, getAnimationSettings: () => preview ? electron.systemPreferences.getAnimationSettings() : { prefersReducedMotion: fixtureReducedMotion, shouldRenderRichAnimation: !fixtureReducedMotion } },
      Tray: class { constructor() { forbidden(); } }, utilityProcess: { fork: forbidden }, desktopCapturer: { getSources: forbidden } } : Module.prototype.require.call(loaded, name);
    loaded._compile(await fs.readFile(target, 'utf8'), target);
    desktop = loaded.exports.createDesktop({ onAction() {}, onSelection() {}, onStatus(patch) { Object.assign(state.status, patch); if (typeof patch.wide === 'boolean') state.wide = patch.wide; emit(); } });
    desktop.setAppearance(state.settings.prefs.appearance); desktop.setWide(false); panel = windows[0];
    panel.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
    await until(() => evaluate('Boolean(document.querySelector(".message"))'), '正式界面');
    if (!preview) {
      panel.webContents.debugger.attach('1.3');
      await panel.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
      await until(() => evaluate('!matchMedia("(prefers-reduced-motion: reduce)").matches && !document.documentElement.classList.contains("reduced-motion")'), '隐藏窗口正常动效媒体');
    }
    if (process.argv.includes('--position-only')) {
      const area = electron.screen.getPrimaryDisplay().workArea, records = [];
      for (let round = 0; round < 3; round++) for (const fraction of [.52, .64, .8]) {
        const original = { x: Math.min(area.x + area.width - 308, Math.round(area.x + area.width * fraction)), y: area.y + 30, width: 300, height: 483 };
        panel.setBounds(original);
        await handle('wide', { wide: true }); await until(() => !state.status.windowTransitioning, '展开落位');
        const reading = panel.getBounds(); panel.setPosition(reading.x + 1, reading.y);
        await handle('wide', { wide: false }); await until(() => !state.status.windowTransitioning, '右侧收窄');
        const result = panel.getBounds(); records.push({ round, original, reading, result });
        assert.ok(Math.abs(result.x - original.x) <= 1, `小窗从 ${original.x} 跳到 ${result.x}`);
      }
      await until(() => evaluate('!document.documentElement.classList.contains("layout-preparing")'), '切换内容显示');
      await fs.writeFile(path.join(output, '右侧往返检查.json'), JSON.stringify({ 通过: true, 正式原生窗口尺寸调用: true, 虚构会话: true, records }, null, 2));
      console.log('正式窗口三轮、九次右侧往返与一像素落位偏差检查通过。');
      clearTimeout(timeout); desktop.dispose(); app.exit(0); return;
    }
    if (process.argv.includes('--motion-only')) {
      await evaluate('window.__motion=[];window.__run=true;function sample(){if(!__run)return;const a=document.querySelector(".answer-pane"),s=document.querySelector(".source-pane");if(a&&s){const x=a.getBoundingClientRect(),y=s.getBoundingClientRect();__motion.push({transform:getComputedStyle(a).transform,overlap:Math.max(0,Math.min(x.right,y.right)-Math.max(x.left,y.left))*Math.max(0,Math.min(x.bottom,y.bottom)-Math.max(x.top,y.top))})}requestAnimationFrame(sample)}sample()');
      for (let i = 0; i < 3; i++) { await handle('wide', { wide: true }); await until(() => !state.status.windowTransitioning, '展开'); await handle('wide', { wide: false }); await until(() => !state.status.windowTransitioning, '收窄'); }
      const frames = await evaluate('window.__run=false;window.__motion');
      const report = { 采样帧: frames.length, 重叠帧: frames.filter(f => f.overlap > 1).length, 文字变换帧: frames.filter(f => f.transform !== 'none').length, 最大重叠面积: Math.max(...frames.map(f => f.overlap)) };
      console.log(JSON.stringify(report));
      await fs.writeFile(path.join(output, root.includes('baseline') ? '修复前展开采样.json' : '修复后展开采样.json'), JSON.stringify(report, null, 2));
      assert.equal(report.重叠帧, 0, '原文与回答在展开中不能相互覆盖');
      assert.equal(report.文字变换帧, 0, '不断变化的文字行宽不能再叠加整栏位移');
      clearTimeout(timeout); desktop.dispose(); app.exit(0); return;
    }
    if (preview) {
      clearTimeout(timeout);
      state.view = 'settings'; state.settingsSection = 'appearance';
      state.settings.prefs.appearance.current.material = 'glass';
      desktop.setAppearance(state.settings.prefs.appearance); desktop.setPinned(true); state.pinned = true;
      panel.setBounds({ x: 140, y: 100, width: 860, height: 690 }); panel.setTitle('PickGloss 本轮悬浮窗验证'); emit();
      electron.BrowserWindow.prototype.show.call(panel);
      console.log('隔离桌面验证窗口已打开；仅虚构材料，无采集和真实服务。');
      const finish = () => { desktop.dispose(); app.exit(0); };
      const stopFile = path.join(output, '停止预览');
      const poll = setInterval(async () => { if (await fs.stat(stopFile).then(() => true, () => false)) { clearInterval(poll); finish(); } }, 500);
      setTimeout(finish, 180000); return;
    }
    if (process.argv.includes('--preview-layout-only')) {
      await checkPreviewLayouts();
      clearTimeout(timeout); desktop.dispose(); app.exit(0); return;
    }
    if (process.argv.includes('--menu-only')) {
      await checkMenu();
      clearTimeout(timeout); desktop.dispose(); app.exit(0); return;
    }
    await shot('深色小窗');
    if (before) {
      checks.push({ 背景: await evaluate('getComputedStyle(document.documentElement).getPropertyValue("--paper").trim()'), 原生圆角裁剪: Boolean(panel.testShape) });
      await handle('navigate', { view: 'paste' });
      checks.push(await evaluate('(()=>{const b=document.querySelector(".panel-body");return {识别页可见高度:b.clientHeight,识别页内容高度:b.scrollHeight}})()'));
      await shot('识别页');
      await fs.writeFile(path.join(output, '修复前.json'), JSON.stringify(checks, null, 2));
      assert.equal(checks[0].背景, '#252525', '深色默认背景必须为 #252525');
    }
    assert.equal(await evaluate('getComputedStyle(document.documentElement).getPropertyValue("--paper").trim()'), '#252525');
    // 透明画布采用与 OCR 工具条相同的 14 DIP 圆角；不恢复旧系统 8 DIP 外框或像素区域裁切。
    for (const mode of ['light', 'dark', 'light', 'dark']) for (const material of ['glass', 'solid']) {
      state.settings.prefs.appearance.current = { ...state.settings.prefs.appearance.current, mode, material };
      desktop.setAppearance(state.settings.prefs.appearance); emit();
      await until(() => evaluate(`document.documentElement.dataset.appearance===${quoteJavaScriptString(mode)}`), '主题切换');
      await until(() => evaluate(`document.documentElement.dataset.material===${quoteJavaScriptString(material)}`), '材质应答就绪');
      assert.equal(panel.testShape, undefined, '不能再用像素区域裁切');
      assert.equal(panel.testOptions.transparent, true);
      assert.equal(await evaluate('getComputedStyle(document.documentElement).getPropertyValue("--panel-radius").trim()'), '14px', '与 OCR 工具条共用 14 DIP 圆角');
      assert.equal(await evaluate('getComputedStyle(document.querySelector(".panel")).borderTopLeftRadius'), '14px');
      assert.equal(await evaluate('getComputedStyle(document.querySelector(".panel")).overflow'), 'hidden', '内容与内侧描边留在圆角内');
      if (material === 'solid') assert.equal(await evaluate('getComputedStyle(document.querySelector(".panel")).borderLeftWidth'), '0px', '实色与磨砂共用无边框盒模型，切换时不挤动正文');
      const rootBackground = await evaluate('getComputedStyle(document.documentElement).backgroundColor');
      assert.equal(rootBackground, 'rgba(0, 0, 0, 0)', '实色和磨砂共用透明根画布，底面在圆角内绘制');
      if (material === 'glass') {
        assert.equal(await evaluate('getComputedStyle(document.querySelector(".panel")).borderLeftWidth'), '0px', '磨砂外沿没有透明边框带');
        assert.equal(await evaluate('getComputedStyle(document.querySelector(".panel")).backgroundImage'), 'none', '磨砂外沿没有径向染色色带');
      }
      await until(() => evaluate(`document.documentElement.style.getPropertyValue('--native-border-suppressed')==='1' && parseFloat(document.documentElement.style.getPropertyValue('--native-client-width'))>0`), '原生几何应答同步');
      const nativeGeometry = await evaluate('(()=>{const s=document.documentElement.style;return {width:parseFloat(s.getPropertyValue("--native-client-width")),height:parseFloat(s.getPropertyValue("--native-client-height")),band:parseFloat(s.getPropertyValue("--native-pin-band")),left:parseFloat(s.getPropertyValue("--native-pin-left")),top:parseFloat(s.getPropertyValue("--native-pin-top")),right:parseFloat(s.getPropertyValue("--native-pin-right")),bottom:parseFloat(s.getPropertyValue("--native-pin-bottom"))}})()');
      assert.ok(nativeGeometry.width > 0 && nativeGeometry.height > 0 && nativeGeometry.band > 0, '光条采用原生助手返回的有效客户区尺寸');
      assert.ok(['left', 'top', 'right', 'bottom'].every(edge => nativeGeometry[edge] >= 0 && nativeGeometry[edge] <= nativeGeometry.band), '内孔四边扣除非客户区后仍在总色带以内');
      assert.equal(await evaluate('getComputedStyle(document.documentElement).getPropertyValue("--paper").trim()'), mode === 'dark' ? '#252525' : '#ffffff');
      if (material === 'glass') await shot(`${mode === 'dark' ? '深色' : '浅色'}磨砂`);
    }
    checks.push({ 检查: '八次明暗与材质切换', 通过: true });
    await handle('pin', { pinned: true });
    await until(() => evaluate('Boolean(document.querySelector(".panel-bar .is-pinned"))'), '置顶状态');
    const pinBand = await evaluate('parseFloat(document.documentElement.style.getPropertyValue("--native-pin-band"))');
    assert.ok(pinBand > 0, '固定描边必须取得原生实体光条厚度');
    // CSS 边框按渲染器像素向下对齐；离屏渲染比例可能与原生助手的桌面 DPI 不同。
    const renderScale = await evaluate('devicePixelRatio');
    assert.equal(await evaluate('parseFloat(getComputedStyle(document.querySelector(".panel"),"::after").borderTopWidth)'), Math.floor(pinBand * renderScale) / renderScale, '固定描边按原生实体光条厚度在渲染器像素对齐后叠画');
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".panel")).borderTopWidth'), '0px', '实体光条不参与正文盒模型');
    const pinShadow = await evaluate('getComputedStyle(document.querySelector(".panel"),"::after").boxShadow');
    assert.ok(pinShadow.includes('0.4') && pinShadow.includes('0.16'), '恢复原有两层柔光强度');
    assert.equal(await evaluate('document.querySelector(".native-pin-frame")'), null, '不叠加旧系统圆角路径的额外光条');
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".panel"),"::after").pointerEvents'), 'none');
    await until(() => evaluate('(()=>{const s=document.documentElement.style,r=document.querySelector(".panel").getBoundingClientRect();return Math.abs(r.width-parseFloat(s.getPropertyValue("--native-client-width")))<.05&&Math.abs(r.height-parseFloat(s.getPropertyValue("--native-client-height")))<.05})()'), '面板与描边尺寸采用实际物理客户区');
    assert.equal(await evaluate('document.documentElement.style.getPropertyValue("--native-border-suppressed")'), '1', '固定时助手仍关闭原生强调边色');
    await shot('置顶-恢复原发光与页面圆角');
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".panel-bar .is-pinned .icon path")).fill'), await evaluate('getComputedStyle(document.querySelector(".panel-bar .is-pinned .icon")).color'));
    state.view = 'settings'; state.settingsSection = 'appearance'; emit();
    await until(() => evaluate('Boolean(document.querySelector(".appearance-page"))'), '外观设置');
    await click('[data-pin-outline="blue"]');
    await until(async () => (await store.getSettings()).prefs.appearance.pinOutline === 'blue', '置顶颜色写盘');
    assert.equal(await evaluate('document.documentElement.style.getPropertyValue("--native-border-suppressed")'), '1');
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".panel"),"::after").borderTopColor'), 'rgb(80, 149, 232)', '固定描边颜色采用已保存的雾蓝');
    assert.equal(windows.some(win => win.webContents.getURL().includes('pin-glow.html')), false);
    assert.equal(await evaluate('getComputedStyle(document.documentElement).getPropertyValue("--pin-glow").trim()'), '80 149 232');
    assert.ok(await evaluate('getComputedStyle(document.querySelector(".panel"),"::after").boxShadow.includes("inset")'));
    await click('[data-pin-outline="none"]');
    await until(async () => (await store.getSettings()).prefs.appearance.pinOutline === 'none', '无描边写盘');
    assert.equal(state.pinned, true);
    assert.equal(await evaluate('document.querySelector(".native-pin-frame")'), null, '无描边不创建额外绘制层');
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".panel"),"::after").content'), 'none');
    await panel.webContents.reload(); await until(() => evaluate('Boolean(document.querySelector("[data-pin-outline=none][aria-pressed=true]"))'), '无描边重载读回');
    failSave = true; await click('[data-pin-outline="violet"]');
    await until(() => evaluate('Boolean(document.querySelector(".appearance-notice.is-error"))'), '保存失败');
    assert.equal((await store.getSettings()).prefs.appearance.pinOutline, 'none'); failSave = false;
    checks.push({ 检查: '置顶填充图标、颜色持久化、无描边和失败保留', 通过: true });
    // 指针必须在实际色板上命中，不能依赖系统置顶颜色弹窗。
    await click('[data-color-toggle="accent"]');
    await evaluate('document.querySelector("[data-color-plane=accent]").scrollIntoView({block:"center"})');
    const point = await evaluate('(()=>{const r=document.querySelector("[data-color-plane=accent]").getBoundingClientRect();return {x:Math.round(r.x+r.width*.7),y:Math.round(r.y+r.height*.3)}})()');
    panel.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
    panel.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
    await until(() => evaluate('document.querySelector("[data-field=appearance-accent-hex]").value!=="#000000"'), '色板实际点击');
    assert.equal(await evaluate('Boolean(document.querySelector("[data-color-plane=accent] .color-thumb"))'), true);
    await shot('外观设置');
    await handle('wide', { wide: true }); await until(() => !state.status.windowTransitioning, '宽屏配色器');
    await evaluate('document.querySelector(".panel-body").scrollTop=0'); await shot('外观设置-阅读尺寸');
    await handle('wide', { wide: false }); await until(() => !state.status.windowTransitioning, '恢复小窗');
    checks.push({ 检查: '真实鼠标点击色板及光标显示', 通过: true });
    await click('.appearance-preset[data-preset="default"]');
    await handle('navigate', { view: 'paste' });
    await until(() => evaluate('Boolean(document.querySelector("[data-field=paste-text]"))'), '识别页面');
    const fit = await evaluate('(()=>{const b=document.querySelector(".panel-body"),r=b.getBoundingClientRect(),a=document.querySelector(".form-actions").getBoundingClientRect();return {高度:b.clientHeight,内容:b.scrollHeight,操作可见:a.bottom<=r.bottom,缩放:document.querySelector("#app").style.zoom,滚动条:getComputedStyle(b).scrollbarWidth}})()');
    assert.ok(fit.内容 <= fit.高度 + 1 && fit.操作可见, JSON.stringify(fit)); assert.equal(fit.缩放, '1'); assert.equal(fit.滚动条, 'none');
    await shot('识别页'); checks.push({ 检查: '300×483 默认缩放识别页完整显示', ...fit });
    await checkPreviewLayouts();
    await shot('截图确认页');
    checks.push({ 检查: '默认小窗截图确认页横图与竖图均完整显示', 通过: true });
    await handle('navigate', { view: 'explain' });
    await until(() => evaluate('Boolean(document.querySelector(".message"))'), '解释返回');
    await evaluate('window.__paneFrames=[];window.__sampling=true;function sample(){if(!window.__sampling)return;const s=document.querySelector(".source-pane"),a=document.querySelector(".answer-pane");if(s&&a){const x=s.getBoundingClientRect(),y=a.getBoundingClientRect();__paneFrames.push({overlap:Math.max(0,Math.min(x.right,y.right)-Math.max(x.left,y.left))*Math.max(0,Math.min(x.bottom,y.bottom)-Math.max(x.top,y.top)),transform:getComputedStyle(a).transform})}requestAnimationFrame(sample)}sample()');
    for (let i = 0; i < 3; i++) {
      await handle('wide', { wide: true }); await until(() => !state.status.windowTransitioning, '展开');
      await handle('wide', { wide: false }); await until(() => !state.status.windowTransitioning, '收窄');
    }
    const frames = await evaluate('window.__sampling=false;window.__paneFrames');
    assert.ok(panel.resizeCalls.every(b => [300,860].includes(b.width)), '原生尺寸只能使用两种目标宽度，不得存在持续换行的中间宽度');
    assert.ok(frames.length > 5); assert.equal(frames.some(f => f.overlap > 1 || f.transform !== 'none'), false, '原文与回答不能在展开中重叠或对文字叠加变换');
    await handle('wide', { wide: true }); await delay(60); await handle('wide', { wide: false }); await until(() => !state.status.windowTransitioning, '即时反向');
    assert.equal(panel.getBounds().width, 300);
    await until(() => evaluate('!document.documentElement.classList.contains("layout-preparing")'), '目标内容恢复显示');
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".panel-body")).visibility'), 'visible');
    checks.push({ 检查: '三轮往返逐帧检查及即时反向', 采样帧: frames.length, 重叠: false });
    // 减少动态效果是另一条必检路径；不跳过上方正常动效的逐帧断言。
    await evaluate('Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))');
    fixtureReducedMotion = true;
    const reducedResizeStart = panel.resizeCalls.length;
    for (const wide of [true, false]) {
      await handle('wide', { wide });
      assert.equal(state.status.reducedMotion, true);
      assert.equal(state.status.windowTransitioning, false, '减少动态效果时直接提交目标尺寸');
      assert.equal(panel.getBounds().width, wide ? 860 : 300);
    }
    assert.deepEqual(panel.resizeCalls.slice(reducedResizeStart).map(bounds => bounds.width), [860, 300], '减少动态效果时每次仅写入一次目标尺寸');
    await until(() => evaluate('document.documentElement.classList.contains("reduced-motion")'), '原生减少动态效果同步');
    assert.equal(await evaluate('document.querySelector(".panel-body").getAnimations().length'), 0, '减少动态效果时不播放布局恢复动画');
    fixtureReducedMotion = false; desktop.setAppearance(state.settings.prefs.appearance);
    await until(() => evaluate('!document.documentElement.classList.contains("reduced-motion")'), '原生正常动效恢复');
    checks.push({ 检查: '原生减少动态效果直接落位及正常动效恢复', 通过: true });
    desktop.setOrb(true); const orb = windows.find(w => w !== panel && !w.getParentWindow());
    await until(() => orb.webContents.executeJavaScript('Boolean(document.querySelector(".orb"))'), '悬浮球');
    await shot('深色悬浮球', orb);
    const ball = await orb.webContents.executeJavaScript('({背景:getComputedStyle(document.querySelector(".orb")).backgroundColor,高光:getComputedStyle(document.querySelector(".orb")).backgroundImage})');
    assert.equal(ball.背景, 'rgba(0, 0, 0, 0)', '悬空品牌没有球面底板'); assert.equal(ball.高光, 'none');
    await checkMenu();
    checks.push({ 检查: '快捷菜单常规设置入口直达对应分类', 通过: true });
    assert.deepEqual(errors, []); assert.ok(windows.every(w => w.isDestroyed() || !w.isVisible()));
    await fs.writeFile(path.join(output, '界面检查.json'), JSON.stringify({ 通过: true, 说明: '真实 Electron 隐藏窗口，虚构会话和隔离存储；不代表真实桌面流畅度或系统磨砂观感验收。', checks }, null, 2));
    console.log('悬浮窗检查通过：圆角、主题、置顶、色板指针、识别页和三轮展开采样。');
    clearTimeout(timeout); desktop.dispose(); app.exit(0);
  } catch (error) {
    await fs.writeFile(path.join(output, '浮窗失败诊断.json'), redact(JSON.stringify({ 通过: false, 阶段: currentPhase, 类型: error.code || error.name,
      错误: error.message, 位置: error.stack || '', 窗口: windows.map(win => win.isDestroyed() ? { 已销毁: true } : {
        页面: new URL(win.webContents.getURL() || 'about:blank').searchParams.get('window'), 主帧加载中: win.webContents.isLoadingMainFrame() }) }, null, 2)));
    console.error(error.message.startsWith('界面检查失败：') ? error.message : (await driver.diagnose('当前浮窗断言或操作通过', '断言或操作失败').catch(() => new Error('界面检查失败：当前窗口状态不可读取'))).message);
    console.error(`失败位置：${error.stack?.split('\n').find(line => line.trim().startsWith('at ')) || '未提供位置'}；异常类型：${error.code || error.name}`);
    clearTimeout(timeout); desktop?.dispose(); app.exit(1);
  }
});
