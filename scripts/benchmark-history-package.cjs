'use strict';
// 固定虚构样本与正式候选包界面计时；不读取已有用户目录。
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { createHash } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { createStore } = require('../src/core/store.cjs');
const { queryHistory } = require('../src/core/history.cjs');

const SEED = 'pickgloss-ticket-18-v1';
const COUNT = 1000;
const OPEN_RUNS = 40;
const SEARCH_ROUNDS = 4;
const TIMEOUT_MS = 10000;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = value => createHash('sha256').update(value).digest('hex');
const title = index => `虚构会话 ${String(index).padStart(4, '0')}`;
const searchCases = [
  { field: '标题', query: '标题专用针998', expected: 1, expectedTitle: `${title(998)} 标题专用针998`, savedOnly: false },
  { field: '上下文', query: '段落专用针876', expected: 1, expectedTitle: title(876), savedOnly: false },
  { field: '非当前文字模式回答', query: '独立回答专用针776', expected: 1, expectedTitle: title(776), savedOnly: false },
  { field: '停止片段', query: '停止片段专用针676', expected: 1, expectedTitle: title(676), savedOnly: false },
  { field: '截图说明', query: '截图说明专用针577', expected: 1, expectedTitle: title(577), savedOnly: false },
  { field: '截图回答', query: '截图回答专用针477', expected: 1, expectedTitle: title(477), savedOnly: false },
  { field: '非首批记录', query: '末批专用针999', expected: 1, expectedTitle: title(999), savedOnly: false },
  { field: '收藏中命中', query: '收藏专用针996', expected: 1, expectedTitle: `${title(996)} 收藏专用针996`, savedOnly: true },
  { field: '收藏中未命中', query: '标题专用针998', expected: 0, savedOnly: true },
  { field: '无匹配', query: '全库无匹配专用针', expected: 0, savedOnly: false },
  { field: '未发送草稿不命中', query: '未发送草稿专用针', expected: 0, savedOnly: false },
];

