'use strict';
// 自建 Chromium 普通 DOM 与真实鼠标拖选夹具；页面仅含固定虚构材料。
const { app, BrowserWindow, screen } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { quoteJavaScriptString } = require('../../scripts/javascript-string.cjs');
const root = path.resolve(__dirname, '../..');
const tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'pickgloss-mixed-selection-'));
app.setPath('userData', tempUserData);
app.commandLine.appendSwitch('force-renderer-accessibility');
app.on('window-all-closed', () => {});

const binary = process.argv[2], inputTool = process.argv[3];
const samples = [
  { name: '单块纯文字对照', start: '固定材料：纯文字正文', end: '固定材料：纯文字正文', expectedDomText: '固定材料：纯文字正文', expectedUiaText: '固定材料：纯文字正文',
    html: '<p><span id="start">固定材料：纯文字正文</span></p>' },
  { name: '正文与命令块混选', start: '固定材料：正文块。', end: 'git status --short', expectedDomText: '固定材料：正文块。\n\ngit status --short', expectedUiaText: '固定材料：正文块。\ngit status --short',
    textBoundaryEvidence: '本夹具中 Chromium DOM 选择文本在块边界返回两个换行；UIA TextPattern 原始文本与全局 Hook 返回一个换行。按 UIA 可取得文本验收，不从 DOM 空白推算。', holdMs: 1600,
    html: '<p><span id="start">固定材料：正文块。</span></p><pre><code><span id="end">git status --short</span></code></pre>' },
  { name: '标题与封面混选', start: '固定材料：虚构影片标题', end: null, expectedDomText: '固定材料：虚构影片标题', expectedUiaText: '固定材料：虚构影片标题',
    textBoundaryEvidence: 'UIA TextPattern 原始选区末尾包含 U+FFFC 图像标记；选定内容只保留文字，不对图片做 OCR。', holdMs: 1600,
    html: '<h2><span id="start">固定材料：虚构影片标题</span></h2><img id="end" alt="虚构封面图" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22320%22 height=%22170%22%3E%3Crect width=%22320%22 height=%22170%22 fill=%22%23345%22/%3E%3C/svg%3E" width="320" height="170">' },
  { name: '正文加内联图片保留两侧换行', start: '正文A\n', end: '\n正文B', expectedDomText: '正文A\n\n正文B', expectedUiaText: '正文A\n\n正文B',
    textBoundaryEvidence: 'UIA 原文预期为正文A、换行、U+FFFC、换行、正文B；仅删除图片占位符，保留两侧原始换行。',
    html: '<p class="mixed-inline"><span id="start">正文A\n</span><img class="inline-image" alt="虚构内联图片" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2228%22 height=%2228%22%3E%3Crect width=%2228%22 height=%2228%22 fill=%22%23888%22/%3E%3C/svg%3E" width="28" height="28"><span id="end">\n正文B</span></p>' },
  { name: '纯图片不得产生文字选区', start: null, end: null, expectedDomText: '', expectedUiaText: '',
    html: '<img id="start" alt="虚构独立图片" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22320%22 height=%22170%22%3E%3Crect width=%22320%22 height=%22170%22 fill=%22%23345%22/%3E%3C/svg%3E" width="320" height="170">' },
  { name: '正文与 Unicode 表情混选', start: '固定材料：正文🙂结束', end: '固定材料：正文🙂结束', expectedDomText: '固定材料：正文🙂结束', expectedUiaText: '固定材料：正文🙂结束',
    html: '<p><span id="start">固定材料：正文🙂结束</span></p>' },
];
const selectedSamples = process.argv[4] ? samples.filter(sample => sample.name === process.argv[4]) : samples;
const holdOverride = process.argv[5] ? Number(process.argv[5]) : null;
const repetitions = process.argv[6] ? Number(process.argv[6]) : 1;
const dragStepDelay = process.argv[7] ? Number(process.argv[7]) : 18;

