'use strict';
// 固定材料、隔离 IPC 与用户数据，验证两档固定字号、响应式阅读和草稿保留。
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const {setTimeout:delay} = require('node:timers/promises');
app.setPath('userData',path.join(os.tmpdir(),`pickgloss-reading-${process.pid}`));
const rootArg=process.argv.indexOf('--app-root');
const sourceRoot=rootArg<0?path.join(__dirname,'..'):path.resolve(process.argv[rootArg+1]);
const outputArg=process.argv.indexOf('--output-dir');
const outputRoot=outputArg<0?path.join(__dirname,'../output/verification'):path.resolve(process.argv[outputArg+1]);
const baseline=process.argv.includes('--baseline');
const calls=[];
const current={view:'explain',history:[],settings:{text:{baseUrl:'http://127.0.0.1',model:'本地阅读验证'}},session:{
  id:'阅读布局验证',kind:'text',text:'compound',context:'Small changes compound over time. A short daily practice can make a lasting difference.',source:{app:'Microsoft Edge',title:'每天一点进步'},activeMode:'context',
  threads:{context:{status:'complete',draft:'',messages:[{id:'回答',role:'assistant',status:'complete',content:'## 这里的 compound 是什么意思？\n\n这里作动词，意思是**逐渐累积、产生叠加效果**。重点不是一次变化有多大，而是变化会持续影响后面的结果。\n\n> Small changes compound over time.\n\n微小的改变，会随着时间累积成显著的效果。\n\n### 放回这段话里理解\n\n- **Small changes**：每天的一点练习。\n- **compound**：前一天的积累，为下一天打下基础。\n- **over time**：这种效果需要时间才看得出来。\n\n### 再看一个例句\n\nRegular reading helps your knowledge compound.\n\n坚持阅读，知识便会不断积累。'}]},independent:{status:'idle',messages:[],draft:''}}
}};
ipcMain.handle('test:invoke',(_,action,payload)=>{calls.push({action,payload});return {ok:true,value:action==='bootstrap'?current:undefined};});
let win;
async function ready(){
  for(let i=0;i<150;i++){
    if(await win.webContents.executeJavaScript(`Boolean(document.querySelector('.message-content'))`))return;
    await delay(20);
  }
  throw Error('等待回答界面超时：'+await win.webContents.executeJavaScript(`document.body.innerText`));
}
async function settle(){await win.webContents.executeJavaScript(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);}
// 此脚本检查最终布局；过渡中的连续性与绘制由 check-resize-presentation 单独检查。
async function size(width,height){win.setContentSize(width,height);await settle();await win.webContents.executeJavaScript(`Promise.all(document.getAnimations().filter(item=>item.effect?.getTiming().iterations!==Infinity).map(item=>item.finished.catch(()=>{})))`);await settle();}
async function shot(name){for(let attempt=0;attempt<4;attempt++){try{const image=await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});await fs.writeFile(path.join(outputRoot,name),image.toPNG());return;}catch(error){if(attempt===3)throw error;await settle();await delay(50);}}}
app.whenReady().then(async()=>{
  const timer=setTimeout(()=>{console.error('阅读视图检查超时');app.exit(1);},30000);
  try{
    await fs.mkdir(outputRoot,{recursive:true});
    win=new BrowserWindow({show:false,frame:false,width:430,height:690,useContentSize:true,webPreferences:{preload:path.join(__dirname,'../tests/renderer/streaming.preload.cjs'),contextIsolation:true,sandbox:true,backgroundThrottling:false,offscreen:true}});
    const errors=[];win.webContents.on('console-message',event=>{if(event.level==='error'){errors.push(event.message);console.error(event.message);}});
    await win.loadFile(path.join(sourceRoot,'src/renderer/index.html'));await ready();await settle();
    if(baseline){await shot('阅读改版前-小窗.png');await size(610,690);await shot('阅读改版前-展开.png');}
    else{
      await win.webContents.executeJavaScript(`window.savedInput=document.querySelector('[data-field="question"]');savedInput.value='窗口验证草稿';savedInput.dispatchEvent(new Event('input',{bubbles:true}));`);
      const report=[];
      for(const [width,height] of [[215,345],[300,483],[430,690],[639,550],[640,550],[860,690],[1075,800],[300,483]]){
        await size(width,height);
        const value=await win.webContents.executeJavaScript(`(()=>{const app=document.querySelector('#app'),panel=document.querySelector('.panel'),input=document.querySelector('[data-field="question"]'),source=document.querySelector('.source-pane'),answer=document.querySelector('.answer-pane');const s=source.getBoundingClientRect(),a=answer.getBoundingClientRect();const controls=[...document.querySelectorAll('.panel-bar button,.composer button,.panel-footer button')].map(b=>{const r=b.getBoundingClientRect();return r.left>=-1&&r.right<=innerWidth+1&&r.top>=-1&&r.bottom<=innerHeight+1});return {viewportWidth:innerWidth,zoom:Number(app.style.zoom),fontSize:parseFloat(getComputedStyle(document.querySelector('.message')).fontSize),reading:panel.classList.contains('reading-layout'),draft:input.value,sameInput:input===savedInput,controls:controls.every(Boolean),noOverflow:document.documentElement.scrollWidth<=innerWidth,columns:a.left>=s.right-1,scrollOwner:document.querySelector('[data-scroll="body"]').className,word:document.querySelector('.selected-word').getBoundingClientRect().height};})()`);
        assert.equal(value.draft,'窗口验证草稿');assert.equal(value.sameInput,true,JSON.stringify({width,...value}));assert.equal(value.controls,true,JSON.stringify({width,...value}));assert.equal(value.noOverflow,true,JSON.stringify({width,...value}));
        assert.equal(value.reading,value.viewportWidth>=640);if(value.reading)assert.equal(value.columns,true);
        assert.equal(value.zoom,1,'拉伸时不整体缩放');assert.equal(value.fontSize,value.reading?16:14,'两档正文保持固定字号');
        if(value.reading){
          const sample=await win.webContents.executeJavaScript(`(()=>{const s=document.querySelector('.source-pane').getBoundingClientRect(),c=document.querySelector('.composer-wrap').getBoundingClientRect();return {x:Math.floor(s.right-1),y:Math.floor(c.top+c.height/2),background:getComputedStyle(document.documentElement).getPropertyValue('--surface-secondary'),line:getComputedStyle(document.documentElement).getPropertyValue('--line')}})()`);
          const capture=await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true}),bitmap=capture.toBitmap(),stride=capture.getSize().width;
          function pixel(x,y){const offset=(y*stride+x)*4;return '#'+[bitmap[offset+2],bitmap[offset+1],bitmap[offset]].map(v=>v.toString(16).padStart(2,'0')).join('');}
          assert.equal(pixel(20,sample.y),sample.background.trim(),'与输入框平行的左侧背景应延续材料区');
          assert.equal(pixel(sample.x,sample.y),sample.line.trim(),'左侧分界线应延伸至输入框底部');
        }
        report.push({width,height,...value});
        if(width===215)await shot('阅读改版后-半尺寸小窗.png');
        if(width===300)await shot('阅读改版后-默认小窗.png');
        if(width===860)await shot('阅读改版后-阅读视图.png');
      }
      await size(860,690);
      await win.webContents.executeJavaScript(`document.querySelector('.layout-toggle').click()`);
      await settle();assert.equal(calls.filter(c=>c.action==='wide').at(-1).payload.wide,false);
      assert.equal(calls.filter(c=>c.action==='send-question').length,0);
      assert.deepEqual(errors,[]);
      await fs.writeFile(path.join(outputRoot,'阅读视图检查.json'),JSON.stringify(report,null,2));
      current.view='settings';
      current.settingsSection='general';
      await win.loadFile(path.join(sourceRoot,'src/renderer/index.html'));
      for(let attempt=0;attempt<100;attempt++){
        if(await win.webContents.executeJavaScript(`Boolean(document.querySelector('[title="恢复窗口默认大小"]'))`))break;
        await delay(20);
      }
      await size(430,690);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[aria-label="窗口设置"]').closest('[data-settings-section]').dataset.settingsSection`),'general','窗口区域放在常规分类');
      await win.webContents.executeJavaScript(`document.querySelector('[aria-label="窗口设置"]').scrollIntoView({block:'end',container:'nearest'})`);
      await settle();await shot('设置-恢复窗口默认大小.png');
      await size(300,483);
      await win.webContents.executeJavaScript(`document.querySelector('[aria-label="窗口设置"]').scrollIntoView({block:'end',container:'nearest'})`);
      assert.equal(await win.webContents.executeJavaScript(`(()=>{const b=document.querySelector('.window-reset').getBoundingClientRect();return b.height<=30&&b.height>=28&&b.right<=innerWidth-1})()`),true,'默认小窗中恢复按钮紧凑且不越界');
      await settle();await shot('默认小窗-紧凑窗口设置.png');
      console.log('固定字号、自由拉伸、两栏布局、按钮边界、草稿节点保留与不误发送检查通过。');
    }
    clearTimeout(timer);app.exit(0);
  }catch(error){console.error(error);clearTimeout(timer);app.exit(1);}
});
