'use strict';
// 使用真实来源助手和正式翻译窗口核对来源跟随；只读取自有窗口元数据与自有 renderer canvas，不采集屏幕。
const electron = require('electron');
const { app, ipcMain, nativeImage, screen, session, BrowserWindow } = electron;
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { spawn, spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { deflateSync } = require('node:zlib');
const vm = require('node:vm');
const { createTranslationSource, sourceForRegion } = require('../src/windows/translation-source.cjs');
const { translationOptions, TRANSLATION_LANGUAGES } = require('../src/core/translation.cjs');
const { createStore } = require('../src/core/store.cjs');

const injectedNoSourceGate = process.argv.includes('--inject-no-source-gate');
const captureStartPanel = process.argv.includes('--capture-start-panel');
const captureStartOther = process.argv.includes('--capture-start-other');
const injectedNoCaptureRestore = process.argv.includes('--inject-no-capture-restore');
const pinReturnOnly = process.argv.includes('--pin-return-only');
const externalOtherProcess = process.argv.includes('--external-other-process');
const injectedNoPinReturn = process.argv.includes('--inject-no-pin-return');
const quickMenuReturnArg = process.argv.find(value => /^--quick-menu-return=(0|5|15|35|80)$/.test(value));
const quickMenuReturnMs = quickMenuReturnArg ? Number(quickMenuReturnArg.split('=')[1]) : null;
const outputIndex = process.argv.indexOf('--output-dir');
if (outputIndex >= 0 && (!process.argv[outputIndex + 1] || process.argv[outputIndex + 1].startsWith('--'))) {
  throw new Error('--output-dir 必须指定目录。');
}
const runStamp = new Date().toISOString().replace(/[:.]/g, '-');
const output = path.resolve(outputIndex >= 0 ? process.argv[outputIndex + 1]
  : path.join(__dirname, `../output/verification/source-follow-${runStamp}-${process.pid}`));
const nativeOutput = path.join(output, 'native');
const systemRoot = process.env.SystemRoot || 'C:\\Windows';
const framework = path.join(systemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319');
const compiler = path.join(framework, 'csc.exe');
const helperPath = path.join(nativeOutput, 'TranslationSource.exe');
const fixturePath = path.join(nativeOutput, 'TranslationSourceFixture.exe');
const userData = fsSync.mkdtempSync(path.join(os.tmpdir(), 'pickgloss-verification-source-'));
app.setPath('userData', userData);
app.setName('PickGloss 来源跟随隔离验证');
app.on('window-all-closed', () => {});

const windows = [];
const networkAttempts = [];
const consoleErrors = [];
const rendererFailures = [];
const nativeEvents = [];
const forwardedEvents = [];
const scenes = [];
const failures = [];
let desktop, fixture, watcher, state, placement, overlay, controls, sourceReady, mainHarness;
let captureWindowForReport = null;
let sourceStatus = null;
let fixtureOutput = '';
let probeSequence = 0;
const pendingProbes = new Map();
const pendingFixtureProbes = new Map();
let fixtureExit = null;
let finishCalled = false;
let initialFocusProbe = null;
let lastFixtureProbe = null;
let lastFocusAttempt = null;
let scenarioPhase = '初始化';
const captureSummaries = [];
const actionCalls = [];
const modelCalls = [];
const restorationAttempts = [];
const restorationReplies = [];
let rendererDiagnostics = null;
let captureChainActive = false;
let pinReturnAwaiting = false;
let lastPinReturnProbe = null;
let quickReturnReply = null;
let fixtureOther = null, fixtureOtherExit = null, fixtureOtherReady = null;

function compile(source, target, references) {
  const args = ['/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/out:' + target,
    ...references.map(reference => '/reference:' + path.join(framework, reference)), source];
  const result = spawnSync(compiler, args, { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stdout || result.stderr || result.error?.message || '原生来源验证夹具编译失败。');
}

function buildNativeInputs() {
  if (process.platform !== 'win32') throw new Error('此原生来源跟随验证仅支持 Windows。');
  if (!fsSync.existsSync(compiler)) throw new Error('未找到 Windows .NET Framework 编译器。');
  fsSync.mkdirSync(nativeOutput, { recursive: true });
  compile(path.join(__dirname, '../src/windows/TranslationSource.cs'), helperPath, ['System.Windows.Forms.dll', 'System.Web.Extensions.dll']);
  compile(path.join(__dirname, '../tests/fixtures/translation-source-fixture.cs'), fixturePath,
    ['System.Windows.Forms.dll', 'System.Web.Extensions.dll']);
}

function handleOf(win) {
  const value = win.getNativeWindowHandle();
  return String(value.length >= 8 ? value.readBigUInt64LE() : value.readUInt32LE());
}

function parseFixtureOutput() {
  let end;
  while ((end = fixtureOutput.indexOf('\n')) >= 0) {
    const line = fixtureOutput.slice(0, end);
    fixtureOutput = fixtureOutput.slice(end + 1);
    if (!line) continue;
    let value;
    try { value = JSON.parse(line); }
    catch { failures.push('夹具输出不是有效 JSON。'); continue; }
    if (value.type === 'ready') {
      if (sourceReady) failures.push('夹具重复报告 ready。');
      else sourceReady = value;
    } else if (value.type === 'error') {
      failures.push('来源夹具无法完成双窗口并排布局。');
    } else if (value.type === 'probe' && Number.isSafeInteger(value.id)) {
      const pending = pendingProbes.get(value.id);
      if (pending) { pendingProbes.delete(value.id); clearTimeout(pending.timer); pending.resolve(value); }
    } else if (value.type === 'fixture-probe' && Number.isSafeInteger(value.id)) {
      lastFixtureProbe = { 前台为自有A: value.foreground === sourceReady?.handle,
        前台进程归属: foregroundOwner(value.foregroundPid),
        A可见: value.sourceVisible === true, B可见: value.otherVisible === true };
      const pending = pendingFixtureProbes.get(value.id);
      if (pending) { pendingFixtureProbes.delete(value.id); clearTimeout(pending.timer); pending.resolve(value); }
    } else if (value.type === 'quick-return') {
      quickReturnReply = value;
    } else if (value.type === 'focus-attempt') {
      lastFocusAttempt = { 系统接受前台请求: value.accepted === true,
        请求后前台为A: value.sourceForeground === true, A可见: value.sourceVisible === true,
        前台进程归属: foregroundOwner(value.foregroundPid),
        单击自有A: value.inputClick === true, 点击目标为自有A: value.clickTargetIsSource === true,
        点击命中来源夹具: value.clickTargetIsSource === true,
        鼠标位置已还原: value.cursorRestored === true, 焦点前临时置顶A: value.raisedForInput === true };
    }
  }
}

function foregroundOwner(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return '未知';
  if (pid === sourceReady?.pid) return '自有来源夹具进程';
  if (pid === fixtureOtherReady?.pid) return '自有独立另一窗口夹具进程';
  if (pid === process.pid) return '本次隔离 Electron 进程';
  return '其他进程';
}

function ownsForeground(pid) { return [sourceReady?.pid, fixtureOtherReady?.pid, process.pid].includes(pid); }

async function startExternalOtherFixture() {
  let output = '';
  fixtureOther = spawn(fixturePath, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  fixtureOther.stdout.on('data', chunk => {
    output += chunk.toString('utf8');
    if (output.length > 32768) { failures.push('独立另一窗口夹具输出超出限制。'); fixtureOther.kill(); return; }
    let end;
    while ((end = output.indexOf('\n')) >= 0) {
      const line = output.slice(0, end); output = output.slice(end + 1);
      try { const value = JSON.parse(line); if (value.type === 'ready') fixtureOtherReady = value; } catch { failures.push('独立夹具输出无效。'); }
    }
  });
  fixtureOther.stderr.on('data', () => {});
  fixtureOther.on('error', () => { fixtureOtherExit = true; }); fixtureOther.on('exit', () => { fixtureOtherExit = true; });
  await waitFor('独立另一窗口夹具创建完成', () => fixtureOtherReady, { timeoutMs: 5000 });
  assert.notEqual(fixtureOtherReady.pid, sourceReady.pid, 'A 与 B 必须属于两个不同的原生进程');
  sourceReady.other = fixtureOtherReady.handle;
  sendFixture(`external-other ${fixtureOtherReady.handle} ${fixtureOtherReady.pid}`);
}

function startFixture() {
  fixture = spawn(fixturePath, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  fixture.stdout.setEncoding('utf8');
  fixture.stdout.on('data', chunk => {
    fixtureOutput += chunk;
    if (fixtureOutput.length > 32768) { failures.push('夹具输出超出限制。'); fixture.kill(); return; }
    parseFixtureOutput();
  });
  fixture.stderr.on('data', () => {});
  fixture.on('error', error => { fixtureExit = { code: -1, error: error.message }; });
  fixture.on('exit', (code, signal) => {
    fixtureExit = { code, signal };
    for (const pending of pendingProbes.values()) { clearTimeout(pending.timer); pending.reject(new Error('来源夹具已退出，无法取得窗口探针。')); }
    pendingProbes.clear();
    for (const pending of pendingFixtureProbes.values()) { clearTimeout(pending.timer); pending.reject(new Error('来源夹具已退出，无法确认前台窗口。')); }
    pendingFixtureProbes.clear();
  });
  return waitFor('来源夹具创建自有窗口', () => sourceReady, { timeoutMs: 10000 });
}

function sendFixture(command) {
  if (externalOtherProcess && command === 'other' && fixtureOther?.stdin?.writable && !fixtureOtherExit) {
    fixtureOther.stdin.write('focus\n'); return;
  }
  if (!fixture?.stdin?.writable || fixtureExit) throw new Error('来源夹具输入管道不可用。');
  fixture.stdin.write(command + '\n');
}

function fixtureProbe() {
  if (!sourceReady) return Promise.reject(new Error('来源夹具尚未就绪。'));
  const id = ++probeSequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pendingFixtureProbes.delete(id); reject(new Error('等待来源夹具前台探针超时。')); }, 3000);
    pendingFixtureProbes.set(id, { resolve, reject, timer });
    sendFixture(`fixture-probe ${id}`);
  });
}

async function focusSourceAndConfirm(description) {
  sendFixture('focus');
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = await fixtureProbe();
    if (value.foreground === sourceReady.handle && value.sourceVisible) return value;
    await delay(120);
  }
  throw new Error(`${description}；原生前台请求=${JSON.stringify(lastFocusAttempt)}；探针=${JSON.stringify(lastFixtureProbe)}`);
}

