'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createStore } = require('../../src/core/store.cjs');
const IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC1kAAAAASUVORK5CYII=';

async function application() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pickgloss-requested-actions-'));
  const failures = new Set(), uncertain = new Set(), trashed = [], loginCalls = [], requests = [], captures = [], translationHeightCalls = [], translationPins = [];
  const store = createStore({ directory, encrypt: value => Buffer.from(value), decrypt: value => value.toString(), trash: async target => {
    const id = path.basename(target); if (failures.has(id)) throw Error('模拟回收失败');
    const destination = path.join(directory, '回收保留-' + id); await fs.rename(target, destination); trashed.push(destination);
    if (uncertain.has(id)) throw Error('模拟回收接口在目录已移动后报错');
  } });
  await store.init();
  let loginFailure = false, respond, loginEnabled = false;
  const app = { isPackaged: true, setPath() {}, getPath: () => directory, setName() {}, setAppUserModelId() {}, requestSingleInstanceLock: () => true,
    on() {}, whenReady: () => new Promise(() => {}),
    getLoginItemSettings: () => ({ openAtLogin: loginEnabled, executableWillLaunchAtLogin: loginEnabled }),
    setLoginItemSettings(value) { if (loginFailure) throw Error('模拟登录项失败'); loginEnabled = value.openAtLogin; loginCalls.push(value); } };
  const placement = { region: { x: 30, y: 40, width: 20, height: 20 }, displayBounds: { x: 0, y: 0, width: 800, height: 600 } };
  const desktop = { broadcast() {}, captureState: () => null, finishCapture: () => IMAGE, finishCaptureWithPlacement: () => ({ imageData: IMAGE, placement: structuredClone(placement) }),
    showTranslation: () => ({ bounds: { x: 30, y: 40, width: 420, height: 246 }, image: { left: 0, top: 0, width: 20, height: 20 }, controls: { left: 0, top: 26, width: 420, height: 220 } }),
    resizeTranslationHeight: (...args) => { translationHeightCalls.push(args); return { height: Math.min(480, args[1]) }; },
    setTranslationControlsPinned: value => translationPins.push(value),
    hideTranslation() {}, openPanel() {}, setOrb() {}, setOrbPreferences() {}, hoverOrb() {}, startSelection() {}, setAppearance() {}, async beginCapture(options) { captures.push(options); } };
  const electron = { app, clipboard: { writeText() {} }, net: { fetch: async (url, options) => {
    const request = { url, options }; requests.push(request);
    if (respond) return respond(request);
    if (options.method === 'GET') return Response.json({ data: [{ id: '当前密钥可用的模型' }] });
    return Response.json({ choices: [{ message: { content: JSON.stringify({ translations: [{ id: 0, translation: '译文' }] }) } }] });
  } } };
  const target = path.join(__dirname, '../../src/main.cjs');
  let recognition = async () => ({ blocks: [{ text: '原文', x: 0, y: 0, width: 1, height: 1 }] });
  const context = { require: name => name === 'electron' ? electron : name === './windows/ocr.cjs' ? { recognizeWindows: (...args) => recognition(...args) } : name.startsWith('./') ? require(path.join(path.dirname(target), name)) : require(name),
    process: { argv: [], env: {}, pid: 1, execPath: 'E:\\测试应用\\PickGloss.exe' }, URL, AbortController, structuredClone, setTimeout, clearTimeout,
    fixture: { store, desktop, settings: await store.getSettings() } };
  vm.createContext(context);
  vm.runInContext(await fs.readFile(target, 'utf8') + '\nstore=fixture.store;desktop=fixture.desktop;settings=fixture.settings;globalThis.testApp={handle,state,drain:async()=>{await translationJob?.promise;await Promise.all([...jobs.values()].map(job=>job.promise));}};', context);
  return { ...context.testApp, store, failures, uncertain, trashed, loginCalls, requests, captures, translationHeightCalls, translationPins,
    loginFailure: value => { loginFailure = value; }, recognize: value => { recognition = value; }, respond: value => { respond = value; } };
}

