'use strict';
const { quoteJavaScriptString } = require('./javascript-string.cjs');
// 旧版与候选包共用一份隔离虚构数据，走正式 renderer、preload、主进程和正常退出。
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { createHash, randomUUID } = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { performance } = require('node:perf_hooks');

const execFileAsync = promisify(execFile);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const imageData = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC1kAAAAASUVORK5CYII=';
const fakeKey = 'pickgloss-ticket-19-fake-key';
const marker = '工单十九虚构材料';

async function until(check, label, timeout = 20000) {
  const end = performance.now() + timeout;
  let last;
  while (performance.now() < end) {
    try { const value = await check(); if (value) return value; }
    catch (error) { last = error; }
    await wait(120);
  }
  throw new Error(`${label} 超时；${last?.message || '未观察到预期状态'}`);
}

async function powershell(script) {
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: 15000 });
  return stdout.trim() ? JSON.parse(stdout) : [];
}

async function matchingProcesses() {
  const rows = await powershell("$p = @(Get-CimInstance Win32_Process -Filter \"Name = 'PickGloss.exe'\" | Select-Object ProcessId, ParentProcessId, ExecutablePath); ConvertTo-Json -InputObject $p -Compress");
  return Array.isArray(rows) ? rows : [rows];
}

async function requireNoExistingInstance() {
  const running = await matchingProcesses();
  if (running.length) throw new Error(`发现已有拾译进程 ${running.map(item => item.ProcessId).join('、')}，本轮隔离验证未启动；请先由该实例的使用者正常退出。`);
}

async function processSnapshot(rootPid) {
  assert.ok(Number.isSafeInteger(rootPid) && rootPid > 0);
  const script = `$rootPid = ${rootPid}; $all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name); $ids = [System.Collections.Generic.HashSet[int]]::new(); [void]$ids.Add($rootPid); do { $more = $false; foreach ($item in $all) { if ($ids.Contains([int]$item.ParentProcessId) -and $ids.Add([int]$item.ProcessId)) { $more = $true } } } while ($more); $rows = @(foreach ($item in $all) { if ($ids.Contains([int]$item.ProcessId)) { $live = Get-Process -Id $item.ProcessId -ErrorAction SilentlyContinue; if ($live) { [pscustomobject]@{ pid = [int]$item.ProcessId; parentPid = [int]$item.ParentProcessId; name = $item.Name; cpuSeconds = [double]$live.CPU; workingSetBytes = [int64]$live.WorkingSet64; privateBytes = [int64]$live.PrivateMemorySize64 } } } }); ConvertTo-Json -InputObject $rows -Compress`;
  const rows = await powershell(script);
  return { at: new Date().toISOString(), monotonicMs: performance.now(), processes: Array.isArray(rows) ? rows : [rows] };
}

async function availablePort() {
  const { createServer } = require('node:net');
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function connect(port) {
  const target = await until(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    const tabs = await response.json();
    return tabs.find(item => item.type === 'page' && item.url.includes('/src/renderer/index.html') && item.url.includes('window=panel'));
  }, '正式界面调试目标');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let serial = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const reply = JSON.parse(event.data);
    if (!pending.has(reply.id)) return;
    const { resolve, reject } = pending.get(reply.id);
    pending.delete(reply.id);
    if (reply.error) reject(new Error(reply.error.message)); else resolve(reply.result);
  });
  socket.addEventListener('close', () => {
    for (const { reject } of pending.values()) reject(new Error('界面调试连接已关闭'));
    pending.clear();
  });
  const evaluate = async expression => {
    const id = ++serial;
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('界面操作响应超时')); }, 5000);
      pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || '正式界面操作失败');
    return result.result?.value;
  };
  const invoke = async (action, payload = {}) => {
    const result = await evaluate(`window.pickgloss.invoke(${quoteJavaScriptString(action)}, JSON.parse(${quoteJavaScriptString(JSON.stringify(payload))}))`);
    assert.equal(result?.ok, true, `${action}：${result?.error || '调用失败'}`);
    return result.value;
  };
  return { socket, evaluate, invoke };
}

