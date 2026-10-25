'use strict';
// 用隐藏 Electron 窗口和虚构状态检查联网服务界面，不访问真实账户或网络。
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { quoteJavaScriptString } = require('./javascript-string.cjs');
const { setTimeout: delay } = require('node:timers/promises');

app.setPath('userData', path.join(os.tmpdir(), `pickgloss-services-ui-${process.pid}`));
const rootArg = process.argv.indexOf('--app-root');
const sourceRoot = rootArg < 0 ? path.join(__dirname, '..') : path.resolve(process.argv[rootArg + 1]);
const outputArg = process.argv.indexOf('--output-dir');
const outputRoot = outputArg < 0 ? path.join(os.tmpdir(), `PickGloss-ai-services-ui-${process.pid}`) : path.resolve(process.argv[outputArg + 1]);
function dimension(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isSafeInteger(value) || value < 200) throw new Error(`${name} 必须是至少 200 的整数。`);
  return value;
}
const viewportWidth = dimension('--width', 430);
const viewportHeight = dimension('--height', 690);
const imageData = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jUioAAAAASUVORK5CYII=';
const calls = [], openedLinks = [], remoteRequests = [], consoleErrors = [];
let win, sendFailureMode = '';

const current = {
  view: 'explain', history: [], settingsFilePath: 'C:\\Users\\Mock\\PickGloss\\settings.json',
  serviceCatalog: {
    models: [
      { id: 'custom', name: '自定义', baseUrl: '', model: '', keyUrl: '' },
      { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', keyUrl: 'https://platform.deepseek.com/api_keys' },
      { id: 'mimo', name: '小米 MiMo', baseUrl: 'https://api.xiaomimimo.com/v1', model: 'mimo-v2.6-pro', keyUrl: 'https://platform.xiaomimimo.com/#/console/api-keys' },
    ],
    search: [
      { id: 'exa', name: 'Exa', baseUrl: 'https://api.exa.ai/search', keyUrl: 'https://dashboard.exa.ai/api-keys' },
      { id: 'custom', name: '自定义', protocol: 'exa', baseUrl: '', keyUrl: '' },
      { id: 'brave', name: 'Brave', baseUrl: 'https://api.search.brave.com/res/v1/llm/context', keyUrl: 'https://api.search.brave.com/app/keys' },
      { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1/tools/search', keyUrl: 'https://platform.deepseek.com/api_keys' },
    ],
  },
  settings: {
    text: { providerId: 'custom', baseUrl: 'https://model.mock.invalid/v1', model: '虚构模型', hasKey: false },
    vision: { providerId: 'custom', baseUrl: '', model: '', hasKey: false },
    search: { providerId: 'exa', baseUrl: 'https://search.mock.invalid', hasKey: false },
    serviceProfiles: {
      text: { deepseek: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', hasKey: true }, mimo: { baseUrl: 'https://api.xiaomimimo.com/v1', model: 'mimo-v2.6-pro', hasKey: true } },
      vision: {},
      search: { exa: { baseUrl: 'https://saved.exa.invalid', hasKey: true }, brave: { baseUrl: 'https://saved.brave.invalid', hasKey: true } },
    },
    prefs: {},
  },
  session: {
    id: '虚构文字会话', kind: 'text', text: 'selected text', context: '', contextPending: true,
    activeMode: 'context', webSearchEnabled: false,
    threads: {
      context: { status: 'error', draft: '', messages: [
        { id: '回答来源', role: 'assistant', content: '查阅到相关资料。[1]', status: 'complete', search: { status: 'complete', providerId: 'exa', query: '示例短查询', sources: [
          { id: 1, title: 'Genshin Impact 6th Anniversary — App Store apps by seller | Companies.sg', url: 'https://evidence.invalid/article', snippet: '这是通过虚构搜索响应提供的来源摘录。\n\nRecord overview    Category&#x20; App Store software' },
        ] } },
        { id: '回答搜索失败', role: 'assistant', content: '', status: 'error', requestQuestion: '请解释这个术语', search: { status: 'failed', providerId: 'exa', query: '请解释这个术语', error: '虚构搜索失败' } },
      ] },
      independent: { status: 'idle', draft: '', messages: [] },
      visual: { status: 'idle', draft: '', messages: [] },
    },
  },
  status: {},
};

async function pushState() {
  const seen = new Promise(resolve => ipcMain.once('test:state-seen', resolve));
  win.webContents.send('test:state', current);
  await seen;
}

ipcMain.handle('test:invoke', async (_, action, payload) => {
  calls.push({ action, payload });
  if (action === 'bootstrap') return { ok: true, value: current };
  if (action === 'send-question') {
    const delivery = sendFailureMode;
    sendFailureMode = '';
    const thread = current.session.threads[payload.mode];
    const question = payload.question;
    thread.draft = '';
    thread.messages.push({ id: `用户-${question}`, role: 'user', content: question, status: 'complete' });
    const reply = { id: `回答-${question}`, role: 'assistant', requestQuestion: question, content: '', status: 'streaming',
      search: { status: 'searching', providerId: 'exa', query: question, sources: [] } };
    thread.messages.push(reply);
    thread.status = 'streaming';
    await pushState();
    const fail = async status => {
      reply.status = status;
      if (status === 'error') reply.search = { ...reply.search, status: 'failed', error: '虚构搜索失败' };
      else reply.search = { ...reply.search, sources: [{ id: 1, title: '停止前已取得来源', url: 'https://evidence.invalid/stopped' }] };
      thread.status = status;
      thread.draft = question;
      await pushState();
    };
    if (delivery === 'before-response') {
      await fail('error');
      await delay(30);
    } else {
      setTimeout(() => { void fail(delivery === 'stop' ? 'stopped' : 'error'); }, 160);
    }
    return { ok: true };
  }
  if (action === 'open-link') openedLinks.push(payload.url);
  if (action === 'set-web-search') {
    current.session.webSearchEnabled = payload.enabled;
    await pushState();
  }
  if (action === 'open-settings') { current.view = 'settings'; current.settingsSection = payload.section === 'general' ? 'general' : 'service'; await pushState(); }
  if (action === 'open-shortcuts') { current.settingsSection = 'shortcuts'; await pushState(); }
  if (action === 'open-appearance') { current.settingsSection = 'appearance'; await pushState(); }
  if (action === 'navigate') { current.view = payload.view; await pushState(); }
  if (action === 'set-mode') { current.session.activeMode = payload.mode; await pushState(); }
  if (action === 'get-source-icon') return {ok:true,value:imageData};
  if (action === 'set-note') current.session.note = payload.note;
  if (action === 'test-search-provider') return { ok: true, value: '虚构搜索服务连接成功' };
  if (action === 'save-settings' && !payload.text) {
    current.settings.prefs = { ...current.settings.prefs, ...payload.prefs };
    await pushState(); return { ok: true, value: { prefs: current.settings.prefs } };
  }
  if (action === 'save-settings') {
    const serviceProfiles = {};
    for (const [kind, profiles] of Object.entries(payload.serviceProfiles)) {
      serviceProfiles[kind] = {};
      for (const [id, config] of Object.entries(profiles)) serviceProfiles[kind][id] = {
        baseUrl: config.baseUrl,
        ...(config.protocol ? { protocol: config.protocol } : {}),
        ...(config.model === undefined ? {} : { model: config.model }),
        hasKey: Boolean(config.apiKey) || Boolean(current.settings.serviceProfiles?.[kind]?.[id]?.hasKey),
      };
    }
    current.settings = {
      ...current.settings,
      text: { providerId: payload.text.providerId, baseUrl: payload.text.baseUrl, model: payload.text.model, hasKey: Boolean(payload.text.apiKey) || current.settings.text.hasKey },
      vision: { providerId: payload.vision.providerId, baseUrl: payload.vision.baseUrl, model: payload.vision.model, hasKey: false },
      search: { providerId: payload.search.providerId, baseUrl: payload.search.baseUrl, ...(payload.search.protocol ? { protocol: payload.search.protocol } : {}), hasKey: Boolean(payload.search.apiKey) || current.settings.search.hasKey },
      prefs: { ...current.settings.prefs, ...payload.prefs },
      serviceProfiles,
    };
    await pushState();
  }
  return { ok: true };
});

async function waitFor(script, description) {
  for (let index = 0; index < 180; index++) {
    if (await win.webContents.executeJavaScript(script)) return;
    await delay(10);
  }
  throw new Error(`等待${description}超时`);
}

async function waitForCall(action, predicate = () => true) {
  for (let index = 0; index < 180; index++) {
    const found = calls.find(item => item.action === action && predicate(item));
    if (found) return found;
    await delay(10);
  }
  throw new Error(`等待 IPC 操作 ${action} 超时`);
}

async function verifyQuestionDraftRecovery(id, delivery, edits, expected) {
  current.view = 'explain';
  current.session = {
    id, kind: 'text', text: 'selected text', context: 'ready context', activeMode: 'independent', webSearchEnabled: true,
    threads: { context: { status: 'idle', draft: '', messages: [] }, independent: { status: 'idle', draft: '', messages: [] }, visual: { status: 'idle', draft: '', messages: [] } },
  };
  await pushState();
  sendFailureMode = delivery;
  const question = `恢复问题-${id}`;
  await win.webContents.executeJavaScript(`(() => { const input=document.querySelector('[data-field="question"]'); input.value=${quoteJavaScriptString(question)}; input.dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('.composer .send').click(); })()`);
  await waitForCall('send-question', item => item.payload?.id === id);
  if (delivery === 'before-response') {
    await waitFor(`Boolean(document.querySelector('.search-failure'))`, '搜索失败状态');
    await waitFor(`document.querySelector('.composer .send')?.disabled===false`, '发送请求结束');
  } else {
    await waitFor(`(() => {const input=document.querySelector('[data-field="question"]'),send=document.querySelector('.composer .send');return input&&!input.disabled&&send?.title==='停止回答';})()`, '发送结果到达且回答仍在运行');
    await waitFor(`document.querySelector('[data-field="question"]').value===''`, '发送结果清空输入');
    if (edits === 'replace') {
      await win.webContents.executeJavaScript(`(() => {const input=document.querySelector('[data-field="question"]');input.value='后写的追问';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    } else if (edits === 'clear') {
      await win.webContents.executeJavaScript(`(() => {const input=document.querySelector('[data-field="question"]');input.value='输入后主动清空';input.dispatchEvent(new Event('input',{bubbles:true}));input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    }
  }
  if (delivery === 'before-response') {
    // 上方已等待搜索失败和 IPC 回执，现检查真实 textarea 值。
  } else if (delivery === 'stop') await waitFor(`Boolean(document.querySelector('.message-state'))`, '停止状态');
  else await waitFor(`Boolean(document.querySelector('.search-failure'))`, '搜索失败状态');
  assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-field="question"]').value`), expected,
    `${delivery}/${edits || '未编辑'} 后，输入框应保留正确草稿`);
  if (delivery === 'stop') {
    const status = await win.webContents.executeJavaScript(`({progress:document.querySelector('.search-progress')?.textContent||'',source:document.querySelector('.search-source-link')?.textContent||''})`);
    assert.doesNotMatch(status.progress, /正在提炼|正在联网搜索/, '停止后不得显示过期的联网进行中状态');
    assert.equal(status.source, '停止前已取得来源', '停止后仍显示之前取得的来源');
  }
}

async function screenshot(name) {
  await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await fs.mkdir(outputRoot, { recursive: true });
  const layout = await win.webContents.executeJavaScript(`({headerTop:document.querySelector('.panel-bar')?.getBoundingClientRect().top,panelScroll:document.querySelector('.panel')?.scrollTop,bodyLeft:document.querySelector('.panel-body')?.scrollLeft})`);
  await fs.writeFile(path.join(outputRoot,name+'.json'), JSON.stringify(layout));
  const image = await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
  await fs.writeFile(path.join(outputRoot, name), image.toPNG());
}

app.whenReady().then(async () => {
  const watchdog = setTimeout(() => { console.error('AI 服务界面检查超时'); app.exit(1); }, 30000);
  try {
    win = new BrowserWindow({ show: false, width: viewportWidth, height: viewportHeight, useContentSize: true,
      webPreferences: { preload: path.join(__dirname, '../tests/renderer/streaming.preload.cjs'), contextIsolation: true, sandbox: true, backgroundThrottling: false, offscreen: true } });
    win.webContents.on('console-message', (_, details) => { if (details.level === 'error') consoleErrors.push(details.message); });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
      remoteRequests.push(details.url);
      callback({ cancel: true });
    });
    await win.loadFile(path.join(sourceRoot, 'src/renderer/index.html'));
    await waitFor(`Boolean(document.querySelector('.composer .web-search-toggle'))`, '追问联网按钮');

    const initial = await win.webContents.executeJavaScript(`(() => ({
      searchPressed: document.querySelector('.composer .web-search-toggle').getAttribute('aria-pressed'),
      searchTitle: document.querySelector('.composer .web-search-toggle').title,
      contextPending: document.querySelector('.context-pending')?.textContent,
      sendDisabled: document.querySelector('.composer .send').disabled,
      independentTab: [...document.querySelectorAll('.mode-tabs[aria-label="解释模式"] button')].some(button => button.textContent === '独立释义'),
      sourceCount: document.querySelectorAll('.search-source-link').length,
      sourceTitle: document.querySelector('.search-source-link')?.textContent,
      failureActions: [...document.querySelectorAll('.search-failure button')].map(button => button.textContent),
    }))()`);
    assert.equal(initial.searchPressed, 'false', '新会话默认关闭联网搜索');
    assert.match(initial.searchTitle, /已关闭/);
    assert.match(initial.contextPending, /正在获取上下文/);
    assert.equal(initial.sendDisabled, true, '上下文尚未就绪时不能发送语境解释');
    assert.equal(initial.independentTab, true, '独立释义仍可用');
    assert.equal(initial.sourceCount, 1, '只显示实际来源对象');
    assert.equal(initial.sourceTitle, 'Genshin Impact 6th Anniversary — App Store apps by seller | Companies.sg');
    assert.deepEqual(initial.failureActions, ['重试联网', '不联网继续']);
    assert.equal(calls.filter(item=>item.action==='get-source-icon').length,0,'来源列表折叠时不请求图标');
    const composerLayout = await win.webContents.executeJavaScript(`(() => {
      const panel=document.querySelector('.panel'), composer=document.querySelector('.composer');
      const textarea=document.querySelector('.composer textarea'), globe=document.querySelector('.composer .web-search-toggle'), send=document.querySelector('.composer .send');
      const box=node=>{const rect=node.getBoundingClientRect();return {left:rect.left,right:rect.right,width:rect.width}};
      const a=box(textarea), b=box(globe), c=box(send), d=box(composer);
      return {width:innerWidth,height:innerHeight,documentOverflow:document.documentElement.scrollWidth>innerWidth+1,
        panelOverflow:panel.scrollWidth>panel.clientWidth+1,composerOverflow:composer.scrollWidth>composer.clientWidth+1,
        textareaWidth:a.width,controlsFit:a.width>=64&&a.right<=b.left+1&&b.right<=c.left+1&&c.right<=d.right+1};
    })()`);
    assert.ok(Math.abs(composerLayout.width - viewportWidth) <= 1, 'Electron 内容宽度允许 1px 的窗口取整');
    assert.ok(Math.abs(composerLayout.height - viewportHeight) <= 1, 'Electron 内容高度允许 1px 的窗口取整');
    assert.equal(composerLayout.documentOverflow, false, '文档不得出现横向溢出');
    assert.equal(composerLayout.panelOverflow, false, '面板不得出现横向溢出');
    assert.equal(composerLayout.composerOverflow, false, '输入框内部不得出现横向溢出');
    assert.equal(composerLayout.controlsFit, true, '追问文字框、联网按钮和发送按钮须按序放进输入框');

    await win.webContents.executeJavaScript(`(() => { const details=document.querySelector('.search-sources'); details.open=true; document.querySelector('[data-field="question"]').value='保留的追问草稿'; document.querySelector('[data-field="question"]').dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('.composer .web-search-toggle').click(); })()`);
    await waitFor(`document.querySelector('.composer .web-search-toggle')?.getAttribute('aria-pressed')==='true'`, '联网开启反馈');
    assert.deepEqual(calls.find(item => item.action === 'set-web-search')?.payload, { id: '虚构文字会话', mode: 'context', enabled: true });
    await win.webContents.executeJavaScript(`document.querySelector('.search-sources').scrollIntoView({block:'start',container:'nearest'})`);
    await screenshot('AI服务-联网回答与来源.png');
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.search-source-excerpt').open`), false, '标题下的摘录默认折叠');
    await waitFor(`Boolean(document.querySelector('.source-site-icon img'))`, '网站图标');
    assert.equal(calls.filter(item=>item.action==='get-source-icon').length,1,'同源网站只请求一次图标');
    assert.deepEqual(calls.find(item=>item.action==='get-source-icon').payload,{id:'虚构文字会话',mode:'context',messageId:'回答来源',sourceId:1});
    await screenshot('联网来源-摘录折叠.png');
    await win.webContents.executeJavaScript(`document.querySelector('.search-source-excerpt summary').click()`);
    const sourceSpacing = await win.webContents.executeJavaScript(`(() => {
      const snippet=document.querySelector('.search-source-snippet'), details=document.querySelector('.search-source-excerpt');
      return {text:snippet.textContent,whiteSpace:getComputedStyle(snippet).whiteSpace,visible:snippet.getBoundingClientRect().height>0,open:details.open};
    })()`);
    assert.doesNotMatch(sourceSpacing.text, /\n| {2,}|&#x20;/);
    assert.equal(sourceSpacing.whiteSpace, 'normal');
    assert.equal(sourceSpacing.open, true); assert.equal(sourceSpacing.visible, true);
    const sourceFonts = await win.webContents.executeJavaScript(`['.search-sources>summary','.search-source-link','.search-source-excerpt>summary','.search-source-snippet'].map(selector=>getComputedStyle(document.querySelector(selector)).fontSize)`);
    assert.deepEqual(sourceFonts, ['12px', '12px', '11px', '12px'], '来源标题和摘录使用更紧凑的字号');
    await pushState();
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.search-source-excerpt').open`), true, '重绘保留主动展开的摘录');
    await win.webContents.executeJavaScript(`document.querySelector('.search-source-excerpt').scrollIntoView({block:'start',container:'nearest'})`);
    await screenshot('联网来源-摘录展开.png');
    current.session.threads.context.messages[0].status = 'streaming';
    for (const status of ['preparing', 'searching', 'complete']) {
      current.session.threads.context.messages[0].search.status = status;
      await pushState();
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-message="回答来源"]').querySelectorAll('.search-progress,.search-sources').length`), 0, '回答生成时隐藏联网过程和来源');
    }
    current.session.threads.context.messages[0].status = 'complete';
    current.session.threads.context.messages[0].search.status = 'complete';
    await pushState();
    assert.match(await win.webContents.executeJavaScript(`document.querySelector('[data-message="回答来源"] .search-progress')?.textContent`), /已参考联网资料/);
    assert.equal(await win.webContents.executeJavaScript(`Boolean(document.querySelector('[data-message="回答来源"] .search-sources'))`), true, '回答完成后显示来源');
    await win.webContents.executeJavaScript(`(() => { const body=document.querySelector('[data-scroll="body"]'); body.scrollTop=body.scrollHeight; })()`);
    await screenshot('AI服务-联网失败恢复.png');

    await win.webContents.executeJavaScript(`document.querySelector('.composer .web-search-toggle').click()`);
    await waitFor(`document.querySelector('.composer .web-search-toggle')?.getAttribute('aria-pressed')==='false'`, '联网关闭反馈');
    assert.deepEqual(calls.filter(item => item.action === 'set-web-search').map(item => item.payload.enabled), [true, false], '按钮能够开启和关闭联网');

    await win.webContents.executeJavaScript(`document.querySelector('.search-source-link').click()`);
    await waitFor(`Boolean(document.querySelector('.search-source-link'))`, '来源链接保留');
    for (let index = 0; index < 180 && openedLinks.length === 0; index++) await delay(10);
    assert.deepEqual(openedLinks, ['https://evidence.invalid/article'], '来源通过 open-link 打开');
    assert.deepEqual(remoteRequests, [], '渲染来源不加载远程图片或页面');

    const failureButtons = await win.webContents.executeJavaScript(` [...document.querySelectorAll('.search-failure button')].map(button => button.textContent)`);
    await win.webContents.executeJavaScript(`document.querySelector('.search-failure button').click()`);
    await waitFor(`document.querySelector('.search-failure button')?.textContent==='重试联网'`, '搜索重试按钮');
    assert.deepEqual(calls.find(item => item.action === 'retry-search')?.payload, { id: '虚构文字会话', mode: 'context', messageId: '回答搜索失败' });
    await win.webContents.executeJavaScript(`document.querySelectorAll('.search-failure button')[1].click()`);
    await waitFor(`Boolean(document.querySelector('.search-failure'))`, '不联网继续操作');
    assert.deepEqual(calls.find(item => item.action === 'retry-without-search')?.payload, { id: '虚构文字会话', mode: 'context', messageId: '回答搜索失败' });
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-field="question"]').value`), '保留的追问草稿', '恢复操作不能丢弃追问草稿');
    assert.deepEqual(failureButtons, ['重试联网', '不联网继续']);

    // 真实 Web Animations 时序：横条中途位置、重绘后继续及内容动画均可观察。
    await win.webContents.executeJavaScript(`document.querySelectorAll('.mode-tabs[aria-label="解释模式"] button')[1].click()`);
    await waitFor(`document.querySelectorAll('.mode-tabs[aria-label="解释模式"] button')[1].getAttribute('aria-selected')==='true' && document.querySelector('.mode-content').getAnimations().length>0`, '解释模式切换动画');
    const modeMotion = await win.webContents.executeJavaScript(`(() => {const tabs=document.querySelector('.mode-tabs[aria-label="解释模式"]'), indicator=tabs.querySelector('.mode-indicator'), animation=indicator.getAnimations()[0];return {left:parseFloat(getComputedStyle(indicator).left),target:tabs.querySelector('[aria-selected="true"]').offsetLeft,frames:animation?.effect.getKeyframes(),time:animation?.currentTime};})()`);
    assert.ok(modeMotion.frames?.length>=2 && modeMotion.frames[0].left!==modeMotion.frames.at(-1).left, '解释横条从旧位置滑向新位置');
    assert.ok(modeMotion.left<modeMotion.target, '能够观察到移动中的横条');
    await delay(35); await pushState();
    const continued = await win.webContents.executeJavaScript(`document.querySelector('.mode-tabs[aria-label="解释模式"] .mode-indicator').getAnimations()[0]?.currentTime`);
    assert.ok(continued>modeMotion.time, '状态回推不会将横条动画重置为起点');
    current.status.reducedMotion=true; await pushState();
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.mode-content').getAnimations().length+document.querySelector('.mode-tabs[aria-label="解释模式"] .mode-indicator').getAnimations().length`),0,'动画中途开启减少动态效果会立即停止');
    current.status.reducedMotion=false; await pushState();
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.mode-content').getAnimations().length+document.querySelector('.mode-tabs[aria-label="解释模式"] .mode-indicator').getAnimations().length`),0,'恢复动态效果不会重播已停止的切换');

    await delay(220);
    assert.equal(await win.webContents.executeJavaScript(`(() => {const tabs=document.querySelector('.mode-tabs[aria-label="解释模式"]');return Math.abs(parseFloat(getComputedStyle(tabs.querySelector('.mode-indicator')).left)-tabs.querySelector('[aria-selected="true"]').offsetLeft)<1;})()`), true);
    await win.webContents.executeJavaScript(`document.querySelectorAll('.mode-tabs[aria-label="解释模式"] button')[0].click()`);
    await waitFor(`document.querySelectorAll('.mode-tabs[aria-label="解释模式"] button')[0].getAttribute('aria-selected')==='true'`, '回到语境解释');
    await delay(220);

    await verifyQuestionDraftRecovery('问题失败先推送', 'before-response', '', '恢复问题-问题失败先推送');
    await verifyQuestionDraftRecovery('问题失败后推送', 'after-response', '', '恢复问题-问题失败后推送');
    await verifyQuestionDraftRecovery('新草稿胜出', 'after-edit', 'replace', '后写的追问');
    await verifyQuestionDraftRecovery('主动清空胜出', 'after-clear', 'clear', '');
    await verifyQuestionDraftRecovery('停止保留问题', 'stop', '', '恢复问题-停止保留问题');

    await win.webContents.executeJavaScript(`document.querySelector('.panel-footer .provider').click()`);
    await waitFor(`Boolean(document.querySelector('[data-settings-section="service"]'))`, '服务设置');
    const settingsInitial = await win.webContents.executeJavaScript(`(() => ({
      keyNote: document.querySelector('.api-key-note')?.textContent,
      keyNoteLines: Math.round(document.querySelector('.api-key-note').scrollHeight / parseFloat(getComputedStyle(document.querySelector('.api-key-note')).lineHeight)),
      visibleKeyNotes: document.querySelectorAll('.settings-section[data-provider]:not([hidden]) .api-key-note').length,
      autoExplain: document.querySelector('[name="autoExplainCapture"]')?.checked,
      providers: [...document.querySelectorAll('.settings-section[data-provider]')].map(section => section.dataset.provider),
    }))()`);
    assert.equal(settingsInitial.keyNote, '本机 DPAPI 加密。路径：C:\\Users\\Mock\\PickGloss\\settings.json');
    assert.equal(settingsInitial.visibleKeyNotes, 1, '当前服务选项卡应只显示一条密钥说明');
    if (viewportWidth <= 350) assert.ok(settingsInitial.keyNoteLines > 1, '小窗中的配置路径应自然换行');
    assert.equal(settingsInitial.autoExplain, false, '截图自动解释默认关闭');
    assert.deepEqual(settingsInitial.providers, ['text', 'vision', 'search']);
    await win.webContents.executeJavaScript(`document.querySelector('.settings-navigation button').click()`);
    await waitFor(`document.querySelector('[data-settings-section="general"]')?.hidden===false`, '常规设置');
    assert.deepEqual(await win.webContents.executeJavaScript(`[...document.querySelectorAll('.settings-navigation button')].map(node=>node.textContent)`), ['常规设置','AI 服务','外观与主题','快捷键']);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-settings-section="appearance"] .window-settings')===null && document.querySelector('[data-settings-section="shortcuts"] [data-field="pin-sound"]')===null`), true, '通用选项已迁出外观和快捷键');
    const settingsTop = await win.webContents.executeJavaScript(`(() => {const body=document.querySelector('.settings-body'),nav=document.querySelector('.settings-navigation');return nav.getBoundingClientRect().top-body.getBoundingClientRect().top;})()`);
    assert.ok(settingsTop<=1, '设置分类与顶部没有额外空白');
    await delay(210);
    await screenshot('常规设置.png');
    const hoverPoint = await win.webContents.executeJavaScript(`(() => {const r=document.querySelectorAll('.settings-navigation button')[1].getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
    win.webContents.sendInputEvent({ type: 'mouseMove', ...hoverPoint });
    await delay(180);
    const hoverStyle = await win.webContents.executeJavaScript(`(() => {const node=document.querySelectorAll('.settings-navigation button')[1],style=getComputedStyle(node),pill=getComputedStyle(node,'::before');return {hover:node.matches(':hover'),background:style.backgroundColor,radius:pill.borderRadius,opacity:Number(pill.opacity)};})()`);
    assert.equal(hoverStyle.hover,true,'真实指针悬停命中设置分类');
    assert.equal(hoverStyle.background,'rgba(0, 0, 0, 0)','不再绘制整块矩形背景');
    assert.equal(hoverStyle.radius,'999px'); assert.ok(hoverStyle.opacity>0.5);
    await screenshot('设置分类-胶囊悬停.png');
    win.webContents.sendInputEvent({type:'mouseMove',x:1,y:1});
    await win.webContents.executeJavaScript(`(() => {const section=document.querySelector('[data-settings-section="general"]'); section.querySelector('[name="autoExplainCapture"]').checked=true;section.querySelector('[name="pinSound"]').checked=false;section.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));})()`);
    await waitForCall('save-settings', item => item.payload.prefs?.autoExplainCapture === true);
    await win.webContents.executeJavaScript(`document.querySelectorAll('.settings-navigation button')[3].click()`);
    await waitFor(`document.querySelector('[data-settings-section="shortcuts"]')?.hidden===false`, '快捷键设置');
    const shortcutsLayout = await win.webContents.executeJavaScript(`(() => {
      const page=document.querySelector('.shortcuts-page'), actions=page.querySelector('.shortcut-actions');
      const buttons=[...actions.children].map(node=>node.getBoundingClientRect());
      return {overflow:page.scrollWidth>page.clientWidth+1, heights:buttons.map(box=>box.height), sameLine:buttons.every(box=>Math.abs(box.top-buttons[0].top)<1), rows:[...page.querySelectorAll('.shortcut-row')].map(node=>node.getBoundingClientRect().height)};
    })()`);
    assert.equal(shortcutsLayout.overflow, false);
    assert.ok(shortcutsLayout.heights.every(height=>height<=30), '底部按钮紧凑');
    assert.equal(shortcutsLayout.sameLine, true, '底部操作放在同一行');
    if (viewportWidth<=350) assert.ok(shortcutsLayout.rows.every(height=>height<=54), '小窗功能行收紧');
    await win.webContents.executeJavaScript(`document.querySelectorAll('.settings-navigation button')[2].click()`);
    await waitFor(`document.querySelector('[data-settings-section="appearance"]').hidden===false`, '外观页');
    const appearanceAlignment = await win.webContents.executeJavaScript(`(() => {const group=document.querySelector('.appearance-mode-heading'),title=group.querySelector('h3'),state=group.querySelector('span');const a=title.getBoundingClientRect(),b=state.getBoundingClientRect();return {top:a.top,other:b.top,font:parseFloat(getComputedStyle(state).fontSize),animations:document.querySelector('[data-settings-section="appearance"]').getAnimations().length,indicator:document.querySelector('.settings-navigation .mode-indicator').getAnimations().length};})()`);
    assert.ok(Math.abs(appearanceAlignment.top-appearanceAlignment.other)<=4, '明暗模式和默认配色在同一行');
    assert.equal(appearanceAlignment.font,12);
    assert.ok(appearanceAlignment.animations>0 && appearanceAlignment.indicator>0, '设置内容与横条都在切换');
    await delay(220);
    await win.webContents.executeJavaScript(`document.querySelector('[data-scroll="body"]').scrollTop=0`);
    await screenshot('外观-对齐与顶部.png');
    await win.webContents.executeJavaScript(`document.querySelectorAll('.settings-navigation button')[0].click();document.querySelectorAll('.settings-navigation button')[3].click()`);
    await waitFor(`document.querySelector('[data-settings-section="shortcuts"]').hidden===false`, '快速切回快捷键');
    await delay(220);
    await win.webContents.executeJavaScript(`document.querySelector('[data-scroll="body"]').scrollTop=0`);
    await screenshot('快捷键-紧凑布局.png');
    await win.webContents.executeJavaScript(`document.querySelector('.shortcut-actions .secondary').click();document.querySelector('.shortcut-actions .primary').click()`);
    await waitForCall('save-settings', item => Boolean(item.payload.prefs?.shortcuts));
    assert.equal(current.settings.prefs.pinSound, false, '保存快捷键不会覆盖常规提示音设置');
    current.status.reducedMotion = true; await pushState();
    await win.webContents.executeJavaScript(`document.querySelectorAll('.settings-navigation button')[0].click()`);
    await waitFor(`document.querySelector('[data-settings-section="general"]').hidden===false`, '减少动态效果设置切换');
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.settings-navigation .mode-indicator').getAnimations().length+document.querySelector('[data-settings-section="general"]').getAnimations().length`),0,'减少动态效果时不播放横条或内容动画');
    current.status.reducedMotion = false; await pushState();
    await win.webContents.executeJavaScript(`document.querySelectorAll('.settings-navigation button')[3].click()`);
    await waitFor(`document.querySelector('[data-settings-section="shortcuts"]').hidden===false`, '回到快捷键底部');
    await delay(220);

    await win.webContents.executeJavaScript(`document.querySelector('[data-scroll="body"]').scrollTop=document.querySelector('[data-scroll="body"]').scrollHeight`);
    await screenshot('快捷键-底部操作.png');
    await win.webContents.executeJavaScript(`document.querySelectorAll('.settings-navigation button')[1].click()`);
    await waitFor(`document.querySelector('[data-settings-section="service"]')?.hidden===false`, '回到AI服务');
    await win.webContents.executeJavaScript(`document.querySelector('[name="text-apiKey"]').scrollIntoView({block:'center',container:'nearest'})`);
    await screenshot('AI服务-密钥说明.png');
    const settingsScroll = await win.webContents.executeJavaScript(`(() => {
      const body=document.querySelector('[data-scroll="body"]'), save=document.querySelector('[data-settings-section="service"] button[type="submit"]');
      body.scrollTop=body.scrollHeight;
      const bodyRect=body.getBoundingClientRect(), saveRect=save.getBoundingClientRect();
      return {scrollable:body.scrollHeight>body.clientHeight,scrollTop:body.scrollTop,saveVisible:saveRect.bottom<=bodyRect.bottom+1&&saveRect.top>=bodyRect.top-1};
    })()`);
    assert.equal(settingsScroll.scrollable, true, '服务设置超过视口时应可滚动');
    assert.ok(settingsScroll.scrollTop > 0, '设置页滚轮可改变滚动位置');
    assert.equal(settingsScroll.saveVisible, true, '滚到设置底部后能够看到保存按钮');
    await screenshot('AI服务-设置底部.png');
    await win.webContents.executeJavaScript(`document.querySelector('[data-scroll="body"]').scrollTop=0`);

    await win.webContents.executeJavaScript(`(() => {
      const select=document.querySelector('[name="text-provider"]'); select.value='deepseek'; select.dispatchEvent(new Event('change',{bubbles:true}));
      window.testStoredKey={value:document.querySelector('[name="text-apiKey"]').value,placeholder:document.querySelector('[name="text-apiKey"]').placeholder};
      document.querySelector('[name="text-apiKey"]').value='虚构的DeepSeekKey';
    })()`);
    const storedKey = await win.webContents.executeJavaScript('window.testStoredKey');
    assert.equal(storedKey.value, '', '公开 hasKey 只控制提示，不会被当作明文密钥');
    assert.match(storedKey.placeholder, /已配置/);
    current.status.selection = '虚构状态更新';
    await pushState();
    const pushedTextProfile = await win.webContents.executeJavaScript(`(() => ({
      provider:document.querySelector('[name="text-provider"]').value,
      baseUrl:document.querySelector('[name="text-baseUrl"]').value,
      model:document.querySelector('[name="text-model"]').value,
      key:document.querySelector('[name="text-apiKey"]').value,
      placeholder:document.querySelector('[name="text-apiKey"]').placeholder,
      keyLinkHidden:document.querySelector('[data-key-link="text"]').hidden,
    }))()`);
    assert.deepEqual(pushedTextProfile, {
      provider: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', key: '虚构的DeepSeekKey',
      placeholder: '已配置，留空保留原 Key', keyLinkHidden: false,
    }, '公开状态重绘须保留所选厂商的密钥入口元数据及未保存字段草稿');
    await win.webContents.executeJavaScript(`document.querySelector('[data-key-link="text"]').click()`);
    for (let index = 0; index < 180 && openedLinks.length < 2; index++) await delay(10);
    assert.equal(openedLinks.at(-1), 'https://platform.deepseek.com/api_keys', '重绘后的官方密钥入口仍指向当前未保存厂商');
    await win.webContents.executeJavaScript(`(() => {
      const select=document.querySelector('[name="text-provider"]');
      select.value='mimo'; select.dispatchEvent(new Event('change',{bubbles:true}));
      const mimoUrl=document.querySelector('[name="text-baseUrl"]').value;
      select.value='deepseek'; select.dispatchEvent(new Event('change',{bubbles:true}));
      window.testProviderDraft={mimoUrl,key:document.querySelector('[name="text-apiKey"]').value,model:document.querySelector('[name="text-model"]').value};
    })()`);
    const modelDraft = await win.webContents.executeJavaScript('window.testProviderDraft');
    assert.equal(modelDraft.mimoUrl, 'https://api.xiaomimimo.com/v1');
    assert.equal(modelDraft.key, '虚构的DeepSeekKey', '厂商切换后恢复该厂商的输入草稿');
    assert.equal(modelDraft.model, 'deepseek-flash');

    await win.webContents.executeJavaScript(`(() => {
      document.querySelector('[data-kind="search"]').click();
      const select=document.querySelector('[name="search-provider"]');
      select.value='brave'; select.dispatchEvent(new Event('change',{bubbles:true}));
      window.testSearchDraft={provider:select.value,url:document.querySelector('[name="search-baseUrl"]').value,keyPlaceholder:document.querySelector('[name="search-apiKey"]').placeholder,keyValue:document.querySelector('[name="search-apiKey"]').value};
      document.querySelector('[data-key-link="search"]').click();
    })()`);
    const searchDraft = await win.webContents.executeJavaScript('window.testSearchDraft');
    assert.equal(searchDraft.provider, 'brave');
    assert.equal(searchDraft.url, 'https://saved.brave.invalid', '切换搜索服务会恢复该厂商保存的地址');
    assert.match(searchDraft.keyPlaceholder, /已配置/);
    assert.equal(searchDraft.keyValue, '', '搜索配置的 hasKey 也不能暴露为明文密钥');
    await waitFor(`Boolean(document.querySelector('[name="search-provider"]'))`, '搜索服务设置');
    await screenshot('AI服务-搜索设置.png');
    for (let index = 0; index < 180 && openedLinks.length < 2; index++) await delay(10);
    assert.deepEqual(openedLinks.at(-1), 'https://api.search.brave.com/app/keys', '官方 API Key 入口使用 open-link');

    await win.webContents.executeJavaScript(`(() => { const button=[...document.querySelectorAll('[data-provider="search"] button')].find(node=>node.textContent==='测试搜索服务'); button.click(); })()`);
    await waitFor(`document.querySelector('[data-provider="search"] .test-result')?.textContent.includes('虚构搜索服务连接成功')`, '搜索服务测试反馈');
    const searchTest = calls.find(item => item.action === 'test-search-provider');
    assert.deepEqual(searchTest?.payload, { config: { providerId: 'brave', baseUrl: 'https://saved.brave.invalid' } });
    await win.webContents.executeJavaScript(`(() => {
      const select=document.querySelector('[name="search-provider"]');select.value='custom';select.dispatchEvent(new Event('change',{bubbles:true}));
      document.querySelector('[name="search-protocol"]').value='deepseek';
      document.querySelector('[name="search-baseUrl"]').value='https://custom-search.mock.invalid/query';
      document.querySelector('[name="search-apiKey"]').value='虚构自定义搜索Key';
      select.value='exa';select.dispatchEvent(new Event('change',{bubbles:true}));
      select.value='custom';select.dispatchEvent(new Event('change',{bubbles:true}));
    })()`);
    const customDraft = await win.webContents.executeJavaScript(`({protocol:document.querySelector('[name="search-protocol"]').value,url:document.querySelector('[name="search-baseUrl"]').value,key:document.querySelector('[name="search-apiKey"]').value,visible:!document.querySelector('.search-protocol-select').hidden,keyLinkHidden:document.querySelector('[data-key-link="search"]').hidden})`);
    assert.deepEqual(customDraft,{protocol:'deepseek',url:'https://custom-search.mock.invalid/query',key:'虚构自定义搜索Key',visible:true,keyLinkHidden:true});
    await pushState();
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[name="search-protocol"]').value`),'deepseek','状态重绘保留未保存的协议选择');
    await win.webContents.executeJavaScript(`([...document.querySelectorAll('[data-provider="search"] button')].find(node=>node.textContent==='测试搜索服务')).click()`);
    await waitForCall('test-search-provider',item=>item.payload.config.providerId==='custom');
    assert.deepEqual(calls.find(item=>item.action==='test-search-provider'&&item.payload.config.providerId==='custom').payload.config,{providerId:'custom',protocol:'deepseek',baseUrl:'https://custom-search.mock.invalid/query',apiKey:'虚构自定义搜索Key'});
    await delay(220);
    await screenshot('搜索服务-自定义提供商.png');



    // 表单提交通过虚构 IPC 保存，不访问用户配置文件。
    await win.webContents.executeJavaScript(`document.querySelector('[data-settings-section="service"] form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))`);
    const saved = await waitForCall('save-settings', item => Boolean(item.payload.text));
    assert.equal(saved.payload.text.providerId, 'deepseek');
    assert.equal(saved.payload.text.apiKey, '虚构的DeepSeekKey');
    assert.equal(saved.payload.serviceProfiles.text.deepseek.apiKey, '虚构的DeepSeekKey');
    assert.equal(saved.payload.search.providerId, 'custom');
    assert.equal(saved.payload.search.protocol,'deepseek');
    assert.equal(saved.payload.serviceProfiles.search.custom.protocol,'deepseek');
    assert.equal(saved.payload.prefs, undefined, 'AI 服务保存不覆盖常规偏好');

    current.view = 'preview';
    current.session = { id: '虚构截图会话', kind: 'image', imageData, note: '', activeMode: 'visual', webSearchEnabled: false,
      threads: { visual: { status: 'idle', draft: '', messages: [] } } };
    await pushState();
    await waitFor(`Boolean(document.querySelector('[data-field="image-note"]'))`, '截图确认页');
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.recognition-preview .web-search-toggle').getAttribute('aria-pressed')`), 'false', '截图预览首次发送前默认关闭联网');
    await screenshot('AI服务-截图预览.png');
    await win.webContents.executeJavaScript(`document.querySelector('.recognition-preview .web-search-toggle').click()`);
    await waitFor(`document.querySelector('.recognition-preview .web-search-toggle')?.getAttribute('aria-pressed')==='true'`, '截图联网设置');
    await win.webContents.executeJavaScript(`document.querySelector('.recognition-preview button.primary').click()`);
    await waitForCall('start-explanation');
    assert.deepEqual(calls.find(item => item.action === 'set-web-search' && item.payload.id === '虚构截图会话')?.payload, { id: '虚构截图会话', mode: 'visual', enabled: true });
    assert.ok(calls.some(item => item.action === 'start-explanation' && item.payload.id === '虚构截图会话' && item.payload.mode === 'visual'));
    assert.deepEqual(remoteRequests, [], '隔离交互全程没有发出网络请求');
    assert.deepEqual(consoleErrors, [], '界面无渲染器脚本或样式加载错误');
    console.log(`AI 服务 renderer 隔离交互通过（请求视口 ${viewportWidth}×${viewportHeight}）；截图证据：${outputRoot}`);
    clearTimeout(watchdog); win.destroy(); app.exit(0);
  } catch (error) {
    console.error(error.stack);
    clearTimeout(watchdog); win?.destroy(); app.exit(1);
  }
});
