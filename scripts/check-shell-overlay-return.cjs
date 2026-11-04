'use strict';
// 使用真实 Shell 身份、正式来源助手和自有 WinForms 页面回放；不采集屏幕、不调用 OCR 或模型。
const electron = require('electron');
const { app, BrowserWindow, ipcMain, nativeImage, screen } = electron;
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { createDesktop } = require('../src/windows/desktop.cjs');
const { createTranslationTracker } = require('../src/windows/translation-tracker.cjs');
const { sourceForRegion, windowHandle } = require('../src/windows/translation-source.cjs');
const { translationSourceBuildArgs } = require('./build-native.cjs');
const { translationOptions, TRANSLATION_LANGUAGES } = require('../src/core/translation.cjs');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output/verification/2026-10-31-translation-reliability/shell-overlay-return');
const framework = path.join(process.env.WINDIR || 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319');
const compiler = path.join(framework, 'csc.exe');
fs.mkdirSync(output, { recursive: true });
const fixtureExe = path.join(output, 'ShellOverlayReturnFixture.exe');
const sourceExe = path.join(output, 'TranslationSource.exe');
const tempData = fs.mkdtempSync(path.join(os.tmpdir(), 'pickgloss-shell-overlay-'));
const fixtureSource = path.join(root, 'tests/fixtures/shell-overlay-return-fixture.cs');
const sourceForRegionMode = process.argv.includes('--source-for-region');
const fixtureBuild = spawnSync(compiler, ['/nologo', '/target:exe', '/platform:x64', `/out:${fixtureExe}`,
  ...['System.Windows.Forms.dll', 'System.Drawing.dll', 'System.Web.Extensions.dll'].map(name => `/reference:${path.join(framework, name)}`),
  fixtureSource], { encoding: 'utf8', windowsHide: true });
if (fixtureBuild.status !== 0) throw new Error('自有 Shell 往返页面夹具编译失败。');
const sourceBuild = spawnSync(compiler, translationSourceBuildArgs(framework, output), { encoding: 'utf8', windowsHide: true });
if (sourceBuild.status !== 0) throw new Error('正式来源助手编译失败。');

const report = { 通过: false, 模式: sourceForRegionMode
  ? '正式 TranslationSource 候选快照与 sourceForRegion 合成区域选择，再由 translation-tracker / desktop 关联真实 Windows Shell；自有 WinForms 页面前台往返'
  : '正式 TranslationSource / translation-tracker / desktop 与真实 Windows Shell；自有 WinForms 页面前台往返',
  界限: ['只读 Shell 窗口身份、进程号与边界元数据。', '不采集像素、不读取桌面图标名称、不调用 OCR 或翻译模型。', '覆盖内容与 1×1 屏幕区域均为合成材料。'],
  来源候选选择: null, 场景: [], 来源状态: [], 前台请求: [], 最终状态: null };
let fixture, fixtureExit, fixtureExitCode = null, fixtureError = null, fixtureStderr = '', fixtureBuffer = '', fixtureMessages = [], tracker, desktop, state, controls, overlay;

function startFixture() {
  fixture = spawn(fixtureExe, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: false });
  fixture.stdout.setEncoding('utf8');
  fixture.stdout.on('data', chunk => {
    fixtureBuffer += chunk;
    if (fixtureBuffer.length > 32768) { fixture.kill(); return; }
    let end;
    while ((end = fixtureBuffer.indexOf('\n')) >= 0) {
      const line = fixtureBuffer.slice(0, end); fixtureBuffer = fixtureBuffer.slice(end + 1);
      try { fixtureMessages.push(JSON.parse(line)); } catch {}
    }
  });
  fixture.stderr.setEncoding('utf8');
  fixture.stderr.on('data', chunk => { fixtureStderr = (fixtureStderr + chunk).slice(-2000); });
  fixture.on('error', error => { fixtureError = error.message; fixtureExit = true; });
  fixture.on('exit', code => { fixtureExitCode = code; fixtureExit = true; });
}

async function waitFor(description, check, timeout = 6000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await delay(30);
  }
  throw new Error(description);
}