function probe() {
  if (!sourceReady || !overlay || !controls) return Promise.reject(new Error('尚未创建可探测的正式翻译窗口。'));
  const id = ++probeSequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pendingProbes.delete(id); reject(new Error('等待自有窗口探针超时。')); }, 3000);
    pendingProbes.set(id, { resolve, reject, timer });
    sendFixture(`probe ${id} ${handleOf(overlay)} ${handleOf(controls)} ${process.pid}`);
  });
}

async function waitFor(description, inspect, { timeoutMs = 6000, intervalMs = 35 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await inspect();
    if (last) return last;
    await delay(intervalMs);
  }
  throw new Error(`等待条件超时：${description}；最后状态=${JSON.stringify(last ?? null)}`);
}

async function waitForForeground(handle, description) {
  return waitFor(description, async () => {
    const value = await probe();
    return value.foreground === handle ? value : null;
  });
}

function reportScene(name, value, extra = {}) {
  const scene = {
    场景: name,
    时间: new Date().toISOString(),
    来源助手状态: sourceStatus?.state || null,
    窗口: {
      覆盖译文可见: overlay && !overlay.isDestroyed() ? overlay.isVisible() : false,
      自有工具条可见: controls && !controls.isDestroyed() ? controls.isVisible() : false,
      工具条已聚焦: controls && !controls.isDestroyed() ? controls.isFocused() : false,
    },
    原生探针: value || null,
    ...extra,
  };
  scenes.push(scene);
  return scene;
}

function assertProbeOwned(value) {
  assert.equal(value.overlayVisible, overlay.isVisible(), '原生探针与 Electron 覆盖窗口显隐状态一致');
  assert.equal(value.controlsVisible, controls.isVisible(), '原生探针与 Electron 工具条显隐状态一致');
}

function layoutTranslation(item, { activate = false } = {}) {
  const extraHeight = item.status === 'failed' ? 56
    : item.status === 'complete' && (item.method === 'vision' || item.unchangedCount > 0) ? 20 : 0;
  item.layout = desktop.showTranslation(item.placement, item.options.displayMode, {
    activate, extraHeight,
    contentHeight: item.options.displayMode === 'compare' ? item.contentHeight : undefined,
  });
}

function captureSnapshotFactory({ onChange }) {
  watcher = createTranslationSource({ helperPath, spawnHelper(file, args, options) {
    const child = spawn(file, args, options); let lines = '';
    child.stdout.on('data', data => { lines += data.toString('utf8'); let end;
      while ((end = lines.indexOf('\n')) >= 0) { const line = lines.slice(0, end); lines = lines.slice(end + 1);
        try { const value = JSON.parse(line); if (value.type === 'restore') restorationReplies.push(value); } catch {} }
    }); return child;
  }, onChange(value) {
    nativeEvents.push({ ...value, phase: scenarioPhase, time: new Date().toISOString() });
    sourceStatus = value;
    if (injectedNoSourceGate && value.state === 'inactive') return;
    if (injectedNoPinReturn && pinReturnAwaiting && value.state === 'active') return;
    forwardedEvents.push(value);
    onChange(value);
  } });
  const restore = watcher.restore.bind(watcher);
  watcher.restore = async (source, context) => {
    const before = await fixtureProbe();
    const restored = injectedNoCaptureRestore ? false : await restore(source, context);
    restorationAttempts.push({ 截图层持有前台: before.foreground === handleOf(context.capture),
      前台为自有A: before.foreground === sourceReady.handle, 前台为自有B: before.foreground === sourceReady.other,
      前台归属: foregroundOwner(before.foregroundPid), 截图层可见: context.capture.isVisible(), 截图层聚焦: context.capture.isFocused(),
      目标为自有A: source.handle === sourceReady.handle, 恢复成功: restored });
    return restored;
  };
  return watcher;
}

function syntheticImageData(width, height) {
  const checksum = bytes => {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const contents = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(checksum(contents));
    return Buffer.concat([length, contents, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, 36, 90, 136, 255]))), chunk('IEND', Buffer.alloc(0)),
  ]);
  const onePixel = nativeImage.createFromBuffer(png);
  if (onePixel.isEmpty()) throw new Error('无法创建自有验证用的合成 PNG。');
  return onePixel.resize({ width: Math.max(1, Math.ceil(width)), height: Math.max(1, Math.ceil(height)) }).toDataURL();
}

function makePlacement(snapshot) {
  // 助手返回物理像素边界；用 Electron 的正式转换得到 DIP 后选取窗内固定小区。
  const a = screen.screenToDipPoint({ x: snapshot.bounds.x, y: snapshot.bounds.y });
  const b = screen.screenToDipPoint({ x: snapshot.bounds.x + snapshot.bounds.width, y: snapshot.bounds.y + snapshot.bounds.height });
  const width = b.x - a.x, height = b.y - a.y;
  assert.ok(width > 180 && height > 180, '来源夹具窗口转换后应留有内部验证区域');
  const region = { x: a.x + 45, y: a.y + 55, width: Math.min(360, width - 90), height: Math.min(120, height - 110) };
  const display = screen.getDisplayMatching(region);
  return { sourceBinding: true, source: snapshot, displayId: display.id, displayBounds: { ...display.bounds }, region };
}

function internalDipRegion(bounds, { xInset = 24, yInset = 52, width = 160, height = 100 } = {}) {
  const a = screen.screenToDipPoint({ x: bounds.x, y: bounds.y });
  const b = screen.screenToDipPoint({ x: bounds.x + bounds.width, y: bounds.y + bounds.height });
  const spanWidth = b.x - a.x, spanHeight = b.y - a.y;
  if (spanWidth <= xInset * 2 || spanHeight <= yInset + 24) throw new Error('自有 B 窗口转换后没有足够的内部区域。');
  const region = { x: a.x + xInset, y: a.y + yInset,
    width: Math.min(width, spanWidth - xInset * 2), height: Math.min(height, spanHeight - yInset - 24) };
  const physical = screen.dipToScreenRect(null, region);
  if (physical.x < bounds.x || physical.y < bounds.y || physical.x + physical.width > bounds.x + bounds.width ||
      physical.y + physical.height > bounds.y + bounds.height) throw new Error('DIP 换算后的框选区域超出自有 B 窗口。');
  return { region, physical };
}

