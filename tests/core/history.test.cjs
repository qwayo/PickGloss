'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');
const { createStore } = require('../../src/core/store.cjs');
const { historyEntry, queryHistory } = require('../../src/core/history.cjs');
const imageData = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC1kAAAAASUVORK5CYII=';

async function setup() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pickgloss-history-'));
  const recycled = new Map();
  const options = { directory, trash: async target => {
    const destination = `${target}.隔离回收目录`;
    await fs.rename(target, destination); recycled.set(path.basename(target), destination);
  } };
  const store = createStore(options); await store.init();
  return { directory, store, options, restore: id => fs.rename(recycled.get(id), path.join(directory, 'sessions', id)) };
}

async function fixture(store, directory, { name, time, messages = [], ...input }) {
  const created = await store.createSession({ text: name, ...input });
  const file = path.join(directory, 'sessions', created.id, 'session.json');
  const raw = JSON.parse(await fs.readFile(file, 'utf8'));
  raw.createdAt = time; raw.updatedAt = time; raw.lastActivityAt = time;
  raw.threads[created.activeMode].messages = messages;
  await fs.writeFile(file, JSON.stringify(raw), 'utf8');
  return await store.getSession(created.id);
}

test('历史预览优先当前模式最后一个非空回答，去基础Markdown并限制展示长度', async () => {
  const { store } = await setup();
  const session = await store.createSession({ text: '原文后备', context: '上下文后备', activeMode: 'independent', source: { app: `  ${'来源'.repeat(45)}  ` }, threads: {
    context: { messages: [{ id: '其它模式', role: 'assistant', content: '不得替代当前模式回答' }], draft: '' },
    independent: { messages: [{ id: '早期', role: 'assistant', content: '早期回答' },
      { id: '末回答', role: 'assistant', content: '# 标题\n- **重点**与 _强调_、`代码`、[标签](https://example.com/private)、![图示](data:image/png;base64,不应暴露)\n```js\n正文\n```' },
      { id: '空回答', role: 'assistant', content: ' \n ' }, { id: '末问题', role: 'user', content: '用户问题不作为回答预览' }], draft: '' },
    visual: { messages: [], draft: '' },
  } });
  const entry = historyEntry(session);
  assert.equal(entry.preview, '标题 重点与 强调、代码、标签、图示 正文');
  assert.equal(entry.sourceLabel.length, 80);
  session.threads.independent.messages = [{ role: 'assistant', content: '长'.repeat(199) + '😀尾部不显示' }];
  const truncated = historyEntry(session).preview;
  assert.equal(truncated, '长'.repeat(199)); assert.ok(truncated.length <= 200);
  session.threads.independent.messages = [{ role: 'assistant', content: '长'.repeat(250) }];
  assert.equal(historyEntry(session).preview.length, 200);
});

test('历史预览把HTML作为字面文本，公开条目不携带完整线程草稿图片或额外密钥', async () => {
  const { store } = await setup();
  const literal = '<img src="x" onerror="全局代码不得执行()"><script>字面脚本</script>';
  const session = await store.createSession({ kind: 'image', imageData, note: '截图说明', threads: {
    context: { messages: [], draft: '未发送的语境草稿' }, independent: { messages: [], draft: '' },
    visual: { messages: [{ id: '截图回答', role: 'assistant', content: literal + '长'.repeat(240) + '完整回答尾部标记' }], draft: '私密的截图追问草稿' },
  } });
  session.imagePath = 'C:/私密图像目录/截图.png'; session.apiKey = '额外密钥不可传输';
  const indexed = historyEntry(session), [entry] = queryHistory([indexed]);
  assert.ok(entry.preview.startsWith(literal)); assert.ok(entry.preview.length <= 200);
  assert.ok(indexed.searchText.includes('完整回答尾部标记'));
  for (const field of ['searchText', 'threads', 'imageData', 'imagePath', 'apiKey', 'source']) assert.equal(field in entry, false);
  const serialized = JSON.stringify(entry);
  for (const secret of ['完整回答尾部标记', '私密的截图追问草稿', '未发送的语境草稿', '私密图像目录', '额外密钥不可传输', 'data:image/png']) assert.equal(serialized.includes(secret), false);
});

