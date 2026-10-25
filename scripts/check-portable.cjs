'use strict';
const { quoteJavaScriptString } = require('./javascript-string.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { createUiDriver } = require('./ui-driver.cjs');

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
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('界面调试通道响应超时（内容已隐藏）')); }, 12000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error('界面操作失败（异常内容已隐藏）。');
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
  let child, browser, driver;
  try {
    const launchArgs = [`--verification-data-dir=${isolated}`, `--remote-debugging-port=${debugPort}`];
    child = spawn(executable, launchArgs, { cwd: packageDirectory, windowsHide: true, stdio: 'ignore' });
    browser = await connect(debugPort);
    const ui = browser.evaluate;
    driver = createUiDriver(ui);
    const visible = (expression, expected = '目标界面状态') => driver.waitFor(expression, expected, { allowErrors: true });
    const field = async (name, value) => {
      const result = await ui(`(() => { const input = document.querySelector(${quoteJavaScriptString(`[data-field="${name}"]`)}); if (!input) return false; input.value = ${quoteJavaScriptString(value)}; input.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
      assert.equal(result, true, `未找到界面字段：${name}`);
    };
    const click = (label, selector = 'button') => driver.click(label, { selector, stage: selector === '.history-item .history-main' ? '打开测试会话' : `点击${label}` });
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
    await driver.click('配置 AI 服务', { scope: '.panel-footer', stage: '打开 AI 服务设置' });
    await visible(`Boolean(document.querySelector('[data-field="text-baseUrl"]'))`);
    // 隔离模式也检查未选中的厂商草稿；所有预设仅使用本机测试地址。
    await ui(`(() => {
      for (const kind of ['text', 'vision', 'search']) {
        const select = document.querySelector('[name="' + kind + '-provider"]'), original = select.value;
        for (const option of [...select.options]) {
          select.value = option.value; select.dispatchEvent(new Event('change', { bubbles: true }));
          const input = document.querySelector('[name="' + kind + '-baseUrl"]');
          input.value = 'http://127.0.0.1:${port}/v1'; input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        select.value = original; select.dispatchEvent(new Event('change', { bubbles: true }));
      }
    })()`);
    await field('text-baseUrl', `http://127.0.0.1:${port}/v1`);
    await field('text-model', '本机验证模型');
    await field('text-apiKey', fakeKey);
    // 失败注入走真实 preload 和主进程校验；拒绝非本机地址发生在网络请求之前。
    const injectedFailure = process.argv.includes('--inject-save-failure');
    if (injectedFailure) await field('text-baseUrl', 'https://blocked.invalid/v1');
    await driver.click('保存设置', { scope: '[data-settings-section="service"]', stage: '保存服务设置' });
    if (injectedFailure) {
      await assert.rejects(driver.waitFor(`document.body.textContent.includes('开始释义')`, '保存成功后返回解释页'), error => {
        assert.match(error.message, /阶段=保存服务设置.*界面拒绝了操作.*隔离模式拒绝服务地址/);
        assert.doesNotMatch(error.message, /blocked\.invalid|fake-key|compound/);
        return true;
      });
      await wait(250);
      assert.equal(requests.length, 0, '保存失败后不得发送解释请求');
      await fs.writeFile(path.join(output, '保存失败注入结果.json'), JSON.stringify({ 通过: true, 阶段: '保存服务设置', 错误: '隔离模式拒绝服务地址', 后续解释请求数: requests.length }, null, 2), 'utf8');
      console.log('真实便携包保存失败注入通过：定位到保存服务设置阶段，错误已脱敏，后续请求为零。');
      return;
    }
    await driver.waitFor(`document.body.textContent.includes('开始释义')`, '保存成功后返回解释页', { stage: '保存服务设置' });
    await click('开始释义');
    await deadline(() => requests.length === 1, '首轮本机解释请求');
    await visible(`document.body.textContent.includes(${quoteJavaScriptString(answers[0])}) && !document.body.textContent.includes('正在解释…')`);
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
    assert.equal(await ui(`(() => { const item = [...document.querySelectorAll('.history-item')].find(entry => entry.textContent.includes(${quoteJavaScriptString(selectedText)})); item?.querySelector('.history-main')?.click(); return Boolean(item); })()`), true);
    await visible(`document.querySelector('.selected-word')?.textContent === ${quoteJavaScriptString(selectedText)}`);
    await field('question', questionText);
    await click('发送追问');
    await deadline(() => requests.length === 2, '本机追问请求');
    await visible(`document.body.textContent.includes(${quoteJavaScriptString(answers[1])}) && !document.body.textContent.includes('正在解释…')`);
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
    assert.equal(await ui(`document.querySelector('.conversation')?.textContent.includes(${quoteJavaScriptString(answers[0])}) && document.querySelector('.conversation')?.textContent.includes(${quoteJavaScriptString(answers[1])})`), true);
    assert.equal(requests.length, 2, '历史重开不应自动请求模型');
    // 先让旧会话成为当前会话，再打开一个筛空的历史页；入口仍应取全局最新活动。
    const older = await ui(`window.pickgloss.invoke('bootstrap').then(r=>r.value.history.find(s=>s.text==='第二条隔离会话').id)`);
    await ui(`window.pickgloss.invoke('open-session',{id:${quoteJavaScriptString(older)}})`);
    await ui(`window.pickgloss.invoke('search-history',{query:'不存在的筛选',savedOnly:true})`);
    assert.equal((await ui(`window.pickgloss.invoke('open-latest-session')`)).ok, true);
    await visible(`document.querySelector('.selected-word')?.textContent === ${quoteJavaScriptString(selectedText)}`);
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
  } catch (error) {
    const diagnostic = driver ? (await driver.diagnose('本阶段检查通过', '断言或操作失败').catch(() => new Error('界面调试通道不可用'))).message : '正式界面尚未连接';
    const safe = error.message.startsWith('界面检查失败：') ? error.message : `${diagnostic}；异常类型=${error.code || error.name}`;
    await fs.writeFile(path.join(output, '便携失败诊断.json'), JSON.stringify({ 通过: false, 诊断: safe }, null, 2), 'utf8');
    throw new Error(safe);
  } finally {
    browser?.socket.close();
    if (child?.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' });
    await close(server);
  }
}

run(path.resolve(process.argv[2] || '')).catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