test('通用截图入口继承常规默认模式，明确指定模式的入口优先且不改默认值', async () => {
  const app = await application(); await app.handle('start-capture');
  assert.equal(app.captures.at(-1).mode, 'explain');
  await app.handle('save-settings', { prefs: { captureDefaultMode: 'translate' } });
  await app.handle('start-capture'); assert.equal(app.captures.at(-1).mode, 'translate');
  await app.handle('start-capture', { mode: 'explain' }); assert.equal(app.captures.at(-1).mode, 'explain');
  assert.equal((await app.state()).settings.prefs.captureDefaultMode, 'translate');
  await assert.rejects(app.handle('start-capture', { mode: 'invalid' }), /截图模式无效/);
});

test('立即识别模式在框选完成后自动识图，旧自动解释字段不控制新行为', async () => {
  const app = await application();
  await app.handle('save-settings', { vision: { baseUrl: 'https://vision.invalid/v1', model: '虚构识图模型' }, prefs: { autoExplainCapture: false, captureExplainMode: 'immediate' } });
  await app.handle('capture-done', { mode: 'explain', rect: {} });
  await app.drain();
  const current = await app.state();
  assert.equal(current.view, 'explain'); assert.equal(current.session.kind, 'image');
  assert.equal(current.session.activeMode, 'visual');
  const body = JSON.parse(app.requests.at(-1).options.body);
  assert.equal(body.model, '虚构识图模型');
  assert.ok(body.messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url')));
});

test('先补充提示词模式保留截图预览且不发请求，手动开始后将说明带入模型请求', async () => {
  const app = await application();
  await app.handle('save-settings', { vision: { baseUrl: 'https://vision.invalid/v1', model: '虚构识图模型' }, prefs: { captureExplainMode: 'prompt' } });
  await app.handle('capture-done', { mode: 'explain', rect: {} });
  assert.equal(app.requests.length, 0);
  const preview = await app.state();
  assert.equal(preview.view, 'preview'); assert.equal(preview.session.kind, 'image');
  await app.handle('set-note', { id: preview.session.id, note: '请辨认图中的产品名称并说明它的功能。' });
  await app.handle('start-explanation', { id: preview.session.id, mode: 'visual' }); await app.drain();
  assert.equal(app.requests.length, 1);
  const body = JSON.parse(app.requests[0].options.body);
  assert.ok(body.messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'text' && part.text.includes('请辨认图中的产品名称并说明它的功能。'))));
  assert.ok(body.messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url')));
});

test('识图提示词模式不影响独立的截图翻译流程', async () => {
  const app = await application();
  await app.handle('save-settings', { text: { baseUrl: 'https://text.invalid/v1', model: '虚构翻译模型' }, prefs: { captureExplainMode: 'prompt' } });
  await app.handle('capture-done', { mode: 'translate', rect: {} }); await app.drain();
  assert.equal(app.requests.length, 1);
  assert.equal((await app.state()).translation.status, 'complete');
});

test('语言选择立即成为下次截图的默认值，切换显示不会把语言改回上次译文所用语言', async () => {
  const app = await application();
  await app.handle('save-settings', { text: { baseUrl: 'https://text.invalid/v1', model: '虚构模型' } });
  await app.handle('capture-done', { mode: 'translate', rect: {} }); await app.drain();
  let result = (await app.state()).translation;
  for (const targetLanguage of ['ja', 'zh-Hans']) {
    const previousLanguage = result.options.targetLanguage;
    await app.handle('set-translation-preferences', { options: { sourceLanguage: 'en', targetLanguage } });
    assert.equal((await app.store.getSettings()).prefs.screenshotTranslation.targetLanguage, targetLanguage, '未开始重新翻译时就保存当前选择');
    assert.equal((await app.state()).translation.options.targetLanguage, previousLanguage, '已有译文仍记录实际翻译所用语言');
    await app.handle('set-translation-options', { id: result.id, options: { displayMode: 'compare' } });
    assert.equal((await app.state()).settings.prefs.screenshotTranslation.targetLanguage, targetLanguage, '对照切换不覆盖新的语言选择');
    await app.handle('start-capture', { mode: 'translate' });
    await app.handle('capture-done', { mode: 'translate', rect: {} }); await app.drain();
    result = (await app.state()).translation;
    assert.equal(result.options.targetLanguage, targetLanguage, '未显式传语言时仍使用最新选择');
    assert.equal(result.options.sourceLanguage, 'en');
    assert.match(JSON.parse(app.requests.at(-1).options.body).messages[0].content, targetLanguage === 'ja' ? /日语/ : /简体中文/);
  }
  await app.handle('start-capture', { mode: 'translate', options: { sourceLanguage: 'en', targetLanguage: 'ja' } });
  assert.equal((await app.state()).settings.prefs.screenshotTranslation.targetLanguage, 'ja', '重新框选直接携带当前语言，不能退回之前保存的值');
  await assert.rejects(app.handle('set-translation-preferences', { options: { targetLanguage: '无效语言' } }), /目标语言无效/);
});