test('旧会话缺少来源时提供后备标签，未解释会话按上下文说明原文顺序预览', async () => {
  const { store } = await setup();
  const session = await store.createSession({ text: '原文后备', context: '  上下文\n段落  ', note: '截图说明后备' });
  delete session.source;
  assert.equal(historyEntry(session).sourceLabel, '未知来源'); assert.equal(historyEntry(session).preview, '上下文 段落');
  session.context = ''; assert.equal(historyEntry(session).preview, '截图说明后备');
  session.note = ''; assert.equal(historyEntry(session).preview, '原文后备');
});

test('超长未闭合Markdown预览处理有界，完整回答尾部仍能搜索', async t => {
  const { store } = await setup();
  const session = await store.createSession({ text: '预览性能样本', threads: {
    context: { messages: [{ id: '长回答', role: 'assistant', content: '['.repeat(40000) + '回答尾部搜索标记' }], draft: '' },
    independent: { messages: [], draft: '' }, visual: { messages: [], draft: '' },
  } });
  const started = performance.now(), entry = historyEntry(session), elapsed = performance.now() - started;
  t.diagnostic(`四万字符未闭合链接预览耗时：${elapsed.toFixed(1)} 毫秒。`);
  assert.equal(entry.preview, '['.repeat(200));
  assert.deepEqual(queryHistory([entry], { query: '回答尾部搜索标记' }).map(item => item.id), [session.id]);
  assert.ok(entry.searchText.includes('回答尾部搜索标记'));
  assert.ok(elapsed < 400, `预览清洗不应阻塞主进程，本次耗时 ${elapsed.toFixed(1)} 毫秒。`);
});

test('会话改名独立保存，原文、段落、截图与各模式问答保持原样', async () => {
  const { store, options } = await setup();
  const text = await store.createSession({ text: 'compound', context: 'Small changes compound.', threads: {
    context: { messages: [{ id: '语境回答', role: 'assistant', content: '不断累积' }], draft: '语境草稿' },
    independent: { messages: [{ id: '独立回答', role: 'assistant', content: '复合物' }], draft: '独立草稿' },
    visual: { messages: [], draft: '' },
  } });
  const changed = await store.updateSession(text.id, { title: '  阅读笔记：复利  ' });
  assert.equal(changed.title, '阅读笔记：复利');
  assert.equal(changed.text, text.text); assert.equal(changed.context, text.context);
  assert.deepEqual(changed.threads, text.threads);
  assert.equal(changed.lastActivityAt, text.lastActivityAt);
  const image = await store.createSession({ kind: 'image', imageData, note: '原始截图说明' });
  await store.updateSession(image.id, { title: '图表笔记' });
  const restarted = createStore(options); await restarted.init();
  assert.equal((await restarted.getSession(text.id)).title, '阅读笔记：复利');
  const restoredImage = await restarted.getSession(image.id);
  assert.equal(restoredImage.title, '图表笔记'); assert.equal(restoredImage.note, '原始截图说明');
  assert.equal(restoredImage.imageData, imageData);
  await assert.rejects(store.updateSession(text.id, { title: '名'.repeat(201) }), { code: 'INPUT_TOO_LONG' });
  assert.equal((await store.getSession(text.id)).title, '阅读笔记：复利');
});

test('旧会话读取不改写文件，首次保存固定兼容时间且无问答记录按建立时间排序', async () => {
  const { directory, store } = await setup();
  for (const withAnswer of [true, false]) {
    const session = await store.createSession({ text: '保留旧材料' });
    const file = path.join(directory, 'sessions', session.id, 'session.json');
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    delete raw.title; delete raw.lastActivityAt;
    raw.createdAt = '2026-01-01T00:00:00.000Z'; raw.updatedAt = '2026-05-01T00:00:00.000Z';
    if (withAnswer) raw.threads.context.messages.push({ id: '旧回答', role: 'assistant', content: '保留的回答' });
    const bytes = JSON.stringify(raw); await fs.writeFile(file, bytes, 'utf8');
    const loaded = await store.getSession(session.id);
    assert.equal(loaded.lastActivityAt, withAnswer ? raw.updatedAt : raw.createdAt);
    assert.equal(queryHistory(await store.listSessions()).find(item => item.id === session.id).title, '保留旧材料');
    assert.equal(await fs.readFile(file, 'utf8'), bytes, '只读兼容不能偷偷改写旧数据');
    await store.updateSession(session.id, { title: '旧记录的新标题', saved: true });
    const next = await store.updateSession(session.id, { threads: { independent: { draft: '尚未发送' } } });
    assert.equal(next.lastActivityAt, loaded.lastActivityAt);
    assert.deepEqual(next.threads.context.messages, raw.threads.context.messages);
  }
});

