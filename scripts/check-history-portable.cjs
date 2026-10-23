'use strict';
// 使用正式候选包和隔离虚构数据，贯通会话整理、留存和旧记录读取。
const { quoteJavaScriptString } = require('./javascript-string.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { createStore } = require('../src/core/store.cjs');

const defaultArtifactRoot = path.join(__dirname, '..', 'output', 'verification');
const imageData = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC1kAAAAASUVORK5CYII=';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (check, label, ms = 20000) => {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { const value = await check(); if (value) return value; }
    catch (error) { last = error; }
    await wait(150);
  }
  throw new Error(`${label} 超时。${last?.message || ''}`);
};
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise(resolve => server.close(resolve));
const digest = value => createHash('sha256').update(value).digest('hex');
async function freePort() {
  const server = http.createServer();
  await listen(server);
  const port = server.address().port;
  await close(server);
  return port;
}

async function connect(port) {
  const target = await until(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    const tabs = await response.json();
    return tabs.find(item => item.type === 'page' && item.url.includes('/src/renderer/index.html'));
  }, '正式界面调试目标');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let serial = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || '界面操作失败。');
    return result.result?.value;
  };
  return { socket, send, evaluate };
}

async function seed(directory) {
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, 'verification.marker'), 'PickGloss 隔离验证目录\n', { flag: 'wx' });
  const root = path.join(directory, 'data');
  const store = createStore({ directory: root });
  await store.init();
  const records = [];
  for (let index = 0; index < 55; index++) {
    const screenshot = index === 2;
    const created = await store.createSession(screenshot
      ? { kind: 'image', imageData, note: '截图说明专用针', title: '截图样本', saved: true }
      : { text: `材料批次 ${String(index).padStart(2, '0')}`, context: '批量命中段落', title: `批次会话 ${String(index).padStart(2, '0')}`, saved: index === 0 });
    const file = path.join(root, 'sessions', created.id, 'session.json');
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    raw.createdAt = index === 0 ? '2025-01-01T00:00:00.000Z'
      : index === 1 ? '2025-01-03T00:00:00.000Z'
        : new Date(Date.UTC(2025, 1, 1, 0, index)).toISOString();
    raw.updatedAt = index === 0 ? '2025-01-02T00:00:00.000Z'
      : index === 1 ? '2025-05-01T00:00:00.000Z' : raw.createdAt;
    raw.lastActivityAt = raw.createdAt;
    if (index === 0) {
      delete raw.title;
      delete raw.lastActivityAt;
      raw.context = '旧记录段落专用针';
      raw.threads.context.messages.push({ id: '旧回答', role: 'assistant', content: '旧版停止片段专用针', status: 'stopped' });
      raw.threads.independent.messages.push({ id: '旧独立回答', role: 'assistant', content: '未显示模式专用针' });
      raw.threads.context.draft = '未发送草稿专用针';
    }
    if (index === 1) { delete raw.title; delete raw.lastActivityAt; }
    if (screenshot) raw.threads.visual.messages.push({ id: '截图回答', role: 'assistant', content: '截图回答专用针', status: 'error' });
    const bytes = JSON.stringify(raw, null, 2);
    await fs.writeFile(file, bytes, 'utf8');
    records.push({ id: created.id, file, bytes });
  }
  return { root, records };
}

