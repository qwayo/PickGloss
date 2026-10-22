'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const provider = require('../../src/core/provider.cjs');
const imageData = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC1kAAAAASUVORK5CYII=';
const textConfig = { baseUrl: 'https://text.example/v1', model: '文字兼容模型', apiKey: '测试文字密钥' };
const visionConfig = { baseUrl: 'https://vision.example/v1', model: '独立识图模型', apiKey: '测试识图密钥' };

// 执行真实主进程和请求构造逻辑，只替换 Electron、磁盘与网络；不读取用户配置。
function harness(configs) {
  const requests = [];
  const app = {setPath() {},getPath:()=>'',setName() {},setAppUserModelId() {},requestSingleInstanceLock:()=>true,on() {},whenReady:()=>new Promise(()=>{})};
  const store = {getSettings:async()=>structuredClone(configs),updateSession:async()=>{},listSessions:async()=>[]};
  const desktop = {captureState:()=>null,broadcast() {}};
  const electron = {app,net:{fetch:async(url,options)=>{
    requests.push({url,headers:options.headers,body:JSON.parse(options.body)});
    return Response.json({choices:[{message:{content:'本机测试响应'}}]});
  }}};
  const context = {require:name=>name==='electron'?electron:name==='./core/provider.cjs'?provider:name.startsWith('./')?{}:require(name),
    process:{argv:[],env:{},pid:1},URL,AbortController,structuredClone,setTimeout:()=>1,clearTimeout() {},testStore:store,testDesktop:desktop,
    testSession:{id:'测试截图',kind:'image',activeMode:'visual',imageData,note:'解释图中内容',threads:Object.fromEntries(['context','independent','visual'].map(mode=>[mode,{messages:[],draft:''}]))}};
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../../src/main.cjs'),'utf8')+`
    store=testStore;desktop=testDesktop;settings={};activeId=testSession.id;cache.set(activeId,testSession);
    globalThis.audit={handle,request:async()=>{await startRequest({id:activeId,mode:'visual'});await Promise.all([...jobs.values()].map(job=>job.promise));},session:()=>active()};
  `,context);
  return {...context.audit,requests};
}

test('未填识图模型时，截图请求完整沿用文字地址模型密钥并保留图片输入',async()=>{
  for(const vision of [undefined,{}, {...visionConfig,model:'  '}]) {
    const app=harness({text:textConfig,vision});
    await app.request();
    const sent=app.requests[0];
    assert.equal(sent.url,textConfig.baseUrl+'/chat/completions');
    assert.equal(sent.body.model,textConfig.model);
    assert.equal(sent.headers.Authorization,'Bearer '+textConfig.apiKey);
    assert.ok(sent.body.messages.some(message=>Array.isArray(message.content)&&message.content.some(part=>part.type==='image_url'&&part.image_url.url===imageData)));
    assert.equal(app.session().threads.visual.status,'done');
  }
});

test('已填识图模型时优先独立配置，配置不完整时不悄悄切换文字服务',async()=>{
  const app=harness({text:textConfig,vision:visionConfig});
  await app.request();
  assert.equal(app.requests[0].url,visionConfig.baseUrl+'/chat/completions');
  assert.equal(app.requests[0].body.model,visionConfig.model);
  assert.equal(app.requests[0].headers.Authorization,'Bearer '+visionConfig.apiKey);
  const incomplete=harness({text:textConfig,vision:{...visionConfig,baseUrl:''}});
  await assert.rejects(incomplete.request(),/请先配置/);
  assert.equal(incomplete.requests.length,0);
  const missing=harness({text:{},vision:{}});
  await assert.rejects(missing.request(),/请先配置/);
  assert.equal(missing.requests.length,0);
});

test('识图测试沿用当前文字表单，仍发送图片，并只沿用文字服务密钥',async()=>{
  const app=harness({text:textConfig,vision:visionConfig});
  const result=await app.handle('test-provider',{kind:'vision',config:{...visionConfig,model:''},fallbackConfig:{baseUrl:textConfig.baseUrl,model:'尚未保存的文字模型'}});
  assert.match(result.message,/文字模型/);
  assert.equal(app.requests[0].body.model,'尚未保存的文字模型');
  assert.equal(app.requests[0].headers.Authorization,'Bearer '+textConfig.apiKey);
  assert.ok(app.requests[0].body.messages[0].content.some(part=>part.type==='image_url'));
});

test('沿用文字模型进行识图测试仍阻止旧密钥跨来源，明确新密钥后才发送',async()=>{
  const app=harness({text:textConfig,vision:visionConfig});
  const payload={kind:'vision',config:{model:''},fallbackConfig:{baseUrl:'https://another.example/v1',model:'另一模型'}};
  await assert.rejects(app.handle('test-provider',payload),/重新输入密钥/);
  assert.equal(app.requests.length,0);
  payload.fallbackConfig.apiKey='新服务测试密钥';
  await app.handle('test-provider',payload);
  assert.equal(app.requests[0].headers.Authorization,'Bearer 新服务测试密钥');
});