test('搜索覆盖标题、原文段落、截图说明及所有模式的问答，收藏筛选不改变覆盖范围', async () => {
  const { store } = await setup();
  const created = await store.createSession({ text: '选定词', context: '段落独有关键字', title: '标题独有关键字', saved: true, threads: {
    context: { messages: [{ id: '问题', role: 'user', content: '问句独有关键字' }, { id: '回答', role: 'assistant', content: 'ContextAnswerOnly' }], draft: '草稿不纳入查找' },
    independent: { messages: [{ id: '独立回答', role: 'assistant', content: '独立模式独有关键字' }], draft: '' },
    visual: { messages: [], draft: '' },
  } });
  const image = await store.createSession({ kind: 'image', imageData, note: '截图说明独有关键字', threads: {
    context: { messages: [], draft: '' }, independent: { messages: [], draft: '' },
    visual: { messages: [{ id: '截图回答', role: 'assistant', content: '截图回答独有关键字', status: 'stopped' }], draft: '' },
  } });
  const entries = await store.listSessions();
  for (const query of ['标题独有', '选定词', '段落独有', '问句独有', 'contextansweronly', '独立模式独有']) {
    assert.deepEqual(queryHistory(entries, { query, savedOnly: true }).map(item => item.id), [created.id]);
  }
  assert.deepEqual(queryHistory(entries, { query: '截图说明独有' }).map(item => item.id), [image.id]);
  assert.deepEqual(queryHistory(entries, { query: '截图回答独有' }).map(item => item.id), [image.id]);
  assert.equal(queryHistory(entries, { query: '截图回答独有', savedOnly: true }).length, 0);
  assert.equal(queryHistory(entries, { query: '草稿不纳入' }).length, 0);
  assert.ok(queryHistory(entries).every(item => !('searchText' in item) && !('imageData' in item)));
});

test('只有新增解释或追问推动排序，收藏、改名、草稿、模式和流式落盘均不推动', async () => {
  const { store, directory } = await setup();
  const older = await fixture(store, directory, { name: '较早的问答', time: '2026-01-01T00:00:00.000Z', messages: [{ id: '旧回答', role: 'assistant', content: '已保存回答' }] });
  const newer = await fixture(store, directory, { name: '较新的未解释材料', time: '2026-02-01T00:00:00.000Z' });
  const order = async () => queryHistory(await store.listSessions()).map(item => item.id);
  await store.updateSession(older.id, { title: '改名后仍在原位置', saved: true, activeMode: 'independent', threads: { independent: { draft: '草稿' } } });
  assert.deepEqual(await order(), [newer.id, older.id]);
  const messages = [{ id: '新追问', role: 'user', content: '继续解释' }, { id: '新回答', role: 'assistant', content: '', status: 'streaming' }];
  const started = await store.updateSession(older.id, { threads: { independent: { messages, draft: '' } } });
  assert.deepEqual(await order(), [older.id, newer.id]);
  messages[1].content = '持续输出的回答'; messages[1].status = 'complete';
  const complete = await store.updateSession(older.id, { threads: { independent: { messages, status: 'done' } } });
  assert.equal(complete.lastActivityAt, started.lastActivityAt);
  const viewed = await store.updateSession(older.id, { saved: false, activeMode: 'context' });
  assert.equal(viewed.lastActivityAt, started.lastActivityAt);
});

