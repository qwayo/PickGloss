'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createStore } = require('../../src/core/store.cjs');

const IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC1kAAAAASUVORK5CYII=';
const TEXT = { providerId:'custom',baseUrl:'https://text.example/v1',model:'固定文字模型',apiKey:'fictional-text-key' };
const VISION = { providerId:'custom',baseUrl:'https://vision.example/v1',model:'固定识图模型',apiKey:'fictional-vision-key' };
const SEARCH = { providerId:'exa',baseUrl:'https://search.example/search',apiKey:'fictional-search-key' };

async function application(respond, existingDirectory) {
  const directory=existingDirectory||await fs.mkdtemp(path.join(os.tmpdir(),'pickgloss-services-actions-'));
  const transform=value=>Buffer.from(value).map(byte=>byte^0xa5);
  const store=createStore({directory,encrypt:value=>transform(Buffer.from(value)),decrypt:value=>transform(value).toString('utf8')});
  await store.init();
  const requests=[];
  const desktop={broadcast(){},captureState:()=>null,finishCapture:()=>IMAGE,openPanel(){},setOrb(){},startSelection(){},setAppearance(){}};
  const app={setPath(){},getPath:()=>directory,setName(){},setAppUserModelId(){},requestSingleInstanceLock:()=>true,on(){},whenReady:()=>new Promise(()=>{})};
  const electron={app,net:{fetch:async(url,options)=>{
    const request={url,headers:options.headers,body:JSON.parse(options.body),signal:options.signal};requests.push(request);
    const custom=await respond?.(request,requests);
    if(custom)return custom;
    if(url===SEARCH.baseUrl)return Response.json({results:[{title:'固定测试来源',url:'https://source.example/article',highlights:['联网资料中的固定依据。']}]});
    const query=request.body.messages.at(-1)?.content==='请只输出本次使用的一个简短搜索查询。';
    return Response.json({choices:[{message:{content:query?'目标词的公开背景':'结合资料的固定回答 [1]'}}]});
  }}};
  const source=path.join(__dirname,'../../src/main.cjs');
  const context={require:name=>name==='electron'?electron:name.startsWith('./')?require(path.join(path.dirname(source),name)):require(name),
    process:{argv:[],env:{},pid:1},URL,AbortController,structuredClone,setTimeout,clearTimeout,testStore:store,testDesktop:desktop,testSettings:await store.getSettings()};
  vm.createContext(context);
  vm.runInContext(await fs.readFile(source,'utf8')+`
    store=testStore;desktop=testDesktop;settings=testSettings;
    globalThis.servicesTest={handle,state,acceptCapturedSelection,applySelectionContext,setSourceIcons:value=>sourceIcons=value,drain:()=>Promise.all([...jobs.values()].map(job=>job.promise))};
  `,context);
  return {...context.servicesTest,store,requests,directory};
}

async function configured(respond, directory) {
  const app=await application(respond,directory);
  await app.handle('save-settings',{text:TEXT,vision:VISION,search:SEARCH});
  return app;
}

test('真实发送链路按会话联网，并保存每条回答自己的来源',async()=>{
  const app=await configured();
  const target=await app.handle('new-text',{text:'目标词',context:'原材料中的目标词所在段落。'});
  await app.handle('start-explanation',target);await app.drain();
  assert.equal(app.requests.length,1,'默认关闭时仅调用回答模型');
  await app.handle('set-web-search',{id:target.id,enabled:true});
  await app.handle('send-question',{...target,question:'它目前的公开背景是什么？'});await app.drain();
  assert.equal(app.requests.length,4,'一轮查询提炼、搜索、最终回答');
  const search=app.requests[2];assert.equal(search.url,SEARCH.baseUrl);
  assert.equal(search.headers['x-api-key'],SEARCH.apiKey);
  assert.equal(search.body.query,'目标词的公开背景');assert.equal(JSON.stringify(search.body).includes('原材料中的'),false);
  assert.ok(JSON.stringify(app.requests[3].body).includes('联网资料中的固定依据。'));
  const asked=app.requests[3].body.messages.filter(message=>message.content==='它目前的公开背景是什么？');
  assert.equal(asked.length,1,'最终模型只接收一次本轮问题');
  const saved=await app.store.getSession(target.id),reply=saved.threads.context.messages.at(-1);
  assert.equal(saved.webSearchEnabled,true);assert.equal(reply.search.status,'complete');
  assert.equal(reply.search.sources[0].url,'https://source.example/article');
  assert.equal(saved.threads.context.messages[0].search,undefined,'先前未联网回答保持原样');
  const next=await app.handle('new-text',{text:'新目标',context:'新段落'});
  assert.equal((await app.store.getSession(next.id)).webSearchEnabled,true);
});

