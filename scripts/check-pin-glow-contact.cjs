'use strict';
// 正式渲染器与真实原生客户区；所有窗口始终隐藏，只使用虚构会话与独立数据目录。
const electron = require('electron');
const { app, BrowserWindow, ipcMain, screen } = electron;
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { createUiDriver } = require('./ui-driver.cjs');
const outputIndex = process.argv.indexOf('--output-dir');
const output = path.resolve(outputIndex < 0 ? path.join(__dirname, '../output/verification', `pin-glow-${Date.now()}`) : process.argv[outputIndex + 1]);
app.setPath('userData', path.join(os.tmpdir(), `pickgloss-pin-glow-${process.pid}`));
app.on('window-all-closed', () => {});
const made = [], report = { 通过: false, 覆盖: '正式隐藏窗口的计算样式与实际原生客户区；实屏像素另由 check:native-edges 验证', 场景: [] };
let desktop, panel;
const state = { view: 'explain', history: [], pinned: true, wide: false, status: {}, settings: { text: { model: '隔离柔光贴合检查' }, prefs: { appearance: {} } },
  session: { id: '隔离柔光贴合检查', kind: 'text', text: '虚构材料', activeMode: 'context', threads: {
    context: { draft: '', status: 'complete', messages: [{ id: '虚构回答', role: 'assistant', status: 'complete', content: '只检查固定窗口内发光是否贴合实体光条。' }] },
    independent: { draft: '', status: 'idle', messages: [] }, visual: { draft: '', status: 'idle', messages: [] },
  } } };
const emit = () => desktop?.broadcast(state), evaluate = code => panel.webContents.executeJavaScript(code);
const driver = createUiDriver(evaluate);
class HiddenWindow extends BrowserWindow {
  constructor(options) { super({ ...options, show: false, webPreferences: { ...options.webPreferences, backgroundThrottling: false } }); made.push(this); }
  show() {} showInactive() {} focus() {}
}
const forbidden = () => { throw Error('柔光贴合检查禁止访问采集、剪贴板、托盘或外部服务'); };
ipcMain.handle('pickgloss:action', async (event, action) => action === 'bootstrap'
  ? { ok: true, value: desktop.stateFor(event, state) } : { ok: false, error: '隔离检查未授权此动作' });
app.whenReady().then(async () => {
  const timeout = setTimeout(() => { desktop?.dispose(); app.exit(1); }, 30000);
  try {
    await fs.mkdir(output, { recursive: true });
    const target = path.resolve(__dirname, '../src/windows/desktop.cjs'), loaded = new Module(target, module);
    loaded.filename = target; loaded.paths = Module._nodeModulePaths(path.dirname(target));
    loaded.require = name => name === 'electron' ? { ...electron, BrowserWindow: HiddenWindow,
      Tray: class { constructor() { forbidden(); } }, clipboard: new Proxy({}, { get: () => forbidden }),
      utilityProcess: { fork: forbidden }, desktopCapturer: { getSources: forbidden } } : Module.prototype.require.call(loaded, name);
    loaded._compile(await fs.readFile(target, 'utf8'), target);
    desktop = loaded.exports.createDesktop({ onAction: forbidden, onSelection: forbidden, onStatus(patch) { Object.assign(state.status, patch); emit(); } });
    state.settings.prefs.appearance = { current: { mode: 'dark', material: 'solid' }, pinOutline: 'orange' };
    desktop.setAppearance(state.settings.prefs.appearance);
    desktop.setWide(false); panel = made[0]; desktop.setPinned(true); desktop.openPanel(); emit();
    await driver.waitFor('Boolean(document.querySelector(".native-pin-frame")) && Boolean(document.documentElement.style.getPropertyValue("--native-client-width"))', '原生几何与正式固定窗口就绪');
    if (process.argv.includes('--inject-old-glow')) {
      await panel.webContents.insertCSS('html.native-rounded-frame .panel.is-pinned::after{inset:0!important;width:auto!important;height:auto!important;border:2px solid transparent!important;border-radius:calc(var(--panel-radius) - var(--actual-panel-border,1px))!important}');
      report.受控旧布局 = true;
    }
    panel.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
    for (const [width, height] of [[300, 483], [321, 487]]) {
      panel.setBounds({ ...panel.getBounds(), width, height });
      await delay(80);
      for (const mode of ['dark', 'light']) for (const material of ['solid', 'glass']) {
        state.settings.prefs.appearance = { current: { mode, material }, pinOutline: 'orange' };
        desktop.setAppearance(state.settings.prefs.appearance); emit();
        await driver.waitFor(`document.documentElement.dataset.appearance==='${mode}' && document.documentElement.dataset.material==='${material}'`, '明暗与材质同步');
        await delay(30);
        const geometry = await evaluate(`(()=>{const p=document.querySelector('.panel'),r=p.getBoundingClientRect(),s=getComputedStyle(p),g=getComputedStyle(p,'::after'),v=document.documentElement.style,n=k=>parseFloat(v.getPropertyValue(k));const origin={x:r.left+parseFloat(s.borderLeftWidth),y:r.top+parseFloat(s.borderTopWidth)};const glow={left:origin.x+parseFloat(g.left)+parseFloat(g.borderLeftWidth),top:origin.y+parseFloat(g.top)+parseFloat(g.borderTopWidth),right:origin.x+parseFloat(g.left)+parseFloat(g.width)-parseFloat(g.borderRightWidth),bottom:origin.y+parseFloat(g.top)+parseFloat(g.height)-parseFloat(g.borderBottomWidth)};const hole={left:n('--native-pin-left'),top:n('--native-pin-top'),right:n('--native-client-width')-n('--native-pin-right'),bottom:n('--native-client-height')-n('--native-pin-bottom')};return {hole,glow,dpr:devicePixelRatio,pseudo:{left:g.left,top:g.top,width:g.width,height:g.height,border:g.borderLeftWidth,radius:g.borderTopLeftRadius},native:Object.fromEntries([...v].filter(k=>k.startsWith('--native-')).map(k=>[k,v.getPropertyValue(k)])),visible:document.visibilityState}})()`);
        const scale = screen.getDisplayMatching(panel.getBounds()).scaleFactor;
        const gaps = { 左: (geometry.glow.left - geometry.hole.left) * scale, 上: (geometry.glow.top - geometry.hole.top) * scale,
          右: (geometry.hole.right - geometry.glow.right) * scale, 底: (geometry.hole.bottom - geometry.glow.bottom) * scale };
        const passed = Object.values(gaps).every(gap => Number.isFinite(gap) && Math.abs(gap) <= .1);
        report.场景.push({ 名称: `${mode}-${material}-${width}x${height}`, passed, 物理像素间隙: gaps, 几何: geometry });
        if (width === 300 && material === 'solid') {
          const image = await panel.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
          await fs.writeFile(path.join(output, `${mode}-solid.png`), image.toPNG({ scaleFactor: scale }));
        }
      }
    }
    const failures = report.场景.filter(scene => !scene.passed);
    assert.equal(failures.length, 0, `柔光与实体光条不贴合：${failures.map(scene => scene.名称).join('、')}`);
    report.通过 = true;
    console.log(`固定窗口内发光贴合检查通过：${report.场景.length} 个隐藏场景。`);
  } catch (error) { report.错误 = error.message; console.error(error.message); }
  finally {
    clearTimeout(timeout); desktop?.dispose();
    report.自有窗口已关闭 = made.every(win => win.isDestroyed());
    await fs.writeFile(path.join(output, '内发光贴合检查.json'), JSON.stringify(report, null, 2), 'utf8');
    app.exit(report.通过 ? 0 : 1);
  }
});