async function mainHarness(store, stream) {
  const codePath = path.join(__dirname, '../../src/main.cjs');
  const broadcasts = [], timers = new Set();
  const desktop = { broadcast: value => broadcasts.push(value), captureState: () => null, openPanel() {}, hidePanel() {} };
  const electron = { app: { setPath() {}, getPath: () => '隔离测试目录', setName() {}, setAppUserModelId() {}, requestSingleInstanceLock: () => true,
    on() {}, whenReady: () => new Promise(() => {}) }, net: { fetch: () => assert.fail('历史操作不能调用网络') } };
  const context = { require: name => name === 'electron' ? electron : name === './core/provider.cjs' ? {
    ...require('../../src/core/provider.cjs'), streamCompletion: stream || (async ({ onDelta }) => onDelta('隔离模型回答')),
  } : name.startsWith('./') ? require(path.join(path.dirname(codePath), name)) : require(name),
  process: { argv: [], env: {}, pid: 1 }, structuredClone, AbortController,
  setTimeout: (fn, ms) => { const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms); timers.add(timer); return timer; }, clearTimeout,
  auditStore: store, auditDesktop: desktop };
  vm.createContext(context);
  vm.runInContext(await fs.readFile(codePath, 'utf8') + `
    store=auditStore; desktop=auditDesktop; settings={};
    globalThis.audit={handle,state,startRequest,persist,cache,jobs};
  `, context);
  return { ...context.audit, broadcasts, dispose() { for (const timer of timers) clearTimeout(timer); } };
}

test('主进程刷新与重新进入历史均能发现还原目录，标题、截图和各模式历史可继续打开', async t => {
  const fixture = await setup();
  const app = await mainHarness(fixture.store); t.after(() => app.dispose());
  const session = await fixture.store.createSession({ kind: 'image', imageData, note: '可恢复材料', title: '还原的标题', saved: true });
  await app.handle('open-history');
  assert.equal((await app.state()).history.length, 1);
  await app.handle('delete-session', { id: session.id });
  assert.equal((await app.state()).history.length, 0);
  await fixture.restore(session.id);
  await app.handle('refresh-history');
  assert.equal((await app.state()).history[0].title, '还原的标题');
  await app.handle('open-session', { id: session.id });
  assert.equal((await app.state()).session.imageData, imageData);
  await app.handle('delete-session', { id: session.id }); await fixture.restore(session.id);
  await app.handle('open-history'); assert.equal((await app.state()).history.length, 1);
  await app.handle('search-history', { query: '可恢复材料', savedOnly: true });
  assert.equal((await app.state()).history[0].id, session.id);
  assert.equal('searchText' in (await app.state()).history[0], false);
  await assert.rejects(app.handle('rename-session', { id: session.id, title: '   ' }), /不能为空/);
});

test('真实主进程请求生命周期中改名，后续流式保存不覆盖标题且重开不自动发请求', async t => {
  const { store, options } = await setup();
  await store.saveSettings({ text: { baseUrl: 'http://127.0.0.1:1234/v1', model: '隔离模型' } });
  let release, requests = 0;
  const app = await mainHarness(store, async ({ onDelta }) => { requests++; onDelta('开始回答'); await new Promise(resolve => { release = resolve; }); onDelta('，完成回答'); });
  t.after(() => app.dispose());
  const session = await store.createSession({ text: 'compound' });
  await app.handle('open-session', { id: session.id });
  await app.startRequest({ id: session.id, mode: 'independent' }, '请解释');
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const activity = (await store.getSession(session.id)).lastActivityAt;
  await app.handle('rename-session', { id: session.id, title: '流式期间改好的标题' });
  const pending = [...app.jobs.values()].map(job => job.promise); release(); await Promise.all(pending);
  await app.handle('set-draft', { id: session.id, mode: 'independent', draft: '保留草稿' });
  const restarted = createStore(options); await restarted.init();
  const loaded = await restarted.getSession(session.id);
  assert.equal(loaded.title, '流式期间改好的标题');
  assert.equal(loaded.lastActivityAt, activity); assert.equal(loaded.threads.independent.draft, '保留草稿');
  assert.equal(loaded.threads.independent.messages.at(-1).content, '开始回答，完成回答');
  await app.handle('open-session', { id: session.id }); assert.equal(requests, 1);
  await app.handle('search-history', { query: '完成回答', savedOnly: false });
  assert.equal((await app.state()).history.length, 1);
});