test('会话开关保存全局默认值，历史会话保持独立且新入口在重启后继承',async()=>{
  const app=await configured();
  const first=await app.handle('new-text',{text:'较早的材料'});
  const second=await app.handle('new-text',{text:'另一段既有材料'});
  assert.equal((await app.state()).settings.prefs.webSearchEnabled,false);

  await app.handle('set-web-search',{id:first.id,enabled:true});
  assert.equal((await app.store.getSession(first.id)).webSearchEnabled,true);
  assert.equal((await app.store.getSession(second.id)).webSearchEnabled,false,'只更新被点击的既有会话');
  assert.equal((await app.state()).settings.prefs.webSearchEnabled,true);

  const nextText=await app.handle('new-text',{text:'后续粘贴材料'});
  assert.equal((await app.store.getSession(nextText.id)).webSearchEnabled,true);
  await app.handle('capture-done',{rect:{}});
  const screenshot=(await app.state()).session;
  assert.equal(screenshot.kind,'image');
  assert.equal(screenshot.webSearchEnabled,true);
  await app.acceptCapturedSelection({app:'测试应用',title:'测试窗口',method:'测试划词',text:'后续划词材料',context:''});
  const selection=(await app.state()).session;
  assert.equal(selection.kind,'text');
  assert.equal(selection.webSearchEnabled,true);

  const restarted=await application(undefined,app.directory);
  assert.equal((await restarted.state()).settings.prefs.webSearchEnabled,true);
  const afterRestart=await restarted.handle('new-text',{text:'重启后的新材料'});
  assert.equal((await restarted.store.getSession(afterRestart.id)).webSearchEnabled,true);

  await restarted.handle('open-session',{id:second.id});
  await restarted.handle('set-web-search',{id:second.id,enabled:false});
  assert.equal((await restarted.store.getSession(second.id)).webSearchEnabled,false);
  assert.equal((await restarted.store.getSession(first.id)).webSearchEnabled,true,'后续开关不回写其他历史会话');
  assert.equal((await restarted.state()).settings.prefs.webSearchEnabled,false);
  const disabledDefault=await restarted.handle('new-text',{text:'默认关闭后的新材料'});
  assert.equal((await restarted.store.getSession(disabledDefault.id)).webSearchEnabled,false);
});

test('并发开关后立即新建会话会继承刚保存的联网默认值',async()=>{
  const app=await configured();
  const target=await app.handle('new-text',{text:'开关目标会话'});

  const enabling=app.handle('set-web-search',{id:target.id,enabled:true});
  const enabledSession=await app.handle('new-text',{text:'立即新建的联网会话'});
  await enabling;
  assert.equal((await app.store.getSession(enabledSession.id)).webSearchEnabled,true);

  const disabling=app.handle('set-web-search',{id:target.id,enabled:false});
  const disabledSession=await app.handle('new-text',{text:'立即新建的不联网会话'});
  await disabling;
  assert.equal((await app.store.getSession(disabledSession.id)).webSearchEnabled,false);
});

