'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createStore } = require('../../src/core/store.cjs');

const IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC1kAAAAASUVORK5CYII=';

async function localService(t, respond = (_request, number) => ({ status: 200, body: { choices: [{ message: { content: `本机服务回答⟦${number}⟧` } }] } })) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const received = { path: request.url, method: request.method, authorization: request.headers.authorization || '', body: JSON.parse(raw) };
    requests.push(received);
    const result = respond(received, requests.length);
    response.writeHead(result.status, { 'Content-Type': result.contentType || 'application/json' });
    const body = typeof result.body === 'string' ? result.body : JSON.stringify(result.body);
    if (result.hold) response.write(body);
    else response.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return { requests, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}

async function appActions(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pickgloss-ai-actions-'));
  const encrypted = value => Buffer.from(value, 'utf8').map(byte => byte ^ 0xa5);
  const decrypted = value => Buffer.from(value).map(byte => byte ^ 0xa5).toString('utf8');
  const store = createStore({ directory, encrypt: encrypted, decrypt: decrypted });
  await store.init();
  const desktop = { broadcast() {}, captureState: () => ({ outsideMarker: '框外材料⟦OUTSIDE⟧' }), finishCapture: () => IMAGE,
    openPanel() {}, setOrb() {}, setOrbPreferences() {}, hoverOrb() {}, startSelection() {}, setAppearance() {} };
  const app = { setPath() {}, getPath: () => '', setName() {}, setAppUserModelId() {}, requestSingleInstanceLock: () => true,
    on() {}, whenReady: () => new Promise(() => {}) };
  const electron = { app, net: { fetch: (url, options) => {
    assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname), '测试只允许连接本机受控服务');
    return fetch(url, options);
  } } };
  const source = path.join(__dirname, '../../src/main.cjs');
  const context = { require: name => name === 'electron' ? electron : name.startsWith('./') ? require(path.join(path.dirname(source), name)) : require(name),
    process: { argv: [], env: {}, pid: 1 }, URL, structuredClone, AbortController, setTimeout, clearTimeout,
    testStore: store, testDesktop: desktop, testSettings: await store.getSettings() };
  vm.createContext(context);
  vm.runInContext(await fs.readFile(source, 'utf8') + '\nstore=testStore;desktop=testDesktop;settings=testSettings;globalThis.actions={handle,state};', context);
  return { ...context.actions, store, directory };
}

async function settled(actions, mode, expected) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const current = (await actions.state()).session?.threads?.[mode];
    if (current?.status === expected) return current;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`等待 ${mode} 进入 ${expected} 超时`);
}

test('会话动作发出的语境、独立和截图请求只携带各自材料与历史', async t => {
  const server = await localService(t);
  const actions = await appActions(t);
  await actions.handle('save-settings', { text: { baseUrl: server.baseUrl, model: '虚构文字模型', apiKey: 'fictional-text-key' } });
  const created = await actions.handle('new-text', { text: '选定内容⟦TEXT⟧', context: '可信段落⟦PARAGRAPH⟧' });
  await actions.handle('set-draft', { id: created.id, mode: 'independent', draft: '未发送草稿⟦DRAFT⟧' });
  assert.equal(server.requests.length, 0);
  await actions.handle('start-explanation', { id: created.id, mode: 'context' });
  await settled(actions, 'context', 'done');
  await actions.handle('send-question', { id: created.id, mode: 'context', question: '语境追问⟦CONTEXT-Q⟧' });
  await settled(actions, 'context', 'done');
  await actions.handle('set-mode', { id: created.id, mode: 'independent' });
  await actions.handle('open-session', { id: created.id });
  assert.equal(server.requests.length, 2, '切换与重开已有会话不能自动调用');
  await actions.handle('start-explanation', { id: created.id, mode: 'independent' });
  await settled(actions, 'independent', 'done');
  const textBodies = server.requests.map(item => JSON.stringify(item.body));
  assert.equal(server.requests.length, 3);
  assert.ok(textBodies[0].includes('选定内容⟦TEXT⟧') && textBodies[0].includes('可信段落⟦PARAGRAPH⟧'));
  assert.ok(textBodies[1].includes('语境追问⟦CONTEXT-Q⟧'));
  assert.ok(textBodies[2].includes('选定内容⟦TEXT⟧'));
  assert.ok(!textBodies[2].includes('可信段落⟦PARAGRAPH⟧'));
  assert.ok(!textBodies[2].includes('语境追问⟦CONTEXT-Q⟧'));
  assert.ok(!textBodies[2].includes('本机服务回答⟦1⟧'));
  assert.ok(!textBodies.some(body => body.includes('未发送草稿⟦DRAFT⟧')));
  await actions.handle('send-question', { id: created.id, mode: 'independent', question: '独立追问⟦INDEPENDENT-Q⟧' });
  await settled(actions, 'independent', 'done');
  const independentBody = JSON.stringify(server.requests[3].body);
  assert.ok(independentBody.includes('本机服务回答⟦3⟧') && independentBody.includes('独立追问⟦INDEPENDENT-Q⟧'));
  assert.ok(!independentBody.includes('本机服务回答⟦1⟧') && !independentBody.includes('可信段落⟦PARAGRAPH⟧'));
  await actions.handle('set-mode', { id: created.id, mode: 'context' });
  await actions.handle('start-explanation', { id: created.id, mode: 'context' });
  await settled(actions, 'context', 'done');
  const continuedContext = JSON.stringify(server.requests[4].body);
  assert.ok(continuedContext.includes('本机服务回答⟦1⟧') && continuedContext.includes('语境追问⟦CONTEXT-Q⟧'));
  assert.ok(!continuedContext.includes('本机服务回答⟦3⟧') && !continuedContext.includes('独立追问⟦INDEPENDENT-Q⟧'));
  // 带说明的待解释材料从已保留会话打开；新框选现在会立即开始识图。
  const captured = await actions.store.createSession({ kind: 'image', imageData: IMAGE, activeMode: 'visual' });
  await actions.handle('open-session', { id: captured.id });
  await actions.handle('set-note', { id: captured.id, note: '截图说明⟦NOTE⟧' });
  await actions.handle('start-explanation', { id: captured.id, mode: 'visual' });
  await settled(actions, 'visual', 'done');
  const imageBody = JSON.stringify(server.requests[5].body);
  assert.ok(imageBody.includes(IMAGE) && imageBody.includes('截图说明⟦NOTE⟧'));
  assert.ok(!imageBody.includes('选定内容⟦TEXT⟧') && !imageBody.includes('可信段落⟦PARAGRAPH⟧'));
  assert.ok(!imageBody.includes('框外材料⟦OUTSIDE⟧'));
  assert.ok(server.requests.every(item => item.path === '/v1/chat/completions' && item.method === 'POST'));
});