async function fixtureCommand(command) {
  if (!fixture?.stdin?.writable || fixtureExit) throw new Error('自有前台夹具不可用。');
  fixture.stdin.write(command + '\n');
  return waitFor('自有页面夹具未应答：' + command, () => {
    const type = command === 'probe' ? 'probe' : command.startsWith('focus-') ? 'focus' : 'inspect';
    const target = command.startsWith('focus-') ? command.slice(6) : null;
    const handle = command.startsWith('inspect ') ? command.slice(8) : null;
    const index = fixtureMessages.findIndex(value => value.type === type &&
      (target === null || value.target === target) &&
      (handle === null || value.window?.handle === handle));
    return index < 0 ? null : fixtureMessages.splice(index, 1)[0];
  });
}

async function waitForFixtureActivation(ready, stage) {
  console.log(JSON.stringify({ state: 'waiting-for-activation', stage, title: '虚构网页前台往返验证', timeoutSeconds: 180 }));
  const activationDeadline = Date.now() + 180000;
  while (Date.now() < activationDeadline) {
    const probe = await fixtureCommand('probe');
    if (probe.foreground?.handle === ready.page.handle && probe.foreground?.pid === ready.pid) {
      console.log(JSON.stringify({ state: 'fixture-activated', stage, foreground: true })); return true;
    }
    await delay(250);
  }
  return false;
}

async function waitForShellDesktop(ready, stage) {
  console.log(JSON.stringify({ state: 'waiting-for-shell-desktop', stage,
    instruction: '请操作员正常点击任务栏“显示桌面”；脚本不会发送键盘或鼠标输入。', timeoutSeconds: 60 }));
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const probe = await fixtureCommand('probe');
    const foreground = probe.foreground;
    if (foreground?.pid === ready.shell.pid && foreground.visible === true &&
      ['Progman', 'WorkerW'].includes(foreground.className)) {
      await delay(700);
      const stableProbe = await fixtureCommand('probe');
      const stableForeground = stableProbe.foreground;
      const stable = stableForeground?.pid === ready.shell.pid && stableForeground.visible === true &&
        ['Progman', 'WorkerW'].includes(stableForeground.className);
      if (!stable) continue;
      const observation = { 目标: '操作员正常显示桌面', 前台窗口类名: stableForeground.className,
        前台进程匹配Shell: stableForeground.pid === ready.shell.pid, 前台可见: stableForeground.visible === true,
        稳定观察毫秒: 700, 可见性确认方式: 'Win32窗口元数据；不采集桌面像素', 阶段: stage };
      report.前台请求.push(observation);
      console.log(JSON.stringify({ state: 'shell-desktop-observed', ...observation }));
      return stableProbe;
    }
    await delay(250);
  }
  report.前台请求.push({ 目标: '操作员正常显示桌面', 前台等待超时: true, 前台等待上限秒: 60 });
  return null;
}

async function waitForStable(description, check, stableMs = 700, timeout = 12000) {
  const deadline = Date.now() + timeout;
  let stableSince = null;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) {
      stableSince ??= Date.now();
      if (Date.now() - stableSince >= stableMs) return value;
    } else stableSince = null;
    await delay(25);
  }
  throw new Error(description);
}

async function inspectOverlay(label) {
  const handle = windowHandle(overlay);
  if (!handle) throw new Error('无法取得自有覆盖窗口的原生句柄。');
  const result = await fixtureCommand('inspect ' + handle);
  const window = result.window;
  const state = window ? { label, handle: window.handle, className: window.className,
    electronVisible: overlay.isVisible(), win32Visible: window.visible, iconic: window.iconic,
    dwmCloaked: window.dwmCloaked, bounds: window.bounds,
    nativeVisible: window.visible === true && window.iconic === false && window.dwmCloaked === false } : null;
  report.覆盖原生可见性 ||= [];
  report.覆盖原生可见性.push(state);
  return state;
}

function layoutTranslation(item, activate = false) {
  item.layout = desktop.showTranslation(item.placement, item.options.displayMode, {
    controlsPinned: item.controlsPinned, activate,
  });
}

async function action(name, payload = {}) {
  const item = state.translation;
  if (name === 'pin-translation-controls' && item) {
    item.controlsPinned = payload.pinned === true;
    desktop.setTranslationControlsPinned(item.controlsPinned);
  } else if (name === 'set-translation-options' && item) {
    item.options = translationOptions({ ...item.options, ...payload.options });
    layoutTranslation(item, false);
  } else if (name === 'translation-content-height' && item) {
    const bounds = desktop.resizeTranslationHeight(item.placement, payload.contentHeight);
    if (bounds) item.layout = { ...item.layout, controlBounds: bounds };
  }
  desktop.broadcast(state);
}

