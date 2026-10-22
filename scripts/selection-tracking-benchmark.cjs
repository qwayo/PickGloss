'use strict';
// 专用 Chromium 测试窗口：只使用固定材料，测量真实 UIA 助手的跟随间隔与误差。
// 不访问用户浏览器、剪贴板、会话或模型服务。
const { app, BrowserWindow, screen } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');
app.commandLine.appendSwitch('force-renderer-accessibility');
app.setPath('userData', path.join(os.tmpdir(), 'pickgloss-tracking-' + process.pid));
let probe, window;
const percentile = (values, fraction) => [...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.floor(values.length*fraction))];
const inline = process.argv.includes('--in-page');

app.whenReady().then(async () => {
  try {
    app.setAccessibilitySupportEnabled(true);
    const prototype = await fs.readFile(path.join(__dirname,'../prototypes/windows-capture/网页内入口原型.html'),'utf8');
    const engine = prototype.match(/<script id="anchor-engine">([\s\S]*?)<\/script>/)[1];
    const styles = prototype.match(/<style>([\s\S]*?)<\/style>/)[1];
    window = new BrowserWindow({ width: 1000, height: 720, show: false, title: '拾译：跟随性能测试（固定材料）', webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><meta charset="utf-8"><title>拾译：跟随性能测试（固定材料）</title>
      <style>${styles}body{margin:0;padding:20px 50px;height:2200px;font:22px/2 sans-serif}#sample{margin-top:280px}#target{background:#edf5dd}</style>
      <h3>正在测量入口跟随延迟</h3><p>固定样本窗口会自动滚动并关闭，不读取其他窗口。</p>
      <p id="sample">Small changes <span id="target">compound</span> over time. A short daily practice helps.</p><script>${engine}</script>`));
    window.show(); window.focus(); window.webContents.focus();
    await new Promise(resolve=>setTimeout(resolve,350));
    const initial = await window.webContents.executeJavaScript(`new Promise(resolve=>requestAnimationFrame(()=>{
      const node=document.getElementById('target').firstChild;
      getSelection().setBaseAndExtent(node,0,node,node.length);
      const rect=getSelection().getRangeAt(0).getBoundingClientRect();
      resolve({x:rect.right,y:rect.bottom});
    }))`);
    const content = window.getContentBounds();
    const point = screen.dipToScreenPoint({ x: Math.round(content.x+initial.x), y: Math.round(content.y+initial.y) });
    const scale = screen.getDisplayMatching(content).scaleFactor;
    await new Promise(resolve=>setTimeout(resolve,250));
    const positions = [], binary = process.env.PICKGLOSS_PROBE || path.join(__dirname, '../build/native-benchmark/ContextProbe.exe');
    let selected;
    if (inline) {
      await window.webContents.executeJavaScript(`window.inlineAnchor=createInlineAnchor(); inlineAnchor.select(getSelection().getRangeAt(0),document.getElementById('sample'));`);
    } else {
    probe = spawn(binary, [], { windowsHide: true, stdio: ['pipe','pipe','pipe'] });
    probe.stderr.on('data',chunk=>process.stderr.write(chunk));
    const first = new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('固定样本的 UIA 选区未返回，请确认测试窗口可获得前台焦点。')),6000);
      readline.createInterface({ input: probe.stdout }).on('line',line=>{
        const data=JSON.parse(line);
        if(data.type==='selection') { clearTimeout(timer); positions.push({time:Date.now(),...data.anchor}); resolve(data); }
        else if(data.type==='anchor') positions.push({time:Date.now(),...data});
        else if(data.valid===false) { clearTimeout(timer); reject(new Error('测试助手未匹配固定选区。窗口焦点：'+window.isFocused())); }
      });
      probe.on('error',reject);
    });
    probe.stdin.write(JSON.stringify({text:'compound',x:point.x,y:point.y,excludePids:'',track:true,fixtureWindow:window.getNativeWindowHandle().readBigUInt64LE().toString(),fixturePid:process.pid})+'\n');
    selected = await first;
    if(!selected.anchor?.visible) throw new Error('固定样本初始选区不可见，未形成有效性能基线。');
    }
    const run = await window.webContents.executeJavaScript(`new Promise(resolve=>{
      const frames=[],start=Date.now(),range=getSelection().getRangeAt(0);
      function step(){
        const elapsed=Date.now()-start;
        if(elapsed<4000) scrollTo(0,90-90*Math.cos(elapsed/600*Math.PI));
        else if(elapsed<4800) scrollTo(0,700);
        else scrollTo(0,0);
        const rect=range.getBoundingClientRect(),button=window.inlineAnchor?.current?.button; frames.push({time:Date.now(),y:rect.bottom,entryY:button?.getBoundingClientRect().top,visible:button?!button.hidden:undefined});
        if(elapsed<5700)requestAnimationFrame(step);else resolve({start,frames});
      }requestAnimationFrame(step);
    })`);
    if (inline) {
      const moving=run.frames.filter(f=>f.time>run.start+300&&f.time<run.start+3900);
      const gaps=moving.slice(1).map((f,i)=>f.time-moving[i].time);
      const error=percentile(moving.map(f=>Math.abs(f.entryY-f.y-4)),.95);
      const report={样本:'同一固定选区的网页内入口',位置更新数:moving.length,更新间隔P95毫秒:Math.round(percentile(gaps,.95)),跟随误差P95像素:Math.round(error),
        滚出隐藏:run.frames.some(f=>f.time>run.start+4100&&f.time<run.start+4700&&!f.visible),滚回恢复:run.frames.some(f=>f.time>run.start+4900&&f.visible)};
      report.通过=report.更新间隔P95毫秒<=60&&report.跟随误差P95像素<=1&&report.滚出隐藏&&report.滚回恢复;
      await fs.writeFile(path.join(__dirname,'../build/selection-tracking-in-page.json'),JSON.stringify(report,null,2),'utf8');
      console.log(JSON.stringify(report,null,2));window.destroy();app.exit(report.通过?0:1);return;
    }
    const moving=positions.filter(p=>p.visible&&p.time>=run.start+300&&p.time<run.start+3900);
    const gaps=moving.slice(1).map((p,i)=>p.time-moving[i].time);
    const offset=selected.anchor.point.y/scale-initial.y;
    let cursor=0; const errors=[];
    for(const frame of run.frames) {
      if(frame.time<run.start+300||frame.time>run.start+3900)continue;
      while(cursor+1<positions.length&&positions[cursor+1].time<=frame.time)cursor++;
      const latest=positions[cursor];
      if(latest.visible)errors.push(Math.abs(latest.point.y/scale-offset-frame.y));
    }
    const hidden=positions.some(p=>!p.visible&&p.time>=run.start+4000&&p.time<run.start+4800);
    const restored=positions.some(p=>p.visible&&p.time>=run.start+4800);
    const report={样本:'隔离 Chromium 固定选区',原生助手:binary,位置更新数:moving.length,
      更新间隔P95毫秒:Math.round(percentile(gaps,.95)||9999),跟随误差P95像素:Math.round(percentile(errors,.95)||9999),滚出隐藏:hidden,滚回恢复:restored};
    report.通过=moving.length>=80&&report.更新间隔P95毫秒<=60&&report.跟随误差P95像素<=18&&hidden&&restored;
    const reportPath=process.env.PICKGLOSS_TRACKING_REPORT||path.join(__dirname,'../build/selection-tracking-benchmark.json');
    await fs.mkdir(path.dirname(reportPath),{recursive:true}); await fs.writeFile(reportPath,JSON.stringify(report,null,2),'utf8');
    console.log(JSON.stringify(report,null,2));
    probe.stdin.end(); window.destroy(); app.exit(report.通过?0:1);
  } catch(error) { console.error(error.message); probe?.kill(); window?.destroy(); app.exit(1); }
});
