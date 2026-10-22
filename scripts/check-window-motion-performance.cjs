'use strict';

// 独立隐藏宿主：仅使用虚构会话，不加载正式主进程，不读取用户数据或采集屏幕。
const { app, BrowserWindow, ipcMain, screen, systemPreferences } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const { performance } = require('node:perf_hooks');
const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'pickgloss-window-motion-'));
app.setPath('userData', path.join(isolated, 'runtime'));
app.setName('PickGloss 隐藏窗口时序检查');
const arg = key => process.argv.find(value => value.startsWith('--' + key + '='))?.slice(key.length + 3);
const cycles = Number(arg('cycles') || 4);
if (!Number.isInteger(cycles) || cycles < 1 || cycles > 20) throw new Error('测量轮数必须为 1 至 20。');
const sourcePath = path.join(__dirname, '../src/windows/desktop.cjs');
let source = fs.readFileSync(arg('source') || sourcePath, 'utf8');
const scheduler = arg('scheduler') || 'source';
if (!['source', 'original', 'deadline', 'adaptive'].includes(scheduler)) throw new Error('调度实验类型无效。');
if (scheduler === 'deadline') {
  // 对隔离模块作单变量实验，原工作区代码暂不变更。
  source = source.replace("const { randomUUID } = require('node:crypto');", "const { randomUUID } = require('node:crypto');\nconst { performance } = require('node:perf_hooks');");
  const start = source.indexOf('  function animatePanel('), end = source.indexOf('  function restoreWindowState(', start);
  let block = source.slice(start, end);
  if (!block.includes('started = Date.now()')) throw new Error('调度实验源代码与预期不同，请先更新实验边界。');
  block = block.replaceAll('Date.now()', 'performance.now()')
    .replace('const current = animation = { win, target };', 'const current = animation = { win, target };\n    let deadline = started + 1000 / 60;\n    function schedule() { animationTimer = setTimeout(tick, Math.max(1, Math.min(8, Math.floor(Math.min(deadline, started + duration) - performance.now()) - 1))); }')
    .replace('animationTimer = setTimeout(tick, Math.min(16, duration - (performance.now() - started)));', 'do { deadline += 1000 / 60; } while (deadline <= performance.now());\n      schedule();')
    .replace('animationTimer = setTimeout(tick, 16);', 'schedule();');
  source = source.slice(0, start) + block + source.slice(end);
}
if (scheduler === 'adaptive') {
  if (!source.includes('if (now + 2 < deadline)')) throw new Error('自适应实验需要绘制截止时间版本的源码。');
  source = source.replace('let deadline = started + 1000 / 60;', 'let deadline = started + 1000 / 60, timerOvershoot = 0, timerSamples = 0;')
    .replace('animationTimer = setTimeout(tick, Math.max(1, Math.min(8, Math.floor(remaining) - 1)));', 'const delay = Math.max(1, Math.min(8, Math.floor(remaining) - 1)), scheduled = performance.now();\n      animationTimer = setTimeout(() => { const over = Math.max(0, performance.now() - scheduled - delay); timerOvershoot = timerSamples++ ? timerOvershoot * .75 + over * .25 : over; tick(); }, delay);')
    .replace('if (now + 2 < deadline)', 'if (now + 2 < deadline && timerOvershoot < 2)');
}
const reportPath = path.resolve(arg('report') || path.join(isolated, 'report.json'));
const snapshotPath = arg('report') ? path.join(path.dirname(reportPath), path.basename(reportPath, '.json') + '-desktop.cjs') : path.join(isolated, 'desktop-source.cjs');
fs.mkdirSync(path.dirname(snapshotPath), { recursive: true }); fs.writeFileSync(snapshotPath, source);
const rendererDirectory = path.join(__dirname, '../src/renderer');
const rendererSha256 = Object.fromEntries(fs.readdirSync(rendererDirectory).filter(name => /\.(?:html|js|css)$/.test(name)).sort().map(name => [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(rendererDirectory, name))).digest('hex')]));
const traceScheduler = process.argv.includes('--trace-scheduler');
const schedulerTicks = [];
globalThis.__pickglossMotionTicks = schedulerTicks;
const measuredSource = traceScheduler ? source.replace('const now = performance.now(), progress =', 'globalThis.__pickglossMotionTicks.push({ at: performance.now(), deadline });\n      const now = performance.now(), progress =') : source;
if (traceScheduler && measuredSource === source) throw new Error('当前源码没有可记录的单调时钟调度边界。');
const fixture = arg('fixture') || 'renderer';
if (!['renderer', 'minimal'].includes(fixture)) throw new Error('测量界面类型无效。');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function distribution(values) {
  const sorted = values.filter(Number.isFinite).sort((a,b) => a-b);
  const at = quantile => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * quantile))] ?? null;
  return { count: sorted.length, median: at(.5), p95: at(.95), max: at(1), over25ms: sorted.filter(value => value > 25).length };
}
function gaps(times) { return times.slice(1).map((value, index) => value - times[index]); }
function fakeState() {
  const content = Array.from({ length: 18 }, (_, index) => `### 虚构性能材料 ${index + 1}\n\n这段文字仅用于测量小窗和阅读视图的换行、滚动与布局变化。**重要内容**保持可读，不能将隐藏帧间隔当作真人流畅验收。\n\n- 虚构观察项\n- 虚构解释项`).join('\n\n');
  const thread = { draft: '', status: 'complete', error: '', messages: [{ id: 'fictional-answer', role: 'assistant', content, status: 'complete' }] };
  return { view: 'explain', session: { id: 'fictional-motion-session', kind: 'text', text: '虚构性能测量材料', context: '这一上下文仅用于本机隐藏测试。', contextOrigin: 'manual', activeMode: 'context', saved: false,
    source: {}, createdAt: new Date().toISOString(), threads: { context: thread, independent: { ...thread, messages: [] }, visual: { ...thread, messages: [] } } },
    history: [], settingsSection: 'service', pinned: true, wide: false, capture: null,
    settings: { prefs: { appearance: require('../src/core/appearance.cjs').defaultAppearance() }, text: { model: 'fictional', baseUrl: 'http://127.0.0.1', hasKey: false }, vision: {} },
    status: { error: '', shortcutErrors: [], selection: '隐藏性能测量，未启动划词入口' } };
}