test('查看原图只作用于本次显示，重新翻译和新截图默认显示译文', async () => {
  const app = await application();
  await app.handle('save-settings', { text: { baseUrl: 'https://text.invalid/v1', model: '虚构模型' } });
  await app.handle('capture-done', { mode: 'translate', rect: {} }); await app.drain();
  let result = (await app.state()).translation;
  await app.handle('set-translation-options', { id: result.id, options: { showOriginal: true } });
  assert.equal((await app.state()).translation.options.showOriginal, true);
  assert.equal((await app.store.getSettings()).prefs.screenshotTranslation.showOriginal, false, '临时查看原图不能成为下次截图的默认值');
  await app.handle('retry-translation', { id: result.id, options: { ...result.options, showOriginal: true } }); await app.drain();
  result = (await app.state()).translation;
  assert.equal(result.options.showOriginal, false, '重新翻译后恢复显示译文');
});

test('按住原图预览只修改本次显示，对照模式拒绝冗余原图状态且不写入偏好', async () => {
  const app = await application();
  await app.handle('save-settings', { text: { baseUrl: 'https://text.invalid/v1', model: '虚构模型' } });
  await app.handle('capture-done', { mode: 'translate', rect: {} }); await app.drain();
  const item = (await app.state()).translation, saved = app.store.saveSettings;
  let writes = 0; app.store.saveSettings = (...args) => { writes++; return saved(...args); };
  await app.handle('preview-translation-original', { id: item.id, visible: true });
  assert.equal((await app.state()).translation.options.showOriginal, true);
  await app.handle('preview-translation-original', { id: item.id, visible: false });
  assert.equal((await app.state()).translation.options.showOriginal, false);
  assert.equal(writes, 0, '临时按住原图不触发设置落盘');
  await app.handle('set-translation-options', { id: item.id, options: { displayMode: 'compare', showOriginal: true } });
  await app.handle('preview-translation-original', { id: item.id, visible: true });
  assert.equal((await app.state()).translation.options.showOriginal, false, '对照已经显示原图，不进入第三种叠加状态');
  assert.equal((await app.store.getSettings()).prefs.screenshotTranslation.showOriginal, false);
  await assert.rejects(app.handle('preview-translation-original', { id: item.id, visible: 'yes' }), /预览状态无效/);
});

test('设置自动保存按字段更新并留在当前设置页，返回确认配置而不回到内容页', async () => {
  const app = await application();
  await app.handle('open-settings', { section: 'general' });
  const saved = await app.handle('save-settings', { autosave: true, prefs: { showOrb: false } });
  assert.equal(saved.prefs.showOrb, false); assert.equal((await app.state()).view, 'settings');
  assert.equal((await app.state()).settingsSection, 'general');
  await app.handle('save-settings', { autosave: true, prefs: { screenshotTranslation: { searchEnabled: false } } });
  assert.equal((await app.state()).settings.prefs.showOrb, false);
  assert.equal((await app.store.getSettings()).prefs.screenshotTranslation.searchEnabled, false);
  await assert.rejects(app.handle('save-settings', { autosave: 'yes', prefs: { showOrb: true } }), /自动保存状态无效/);
  assert.equal((await app.store.getSettings()).prefs.showOrb, false);
});

