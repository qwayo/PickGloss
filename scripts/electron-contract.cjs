'use strict';
const { app, safeStorage, shell, net, desktopCapturer, screen } = require('electron');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { createStore } = require('../src/core/store.cjs');
const { buildMessages, streamCompletion } = require('../src/core/provider.cjs');

app.whenReady().then(async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'pickgloss-contract-'));
  const received=[];
  const server=http.createServer(async(req,res)=>{
    let data='';for await(const chunk of req)data+=chunk;
    received.push(JSON.parse(data));
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    res.write('data: '+JSON.stringify({choices:[{delta:{content:'这是一段本机测试响应。'}}]})+'\n\n');
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const config={baseUrl:`http://127.0.0.1:${server.address().port}/v1`,model:'local-test',apiKey:'pickgloss-test-key-only'};
    const store=createStore({directory:root,encrypt:value=>safeStorage.encryptString(value),decrypt:value=>safeStorage.decryptString(value),trash:target=>shell.trashItem(target)});
    await store.init();await store.saveSettings({text:config});
    assert.equal((await store.getSettings({includeSecrets:true})).text.apiKey,config.apiKey);
    assert.equal((await fs.readFile(path.join(root,'settings.json'),'utf8')).includes(config.apiKey),false);
    const selected=await store.createSession({text:'compound',context:'Small discoveries compound over time.',kind:'text'});
    const answer=await streamCompletion({config,messages:buildMessages(selected,'independent'),fetchImpl:(...args)=>net.fetch(...args)});
    assert.equal(answer,'这是一段本机测试响应。');
    assert.equal(JSON.stringify(received[0]).includes(selected.context),false);
    await store.deleteSession(selected.id);
    assert.equal((await store.listSessions()).length,0);
    const display=screen.getPrimaryDisplay();
    const sources=await desktopCapturer.getSources({types:['screen'],thumbnailSize:{width:display.bounds.width,height:display.bounds.height}});
    const screenshotAvailable=sources.some(source=>!source.thumbnail.isEmpty());
    assert.equal(screenshotAvailable,true);
    // 屏幕内容只在内存中用于确认捕获API可用，不保存、发送或记录画面。
    const report={encryptionRoundTrip:true,keyNotPlaintext:true,electronFetchWithLocalStub:true,independentPayloadIsolated:true,windowsRecycleBin:true,screenCaptureAvailable:true,realProvider:false};
    await fs.mkdir(path.join(__dirname,'..','build'),{recursive:true});
    await fs.writeFile(path.join(__dirname,'..','build','electron-contract.json'),JSON.stringify(report,null,2),'utf8');
    console.log('Windows 宿主合同检查通过。');
    await shell.trashItem(root);
    server.close();app.exit(0);
  } catch(error) {console.error(error.message);server.close();app.exit(1);}
});