async function reserveOutput(artifactRoot, names) {
  await fs.mkdir(artifactRoot, { recursive: true });
  for (const name of names) {
    try { await fs.lstat(path.join(artifactRoot, name)); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw new Error(`独立输出目录已有同名结果，请另选目录：${name}`);
  }
}

async function prepareHuman(output, artifactRoot, exclusive) {
  const manifest = JSON.parse(await fs.readFile(path.join(output, 'candidate-manifest.json'), 'utf8'));
  const executable = path.join(output, manifest.packageDirectory, 'PickGloss.exe');
  await fs.access(executable);
  if (exclusive) await reserveOutput(artifactRoot, ['工单13-人工样本.json']);
  const isolated = path.join(os.tmpdir(), `pickgloss-verification-${randomUUID()}`);
  await seed(isolated);
  const launchCommand = `& '${executable}' '--verification-data-dir=${isolated}'`;
  await fs.mkdir(artifactRoot, { recursive: true });
  const reportPath = path.join(artifactRoot, '工单13-人工样本.json');
  await fs.writeFile(reportPath, JSON.stringify({
    candidateId: manifest.candidateId, sourceFingerprint: manifest.sourceFingerprint,
    packageFingerprint: manifest.packageFingerprint, executable, isolatedDirectory: isolated,
    launchCommand,
    fixtureCount: 55, createdAt: new Date().toISOString(),
    markers: ['材料批次 00', '未显示模式专用针', '未发送草稿专用针', '截图说明专用针'],
    note: '仅含虚构会话；以隔离参数打开正式界面，不读取普通用户资料。',
  }, null, 2), exclusive ? { encoding: 'utf8', flag: 'wx' } : 'utf8');
  console.log(`人工样本已准备：${reportPath}\n候选包：${manifest.candidateId}\n隔离目录：${isolated}\n启动命令：${launchCommand}`);
}

async function run(output, artifactRoot, exclusive) {
  const manifest = JSON.parse(await fs.readFile(path.join(output, 'candidate-manifest.json'), 'utf8'));
  const executable = path.join(output, manifest.packageDirectory, 'PickGloss.exe');
  await fs.access(executable);
  if (exclusive) await reserveOutput(artifactRoot, ['工单13-正式历史小窗.png', '工单13-隔离贯通结果.json']);
  const isolated = path.join(os.tmpdir(), `pickgloss-verification-${randomUUID()}`);
  const fixture = await seed(isolated);
  const oldAnswered = fixture.records[0], oldUnanswered = fixture.records[1], screenshot = fixture.records[2];
  const initialCount = fixture.records.length;
  const requests = [];
  let heldResponse;
  const server = http.createServer(async (request, response) => {
    try {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/chat/completions');
      assert.equal(body.model, '会话整理隔离模型');
      requests.push(body);
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '生成片段专用针' } }] })}\n\n`);
      heldResponse = response;
    } catch {
      response.writeHead(400);
      response.end('本机测试请求无效');
    }
  });
  await listen(server);
  let child, browser;
  const packageDirectory = path.dirname(executable);
  const launch = async () => {
    const debugPort = await freePort();
    child = spawn(executable, [`--verification-data-dir=${isolated}`, `--remote-debugging-port=${debugPort}`],
      { cwd: packageDirectory, windowsHide: true, stdio: 'ignore' });
    browser = await connect(debugPort);
    return browser.evaluate;
  };
  const report = {
    candidateId: manifest.candidateId, sourceFingerprint: manifest.sourceFingerprint,
    packageFingerprint: manifest.packageFingerprint, runAt: new Date().toISOString(),
    executable, isolatedDirectory: isolated, fixtureCount: initialCount, checks: [],
    evidenceBoundary: '正式候选包与正式界面；隔离虚构数据和本机受控服务；无真实采集、真实回收站还原或用户人工体验。',
  };
  try {
    let ui = await launch();
    const visible = (expression, title = '界面状态') => until(() => ui(expression), title);
    const field = async (name, value) => {
      assert.equal(await ui(`(() => { const input = document.querySelector(${quoteJavaScriptString(`[data-field="${name}"]`)}); if (!input) return false; input.value = ${quoteJavaScriptString(value)}; input.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`), true, `找不到字段：${name}`);
    };
    const click = async (label, selector = 'button') => {
      await until(() => ui(`(() => { const item = [...document.querySelectorAll(${quoteJavaScriptString(selector)})].find(node => node.textContent.trim() === ${quoteJavaScriptString(label)} || node.getAttribute('aria-label') === ${quoteJavaScriptString(label)} || node.getAttribute('title') === ${quoteJavaScriptString(label)}); if (!item || item.disabled) return false; item.click(); return true; })()`), `可点击入口：${label}`);
    };
    const count = async expected => visible(`document.querySelector('.history-count')?.textContent === ${quoteJavaScriptString(`${expected} 个会话`)}`, `历史数量 ${expected}`);
    const search = async (query, expected) => {
      await visible(`Boolean(document.querySelector('[data-field="history-search"]'))`, '历史搜索入口');
      await field('history-search', query);
      await count(expected);
    };
    const sessionFile = id => path.join(fixture.root, 'sessions', id, 'session.json');
    const stored = async id => JSON.parse(await fs.readFile(sessionFile(id), 'utf8'));
    const ids = async () => (await fs.readdir(path.join(fixture.root, 'sessions'))).filter(name => /^[0-9a-f-]{36}$/i.test(name));

    await visible(`Boolean(document.querySelector('[data-field="paste-text"]'))`);
    await click('历史');
    await count(55);
    assert.equal(await ui(`document.querySelectorAll('.history-item').length`), 50);
    assert.equal(await ui(`document.documentElement.scrollWidth > innerWidth`), false);
    report.rendererWidth = await ui(`innerWidth`);
    assert.ok(report.rendererWidth >= 299 && report.rendererWidth <= 301, 'Windows 像素取整后的渲染宽度应对应 300 逻辑像素小窗');
    await click('加载更多（还有 5 个）');
    assert.equal(await ui(`document.querySelectorAll('.history-item').length`), 55);
    assert.equal(await ui(`[...document.querySelectorAll('.history-item .history-title')].map(node => node.textContent).filter((value,index,array) => array.indexOf(value) === index).length`), 55);
    assert.deepEqual(await ui(`[...document.querySelectorAll('.history-item .history-title')].slice(-2).map(node => node.textContent)`), ['材料批次 01', '材料批次 00'], '无问答旧记录应使用建立时间排序，而不是较晚的普通更新时间');
    assert.equal((await ids()).length, 55);
    report.checks.push('300 像素正式历史界面、55 条分批显示与加载更多无漏项重项及磁盘数量变化');

    await search('未显示模式专用针', 1);
    assert.equal(await ui(`document.querySelector('.history-title')?.textContent`), '材料批次 00');
    await search('未发送草稿专用针', 0);
    await search('旧版停止片段专用针', 1);
    await click('打开会话', '.history-item .history-main');
    await visible(`document.body.textContent.includes('已停止，已生成的内容已保留')`);
    await click('历史');
    await search('旧版停止片段专用针', 1);
    await click('手动收藏', '[role="tab"]');
    await count(1);
    await search('旧记录段落专用针', 1);
    await click('全部会话', '[role="tab"]');
    await count(1);
    await search('截图回答专用针', 1);
    await search('截图说明专用针', 1);
    await click('打开会话', '.history-item .history-main');
    await visible(`Boolean(document.querySelector('.preview-image')) && document.body.textContent.includes('截图说明专用针') && document.body.textContent.includes('这次请求没有完成')`);
    assert.equal(digest(await fs.readFile(path.join(fixture.root, 'sessions', screenshot.id, 'crop.png'))), digest(Buffer.from(imageData.split(',')[1], 'base64')));
    assert.equal(await fs.readFile(oldAnswered.file, 'utf8'), oldAnswered.bytes);
    assert.equal(await fs.readFile(oldUnanswered.file, 'utf8'), oldUnanswered.bytes);
    report.checks.push('旧格式只读无改写、跨模式与停止片段搜索、草稿排除、收藏同字段覆盖、截图材料及图片重开');

    await click('历史');
    await search('材料批次 00', 1);
    await click('改名');
    await field(`history-title-${oldAnswered.id}`, '   ');
    await click('保存标题');
    await visible(`document.body.textContent.includes('会话标题须为 1 至 200 个字符')`);
    await field(`history-title-${oldAnswered.id}`, '字'.repeat(201));
    await click('保存标题');
    assert.equal((await stored(oldAnswered.id)).title, undefined, '超长标题不能写入旧记录');
    await field(`history-title-${oldAnswered.id}`, '旧格式改名后标题');
    await click('保存标题');
    await visible(`document.querySelector('.history-title')?.textContent === '旧格式改名后标题'`);
    const compatible = await stored(oldAnswered.id);
    assert.equal(compatible.lastActivityAt, '2025-01-02T00:00:00.000Z');
    assert.equal(compatible.text, '材料批次 00');
    assert.equal(compatible.context, '旧记录段落专用针');
    assert.equal(compatible.threads.independent.messages[0].content, '未显示模式专用针');
    assert.equal((await stored(oldUnanswered.id)).lastActivityAt, undefined);
    assert.equal(await fs.readFile(oldUnanswered.file, 'utf8'), oldUnanswered.bytes);
    report.checks.push('空标题反馈、旧问答原更新时间兼容近似首次保存固定、未问答旧记录继续只读且使用建立时间');

    await search('', 55);
    await click('新建');
    await visible(`Boolean(document.querySelector('[data-field="paste-text"]'))`);
    await field('paste-text', 'compound 会话整理样本');
    await field('paste-context', '会话整理专用段落：Small gains compound.');
    await click('开始解释');
    await visible(`document.querySelector('.selected-word')?.textContent === 'compound 会话整理样本'`);
    const firstNew = (await ids()).find(id => !fixture.records.some(item => item.id === id));
    assert.ok(firstNew);
    assert.equal(requests.length, 0);
    await click('历史');
    await click('新建');
    await visible(`Boolean(document.querySelector('[data-field="paste-text"]'))`);
    await field('paste-text', 'compound 会话整理样本');
    await click('开始解释');
    await visible(`document.querySelector('.selected-word')?.textContent === 'compound 会话整理样本'`);
    const nextIds = (await ids()).filter(id => !fixture.records.some(item => item.id === id));
    assert.equal(nextIds.length, 2);
    const secondNew = nextIds.find(id => id !== firstNew);
    assert.ok(secondNew);
    await click('历史');
    await count(57);
    assert.equal(await ui(`document.querySelector('.history-title')?.textContent`), 'compound 会话整理样本');
    report.checks.push('正式粘贴入口即时落盘、无模型配置不发请求、重复材料形成独立会话并按建立时间显示');

    await search('会话整理专用段落', 1);
    await click('改名');
    await field(`history-title-${firstNew}`, '正式包改名验收');
    await click('保存标题');
    await visible(`document.querySelector('.history-title')?.textContent === '正式包改名验收'`);
    const beforeFavorite = await stored(firstNew);
    await click('收藏');
    await visible(`Boolean(document.querySelector('.history-item button[aria-pressed="true"]'))`);
    await click('手动收藏', '[role="tab"]');
    await count(1);
    await click('打开会话', '.history-item .history-main');
    await visible(`document.querySelector('.selected-word')?.textContent === 'compound 会话整理样本'`);
    assert.equal((await stored(firstNew)).lastActivityAt, beforeFavorite.lastActivityAt);
    assert.equal((await stored(firstNew)).context, beforeFavorite.context);
    report.checks.push('正式界面改名、收藏与重开不修改原文段落或问答活动时间');

    await click('配置 AI 服务');
    await visible(`Boolean(document.querySelector('[data-field="text-baseUrl"]'))`);
    await field('text-baseUrl', `http://127.0.0.1:${server.address().port}/v1`);
    await field('text-model', '会话整理隔离模型');
    await click('保存设置');
    await visible(`document.body.textContent.includes('开始释义')`);
    await click('开始释义');
    await until(() => requests.length === 1, '本机隔离解释请求');
    await visible(`document.body.textContent.includes('生成片段专用针')`);
    await click('历史');
    await search('正式包改名验收', 1);
    await click('改名');
    await field(`history-title-${firstNew}`, '流式期间改好的标题');
    await click('保存标题');
    await until(async () => (await stored(firstNew)).title === '流式期间改好的标题', '流式期间新标题落盘');
    await search('流式期间改好的标题', 1);
    await visible(`document.querySelector('.history-title')?.textContent === '流式期间改好的标题'`);
    const activityDuringStream = (await stored(firstNew)).lastActivityAt;
    heldResponse.end('data: [DONE]\n\n');
    await until(async () => (await stored(firstNew)).threads.context.messages.at(-1)?.status === 'complete', '流式回答完成落盘');
    assert.equal((await stored(firstNew)).title, '流式期间改好的标题');
    assert.equal((await stored(firstNew)).lastActivityAt, activityDuringStream);
    await search('生成片段专用针', 1);
    await click('打开会话', '.history-item .history-main');
    await visible(`document.body.textContent.includes('生成片段专用针')`);
    assert.equal(requests.length, 1, '历史重开不能发起新请求');
    report.checks.push('正式界面流式期间改名不被后台保存覆盖，同一回答完成落盘不重新排序，历史重开不自动请求');

    await field('question', '收藏后继续追问专用针');
    await click('发送追问');
    await until(() => requests.length === 2, '收藏后本机追问请求');
    heldResponse.end('data: [DONE]\n\n');
    await until(async () => (await stored(firstNew)).threads.context.messages.length === 3 && (await stored(firstNew)).threads.context.messages.at(-1).status === 'complete', '收藏后追问保存');
    assert.equal((await stored(firstNew)).saved, true);
    await field('question', '语境未发送草稿专用针');
    await click('独立释义', '[role="tab"]');
    await visible(`document.querySelector('[data-field="question"]')?.dataset.mode === 'independent'`);
    await field('question', '独立未发送草稿专用针');
    await click('语境解释', '[role="tab"]');
    await visible(`document.querySelector('[data-field="question"]')?.dataset.mode === 'context'`);
    await visible(`document.querySelector('[data-field="question"]')?.value === '语境未发送草稿专用针'`);
    await click('历史');
    await search('收藏后继续追问专用针', 1);
    await click('取消收藏');
    await click('手动收藏', '[role="tab"]');
    await count(0);
    await click('全部会话', '[role="tab"]');
    await count(1);
    assert.equal((await stored(firstNew)).threads.context.messages[1].content, '收藏后继续追问专用针');
    report.checks.push('收藏后继续追问仍在同一会话，取消收藏后完整历史可搜索重开');

    await search('不存在的筛选针', 0);
    assert.equal((await ids()).length, 57);
    await search('未显示模式专用针', 1);
    assert.equal(await ui(`document.documentElement.scrollWidth > innerWidth`), false);
    await click('改名');
    assert.equal(await ui(`document.documentElement.scrollWidth > innerWidth`), false);
    const screenshotResult = await browser.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await fs.mkdir(artifactRoot, { recursive: true });
    const screenshotPath = path.join(artifactRoot, '工单13-正式历史小窗.png');
    await fs.writeFile(screenshotPath, Buffer.from(screenshotResult.data, 'base64'), exclusive ? { flag: 'wx' } : undefined);
    report.screenshot = screenshotPath;
    report.checks.push('无搜索结果和界面分页不删磁盘记录，300 像素搜索、筛选、改名状态无横向溢出');

    assert.equal(await fs.readFile(oldUnanswered.file, 'utf8'), oldUnanswered.bytes);
    await ui(`(() => { void window.pickgloss.invoke('quit'); return true; })()`);
    browser.socket.close();
    await until(() => child.exitCode !== null, '隔离实例正常退出');
    ui = await launch();
    await until(() => ui(`Boolean(document.querySelector('[data-field="paste-text"]'))`), '重启后正式界面');
    assert.equal(requests.length, 2, '重启不能自动请求模型');
    await ui(`[...document.querySelectorAll('button')].find(item => item.textContent.trim() === '历史')?.click()`);
    await until(() => ui(`document.querySelector('.history-count')?.textContent === '57 个会话'`), '重启后历史');
    await ui(`(() => { const input = document.querySelector('[data-field="history-search"]'); input.value = '流式期间改好的标题'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await until(() => ui(`document.querySelector('.history-count')?.textContent === '1 个会话'`), '重启后查找标题');
    assert.equal(await ui(`document.querySelector('.history-title')?.textContent`), '流式期间改好的标题');
    await ui(`document.querySelector('.history-item .history-main')?.click()`);
    await until(() => ui(`document.body.textContent.includes('收藏后继续追问专用针')`), '重启后重开问答');
    assert.equal(await ui(`document.querySelector('.selected-word')?.textContent`), 'compound 会话整理样本');
    assert.equal(await ui(`document.querySelector('[data-field="question"]')?.value`), '语境未发送草稿专用针');
    await ui(`[...document.querySelectorAll('[role="tab"]')].find(item => item.textContent.trim() === '独立释义')?.click()`);
    await until(() => ui(`document.querySelector('[data-field="question"]')?.value === '独立未发送草稿专用针'`), '重启后独立模式草稿');
    assert.equal((await stored(firstNew)).threads.context.messages.length, 3);
    assert.equal((await stored(oldUnanswered.id)).lastActivityAt, undefined);
    await ui(`[...document.querySelectorAll('button')].find(item => item.textContent.trim() === '历史')?.click()`);
    await until(() => ui(`Boolean(document.querySelector('[data-field="history-search"]'))`), '重启后再次进入历史');
    await ui(`(() => { const input = document.querySelector('[data-field="history-search"]'); input.value = '截图说明专用针'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await until(() => ui(`document.querySelector('.history-count')?.textContent === '1 个会话'`), '重启后查找截图');
    await ui(`document.querySelector('.history-item .history-main')?.click()`);
    await until(() => ui(`Boolean(document.querySelector('.preview-image')) && document.body.textContent.includes('截图回答专用针')`), '重启后截图及回答');
    report.checks.push('正常退出并重启同一隔离目录，标题、材料、截图、双模式草稿和问答留存，重启未发新请求');
    report.requestCount = requests.length;
    report.finalDiskCount = (await ids()).length;
    report.legacyAnsweredOriginalSha256 = digest(oldAnswered.bytes);
    report.legacyUnansweredOriginalSha256 = digest(oldUnanswered.bytes);
    const reportPath = path.join(artifactRoot, '工单13-隔离贯通结果.json');
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2), exclusive ? { encoding: 'utf8', flag: 'wx' } : 'utf8');
    console.log(`会话管理隔离贯通通过：${manifest.candidateId}；${report.checks.length} 组检查；报告 ${reportPath}`);
  } finally {
    browser?.socket.close();
    if (child?.pid && child.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' });
    if (heldResponse && !heldResponse.writableEnded) heldResponse.end();
    await close(server);
  }
}

function parseCommandLine(args) {
  const human = args[0] === '--prepare-human';
  const packageArgument = args[human ? 1 : 0];
  if (!packageArgument || packageArgument.startsWith('--')) throw new Error('请指定候选包目录。');
  const options = args.slice(human ? 2 : 1);
  let outputArgument;
  if (options.length === 1 && options[0].startsWith('--output-dir=')) outputArgument = options[0].slice('--output-dir='.length);
  else if (options.length === 2 && options[0] === '--output-dir') outputArgument = options[1];
  else if (options.length) throw new Error('可选参数仅支持 --output-dir=<绝对目录> 或 --output-dir <绝对目录>。');
  if (outputArgument !== undefined && !path.isAbsolute(outputArgument)) throw new Error('独立输出目录必须使用绝对路径。');
  const output = path.resolve(packageArgument);
  const artifactRoot = outputArgument === undefined ? defaultArtifactRoot : path.resolve(outputArgument);
  if (outputArgument !== undefined && artifactRoot.toLowerCase() === path.resolve(defaultArtifactRoot).toLowerCase()) {
    throw new Error('独立输出目录不能与旧报告目录相同。');
  }
  if (outputArgument !== undefined && (artifactRoot.toLowerCase() === output.toLowerCase() ||
      artifactRoot.toLowerCase().startsWith(`${output.toLowerCase()}${path.sep}`))) {
    throw new Error('独立输出目录不能位于候选包目录内。');
  }
  return { human, output, artifactRoot, exclusive: outputArgument !== undefined };
}

const task = Promise.resolve().then(() => {
  const { human, output, artifactRoot, exclusive } = parseCommandLine(process.argv.slice(2));
  return human ? prepareHuman(output, artifactRoot, exclusive) : run(output, artifactRoot, exclusive);
});
task.catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
