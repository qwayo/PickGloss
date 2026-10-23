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
const root = path.resolve(process.argv.find(a => a.startsWith('--source-root='))?.slice(14) || path.join(__dirname, '..'));
const output = path.resolve(__dirname, '../output/verification/floating-20261021');
const before = process.argv.includes('--before');
const preview = process.argv.includes('--preview');
app.setPath('userData', path.join(os.tmpdir(), `pickgloss-floating-${process.pid}`));
const windows = [];
class TestWindow extends electron.BrowserWindow {
  constructor(options) { super({ ...options, show: false, webPreferences: { ...options.webPreferences, offscreen: !preview, backgroundThrottling: false } }); this.testOptions = options; windows.push(this); }
  show() {} showInactive() {} focus() {}
  setBounds(bounds) { this.resizeCalls ||= []; this.resizeCalls.push({ width: bounds.width, height: bounds.height }); super.setBounds(bounds); }
  setShape(rects) { this.testShape = rects; super.setShape(rects); }
}
let desktop, panel, store, state, failSave = false;
const errors = [], checks = [];
const evaluate = code => panel.webContents.executeJavaScript(code);
async function until(predicate, label) {
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(10); }
  throw Error(`等待${label}超时`);
}
async function click(selector) { await evaluate(`document.querySelector(${quoteJavaScriptString(selector)}).click()`); }
async function shot(name, win = panel) {
  await win.webContents.executeJavaScript('Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))');
  await win.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  await fs.writeFile(path.join(output, `${before ? '修复前-' : ''}${name}.png`), (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
}
function emit() { desktop.broadcast(state); }
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
    loaded.require = name => name === 'electron' ? { ...electron, BrowserWindow: TestWindow, Tray: class { constructor() { forbidden(); } }, utilityProcess: { fork: forbidden }, desktopCapturer: { getSources: forbidden } } : Module.prototype.require.call(loaded, name);
    loaded._compile(await fs.readFile(target, 'utf8'), target);
    desktop = loaded.exports.createDesktop({ onAction() {}, onSelection() {}, onStatus(patch) { Object.assign(state.status, patch); if (typeof patch.wide === 'boolean') state.wide = patch.wide; emit(); } });
    desktop.setAppearance(state.settings.prefs.appearance); desktop.setWide(false); panel = windows[0];
    panel.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
    await until(() => evaluate('Boolean(document.querySelector(".message"))'), '正式界面');
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
    // 材质与明暗切换仍保留系统圆角路径，不恢复有锯齿的原生像素区域。
    for (const mode of ['light', 'dark', 'light', 'dark']) for (const material of ['glass', 'solid']) {
      state.settings.prefs.appearance.current = { ...state.settings.prefs.appearance.current, mode, material };
      desktop.setAppearance(state.settings.prefs.appearance); emit();
      await until(() => evaluate(`document.documentElement.dataset.appearance===${quoteJavaScriptString(mode)}`), '主题切换');
      assert.equal(panel.testShape, undefined, '不能再用像素区域裁切');
      assert.equal(panel.testOptions.transparent, false);
      assert.equal(await evaluate('getComputedStyle(document.querySelector(".panel")).borderTopLeftRadius'), '8px');
      assert.equal(await evaluate('getComputedStyle(document.documentElement).getPropertyValue("--paper").trim()'), mode === 'dark' ? '#252525' : '#ffffff');
      if (material === 'glass') await shot(`${mode === 'dark' ? '深色' : '浅色'}磨砂`);
    }
    checks.push({ 检查: '八次明暗与材质切换', 通过: true });
    await handle('pin', { pinned: true });
    await until(() => evaluate('Boolean(document.querySelector(".panel-bar .is-pinned"))'), '置顶状态');
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".panel-bar .is-pinned .icon path")).fill'), await evaluate('getComputedStyle(document.querySelector(".panel-bar .is-pinned .icon")).color'));
    state.view = 'settings'; state.settingsSection = 'appearance'; emit();
    await until(() => evaluate('Boolean(document.querySelector(".appearance-page"))'), '外观设置');
    await click('[data-pin-outline="blue"]');
    await until(async () => (await store.getSettings()).prefs.appearance.pinOutline === 'blue', '置顶颜色写盘');
    assert.equal(windows.some(win => win.webContents.getURL().includes('pin-glow.html')), false);
    assert.equal(await evaluate('getComputedStyle(document.documentElement).getPropertyValue("--pin-glow").trim()'), '80 149 232');
    assert.ok(await evaluate('getComputedStyle(document.querySelector(".panel"),"::after").boxShadow.includes("inset")'));
    await click('[data-pin-outline="none"]');
    await until(async () => (await store.getSettings()).prefs.appearance.pinOutline === 'none', '无描边写盘');
    assert.equal(state.pinned, true);
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
    await click('.appearance-reset');
    await handle('navigate', { view: 'paste' });
    await until(() => evaluate('Boolean(document.querySelector("[data-field=paste-text]"))'), '识别页面');
    const fit = await evaluate('(()=>{const b=document.querySelector(".panel-body"),r=b.getBoundingClientRect(),a=document.querySelector(".form-actions").getBoundingClientRect();return {高度:b.clientHeight,内容:b.scrollHeight,操作可见:a.bottom<=r.bottom,缩放:document.querySelector("#app").style.zoom,滚动条:getComputedStyle(b).scrollbarWidth}})()');
    assert.ok(fit.内容 <= fit.高度 + 1 && fit.操作可见, JSON.stringify(fit)); assert.equal(fit.缩放, '1'); assert.equal(fit.滚动条, 'none');
    await shot('识别页'); checks.push({ 检查: '300×483 默认缩放识别页完整显示', ...fit });
    const originalSession = state.session, originalVision = state.settings.vision;
    state.settings.vision = { baseUrl: 'http://127.0.0.1/v1', model: '隔离识图模型' };
    for (const [width, height] of [[640,180],[180,640]]) {
      const imageData = await evaluate(`(()=>{const c=document.createElement('canvas');c.width=${width};c.height=${height};const x=c.getContext('2d');x.fillStyle='#e9edf2';x.fillRect(0,0,c.width,c.height);x.fillStyle='#252525';x.font='20px sans-serif';x.fillText('截图验证材料',16,40);return c.toDataURL('image/png')})()`);
      state.session = { ...originalSession, kind: 'image', imageData }; state.view = 'preview'; emit();
      await until(() => evaluate('Boolean(document.querySelector(".recognition-preview .preview-image"))'), '截图确认页');
      const fits = await evaluate('(()=>{const b=document.querySelector(".panel-body"),a=document.querySelector(".form-actions").getBoundingClientRect();return b.scrollHeight<=b.clientHeight+1&&a.bottom<=b.getBoundingClientRect().bottom})()');
      assert.equal(fits, true, `截图 ${width}×${height} 默认小窗完整显示`);
    }
    await shot('截图确认页'); state.session = originalSession; state.settings.vision = originalVision;
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
    desktop.setOrb(true); const orb = windows.find(w => w !== panel && !w.getParentWindow());
    await until(() => orb.webContents.executeJavaScript('Boolean(document.querySelector(".orb"))'), '悬浮球');
    await shot('深色悬浮球', orb);
    const ball = await orb.webContents.executeJavaScript('({背景:getComputedStyle(document.querySelector(".orb")).backgroundColor,高光:getComputedStyle(document.querySelector(".orb")).backgroundImage})');
    assert.equal(ball.背景, 'rgb(37, 37, 37)'); assert.ok(ball.高光.includes('radial-gradient'));
    assert.deepEqual(errors, []); assert.ok(windows.every(w => w.isDestroyed() || !w.isVisible()));
    await fs.writeFile(path.join(output, '界面检查.json'), JSON.stringify({ 通过: true, 说明: '真实 Electron 隐藏窗口，虚构会话和隔离存储；不代表真实桌面流畅度或系统磨砂观感验收。', checks }, null, 2));
    console.log('悬浮窗检查通过：圆角、主题、置顶、色板指针、识别页和三轮展开采样。');
    clearTimeout(timeout); desktop.dispose(); app.exit(0);
  } catch (error) { console.error(error); clearTimeout(timeout); desktop?.dispose(); app.exit(1); }
});
