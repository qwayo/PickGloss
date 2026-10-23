'use strict';

// 仅在用户提供本机密钥文件或 DPAPI 凭据后执行；对正式包、虚构样本和按量付费 MiMo 发起真实请求。
const { quoteJavaScriptString } = require('./javascript-string.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const BASE_URL = 'https://api.xiaomimimo.com/v1';
const MODEL = 'mimo-v2.6-flash';
const TEXT = 'compound';
const CONTEXT = 'Small improvements compound over time. A habit that seems minor today can become useful after months of practice.';
const NOTE = '请说明蓝色边框内可见的英文词，不要推测框外内容。';
const FOLLOW_UP = '这里的 compound 为什么不是化合物？请只根据给定段落回答。';
const IMAGE_FOLLOW_UP = '图片中英文词的拼写是什么？';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(check, title, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try { const result = await check(); if (result) return result; } catch (error) { last = error; }
    await pause(100);
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
  assert.equal(result.status, 0, '无法核对现有拾译实例。');
  assert.equal(result.stdout.trim(), '', '检测到正在运行的拾译，已停止以保护现有实例。');
}

async function connect(port) {
  const tab = await until(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    const pages = await response.json();
    return pages.find(item => item.type === 'page' && item.url.includes('/src/renderer/index.html') && item.url.includes('window=panel'));
  }, '正式界面调试目标');
  const socket = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let serial = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const data = JSON.parse(event.data);
    const task = pending.get(data.id);
    if (!task) return;
    pending.delete(data.id);
    if (data.error) task.reject(new Error(data.error.message));
    else task.resolve(data.result);
  });
  const evaluate = expression => new Promise((resolve, reject) => {
    const id = ++serial;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  }).then(result => {
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || '正式界面执行失败');
    return result.result?.value;
  });
  return { socket, evaluate };
}