test('菜单切换翻译深度立即重译并保存，下次框选继承且常规请求明确关闭思考', async () => {
  const app = await application();
  await app.handle('save-settings', { text: { baseUrl: 'https://api.xiaomimimo.com/v1', model: 'mimo-v2.6-flash' },
    prefs: { screenshotTranslation: { translationMode: 'deep', searchEnabled: false, searchScope: 'deep', targetLanguage: 'ja' } } });
  await app.handle('capture-done', { mode: 'translate', rect: {} }); await app.drain();
  let item = (await app.state()).translation;
  assert.equal(item.status, 'complete'); assert.equal(item.options.translationMode, 'deep');
  assert.equal(item.options.searchEnabled, false); assert.equal(item.options.searchScope, 'deep'); assert.equal(item.search.status, 'disabled');
  assert.equal(JSON.parse(app.requests.at(-1).options.body).thinking.type, 'enabled');
  await app.handle('retry-translation', { id: item.id, options: { ...item.options, translationMode: 'standard' } }); await app.drain();
  item = (await app.state()).translation;
  assert.equal(item.options.translationMode, 'standard'); assert.equal(item.thinking.status, 'disabled');
  assert.equal(JSON.parse(app.requests.at(-1).options.body).thinking.type, 'disabled');
  await app.handle('set-translation-preferences', { options: { translationMode: 'deep', searchEnabled: true, searchScope: 'standard' } });
  await app.handle('set-translation-options', { id: item.id, options: { displayMode: 'compare' } });
  const prefs = (await app.store.getSettings()).prefs.screenshotTranslation;
  assert.equal(prefs.translationMode, 'deep'); assert.equal(prefs.searchEnabled, true); assert.equal(prefs.searchScope, 'standard'); assert.equal(prefs.targetLanguage, 'ja');
  await assert.rejects(app.handle('set-translation-options', { id: item.id, options: { translationMode: 'deep' } }), /重新翻译/);
  await app.handle('start-capture', { mode: 'translate' });
  await app.handle('capture-done', { mode: 'translate', rect: {} }); await app.drain();
  assert.equal((await app.state()).translation.options.translationMode, 'deep');
  assert.equal(JSON.parse(app.requests.at(-1).options.body).thinking.type, 'enabled');
  await assert.rejects(app.handle('set-translation-preferences', { options: { recognitionMode: 'vision' } }), /截图翻译设置无效/);
  assert.equal(app.requests.length, 3, '关闭深度联网时不生成查询或调用搜索');
});

test('联网中切回常规会取消旧深度任务，迟到来源不能恢复旧译文或继续生成', async () => {
  const app = await application();
  await app.handle('save-settings', { text: { baseUrl: 'https://api.xiaomimimo.com/v1', model: 'mimo-v2.6-flash' },
    search: { providerId: 'exa', baseUrl: 'https://search.invalid/search', apiKey: '虚构搜索密钥' },
    prefs: { screenshotTranslation: { translationMode: 'deep', searchEnabled: true, searchScope: 'deep' } } });
  let finishSearch, finalCalls = 0;
  app.respond(request => {
    if (request.url === 'https://search.invalid/search') return new Promise(resolve => { finishSearch = resolve; });
    const body = JSON.parse(request.options.body), final = body.messages[0].content.includes('"translations"');
    if (final) finalCalls++;
    return Response.json({ choices: [{ message: { content: final ? JSON.stringify({ translations: [{ id: 0, translation: '常规译文' }] }) : JSON.stringify({ query: 'Quark 中文译名' }) } }] });
  });
  await app.handle('capture-done', { mode: 'translate', rect: {} });
  const deadline = Date.now() + 3000;
  while (!finishSearch && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1));
  assert.ok(finishSearch, (await app.state()).translation.error || '深度翻译应到达联网阶段');
  const old = (await app.state()).translation;
  assert.equal(old.status, 'searching'); assert.equal(old.search.status, 'searching');
  await app.handle('retry-translation', { id: old.id, options: { ...old.options, translationMode: 'standard' } }); await app.drain();
  const current = (await app.state()).translation;
  assert.equal(current.status, 'complete'); assert.equal(current.options.translationMode, 'standard');
  assert.notEqual(current.id, old.id); assert.equal(current.search.status, 'disabled');
  finishSearch(Response.json({ results: [{ title: '旧请求来源', url: 'https://example.invalid/old', highlights: ['旧来源摘录'] }] }));
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal((await app.state()).translation.id, current.id); assert.equal(finalCalls, 1);
  assert.equal((await app.state()).translation.blocks[0].translation, '常规译文');
  await app.handle('close-translation', { id: current.id });
  assert.equal((await app.state()).translation, null);
});