async function launch(executable, localAppData) {
  await requireNoExistingInstance();
  const port = await availablePort();
  const started = performance.now();
  const child = spawn(executable, [`--remote-debugging-port=${port}`], {
    cwd: path.dirname(executable), windowsHide: true, stdio: 'ignore',
    env: { ...process.env, LOCALAPPDATA: localAppData },
  });
  child.once('error', error => { child.launchError = error; });
  let browser;
  try {
    browser = await connect(port);
    await until(() => browser.evaluate("Boolean(window.pickgloss?.invoke && document.querySelector('[data-field=\"paste-text\"]'))"), '面板可操作');
    const panelMs = Math.round(performance.now() - started);
    const selection = await until(async () => {
      const result = await browser.invoke('bootstrap');
      return result?.status?.selection !== '正在启动划词入口…' ? result?.status?.selection : null;
    }, '采集状态确定');
    const captureStateMs = Math.round(performance.now() - started);
    return { child, browser, panelMs, captureStateMs, selection, port };
  } catch (error) {
    if (browser && child.exitCode === null) {
      try {
        await browser.evaluate("(() => { void window.pickgloss.invoke('quit'); return true; })()");
        await until(() => child.exitCode !== null, '启动失败后的正常退出', 10000);
      } catch { /* 隔离 PID 和目录写入错误信息，供人工核对。 */ }
    }
    browser?.socket.close();
    throw new Error(`${error.message}；本轮子进程 PID ${child.pid || '未知'}，隔离数据已保留。`);
  }
}

async function exitNormally(run) {
  const { child, browser } = run;
  if (child.exitCode === null) {
    await browser.evaluate("(() => { void window.pickgloss.invoke('quit'); return true; })()");
    await until(() => child.exitCode !== null, '正常退出', 20000);
  }
  browser.socket.close();
  assert.equal(child.exitCode, 0, '正常退出码');
  await until(async () => (await matchingProcesses()).length === 0, '拾译相关进程结束', 10000);
}

async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of require('node:fs').createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function seedOldData(oldDirectory, dataDirectory) {
  const { createStore } = require(path.join(oldDirectory, 'resources', 'app', 'src', 'core', 'store.cjs'));
  const store = createStore({ directory: dataDirectory });
  await store.init();
  const text = await store.createSession({ kind: 'text', text: marker, context: '虚构段落：本轮只验证本地旧数据更新。',
    contextOrigin: '手动补充的段落', saved: true, source: { app: '旧版虚构样本', title: '旧版文字', method: '用户输入' },
    threads: {
      context: { messages: [{ id: '旧版语境回答', role: 'assistant', content: '旧版语境说明。' }], draft: '旧版语境草稿。' },
      independent: { messages: [{ id: '旧版独立回答', role: 'assistant', content: '旧版独立说明。' }], draft: '旧版独立草稿。' },
      visual: { messages: [], draft: '' },
    } });
  const image = await store.createSession({ kind: 'image', text: '截图讲解', imageData,
    note: '旧版截图说明。', source: { app: '旧版虚构样本', title: '旧版截图', method: '用户框选' },
    threads: {
      context: { messages: [], draft: '' }, independent: { messages: [], draft: '' },
      visual: { messages: [{ id: '旧版识图回答', role: 'assistant', content: '旧版截图说明回答。' }], draft: '旧版识图草稿。' },
    } });
  return { textId: text.id, imageId: image.id };
}

function assertSessions(text, image) {
  assert.equal(text.text, marker);
  assert.equal(text.saved, true);
  assert.equal(text.context, '虚构段落：本轮只验证本地旧数据更新。');
  assert.equal(text.threads.context.messages[0].content, '旧版语境说明。');
  assert.equal(text.threads.independent.messages[0].content, '旧版独立说明。');
  assert.equal(text.threads.independent.draft, '旧版独立草稿。');
  assert.equal(image.note, '旧版截图说明。');
  assert.equal(image.threads.visual.messages[0].content, '旧版截图说明回答。');
  assert.equal(image.threads.visual.draft, '旧版识图草稿。');
  assert.ok(image.imageData?.startsWith('data:image/png;base64,'));
}