test('并发开启联网后立即追问会按新状态执行联网搜索',async()=>{
  const app=await configured();
  const target=await app.handle('new-text',{text:'待追问的材料',context:'材料中的目标词及其上下文'});
  const enabling=app.handle('set-web-search',{id:target.id,enabled:true});
  const sending=app.handle('send-question',{...target,question:'请查找目标词的公开背景'});
  await Promise.all([enabling,sending]);
  await app.drain();

  assert.equal(app.requests.length,3,'开启后立即追问也走查询提炼、联网搜索和最终回答');
  assert.equal(app.requests[1].url,SEARCH.baseUrl);
  const saved=await app.store.getSession(target.id);
  assert.equal(saved.webSearchEnabled,true);
  assert.equal(saved.threads.context.messages.at(-1).search.status,'complete');

  const beforeDisable=app.requests.length;
  const disabling=app.handle('set-web-search',{id:target.id,enabled:false});
  const sendingWithoutSearch=app.handle('send-question',{...target,question:'关闭后直接追问'});
  await Promise.all([disabling,sendingWithoutSearch]);
  await app.drain();
  assert.equal(app.requests.length-beforeDisable,1,'关闭后立即追问只调用回答模型');
  const updated=await app.store.getSession(target.id);
  assert.equal(updated.webSearchEnabled,false);
  assert.equal(updated.threads.context.messages.length,4);
  assert.equal(updated.threads.context.messages.at(-1).search,undefined);
});

test('当前会话写入失败时回滚全局联网默认和内存状态',async()=>{
  const app=await configured();
  const target=await app.handle('new-text',{text:'待保留的历史会话'});
  const folder=path.join(app.directory,'sessions',target.id);
  const held=folder+'.测试临时保留';
  await fs.rename(folder,held);
  try {
    await assert.rejects(app.handle('set-web-search',{id:target.id,enabled:true}),{code:'NOT_FOUND'});
    assert.equal((await app.state()).session.webSearchEnabled,false);
    assert.equal((await app.state()).settings.prefs.webSearchEnabled,false);
  } finally {
    await fs.rename(held,folder);
  }
  assert.equal((await app.store.getSession(target.id)).webSearchEnabled,false);
  const next=await app.handle('new-text',{text:'失败后的新会话'});
  assert.equal((await app.store.getSession(next.id)).webSearchEnabled,false);
});

test('打开设置可选择常规设置分区，其他分区参数仍回到服务设置',async()=>{
  const app=await configured();
  await app.handle('open-settings',{section:'general'});
  assert.equal((await app.state()).settingsSection,'general');
  await app.handle('open-settings',{section:'unknown'});
  assert.equal((await app.state()).settingsSection,'service');
});

test('搜索失败保留问题，联网重试及不联网继续均复用失败回答',async()=>{
  let fail=true;
  const app=await configured(request=>request.url===SEARCH.baseUrl&&fail?Response.json({error:'虚构服务失败'},{status:503}):null);
  const target=await app.handle('new-text',{text:'目标词',context:'所在段落'});
  await app.handle('set-web-search',{id:target.id,enabled:true});
  await app.handle('send-question',{...target,question:'请找公开资料'});await app.drain();
  let thread=(await app.state()).session.threads.context,reply=thread.messages.at(-1);
  assert.equal(reply.search.status,'failed');assert.equal(thread.draft,'请找公开资料');assert.equal(app.requests.length,2);
  const replyId=reply.id;fail=false;
  await app.handle('retry-search',{...target,messageId:replyId});await app.drain();
  thread=(await app.state()).session.threads.context;assert.equal(thread.messages.length,2);assert.equal(thread.messages.at(-1).id,replyId);
  assert.equal(thread.messages.at(-1).search.status,'complete');assert.equal(thread.draft,'');
  assert.equal(app.requests.at(-1).body.messages.filter(message=>message.content==='请找公开资料').length,1);
  fail=true;await app.handle('send-question',{...target,question:'第二个需要搜索的问题'});await app.drain();
  reply=(await app.state()).session.threads.context.messages.at(-1);
  const before=app.requests.length;
  await app.handle('retry-without-search',{...target,messageId:reply.id});await app.drain();
  thread=(await app.state()).session.threads.context;
  assert.equal(app.requests.length,before+1);assert.equal(thread.messages.length,4);assert.equal(thread.messages.at(-1).search,undefined);
  assert.equal((await app.state()).session.webSearchEnabled,true,'本次继续不改变会话的联网偏好');
  assert.equal((await app.state()).settings.prefs.webSearchEnabled,true,'本次继续不修改全局默认值');
  const next=await app.handle('new-text',{text:'不联网继续之后的新材料'});
  assert.equal((await app.store.getSession(next.id)).webSearchEnabled,true);
});