async function clickControl(control, description, expected) {
  await waitFor('正式翻译菜单尚未加载。', async () => controls && !controls.webContents.isLoading() &&
    await controls.webContents.executeJavaScript('!!document.querySelector(".translation-pin")'));
  const scripts = {
    pin: '(() => { const button = document.querySelector(".translation-pin"); if (!button || button.disabled) throw new Error("验证控件不可用"); button.click(); })()',
    compare: '(() => { const button = [...document.querySelectorAll(".translation-display button")].find(value => value.textContent.trim() === "对照"); if (!button || button.disabled) throw new Error("验证控件不可用"); button.click(); })()',
    overlay: '(() => { const button = [...document.querySelectorAll(".translation-display button")].find(value => value.textContent.trim() === "覆盖"); if (!button || button.disabled) throw new Error("验证控件不可用"); button.click(); })()',
  };
  if (!scripts[control]) throw new Error('验证菜单动作无效。');
  await controls.webContents.executeJavaScript(scripts[control]);
  await waitFor(description, () => expected() ? true : null);
}

async function run() {
  app.setPath('userData', path.join(tempData, 'user-data'));
  app.setPath('sessionData', path.join(tempData, 'session-data'));
  app.on('window-all-closed', () => {});
  startFixture();
  const ready = await waitFor('自有 Shell 往返夹具未创建页面和桌面身份快照。',
    () => fixtureMessages.find(value => value.type === 'ready'), 12000);
  fixtureMessages.splice(fixtureMessages.indexOf(ready), 1);
  if (process.argv.includes('--wait-for-activation')) {
    const activated = await waitForFixtureActivation(ready, '开始前建立受信任的前台所有者');
    report.前台请求.push({ 目标: '自有网页替身', 操作者主动激活: activated,
      阶段: '开始前建立受信任的前台所有者', 页面标题: '虚构网页前台往返验证', 前台等待上限秒: 180 });
    if (!activated) throw new Error('等待180秒后自有网页替身仍未成为前台；未请求 Shell 切换。');
  }
  const waitForOperatorDesktop = sourceForRegionMode && process.argv.includes('--wait-for-activation');
  let focusedShell;
  if (waitForOperatorDesktop) {
    const revealed = await waitForShellDesktop(ready, '初次显示桌面并采集合成区域');
    if (!revealed) throw new Error('等待操作员显示桌面超时；未调用 SetForegroundWindow 或继续来源绑定。');
    focusedShell = { accepted: true, targetForeground: true, foreground: revealed.foreground, shell: revealed.shell };
  } else focusedShell = await fixtureCommand('focus-shell');
  report.前台请求.push({ 目标: 'Shell', 调用接受: focusedShell.accepted, 目标为当前前台: focusedShell.targetForeground,
    前台进程与Shell相同: focusedShell.foreground?.pid === ready.shell.pid,
    前台窗口类名: focusedShell.foreground?.className || null,
    Shell宿主可见: ready.shell.visible === true, 前台宿主可见: focusedShell.foreground?.visible === true });
  const shellForeground = focusedShell.targetForeground || focusedShell.foreground?.pid === ready.shell.pid &&
    ['Progman', 'WorkerW'].includes(focusedShell.foreground?.className);
  if (!shellForeground) throw new Error('Windows 未把 Shell 交给自有夹具；未继续来源绑定或覆盖。');

  state = { view: 'explain', session: null, history: [], capture: null, translation: null, status: {},
    settings: { prefs: { appearance: { current: { mode: 'light', material: 'solid' }, reducedMotion: false }, screenshotTranslation: {} },
      text: {}, vision: {} }, translationLanguages: TRANSLATION_LANGUAGES };
  desktop = createDesktop({ onAction: action,
    onStatus(value) { Object.assign(state.status, value); if (desktop) desktop.broadcast(state); },
    sourceFactory({ onChange }) {
      tracker = createTranslationTracker({ helperPath: sourceExe, onChange(value) {
        report.来源状态.push({ state: value.state, windowActive: value.windowActive === true });
        onChange(value);
      } });
      return tracker;
    } });
  const captured = await tracker.capture();
  if (!captured || captured.pid !== ready.shell.pid) throw new Error('正式来源助手未把当前真实 Shell 识别为截图来源。');
  if (!await tracker.sealCapture(captured)) throw new Error('Shell 来源快照未能封存。');

  const display = screen.getPrimaryDisplay(), area = display.workArea;
  let region = { x: area.x + area.width - 8, y: area.y + area.height - 8, width: 1, height: 1 };
  let source = captured;
  if (sourceForRegionMode) {
    const dipRegion = { x: Math.round(display.bounds.x + 24), y: Math.round(display.bounds.y + 24), width: 1, height: 1 };
    const physicalRegion = screen.dipToScreenRect(null, dipRegion);
    source = sourceForRegion(captured, physicalRegion);
    const candidates = Array.isArray(captured.candidates) ? captured.candidates : [];
    const relation = candidate => {
      const b = candidate.bounds;
      const intersects = physicalRegion.x < b.x + b.width && physicalRegion.x + physicalRegion.width > b.x &&
        physicalRegion.y < b.y + b.height && physicalRegion.y + physicalRegion.height > b.y;
      const contains = physicalRegion.x >= b.x && physicalRegion.y >= b.y &&
        physicalRegion.x + physicalRegion.width <= b.x + b.width && physicalRegion.y + physicalRegion.height <= b.y + b.height;
      return { intersects, contains };
    };
    const indexed = candidates.map((candidate,index) => ({ candidate, index, ...relation(candidate) }));
    const firstIntersecting = indexed.find(value => value.intersects) || null;
    const selectedIndex = source ? candidates.findIndex(candidate => candidate.handle === source.handle && candidate.pid === source.pid) : -1;
    const blocker = source ? indexed.find(value => value.index === selectedIndex) : firstIntersecting;
    const inspected = blocker ? await fixtureCommand('inspect ' + blocker.candidate.handle) : null;
    const blockerClass = inspected?.window?.className || null;
    const shellPidMatched = source?.pid === ready.shell.pid;
    report.来源候选选择 = { 候选数: candidates.length,
      捕获前台: { handle: captured.handle, pid: captured.pid, bounds: captured.bounds, shellClassName: ready.shell.className },
      合成DIP区域: dipRegion, 正式换算物理区域: physicalRegion,
      sourceForRegion是否选中: !!source,
      sourceForRegion选择: source ? { candidateIndex: selectedIndex, handle: source.handle, pid: source.pid,
        shellPidMatched, bounds: source.bounds, 与捕获前台相同句柄: source.handle === captured.handle, className: blockerClass } : null,
      阻挡或首个相交候选: blocker ? { candidateIndex: blocker.index, handle: blocker.candidate.handle, pid: blocker.candidate.pid,
        shellPidMatched: blocker.candidate.pid === ready.shell.pid, className: blockerClass,
        与合成区域相交: blocker.intersects, 完全包含合成区域: blocker.contains } : null,
      firstIntersectingCandidateIndex: firstIntersecting?.index ?? null,
      遮挡说明: !source ? blocker ? blocker.contains
        ? '正式 sourceForRegion 未选中候选；首个相交候选完整包含区域但没有可用来源。'
        : '正式规则遇到首个相交窗口未完整包含合成区域，因此返回null。'
        : '候选列表没有窗口与合成区域相交。'
        : !shellPidMatched ? `首个合成区域来源属于非Shell进程，窗口类名=${blockerClass || '未知'}。`
        : `选中Shell进程候选，窗口类名=${blockerClass || '未知'}。`,
      相交候选顺序: indexed.filter(value=>value.intersects).map(value=>({ index:value.index, handle:value.candidate.handle,
        pid:value.candidate.pid, shellPidMatched:value.candidate.pid===ready.shell.pid, bounds:value.candidate.bounds,
        完全包含合成区域:value.contains })) };
    if (!source) throw new Error(`正式 sourceForRegion 未选出来源；阻挡候选类名=${blockerClass || '未知'}。`);
    if (!shellPidMatched) throw new Error(`正式 sourceForRegion 选中非Shell候选；类名=${blockerClass || '未知'}，序号=${selectedIndex}；未继续覆盖往返。`);
    if (!['Progman', 'WorkerW'].includes(blockerClass)) throw new Error(`正式 sourceForRegion 选中的Shell候选类型不是Progman/WorkerW；类名=${blockerClass || '未知'}。`);
    region = physicalRegion;
  }
  const placement = { sourceBinding: true, source, displayId: display.id,
    displayBounds: { ...display.bounds }, region };
  const width = 16, height = 16, bitmap = Buffer.alloc(width * height * 4);
  for (let index = 3; index < bitmap.length; index += 4) bitmap[index] = 255;
  const imageData = nativeImage.createFromBitmap(bitmap, { width, height }).toDataURL();
  state.translation = { id: 'shell-overlay-return-fixture', placement, imageData, status: 'complete', method: 'windows-ocr',
    width, height, controlsPinned: false, overlayAvailable: true, blocks: [{ id: 0, text: 'Desktop', translation: '桌面', x: 1, y: 1, width: 12, height: 12 }],
    warning: '', error: '', options: translationOptions({ displayMode: 'overlay', searchEnabled: false }) };
  layoutTranslation(state.translation, false);
  ipcMain.handle('pickgloss:action', async (event, name, payload = {}) => {
    if (name === 'bootstrap') return { ok: true, value: desktop.stateFor(event, state) };
    if (!desktop.authorize(event, name)) return { ok: false, error: '验证窗口未授权此动作。' };
    try { await action(name, payload); return { ok: true }; }
    catch { return { ok: false, error: '验证动作未完成。' }; }
  });
  desktop.broadcast(state);
  await waitFor('正式覆盖窗口和翻译菜单未完成创建。', () => {
    const windows = BrowserWindow.getAllWindows();
    overlay = windows.find(win => win.webContents.getURL().endsWith('window=translation-overlay'));
    controls = windows.find(win => win.webContents.getURL().endsWith('window=translation'));
    return overlay && controls ? true : null;
  });
  await waitFor('真实 Shell 前台时正式覆盖和工具条未出现。', () => overlay?.isVisible() && controls?.isVisible());
  report.场景.push({ 名称: '虚构 OCR 结果绑定真实 Shell', 来源进程匹配Shell: captured.pid === ready.shell.pid,
    来源窗口类名: ready.shell.className, 覆盖可见: overlay.isVisible(), 菜单可见: controls.isVisible(), 菜单置顶: controls.isAlwaysOnTop() });

  await clickControl('pin', '翻译菜单没有完成置顶。', () => state.translation.controlsPinned);
  if (!controls.isAlwaysOnTop()) throw new Error('菜单置顶状态没有进入原生窗口。');
  report.场景.push({ 名称: '置顶翻译菜单', 来源仍为Shell: true, 菜单置顶: controls.isAlwaysOnTop(), 覆盖可见: overlay.isVisible() });

  if (process.argv.includes('--wait-for-activation')) {
    const pageForeground = await waitForFixtureActivation(ready, '置顶后离开Shell');
    report.前台请求.push({ 目标: '自有网页替身', 操作者主动激活: pageForeground,
      阶段: '置顶后离开Shell', 页面标题: '虚构网页前台往返验证', 前台等待上限秒: 180 });
    if (!pageForeground) throw new Error('等待180秒后自有网页替身仍未成为前台；未请求返回 Shell。');
  } else {
    const focusedPage = await fixtureCommand('focus-page');
    report.前台请求.push({ 目标: '自有网页替身', 调用接受: focusedPage.accepted, 目标为当前前台: focusedPage.targetForeground,
      前台进程为自有夹具: focusedPage.foreground?.pid === ready.pid });
    if (!focusedPage.targetForeground) throw new Error('Windows 未把前台交给自有网页替身；未用输入注入绕过。');
  }
  await waitFor('离开 Shell 后来源状态没有变为 inactive。', () => report.来源状态.at(-1)?.state === 'inactive' && !overlay.isVisible());
  report.场景.push({ 名称: '切到自有网页替身', 来源状态: report.来源状态.at(-1)?.state,
    覆盖可见: overlay.isVisible(), 置顶菜单仍可见: controls.isVisible() });

  let returnedShell;
  if (waitForOperatorDesktop) {
    const returned = await waitForShellDesktop(ready, '从自有网页返回显示桌面');
    if (!returned) throw new Error('等待操作员从自有网页显示桌面超时；未调用 SetForegroundWindow。');
    returnedShell = { accepted: true, targetForeground: true, foreground: returned.foreground, shell: returned.shell };
  } else returnedShell = await fixtureCommand('focus-shell');
  report.前台请求.push({ 目标: '返回同一 Shell', 操作方式: waitForOperatorDesktop ? '操作员正常显示桌面' : '夹具SetForegroundWindow',
    调用接受: returnedShell.accepted, 目标为当前前台: returnedShell.targetForeground,
    前台进程与Shell相同: returnedShell.foreground?.pid === ready.shell.pid,
    前台窗口类名: returnedShell.foreground?.className || null,
    Shell宿主可见: ready.shell.visible === true, 前台宿主可见: returnedShell.foreground?.visible === true });
  if (!(returnedShell.targetForeground || returnedShell.foreground?.pid === ready.shell.pid &&
    ['Progman', 'WorkerW'].includes(returnedShell.foreground?.className))) throw new Error('Windows 未把前台交还同一 Shell。');
  await waitForStable('返回 Shell 后来源状态未稳定为 active。',
    () => report.来源状态.at(-1)?.state === 'active' ? true : null, 700);
  const overlayAtReturn = await inspectOverlay('返回同一 Shell 后');
  report.场景.push({ 名称: '返回同一未变化 Shell 后覆盖恢复', 来源状态: report.来源状态.at(-1)?.state,
    覆盖可见: overlay.isVisible(), 覆盖Win32可见: overlayAtReturn?.win32Visible,
    覆盖最小化: overlayAtReturn?.iconic, 覆盖DWM隐藏: overlayAtReturn?.dwmCloaked,
    置顶菜单仍可见: controls.isVisible(), 菜单仍置顶: controls.isAlwaysOnTop() });

  await clickControl('compare',
    '切换对照翻译未完成。', () => state.translation.options.displayMode === 'compare');
  await clickControl('overlay',
    '从对照返回覆盖未完成。', () => state.translation.options.displayMode === 'overlay');
  await waitFor('覆盖与对照往返后覆盖未保持可见。', () => overlay.isVisible());
  await waitForStable('点击覆盖后Electron窗口可见状态未稳定。', () => overlay.isVisible() ? true : null, 700);
  const overlayAfterClick = await inspectOverlay('点击覆盖后');
  report.场景.push({ 名称: '返回后对照与覆盖往返', 显示模式: state.translation.options.displayMode,
    覆盖可见: overlay.isVisible(), 覆盖Win32可见: overlayAfterClick?.win32Visible,
    覆盖最小化: overlayAfterClick?.iconic, 覆盖DWM隐藏: overlayAfterClick?.dwmCloaked, 菜单置顶: controls.isAlwaysOnTop() });
  report.通过 = overlayAtReturn?.nativeVisible === true && overlayAfterClick?.nativeVisible === true;
  if (!report.通过) report.错误 = '来源恢复后的自有覆盖窗口未在稳定检查中达到Win32可见、非最小化、非DWM隐藏状态。';
}