async function readSessions(run, ids) {
  await run.browser.invoke('open-history');
  const history = await run.browser.invoke('bootstrap');
  assert.ok(history.history.some(item => item.id === ids.textId));
  assert.ok(history.history.some(item => item.id === ids.imageId));
  await run.browser.invoke('open-session', { id: ids.textId });
  const text = (await run.browser.invoke('bootstrap')).session;
  await run.browser.invoke('open-session', { id: ids.imageId });
  const image = (await run.browser.invoke('bootstrap')).session;
  assertSessions(text, image);
  return { text, image };
}

function resourceSummary(before, after, rootPid) {
  const old = new Map(before.processes.map(item => [item.pid, item]));
  const deltaSeconds = Math.max(0.001, (after.monotonicMs - before.monotonicMs) / 1000);
  const processes = after.processes.map(item => ({ pid: item.pid, parentPid: item.parentPid,
    role: item.pid === rootPid ? '主进程' : '相关子进程', name: item.name,
    cpuSeconds: Number(Math.max(0, item.cpuSeconds - (old.get(item.pid)?.cpuSeconds ?? item.cpuSeconds)).toFixed(3)),
    workingSetMiB: Number((item.workingSetBytes / 1048576).toFixed(1)),
    privateMiB: Number((item.privateBytes / 1048576).toFixed(1)) }));
  const cpuSeconds = processes.reduce((sum, item) => sum + item.cpuSeconds, 0);
  return { windowSeconds: Number(deltaSeconds.toFixed(3)), processCount: after.processes.length,
    names: [...new Set(after.processes.map(item => item.name))].sort(),
    cpuSeconds: Number(cpuSeconds.toFixed(3)), cpuPercentOfOneCore: Number((cpuSeconds / deltaSeconds * 100).toFixed(1)),
    workingSetMiB: Number((after.processes.reduce((sum, item) => sum + item.workingSetBytes, 0) / 1048576).toFixed(1)),
    privateMiB: Number((after.processes.reduce((sum, item) => sum + item.privateBytes, 0) / 1048576).toFixed(1)), processes };
}

async function measureResources(run) {
  await wait(3000);
  const idleBefore = await processSnapshot(run.child.pid);
  await wait(1800);
  const idleAfter = await processSnapshot(run.child.pid);
  const activeBefore = await processSnapshot(run.child.pid);
  for (const query of Array(4).fill(['旧版', '截图', '虚构', '没有匹配的词', '工单十九', '']).flat()) {
    await run.browser.invoke('open-history');
    await run.browser.invoke('search-history', { query, savedOnly: false });
  }
  const activeAfter = await processSnapshot(run.child.pid);
  return { idle: resourceSummary(idleBefore, idleAfter, run.child.pid), operation: resourceSummary(activeBefore, activeAfter, run.child.pid),
    method: '正式读取旧数据与测试本机服务后等待 3 秒，再采集空闲区间。通过 Win32_Process 父子 PID 链统计采样时存活的主进程与相关子进程；本轮未触发划词，短时运行的 ContextProbe.exe 不在样本中。Get-Process 的累计 CPU 秒做区间差，内存使用区间终点 WorkingSet64 与 PrivateMemorySize64 合计。操作区间执行 24 次正式历史/搜索动作；PowerShell 采样本身有开销，CPU 百分比以单核 100% 为基数。' };
}