function intersects(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function setupIpc() {
  ipcMain.handle('pickgloss:action', async (event, action, payload = {}) => {
    try {
      if (!desktop.authorize(event, action)) return { ok: false, error: '隔离验证窗口未授权此动作。' };
      const actionCall = { action, payload, completed: false, phase: scenarioPhase, time: new Date().toISOString() };
      actionCalls.push(actionCall);
      if (captureChainActive && mainHarness) {
        if (action === 'bootstrap') {
          state = await mainHarness.state();
          actionCall.completed = true;
          return { ok: true, value: desktop.stateFor(event, state) };
        }
        const value = await mainHarness.handle(action, payload);
        state = await mainHarness.state();
        actionCall.completed = true;
        return { ok: true, value };
      }
      if (action === 'bootstrap') return { ok: true, value: desktop.stateFor(event, state) };
      if (action === 'translation-content-height') {
        if (state.translation?.id === payload.id) {
          const bounds = desktop.resizeTranslationHeight(placement, payload.contentHeight);
          if (bounds) state.translation.layout = { ...state.translation.layout, controlBounds: bounds };
        }
        return { ok: true };
      }
      if (action === 'preview-translation-original' && state.translation?.id === payload.id) {
        state.translation.options = { ...state.translation.options, showOriginal: payload.visible === true };
        desktop.broadcast(state);
        return { ok: true };
      }
      if (action === 'set-translation-options' && state.translation?.id) {
        state.translation.options = translationOptions({ ...state.translation.options, ...payload.options });
        layoutTranslation(state.translation, { activate: false });
        desktop.broadcast(state);
        return { ok: true };
      }
      return { ok: true };
    } catch {
      return { ok: false, error: '隔离验证动作未完成。' };
    }
  });
}

async function ownedRendererPixels() {
  const owner = await fixtureProbe();
  assert.ok(ownsForeground(owner.foregroundPid), '前台离开本次自有夹具/窗口，立即中止；不读取渲染像素');
  return overlay.webContents.executeJavaScript(`(() => {
    const canvas = document.querySelector('canvas.translation-overlay');
    const context = canvas?.getContext('2d'); let ink = 0;
    if (context) { const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 0 && data[i] < 245 && data[i + 1] < 245 && data[i + 2] < 245) ink++; }
    return { canvas: !!canvas, width: canvas?.width || 0, height: canvas?.height || 0, ink,
      figureVisible: !!canvas && getComputedStyle(canvas).display !== 'none' && !!canvas.getBoundingClientRect().width };
  })()`);
}

async function clickTranslationControl(selector, expected, description) {
  const owner = await fixtureProbe();
  assert.ok(ownsForeground(owner.foregroundPid), '前台离开本次自有夹具/窗口，立即中止操作');
  const before = actionCalls.length;
  await controls.webContents.executeJavaScript(`(() => { const button = ${selector};
    if (!button || button.disabled) throw new Error('正式翻译控件尚不可用'); button.click(); })()`);
  await waitFor(description, async () => {
    state = await mainHarness.state();
    return actionCalls.slice(before).some(call => call.completed) && expected() ? true : null;
  });
  await waitFor('正式翻译控件完成操作', () => controls.webContents.executeJavaScript(`document.querySelector('.translation-controls')?.getAttribute('aria-busy') === 'false'`));
}

async function runPinReturnChain() {
  captureChainActive = true;
  scenarioPhase = '菜单置顶返回来源完整链路';
  const displayButton = label => `[...document.querySelectorAll('.translation-display button')].find(button => button.textContent === ${JSON.stringify(label)})`;
  await clickTranslationControl(displayButton('对照'), () => state.translation.options.displayMode === 'compare', '正式对照模式已生效');
  const pinBeforeOverlay = process.argv.includes('--pin-before-overlay');
  if (pinBeforeOverlay) await clickTranslationControl(`document.querySelector('.translation-pin')`, () => state.translation.controlsPinned === true, '先置顶正式菜单再进入覆盖');
  await clickTranslationControl(displayButton('覆盖'), () => state.translation.options.displayMode === 'overlay', '完成后点击覆盖已生效');
  if (!pinBeforeOverlay) {
    await clickTranslationControl(`document.querySelector('.translation-pin')`, () => state.translation.controlsPinned === true, '正式菜单置顶动作已生效');
    await focusSourceAndConfirm('置顶后建立 A 来源前台');
  }
  const beforeSwitch = await waitFor('置顶时覆盖仍在普通来源之上', async () => {
    const value = await probe();
    return value.foreground === (pinBeforeOverlay ? handleOf(controls) : sourceReady.handle) && value.overlayVisible && value.controlsVisible && value.overlayAboveSource && !value.overlayTopmost ? value : null;
  });
  const beforePixels = await ownedRendererPixels();
  assert.ok(beforePixels.ink > 0 && beforePixels.figureVisible, '切走前覆盖必须实际绘制译文');
  reportScene('完成→覆盖→菜单置顶', beforeSwitch, { 渲染像素: beforePixels, 菜单原生置顶: controls.isAlwaysOnTop() });
  sendFixture('other');
  const outside = await waitFor('置顶后切 B 仅保留菜单', async () => {
    const value = await probe();
    return value.foreground === sourceReady.other && value.otherVisible && sourceStatus?.state === 'inactive' && !value.overlayVisible && value.controlsVisible ? value : null;
  });
  reportScene('置顶→切 B 仅菜单可见', outside);
  if (!process.argv.includes('--skip-outside-menu')) {
  const bounds = controls.getBounds();
  const point = screen.dipToScreenPoint({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height - 5 });
  sendFixture(`capture-drag ${++probeSequence} ${handleOf(controls)} ${process.pid} ${point.x} ${point.y} ${point.x} ${point.y} owned`);
  const foreignMenu = await waitFor('B 上操作菜单仍不恢复 A 覆盖', async () => {
    const value = await probe();
    return value.foreground === handleOf(controls) && sourceStatus?.state === 'inactive' && !value.overlayVisible && value.controlsVisible ? value : null;
  });
  reportScene('B 上操作菜单不带出旧覆盖', foreignMenu);
  }
  pinReturnAwaiting = true;
  if (quickMenuReturnMs !== null) sendFixture(`quick-return ${handleOf(controls)} ${process.pid} ${quickMenuReturnMs}`);
  else sendFixture('focus');
  const returned = await waitFor('菜单保持置顶，回 A 必须恢复覆盖及正确 Z 序', async () => {
    const value = await probe();
    lastPinReturnProbe = value;
    return value.foreground === (quickMenuReturnMs === null ? sourceReady.handle : handleOf(controls)) && sourceStatus?.state === 'active' && value.overlayVisible && value.controlsVisible && value.overlayAboveSource && !value.overlayTopmost ? value : null;
  }, { timeoutMs: 1600 });
  const returnedPixels = await ownedRendererPixels();
  assert.ok(returnedPixels.ink > 0 && returnedPixels.figureVisible, '回 A 后 canvas 必须保留实际译文像素');
  reportScene('菜单置顶→切 B→回 A 覆盖恢复', returned, { 渲染像素: returnedPixels, 菜单原生置顶: controls.isAlwaysOnTop() });
  await clickTranslationControl(displayButton('对照'), () => state.translation.options.displayMode === 'compare', '返回后对照模式已生效');
  await waitFor('对照 renderer 实际显示原译文', () => controls.webContents.executeJavaScript(`!!document.querySelector('.translation-target-text')?.textContent.includes('桌面')`));
  reportScene('返回后切对照', await probe(), { 模式: state.translation.options.displayMode });
  await clickTranslationControl(displayButton('覆盖'), () => state.translation.options.displayMode === 'overlay', '返回后覆盖模式已生效');
  const roundtrip = await waitFor('对照再覆盖实际可见且层级正确', async () => {
    const value = await probe(), pixels = await ownedRendererPixels();
    return sourceStatus?.state === 'active' && value.overlayVisible && value.controlsVisible && value.overlayAboveSource && !value.overlayTopmost && pixels.ink > 0 && pixels.figureVisible ? { value, pixels } : null;
  });
  assert.equal(state.translation.controlsPinned, true, '模式往返后菜单仍然置顶');
  assert.equal(controls.isAlwaysOnTop(), true);
  assert.equal(state.translation.sourceInvalid, undefined, '切换应用不会使来源位置失效');
  reportScene('返回后对照→覆盖实际恢复', roundtrip.value, { 渲染像素: roundtrip.pixels, 模式: state.translation.options.displayMode, 菜单原生置顶: controls.isAlwaysOnTop() });
}

async function runMinimizeReturnChain() {
  captureChainActive = true;
  scenarioPhase = '自有来源最小化还原与真实移动';
  const displayButton = label => `[...document.querySelectorAll('.translation-display button')].find(button => button.textContent === ${JSON.stringify(label)})`;
  for (const [index, mode] of ['overlay', 'compare', 'overlay'].entries()) {
    if (index === 1) await clickTranslationControl(`document.querySelector('.translation-pin')`, () => state.translation.controlsPinned === false, '取消菜单置顶后验证对照最小化');
    await clickTranslationControl(displayButton(mode === 'overlay' ? '覆盖' : '对照'), () => state.translation.options.displayMode === mode, '最小化前正式模式生效');
    await focusSourceAndConfirm('最小化前确认自有来源前台');
    sendFixture('minimize');
    const minimized = await waitFor('自有来源最小化后覆盖隐藏', async () => {
      const value = await probe();
      return sourceStatus?.state === 'inactive' && !value.overlayVisible && value.controlsVisible === (state.translation.controlsPinned === true) ? value : null;
    });
    reportScene(`第${index + 1}次最小化立即隐藏覆盖`, minimized, { 模式: mode });
    sendFixture('restore');
    const restored = await waitFor('原位置还原后恢复来源活动且覆盖层级正确', async () => {
      const value = await probe();
      return sourceStatus?.state === 'active' && value.foreground === sourceReady.handle && value.overlayVisible && value.controlsVisible && value.overlayAboveSource && !value.overlayTopmost ? value : null;
    });
    state = await mainHarness.state();
    assert.notEqual(state.translation.sourceInvalid, true, '原位置最小化还原不应永久标记来源失效');
    assert.equal(state.translation.options.displayMode, mode, '最小化还原不能强制改为对照');
    const pixels = mode === 'overlay' ? await ownedRendererPixels() : null;
    if (pixels) assert.ok(pixels.ink > 0 && pixels.figureVisible, '还原后正式canvas仍实际绘制覆盖译文');
    reportScene(`第${index + 1}次原位置还原后恢复`, restored, { 模式: mode, 渲染像素: pixels, 来源失效: state.translation.sourceInvalid === true });
  }
  sendFixture('move');
  const moved = await waitFor('真实移动仍必须永久终止旧位置覆盖', async () => {
    const value = await probe();
    state = await mainHarness.state();
    return state.translation.sourceInvalid === true && !value.overlayVisible ? value : null;
  });
  reportScene('最小化还原后真实移动仍终止旧覆盖', moved);
}

async function createMainHarness() {
  const directory = path.join(userData, 'capture-chain-data');
  const store = createStore({ directory, encrypt: value => Buffer.from(value, 'utf8'), decrypt: value => value.toString('utf8') });
  await store.init();
  const appStub = { isPackaged: false, setPath() {}, getPath: () => directory, setName() {}, setAppUserModelId() {},
    requestSingleInstanceLock: () => true, on() {}, whenReady: () => new Promise(() => {}) };
  const electronStub = { app: appStub, ipcMain: { handle() {}, removeHandler() {} }, globalShortcut: {},
    session: { defaultSession: {} }, safeStorage: {}, shell: {}, dialog: {}, clipboard: { writeText() {} }, nativeImage,
    net: { async fetch(url, options = {}) {
      assert.ok(String(url).startsWith('https://translation.invalid/'), '截图翻译只允许使用隔离的虚构模型端点');
      const request = JSON.parse(options.body || '{}');
      const user = request.messages?.find(message => message.role === 'user')?.content;
      const lines = typeof user === 'string' ? JSON.parse(user).lines : [];
      modelCalls.push({ host: new URL(url).hostname, lines: lines.length });
      return Response.json({ choices: [{ message: { content: JSON.stringify({ translations: lines.map(line => ({ id: line.id, translation: '桌面' })) }) } }] });
    } } };
  const sourceFile = path.join(__dirname, '../src/main.cjs');
  const context = { require: name => name === 'electron' ? electronStub
    : name === './windows/ocr.cjs' ? { recognizeWindows: async input => {
      const size = nativeImage.createFromDataURL(input.imageData).getSize();
      return { language: 'en-US', angle: 0, blocks: [{ text: 'Desktop', x: 8, y: 8, width: Math.min(120, size.width - 8), height: Math.min(32, size.height - 8) }] };
    } }
    : name.startsWith('./') ? require(path.resolve(path.dirname(sourceFile), name)) : require(name),
    process: { argv: [], env: {}, pid: process.pid, execPath: process.execPath }, URL, AbortController, structuredClone,
    setTimeout, clearTimeout, setInterval, clearInterval, Buffer, Response,
    fixture: { store, desktop, settings: await store.getSettings() } };
  vm.createContext(context);
  vm.runInContext(fsSync.readFileSync(sourceFile, 'utf8') + '\n' +
    'store=fixture.store;desktop=fixture.desktop;settings=fixture.settings;' +
    'globalThis.testApp={handle,state,seedTranslation:item=>{translation=item;},drain:async()=>{await translationJob?.promise;await Promise.all([...jobs.values()].map(job=>job.promise));}};', context);
  return context.testApp;
}

function setupDesktop() {
  const originalLoad = Module._load;
  const capturePoint = screen.screenToDipPoint({ x: sourceReady.bounds.x + Math.floor(sourceReady.bounds.width / 2),
    y: sourceReady.bounds.y + Math.floor(sourceReady.bounds.height / 2) });
  const sourceScreen = new Proxy(screen, { get(target, property) {
    if (property === 'getCursorScreenPoint') return () => capturePoint;
    if (property === 'getDisplayNearestPoint') return point => target.getDisplayNearestPoint(point);
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  class OwnedWindow extends BrowserWindow {
    constructor(options) {
      super(options);
      this.webContents.on('console-message', (_event, detail) => {
        const level = typeof detail === 'object' ? detail.level : detail;
        if (level >= 2) {
          const message = typeof detail === 'object' ? detail.message : '';
          consoleErrors.push(`${this.kind || '未知窗口'}:${level}:${String(message || '渲染器错误').slice(0, 240)}`);
        }
      });
      this.webContents.on('did-fail-load', (_event, code, description) => {
        rendererFailures.push(`${this.kind || '未知窗口'}:${code}:${String(description || '页面加载失败').slice(0, 160)}`);
      });
      windows.push(this);
    }
    loadFile(file, options) { this.kind = options?.query?.window; return super.loadFile(file, options); }
  }
  Module._load = function(name, ...args) {
    if (name === 'electron') return { ...electron, BrowserWindow: OwnedWindow, screen: sourceScreen };
    const result = originalLoad.call(this, name, ...args);
    if (name === './window-appearance.cjs' && !process.argv.includes('--real-window-appearance')) return { ...result, createWindowAppearance() {
      return { isReady: false, setBackdrop() {}, apply() {}, dispose() {}, getBackdropInfo() { return null; } };
    } };
    return result;
  };
  try {
    desktop = require('../src/windows/desktop.cjs').createDesktop({
      captureFactory: () => ({ async prepare() {}, async capture(rect) {
        const scale = Math.min(1, 1400 / rect.width, 1000 / rect.height);
        const width = Math.max(1, Math.round(rect.width * scale)), height = Math.max(1, Math.round(rect.height * scale));
        return { bitmap: Buffer.alloc(width * height * 4, 255), width, height };
      }, dispose() {} }),
      sourceFactory: captureSnapshotFactory,
      onAction(action, payload = {}) {
        if (action === 'translation-source-invalid' && state.translation && payload.placement === state.translation.placement) {
          const item = state.translation;
          item.sourceInvalid = true;
          item.placement.sourceInvalid = true;
          item.sourceWarning = payload.reason === 'moved' ? '来源窗口已移动，请重新框选以覆盖译文。' : '来源窗口跟踪已中断，请重新框选。';
          item.options = { ...item.options, displayMode: 'compare', showOriginal: false };
          layoutTranslation(item);
          desktop.broadcast(state);
        } else if (action === 'translation-source-closed' && state.translation && payload.placement === state.translation.placement) {
          state.translation = null;
          desktop.hideTranslation();
          desktop.broadcast(state);
        }
      },
      onStatus() {},
      onWindowState() {},
    });
  } finally { Module._load = originalLoad; }
}

async function obtainSnapshot() {
  let snapshot = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const foreground = await focusSourceAndConfirm('真实捕获前未能确认来源 A 位于前台');
    if (attempt === 0) initialFocusProbe = foreground;
    snapshot = await watcher.capture();
    captureSummaries.push({ 来源快照存在: !!snapshot?.handle, 前台句柄匹配自有A: snapshot?.handle === sourceReady.handle,
      来源进程匹配自有夹具: snapshot?.pid === sourceReady.pid, 返回候选集合: Array.isArray(snapshot?.candidates) });
    if (snapshot?.handle === sourceReady.handle && snapshot.pid === sourceReady.pid) return snapshot;
  }
  throw new Error('真实来源助手未从自有来源夹具取得预期截图来源快照。');
}

async function runScenarios() {
  scenarioPhase = '编译自有原生夹具';
  buildNativeInputs();
  await fs.mkdir(output, { recursive: true });
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    networkAttempts.push(details.url); callback({ cancel: true });
  });
  scenarioPhase = '创建自有来源窗口';
  const initial = await startFixture();
  assert.ok(Number.isInteger(initial.pid) && initial.pid > 0, '夹具报告有效进程号');
  assert.notEqual(initial.pid, process.pid, '来源夹具必须与 Electron 主进程分离');
  scenarioPhase = 'desktop 尚未初始化，核对首次自有来源前台';
  initialFocusProbe = await focusSourceAndConfirm('来源助手启动前未能确认 A HWND 持有前台');
  scenarioPhase = '来源助手已启动，采集初始快照';
  setupDesktop();
  const snapshot = await obtainSnapshot();
  assert.equal(snapshot.handle, initial.handle, '捕获快照属于夹具来源窗口');
  assert.equal(snapshot.pid, initial.pid, '捕获快照属于独立夹具进程');
  placement = makePlacement(snapshot);

  const options = translationOptions({ displayMode: 'overlay', targetLanguage: 'zh-Hans', searchEnabled: false });
  setupIpc();
  desktop.setOrb(false);
  scenarioPhase = '初始化隔离 main.cjs 状态机';
  mainHarness = await createMainHarness();
  state = await mainHarness.state();
  desktop.setAppearance(state.settings.prefs.appearance);
  await mainHarness.handle('save-settings', { text: { baseUrl: 'https://translation.invalid/v1', model: '隔离验证模型' },
    prefs: { screenshotTranslation: options } });
  state = await mainHarness.state();
  desktop.broadcast(state);

  if (process.argv.includes('--seeded-minimize-only')) {
    scenarioPhase = '合成完成态定向最小化验证'; captureChainActive = true;
    const item = { id: '自有来源最小化合成完成态', placement, options, controlsPinned: true,
      imageData: syntheticImageData(placement.region.width, placement.region.height), status: 'complete', method: 'windows-ocr',
      width: Math.ceil(placement.region.width), height: Math.ceil(placement.region.height), unchangedCount: 0, overlayAvailable: true,
      blocks: [{ id: 0, text: 'Desktop', translation: '桌面', x: 8, y: 8, width: 100, height: 30 }] };
    mainHarness.seedTranslation(item); state = await mainHarness.state();
    item.layout = desktop.showTranslation(placement, 'overlay', { controlsPinned: true, activate: false });
    overlay = windows.find(win => win.kind === 'translation-overlay'); controls = windows.find(win => win.kind === 'translation');
    await waitFor('正式翻译窗口加载完成', () => !overlay.webContents.isLoading() && !controls.webContents.isLoading());
    desktop.broadcast(state);
    await focusSourceAndConfirm('合成完成态测试先确认自有来源前台');
    await waitFor('合成完成态来源活动', () => sourceStatus?.state === 'active');
    await waitFor('合成完成态覆盖译文绘制', async () => (await ownedRendererPixels()).ink > 0);
    reportScene('定向最小化测试使用合成完成态', await probe(), { 断言: '跳过截图前台交还，只核对正式helper、main动作、desktop、renderer的来源最小化恢复。' });
    await runMinimizeReturnChain(); return;
  }

  // 从正式桌面截图入口开始，真实 capture renderer 完成框选，再经过 main.cjs 的正式 capture-done 分支。
  captureChainActive = true;
  scenarioPhase = 'capture 启动前确认自有来源前台';
  await focusSourceAndConfirm('截图翻译链路启动前未能确认来源 A 位于前台');
  if (captureStartPanel) {
    desktop.prepareCapture(); desktop.openPanel();
    await waitFor('预热后正式主窗成为前台', () => windows.find(win => win.kind === 'panel')?.isFocused());
  }
  if (captureStartOther) {
    sendFixture('separate'); sendFixture('other');
    await waitFor('来源A可见而并排B为前台', async () => {
      const value = await fixtureProbe();
      return value.foreground === sourceReady.other && value.sourceVisible && value.otherVisible &&
        value.otherBounds.x >= value.bounds.x + value.bounds.width ? value : null;
    });
  }
  scenarioPhase = '正式 capture renderer 就绪';
  await mainHarness.handle('start-capture', { mode: 'translate', options });
  state = await mainHarness.state();
  const captureState = desktop.captureState();
  assert.ok(captureState?.id && captureState.mode === 'translate', '正式开始截图入口创建翻译模式截图');
  const captureWindow = windows.find(win => win.kind === 'capture');
  assert.ok(captureWindow, '正式桌面模块创建截图框选窗口');
  captureWindowForReport = captureWindow;
  await waitFor('正式截图框选 renderer 准备完成', async () => {
    if (captureWindow.webContents.isLoading()) return null;
    const ui = await captureWindow.webContents.executeJavaScript(`(() => ({
      mode: document.querySelector('.capture-help-message')?.textContent || '',
      decoded: Boolean(document.querySelector('.capture-image')?.naturalWidth),
      invoke: typeof window.pickgloss?.invoke === 'function'
    }))()`);
    const readyAction = actionCalls.some(call => call.action === 'capture-ready' && call.payload.id === captureState.id && call.completed);
    return ui.decoded && ui.invoke && ui.mode.includes('松开即翻译') && readyAction &&
      captureWindow.isVisible() && captureWindow.isFocused() ? ui : null;
  }, { timeoutMs: 12000 });
  const captureBounds = captureWindow.getBounds(), sourceRegion = placement.region;
  const crop = { x: Math.round(sourceRegion.x - captureBounds.x + 5), y: Math.round(sourceRegion.y - captureBounds.y + 5),
    width: Math.min(150, Math.floor(sourceRegion.width - 10)), height: Math.min(70, Math.floor(sourceRegion.height - 10)) };
  assert.ok(crop.x >= 0 && crop.y >= 30 && crop.x + crop.width <= captureBounds.width && crop.y + crop.height <= captureBounds.height,
    '截图框选坐标应落在自有来源 A 的窗口边界内');
  scenarioPhase = '自有截图框选中';
  const firstPoint = screen.dipToScreenPoint({ x: captureBounds.x + crop.x, y: captureBounds.y + crop.y });
  const lastPoint = screen.dipToScreenPoint({ x: captureBounds.x + crop.x + crop.width, y: captureBounds.y + crop.y + crop.height });
  sendFixture(`capture-drag ${++probeSequence} ${handleOf(captureWindow)} ${process.pid} ${firstPoint.x} ${firstPoint.y} ${lastPoint.x} ${lastPoint.y} owned`);
  await waitFor('正式 renderer 的 capture-done 主流程完成', () => actionCalls.some(call => call.action === 'capture-done' && call.completed), { timeoutMs: 6000 });
  const submitted = actionCalls.findLast(call => call.action === 'capture-done');
  assert.equal(submitted.payload.mode, 'translate', '正式 capture renderer 把本次选框路由为截图翻译');
  assert.ok(submitted.payload.rect.width >= 8 && submitted.payload.rect.height >= 8, '框选完成后提交有效选区');
  scenarioPhase = 'main capture-done 已完成，等待隔离 OCR/翻译';
  await mainHarness.drain();
  scenarioPhase = 'OCR/翻译完成，检查真实窗口状态';
  captureChainActive = false;
  state = await mainHarness.state();
  desktop.broadcast(state);
  assert.equal(desktop.captureState(), null, '框选完成后清除截图层');
  assert.ok(state.translation, '框选完成后必须保留截图翻译状态');
  assert.equal(state.translation.status, 'complete', state.translation.error || '隔离 OCR 与本机翻译应完成');
  assert.equal(state.translation.blocks[0]?.text, 'Desktop');
  assert.equal(state.translation.blocks[0]?.translation, '桌面');
  assert.equal(modelCalls.length, 1, '该框选只使用一次隔离的本机翻译 mock');
  assert.equal(state.translation.placement.sourceBinding, true, '翻译结果继续绑定本次截图来源窗口');
  assert.equal(state.translation.placement.source.handle, sourceReady.handle, '截图框选来源应关联到自有 A HWND');
  placement = state.translation.placement;
  overlay = windows.find(win => win.kind === 'translation-overlay');
  controls = windows.find(win => win.kind === 'translation');
  assert.ok(overlay && controls, '正式桌面模块创建覆盖窗和翻译工具条');
  const rendered = await waitFor('正式 preload、工具条与覆盖译文均完成渲染', async () => {
    if (overlay.webContents.isLoading() || controls.webContents.isLoading()) return null;
    const ownedForeground = await fixtureProbe();
    assert.ok(ownsForeground(ownedForeground.foregroundPid), '前台离开本次自有窗口，立即中止；不读取 renderer 像素');
    const [controlState, overlayState] = await Promise.all([
      controls.webContents.executeJavaScript(`({ preload: typeof window.pickgloss?.invoke === 'function', surface: new URLSearchParams(location.search).get('window'), root: !!document.getElementById('app'), controls: !!document.querySelector('.translation-controls'), translation: !!document.querySelector('.translation-status'), translationStatus: document.querySelector('.translation-status')?.textContent || '', translationText: document.querySelector('.translation-target-text')?.textContent || '', appBusy: document.getElementById('app')?.getAttribute('aria-busy') || null })`),
      overlay.webContents.executeJavaScript(`(() => { const image = document.querySelector('.translation-image img'); const figure = document.querySelector('.translation-image'); const canvas = document.querySelector('canvas.translation-overlay'); const context = canvas?.getContext('2d'); let darkPixels = 0; if (context) { const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data; for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 245 && pixels[i + 1] < 245 && pixels[i + 2] < 245) darkPixels++; } return { preload: typeof window.pickgloss?.invoke === 'function', surface: new URLSearchParams(location.search).get('window'), root: !!document.getElementById('app'), figure: !!figure, figureLabel: figure?.getAttribute('aria-label') || null, imageComplete: image?.complete ?? null, imageNaturalWidth: image?.naturalWidth ?? null, imageNaturalHeight: image?.naturalHeight ?? null, imageSource: image?.getAttribute('src')?.slice(0, 48) || null, canvas: !!canvas, canvasSize: canvas ? [canvas.width, canvas.height] : null, canvasContext: !!context, darkPixels, appBusy: document.getElementById('app')?.getAttribute('aria-busy') || null }; })()`),
    ]);
    rendererDiagnostics = { controlState, overlayState, imageData: {
      prefix: state.translation.imageData.slice(0, 48), length: state.translation.imageData.length,
      matchesPngDataUrl: /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(state.translation.imageData),
      nativeImageEmpty: nativeImage.createFromDataURL(state.translation.imageData).isEmpty(),
    }, 状态: { 翻译状态: state.translation?.status || null, 显示模式: state.translation?.options?.displayMode || null,
      来源绑定: state.translation?.placement?.source?.handle === sourceReady?.handle,
      来源失效: state.translation?.sourceInvalid === true, 识别块数: state.translation?.blocks?.length || 0,
      译文: state.translation?.blocks?.[0]?.translation || null },
    窗口: { 截图层可见: captureWindowForReport && !captureWindowForReport.isDestroyed() ? captureWindowForReport.isVisible() : false,
      覆盖译文可见: overlay && !overlay.isDestroyed() ? overlay.isVisible() : false,
      工具条可见: controls && !controls.isDestroyed() ? controls.isVisible() : false,
      工具条已聚焦: controls && !controls.isDestroyed() ? controls.isFocused() : false },
    来源事件: sourceStatus };
    return controlState.preload && controlState.controls && controlState.translation && controlState.translationStatus.includes('完成') &&
      overlayState.preload && overlayState.figure && overlayState.canvas && overlayState.darkPixels > 0 ? { controlState, overlayState } : null;
  }, { timeoutMs: 12000 });
  assert.ok(rendered.controlState.preload && rendered.overlayState.preload, '正式 preload 在两个翻译窗口中可用');
  assert.match(rendered.controlState.translationStatus, /完成/, '正式翻译工具条显示 OCR/翻译已完成');
  assert.ok(rendered.overlayState.darkPixels > 0, '正式覆盖译文 renderer 在合成白底图上实际绘制了译文像素');
  // 此处不能重新激活来源：必须由正式截图提交路径自行交还前台，否则会掩盖结果全部隐藏。
  await waitFor('来源绑定进入活动状态', () => sourceStatus?.state === 'active');
  const first = await waitFor('截图框选完成后来源活动且覆盖译文和工具条均可见', async () => {
    const value = await probe();
    return [sourceReady.handle, handleOf(controls)].includes(value.foreground) && value.overlayVisible && value.controlsVisible && value.overlayAboveSource && !value.overlayTopmost ? value : null;
  });
  reportScene('真实截图框选完成后保留译文', first, { 断言: '真实 capture renderer 提交 capture-done；之后不手动恢复来源；本机 OCR/翻译 mock 完成且覆盖译文、工具条自行可见。' });
  assert.ok([sourceReady.handle, handleOf(controls)].includes(first.foreground), '前台必须属于来源或本次翻译工具条');
  assertProbeOwned(first);
  assert.equal(first.overlayAboveSource, true, '普通来源上方必须实际存在覆盖译文，不能只检查 IsWindowVisible');
  assert.equal(first.overlayTopmost, false, '普通来源的覆盖最终必须处于非置顶层');
  assert.equal(captureWindow.isVisible(), false, '框选完成后正式截图窗口退出');
  assert.equal(state.translation.status, 'complete', '截图窗口退出后 main 状态中仍有完成的截图翻译');
  assert.equal(first.overlayVisible, true, '来源活动时覆盖译文可见');
  assert.equal(first.controlsVisible, true, '来源活动时自有工具条可见');

  if (pinReturnOnly) {
    if (externalOtherProcess) await startExternalOtherFixture();
    await runPinReturnChain();
    if (process.argv.includes('--with-minimize-return')) await runMinimizeReturnChain();
    return;
  }

  await focusSourceAndConfirm('首次自动可见已验证，后续来源跟随场景重新建立 A 前台');

  const originalTranslation = state.translation;
  sendFixture('separate');
  const arranged = await waitFor('A 前台、B 可见且两窗不重叠', async () => {
    const value = await probe();
    return value.foreground === sourceReady.handle && value.otherVisible && value.bounds && value.otherBounds &&
      value.overlayVisible && value.controlsVisible && value.overlayAboveSource && !value.overlayTopmost && sourceStatus?.state === 'active' &&
      !intersects(value.bounds, value.otherBounds) ? value : null;
  });
  reportScene('截图前 A 前台且 B 可见并排', arranged, { 断言: '原生探针确认 A 是前台 HWND，B 可见，且两窗物理边界不重叠。' });
  assert.equal(arranged.foreground, sourceReady.handle, '真实截图来源采集前必须确认 A HWND 前台');
  assert.equal(arranged.otherVisible, true, '真实截图来源采集前必须确认 B 窗口可见');
  assert.equal(intersects(arranged.bounds, arranged.otherBounds), false, 'A 与 B 的物理窗口边界不重叠');

  // 完整 atlas 仅留在内存供正式 sourceForRegion 选择，不写入报告或日志。
  const capturedAtlas = await watcher.capture();
  const atlasSummary = { 来源快照存在: !!capturedAtlas?.source?.handle,
    快照与自有A匹配: capturedAtlas?.source?.handle === sourceReady.handle && capturedAtlas?.source?.pid === sourceReady.pid,
    来源快照与前台不冲突: !capturedAtlas?.source || capturedAtlas.source.handle === sourceReady.handle && capturedAtlas.source.pid === sourceReady.pid,
    候选数组存在: Array.isArray(capturedAtlas?.candidates), 候选数量: capturedAtlas?.candidates?.length ?? null,
    候选包含自有A: capturedAtlas?.candidates?.some(value => value.handle === sourceReady.handle && value.pid === sourceReady.pid) === true,
    候选包含自有B: capturedAtlas?.candidates?.some(value => value.handle === sourceReady.other && value.pid === sourceReady.pid) === true };
  captureSummaries.push(atlasSummary);
  if (!atlasSummary.来源快照与前台不冲突 || !atlasSummary.候选数组存在 || atlasSummary.候选数量 < 2 ||
      atlasSummary.候选数量 > 64 || !atlasSummary.候选包含自有A || !atlasSummary.候选包含自有B) {
    throw new Error(`截图时真实前台快照未确认自有 A，或来源候选图集无效：${JSON.stringify(atlasSummary)}`);
  }
  const bArea = internalDipRegion(arranged.otherBounds);
  const selectedB = sourceForRegion(capturedAtlas, bArea.physical);
  if (!selectedB || selectedB.handle !== sourceReady.other || selectedB.pid !== sourceReady.pid) {
    throw new Error('真实截图候选顺序未将 B 内部区域归属到自有 B 窗口。');
  }
  const bDisplay = screen.getDisplayMatching(bArea.region);
  const placementB = { sourceBinding: true, source: selectedB, displayId: bDisplay.id,
    displayBounds: { ...bDisplay.bounds }, region: bArea.region };
  reportScene('真实框选区域选择自有 B', arranged, {
    断言: '真实 atlas 经 sourceForRegion 按物理框选区域选中 B；完整 atlas 未写入报告。',
    截图前台选择: { 窗口: 'A', HWND: sourceReady.handle, PID: sourceReady.pid,
      原生夹具探针确认: true, 来源快照匹配: atlasSummary.快照与自有A匹配 },
    框选来源选择: { 窗口: 'B', HWND: selectedB.handle, PID: selectedB.pid, 与预期一致: true },
  });

  sendFixture('other');
  if (injectedNoSourceGate) {
    const injected = await waitFor('故障注入切到 B 后 helper 已发现 inactive 且旧覆盖仍显示', async () => {
      const value = await probe();
      return nativeEvents.some(event => event.state === 'inactive') &&
        !forwardedEvents.some(event => event.state === 'inactive') &&
        value.foreground === sourceReady.other && value.otherVisible && value.overlayVisible && value.controlsVisible ? value : null;
    });
    reportScene('故障注入切到 B 后旧覆盖仍显示', injected, { 断言: 'helper 已报告 inactive；故障注入抑制了该状态，绑定 A 的旧覆盖仍然可见。' });
    assert.equal(injected.foreground, sourceReady.other, '故障注入时原生前台应为自有 B');
    assert.equal(injected.overlayVisible, false, '故障注入应检测到切到 B 后 A 覆盖仍然残留');
    throw new Error('inactive 门控故障注入未使来源覆盖残留。');
  }
  const switchedToB = await waitFor('激活 B 后原 A 绑定先隐藏', async () => {
    const value = await probe();
    return value.foreground === sourceReady.other && value.otherVisible && sourceStatus?.state === 'inactive' &&
      !value.overlayVisible && !value.controlsVisible ? value : null;
  });
  reportScene('激活 B 后旧 A 绑定隐藏', switchedToB, { 断言: '激活 B 时原先绑定 A 的覆盖与工具条已隐藏。' });
  assert.equal(switchedToB.foreground, sourceReady.other, '切换成功到 B 的原生 HWND');
  const lateRestore = await watcher.restore(placement.source, { capture: captureWindow });
  assert.equal(lateRestore, false, '截图层已离开前台，迟到恢复必须被拒绝');
  const afterLateRestore = await probe();
  assert.equal(afterLateRestore.foreground, sourceReady.other, '迟到恢复不能抢走 B 的前台');
  assert.equal(afterLateRestore.overlayVisible, false); assert.equal(afterLateRestore.controlsVisible, false);
  desktop.setTranslationControlsPinned(true);
  state.translation.controlsPinned = true; desktop.broadcast(state);
  const pinnedOutside = await waitFor('B 前台时仅置顶菜单保留', async () => {
    const value = await probe();
    return value.foreground === sourceReady.other && value.controlsVisible && !value.overlayVisible ? value : null;
  });
  assert.equal(controls.isAlwaysOnTop(), true);
  assert.equal(overlay.isAlwaysOnTop(), false, '原位覆盖不能获得系统置顶');
  reportScene('只置顶翻译菜单，其他应用前台覆盖仍隐藏', pinnedOutside, { 断言: '菜单置顶与覆盖来源门控独立。' });
  const menuBounds = controls.getBounds();
  // 点击内容区底部留白；标题栏是原生拖动区，不能用来做单纯的激活检查。
  const menuPoint = screen.dipToScreenPoint({ x: menuBounds.x + menuBounds.width / 2, y: menuBounds.y + menuBounds.height - 5 });
  sendFixture(`capture-drag ${++probeSequence} ${handleOf(controls)} ${process.pid} ${menuPoint.x} ${menuPoint.y} ${menuPoint.x} ${menuPoint.y} owned`);
  const pinnedFocused = await waitFor('B 后激活置顶菜单也不带出 A 覆盖', async () => {
    const value = await probe();
    return value.foreground === handleOf(controls) && value.controlsVisible && !value.overlayVisible && sourceStatus?.state === 'inactive' ? value : null;
  });
  reportScene('跨应用操作置顶菜单不恢复旧覆盖', pinnedFocused, { 断言: '工具条前台不能替代截图来源前台。' });
  desktop.setTranslationControlsPinned(false); state.translation.controlsPinned = false;
  assert.equal(controls.isAlwaysOnTop(), false);
  assert.equal(controls.isVisible(), false, '取消菜单置顶时仍在其他应用上下文，立即隐藏');
  sendFixture('other');
  await waitFor('取消置顶后回到 B', async () => (await probe()).foreground === sourceReady.other);
  if (process.argv.includes('--pin-check-only')) return;
  reportScene('迟到来源恢复不会抢占其他窗口', afterLateRestore, { 断言: '恢复助手启动时截图层已不在前台，拒绝激活旧来源，保持 B 前台及结果隐藏。' });
  assert.equal(switchedToB.overlayVisible, false, '原 A 绑定在 B 激活时隐藏');

  desktop.hideTranslation();
  const bOptions = translationOptions({ displayMode: 'overlay', targetLanguage: 'zh-Hans', searchEnabled: false });
  state.translation = { id: '来源选择 B 原生验证', imageData: syntheticImageData(bArea.region.width, bArea.region.height),
    placement: placementB, options: bOptions, status: 'complete', method: 'windows-ocr', fallbackReason: '',
    width: Math.ceil(bArea.region.width), height: Math.ceil(bArea.region.height), warning: '', unchangedCount: 0,
    rotationAdjusted: false, overlayAvailable: true,
    blocks: [{ id: 0, text: 'Other', translation: '另一窗', x: 8, y: 8, width: 100, height: 30 }] };
  state.translation.layout = desktop.showTranslation(placementB, bOptions.displayMode, { activate: true });
  desktop.broadcast(state);
  await waitFor('B 绑定进入活动状态', () => sourceStatus?.state === 'active');
  sendFixture('other');
  const bOverlay = await waitFor('B HWND 活动时覆盖可见且保持 B 前台', async () => {
    const value = await probe();
    return value.foreground === sourceReady.other && value.otherVisible && value.overlayVisible && value.controlsVisible ? value : null;
  });
  reportScene('按真实框选结果绑定 B 后覆盖可见', bOverlay, { 断言: 'helper 绑定自有 B HWND 后，B 前台时覆盖与工具条可见。' });
  assertProbeOwned(bOverlay);
  assert.equal(bOverlay.foreground, sourceReady.other, '覆盖可见的同时原生前台确为 B HWND');
  assert.equal(bOverlay.overlayVisible, true, '真实区域选择 B 后覆盖译文可见');
  assert.equal(bOverlay.controlsVisible, true, '真实区域选择 B 后工具条可见');

  sendFixture('focus');
  const aHidesB = await waitFor('返回 A 后 B 绑定隐藏', async () => {
    const value = await probe();
    return value.foreground === sourceReady.handle && sourceStatus?.state === 'inactive' &&
      !value.overlayVisible && !value.controlsVisible ? value : null;
  });
  reportScene('返回 A 后 B 绑定隐藏', aHidesB, { 断言: 'B 绑定不会错误跟随 A；回到 A 后两个翻译窗口隐藏。' });
  assertProbeOwned(aHidesB);
  assert.equal(aHidesB.foreground, sourceReady.handle, '返回 A 的原生 HWND 已确认');
  assert.equal(aHidesB.overlayVisible, false, '绑定 B 的覆盖不会错误留在 A 上');
  assert.equal(aHidesB.controlsVisible, false, '绑定 B 的工具条不会错误留在 A 上');

  desktop.hideTranslation();
  state.translation = originalTranslation;
  sendFixture('focus');
  await waitForForeground(sourceReady.handle, '重新绑定原始 A 前先确认 A 为前台');
  state.translation.layout = desktop.showTranslation(placement, state.translation.options.displayMode, { activate: true });
  desktop.broadcast(state);
  await waitFor('重新绑定 A 后覆盖恢复', async () => {
    const value = await probe();
    return sourceStatus?.state === 'active' && value.overlayVisible && value.controlsVisible ? value : null;
  });
  sendFixture('focus');
  const reboundA = await waitFor('重新绑定 A 后保持 A 前台和覆盖显示', async () => {
    const value = await probe();
    return sourceStatus?.state === 'active' && value.foreground === sourceReady.handle && value.overlayVisible && value.controlsVisible && value.overlayAboveSource && !value.overlayTopmost ? value : null;
  });
  reportScene('B 区域验证后恢复原始 A 绑定', reboundA, { 断言: '后续七个来源跟随场景恢复到最初 A 绑定。' });
  assertProbeOwned(reboundA);
  assert.equal(reboundA.foreground, sourceReady.handle, '重新绑定后 A HWND 持有前台');
  assert.equal(reboundA.overlayTopmost, false, '重新绑定普通来源后覆盖最终仍非置顶');

  sendFixture('other');
  let second = await waitForForeground(sourceReady.other, '同一夹具进程的另一窗口成为前台');
  second = await waitFor('切到另一窗口后来源状态 inactive 且两个正式窗口隐藏', async () => {
    const value = await probe();
    return sourceStatus?.state === 'inactive' && value.foreground === sourceReady.other && !value.overlayVisible && !value.controlsVisible ? value : null;
  });
  reportScene('切到同进程另一窗口后隐藏', second, { 断言: '覆盖译文与自有工具条均隐藏。' });
  assertProbeOwned(second);
  assert.equal(second.foreground, sourceReady.other, '前台确为同一子进程的另一窗口');
  assert.equal(second.overlayVisible, false, '切换其他窗口后覆盖译文隐藏');
  assert.equal(second.controlsVisible, false, '切换其他窗口后工具条隐藏');

  state.translation.unchangedCount = 1;
  layoutTranslation(state.translation, { activate: false });
  desktop.broadcast(state);
  const backgroundLayout = await probe();
  reportScene('后台 layout activate false 不重显', backgroundLayout, { 断言: '后台更新布局不重显任一翻译窗口。' });
  assertProbeOwned(backgroundLayout);
  assert.equal(backgroundLayout.foreground, sourceReady.other, '后台排版不改变另一个窗口的前台状态');
  assert.equal(backgroundLayout.overlayVisible, false, '后台排版不重显覆盖译文');
  assert.equal(backgroundLayout.controlsVisible, false, '后台排版不重显工具条');

  sendFixture('focus');
  const returned = await waitFor('返回来源后恢复两个窗口且不抢焦点', async () => {
    const value = await probe();
    return sourceStatus?.state === 'active' && value.foreground === sourceReady.handle && value.overlayVisible && value.controlsVisible && value.overlayAboveSource && !value.overlayTopmost ? value : null;
  });
  reportScene('返回来源后恢复且不抢焦点', returned, { 断言: '覆盖译文与工具条恢复；前台仍为来源窗口。' });
  assertProbeOwned(returned);
  assert.equal(returned.overlayAboveSource, true, '返回普通来源后覆盖仍须位于来源上方');
  assert.equal(returned.overlayTopmost, false, '返回普通来源后覆盖最终仍非置顶');
  assert.equal(returned.foreground, sourceReady.handle, '返回来源后仍由来源窗口持有前台焦点');
  assert.equal(controls.isFocused(), false, '恢复时工具条未取得焦点');

  sendFixture('raise');
  const raised = await waitFor('来源 native raise 后覆盖译文重新位于来源上方', async () => {
    const value = await probe();
    return value.foreground === sourceReady.handle && value.overlayVisible && value.controlsVisible && value.overlayAboveSource ? value : null;
  });
  reportScene('来源置顶后覆盖仍在来源上方', raised, { 断言: '原生 Z 序中覆盖译文高于来源窗口，且来源仍持有前台。' });
  assertProbeOwned(raised);
  assert.equal(raised.foreground, sourceReady.handle, '修正 Z 序不夺取来源窗口焦点');
  assert.equal(raised.overlayAboveSource, true, '覆盖译文最终位于被 native raise 的来源窗口上方');

  sendFixture('minimize');
  const minimized = await waitFor('来源最小化后两个正式翻译窗口隐藏', async () => {
    const value = await probe();
    return sourceStatus?.state === 'inactive' && !value.overlayVisible && !value.controlsVisible ? value : null;
  });
  reportScene('来源最小化后隐藏', minimized, { 断言: '来源最小化后覆盖译文和工具条隐藏。' });
  assertProbeOwned(minimized);
  assert.equal(minimized.overlayVisible, false, '最小化来源后覆盖译文隐藏');
  assert.equal(minimized.controlsVisible, false, '最小化来源后工具条隐藏');

  sendFixture('restore');
  const restored = await waitFor('来源还原后恢复显示且保持来源前台', async () => {
    const value = await probe();
    return sourceStatus?.state === 'active' && value.foreground === sourceReady.handle && value.overlayVisible && value.controlsVisible && value.overlayAboveSource && value.overlayTopmost === value.sourceTopmost ? value : null;
  });
  reportScene('来源还原后恢复', restored, { 断言: '两个窗口恢复；工具条未抢占来源焦点。' });
  assertProbeOwned(restored);
  assert.equal(restored.foreground, sourceReady.handle, '来源还原后前台仍是来源窗口');
  assert.equal(controls.isFocused(), false, '来源还原后工具条不夺取焦点');

  sendFixture('move');
  await waitFor('原生助手识别来源移动', () => nativeEvents.some(value => value.state === 'moved'));
  const moved = await waitFor('移动来源后结束旧覆盖并保留对照', async () => {
    const value = await probe();
    return state.translation?.sourceInvalid === true && state.translation.options.displayMode === 'compare' &&
      !value.overlayVisible && value.controlsVisible ? value : null;
  });
  reportScene('来源移动后终止旧覆盖并保留对照', moved, { 断言: '原生移动事件更新翻译状态与正式布局；覆盖关闭、对照工具条保留。' });
  assertProbeOwned(moved);
  assert.equal(moved.overlayVisible, false, '来源移动后旧位置覆盖结束');
  assert.equal(moved.controlsVisible, true, '来源移动后对照工具条保留');
  assert.equal(state.translation.placement.sourceInvalid, true, '翻译状态标记旧来源位置失效');
  assert.equal(state.translation.options.displayMode, 'compare', '正式动作适配器切换为对照翻译');

  sendFixture('destroy-source');
  const closed = await waitFor('来源窗口销毁后本次覆盖与翻译结束', () => sourceStatus?.state === 'closed' &&
    state.translation === null && !overlay.isVisible() && !controls.isVisible());
  reportScene('来源关闭后结束本次翻译', null, { 断言: '来源 HWND 关闭事件清除本次翻译状态，覆盖译文与工具条均隐藏。', 来源状态: closed.state });
  assert.equal(state.translation, null, '来源关闭后结束本次翻译');
}

async function writeReport(success, error) {
  let foregroundAtReport = null;
  if (sourceReady && !fixtureExit) {
    try {
      const value = await fixtureProbe();
      foregroundAtReport = { 归属: foregroundOwner(value.foregroundPid), 前台为自有A: value.foreground === sourceReady.handle,
        A可见: value.sourceVisible === true, B可见: value.otherVisible === true };
    } catch {}
  }
  const displays = process.platform === 'win32' ? screen.getAllDisplays().map(display => ({
    id: display.id, bounds: display.bounds, workArea: display.workArea, scaleFactor: display.scaleFactor,
    dpi: Math.round(96 * display.scaleFactor),
  })) : [];
  const report = {
    通过: success,
    模式: process.argv.includes('--seeded-minimize-only') ? '自有原生来源最小化恢复定向验证（合成完成态）' : injectedNoPinReturn ? '回来源 active 适配器故障注入' : injectedNoSourceGate ? 'inactive 适配器故障注入'
      : pinReturnOnly ? '菜单置顶返回来源与模式往返原生验证' : '真实 Windows 来源跟随原生验证',
    材质助手: process.argv.includes('--real-window-appearance') ? '真实 WindowAppearance 辅助进程' : '材质助手替身，未覆盖真实材质',
    覆盖: ['正式截图 renderer 的框选完成动作', '正式 main.cjs capture-done 翻译分支', '正式 desktop.cjs capture 与翻译窗口',
      '正式 preload 与翻译 renderer', '正式 translation-source.cjs', '由正式 TranslationSource.cs 构建的真实助手', '独立自有 WinForms 来源夹具'],
    系统: { 平台: os.platform(), 版本: os.release(), 详细版本: os.version(), 架构: os.arch(), Electron: process.versions.electron, Node: process.versions.node },
    显示器: displays,
    进程: { Electron主进程: process.pid, 来源夹具: sourceReady?.pid || null, 两进程不同: sourceReady ? sourceReady.pid !== process.pid : null },
    独立另一窗口夹具: { 启用: externalOtherProcess, A与B进程不同: fixtureOtherReady ? fixtureOtherReady.pid !== sourceReady.pid : false },
    隔离诊断: { 阶段: scenarioPhase, 临时userData: path.dirname(userData) === os.tmpdir() && path.basename(userData).startsWith('pickgloss-verification-source-'),
      桌面模块已创建: Boolean(desktop), mainVM已初始化: Boolean(mainHarness), mainVM单实例锁stub: mainHarness ? '隔离VM始终返回true；未进入Electron真实main.start' : '未创建',
      本次Electron自有窗口数: windows.filter(win => !win.isDestroyed()).length, 前台探针: foregroundAtReport },
    来源快照: placement?.source ? { handle: placement.source.handle, pid: placement.source.pid, bounds: placement.source.bounds } : null,
    前台建立探针: initialFocusProbe ? { 前台为自有A: initialFocusProbe.foreground === sourceReady?.handle,
      A可见: initialFocusProbe.sourceVisible, B可见: initialFocusProbe.otherVisible } : null,
    最近来源前台探针: lastFixtureProbe,
    最近前台请求: lastFocusAttempt,
    捕获归属摘要: captureSummaries,
    渲染器结构探针: rendererDiagnostics,
    来源状态事件: nativeEvents,
    适配器状态事件: forwardedEvents,
    正式capture完成动作: actionCalls.filter(value => value.action === 'capture-done').length,
    来源恢复尝试: restorationAttempts,
    来源恢复应答: restorationReplies,
    菜单置顶回来源最近原生探针: lastPinReturnProbe,
    故障注入: { 丢弃返回来源active: injectedNoPinReturn, 返回检查已开始: pinReturnAwaiting },
    快速返回菜单: quickReturnReply,
    本机OCR与翻译mock请求: modelCalls,
    网络请求尝试数: networkAttempts.length,
    渲染器错误: consoleErrors,
    渲染器加载问题: rendererFailures,
    场景: scenes,
    失败: error ? (error.stack || String(error)).split('\n').slice(0, 8) : failures,
    输出: path.relative(path.join(__dirname, '..'), path.join(output, 'report.json')),
    截图: '未采集屏幕；只检查自有窗口元数据与合成材料的自有 renderer canvas 像素。',
  };
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
}

async function cleanup() {
  if (desktop) { try { desktop.dispose(); } catch {} }
  if (watcher) { try { watcher.dispose(); } catch {} }
  if (fixtureOther && !fixtureOtherExit) {
    try { fixtureOther.stdin.write('quit\n'); } catch {}
    const deadline = Date.now() + 2000;
    while (!fixtureOtherExit && Date.now() < deadline) await delay(25);
    if (!fixtureOtherExit) fixtureOther.kill();
  }
  if (fixture && !fixtureExit) {
    try { sendFixture('quit'); } catch {}
    const deadline = Date.now() + 2500;
    while (!fixtureExit && Date.now() < deadline) await delay(25);
    if (!fixtureExit) { try { fixture.kill(); } catch {} }
  }
  for (const pending of [...pendingProbes.values(), ...pendingFixtureProbes.values()]) { clearTimeout(pending.timer); pending.reject(new Error('验证清理中止窗口探针。')); }
  pendingProbes.clear();
  pendingFixtureProbes.clear();
  try { ipcMain.removeHandler('pickgloss:action'); } catch {}
  // 仅清理本次由 mkdtemp 创建且路径前缀固定的临时 userData。
  if (path.dirname(userData) === os.tmpdir() && path.basename(userData).startsWith('pickgloss-verification-source-')) {
    try { await fs.rm(userData, { recursive: true, force: true }); } catch {}
  }
}

async function main() {
  let error = null;
  try {
    if (injectedNoSourceGate) {
      try { await runScenarios(); }
      catch (caught) {
        if (nativeEvents.some(value => value.state === 'inactive') && !forwardedEvents.some(value => value.state === 'inactive') &&
            overlay && !overlay.isDestroyed() && overlay.isVisible()) {
          error = caught;
        } else throw caught;
      }
      if (!error) throw new Error('故障注入没有触发跨窗口残留检查失败。');
      await writeReport(false, error);
      process.stderr.write('来源跟随故障注入如预期失败；请检查 report.json 的残留场景。\n');
      process.exitCode = 1;
      return;
    }
    await runScenarios();
    assert.deepEqual(networkAttempts, [], '隔离验证不应尝试联网');
    assert.deepEqual(consoleErrors, [], '正式渲染器不应报告错误');
    assert.deepEqual(failures, [], '原生夹具协议未报告错误');
    await writeReport(true, null);
    process.stdout.write(`来源跟随原生验证通过；报告：${path.join(output, 'report.json')}\n`);
  } catch (caught) {
    error = caught;
    try { await writeReport(false, error); } catch {}
    process.stderr.write(`来源跟随原生验证失败：${caught.message}\n`);
    process.exitCode = 1;
  } finally {
    if (!finishCalled) { finishCalled = true; await cleanup(); }
  }
}

app.whenReady().then(main).catch(error => {
  process.stderr.write(`来源跟随原生验证启动失败：${error.message}\n`);
  process.exitCode = 1;
}).finally(() => app.exit(process.exitCode || 0));