test('深度联网失败保留实际模式与错误，不伪装为已联网完成或静默改为常规', async () => {
  const app = await application();
  await app.handle('save-settings', { text: { baseUrl: 'https://api.xiaomimimo.com/v1', model: 'mimo-v2.6-flash' },
    search: { providerId: 'exa', baseUrl: 'https://search.invalid/search', apiKey: '虚构搜索密钥' },
    prefs: { screenshotTranslation: { translationMode: 'deep', searchEnabled: true, searchScope: 'deep' } } });
  app.respond(request => request.url === 'https://search.invalid/search'
    ? new Response('', { status: 503 })
    : Response.json({ choices: [{ message: { content: JSON.stringify({ query: 'Quark 中文译名' }) } }] }));
  await app.handle('capture-done', { mode: 'translate', rect: {} }); await app.drain();
  const current = (await app.state()).translation;
  assert.equal(current.status, 'failed'); assert.equal(current.options.translationMode, 'deep');
  assert.match(current.error, /搜索.*失败/); assert.notEqual(current.search.status, 'complete');
  assert.equal(current.blocks.length, 0); assert.equal(app.requests.length, 2);
  assert.equal((await app.store.getSettings()).prefs.screenshotTranslation.translationMode, 'deep');
});

test('手动识图重试跳过本地识别，请求期间及失败后都保留实际识别模式', async () => {
  const app = await application();
  await app.handle('save-settings', { text: { baseUrl: 'https://text.invalid/v1', model: '虚构模型' } });
  let recognitions = 0;
  app.recognize(async () => { recognitions++; return { blocks: [{ text: 'Quark', x: 0, y: 0, width: 1, height: 1 }] }; });
  await app.handle('capture-done', { mode: 'translate', rect: {} }); await app.drain();
  const previous = (await app.state()).translation;
  let failRequest;
  app.respond(() => new Promise((_resolve, reject) => { failRequest = reject; }));
  await app.handle('retry-translation', { id: previous.id, recognitionMode: 'vision' });
  while (!failRequest) await new Promise(resolve => setTimeout(resolve, 1));
  const pending = { ...(await app.state()).translation };
  failRequest(Error('模拟识图网络失败')); await app.drain();
  assert.equal(pending.status, 'translating');
  assert.equal(pending.method, 'vision', '开始远端请求前应已切换状态');
  assert.equal(pending.fallbackReason, 'manual');
  assert.equal(recognitions, 1, '手动识图重试不能再次调用本地 OCR');
  const failed = (await app.state()).translation;
  assert.equal(failed.status, 'failed'); assert.equal(failed.method, 'vision');
  assert.equal(failed.fallbackReason, 'manual');
  assert.equal((await app.store.getSettings()).prefs.screenshotTranslation.recognitionMode, undefined, '本次识图重试不能改变后续默认模式');
  await assert.rejects(app.handle('retry-translation', { id: failed.id, recognitionMode: '未知模式' }), /识别模式无效/);
  assert.equal((await app.state()).translation.id, failed.id, '非法模式不能替换本次翻译');
});

test('OCR 缺少语言切换识图后，等待请求时即可读到切换原因', async () => {
  const app = await application();
  await app.handle('save-settings', { text: { baseUrl: 'https://text.invalid/v1', model: '虚构模型' } });
  app.recognize(async () => { throw Object.assign(Error('模拟缺少语言包'), { code: 'OCR_LANGUAGE_UNAVAILABLE' }); });
  let completeRequest;
  app.respond(() => new Promise(resolve => { completeRequest = resolve; }));
  await app.handle('capture-done', { mode: 'translate', rect: {} });
  while (!completeRequest) await new Promise(resolve => setTimeout(resolve, 1));
  const pending = { ...(await app.state()).translation };
  completeRequest(Response.json({ choices: [{ message: { content: JSON.stringify({ sourceText: 'Quark', translation: '夸克' }) } }] }));
  await app.drain();
  assert.equal(pending.method, 'vision'); assert.equal(pending.fallbackReason, 'language');
  assert.equal((await app.state()).translation.fallbackReason, 'language');
});