async function run() {
  if (process.platform !== 'win32') throw new Error('仅在 Windows 宿主运行。');
  const oldDirectory = path.resolve(process.argv[2] || '');
  const output = path.resolve(process.argv[3] || '');
  const manifest = JSON.parse(await fs.readFile(path.join(output, 'candidate-manifest.json'), 'utf8'));
  const newDirectory = path.join(output, manifest.packageDirectory);
  assert.notEqual(oldDirectory.toLowerCase(), newDirectory.toLowerCase(), '旧包与新包必须是不同完整目录');
  const oldExecutable = path.join(oldDirectory, 'PickGloss.exe');
  const newExecutable = path.join(newDirectory, 'PickGloss.exe');
  await Promise.all([fs.access(oldExecutable), fs.access(newExecutable)]);
  const oldPackage = JSON.parse(await fs.readFile(path.join(oldDirectory, 'resources', 'app', 'package.json'), 'utf8'));
  const oldIdentity = { version: oldPackage.version, directory: oldDirectory, executableSha256: await hashFile(oldExecutable),
    mainSha256: await hashFile(path.join(oldDirectory, 'resources', 'app', 'src', 'main.cjs')),
    nativeSha256: await hashFile(path.join(oldDirectory, 'resources', 'native', 'ContextProbe.exe')) };
  await requireNoExistingInstance();
  const sandbox = path.join(os.tmpdir(), `pickgloss-lifecycle-${randomUUID()}`);
  const localAppData = path.join(sandbox, 'LocalAppData');
  const dataDirectory = path.join(localAppData, 'PickGloss', 'data');
  await fs.mkdir(localAppData, { recursive: true });
  const ids = await seedOldData(oldDirectory, dataDirectory);
  const report = { runAt: new Date().toISOString(), oldPackage: oldIdentity,
    newPackage: { candidateId: manifest.candidateId, sourceFingerprint: manifest.sourceFingerprint,
      packageFingerprint: manifest.packageFingerprint, directory: newDirectory },
    sandbox, dataDirectory, ids, checks: [], realModel: false, realUserData: false, realCapture: false,
    sample: '旧版公开存储接口创建的两条虚构会话；文字含双模式回答与草稿、收藏；截图含图片、说明、回答与草稿。' };
  let oldRun, newRun, reopened, service;
  const requests = [];
  try {
    service = http.createServer(async (request, response) => {
      let body = '';
      for await (const part of request) body += part;
      try {
        const payload = JSON.parse(body);
        assert.equal(request.method, 'POST');
        assert.equal(request.url, '/v1/chat/completions');
        assert.equal(request.headers.authorization, `Bearer ${fakeKey}`);
        assert.equal(payload.model, '虚构本机模型');
        requests.push({ model: payload.model, local: true });
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
        response.end('data: {"choices":[{"delta":{"content":"连接正常"}}]}\n\ndata: [DONE]\n\n');
      } catch {
        response.writeHead(400); response.end('本机测试请求无效');
      }
    });
    await new Promise(resolve => service.listen(0, '127.0.0.1', resolve));
    const localUrl = `http://127.0.0.1:${service.address().port}/v1`;
    oldRun = await launch(oldExecutable, localAppData);
    await readSessions(oldRun, ids);
    const saved = await oldRun.browser.invoke('save-settings', { text: { baseUrl: localUrl, model: '虚构本机模型', apiKey: fakeKey } });
    assert.equal(saved, null);
    await oldRun.browser.invoke('close');
    assert.equal(oldRun.child.exitCode, null, '关闭窗口不结束程序');
    await oldRun.browser.invoke('open-history');
    assert.equal((await oldRun.browser.invoke('bootstrap')).view, 'history', '隐藏后仍能打开历史');
    report.oldStartup = { panelOperableMs: oldRun.panelMs, captureStateMs: oldRun.captureStateMs,
      selectionStatus: oldRun.selection };
    await exitNormally(oldRun); oldRun = null;
    report.checks.push('旧版正式界面读取文字与截图；设置虚构本机服务和加密 Key；关闭窗口仍存活；正常退出后进程结束');
    const backup = path.join(sandbox, 'pre-update-backup');
    await fs.cp(dataDirectory, backup, { recursive: true, errorOnExist: true, force: false });
    report.preUpdateBackup = backup;
    const settingsBytes = await fs.readFile(path.join(dataDirectory, 'settings.json'), 'utf8');
    assert.ok(!settingsBytes.includes(fakeKey), '虚构 Key 也不应明文落盘');
    await requireNoExistingInstance();
    newRun = await launch(newExecutable, localAppData);
    report.newStartup = { panelOperableMs: newRun.panelMs, captureStateMs: newRun.captureStateMs,
      selectionStatus: newRun.selection, devicePixelRatio: await newRun.browser.evaluate('window.devicePixelRatio'),
      screen: await newRun.browser.evaluate('({ width: window.screen.width, height: window.screen.height })') };
    await readSessions(newRun, ids);
    const configured = await newRun.browser.invoke('bootstrap');
    assert.equal(configured.settings.text.model, '虚构本机模型');
    assert.equal(configured.settings.text.hasKey, true);
    await newRun.browser.invoke('test-provider', { kind: 'text', config: { baseUrl: localUrl, model: '虚构本机模型', apiKey: '' } });
    assert.equal(requests.length, 1, '旧版保存的虚构 Key 应能在新包解密并发送给本机服务');
    report.resources = await measureResources(newRun);
    await newRun.browser.invoke('rename-session', { id: ids.textId, title: '更新后的虚构标题' });
    await newRun.browser.invoke('open-session', { id: ids.textId });
    const injected = await newRun.browser.evaluate(`(() => { const input = document.querySelector('[data-field="question"]'); if (!input) return false; input.value = '正常退出即时草稿十九'; input.dispatchEvent(new Event('input', { bubbles: true })); void window.pickgloss.invoke('quit'); return true; })()`);
    assert.equal(injected, true, '从正式解释页输入草稿并发起退出');
    await until(() => newRun.child.exitCode !== null, '新包正常退出', 20000);
    newRun.browser.socket.close();
    assert.equal(newRun.child.exitCode, 0);
    await requireNoExistingInstance(); newRun = null;
    report.checks.push('新包正式界面读取旧版设置、文字、截图、双模式问答与草稿；加密虚构 Key 可解密并仅发送一次本机连接测试；正式输入后正常退出；未发送草稿保存');
    reopened = await launch(newExecutable, localAppData);
    const preserved = await readSessions(reopened, ids);
    assert.equal(preserved.text.title, '更新后的虚构标题');
    assert.equal(preserved.text.threads.context.draft, '正常退出即时草稿十九');
    assert.equal(preserved.text.threads.context.messages.length, 1, '重启不自动发送未提交草稿');
    assert.equal((await reopened.browser.invoke('bootstrap')).settings.text.hasKey, true);
    assert.equal(requests.length, 1, '重启不会自动联系本机服务');
    await exitNormally(reopened); reopened = null;
    report.checks.push('同一新包重启后标题与即时草稿保留、双模式不串用、未自动请求服务');
    const { createStore } = require(path.join(oldDirectory, 'resources', 'app', 'src', 'core', 'store.cjs'));
    const recovery = createStore({ directory: backup });
    await recovery.init();
    const backupText = await recovery.getSession(ids.textId);
    const backupImage = await recovery.getSession(ids.imageId);
    assertSessions(backupText, backupImage);
    report.checks.push('更新前完整隔离数据备份由旧版公开存储接口重新读取；旧包与备份保留用于恢复');
    report.localRequestCount = requests.length;
    report.environment = { windowsRelease: os.release(), architecture: os.arch(),
      note: '窗口设备像素比见 newStartup；系统显示缩放与显示器数量未单独核验。' };
    const artifactRoot = path.join(__dirname, '..', 'output', 'verification');
    await fs.mkdir(artifactRoot, { recursive: true });
    const file = path.join(artifactRoot, `工单19-隔离生命周期更新-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    await fs.writeFile(file, JSON.stringify(report, null, 2), { encoding: 'utf8', flag: 'wx' });
    console.log(`隔离退出与手动更新检查通过：${manifest.candidateId}；记录 ${file}`);
  } finally {
    for (const active of [reopened, newRun, oldRun]) {
      if (!active || active.child.exitCode !== null) continue;
      try { await exitNormally(active); }
      catch { console.error(`本轮隔离拾译 PID ${active.child.pid} 未确认正常退出；已保留数据 ${sandbox}，请核对，不会强制结束进程。`); }
    }
    if (service) await new Promise(resolve => service.close(resolve));
  }
}

run().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