test('重新解释不消耗尚未发送的本模式追问草稿', async t => {
  const server = await localService(t);
  const actions = await appActions(t);
  await actions.handle('save-settings', { text: { baseUrl: server.baseUrl, model: '虚构文字模型' } });
  const created = await actions.handle('new-text', { text: '选定内容', context: '可信段落' });
  await actions.handle('set-draft', { id: created.id, mode: 'context', draft: '待发送的追问草稿' });
  await actions.handle('start-explanation', { id: created.id, mode: 'context' });
  await settled(actions, 'context', 'done');
  assert.equal((await actions.state()).session.threads.context.draft, '待发送的追问草稿');
  assert.equal((await actions.store.getSession(created.id)).threads.context.draft, '待发送的追问草稿');
  assert.ok(!JSON.stringify(server.requests[0].body).includes('待发送的追问草稿'));
});

test('截图动作、追问及连接测试按识图模型名完整沿用或独立路由', async t => {
  const textService = await localService(t);
  let rejectImages = false;
  const visionService = await localService(t, () => rejectImages
    ? { status: 400, body: { error: { message: '受控服务不支持图片' } } }
    : { status: 200, body: { choices: [{ message: { content: '独立识图回答' } }] } });
  const actions = await appActions(t);
  await actions.handle('save-settings', { text: { baseUrl: textService.baseUrl, model: '虚构文字模型', apiKey: 'fictional-text-key' },
    vision: { baseUrl: visionService.baseUrl, model: ' ', apiKey: 'fictional-vision-key' } });
  await actions.handle('capture-done', { rect: {} });
  const first = (await actions.state()).session;
  await settled(actions, 'visual', 'done');
  await actions.handle('send-question', { id: first.id, mode: 'visual', question: '截图追问' });
  await settled(actions, 'visual', 'done');
  await actions.handle('test-provider', { kind: 'vision', config: { baseUrl: visionService.baseUrl, model: '' },
    fallbackConfig: { baseUrl: textService.baseUrl, model: '表单中尚未保存的文字模型' } });
  assert.equal(visionService.requests.length, 0);
  assert.deepEqual(textService.requests.map(item => item.body.model), ['虚构文字模型', '虚构文字模型', '表单中尚未保存的文字模型']);
  assert.ok(textService.requests.every(item => item.authorization === 'Bearer fictional-text-key'));
  assert.ok(textService.requests[2].body.messages[0].content.some(part => part.type === 'image_url'));
  await actions.handle('save-settings', { vision: { model: '独立识图模型' } });
  await actions.handle('capture-done', { rect: {} });
  const second = (await actions.state()).session;
  await settled(actions, 'visual', 'done');
  assert.equal(visionService.requests[0].body.model, '独立识图模型');
  assert.equal(visionService.requests[0].authorization, 'Bearer fictional-vision-key');
  assert.equal(textService.requests.length, 3);
  rejectImages = true;
  await actions.handle('capture-done', { rect: {} });
  const failed = (await actions.state()).session;
  const thread = await settled(actions, 'visual', 'error');
  assert.match(thread.error, /HTTP 400/);
  assert.equal((await actions.store.getSession(failed.id)).imageData, IMAGE);
  assert.equal(textService.requests.length, 3, '独立识图失败不能暗中切换文字服务');
  assert.equal(visionService.requests.length, 2);
  await actions.handle('save-settings', { vision: { baseUrl: '', model: '独立识图模型', clearKey: true } });
  await actions.handle('capture-done', { rect: {} });
  const unconfigured = (await actions.state()).session;
  await assert.rejects(actions.handle('start-explanation', { id: unconfigured.id, mode: 'visual' }), /请先配置/);
  assert.equal(textService.requests.length, 3);
  assert.equal(visionService.requests.length, 2);
  assert.equal((await actions.store.getSession(unconfigured.id)).imageData, IMAGE);
  rejectImages = false;
  await actions.handle('save-settings', { vision: { baseUrl: visionService.baseUrl, model: '独立识图模型', apiKey: 'fictional-new-vision-key' } });
  await actions.handle('start-explanation', { id: unconfigured.id, mode: 'visual' });
  await settled(actions, 'visual', 'done');
  assert.equal(visionService.requests[2].authorization, 'Bearer fictional-new-vision-key');
});