function uuid(index) {
  const value = hash(`${SEED}:${index}`);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-4${value.slice(13, 16)}-a${value.slice(17, 20)}-${value.slice(20, 32)}`;
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function chunk(type, data) {
  const tag = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([tag, data])) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, tag, data, checksum]);
}
function samplePng(size) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 2;
  const raw = Buffer.alloc(size * (size * 3 + 1));
  let random = 0x7182026 ^ size;
  for (let row = 0; row < size; row++) {
    const start = row * (size * 3 + 1);
    for (let offset = 1; offset <= size * 3; offset++) {
      random ^= random << 13; random ^= random >>> 17; random ^= random << 5;
      raw[start + offset] = random & 255;
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function session(index) {
  const screenshot = index % 5 === 2;
  const saved = index % 3 === 0;
  const date = new Date(Date.UTC(2026, 8, 1) - index * 60000).toISOString();
  const contextMessages = [];
  const independentMessages = [];
  const visualMessages = [];
  if (!screenshot && index % 4 !== 0) {
    contextMessages.push({ id: `问-${index}`, role: 'user', content: `请解释本段材料 ${index}；${'阅读 '.repeat(index % 17)}`, status: 'complete' });
    contextMessages.push({ id: `答-${index}`, role: 'assistant', content: `语境回答 ${index}；${'依据所给段落。'.repeat(5 + index % 18)}`, status: 'complete' });
  }
  if (!screenshot && index % 4 >= 2) independentMessages.push({ id: `独-${index}`, role: 'assistant', content: `独立释义 ${index}；${'一般含义。'.repeat(4 + index % 13)}`, status: 'complete' });
  if (index === 776) independentMessages.push({ id: '专用独立回答', role: 'assistant', content: '独立回答专用针776', status: 'complete' });
  if (index === 676) contextMessages.push({ id: '专用停止片段', role: 'assistant', content: '停止片段专用针676', status: 'stopped' });
  if (screenshot && index % 4 !== 0) visualMessages.push({ id: `图-${index}`, role: 'assistant', content: `截图回答 ${index}；${'可见区域说明。'.repeat(5 + index % 12)}`, status: index % 11 === 2 ? 'stopped' : 'complete' });
  if (index === 477) visualMessages.push({ id: '专用截图回答', role: 'assistant', content: '截图回答专用针477', status: 'complete' });
  const note = screenshot ? `虚构截图说明 ${index}。${'图像说明 '.repeat(5 + index % 14)}${index === 577 ? '截图说明专用针577' : ''}` : '';
  const result = {
    id: uuid(index), kind: screenshot ? 'image' : 'text',
    title: `${title(index)}${index === 998 ? ' 标题专用针998' : ''}${index === 996 ? ' 收藏专用针996' : ''}`,
    text: screenshot ? '截图讲解' : `虚构选定内容 ${index}。${'词句 '.repeat(3 + index % 30)}${index === 999 ? '末批专用针999' : ''}`,
    context: screenshot ? '' : `虚构段落 ${index}。${'这段材料仅供性能验证。'.repeat(4 + index % 35)}${index === 876 ? '段落专用针876' : ''}`,
    contextOrigin: screenshot ? '' : '虚构段落', contextReason: '',
    source: { app: screenshot ? '虚构图片来源' : '虚构文字来源', title: `来源 ${index}`, method: screenshot ? '截图框选' : '划词' },
    note, createdAt: date, updatedAt: date, lastActivityAt: date, saved,
    activeMode: screenshot ? 'visual' : 'context',
    threads: {
      context: { messages: contextMessages, draft: index === 301 ? '未发送草稿专用针' : '' },
      independent: { messages: independentMessages, draft: '' },
      visual: { messages: visualMessages, draft: '' },
    },
  };
  return result;
}

async function inventory(dataRoot) {
  const ids = (await fs.readdir(path.join(dataRoot, 'sessions'))).sort();
  const digest = createHash('sha256');
  let images = 0;
  for (const id of ids) {
    digest.update(id);
    digest.update(await fs.readFile(path.join(dataRoot, 'sessions', id, 'session.json')));
    const image = path.join(dataRoot, 'sessions', id, 'crop.png');
    try { digest.update(await fs.readFile(image)); images++; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { count: ids.length, images, sha256: digest.digest('hex') };
}

async function seedFixture() {
  const isolatedDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'pickgloss-verification-'));
  await fs.writeFile(path.join(isolatedDirectory, 'verification.marker'), 'PickGloss 隔离验证目录\n', { flag: 'wx' });
  const dataRoot = path.join(isolatedDirectory, 'data');
  const sessionsRoot = path.join(dataRoot, 'sessions');
  await fs.mkdir(sessionsRoot, { recursive: true });
  const images = [64, 128, 192].map(samplePng);
  const records = Array.from({ length: COUNT }, (_, index) => session(index));
  for (let start = 0; start < COUNT; start += 16) {
    await Promise.all(records.slice(start, start + 16).map(async (record, offset) => {
      const index = start + offset;
      const folder = path.join(sessionsRoot, record.id);
      await fs.mkdir(folder);
      await fs.writeFile(path.join(folder, 'session.json'), JSON.stringify(record, null, 2), { flag: 'wx' });
      if (record.kind === 'image') await fs.writeFile(path.join(folder, 'crop.png'), images[index % 3], { flag: 'wx' });
    }));
  }
  const store = createStore({ directory: dataRoot });
  await store.init();
  const entries = await store.listSessions();
  assert.equal(entries.length, COUNT, '主存储必须能读取全部 1,000 条样本');
  assert.ok(entries.findIndex(item => item.id === uuid(999)) >= 50, '末批样本必须在首批之外');
  // 在正式界面计时前核对样本关键词分布，避免把生成器写错误判成产品超时。
  for (const item of searchCases) {
    const matches = queryHistory(entries, { query: item.query, savedOnly: item.savedOnly });
    assert.equal(matches.length, item.expected, `样本查询不符：${item.field}`);
    if (item.expectedTitle) assert.equal(matches[0]?.title, item.expectedTitle, `样本标题不符：${item.field}`);
  }
  const before = await inventory(dataRoot);
  assert.equal(before.count, COUNT); assert.equal(before.images, 200);
  const messageCounts = records.map(value => Object.values(value.threads).reduce((count, thread) => count + thread.messages.length, 0));
  const textLengths = records.map(value => value.text.length + value.context.length + value.note.length);
  return { isolatedDirectory, dataRoot, before, characteristics: {
    seed: SEED, count: COUNT, textSessions: 800, imageSessions: 200, saved: records.filter(value => value.saved).length,
    unexplained: messageCounts.filter(count => count === 0).length,
    stopped: records.filter(value => Object.values(value.threads).some(thread => thread.messages.some(message => message.status === 'stopped'))).length,
    dualTextMode: records.filter(value => value.threads.context.messages.length && value.threads.independent.messages.length).length,
    messageCount: messageCounts.reduce((total, count) => total + count, 0),
    messageCountPerSession: { min: Math.min(...messageCounts), max: Math.max(...messageCounts) },
    materialLengthPerSession: { min: Math.min(...textLengths), max: Math.max(...textLengths) },
    pngBytes: images.map(image => image.length),
  } };
}

async function until(check, label, timeout = TIMEOUT_MS) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { const result = await check(); if (result) return result; }
    catch (error) { last = error; }
    await wait(50);
  }
  throw new Error(`${label} 超时：${last?.message || '未达到预期状态'}`);
}
async function freePort() {
  const http = require('node:http');
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function connect(port) {
  const target = await until(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    const tabs = await response.json();
    return tabs.find(item => item.type === 'page' && item.url.includes('/src/renderer/index.html'));
  }, '正式界面调试目标', 30000);
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let serial = 0;
  const pending = new Map();
  socket.addEventListener('close', () => {
    for (const job of pending.values()) job.reject(new Error('应用已关闭调试连接'));
    pending.clear();
  });
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const job = pending.get(message.id); pending.delete(message.id);
    if (message.error) job.reject(new Error(message.error.message)); else job.resolve(message.result);
  });
  const evaluate = async expression => {
    const result = await new Promise((resolve, reject) => {
      const id = ++serial; pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || '正式界面操作失败');
    return result.result?.value;
  };
  return { socket, evaluate };
}

function observedOperation(action, expected) {
  return `(async () => {
    const wanted = ${JSON.stringify(expected)};
    const action = ${action};
    return await new Promise((resolve, reject) => {
      let finished = false;
      const observer = new MutationObserver(check);
      const timer = setTimeout(() => finish(new Error('界面结果超过 ${TIMEOUT_MS} 毫秒')), ${TIMEOUT_MS});
      function finish(error, value) {
        if (finished) return;
        finished = true; clearTimeout(timer); observer.disconnect();
        if (error) reject(error); else resolve(value);
      }
      function check() {
        const count = document.querySelector('.history-count');
        const input = document.querySelector('[data-field="history-search"]');
        const first = document.querySelector('.history-item .history-title');
        if (!/^\\d+ 个会话$/.test(count?.textContent || '') || !input || (wanted.query !== undefined && input.value !== wanted.query)) return;
        requestAnimationFrame(() => requestAnimationFrame(() => finish(null, { milliseconds: performance.now() - started,
          count: count.textContent, firstTitle: first?.textContent || '', operable: Boolean(document.querySelector('.history-item .history-main:not(:disabled)')) })));
      }
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      const started = performance.now();
      try { action(); check(); } catch (error) { finish(error); }
    });
  })()`;
}

function summary(samples) {
  const values = samples.filter(sample => sample.ok).map(sample => sample.milliseconds).sort((a, b) => a - b);
  const under1000 = samples.filter(sample => sample.ok && sample.milliseconds < 1000).length;
  const percentile = percent => values.length ? values[Math.ceil(percent * values.length) - 1] : null;
  return { attempts: samples.length, completed: values.length, under1000, ratio: under1000 / samples.length,
    p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99), max: values.at(-1) ?? null,
    failures: samples.filter(sample => !sample.ok).length, timeouts: samples.filter(sample => !sample.ok && /超时|超过/.test(sample.error)).length,
    meetsTarget: under1000 >= Math.ceil(samples.length * 0.95) };
}

async function run() {
  const fixture = await seedFixture();
  if (process.argv[2] === '--seed-only') {
    console.log(JSON.stringify({ isolatedDirectory: fixture.isolatedDirectory, characteristics: fixture.characteristics, inventory: fixture.before }, null, 2));
    return;
  }
  const output = path.resolve(process.argv[2] || '');
  const verified = spawnSync(process.execPath, [path.join(__dirname, 'verify-package.cjs'), output], { encoding: 'utf8', windowsHide: true });
  if (verified.status !== 0) throw new Error(`正式包核对失败：${verified.stderr || verified.stdout}`);
  const manifest = JSON.parse(await fs.readFile(path.join(output, 'candidate-manifest.json'), 'utf8'));
  const executable = path.join(output, manifest.packageDirectory, 'PickGloss.exe');
  await fs.access(executable);
  const existing = spawnSync('tasklist', ['/FI', 'IMAGENAME eq PickGloss.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
  if (existing.status !== 0 || /^"PickGloss\.exe"/im.test(existing.stdout)) throw new Error('已有拾译实例或无法确认进程状态；为避免单实例串用，已停止启动。');
  const report = { measuredAt: new Date().toISOString(), candidateId: manifest.candidateId,
    sourceFingerprint: manifest.sourceFingerprint, packageFingerprint: manifest.packageFingerprint,
    packageFileCount: manifest.packageFileCount, packageDirectory: output, isolatedDirectory: fixture.isolatedDirectory,
    fixture: fixture.characteristics, before: fixture.before,
    environment: { platform: process.platform, release: os.release(), arch: os.arch(), cpu: os.cpus()[0]?.model,
      logicalCpus: os.cpus().length, totalMemoryBytes: os.totalmem(), node: process.version },
    plan: { openRuns: OPEN_RUNS, searchRounds: SEARCH_ROUNDS, searchCases, thresholdMilliseconds: 1000,
      timeoutMilliseconds: TIMEOUT_MS, sampleOrder: '先 40 次历史打开，后按所列顺序做四轮搜索，不挑选样本。' },
    opens: [], searches: [], evidenceBoundary: '正式候选包、正式界面及独立虚构目录；自动化注入完整输入事件，不代表真人手感。' };
  let child, browser;
  const reportPath = path.join(__dirname, '..', 'output', 'verification', '工单18-千条会话计时结果.json');
  try {
    const port = await freePort();
    child = spawn(executable, [`--verification-data-dir=${fixture.isolatedDirectory}`, `--remote-debugging-port=${port}`],
      { cwd: path.dirname(executable), windowsHide: true, stdio: 'ignore' });
    browser = await connect(port);
    const ui = browser.evaluate;
    report.environment.display = await ui('({ width: screen.width, height: screen.height, devicePixelRatio: devicePixelRatio, innerWidth: innerWidth, innerHeight: innerHeight })');
    await until(() => ui("Boolean([...document.querySelectorAll('button')].find(item => item.textContent.trim() === '历史'))"), '历史入口');
    for (let index = 0; index < OPEN_RUNS; index++) {
      let value;
      try {
        value = await ui(observedOperation(`() => {
          const button = [...document.querySelectorAll('button')].find(item => item.textContent.trim() === '历史');
          if (!button || button.disabled) throw new Error('历史按钮不可操作'); button.click();
        }`, {}));
        assert.equal(value.count, '1000 个会话', '历史数量必须为 1,000');
        assert.equal(value.operable, true, '历史首项必须可操作');
        report.opens.push({ sequence: index + 1, condition: index === 0 ? '进程首次用户打开' : '进程持续运行', ok: true, ...value });
      } catch (error) {
        report.opens.push({ sequence: index + 1, condition: index === 0 ? '进程首次用户打开' : '进程持续运行', ok: false, ...value, error: error.message });
        throw error;
      }
      if (index + 1 < OPEN_RUNS) {
        await ui("[...document.querySelectorAll('button')].find(item => item.textContent.trim() === '新建')?.click()");
        await until(() => ui("Boolean([...document.querySelectorAll('button')].find(item => item.textContent.trim() === '历史')) && !document.querySelector('[data-field=history-search]')"), '返回新建页面');
      }
    }
    for (let round = 1; round <= SEARCH_ROUNDS; round++) {
      for (const item of searchCases) {
        const baselineCount = item.savedOnly ? `${fixture.characteristics.saved} 个会话` : '1000 个会话';
        await ui(`(() => {
          const name = ${JSON.stringify(item.savedOnly ? '手动收藏' : '全部会话')};
          const tab = [...document.querySelectorAll('[role="tab"]')].find(node => node.textContent.trim() === name);
          if (!tab) throw new Error('找不到历史筛选'); tab.click();
          const input = document.querySelector('[data-field="history-search"]');
          if (!input) throw new Error('找不到历史搜索'); input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
        await until(() => ui(`document.querySelector('.history-count')?.textContent === ${JSON.stringify(baselineCount)} && document.querySelector('[data-field="history-search"]')?.value === ''`), '搜索前基线');
        let value;
        try {
          value = await ui(observedOperation(`() => {
            const input = document.querySelector('[data-field="history-search"]');
            if (!input) throw new Error('找不到搜索框'); input.value = ${JSON.stringify(item.query)};
            input.dispatchEvent(new Event('input', { bubbles: true }));
          }`, { query: item.query }));
          assert.equal(value.count, `${item.expected} 个会话`, `${item.field}结果数量`);
          if (item.expectedTitle) assert.equal(value.firstTitle, item.expectedTitle, `${item.field}结果标题`);
          else assert.equal(value.operable, false, `${item.field}不应出现可打开的结果`);
          report.searches.push({ round, field: item.field, query: item.query, savedOnly: item.savedOnly,
            expected: item.expected, condition: '同一进程中的暖搜索', ok: true, ...value });
        } catch (error) {
          report.searches.push({ round, field: item.field, query: item.query, savedOnly: item.savedOnly,
            expected: item.expected, condition: '同一进程中的暖搜索', ok: false, ...value, error: error.message });
          throw error;
        }
      }
    }
    report.after = await inventory(fixture.dataRoot);
    assert.deepEqual(report.after, fixture.before, '历史与搜索不得改写或丢失样本');
    report.openSummary = summary(report.opens);
    report.searchSummary = summary(report.searches);
    report.complete = report.opens.length === OPEN_RUNS && report.searches.length === SEARCH_ROUNDS * searchCases.length;
    console.log(`历史：${report.openSummary.under1000}/${report.openSummary.attempts} 次低于 1 秒；搜索：${report.searchSummary.under1000}/${report.searchSummary.attempts} 次低于 1 秒。`);
  } catch (error) {
    report.error = error.stack || error.message;
    report.after = await inventory(fixture.dataRoot);
    report.openSummary = summary(report.opens);
    report.searchSummary = summary(report.searches);
    report.complete = false;
    process.exitCode = 1;
  } finally {
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
    try { await browser?.evaluate("window.pickgloss.invoke('quit')"); } catch { /* 正常退出会主动关闭调试连接。 */ }
    browser?.socket.close();
    if (child && child.exitCode === null) {
      const exited = await Promise.race([new Promise(resolve => child.once('exit', resolve)), wait(15000).then(() => false)]);
      if (exited === false && child.exitCode === null) console.error(`隔离测试实例未正常退出，PID ${child.pid}；未强制终止，请人工检查。`);
    }
    console.log(`逐次记录：${reportPath}`);
    if (report.error) console.error(report.error);
  }
}
run().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