// 任意意外展示都立即失败，不能依赖 windowsHide 来隐藏 BrowserWindow。
for (const method of ['show', 'showInactive']) BrowserWindow.prototype[method] = function () { throw new Error('隐藏性能测试禁止显示窗口。'); };
const timeout = setTimeout(() => { console.error('隐藏窗口时序检查超时。'); app.exit(1); }, 25000);
app.whenReady().then(async () => {
  let desktop;
  try {
    const state = fakeState();
    ipcMain.handle('pickgloss:action', (_event, action) => action === 'bootstrap' ? { ok: true, value: state } : { ok: false, error: '性能测量不会执行真实操作。' });
    const loaded = new Module(sourcePath, module);
    loaded.filename = sourcePath; loaded.paths = module.paths;
    loaded._compile(measuredSource, sourcePath);
    desktop = loaded.exports.createDesktop({ onAction() {}, onSelection() {}, onStatus(change) { Object.assign(state.status, change); if (typeof change.wide === 'boolean') state.wide = change.wide; desktop?.broadcast(state); } });
    desktop.setAppearance(state.settings.prefs.appearance);
    await desktop.smoke();
    const win = BrowserWindow.getAllWindows()[0];
    win.webContents.setBackgroundThrottling(false);
    if (fixture === 'minimal') await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><html lang="zh"><body style="margin:0;background:#111214;color:white">虚构最小布局</body></html>'));
    else {
      await sleep(180);
      if (!(await win.webContents.executeJavaScript('Boolean(document.querySelector(".panel")) && Boolean(document.querySelector(".message"))'))) throw new Error('正式界面的虚构会话未完成加载。');
    }
    win.setBounds({ x: 120, y: 80, width: 300, height: 483 });
    const calls = [], nativeResize = [];
    const original = win.setBounds.bind(win);
    win.setBounds = bounds => { const started = performance.now(); original(bounds); calls.push({ at: started, cost: performance.now() - started, bounds: { ...bounds } }); };
    win.on('resize', () => nativeResize.push(performance.now()));
    await win.webContents.executeJavaScript(`globalThis.motionProbe = { raf: [], resize: [], running: true }; addEventListener('resize', () => { if (motionProbe.running) motionProbe.resize.push(performance.now()); }); function recordFrame(at) { if (!motionProbe.running) return; motionProbe.raf.push(at); requestAnimationFrame(recordFrame); } requestAnimationFrame(recordFrame);`);
    await sleep(250);
    const idle = await win.webContents.executeJavaScript('motionProbe.raf.splice(0)');
    const rounds = [];
    for (let round = 0; round < cycles * 2; round++) {
      const rendererStart = await win.webContents.executeJavaScript('performance.now()');
      const startCall = calls.length, started = performance.now(), target = round % 2 === 0;
      desktop.setWide(target);
      await sleep(target ? 430 : 360);
      const measured = calls.slice(startCall);
      const rendererRound = await win.webContents.executeJavaScript(`({ raf: motionProbe.raf.filter(at => at >= ${rendererStart} && at <= ${rendererStart + (target ? 370 : 300)}), resize: motionProbe.resize.filter(at => at >= ${rendererStart} && at <= ${rendererStart + (target ? 370 : 300)}) })`);
      rounds.push({ wide: target, elapsed: performance.now() - started, calls: measured.length, callCost: distribution(measured.map(value => value.cost)), callInterval: distribution(gaps(measured.map(value => value.at))), rendererRaf: distribution(gaps(rendererRound.raf)), rendererResize: distribution(gaps(rendererRound.resize)) });
    }
    const renderer = await win.webContents.executeJavaScript('motionProbe.running = false; ({raf: motionProbe.raf, resize: motionProbe.resize, width: innerWidth, height: innerHeight, visibility: document.visibilityState})');
    const report = { description: '真实 Electron 隐藏窗口时序诊断；虚构材料，禁止等同于 Windows 前台流畅验收。',
      sourceSha256: crypto.createHash('sha256').update(source).digest('hex'), sourceSnapshot: snapshotPath, rendererSha256, fixture, scheduler,
      instrumentation: traceScheduler ? '仅隔离宿主记录每次调度唤醒的单调时刻和绘制截止时间，生产模块没有日志。' : '未插入调度探针。', measuredSourceSha256: crypto.createHash('sha256').update(measuredSource).digest('hex'),
      electron: process.versions.electron, platform: process.platform, release: os.release(), displays: screen.getAllDisplays().map(value => ({ scaleFactor: value.scaleFactor, workArea: value.workArea })),
      animationSettings: systemPreferences.getAnimationSettings(), isolated, allWindowsHidden: BrowserWindow.getAllWindows().every(value => !value.isVisible()),
      idleRaf: distribution(gaps(idle)), nativeCalls: distribution(calls.map(value => value.cost)), nativeCallIntervals: distribution(gaps(calls.map(value => value.at))),
      nativeResizeIntervals: distribution(gaps(nativeResize)), rendererRaf: distribution(gaps(renderer.raf)), rendererResizeIntervals: distribution(gaps(renderer.resize)), rounds,
      raw: { calls, rendererRaf: renderer.raf, rendererResize: renderer.resize, nativeResize, schedulerTicks: schedulerTicks.map((tick, index) => ({ ...tick, earlyBy: tick.deadline - tick.at, drew: calls.some(call => call.at >= tick.at && call.at < (schedulerTicks[index + 1]?.at ?? Infinity)) })) },
      measurementNotes: '跨动作的全局间隔含人为等待；只使用 rounds 中各动作的 callInterval 评估调度。隐藏 rAF 可被节流，0帧或合帧单独记录，不能视为已呈现。',
      limitation: '隐藏窗口不走可见桌面的完整 DWM 呈现链路；该测量可定位调度与布局阻塞，不能单独证明或否定用户所述视觉卡顿。' };
    const cadencePass = rounds.every(round => round.callInterval.p95 !== null && round.callInterval.p95 <= 25);
    report.cadencePass = cadencePass;
    fs.mkdirSync(path.dirname(reportPath), { recursive: true }); fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ report: reportPath, isolated, hidden: report.allWindowsHidden, fixture, scheduler, cadencePass, nativeCalls: report.nativeCalls, idleRaf: report.idleRaf, rounds }, null, 2));
    desktop.dispose(); clearTimeout(timeout); app.exit(report.allWindowsHidden && (!process.argv.includes('--assert-cadence') || cadencePass) ? 0 : 1);
  } catch (error) { console.error(error.stack); desktop?.dispose(); clearTimeout(timeout); app.exit(1); }
});