test('显式重新打开会话历史产生新的进入标识，刷新和筛选不产生', async () => {
  const app = await application();
  await app.handle('open-history'); const first = (await app.state()).historyOpenId;
  await app.handle('refresh-history'); await app.handle('search-history', { query: '虚构' });
  assert.equal((await app.state()).historyOpenId, first);
  await app.handle('open-history'); const second = (await app.state()).historyOpenId;
  assert.notEqual(second, first, '历史页面已打开时从菜单再次进入也应结束旧的多选状态');
  await app.handle('navigate', { view: 'history' });
  assert.notEqual((await app.state()).historyOpenId, second);
});

test('翻译模型获取使用自己的草稿密钥，空模型的连接测试整套沿用当前文字草稿', async () => {
  const app = await application();
  await app.handle('save-settings', { text: { baseUrl: 'https://text.invalid/v1', model: '文字模型', apiKey: '虚构文字密钥' }, translation: { baseUrl: 'https://translate.invalid/v1', model: '', apiKey: '虚构翻译密钥' } });
  await app.handle('fetch-models', { kind: 'translation', config: { baseUrl: 'https://translate.invalid/v1', model: '' } });
  assert.equal(app.requests[0].options.headers.Authorization, 'Bearer 虚构翻译密钥');
  await assert.rejects(app.handle('fetch-models', { kind: 'translation', config: { baseUrl: 'https://other.invalid/v1' } }), /重新输入密钥/);
  const result = await app.handle('test-provider', { kind: 'translation', config: { model: '' }, fallbackConfig: { baseUrl: 'https://text.invalid/v1', model: '未保存的文字模型' } });
  assert.match(result.message, /文字模型完成翻译测试/);
  assert.equal(app.requests[1].url, 'https://text.invalid/v1/chat/completions');
  assert.equal(app.requests[1].options.headers.Authorization, 'Bearer 虚构文字密钥');
  assert.equal(JSON.parse(app.requests[1].options.body).model, '未保存的文字模型');
  assert.match(JSON.parse(app.requests[1].options.body).messages[0].content, /TXT/);
  await app.handle('save-settings', { translation: { model: '独立翻译模型' } });
  await app.handle('capture-done', { rect: {}, mode: 'translate' }); await app.drain();
  assert.equal(app.requests.at(-1).url, 'https://translate.invalid/v1/chat/completions');
  assert.equal(app.requests.at(-1).options.headers.Authorization, 'Bearer 虚构翻译密钥');
});

test('批量回收先校验所有标识，部分失败只移走成功项并保留收藏和原数据', async () => {
  const app = await application();
  const first = await app.store.createSession({ text: '成功项', saved: true });
  const second = await app.store.createSession({ text: '失败项', saved: true });
  app.failures.add(second.id);
  await assert.rejects(app.handle('delete-sessions', { ids: [first.id, '../无效路径'] }));
  assert.equal(app.trashed.length, 0);
  const result = await app.handle('delete-sessions', { ids: [first.id, first.id, second.id] });
  assert.deepEqual([...result.deletedIds], [first.id]); assert.equal(result.failed[0].id, second.id);
  assert.equal(app.trashed.length, 1); assert.equal((await app.store.getSession(second.id)).saved, true);
  assert.equal((await app.state()).history.some(entry => entry.id === first.id), false);
});

test('模型发现使用当前未保存表单，旧密钥不能跨来源，识图不借用文字密钥', async () => {
  const app = await application();
  await app.handle('save-settings', { text: { providerId: 'custom', baseUrl: 'https://old.invalid/v1', model: '旧模型', apiKey: 'fictional-old-key' } });
  await assert.rejects(app.handle('fetch-models', { kind: 'text', config: { providerId: 'custom', baseUrl: 'https://new.invalid/v1', model: '' } }), /重新输入密钥/);
  assert.equal(app.requests.length, 0);
  const result = await app.handle('fetch-models', { kind: 'text', config: { providerId: 'custom', baseUrl: 'https://new.invalid/v1', apiKey: 'fictional-new-key' } });
  assert.equal(result.models[0], '当前密钥可用的模型');
  assert.equal(app.requests[0].url, 'https://new.invalid/v1/models');
  assert.equal(app.requests[0].options.headers.Authorization, 'Bearer fictional-new-key');
  await app.handle('fetch-models', { kind: 'vision', config: { providerId: 'custom', baseUrl: 'https://vision.invalid/v1' } });
  assert.equal(app.requests[1].options.headers.Authorization, undefined);
  assert.equal((await app.state()).settings.text.baseUrl, 'https://old.invalid/v1');
});

