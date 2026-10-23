'use strict';

const { quoteJavaScriptString } = require('./javascript-string.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC1kAAAAASUVORK5CYII=';
const TEXT = '选定内容⟦TEXT⟧';
const PARAGRAPH = '可信段落⟦PARAGRAPH⟧';
const QUESTION = '触发截断⟦QUESTION⟧';
const DRAFT = '尚未发送⟦DRAFT⟧';
const NOTE = '截图说明⟦NOTE⟧';
const OUTSIDE = '框外材料⟦OUTSIDE⟧';
const TEXT_KEY = 'fictional-portable-text-key';
const VISION_KEY = 'fictional-portable-vision-key';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(check, title, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try { const value = await check(); if (value) return value; } catch (error) { last = error; }
    await pause(120);
  }
  throw new Error(`${title} 超时。${last?.message || ''}`);
}

async function freePort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function assertNoExistingInstance() {
  const result = spawnSync('powershell', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process -Filter "Name=\'PickGloss.exe\'" | Select-Object -ExpandProperty ProcessId'],
    { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(result.status, 0, result.stderr || '无法检查现有拾译实例');
  assert.equal(result.stdout.trim(), '', '检测到正在运行的 PickGloss.exe；已跳过以保护现有实例');
}

async function connect(port) {
  const tab = await until(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    const pages = await response.json();
    return pages.find(item => item.type === 'page' && item.url.includes('/src/renderer/index.html'));
  }, '正式界面调试目标');
  const socket = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let id = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const data = JSON.parse(event.data);
    if (!pending.has(data.id)) return;
    const task = pending.get(data.id); pending.delete(data.id);
    if (data.error) task.reject(new Error(data.error.message)); else task.resolve(data.result);
  });
  const evaluate = expression => new Promise((resolve, reject) => {
    const serial = ++id; pending.set(serial, { resolve, reject });
    socket.send(JSON.stringify({ id: serial, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  }).then(result => {
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || '正式界面执行失败');
    return result.result?.value;
  });
  return { socket, evaluate };
}

function uiActions(evaluate) {
  const visible = (expression, title) => until(() => evaluate(expression), title);
  const field = async (name, value) => {
    const expression = `(() => { const input = document.querySelector(${quoteJavaScriptString(`[data-field="${name}"]`)}); if (!input) return false; input.value = ${quoteJavaScriptString(value)}; input.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`;
    assert.equal(await evaluate(expression), true, `未找到字段：${name}`);
  };
  const click = async (label, selector = 'button') => {
    const expression = `(() => { const node = [...document.querySelectorAll(${quoteJavaScriptString(selector)})].find(item => item.getClientRects().length && !item.disabled && (item.textContent.trim() === ${quoteJavaScriptString(label)} || item.getAttribute('aria-label') === ${quoteJavaScriptString(label)} || item.getAttribute('title') === ${quoteJavaScriptString(label)})); if (!node) return false; node.click(); return true; })()`;
    await until(() => evaluate(expression), `可点击入口：${label}`);
  };
  return { visible, field, click };
}

async function run(output) {
  const manifest = JSON.parse(await fs.readFile(path.join(output, 'candidate-manifest.json'), 'utf8'));
  const packageDirectory = path.join(output, manifest.packageDirectory);
  const executable = path.join(packageDirectory, 'PickGloss.exe');
  await fs.access(executable);
  const verified = spawnSync(process.execPath, [path.join(__dirname, 'verify-package.cjs'), output], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  assert.equal(verified.status, 0, verified.stderr || verified.stdout);
  assertNoExistingInstance();

  const { createStore } = require(path.join(packageDirectory, 'resources', 'app', 'src', 'core', 'store.cjs'));
  const isolated = path.join(os.tmpdir(), `pickgloss-verification-${randomUUID()}`);
  await fs.mkdir(isolated);
  await fs.writeFile(path.join(isolated, 'verification.marker'), 'PickGloss 隔离验证目录\n', { flag: 'wx' });
  const store = createStore({ directory: path.join(isolated, 'data') });
  await store.init();
  const image = await store.createSession({ kind: 'image', imageData: IMAGE, note: NOTE,
    source: { app: '隔离样本', title: OUTSIDE, method: '预置的裁剪 PNG' } });
  const requests = { text: [], vision: [] };
  let truncated = false, failVision = false;
  const makeServer = channel => http.createServer(async (request, response) => {
    try {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/chat/completions');
      assert.equal(request.headers.authorization, `Bearer ${channel === 'text' ? TEXT_KEY : VISION_KEY}`);
      requests[channel].push({ body, authorization: request.headers.authorization });
      const serialized = JSON.stringify(body.messages);
      if (channel === 'text' && serialized.includes(QUESTION) && !truncated) {
        truncated = true;
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.end('data: {"choices":[{"delta":{"content":"未完成片段⟦PARTIAL⟧"}}]}\n\n');
        return;
      }
      if (channel === 'vision' && failVision) {
        failVision = false;
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end('{"error":{"message":"本机受控图片失败"}}');
        return;
      }
      const prompt = body.messages[0]?.content;
      const answer = typeof prompt === 'string' && prompt.includes('当前任务是语境解释') ? `语境回答⟦${requests[channel].length}⟧`
        : typeof prompt === 'string' && prompt.includes('当前任务是独立释义') ? '独立回答⟦INDEPENDENT⟧'
          : channel === 'vision' ? '独立识图回答⟦VISION⟧' : '本机文字服务回答⟦TEXT-SERVICE⟧';
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: answer }, finish_reason: 'stop' }] })}\n\n`);
    } catch {
      response.writeHead(400); response.end('本机测试请求无效');
    }
  });
  const textService = makeServer('text'), visionService = makeServer('vision');
  await Promise.all([textService, visionService].map(server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))));
  const textBase = `http://127.0.0.1:${textService.address().port}/v1`;
  const visionBase = `http://127.0.0.1:${visionService.address().port}/v1`;
  const readSession = id => fs.readFile(path.join(isolated, 'data', 'sessions', id, 'session.json'), 'utf8').then(JSON.parse);
  const report = { candidateId: manifest.candidateId, sourceFingerprint: manifest.sourceFingerprint,
    packageFingerprint: manifest.packageFingerprint, executable, isolatedDirectory: isolated,
    runAt: new Date().toISOString(), checks: [], realProvider: false,
    evidenceBoundary: '正式便携包与正式 renderer、preload、主进程、隔离存储及本机受控服务；截图会话为预置裁剪 PNG，未调用真实截图或模型。' };
  let child, browser;
  const launch = async () => {
    const debugPort = await freePort();
    child = spawn(executable, [`--verification-data-dir=${isolated}`, `--remote-debugging-port=${debugPort}`],
      { cwd: packageDirectory, windowsHide: true, stdio: 'ignore' });
    browser = await connect(debugPort);
    return uiActions(browser.evaluate);
  };
  try {
    let ui = await launch();
    await ui.visible(`Boolean(document.querySelector('[data-field="paste-text"]'))`, '正式粘贴界面');
    await ui.field('paste-text', TEXT);
    await ui.field('paste-context', PARAGRAPH);
    await ui.click('开始解释');
    await ui.visible(`document.querySelector('.selected-word')?.textContent === ${quoteJavaScriptString(TEXT)}`, '已接纳文字会话');
    const textId = await until(async () => {
      const entries = await fs.readdir(path.join(isolated, 'data', 'sessions'));
      return entries.find(id => id !== image.id);
    }, '文字材料落盘');
    assert.equal(requests.text.length + requests.vision.length, 0);
    report.checks.push('正式粘贴接纳材料先落盘，无配置时不出站');

    await ui.click('配置 AI 服务');
    await ui.visible(`Boolean(document.querySelector('[data-field="text-baseUrl"]'))`, '正式服务设置');
    await ui.field('text-baseUrl', textBase);
    await ui.field('text-model', '虚构文字模型');
    await ui.field('text-apiKey', TEXT_KEY);
    await ui.click('识图模型', '[role="tab"]');
    await ui.field('vision-baseUrl', visionBase);
    await ui.field('vision-apiKey', VISION_KEY);
    await ui.click('文字模型', '[role="tab"]');
    await ui.click('测试连接', '[data-provider="text"] button');
    await until(() => requests.text.length === 1, '当前文字表单测试请求');
    await ui.visible(`document.querySelector('[data-provider="text"] .test-result')?.textContent.includes('测试请求成功')`, '文字表单测试成功');
    await ui.click('识图模型', '[role="tab"]');
    await ui.click('测试连接', '[data-provider="vision"] button');
    await until(() => requests.text.length === 2, '沿用当前文字表单的小图测试');
    await ui.visible(`document.querySelector('[data-provider="vision"] .test-result')?.textContent.includes('已使用文字模型')`, '沿用文字模型的小图测试成功');
    assert.equal(requests.vision.length, 0);
    assert.equal(requests.text[1].body.model, '虚构文字模型');
    assert.ok(requests.text[1].body.messages[0].content.some(part => part.type === 'image_url'));
    await ui.click('保存设置');
    await ui.visible(`document.body.textContent.includes('开始释义')`, '保存设置后恢复文字会话');
    const settings = await fs.readFile(path.join(isolated, 'data', 'settings.json'), 'utf8');
    assert.ok(!settings.includes(TEXT_KEY) && !settings.includes(VISION_KEY));
    report.checks.push('正式表单文字短文字与空白识图模型的小图测试均到文字服务，残留识图地址和 Key 不参与请求，虚构 Key 不明文落盘');

    await ui.click('开始释义');
    await until(async () => (await readSession(textId)).threads.context.status === 'done', '语境解释完成');
    const contextFirst = JSON.stringify(requests.text.at(-1).body.messages);
    assert.ok(contextFirst.includes(TEXT) && contextFirst.includes(PARAGRAPH));
    assert.ok(!contextFirst.includes(NOTE) && !contextFirst.includes(OUTSIDE));
    await ui.field('question', DRAFT);
    await ui.click('重新解释');
    await until(() => requests.text.length === 4, '主动重新解释');
    await until(async () => {
      const thread = (await readSession(textId)).threads.context;
      return thread.status === 'done' && thread.messages.filter(message => message.role === 'assistant').length === 2;
    }, '重新解释完成');
    assert.equal(await browser.evaluate(`document.querySelector('[data-field="question"]')?.value`), DRAFT);
    assert.ok(!JSON.stringify(requests.text[3].body.messages).includes(DRAFT));
    report.checks.push('语境出站只含选定内容与可信段落；重新解释追加回答且未发送追问草稿保留、不出站');

    await ui.field('question', QUESTION);
    await ui.click('发送追问');
    await until(() => requests.text.length === 5, '失败追问请求');
    await ui.visible(`document.body.textContent.includes('这次请求没有完成')`, '截断提示');
    await until(async () => (await readSession(textId)).threads.context.messages.at(-1)?.status === 'error', '截断片段落盘');
    assert.equal((await readSession(textId)).threads.context.messages.at(-1).content, '未完成片段⟦PARTIAL⟧');
    await ui.click('重试');
    await until(() => requests.text.length === 6, '手动重试请求');
    await until(async () => {
      const thread = (await readSession(textId)).threads.context;
      return thread.status === 'done' && thread.messages.filter(message => message.role === 'assistant').length === 4;
    }, '重试回答落盘');
    const retry = JSON.stringify(requests.text[5].body.messages);
    assert.equal(retry.split(QUESTION).length - 1, 1);
    assert.ok(!retry.includes('未完成片段⟦PARTIAL⟧'));
    report.checks.push('本机截断保留已收片段、无后台重发；手动重试不重复追加追问、不把未完成回答当完整依据');

    await ui.click('独立释义', '[role="tab"]');
    assert.equal(requests.text.length, 6);
    await ui.click('开始释义');
    await until(() => requests.text.length === 7, '独立释义请求');
    await until(async () => (await readSession(textId)).threads.independent.status === 'done', '独立释义回答落盘');
    const independent = JSON.stringify(requests.text[6].body.messages);
    assert.ok(independent.includes(TEXT));
    assert.ok(!independent.includes(PARAGRAPH) && !independent.includes(QUESTION) && !independent.includes(DRAFT));
    assert.ok(!independent.includes('语境回答') && !independent.includes('未完成片段'));
    report.checks.push('首次切换独立释义不自动请求，主动开始后不携带语境段落、历史或未发送草稿');

    await ui.click('历史');
    await ui.visible(`Boolean(document.querySelector('[data-field="history-search"]'))`, '正式历史界面');
    await ui.field('history-search', NOTE);
    await ui.visible(`document.querySelectorAll('.history-item').length === 1`, '预置截图会话搜索结果');
    await ui.click('打开会话', '.history-item .history-main');
    await ui.visible(`Boolean(document.querySelector('.preview-image'))`, '截图会话正式界面');
    assert.equal(await browser.evaluate(`document.querySelector('.panel-footer .provider')?.textContent`), '虚构文字模型');
    await ui.click('解释截图');
    await until(() => requests.text.length === 8, '沿用文字服务的截图解释');
    await until(async () => (await readSession(image.id)).threads.visual.status === 'done', '截图解释落盘');
    const visual = JSON.stringify(requests.text[7].body.messages);
    assert.equal(requests.text[7].body.model, '虚构文字模型');
    assert.ok(visual.includes(IMAGE) && visual.includes(NOTE));
    assert.ok(!visual.includes(TEXT) && !visual.includes(PARAGRAPH) && !visual.includes(OUTSIDE));
    await ui.field('question', '截图追问⟦IMAGE-Q⟧');
    await ui.click('发送追问');
    await until(() => requests.text.length === 9, '沿用文字服务的截图追问');
    await until(async () => {
      const thread = (await readSession(image.id)).threads.visual;
      return thread.status === 'done' && thread.messages.filter(message => message.role === 'assistant').length === 2;
    }, '截图追问落盘');
    assert.ok(JSON.stringify(requests.text[8].body.messages).includes('截图追问⟦IMAGE-Q⟧'));
    report.checks.push('正式截图会话沿用文字地址、模型和 Key；实际出站仅含预置裁剪 PNG、说明及截图模式历史，不含文字会话或框外元数据');

    await ui.click('虚构文字模型', '.panel-footer button');
    await ui.click('识图模型', '[role="tab"]');
    await ui.field('vision-model', '独立识图模型');
    await ui.click('测试连接', '[data-provider="vision"] button');
    await until(() => requests.vision.length === 1, '独立识图当前表单小图测试');
    await ui.visible(`document.querySelector('[data-provider="vision"] .test-result')?.textContent.includes('测试请求成功')`, '独立识图小图测试成功');
    assert.equal(requests.vision[0].body.model, '独立识图模型');
    await ui.click('保存设置');
    await ui.visible(`document.querySelector('.panel-footer .provider')?.textContent === '独立识图模型'`, '正式界面实际模型名称');
    failVision = true;
    await ui.click('重新解释');
    await until(() => requests.vision.length === 2, '独立识图失败请求');
    await ui.visible(`document.body.textContent.includes('这次请求没有完成')`, '独立识图失败提示');
    assert.equal(requests.text.length, 9, '独立识图失败不能改发文字服务');
    assert.equal((await fs.readFile(path.join(isolated, 'data', 'sessions', image.id, 'crop.png'))).toString('base64'), IMAGE.split(',')[1]);
    await ui.click('重试');
    await until(() => requests.vision.length === 3, '独立识图手动重试');
    await until(async () => {
      const thread = (await readSession(image.id)).threads.visual;
      return thread.status === 'done' && thread.messages.filter(message => message.role === 'assistant').length === 4;
    }, '独立识图重试落盘');
    assert.equal(requests.vision[2].authorization, `Bearer ${VISION_KEY}`);
    assert.equal(requests.text.length, 9);
    report.checks.push('独立识图表单小图测试、实际模型显示、失败提示与材料保留；重试仍只发独立地址、模型及 Key');

    const beforeReopen = requests.text.length + requests.vision.length;
    await ui.click('历史');
    await ui.visible(`Boolean(document.querySelector('[data-field="history-search"]'))`, '历史中的截图搜索框');
    await ui.field('history-search', NOTE);
    await ui.visible(`document.querySelectorAll('.history-item').length === 1`, '历史中的截图会话');
    await ui.click('打开会话', '.history-item .history-main');
    await ui.visible(`document.body.textContent.includes('独立识图回答⟦VISION⟧')`, '历史重开后的识图回答');
    assert.equal(requests.text.length + requests.vision.length, beforeReopen);
    await browser.evaluate(`(() => { void window.pickgloss.invoke('quit'); return true; })()`);
    browser.socket.close();
    await until(() => child.exitCode !== null, '隔离实例正常退出');
    assertNoExistingInstance();
    ui = await launch();
    await ui.visible(`Boolean(document.querySelector('[data-field="paste-text"]'))`, '重启后的正式界面');
    await ui.click('历史');
    await ui.visible(`Boolean(document.querySelector('[data-field="history-search"]'))`, '重启后的截图搜索框');
    await ui.field('history-search', NOTE);
    await ui.visible(`document.querySelectorAll('.history-item').length === 1`, '重启后截图历史');
    await ui.click('打开会话', '.history-item .history-main');
    await ui.visible(`document.body.textContent.includes('独立识图回答⟦VISION⟧')`, '重启后截图回答');
    assert.equal(requests.text.length + requests.vision.length, beforeReopen);
    report.checks.push('正式包历史重开和正常退出后重启恢复截图材料与回答，均不自动发新请求');
    await browser.evaluate(`(() => { void window.pickgloss.invoke('quit'); return true; })()`);
    browser.socket.close();
    await until(() => child.exitCode !== null, '第二次隔离实例正常退出');

    report.requestCount = { text: requests.text.length, vision: requests.vision.length };
    report.sessionIds = { text: textId, image: image.id };
    const artifactRoot = path.join(__dirname, '..', 'output', 'verification');
    await fs.mkdir(artifactRoot, { recursive: true });
    const artifact = path.join(artifactRoot, `工单15-正式包隔离贯通-${randomUUID()}.json`);
    await fs.writeFile(artifact, JSON.stringify(report, null, 2), { encoding: 'utf8', flag: 'wx' });
    console.log(`工单 #15 正式包隔离贯通通过：${manifest.candidateId}；${report.checks.length} 组；文字 ${report.requestCount.text} 次、识图 ${report.requestCount.vision} 次；报告 ${artifact}`);
  } finally {
    browser?.socket.close();
    if (child?.pid && child.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' });
    for (const server of [textService, visionService]) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  }
}

if (!process.argv[2]) {
  console.error('用法：node scripts/check-ai-portable.cjs <候选包产物目录>');
  process.exitCode = 2;
} else {
  run(path.resolve(process.argv[2])).catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
}