test('截断后保留片段，手动重试只发送一次原追问且不把片段当完整历史', async t => {
  const partial = '未完成片段⟦PARTIAL⟧';
  const server = await localService(t, (_request, number) => number === 2
    ? { status: 200, contentType: 'text/event-stream', body: `data: ${JSON.stringify({ choices: [{ delta: { content: partial } }] })}\n\n` }
    : { status: 200, body: { choices: [{ message: { content: `已完成回答⟦${number}⟧` } }] } });
  const actions = await appActions(t);
  await actions.handle('save-settings', { text: { baseUrl: server.baseUrl, model: '虚构文字模型' } });
  const created = await actions.handle('new-text', { text: '选定内容', context: '可信段落' });
  await actions.handle('start-explanation', { id: created.id, mode: 'context' });
  await settled(actions, 'context', 'done');
  await actions.handle('send-question', { id: created.id, mode: 'context', question: '唯一追问⟦QUESTION⟧' });
  const failed = await settled(actions, 'context', 'error');
  assert.equal(failed.messages.at(-1).content, partial);
  assert.equal(failed.messages.at(-1).status, 'error');
  assert.equal((await actions.store.getSession(created.id)).threads.context.messages.at(-1).content, partial);
  assert.equal(server.requests.length, 2, '截断后不能自动重试');
  await actions.handle('start-explanation', { id: created.id, mode: 'context' });
  await settled(actions, 'context', 'done');
  const retry = JSON.stringify(server.requests[2].body);
  assert.equal(retry.split('唯一追问⟦QUESTION⟧').length - 1, 1);
  assert.ok(retry.includes('已完成回答⟦1⟧'));
  assert.ok(!retry.includes(partial));
  assert.equal((await actions.state()).session.threads.context.messages.at(-2).content, partial);
  assert.equal(server.requests.length, 3);
});

test('主动停止只保留已经收到的片段，重开会话不会续发', async t => {
  const partial = '停止前片段⟦STOPPED⟧';
  const server = await localService(t, () => ({ status: 200, contentType: 'text/event-stream', hold: true,
    body: `data: ${JSON.stringify({ choices: [{ delta: { content: partial } }] })}\n\n` }));
  const actions = await appActions(t);
  await actions.handle('save-settings', { text: { baseUrl: server.baseUrl, model: '虚构文字模型' } });
  const created = await actions.handle('new-text', { text: '选定内容', context: '可信段落' });
  await actions.handle('start-explanation', { id: created.id, mode: 'context' });
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && (await actions.state()).session.threads.context.messages.at(-1)?.content !== partial) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal((await actions.state()).session.threads.context.messages.at(-1)?.content, partial);
  await actions.handle('stop', { id: created.id, mode: 'context' });
  const stopped = await settled(actions, 'context', 'stopped');
  assert.equal(stopped.messages.at(-1).content, partial);
  await actions.handle('open-session', { id: created.id });
  assert.equal(server.requests.length, 1);
  assert.equal((await actions.store.getSession(created.id)).threads.context.messages.at(-1).status, 'stopped');
});

test('重新打开中断会话呈现已保存片段，不自动续发请求', async t => {
  const server = await localService(t);
  const actions = await appActions(t);
  await actions.handle('save-settings', { text: { baseUrl: server.baseUrl, model: '虚构文字模型' } });
  const threads = Object.fromEntries(['context', 'independent', 'visual'].map(mode => [mode, { messages: [], draft: '' }]));
  threads.context = { messages: [{ id: '未完成回答', role: 'assistant', content: '中断前已保存片段', status: 'streaming' }], draft: '保留追问草稿', status: 'streaming' };
  const saved = await actions.store.createSession({ text: '选定内容', context: '可信段落', threads });
  await actions.handle('open-session', { id: saved.id });
  const restored = (await actions.state()).session.threads.context;
  assert.equal(restored.messages[0].content, '中断前已保存片段');
  assert.equal(restored.messages[0].status, 'stopped');
  assert.equal(restored.draft, '保留追问草稿');
  assert.equal(server.requests.length, 0);
});