test('回收接口在移动目录后报错时刷新历史，不声称原文件保留可重试', async () => {
  const app = await application();
  const target = await app.store.createSession({ text: '回收结果不确定的会话' });
  await app.handle('open-history'); app.uncertain.add(target.id);
  const result = await app.handle('delete-sessions', { ids: [target.id] });
  assert.equal(result.deletedIds.length, 0); assert.equal(result.failed[0].uncertain, true); assert.equal(result.failed[0].absent, true);
  assert.match(result.failed[0].error, /避免重复操作/); assert.equal(result.failed[0].error.includes('原文件已保留'), false);
  assert.equal((await app.state()).history.length, 0); assert.equal((await app.state()).session, null);
  assert.equal(app.trashed.length, 1);
});

test('开机自启默认关闭，原生更新失败会回滚开关', async () => {
  const app = await application();
  assert.equal((await app.state()).settings.prefs.launchAtLogin, false);
  await app.handle('save-settings', { prefs: { launchAtLogin: true } });
  assert.equal(app.loginCalls[0].openAtLogin, true); assert.deepEqual([...app.loginCalls[0].args], ['--autostart']);
  app.loginFailure(true);
  await assert.rejects(app.handle('save-settings', { prefs: { launchAtLogin: false } }), /无法更新 Windows/);
  assert.equal((await app.state()).settings.prefs.launchAtLogin, true);
});

test('组合常规设置中的自启更新失败时一并回滚其他开关，随后可正常应用', async () => {
  const app = await application(); app.loginFailure(true);
  await assert.rejects(app.handle('save-settings', { prefs: { launchAtLogin: true, showOrb: false, selectionEnabled: false } }), /无法更新 Windows/);
  const prefs = (await app.state()).settings.prefs;
  assert.equal(prefs.launchAtLogin, false); assert.equal(prefs.showOrb, true); assert.equal(prefs.selectionEnabled, true);
  app.loginFailure(false);
  await app.handle('save-settings', { prefs: { launchAtLogin: true, showOrb: false, selectionEnabled: false } });
  assert.equal((await app.state()).settings.prefs.showOrb, false); assert.equal((await app.state()).settings.prefs.selectionEnabled, false);
});

test('截图翻译走独立结果窗；重复截图取消旧识别，迟到结果不能覆盖新截图', async () => {
  const app = await application();
  await app.handle('save-settings', { text: { providerId: 'custom', baseUrl: 'https://text.invalid/v1', model: '测试模型' } });
  let finishFirst;
  app.recognize(() => new Promise(resolve => { finishFirst = resolve; }));
  await app.handle('capture-done', { rect: {}, mode: 'translate' });
  const first = (await app.state()).translation.id;
  while (!finishFirst) await new Promise(resolve => setTimeout(resolve, 1));
  app.recognize(async () => ({ blocks: [{ text: '新截图原文', x: 0, y: 0, width: 1, height: 1 }] }));
  await app.handle('capture-done', { rect: {}, mode: 'translate' }); await app.drain();
  const current = (await app.state()).translation;
  assert.notEqual(current.id, first); assert.equal(current.status, 'complete'); assert.equal(current.blocks[0].text, '新截图原文');
  finishFirst({ blocks: [{ text: '旧截图迟到原文', x: 0, y: 0, width: 1, height: 1 }] });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await app.state()).translation.blocks[0].text, '新截图原文');
  assert.equal(app.requests.length, 1); assert.equal((await app.state()).history.length, 0);
  await app.handle('close-translation', { id: current.id }); assert.equal((await app.state()).translation, null);
});

