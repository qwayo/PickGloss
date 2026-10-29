'use strict';
// 使用隔离配置、正式桌面模块和渲染器；默认隐藏窗口，只逐帧读取自有 DOM。
const electron = require('electron');
const { app, BrowserWindow, ipcMain } = electron;
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const { quoteJavaScriptString } = require('./javascript-string.cjs');
const appearanceBridge = require('../src/windows/window-appearance.cjs');
const outputIndex = process.argv.indexOf('--output-dir');
const output = path.resolve(outputIndex < 0 ? 'output/verification/material-transition-hidden' : process.argv[outputIndex + 1]);
const native = process.argv.includes('--native');
app.setPath('userData', path.join(os.tmpdir(), `pickgloss-material-transition-${process.pid}`));
app.on('window-all-closed', () => {});
const windows = [], commands = [];
let desktop, panel, background;
const state = { view: 'explain', pinned: false, wide: false, history: [], status: {}, settings: { text: {}, prefs: {
  appearance: { current: { mode: 'dark', material: 'solid' }, pinOutline: 'orange' },
} }, session: { id: '材质逐帧隔离检查', kind: 'text', text: '虚构材料', activeMode: 'context', threads: {
  context: { status: 'complete', messages: [{ id: '虚构回答', role: 'assistant', status: 'complete', content: '仅用于检查材质切换时的位置与表面。' }] },
  independent: { status: 'idle', messages: [] }, visual: { status: 'idle', messages: [] },
} } };
class HiddenWindow extends BrowserWindow {
  constructor(options) { super({ ...options, show: false, webPreferences: { ...options.webPreferences, offscreen: !native, backgroundThrottling: false } }); windows.push(this); }
  show() { if (native) super.show(); } showInactive() { if (native) super.showInactive(); }
}
const emit = () => desktop?.broadcast(state);
const evaluate = code => panel.webContents.executeJavaScript(code);
ipcMain.handle('pickgloss:action', (event, action) => action === 'bootstrap' ? { ok: true, value: desktop.stateFor(event, state) } : { ok: true });
function fakeHelper() {
  const child = new EventEmitter(); child.pid = 12345;
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
  child.stdin = Object.assign(new EventEmitter(), { end() {}, write(line, done) {
    const [sequence, , enabled] = line.trim().split(' '); commands.push({ sequence: Number(sequence), enabled: enabled === '1', time: Date.now() });
    // 固定两帧应答延迟，让每次切换都覆盖请求未就绪与已就绪的边界。
    setTimeout(() => child.stdout.emit('data', JSON.stringify({ sequence: Number(sequence), width: 750, height: 1208,
      left: 0, top: 0, right: 0, bottom: 0, dpi: 240, backdrop: { handle: '456', pid: child.pid, enabled: enabled === '1', visible: enabled === '1', radius: 14 } }) + '\n'), 34);
    done?.();
  } }); return child;
}
app.whenReady().then(async () => {
  const report = { 通过: false, 覆盖: native ? '自有窗口内部逐帧 DWM 实屏采样；每帧前后验证归属' : '隐藏自有窗口；正式桌面模块、正式渲染器、受控原生应答；不代表 DWM 实屏验收', 场景: [], 命令: commands };
  const watchdog = setTimeout(() => app.exit(2), 30000);
  try {
    await fs.mkdir(output, { recursive: true });
    const target = path.resolve(__dirname, '../src/windows/desktop.cjs'), loaded = new Module(target, module);
    loaded.filename = target; loaded.paths = Module._nodeModulePaths(path.dirname(target));
    loaded.require = name => name === 'electron' ? { ...electron, BrowserWindow: HiddenWindow } : name === './window-appearance.cjs'
      ? { ...appearanceBridge, createWindowAppearance: (win, options) => {
        const controller = appearanceBridge.createWindowAppearance(win, native ? options : { ...options, exists: () => true, spawnHelper: fakeHelper });
        if (native && process.argv.includes('--inject-unready-backdrop') && controller) { const original = controller.setBackdrop; controller.setBackdrop = () => original(false); }
        return controller;
      } }
      : Module.prototype.require.call(loaded, name);
    loaded._compile(await fs.readFile(target, 'utf8'), target);
    desktop = loaded.exports.createDesktop({ onAction() {}, onStatus(patch) { Object.assign(state.status, patch); emit(); }, sourceFactory: () => null });
    if (native) {
      const area = electron.screen.getPrimaryDisplay().workArea;
      desktop.restoreWindowState({ panel: { x: area.x + 20, y: area.y + 20 } });
      background = new BrowserWindow({ x: area.x, y: area.y, width: 360, height: 540, frame: false, show: false, focusable: false, webPreferences: { sandbox: true } });
      await background.loadURL('data:text/html,<style>html,body{margin:0;height:100%;background:repeating-linear-gradient(90deg,%23000 0px,%23000 4px,%23fff 4px,%23fff 8px)}</style>');
      background.setAlwaysOnTop(true, 'pop-up-menu'); background.showInactive();
    }
    desktop.setAppearance(state.settings.prefs.appearance); desktop.setWide(false); panel = windows[0]; desktop.openPanel(); emit();
    await new Promise(resolve => panel.webContents.isLoading() ? panel.webContents.once('did-finish-load', resolve) : resolve());
    await evaluate(`new Promise(resolve=>{function ready(){if(document.querySelector('.message'))resolve();else requestAnimationFrame(ready)}ready()})`);
    if (process.argv.includes('--inject-layout-border')) await panel.webContents.insertCSS('html.panel-surface[data-material=solid] .panel:not(.is-pinned){border:1px solid transparent!important}');
    if (process.argv.includes('--inject-pin-outline-border')) await panel.webContents.insertCSS('html.panel-surface[data-pin-outline=orange] .panel.is-pinned{border:1px solid transparent!important}');
    if (!native) {
      // 用长段虚构正文让换行、正文滚动和阅读锚点都参与固定描边 A/B 比较。
      state.session.threads.context.messages[0].content = '固定窗口正文几何与阅读锚点检查。'.repeat(180);
      state.pinned = true;
      state.settings.prefs.appearance.current.material = 'solid';
      state.settings.prefs.appearance.current.mode = 'dark';
      const pinGeometry = {};
      for (const pinOutline of ['orange', 'none']) {
        state.settings.prefs.appearance.pinOutline = pinOutline;
        desktop.setPinned(true); desktop.setAppearance(state.settings.prefs.appearance); emit();
        await evaluate(`new Promise((resolve,reject)=>{const deadline=performance.now()+3000;function ready(){const root=document.documentElement,p=document.querySelector('.panel');if(root.dataset.pinOutline===${quoteJavaScriptString(pinOutline)}&&p?.classList.contains('is-pinned')&&root.classList.contains('panel-surface'))requestAnimationFrame(()=>requestAnimationFrame(resolve));else if(performance.now()>deadline)reject(Error('固定描边几何检查未进入目标渲染状态：'+JSON.stringify({outline:root.dataset.pinOutline,pinned:p?.classList.contains('is-pinned'),surface:root.classList.contains('panel-surface')})));else requestAnimationFrame(ready)}ready()})`);
        const snapshot = await evaluate(`(()=>{const p=document.querySelector('.panel'),b=p.querySelector('.panel-body'),m=p.querySelector('.message'),c=m.querySelector('.message-content'),s=getComputedStyle(p);b.scrollTop=Math.min(140,b.scrollHeight-b.clientHeight);const rect=e=>{const r=e.getBoundingClientRect();return Object.fromEntries(['x','y','width','height'].map(k=>[k,Number(r[k].toFixed(2))]))};const walker=document.createTreeWalker(c,NodeFilter.SHOW_TEXT),range=document.createRange(),lineStarts=[];let node,offset=0,lastTop=null;while(node=walker.nextNode()){for(let i=0;i<node.textContent.length;i++){range.setStart(node,i);range.setEnd(node,i+1);const top=range.getBoundingClientRect().top;if(lastTop===null||Math.abs(top-lastTop)>.5)lineStarts.push(offset+i);lastTop=top}offset+=node.textContent.length}const edge=b.getBoundingClientRect().top,block=[...c.children].find(e=>e.getBoundingClientRect().bottom>edge+12),blockRect=block?.getBoundingClientRect();return {borderWidth:s.borderWidth,layout:{panel:rect(p),container:rect(b),paragraph:rect(m),content:rect(c),lineStarts,scroll:{top:Number(b.scrollTop.toFixed(2)),height:b.scrollHeight,clientHeight:b.clientHeight},anchor:block&&{text:block.textContent.slice(0,24),offsetY:Number((blockRect.top-edge).toFixed(2))}}}})()`);
        const { lineStarts, ...layout } = snapshot.layout;
        pinGeometry[pinOutline] = { borderWidth: snapshot.borderWidth, layout: { ...layout, lineWrapSignature: lineStarts.join(',') } };
      }
      report.固定描边几何对比 = pinGeometry;
      const geometrySummary = value => ({ borderWidth: value.borderWidth, panel: value.layout.panel, container: value.layout.container,
        paragraph: value.layout.paragraph, content: value.layout.content, lineCount: value.layout.lineWrapSignature.split(',').length,
        scroll: value.layout.scroll, anchor: value.layout.anchor });
      const orangeLines = pinGeometry.orange.layout.lineWrapSignature.split(',').map(Number), noneLines = pinGeometry.none.layout.lineWrapSignature.split(',').map(Number);
      const wrapDifferences = Array.from({ length: Math.max(orangeLines.length, noneLines.length) }, (_, index) =>
        orangeLines[index] === noneLines[index] ? null : { line: index, orange: orangeLines[index], none: noneLines[index] }).filter(Boolean).slice(0, 8);
      assert.ok(JSON.stringify(pinGeometry.orange.layout) === JSON.stringify(pinGeometry.none.layout),
        `固定窗口切换有色/无色描边不能改变正文几何、换行或阅读锚点：${JSON.stringify({ orange: geometrySummary(pinGeometry.orange), none: geometrySummary(pinGeometry.none), wrapDifferences })}`);
    }
    if (native) {
      report.原生采样 = []; report.切换时刻 = [];
      report.显示刷新率 = electron.screen.getDisplayMatching(panel.getBounds()).displayFrequency;
      await evaluate(`(()=>{window.materialFrames=[];window.materialSampling=true;function frame(t){const p=document.querySelector('.panel'),b=document.querySelector('.panel-body');materialFrames.push({time:Date.now(),t,material:document.documentElement.dataset.material,body:b.getBoundingClientRect().toJSON(),border:getComputedStyle(p).borderWidth});if(materialSampling)requestAnimationFrame(frame)}requestAnimationFrame(frame)})()`);
      const bytes = panel.getNativeWindowHandle(), handle = String(bytes.length === 8 ? bytes.readBigUInt64LE() : bytes.readUInt32LE());
      await new Promise((resolve, reject) => {
        const recorder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'record-owned-material.ps1'), '-PanelHandle', handle,
          '-OwnerPid', String(process.pid), '-OutputDirectory', path.join(output, '连续实屏采样')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let buffer = '', errors = '';
        recorder.stderr.on('data', chunk => errors += chunk.toString()); recorder.on('error', reject);
        recorder.stdout.on('data', chunk => { buffer += chunk.toString(); let end; while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1); if (!line) continue;
          const sample = JSON.parse(line); report.原生采样.push(sample);
          const material = sample.frame === 20 ? 'glass' : sample.frame === 75 ? 'solid' : null;
          if (material) { report.切换时刻.push({ material, time: Date.now(), nativeFrame: sample.frame }); state.settings.prefs.appearance.current.material = material; desktop.setAppearance(state.settings.prefs.appearance); emit(); }
        } });
        recorder.on('exit', code => code === 0 ? resolve() : reject(Error(`自有材质记录失败：${errors}`)));
      });
      report.DOM逐帧 = await evaluate('materialSampling=false;materialFrames');
      const intervals = report.原生采样.slice(1).map((frame, index) => frame.ms - report.原生采样[index].ms);
      const switchIntervals = intervals.slice(19, 28).concat(intervals.slice(74, 83));
      report.采样间隔 = { 最大毫秒: Math.max(...intervals), 切换附近最大毫秒: Math.max(...switchIntervals), 平均毫秒: intervals.reduce((sum, value) => sum + value, 0) / intervals.length };
      assert.ok(report.DOM逐帧.some(frame => frame.material === 'glass'), '原生循环必须经过真实磨砂就绪');
      assert.ok(report.原生采样.length === 110, '连续原生采样必须完整');
      const twoRefreshes = report.显示刷新率 > 0 ? 2000 / report.显示刷新率 : 34;
      assert.ok(report.采样间隔.切换附近最大毫秒 < twoRefreshes + 2, '切换附近采样存在超过两次屏幕刷新的空隙，不能作为短暂跳变通过依据');
      assert.ok(report.原生采样.every(frame => frame.columnRange < 8), '任何一帧都不能透出未磨砂的高对比条纹');
      const average = frames => frames.reduce((sum, frame) => sum + frame.mean, 0) / frames.length;
      assert.ok(average(report.原生采样.slice(55, 70)) - average(report.原生采样.slice(5, 20)) > 5, '实屏像素必须实际经过透明磨砂表面，而不能全程停在实色');
      report.通过 = true; console.log('自有材质连续实屏110帧检查通过；每帧表面均未露出未磨砂条纹。'); return;
    }
    for (const scenario of [{ mode: 'dark', pinned: false, pinOutline: 'orange' }, { mode: 'light', pinned: false, pinOutline: 'orange' },
      { mode: 'dark', pinned: true, pinOutline: 'orange' }, { mode: 'dark', pinned: true, pinOutline: 'none' }]) {
      Object.assign(state.settings.prefs.appearance.current, { mode: scenario.mode, material: 'solid' });
      state.settings.prefs.appearance.pinOutline = scenario.pinOutline; state.pinned = scenario.pinned;
      desktop.setPinned(scenario.pinned); desktop.setAppearance(state.settings.prefs.appearance); emit();
      await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      for (const material of ['glass', 'solid', 'glass', 'solid']) {
      await evaluate(`(()=>{window.materialFrames=[];window.materialSampling=true;function frame(t){const p=document.querySelector('.panel'),b=document.querySelector('.panel-body'),m=document.querySelector('.message'),s=getComputedStyle(p);materialFrames.push({t,material:document.documentElement.dataset.material,border:s.borderWidth,panel:p.getBoundingClientRect().toJSON(),body:b.getBoundingClientRect().toJSON(),message:m.getBoundingClientRect().toJSON()});if(materialSampling)requestAnimationFrame(frame)}requestAnimationFrame(frame)})()`);
      await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      state.settings.prefs.appearance.current.material = material; desktop.setAppearance(state.settings.prefs.appearance); emit();
      const frames = await evaluate(`new Promise((resolve,reject)=>{const deadline=performance.now()+3000;function done(){if(materialFrames.length>=15&&document.documentElement.dataset.material===${quoteJavaScriptString(material)}){materialSampling=false;resolve(materialFrames)}else if(performance.now()>deadline){materialSampling=false;reject(Error('材质逐帧检查未在期限内到达目标状态'))}else requestAnimationFrame(done)}done()})`);
      const baseline = frames[0];
      const displaced = frames.filter(frame => ['body','message'].some(key => ['x','y','width'].some(axis => Math.abs(frame[key][axis] - baseline[key][axis]) > .01)));
      report.场景.push({ ...scenario, 目标材质: material, 帧数: frames.length, 位移帧数: displaced.length, frames });
      assert.equal(displaced.length, 0, `切换到${material}时正文不能因为表面材质改变位置；首个异常帧=${JSON.stringify(displaced[0])}`);
      }
    }
    report.通过 = true; console.log('材质逐帧检查通过：深浅色、固定描边及无描边共16次切换期间正文位置保持一致。');
  } catch (error) { report.错误 = error.message; console.error(error.message); process.exitCode = 1; }
  finally { clearTimeout(watchdog); desktop?.dispose(); background?.destroy(); for (const win of windows) if (!win.isDestroyed()) win.destroy(); await fs.writeFile(path.join(output, '材质逐帧检查.json'), JSON.stringify(report, null, 2)); process.exit(report.通过 ? 0 : 1); }
});