app.whenReady().then(run).catch(error => { report.错误 = error.message; }).finally(async () => {
  report.来源状态 = report.来源状态.slice(0, 80);
  report.最终状态 = { 覆盖可见: !!overlay && !overlay.isDestroyed() && overlay.isVisible(),
    菜单可见: !!controls && !controls.isDestroyed() && controls.isVisible(), 菜单置顶: !!controls && !controls.isDestroyed() && controls.isAlwaysOnTop(),
    前台归属: fixtureMessages.findLast(value => value.type === 'probe')?.foreground?.className || null };
  try { desktop?.dispose(); } catch {}
  if (fixture?.stdin?.writable && !fixtureExit) { try { fixture.stdin.write('quit\n'); } catch {} }
  const end = Date.now() + 1500;
  while (fixture && !fixtureExit && Date.now() < end) await delay(25);
  if (fixture && !fixtureExit) fixture.kill();
  try { ipcMain.removeHandler('pickgloss:action'); } catch {}
  const reportPath = path.join(output, 'report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify({ report: reportPath, passed: report.通过, mode: report.模式,
    scope: report.界限, sourceSelection: report.来源候选选择, scenes: report.场景, foregroundAttempts: report.前台请求,
    states: report.来源状态, error: report.错误 || null }, null, 2));
  app.exit(report.通过 ? 0 : 1);
});
