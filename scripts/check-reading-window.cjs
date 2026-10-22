'use strict';
// 真实 Electron 窗口几何检查；测试会话和用户数据目录完全隔离，不启动取词或模型请求。
const {app,BrowserWindow,ipcMain,screen}=require('electron');
const assert=require('node:assert/strict');
const path=require('node:path');
const os=require('node:os');
const fs=require('node:fs/promises');
const {setTimeout:delay}=require('node:timers/promises');
const rootArg=process.argv.indexOf('--app-root');
const sourceRoot=rootArg<0?path.join(__dirname,'..'):path.resolve(process.argv[rootArg+1]);
const outputArg=process.argv.indexOf('--output-dir');
const outputRoot=outputArg<0?path.join(__dirname,'../output/verification'):path.resolve(process.argv[outputArg+1]);
app.setPath('userData',path.join(os.tmpdir(),`pickgloss-window-${process.pid}`));
let desktop, resetCalls=0;
const fixture={view:'settings',settings:{text:{baseUrl:'http://127.0.0.1',model:'固定测试模型'},prefs:{showOrb:true,selectionEnabled:true}},history:[]};
ipcMain.handle('pickgloss:action',(_,action)=>{
  if(action==='reset-window-size'){resetCalls++;fixture.wide=desktop.resetPanelSize();desktop.broadcast(fixture);}
  return {ok:true,value:action==='bootstrap'?fixture:undefined};
});
app.whenReady().then(async()=>{
  const {createDesktop}=require(path.join(sourceRoot,'src/windows/desktop.cjs'));
  desktop=createDesktop({onAction(){},onSelection(){},onStatus(){}});
  try{
    desktop.setWide(false);
    const win=BrowserWindow.getAllWindows()[0], area=screen.getDisplayMatching(win.getBounds()).workArea;
    const report=[];
    for(const edge of ['left','right']){
      win.setBounds({x:edge==='right'?area.x+area.width-235:area.x+20,y:area.y+30,width:215,height:345});
      const before=win.getBounds();desktop.setWide(true);const after=win.getBounds();
      const distance=edge==='right'?Math.abs(before.x+before.width-after.x-after.width):Math.abs(before.x-after.x);
      assert.ok(distance<=2,'展开时保留靠近的一侧边缘');
      assert.ok(after.x>=area.x&&after.x+after.width<=area.x+area.width+1);
      desktop.setWide(false);const restored=win.getBounds();
      for(const key of ['x','y','width','height'])assert.ok(Math.abs(restored[key]-before[key])<=2,`收回后恢复 ${key}`);
      report.push({edge,before,after,restored});
    }
    if(win.webContents.isLoading())await new Promise(resolve=>win.webContents.once('did-finish-load',resolve));
    for(let n=0;n<100;n++){
      if(await win.webContents.executeJavaScript(`Boolean(document.querySelector('[title="恢复窗口默认大小"]'))`))break;
      await delay(20);
    }
    for(const width of [350,950]){
      win.setBounds({x:area.x+20,y:area.y+20,width,height:600});
      await win.webContents.executeJavaScript(`document.querySelector('[data-field="text-model"]').value='尚未保存的模型草稿';document.querySelector('[title="恢复窗口默认大小"]').click();`);
      for(let n=0;n<100;n++){
        if(await win.webContents.executeJavaScript(`document.querySelector('[data-window-size-feedback]')?.textContent==='已恢复默认大小'`))break;
        await delay(20);
      }
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-field="text-model"]').value`),'尚未保存的模型草稿');
      const bounds=win.getBounds(),expected=width<640?{width:300,height:483}:{width:860,height:690};
      assert.ok(Math.abs(bounds.width-expected.width)<=2);assert.ok(Math.abs(bounds.height-expected.height)<=2);
      report.push({恢复默认:width<640?'小窗':'阅读视图',bounds,未保存表单保留:true});
    }
    assert.equal(resetCalls,2,'真实 preload 只发送两次恢复请求');
    await fs.mkdir(outputRoot,{recursive:true});
    await fs.writeFile(path.join(outputRoot,'阅读窗口原生几何.json'),JSON.stringify(report,null,2));
    console.log('真实 Electron 左右边缘展开、收回、设置恢复默认及未保存表单保留检查通过。');desktop.dispose();app.exit(0);
  }catch(error){console.error(error);desktop.dispose();app.exit(1);}
});