test('截图默认待确认，自动解释开关及截图联网使用正确服务',async()=>{
  const app=await configured();
  await app.handle('capture-done',{rect:{}});
  assert.equal((await app.state()).view,'preview');assert.equal(app.requests.length,0);
  await app.handle('save-settings',{prefs:{autoExplainCapture:true}});
  await app.handle('capture-done',{rect:{}});await app.drain();
  let current=(await app.state()).session;
  assert.equal((await app.state()).view,'explain');assert.equal(current.webSearchEnabled,false);assert.equal(app.requests.length,1);
  assert.equal(app.requests[0].body.model,VISION.model);assert.ok(JSON.stringify(app.requests[0].body).includes(IMAGE));
  await app.handle('set-web-search',{id:current.id,enabled:true});
  await app.handle('send-question',{id:current.id,mode:'visual',question:'图中对象有哪些公开背景？'});await app.drain();
  assert.equal(app.requests[1].body.model,VISION.model);assert.ok(JSON.stringify(app.requests[1].body).includes(IMAGE));
  assert.equal(app.requests[2].url,SEARCH.baseUrl);assert.equal(JSON.stringify(app.requests[2].body).includes(IMAGE),false);
  assert.equal(app.requests[3].body.model,VISION.model);assert.ok(JSON.stringify(app.requests[3].body).includes(IMAGE));
  assert.ok(JSON.stringify(app.requests[3].body).includes('联网资料中的固定依据。'));
});

test('搜索进行中停止会阻止最终模型请求，并保留未回答问题',async()=>{
  let searchStarted;
  const entered=new Promise(resolve=>{searchStarted=resolve;});
  const app=await configured(request=>{
    if(request.url===SEARCH.baseUrl){searchStarted();return new Promise(()=>{});}
    return null;
  });
  const target=await app.handle('new-text',{text:'目标词',context:'所在段落'});
  await app.handle('set-web-search',{id:target.id,enabled:true});
  await app.handle('send-question',{...target,question:'稍后再回答的问题'});await entered;
  await app.handle('stop',target);await app.drain();
  const thread=(await app.state()).session.threads.context;
  assert.equal(thread.status,'stopped');assert.equal(thread.draft,'稍后再回答的问题');assert.equal(app.requests.length,2);
});

test('迟到上下文绑定原会话并尊重手动补充，不触发模型',async()=>{
  const app=await configured();
  const source={app:'固定原软件',title:'虚构窗口',method:'UIA 已验证选区'};
  await app.acceptCapturedSelection({...source,requestId:'1:1',text:'先选的文字',context:'',contextPending:true});
  const first=(await app.state()).session.id;
  await app.acceptCapturedSelection({...source,requestId:'1:2',text:'后选的文字',context:'',contextPending:true});
  const second=(await app.state()).session.id;
  await app.applySelectionContext({requestId:'1:1',context:'先选文字的段落',contextOrigin:'UIA 所在段落'});
  assert.equal((await app.store.getSession(first)).context,'先选文字的段落');
  assert.equal((await app.state()).session.id,second);assert.equal((await app.state()).session.context,'');
  await app.handle('set-context',{id:second,context:'用户手动补充的段落'});
  await app.applySelectionContext({requestId:'1:2',context:'不该覆盖的自动段落',contextOrigin:'UIA 所在段落'});
  assert.equal((await app.store.getSession(second)).context,'用户手动补充的段落');
  assert.equal((await app.state()).session.contextPending,false);assert.equal(app.requests.length,0);
});