function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function runMouseInput(executable, args) {
  return new Promise(resolve => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true; child.kill(); resolve({ error: new Error('自有窗口鼠标输入超时。'), stdout, stderr });
    }, 10000);
    child.stdout?.setEncoding('utf8'); child.stdout?.on('data', value => { stdout += value; });
    child.stderr?.setEncoding('utf8'); child.stderr?.on('data', value => { stderr += value; });
    child.on('error', error => {
      if (settled) return;
      settled = true; clearTimeout(timer); resolve({ error, stdout, stderr });
    });
    child.on('close', status => {
      if (settled) return;
      settled = true; clearTimeout(timer); resolve({ status, stdout, stderr });
    });
  });
}
async function run() {
  if (!binary || !inputTool) throw new Error('需要传入 UIA 助手和鼠标输入工具路径。');
  const workArea = screen.getPrimaryDisplay().workArea;
  const width = Math.max(360, Math.min(450, Math.floor(workArea.width * 0.3)));
  const x = workArea.x + Math.floor(workArea.width * 0.35);
  const y = workArea.y + 30, height = Math.max(420, Math.min(700, workArea.height - 60));
  const win = new BrowserWindow({ title: 'PickGloss 混合选区原生复现（固定虚构材料）', width, height, x, y, show: false,
    webPreferences: { sandbox: false, contextIsolation: true, nodeIntegration: false } });
  win.setAlwaysOnTop(true, 'pop-up-menu');
  const hookMessages = [];
  const helperProcesses = [];
  const parentPort = { postMessage: value => hookMessages.push(value), on() {} };
  const realSpawn = require('node:child_process').spawn;
  const fixtureRequire = name => name === 'node:child_process' ? { spawn: (...args) => {
    const child = realSpawn(...args), record = { args: args[1] || [], input: '', sentInput: '', stdout: '' };
    child.stdout?.setEncoding('utf8'); child.stdout?.on('data', value => { record.stdout += value; });
    const write = child.stdin.write.bind(child.stdin), end = child.stdin.end.bind(child.stdin);
    child.stdin.write = (value, ...rest) => { if (typeof value === 'string') record.input += value; if (typeof value === 'string') record.sentInput += value; return write(value, ...rest); };
    child.stdin.end = (value, ...rest) => { if (typeof value === 'string') record.input += value; if (typeof value === 'string') record.sentInput += value; return end(value, ...rest); };
    helperProcesses.push(record); return child;
  } } : require(name);
  const workerSource = fs.readFileSync(path.join(root, 'src/windows/selection-worker.cjs'), 'utf8') +
    '\n;hook.on("text-selection", data => post({type:"fixture-hook-event", text:data.text, method:data.method, point:data.mousePosEnd}));' +
    '\n;hook.on("mouse-down", data => post({type:"fixture-mouse-down", point:data}));' +
    '\n;hook.on("mouse-up", data => post({type:"fixture-mouse-up", point:data}));';
  vm.runInNewContext(workerSource, {
    require: fixtureRequire,
    process: { parentPort, argv: ['', '', binary, ''] , exit() {} },
    setTimeout, clearTimeout, setInterval, clearInterval, console, Buffer, Date, Math, JSON, Promise,
  }, { filename: 'src/windows/selection-worker.cjs' });
  const hwnd = win.getNativeWindowHandle().readBigUInt64LE().toString(16);
  const results = [];
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><html lang="zh"><meta charset="utf-8"><title>固定虚构材料</title><style>body{font:24px/1.7 Arial,sans-serif;margin:34px;width:780px}h2{margin:0 0 12px}p{margin:0 0 20px}p.mixed-inline{white-space:pre-wrap}pre{font:22px/1.5 Consolas,monospace;background:#eee;padding:18px;width:680px}img{display:block;margin-top:16px}img.inline-image{display:inline-block;margin:0;vertical-align:middle}#stage{user-select:text}</style><main id="stage"></main>'));
    win.show(); win.focus(); app.focus({ steal: true });
    for (let retry = 0; retry < 80 && !win.isFocused(); retry++) await wait(50);
    if (!win.isFocused()) throw new Error('自建虚构材料窗口未能取得前台焦点。');
    for (let retry = 0; retry < 80 && !hookMessages.some(message => message.type === 'ready'); retry++) await wait(100);
    if (!hookMessages.some(message => message.type === 'ready' && message.running)) throw new Error('真实全局选区 Hook 未启动。');
    await wait(350);
    if (!selectedSamples.length || !Number.isInteger(repetitions) || repetitions < 1 || repetitions > 10 || (holdOverride !== null && (!Number.isInteger(holdOverride) || holdOverride < 0 || holdOverride > 5000)) || !Number.isInteger(dragStepDelay) || dragStepDelay < 0 || dragStepDelay > 100) throw new Error('固定材料运行参数无效。');
    for (let pass = 1; pass <= repetitions; pass++) for (const sample of selectedSamples) {
      const offset = hookMessages.length;
      const helperOutputOffsets = helperProcesses.map(record => record.stdout.length);
      await win.webContents.executeJavaScript(`document.getElementById('stage').innerHTML=${quoteJavaScriptString(sample.html)};window.getSelection().removeAllRanges();`);
    await wait(100);
      const rects = await win.webContents.executeJavaScript(`(() => {
        const point=(el,start)=>{const r=el.getBoundingClientRect();if(el.tagName==='IMG')return{x:start?r.left+3:r.right-3,y:r.top+r.height/2};const t=el.firstChild,range=document.createRange();range.setStart(t,start?0:t.length-1);range.setEnd(t,start?1:t.length);const b=range.getBoundingClientRect();return{x:start?b.left+2:b.right-2,y:b.top+b.height/2};};
        const a=document.getElementById('start'),b=document.getElementById('end')||a;return{start:point(a,true),end:point(b,false)};
      })()`);
      // 坐标先从页面 DIP 转到屏幕物理像素，输入工具会再次确认自有窗口仍在前台。
      const bounds = win.getContentBounds();
      const start = screen.dipToScreenPoint({ x: Math.round(bounds.x + rects.start.x), y: Math.round(bounds.y + rects.start.y) });
      const end = screen.dipToScreenPoint({ x: Math.round(bounds.x + rects.end.x), y: Math.round(bounds.y + rects.end.y) });
      const coordinateCheck = spawnSync(inputTool, ['--validate', hwnd, String(start.x), String(start.y), String(end.x), String(end.y)], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
      if (coordinateCheck.error || coordinateCheck.status !== 0) throw new Error('拖选端点没有通过自建窗口边界校验：' + (coordinateCheck.stdout || coordinateCheck.stderr || coordinateCheck.error?.message || coordinateCheck.status) + `；DIP窗口=${JSON.stringify(win.getBounds())}，内容=${JSON.stringify(bounds)}，端点=${JSON.stringify({ start, end, rects })}`);
      const holdMs = holdOverride === null ? (sample.holdMs || 0) : holdOverride;
      const injected = await runMouseInput(inputTool, [hwnd, String(start.x), String(start.y), String(end.x), String(end.y), String(holdMs), String(dragStepDelay)]);
      if (injected.error || injected.status !== 0) throw new Error('自有窗口真实拖选失败：' + (injected.stderr || injected.error?.message || injected.status));
      let inputHoldEvidence = null;
      try { inputHoldEvidence = JSON.parse(injected.stdout.trim().split(/\r?\n/).at(-1)); } catch { }
      if (!inputHoldEvidence || inputHoldEvidence.inputHoldRequestedMs !== holdMs || (holdMs > 0 && inputHoldEvidence.inputHoldElapsedMs < holdMs)) {
        throw new Error(`原生鼠标工具未证实按下停留时长：期望 ${holdMs}ms，实际输出=${injected.stdout}`);
      }
      await wait(260);
      const domText = await win.webContents.executeJavaScript('window.getSelection().toString()');
      const deadline = Date.now() + 2800;
      while (Date.now() < deadline && !hookMessages.slice(offset).some(message => message.type === 'selection' || message.type === 'selection-too-long' || message.type === 'probe-unavailable')) await wait(40);
      const current = hookMessages.slice(offset);
      const hookEvent = current.find(message => message.type === 'fixture-hook-event');
      const workerSelection = current.find(message => message.type === 'selection');
      const probeFrames = helperProcesses.map((record, index) => ({ args: record.args, input: record.input, sentInput: record.sentInput, stdout: record.stdout.slice(helperOutputOffsets[index] || 0) }))
        .filter((record, index) => record.stdout || index >= helperOutputOffsets.length);
      const normalize = value => String(value || '').replace(/\r\n/g, '\n');
      const domMatchesExpectedText = normalize(String(domText || '').trim()) === normalize(sample.expectedDomText);
      const hookMatchesExpectedText = !hookEvent || normalize(hookEvent.text) === normalize(sample.expectedUiaText);
      const workerMatchesExpectedText = sample.expectedUiaText ? normalize(workerSelection?.text) === normalize(sample.expectedUiaText) : !workerSelection;
      results.push({ name: repetitions > 1 ? `${sample.name}（第${pass}次）` : sample.name, expectedDomText: sample.expectedDomText, expectedUiaText: sample.expectedUiaText,
        textBoundaryEvidence: sample.textBoundaryEvidence || '', domSelection: domText, hookEvent: hookEvent || null,
        workerSelection: workerSelection || null, workerFrames: current, probeFrames, inputExitCode: injected.status,
        domMatchesExpectedText, hookMatchesExpectedText, workerMatchesExpectedText,
        windowBounds: win.getBounds(), contentBounds: bounds, displayWorkArea: workArea, displayScaleFactor: screen.getPrimaryDisplay().scaleFactor, endpointRects: rects, inputStart: start, inputEnd: end, holdAfterDownMs: holdMs, inputHoldEvidence, dragStepDelayMs: dragStepDelay,
        verdict: domMatchesExpectedText && workerMatchesExpectedText ? '通过' : '失败' });
    }
    process.stdout.write(JSON.stringify({ description: '真实全局 selection-hook、真实 Chromium 普通 DOM 拖选与原生 UIA 助手；页面只有虚构材料。', results }) + '\n');
  } finally {
    parentPort.postMessage({ type: 'stop' });
    win.destroy(); app.exit(0);
  }
}

app.whenReady().then(run).catch(error => { console.error(error.message); app.exit(2); });
