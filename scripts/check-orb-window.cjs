'use strict';
// 只用隔离窗口验证原生尺寸，不连接模型、不读取用户数据或启动屏幕采集。
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
app.setPath('userData', path.join(os.tmpdir(), `pickgloss-orb-window-${process.pid}`));
const output = path.resolve(__dirname, '../output/verification/orb-action-20261022');
const rootIndex=process.argv.indexOf('--app-root');
const sourceRoot=rootIndex<0?path.resolve(__dirname,'..'):path.resolve(process.argv[rootIndex+1]);
let desktop;
ipcMain.handle('pickgloss:action', () => ({ ok: true, value: { view:'paste', settings:{prefs:{}}, status:{} } }));
app.whenReady().then(async () => {
  const timeout=setTimeout(()=>app.exit(1),20000);
  try {
    desktop=require(path.join(sourceRoot,'src/windows/desktop.cjs')).createDesktop({onAction(){},onSelection(){},onStatus(){}});
    desktop.setPinned(true);
    desktop.openPanel();
    const panel=BrowserWindow.getAllWindows()[0];
    await delay(150);
    const runs=[];
    for(const placement of ['当前位置','右下边缘']) {
      if(placement==='右下边缘') {
        const area=screen.getDisplayMatching(panel.getBounds()).workArea,bounds=panel.getBounds();
        panel.setPosition(area.x+area.width-bounds.width,area.y+area.height-bounds.height);
      }
      const original=panel.getBounds(),frames=[];
      for(let i=0;i<30;i++) { desktop.openPanel();await delay(15);frames.push(panel.getBounds()); }
      runs.push({placement,original,frames});
    }
    await fs.mkdir(output,{recursive:true});
    await fs.writeFile(path.join(output,'原生重复唤回尺寸.json'),JSON.stringify({runs},null,2));
    for(const {placement,original,frames} of runs)assert.ok(frames.every(b=>b.width===original.width&&b.height===original.height),`${placement}重复唤回尺寸改变：${JSON.stringify(original)} -> ${JSON.stringify(frames.at(-1))}`);
    console.log('原生窗口当前位置和右下边缘各重复唤回 30 次尺寸保持一致。');
    clearTimeout(timeout);desktop.dispose();app.exit(0);
  } catch(error) { console.error(error.message);clearTimeout(timeout);desktop?.dispose();app.exit(1); }
});