test('测试未选中的厂商时只使用该厂商保存的密钥',async()=>{
  const app=await configured();
  const deepseek={providerId:'deepseek',baseUrl:'https://deepseek.example/v1',model:'虚构DeepSeek模型',apiKey:'fictional-deepseek-key'};
  const mimo={providerId:'mimo',baseUrl:'https://mimo.example/v1',model:'虚构MiMo模型',apiKey:'fictional-mimo-key'};
  await app.handle('save-settings',{text:deepseek});await app.handle('save-settings',{text:mimo});
  await app.handle('test-provider',{kind:'text',config:{providerId:'deepseek',baseUrl:deepseek.baseUrl,model:deepseek.model}});
  assert.equal(app.requests.at(-1).headers.Authorization,'Bearer '+deepseek.apiKey);
  const before=app.requests.length;
  await assert.rejects(app.handle('test-provider',{kind:'text',config:{providerId:'deepseek',baseUrl:'https://changed.example/v1',model:deepseek.model}}),/重新输入密钥/);
  assert.equal(app.requests.length,before);
});

test('截图自动解释配置不完整时仍保留预览和图像材料',async()=>{
  const app=await application();
  await app.handle('save-settings',{prefs:{autoExplainCapture:true}});
  await app.handle('capture-done',{rect:{}});
  const state=await app.state();
  assert.equal(state.view,'preview');assert.equal(state.session.imageData,IMAGE);assert.match(state.status.error,/请先配置/);
  assert.equal(app.requests.length,0);
});

test('关闭会话联网后点击重试联网，仍只为该次重试检索',async()=>{
  let fail=true;
  const app=await configured(request=>request.url===SEARCH.baseUrl&&fail?Response.json({error:'虚构搜索失败'},{status:503}):null);
  const target=await app.handle('new-text',{text:'目标词',context:'所在段落'});
  await app.handle('set-web-search',{id:target.id,enabled:true});
  await app.handle('send-question',{...target,question:'需要资料的问题'});await app.drain();
  const message=(await app.state()).session.threads.context.messages.at(-1);
  await app.handle('set-web-search',{id:target.id,enabled:false});
  const before=app.requests.length;fail=false;
  await app.handle('retry-search',{...target,messageId:message.id});await app.drain();
  const state=await app.state();
  assert.equal(app.requests.length,before+3);assert.equal(state.session.webSearchEnabled,false);
  assert.equal(state.settings.prefs.webSearchEnabled,false,'显式联网重试不修改全局默认值');
  assert.equal(state.session.threads.context.messages.at(-1).search.status,'complete');
  const next=await app.handle('new-text',{text:'显式联网重试之后的新材料'});
  assert.equal((await app.store.getSession(next.id)).webSearchEnabled,false);
});

test('网站图标只读取回答中保存的来源，不接受渲染器任意指定的网址',async()=>{
  const app=await application();
  const saved=await app.store.createSession({text:'测试来源材料',activeMode:'independent',threads:{context:{messages:[],draft:''},visual:{messages:[],draft:''},independent:{draft:'',messages:[{id:'带来源的回答',role:'assistant',content:'带来源的回答',status:'complete',search:{status:'complete',providerId:'exa',query:'测试',sources:[{id:1,title:'公开来源',url:'https://source.example/article'}]}}]}}});
  await app.handle('open-session',{id:saved.id});
  const requested=[];
  app.setSourceIcons({get:async url=>{requested.push(url);return '虚构安全图标';}});
  const selected={id:saved.id,mode:'independent',messageId:'带来源的回答',sourceId:1,url:'https://other.example/arbitrary'};
  assert.equal(await app.handle('get-source-icon',selected),'虚构安全图标');
  assert.deepEqual(requested,['https://source.example/article']);
  assert.equal(await app.handle('get-source-icon',{...selected,sourceId:2}),'');
  assert.equal(requested.length,1);
});