test('生成中的截图会话移入回收目录前完成停止，恢复后保留截图、回答与草稿', async t => {
  const fixture = await setup();
  await fixture.store.saveSettings({ vision: { baseUrl: 'http://127.0.0.1:1234/v1', model: '隔离识图模型' } });
  let streaming;
  const started = new Promise(resolve => { streaming = resolve; });
  const app = await mainHarness(fixture.store, async ({ signal, onDelta }) => {
    onDelta('虚构截图的已保存片段');
    streaming();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  });
  t.after(() => app.dispose());
  const created = await fixture.store.createSession({ kind: 'image', imageData, title: '回收站截图样本', note: '蓝黄条纹的虚构截图', saved: true });
  await fixture.store.updateSession(created.id, { threads: { visual: { draft: '保留的截图追问草稿' } } });
  await app.handle('open-session', { id: created.id });
  await app.startRequest({ id: created.id, mode: 'visual' });
  await started;

  await app.handle('delete-session', { id: created.id });
  assert.equal((await app.state()).history.length, 0);
  await assert.rejects(fixture.store.getSession(created.id), { code: 'NOT_FOUND' });
  await assert.rejects(app.handle('set-draft', { id: created.id, mode: 'visual', draft: '迟到保存' }), /已关闭或删除/);

  await fixture.restore(created.id);
  await app.handle('refresh-history');
  assert.equal((await app.state()).history[0].title, '回收站截图样本');
  await app.handle('open-session', { id: created.id });
  const recovered = (await app.state()).session;
  assert.equal(recovered.saved, true);
  assert.equal(recovered.note, '蓝黄条纹的虚构截图');
  assert.equal(recovered.imageData, imageData);
  assert.equal(recovered.threads.visual.draft, '保留的截图追问草稿');
  assert.equal(recovered.threads.visual.messages.at(-1).content, '虚构截图的已保存片段');
  assert.equal(recovered.threads.visual.messages.at(-1).status, 'stopped');
});

test('请求等待设置期间删除会话，迟到的请求不能重新发起或保存', async t => {
  const fixture = await setup();
  await fixture.store.saveSettings({ text: { baseUrl: 'http://127.0.0.1:1234/v1', model: '隔离模型' } });
  const originalSettings = fixture.store.getSettings.bind(fixture.store);
  let entered, release, requests = 0;
  const waiting = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  fixture.store.getSettings = async (...args) => { entered(); await gate; return originalSettings(...args); };
  const app = await mainHarness(fixture.store, async () => { requests++; });
  t.after(() => app.dispose());
  const created = await fixture.store.createSession({ text: '等待设置的虚构材料' });
  await app.handle('open-session', { id: created.id });
  const starting = app.handle('start-explanation', { id: created.id, mode: 'context' });
  await waiting;
  await app.handle('delete-session', { id: created.id });
  release();
  await assert.rejects(starting, /已删除/);
  assert.equal(requests, 0);
  assert.equal((await app.state()).history.length, 0);
  await assert.rejects(fixture.store.getSession(created.id), { code: 'NOT_FOUND' });
});

test('会话还原后旧流的迟到片段不能写回已删除会话', async t => {
  const fixture = await setup();
  await fixture.store.saveSettings({ vision: { baseUrl: 'http://127.0.0.1:1234/v1', model: '隔离识图模型' } });
  let lateDelta, started;
  const waiting = new Promise(resolve => { started = resolve; });
  const app = await mainHarness(fixture.store, async ({ signal, onDelta }) => {
    onDelta('删除前片段');
    lateDelta = () => onDelta('迟到片段');
    started();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  });
  t.after(() => app.dispose());
  const created = await fixture.store.createSession({ kind: 'image', imageData });
  await app.handle('open-session', { id: created.id });
  await app.startRequest({ id: created.id, mode: 'visual' });
  await waiting;
  await app.handle('delete-session', { id: created.id });
  await fixture.restore(created.id);
  await app.handle('refresh-history');
  await app.handle('open-session', { id: created.id });
  await new Promise(resolve => setTimeout(resolve, 2100));
  lateDelta();
  await new Promise(resolve => setTimeout(resolve, 50));
  const recovered = await fixture.store.getSession(created.id);
  assert.equal(recovered.threads.visual.messages.at(-1).content, '删除前片段');
  assert.equal((await app.state()).status.error, '');
});