test('截图翻译高度反馈只接受当前截图的有限合法尺寸，旧截图测量不会改动新窗口', async () => {
  const app = await application();
  await app.handle('save-settings', { text: { baseUrl: 'https://text.invalid/v1', model: '测试模型' } });
  await app.handle('capture-done', { rect: {}, mode: 'translate' }); await app.drain();
  const first = (await app.state()).translation;
  await app.handle('set-translation-options', { id: first.id, options: { displayMode: 'compare' } });
  await app.handle('translation-content-height', { id: first.id, contentHeight: 184 });
  assert.equal(app.translationHeightCalls.length, 1);
  assert.equal(app.translationHeightCalls[0][0], first.placement);
  assert.equal(app.translationHeightCalls[0][1], 184);
  for (const contentHeight of [NaN, Infinity, -1, 0, '184', 1_000_001]) {
    await assert.rejects(app.handle('translation-content-height', { id: first.id, contentHeight }), /高度/);
  }
  assert.equal(app.translationHeightCalls.length, 1, '非法测量不能到达窗口布局层');
  await app.handle('capture-done', { rect: {}, mode: 'translate' }); await app.drain();
  const current = (await app.state()).translation;
  assert.notEqual(current.id, first.id);
  await app.handle('translation-content-height', { id: first.id, contentHeight: 420 });
  assert.equal(app.translationHeightCalls.length, 1, '迟到旧 id 只被忽略');
});

test('来源位置失效保留对照译文，不能重新覆盖旧位置；迟到来源事件不关闭新截图', async () => {
  const app = await application();
  await app.handle('save-settings', { text: { baseUrl: 'https://text.invalid/v1', model: '测试模型' } });
  await app.handle('capture-done', { rect: {}, mode: 'translate' }); await app.drain();
  const first = (await app.state()).translation;
  await app.handle('translation-source-invalid', { placement: first.placement, reason: 'moved' });
  const invalid = (await app.state()).translation;
  assert.equal(invalid.options.displayMode, 'compare'); assert.equal(invalid.blocks[0].translation, '译文');
  assert.match(invalid.sourceWarning, /来源窗口已移动/);
  await assert.rejects(app.handle('set-translation-options', { id: invalid.id, options: { displayMode: 'overlay' } }), /重新框选/);
  await app.handle('translation-source-invalid', { placement: {}, reason: 'unavailable' });
  assert.match((await app.state()).translation.sourceWarning, /来源窗口已移动/, '过期来源事件不能改动本次状态');
  await app.handle('translation-source-closed', { placement: {} });
  assert.equal((await app.state()).translation.id, invalid.id);
  await app.handle('translation-source-closed', { placement: invalid.placement });
  assert.equal((await app.state()).translation, null);
});

test('翻译菜单置顶独立于解释窗口且不产生音效反馈，同图重译保留，新截图复位', async () => {
  const app = await application();
  await app.handle('save-settings', { text: { baseUrl: 'https://text.invalid/v1', model: '虚构模型' } });
  await app.handle('capture-done', { mode: 'translate', rect: {} }); await app.drain();
  let state = await app.state(), id = state.translation.id;
  await app.handle('pin-translation-controls', { id, pinned: true });
  state = await app.state();
  assert.equal(state.translation.controlsPinned, true);
  assert.equal(state.pinned, false); assert.equal(state.pinFeedback, null);
  assert.deepEqual(app.translationPins, [true]);
  await assert.rejects(app.handle('pin-translation-controls', { id: '过期翻译', pinned: false }), /已关闭或更新/);
  await assert.rejects(app.handle('pin-translation-controls', { id, pinned: 'true' }), /状态无效/);
  await app.handle('retry-translation', { id }); await app.drain();
  state = await app.state(); assert.equal(state.translation.controlsPinned, true);
  id = state.translation.id;
  await app.handle('pin-translation-controls', { id, pinned: false });
  assert.equal((await app.state()).translation.controlsPinned, false);
  await app.handle('pin-translation-controls', { id, pinned: true });
  await app.handle('capture-done', { mode: 'translate', rect: {} }); await app.drain();
  assert.equal((await app.state()).translation.controlsPinned, false, '新截图不继承旧菜单置顶');
  assert.equal((await app.state()).pinFeedback, null);
});
