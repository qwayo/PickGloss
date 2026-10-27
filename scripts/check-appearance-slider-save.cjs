'use strict';
// 正式渲染器与预加载的滑块保存回归：只使用虚构设置，不接触日常配置或原生材质。
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { setTimeout: delay } = require('node:timers/promises');
const { defaultAppearance } = require('../src/core/appearance.cjs');
const { applySettingsFixture } = require('./settings-fixture.cjs');
const { createUiDriver } = require('./ui-driver.cjs');

app.setPath('userData', path.join(os.tmpdir(), `pickgloss-slider-save-${process.pid}`));
app.on('window-all-closed', () => {});
const outputIndex = process.argv.indexOf('--output-dir');
const output = path.resolve(outputIndex >= 0 ? process.argv[outputIndex + 1] : 'output/verification/2026-10-27-appearance-slider');
const visible = process.argv.includes('--visible');
const appearance = defaultAppearance(); appearance.current.material = 'glass';
const current = { view: 'settings', settingsSection: 'appearance', history: [], session: null,
  status: { appearanceMaterial: 'glass' }, settings: { text: {}, vision: {}, translation: {}, search: {},
    serviceProfiles: {}, prefs: { appearance, showOrb: true } } };
let win, phase = '初始化', closed = 0;
const writes = [], consoleErrors = [], network = [];
ipcMain.handle('pickgloss:action', async (_, action, payload = {}) => {
  if (action === 'bootstrap') return { ok: true, value: current };
  if (action === 'save-settings') {
    writes.push(structuredClone(payload)); await delay(60);
    current.settings = applySettingsFixture(current.settings, payload);
    win.webContents.send('pickgloss:state', current);
    return { ok: true, value: current.settings };
  }
  if (action === 'open-settings') current.settingsSection = payload.section === 'general' ? 'general' : 'service';
  if (action === 'open-appearance') current.settingsSection = 'appearance';
  if (action === 'open-shortcuts') current.settingsSection = 'shortcuts';
  if (action === 'close') closed++;
  return { ok: true };
});
app.whenReady().then(async () => {
  const timeout = setTimeout(() => { console.error(`滑块保存验证超时：${phase}；已收到保存请求 ${writes.length} 次`); win?.destroy(); app.exit(1); }, 12000);
  try {
    await fs.mkdir(output, { recursive: true });
    win = new BrowserWindow({ width: 400, height: 700, show: visible, webPreferences: {
      preload: path.resolve(__dirname, '../src/preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    } });
    win.webContents.on('console-message', (...args) => { const detail = args[1]; if (typeof detail === 'object' ? detail.level === 'error' : args[1] >= 2) consoleErrors.push(typeof detail === 'object' ? detail.message : args[2]); });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => { network.push(details.url); callback({ cancel: true }); });
    const evaluate = code => win.webContents.executeJavaScript(code);
    const driver = createUiDriver(evaluate, { timeoutMs: 3000 });
    await win.loadFile(path.resolve(__dirname, '../src/renderer/index.html'), { query: { window: 'panel' } });
    await driver.waitFor('Boolean(document.querySelector("[data-field=appearance-opacity]"))', '外观滑块出现');
    if (visible) {
      win.focus(); win.webContents.focus();
      await driver.waitFor('document.hasFocus()', '可见窗口实际获得焦点');
    }
    await evaluate(`window.originalSlider=document.querySelector('[data-field=appearance-opacity]');window.rangeInputs=0;document.addEventListener('input',event=>{if(event.target===window.originalSlider)window.rangeInputs++})`);
    phase = '真实鼠标事件拖动不透明度';
    const point = await evaluate(`(()=>{const node=document.querySelector('[data-field=appearance-opacity]');node.scrollIntoView({block:'center'});const rect=node.getBoundingClientRect();return {x:Math.round(rect.x+rect.width/2),y:Math.round(rect.y+rect.height/2)}})()`);
    win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});
    for(let index=0;index<12;index++) {
      win.webContents.sendInputEvent({type:'mouseMove',button:'left',x:point.x+index*2,y:point.y});
      await delay(30);
    }
    win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:point.x+22,y:point.y});
    await delay(400);
    assert.ok(await evaluate('window.rangeInputs>0'), '真实鼠标事件应触发滑块输入');
    assert.equal(await evaluate('window.originalSlider===document.querySelector("[data-field=appearance-opacity]")'), true, '自动保存不应重建或打断正在操作的滑块');
    phase = '拖动不透明度后保存应结束，界面应继续响应';
    await evaluate(`window.slider=document.querySelector('[data-field=appearance-opacity]');slider.focus();slider.value='90';slider.dispatchEvent(new Event('input',{bubbles:true}));slider.dispatchEvent(new Event('change',{bubbles:true}));`);
    await delay(400);
    await driver.waitFor(`document.querySelector('[data-settings-save-summary]').textContent==='已自动保存' && document.querySelector('.appearance-page').getAttribute('aria-busy')==='false'`, '保存完成且解除忙碌状态');
    assert.equal(current.settings.prefs.appearance.current.opacity, 90);
    phase = '连续拖动并在保存期间失焦';
    await evaluate(`(()=>{const node=document.querySelector('[data-field=appearance-opacity]');node.focus();for(const value of [91,92,88]){node.value=value;node.dispatchEvent(new Event('input',{bubbles:true}));}node.dispatchEvent(new Event('change',{bubbles:true}));node.blur();})()`);
    await delay(400);
    await driver.waitFor(`document.querySelector('[data-settings-save-summary]').textContent==='已自动保存' && document.querySelector('.appearance-page').getAttribute('aria-busy')==='false'`, '连续拖动后保存结束');
    assert.equal(current.settings.prefs.appearance.current.opacity, 88);
    phase = '保存后其他按钮及关闭可用';
    await driver.click('常规', { scope: '.settings-navigation' });
    await driver.waitFor('document.querySelector("[data-settings-section=general]").hidden===false', '常规页仍可点击');
    await driver.click('关闭窗口');
    await driver.waitFor('document.querySelector("button[title=关闭窗口]")?.disabled===false', '关闭动作已结束');
    assert.equal(closed, 1);
    assert.deepEqual(network, []); assert.deepEqual(consoleErrors, []);
    await fs.writeFile(path.join(output, '磨砂滑块保存检查.json'), JSON.stringify({ 通过: true, 可见窗口焦点验证: visible, 保存请求数: writes.length, 已保存不透明度: current.settings.prefs.appearance.current.opacity,
      覆盖: ['鼠标拖动磨砂滑块', '保存期间保留滑块节点', '连续编辑和失焦', '保存状态结束', '其他设置及关闭按钮可用'], 证据范围: `正式预加载和${visible ? '实际获得焦点的可见' : '隐藏'} Electron 界面；虚构 IPC，不修改日常设置或原生材质` }, null, 2));
    console.log(`磨砂滑块保存检查通过：${output}`);
    clearTimeout(timeout); win.destroy(); app.exit(0);
  } catch (error) { console.error(phase, error.stack || error, consoleErrors); clearTimeout(timeout); win?.destroy(); app.exit(1); }
});