function uiActions(evaluate) {
  const visible = (expression, title, timeoutMs) => until(() => evaluate(expression), title, timeoutMs);
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

function answerSummary(answer) {
  return {
    length: answer.length,
    sha256: createHash('sha256').update(answer).digest('hex'),
    excerpt: answer.slice(0, 500),
  };
}

async function run(candidateRoot) {
  const apiKey = process.env.MIMO_API_KEY?.trim();
  if (!apiKey) throw new Error('缺少 MIMO_API_KEY；尚未启动候选包或发出云端请求。');
  if (/[\r\n]/.test(apiKey)) throw new Error('API Key 格式无效；尚未发出云端请求。');
  const safeMessage = value => String(value || '').replaceAll(apiKey, '[已隐藏密钥]');
  const manifest = JSON.parse(await fs.readFile(path.join(candidateRoot, 'candidate-manifest.json'), 'utf8'));
  const packageDirectory = path.join(candidateRoot, manifest.packageDirectory);
  const executable = path.join(packageDirectory, 'PickGloss.exe');
  await fs.access(executable);
  const verified = spawnSync(process.execPath, [path.join(__dirname, 'verify-package.cjs'), candidateRoot],
    { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  assert.equal(verified.status, 0, '候选包内容核对失败，未发出云端请求。');
  assertNoExistingInstance();

  const { createStore } = require(path.join(packageDirectory, 'resources', 'app', 'src', 'core', 'store.cjs'));
  const isolated = path.join(os.tmpdir(), `pickgloss-mimo-${randomUUID()}`);
  const dataDirectory = path.join(isolated, 'PickGloss', 'data');
  await fs.mkdir(isolated);
  await fs.writeFile(path.join(isolated, 'mimo-verification.marker'), '拾译 MiMo 云端验收隔离目录\n', { flag: 'wx' });
  const store = createStore({ directory: dataDirectory });
  await store.init();
  await store.saveSettings({ prefs: { showOrb: false, selectionEnabled: false } });
  const textSession = await store.createSession({ kind: 'text', title: '复利段落', text: TEXT, context: CONTEXT,
    contextOrigin: '固定虚构样本', source: { app: '隔离样本', title: '复利段落', method: '预置文字材料' } });
  const png = await fs.readFile(path.join(__dirname, '..', 'tests', 'fixtures', 'mimo-fixed-crop.png'));
  const imageSession = await store.createSession({ kind: 'image', imageData: `data:image/png;base64,${png.toString('base64')}`,
    note: NOTE, source: { app: '隔离样本', title: '仅限虚构裁剪图', method: '预置裁剪 PNG' } });
  const readSession = id => fs.readFile(path.join(dataDirectory, 'sessions', id, 'session.json'), 'utf8').then(JSON.parse);
  const report = {
    runAt: new Date().toISOString(), candidateId: manifest.candidateId,
    sourceFingerprint: manifest.sourceFingerprint, packageFingerprint: manifest.packageFingerprint,
    executableSha256: createHash('sha256').update(await fs.readFile(executable)).digest('hex'),
    provider: '小米 MiMo 按量付费 API', baseUrl: BASE_URL, model: MODEL,
    sample: { text: TEXT, context: CONTEXT, imageSha256: createHash('sha256').update(png).digest('hex') },
    isolatedDirectory: isolated, scenarios: [],
    evidenceBoundary: '正式候选包正常模式、独立 LOCALAPPDATA、正式设置界面与固定虚构材料；预置 PNG 不证明实际截图框选。自动化检查不等于人工阅读体验或真人采集。',
  };
  let child, browser;
  const saveReport = async () => {
    const root = path.join(__dirname, '..', 'output', 'verification', 'mimo');
    await fs.mkdir(root, { recursive: true });
    const file = path.join(root, `工单15-MiMo真实请求-${randomUUID()}.json`);
    await fs.writeFile(file, JSON.stringify(report, null, 2).replaceAll(apiKey, '[已隐藏密钥]'), { encoding: 'utf8', flag: 'wx' });
    console.log(`验收报告：${file}`);
  };
  const measure = async (name, id, mode, trigger) => {
    const before = await readSession(id);
    const previousCount = before.threads[mode].messages.filter(message => message.role === 'assistant').length;
    const start = performance.now();
    await trigger();
    let firstVisibleMs = null, final;
    const limit = Date.now() + 75000;
    while (Date.now() < limit) {
      if (firstVisibleMs === null) {
        const content = await browser.evaluate(`(() => { const items = [...document.querySelectorAll('article.assistant .message-content')]; return items.length > ${previousCount} ? (items.at(-1)?.textContent || '') : ''; })()`);
        if (content?.trim() && content.trim() !== '正在解释…') firstVisibleMs = Math.round(performance.now() - start);
      }
      const current = await readSession(id);
      if (['done', 'error', 'stopped'].includes(current.threads[mode].status)) {
        const answers = current.threads[mode].messages.filter(message => message.role === 'assistant');
        if (answers.length > previousCount) { final = { current, answer: answers.at(-1) }; break; }
      }
      await pause(60);
    }
    const completedMs = Math.round(performance.now() - start);
    const result = final ? {
      name, status: final.current.threads[mode].status,
      answerStatus: final.answer.status, firstVisibleMs, completedMs,
      answer: answerSummary(final.answer.content),
      error: final.current.threads[mode].error || null,
    } : { name, status: 'timeout', firstVisibleMs, completedMs, error: '75 秒内未观察到会话终态。' };
    report.scenarios.push(result);
    if (result.status !== 'done' || result.answerStatus !== 'complete') throw new Error(`${name} 未完成：${result.error || result.status}`);
    return result;
  };
  try {
    const port = await freePort();
    const childEnv = { ...process.env, LOCALAPPDATA: isolated };
    delete childEnv.MIMO_API_KEY;
    child = spawn(executable, [`--remote-debugging-address=127.0.0.1`, `--remote-debugging-port=${port}`], {
      cwd: packageDirectory, windowsHide: true, stdio: 'ignore', env: childEnv,
    });
    browser = await connect(port);
    const ui = uiActions(browser.evaluate);
    await ui.visible(`Boolean(document.querySelector('[data-field="paste-text"]'))`, '正式粘贴界面');
    await ui.click('配置 AI 服务');
    await ui.visible(`Boolean(document.querySelector('[data-field="text-baseUrl"]'))`, '正式服务设置');
    await ui.field('text-baseUrl', BASE_URL);
    await ui.field('text-model', MODEL);
    await ui.field('text-apiKey', apiKey);
    const connectionStart = performance.now();
    await ui.click('测试连接', '[data-provider="text"] button');
    const textConnection = await ui.visible(`(() => { const node = document.querySelector('[data-provider="text"] .test-result'); const message = node?.textContent.trim(); return message && !message.includes('正在') ? { ok: !node.classList.contains('danger'), message } : null; })()`, '文字连接测试结果', 25000);
    report.scenarios.push({ name: '文字连接测试', status: textConnection.ok ? 'done' : 'error',
      completedMs: Math.round(performance.now() - connectionStart), result: safeMessage(textConnection.message).slice(0, 300) });
    if (report.scenarios.at(-1).status !== 'done') throw new Error('文字连接测试失败，已停止后续云端请求。');
    await ui.click('识图模型', '[role="tab"]');
    const visionConnectionStart = performance.now();
    await ui.click('测试连接', '[data-provider="vision"] button');
    const visionConnection = await ui.visible(`(() => { const node = document.querySelector('[data-provider="vision"] .test-result'); const message = node?.textContent.trim(); return message && !message.includes('正在') ? { ok: !node.classList.contains('danger'), message } : null; })()`, '识图连接测试结果', 25000);
    report.scenarios.push({ name: '识图连接测试（沿用文字模型）', status: visionConnection.ok ? 'done' : 'error',
      completedMs: Math.round(performance.now() - visionConnectionStart), result: safeMessage(visionConnection.message).slice(0, 300) });
    if (report.scenarios.at(-1).status !== 'done') throw new Error('识图连接测试失败，已停止后续云端请求。');
    await ui.click('文字模型', '[role="tab"]');
    await ui.click('保存设置');
    await ui.visible(`Boolean(document.querySelector('[data-field="paste-text"]'))`, '保存设置后返回');
    const settingsDisk = await fs.readFile(path.join(dataDirectory, 'settings.json'), 'utf8');
    assert.ok(!settingsDisk.includes(apiKey), '隔离目录设置文件出现明文 Key');
    report.keyEncryptedOnDisk = true;

    await ui.click('历史');
    await ui.visible(`Boolean(document.querySelector('[data-field="history-search"]'))`, '历史搜索');
    await ui.field('history-search', '复利段落');
    await ui.visible(`document.querySelectorAll('.history-item').length === 1`, '固定文字会话');
    await ui.click('打开会话', '.history-item .history-main');
    await ui.visible(`document.querySelector('.selected-word')?.textContent === 'compound'`, '固定文字会话界面');
    await measure('语境解释', textSession.id, 'context', () => ui.click('开始释义'));
    await ui.field('question', FOLLOW_UP);
    await measure('语境追问', textSession.id, 'context', () => ui.click('发送追问'));
    await ui.click('独立释义', '[role="tab"]');
    await ui.visible(`document.body.textContent.includes('查看一般含义')`, '独立释义尚未自动开始');
    await measure('独立释义', textSession.id, 'independent', () => ui.click('开始释义'));

    await ui.click('历史');
    await ui.visible(`Boolean(document.querySelector('[data-field="history-search"]'))`, '截图历史搜索');
    await ui.field('history-search', NOTE);
    await ui.visible(`document.querySelectorAll('.history-item').length === 1`, '固定截图会话');
    await ui.click('打开会话', '.history-item .history-main');
    await ui.visible(`Boolean(document.querySelector('.preview-image'))`, '固定裁剪图界面');
    assert.equal(await browser.evaluate(`document.querySelector('.panel-footer .provider')?.textContent`), MODEL);
    await measure('预置裁剪 PNG 解释', imageSession.id, 'visual', () => ui.click('解释截图'));
    await ui.field('question', IMAGE_FOLLOW_UP);
    await measure('图像追问', imageSession.id, 'visual', () => ui.click('发送追问'));

    const before = await readSession(imageSession.id);
    await ui.click('历史');
    await ui.visible(`Boolean(document.querySelector('[data-field="history-search"]'))`, '复开前历史搜索');
    await ui.field('history-search', NOTE);
    await ui.visible(`document.querySelectorAll('.history-item').length === 1`, '复开前截图结果');
    await ui.click('打开会话', '.history-item .history-main');
    await ui.visible(`document.querySelectorAll('article.assistant').length === 2`, '历史重开后的两条回答');
    await pause(1200);
    const after = await readSession(imageSession.id);
    assert.equal(after.threads.visual.messages.length, before.threads.visual.messages.length);
    report.scenarios.push({ name: '历史重开', status: 'done', result: '回答与消息数保持一致；未观察到新回答。' });
    report.overall = 'passed';
  } catch (error) {
    report.overall = 'failed';
    report.failure = safeMessage(error.message || error).slice(0, 500);
  } finally {
    try {
      if (browser && child?.exitCode === null) {
        await browser.evaluate(`(() => { void window.pickgloss.invoke('quit'); return true; })()`);
        await until(() => child.exitCode !== null, '隔离实例正常退出', 15000);
        report.normalExit = true;
      }
    } catch { report.normalExit = false; }
    if (child?.pid && child.exitCode === null) {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' });
      report.emergencyStopOwnChild = true;
      report.normalExit = false;
      report.overall = 'failed';
      report.failure ||= '隔离实例未能正常退出，已仅终止本脚本启动的进程。';
    }
    browser?.socket.close();
    await saveReport();
  }
  if (report.overall !== 'passed') throw new Error(`MiMo 验收未通过：${report.failure || '未知原因'}。报告已保留。`);
  console.log(`MiMo 真实服务验收完成：${manifest.candidateId}；${report.scenarios.length} 项。`);
}

if (!process.argv[2]) {
  console.error('用法：node scripts/check-mimo-portable.cjs <候选包目录>；API Key 仅从 MIMO_API_KEY 环境变量读取。');
  process.exitCode = 2;
} else {
  run(path.resolve(process.argv[2])).catch(error => { console.error(error.message); process.exitCode = 1; });
}
