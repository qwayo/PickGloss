'use strict';
// 隐藏渲染器内重放鼠标事件；拖动和菜单 IPC 使用内存替身，不移动桌面鼠标。
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const { setTimeout: delay } = require('node:timers/promises');
const { defaultAppearance } = require('../src/core/appearance.cjs');
app.setPath('userData', path.join(os.tmpdir(), `pickgloss-entries-${process.pid}`));
const outputIndex = process.argv.indexOf('--output-dir');
const output = outputIndex >= 0 ? path.resolve(process.argv[outputIndex + 1]) : path.join(__dirname, '../output/verification/ui-refinement-20261016');
const calls = [], errors = [], windows = [];
async function until(predicate, label) { const end=Date.now()+3000;while(Date.now()<end){if(await predicate())return;await delay(15);}throw Error(`等待${label}超时`); }
let fixture = { settings: { prefs: { appearance: defaultAppearance() } }, status: { appearanceDark: true, appearanceMaterial: 'solid' } };
ipcMain.handle('test:invoke', (_event, action, payload) => { calls.push({ action, payload }); return { ok: true, value: action === 'bootstrap' ? fixture : true }; });
async function ready(win, selector) {
  for (let i = 0; i < 150; i++) { if (await win.webContents.executeJavaScript(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)) return; await delay(20); }
  throw Error('品牌入口未加载');
}
async function mouse(win, type, x, y) { const bounds=win.getBounds();win.webContents.sendInputEvent({ type, x, y, globalX:bounds.x+x,globalY:bounds.y+y,button:'left',clickCount:1,modifiers:type==='mouseMove'?['leftButtonDown']:[] });await delay(25); }
async function screenshot(win, name) { await fs.writeFile(path.join(output, name), (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG()); }
app.whenReady().then(async () => {
  try {
    await fs.mkdir(output, { recursive: true });
    const create = async (surface, width, height) => {
      const win = new BrowserWindow({ show: false, frame: false, width, height, useContentSize: true, transparent: true, backgroundColor: '#00000000', webPreferences: { preload: path.join(__dirname, '../tests/renderer/streaming.preload.cjs'), contextIsolation: true, sandbox: true, offscreen: true, backgroundThrottling: false } });
      windows.push(win); win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
      await win.loadFile(path.join(__dirname, '../src/renderer/index.html'), { query: { window: surface } }); return win;
    };
    const orb = await create('orb', 48, 48); await ready(orb, '.orb');
    assert.equal(await orb.webContents.executeJavaScript(`document.querySelector('.orb').getBoundingClientRect().width`), 40);
    assert.equal(await orb.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.orb')).backgroundColor`), 'rgb(37, 37, 37)');
    assert.ok(await orb.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.orb')).backgroundImage.includes('radial-gradient')`));
    await orb.webContents.executeJavaScript(`window.entryEvents=[];for(const type of ['pointerdown','pointermove','pointerup','pointercancel','lostpointercapture'])document.addEventListener(type,event=>entryEvents.push({type,id:event.pointerId,buttons:event.buttons,x:event.clientX,y:event.clientY}),true)`);
    await mouse(orb, 'mouseDown', 24, 24); await mouse(orb, 'mouseUp', 24, 24);
    await until(()=>calls.filter(call=>call.action==='orb-activate').length===1,'左键打开最新会话');
    assert.equal(calls.filter(call => call.action === 'orb-activate').length, 1, '左键打开一次最新会话');
    await orb.webContents.executeJavaScript(`window.originalOrb=document.querySelector('.orb')`);
    await mouse(orb, 'mouseDown', 24, 24); await mouse(orb, 'mouseMove', 37, 36);
    await until(()=>calls.some(call=>call.action==='orb-drag'&&call.payload.phase==='start'),'拖动开始');
    fixture = { ...fixture, settings: { prefs: { appearance: { ...defaultAppearance(), current: { ...defaultAppearance().current, mode: 'light' } } } }, status: { appearanceDark: false, appearanceMaterial: 'solid' } };
    orb.webContents.send('test:state', fixture); await delay(25);
    assert.equal(await orb.webContents.executeJavaScript(`document.querySelector('.orb')===window.originalOrb`), true, '拖动中的主题推送保留指针节点');
    assert.equal(await orb.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.orb')).backgroundColor`), 'rgb(255, 255, 255)');
    await mouse(orb, 'mouseMove', 41, 40); await mouse(orb, 'mouseUp', 41, 40); await delay(25);
    await until(()=>calls.some(call=>call.action==='orb-drag'&&call.payload.phase==='end'),'拖动结束');
    assert.equal(calls.filter(call => call.action === 'orb-activate').length, 1, '拖动松手不触发最新会话');
    const phases = calls.filter(call => call.action === 'orb-drag').map(call => call.payload.phase);
    assert.equal(phases[0], 'start'); assert.ok(phases.includes('move')); assert.equal(phases.at(-1), 'end');
    await mouse(orb, 'mouseDown', 24, 24); await mouse(orb, 'mouseUp', 24, 24);
    await until(()=>calls.filter(call=>call.action==='orb-activate').length===2,'拖动后点击');
    assert.equal(calls.filter(call => call.action === 'orb-activate').length, 2, '拖动之后仍可左键打开会话');
    orb.webContents.sendInputEvent({type:'mouseDown',x:24,y:24,button:'right',clickCount:1});
    orb.webContents.sendInputEvent({type:'mouseUp',x:24,y:24,button:'right',clickCount:1});
    await until(()=>calls.filter(call=>call.action==='menu').length===1,'右键打开菜单');
    assert.equal(calls.filter(call=>call.action==='orb-activate').length,2,'右键不能误开会话');
    await orb.webContents.executeJavaScript(`for(let i=0;i<10;i++)document.querySelector('.orb').click()`);
    await until(()=>calls.filter(call=>call.action==='orb-activate').length===12,'连续左键点击逐次交给开关入口');
    fixture={...fixture,settings:{prefs:{...fixture.settings.prefs,orbAction:'capture'}}};
    orb.webContents.send('test:state',fixture);
    await until(()=>orb.webContents.executeJavaScript(`document.querySelector('.orb').title.startsWith('截图框选')`),'截图功能提示同步');
    assert.equal(await orb.webContents.executeJavaScript(`document.querySelector('.orb')===window.originalOrb`),true,'切换悬浮球功能保留拖动节点');
    await screenshot(orb, '正式程序-暖白悬浮球.png');
    const selection = await create('selection', 34, 34); await ready(selection, '.selection-action');
    await selection.webContents.executeJavaScript(`Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>{})))`);
    const oldShadow = await selection.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});
    const shadowBitmap=oldShadow.toBitmap(),shadowSize=oldShadow.getSize();
    assert.ok(Array.from({length:shadowSize.width},(_,x)=>shadowBitmap[((shadowSize.height-1)*shadowSize.width+x)*4+3]).every(alpha=>alpha===0),'划词入口下边界应完全透明，不能直接截断阴影');
    assert.equal(await selection.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.selection-action')).boxShadow`),'none','划词解释按钮不再带阴影');
    assert.equal(await selection.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.selection-action')).borderRadius`),'9px');
    assert.equal(await selection.webContents.executeJavaScript(`document.querySelector('.selection-action .brand-background').getAttribute('rx')`),'22','图标底板同步加圆，避免覆盖按钮圆角');
    assert.equal(await selection.webContents.executeJavaScript(`document.querySelector('.selection-action').getBoundingClientRect().width`), 26);
    assert.equal(await selection.webContents.executeJavaScript(`document.querySelector('.selection-action').textContent.trim()`), '');
    assert.equal(await selection.webContents.executeJavaScript(`document.querySelector('.selection-action .brand .brand-ink').children.length`), 2);
    await selection.webContents.executeJavaScript(`window.originalEntry=document.querySelector('.selection-action')`);
    assert.equal(await selection.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.selection-action .brand-background')).fill`), 'rgb(255, 255, 255)');
    fixture = { ...fixture, settings: { prefs: { appearance: { ...defaultAppearance(), current: { ...defaultAppearance().current, mode: 'dark' } } } }, status: { appearanceDark: true, appearanceMaterial: 'solid' } };
    selection.webContents.send('test:state', fixture);
    await until(()=>selection.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.selection-action .brand-background')).fill==='rgb(37, 37, 37)'`),'深色划词入口');
    assert.equal(await selection.webContents.executeJavaScript(`document.querySelector('.selection-action')===window.originalEntry`), true, '主题切换保留节点并立即更新颜色');
    assert.equal(await selection.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.selection-action')).backgroundColor`), 'rgb(37, 37, 37)');
    await screenshot(selection, '正式程序-深色划词入口.png');
    fixture = { ...fixture, settings: { prefs: { appearance: { ...defaultAppearance(), current: { ...defaultAppearance().current, mode: 'light' } } } }, status: { appearanceDark: false, appearanceMaterial: 'solid' } };
    selection.webContents.send('test:state', fixture);
    await until(()=>selection.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.selection-action .brand-background')).fill==='rgb(255, 255, 255)'`),'浅色划词入口');
    assert.equal(await selection.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.selection-action')).backgroundColor`), 'rgb(255, 255, 255)');

    selection.webContents.send('test:state', fixture); await delay(25);
    assert.equal(await selection.webContents.executeJavaScript(`document.querySelector('.selection-action')===window.originalEntry`), true, '普通状态推送不重播入口动画');
    fixture = { ...fixture, selectionEntry: 2 }; selection.webContents.send('test:state', fixture); await delay(25);
    assert.equal(await selection.webContents.executeJavaScript(`document.querySelector('.selection-action')!==window.originalEntry`), true, '复用窗口的新划词重新播放入场');
    assert.equal(await selection.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.selection-action')).animationName`), 'selection-appear');
    fixture = { ...fixture, selectionEntry: 3, status: { ...fixture.status, reducedMotion: true } }; selection.webContents.send('test:state', fixture); await delay(25);
    assert.equal(await selection.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.selection-action')).animationName`), 'none');
    await screenshot(selection, '正式程序-暖白划词入口.png');
    assert.equal(windows.every(win => !win.isVisible()), true); assert.deepEqual(errors, []);
    await fs.writeFile(path.join(output, '品牌入口检查.json'), JSON.stringify({ 通过: true, 隐藏输入重放: true, 左键打开最新会话: true, 右键打开菜单: true, 整球拖动: true, 拖动中主题推送保留节点: true, 拖动不误开会话: true, 拖动后点击: true, 划词入口尺寸: 26, 划词入口无气泡: true, 划词入口明暗背景: true, phases, 未移动真实桌面鼠标: true }, null, 2));
    windows.forEach(win => win.destroy()); console.log('隐藏品牌入口：左键会话、右键菜单、整球拖动、主题推送与拖后点击检查通过。'); app.exit(0);
  } catch (error) { console.error(error); console.error(errors);if(windows[0]&&!windows[0].isDestroyed())console.error(await windows[0].webContents.executeJavaScript(`JSON.stringify(window.entryEvents)`));console.error(calls.filter(call=>call.action==='orb-drag'));windows.forEach(win => win.destroy()); app.exit(1); }
});
