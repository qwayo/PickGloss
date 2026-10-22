'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const selectedText = 'compound';
const contextText = 'Small discoveries compound over time.';
const questionText = '请再给出一个简短例句。';
const answers = ['本机验证回答：这里表示逐步积累。', '本机验证追问：Small gains compound.'];
const fakeKey = 'pickgloss-ticket-12-fake-key';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = async (check, title, ms = 20000) => {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { const value = await check(); if (value) return value; }
    catch (error) { last = error; }
    await wait(180);
  }
  throw new Error(`${title} 超时。${last?.message || ''}`);
};
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise(resolve => server.close(resolve));
async function freePort() {
  const server = http.createServer();
  await listen(server);
  const port = server.address().port;
  await close(server);
  return port;
}

async function connect(port) {
  const target = await deadline(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    const tabs = await response.json();
    return tabs.find(item => item.type === 'page' && item.url.includes('/src/renderer/index.html'));
  }, '正式界面调试目标');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
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

async function run(output) {
  const manifest = JSON.parse(await fs.readFile(path.join(output, 'candidate-manifest.json'), 'utf8'));
  const packageDirectory = path.join(output, manifest.packageDirectory);
  const executable = path.join(packageDirectory, 'PickGloss.exe');
  await fs.access(executable);
  const isolated = path.join(os.tmpdir(), `pickgloss-verification-${randomUUID()}`);
  const requests = [];
  const server = http.createServer(async (request, response) => {
    try {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/chat/completions');
      assert.equal(request.headers.authorization, `Bearer ${fakeKey}`);
      assert.equal(body.model, '本机验证模型');
      requests.push(body);
      const answer = answers[requests.length - 1];
      assert.ok(answer, '只接受本轮两个主动请求');
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\n`);
      response.end('data: [DONE]\n\n');
    } catch {
      response.writeHead(400);
      response.end('本机测试请求无效');
    }
  });
  await listen(server);
  const port = server.address().port, debugPort = await freePort();
  let child, browser;
  try {
    const launchArgs = [`--verification-data-dir=${isolated}`, `--remote-debugging-port=${debugPort}`];
    child = spawn(executable, launchArgs, { cwd: packageDirectory, windowsHide: true, stdio: 'ignore' });
    browser = await connect(debugPort);
    const ui = browser.evaluate;
    const visible = expression => deadline(() => ui(expression), '界面状态');
    const field = async (name, value) => {
      const result = await ui(`(() => { const input = document.querySelector(${JSON.stringify(`[data-field="${name}"]`)}); if (!input) return false; input.value = ${JSON.stringify(value)}; input.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
      assert.equal(result, true, `未找到界面字段：${name}`);
    };
    const click = async (label, selector = 'button') => {
      const result = await ui(`(() => { const button = [...document.querySelectorAll(${JSON.stringify(selector)})].find(item => item.textContent.trim() === ${JSON.stringify(label)} || item.getAttribute('aria-label') === ${JSON.stringify(label)} || item.getAttribute('title') === ${JSON.stringify(label)}); if (!button || button.disabled) return false; button.click(); return true; })()`);
      assert.equal(result, true, `未找到可点击入口：${label}`);
    };
    await visible(`Boolean(document.querySelector('[data-field="paste-text"]'))`);
    assert.equal((await ui(`window.pickgloss.invoke('open-latest-session')`)).ok, true);
    await visible(`Boolean(document.querySelector('[data-field="paste-text"]'))`);
    await click('截图框选');
    await visible(`document.body.textContent.includes('隔离验证模式不会读取实际屏幕')`);
    await field('paste-text', selectedText);
    await field('paste-context', contextText);
    await click('开始解释');
    await visible(`Boolean(document.querySelector('.selected-word'))`);
    await visible(`document.body.textContent.includes('配置文字模型后继续')`);
    const sessionRoot = path.join(isolated, 'data', 'sessions');
    const sessions = await deadline(async () => { const entries = await fs.readdir(sessionRoot); return entries.length === 1 ? entries : null; }, '无配置材料落盘');
    assert.equal(requests.length, 0, '无配置时不得发送请求');
    await click('配置 AI 服务');
    await visible(`Boolean(document.querySelector('[data-field="text-baseUrl"]'))`);
    await field('text-baseUrl', `http://127.0.0.1:${port}/v1`);
    await field('text-model', '本机验证模型');
    await field('text-apiKey', fakeKey);
    await click('保存设置');
    await visible(`document.body.textContent.includes('开始释义')`);
    await click('开始释义');
    await deadline(() => requests.length === 1, '首轮本机解释请求');
    await visible(`document.body.textContent.includes(${JSON.stringify(answers[0])}) && !document.body.textContent.includes('正在解释…')`);
    await click('会话历史');
    await visible(`Boolean(document.querySelector('.history-item'))`);
    await click('新建');
    await visible(`Boolean(document.querySelector('[data-field="paste-text"]'))`);
    await field('paste-text', '第二条隔离会话');
    await click('开始解释');
    await visible(`document.querySelector('.selected-word')?.textContent === '第二条隔离会话'`);
    assert.equal(requests.length, 1, '缺少上下文的第二条材料不应自动请求');
    await click('会话历史');
    await visible(`document.querySelectorAll('.history-item').length === 2`);
    assert.equal(await ui(`document.querySelector('.history-item .history-title')?.textContent`), '第二条隔离会话');
    assert.equal(await ui(`(() => { const item = [...document.querySelectorAll('.history-item')].find(entry => entry.textContent.includes(${JSON.stringify(selectedText)})); item?.querySelector('.history-main')?.click(); return Boolean(item); })()`), true);
    await visible(`document.querySelector('.selected-word')?.textContent === ${JSON.stringify(selectedText)}`);
    await field('question', questionText);
    await click('发送追问');
    await deadline(() => requests.length === 2, '本机追问请求');
    await visible(`document.body.textContent.includes(${JSON.stringify(answers[1])}) && !document.body.textContent.includes('正在解释…')`);
    await click('关闭窗口');
    await visible(`document.visibilityState === 'hidden'`);
    const second = spawnSync(executable, [`--verification-data-dir=${isolated}`], { cwd: packageDirectory, windowsHide: true, timeout: 15000, encoding: 'utf8' });
    assert.equal(second.status, 0, second.stderr || '第二次启动未能唤回隔离窗口');
    await visible(`document.visibilityState === 'visible'`);
    await click('会话历史');
    await visible(`document.querySelectorAll('.history-item').length === 2`);
    assert.equal(await ui(`document.querySelector('.history-item .history-title')?.textContent`), selectedText, '新追问后应按问答活动把本会话排在前面');
    assert.equal(await ui(`Boolean(document.querySelector('[data-field="history-search"]') && document.querySelector('button[aria-label="修改标题"]') && document.querySelector('button[aria-label="刷新历史"]'))`), true, '候选包应包含查找、改名、刷新入口');
    await click(`打开会话：${selectedText}`, '.history-item .history-main');
    await visible(`Boolean(document.querySelector('.selected-word'))`);
    assert.equal(await ui(`document.querySelector('.selected-word')?.textContent`), selectedText);
    assert.equal(await ui(`document.querySelector('.conversation')?.textContent.includes(${JSON.stringify(answers[0])}) && document.querySelector('.conversation')?.textContent.includes(${JSON.stringify(answers[1])})`), true);
    assert.equal(requests.length, 2, '历史重开不应自动请求模型');
    // 先让旧会话成为当前会话，再打开一个筛空的历史页；入口仍应取全局最新活动。
    const older = await ui(`window.pickgloss.invoke('bootstrap').then(r=>r.value.history.find(s=>s.text==='第二条隔离会话').id)`);
    await ui(`window.pickgloss.invoke('open-session',{id:${JSON.stringify(older)}})`);
    await ui(`window.pickgloss.invoke('search-history',{query:'不存在的筛选',savedOnly:true})`);
    assert.equal((await ui(`window.pickgloss.invoke('open-latest-session')`)).ok, true);
    await visible(`document.querySelector('.selected-word')?.textContent === ${JSON.stringify(selectedText)}`);
    assert.equal(requests.length, 2, '打开最新会话不得重发模型请求');

    const firstPayload = JSON.stringify(requests[0].messages);
    const secondPayload = JSON.stringify(requests[1].messages);
    assert.ok(firstPayload.includes(selectedText) && firstPayload.includes(contextText));
    assert.ok(secondPayload.includes(questionText) && secondPayload.includes(answers[0]));
    const stored = JSON.parse(await fs.readFile(path.join(sessionRoot, sessions[0], 'session.json'), 'utf8'));
    assert.equal(stored.text, selectedText);
    assert.equal(stored.context, contextText);
    assert.deepEqual(stored.threads.context.messages.map(item => item.content), [answers[0], questionText, answers[1]]);
    const settings = await fs.readFile(path.join(isolated, 'data', 'settings.json'), 'utf8');
    assert.equal(settings.includes(fakeKey), false, '虚构 Key 也应加密落盘');
    const report = { candidateId: manifest.candidateId, sourceFingerprint: manifest.sourceFingerprint,
      packageFingerprint: manifest.packageFingerprint, runAt: new Date().toISOString(), isolatedDirectory: isolated,
      executable, checked: ['隔离模式阻止读取实际屏幕', '正式界面接纳材料并保存', '无配置时不发送请求', '正式界面设置本机服务与虚构密钥',
        'preload 与主进程发出解释及追问请求', '关闭窗口后由第二次启动唤回', '历史重开保留材料及回答且不自动请求',
        '包内改名、完整搜索和刷新入口可达', '新增问答后按活动时间排序', '最新会话入口忽略筛选、不重发请求、空历史回到文字识别', '实际隔离存储与界面一致', '虚构密钥未明文落盘'],
      requestCount: requests.length, material: { text: selectedText, context: contextText, question: questionText },
      answers, realProvider: false, realClipboardAccess: false, realSessionAccess: false, nativeSelectionEnabled: false };
    const reportPath = path.join(output, '隔离贯通结果.json');
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
    console.log(`隔离贯通通过：${manifest.candidateId}；本机请求 ${requests.length} 次；报告 ${reportPath}`);
  } finally {
    browser?.socket.close();
    if (child?.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' });
    await close(server);
  }
}

run(path.resolve(process.argv[2] || '')).catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
