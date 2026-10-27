'use strict';

// 截图框选的隔离诊断。只使用预制虚构像素与 desktopCapturer 替身，不运行正式主进程。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { performance } = require('node:perf_hooks');
const crypto = require('node:crypto');
const os = require('node:os');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');
const option = name => process.argv.find(value => value.startsWith('--' + name + '='))?.slice(name.length + 3);
const sourcePath = path.join(__dirname, '../src/windows/desktop.cjs');
const source = fs.readFileSync(option('source') || sourcePath, 'utf8');
const sourceSha256 = crypto.createHash('sha256').update(source).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function distribution(values) {
  const ordered = values.filter(Number.isFinite).sort((a, b) => a - b);
  const item = quantile => ordered[Math.max(0, Math.ceil(ordered.length * quantile) - 1)] ?? null;
  return { count: ordered.length, median: item(.5), p95: item(.95), max: item(1) };
}

async function structuralProbe() {
  const events = [], windows = [], messages = [], requests = [];
  let encoded = 0, jpegEncoded = 0, now = 0, lastCrop = null;
  const display = { id: 707, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 2 };
  const image = { isEmpty: () => false, getSize: () => ({ width: 3840, height: 2160 }),
    toDataURL() { encoded++; events.push({ stage: '编码整屏PNG', at: now }); return 'data:image/png;base64,' + 'A'.repeat(1024); },
    toJPEG(quality) { jpegEncoded++; events.push({ stage: '编码整屏JPEG预览', at: now, quality }); return Buffer.from('虚构JPEG预览'); },
    crop(rect) { lastCrop = rect; return { toDataURL: () => 'data:image/png;base64,AA==' }; } };
  class HiddenWindow extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.bounds = { ...display.bounds }; this.destroyed = false;
      this.webContents = Object.assign(new EventEmitter(), { id: windows.length + 1, mainFrame: {},
        isLoading: () => false, setWindowOpenHandler() {}, send: (channel, state) => messages.push({ channel, state, kind: this.kind }), });
      windows.push(this); events.push({ stage: '构建窗口', at: now });
    }
    loadFile(_file, options) {
      this.kind = options.query.window;
      this.webContents.mainFrame.url = pathToFileURL(path.join(__dirname, '../src/renderer/index.html')).href + '?window=' + this.kind;
      events.push({ stage: '开始loadFile', at: now });
      return Promise.resolve();
    }
    isDestroyed() { return this.destroyed; } isVisible() { return false; }
    hide() {} show() { events.push({ stage: '展示被替身拦截', at: now }); } showInactive() {} focus() {}
    setAlwaysOnTop() {} setBounds(bounds) { this.bounds = bounds; } getBounds() { return this.bounds; }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const electron = { BrowserWindow: HiddenWindow, ipcMain: new EventEmitter(), nativeTheme: new EventEmitter(),
    systemPreferences: {}, app: {}, utilityProcess: {}, nativeImage: {}, Menu: {}, Tray: class {},
    screen: Object.assign(new EventEmitter(), { getCursorScreenPoint: () => ({ x: 1, y: 1 }), getDisplayNearestPoint: () => display,
      getDisplayMatching: () => display, getPrimaryDisplay: () => display }),
    desktopCapturer: { async getSources(request) { requests.push(request); events.push({ stage: '取图替身', at: now }); return [{ display_id: String(display.id), thumbnail: image }]; } } };
  const loaded = { exports: {} };
  vm.runInNewContext(source, { module: loaded, exports: loaded.exports, __dirname: path.dirname(sourcePath),
    require: name => name === 'electron' ? electron : name === './screen-capture.cjs' ? { createScreenCapture: () => null } : name.startsWith('./') ? require(path.join(path.dirname(sourcePath), name)) : require(name),
    process: { platform: 'win32', pid: 0 }, Date,
    setTimeout(callback, delay = 0) {
      events.push({ stage: '定时等待', at: now, delay });
      // 只推进退隐等待；就绪失败看门狗保留为待执行计时器，避免替身提前取消会话。
      if (delay <= 160) { now += delay; queueMicrotask(callback); }
      return 1;
    },
    clearTimeout() {}, setInterval() {}, clearInterval() {},
  }, { filename: sourcePath });
  const desktop = loaded.exports.createDesktop({ onAction() {}, onSelection() {}, onStatus() {} });
  desktop.openPanel(); desktop.setOrb(true);
  await desktop.beginCapture();
  const firstState = desktop.captureState();
  const bootstrapDeliveries = windows.map(win => {
    const fullState = { capture: firstState, status: {} };
    const state = desktop.stateFor ? desktop.stateFor({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, fullState) : fullState;
    return { kind: win.kind, state };
  });
  desktop.broadcast({ capture: firstState, status: {} });
  const secondState = desktop.captureState();
  desktop.broadcast({ capture: secondState, status: { selection: '虚构状态变化' } });
  assert.equal(requests.length, 1, '同一次截图只能调用一次取图入口。');
  assert.equal(requests[0].thumbnailSize.width, 3840, '保留屏幕物理像素宽度。');
  assert.equal(requests[0].thumbnailSize.height, 2160, '保留屏幕物理像素高度。');
  assert.equal(firstState.imageData, secondState.imageData, '重复读取同一次截图材料应相同。');
  const imageDeliveries = [...bootstrapDeliveries, ...messages]
    .filter(value => value.state.capture?.imageData || value.state.imageData);
  const nonCaptureImageDeliveries = imageDeliveries.filter(value => value.kind !== 'capture').length;
  const redundantEncoding = encoded + jpegEncoded > 1;
  const redundantBroadcast = imageDeliveries.filter(value => value.kind === 'capture').length > 1;
  const captureRendererCanPrepareWhileHidden = !desktop.captureReady || windows.find(value => value.kind === 'capture')?.options.webPreferences?.backgroundThrottling === false;
  const cropped = desktop.finishCapture({ x: 20, y: 30, width: 40, height: 50 });
  assert.match(cropped, /^data:image\/png;base64,/, '最终选区必须从原图输出 PNG。');
  assert.deepEqual({ ...lastCrop }, { x: 40, y: 60, width: 80, height: 100 }, '最终选区必须使用原始物理像素。');
  desktop.cancelCapture();
  return { description: '实际桌面模块的确定性替身反馈环；未测真实取图和真实墙钟延迟。', sourceSha256,
    signals: { redundantEncoding, redundantBroadcast, nonCaptureImageDeliveries, fullScreenPngEncodes: encoded,
      fullScreenJpegPreviewEncodes: jpegEncoded, finalCropUsesOriginalPixels: true, captureRendererCanPrepareWhileHidden,
      broadcastsWithWholeScreenData: messages.filter(value => value.state.capture?.imageData).length,
      totalImageDeliveries: imageDeliveries.length,
      verdict: redundantEncoding || redundantBroadcast || nonCaptureImageDeliveries || !captureRendererCanPrepareWhileHidden ? 'RED' : 'GREEN' },
    requestedThumbnailSize: requests[0].thumbnailSize, sourceCalls: requests.length, events,
    limitation: 'RED 表示导致等待的重复工作模式存在，不声称复现了真实屏幕上用户看到的总等待时长。' };
}

async function main() {
  if (process.argv.includes('--electron') && !process.versions.electron) {
    const { spawn } = require('node:child_process');
    const childEnv = { ...process.env };
    delete childEnv.ELECTRON_RUN_AS_NODE;
    const child = spawn(require('electron'), [__filename, ...process.argv.slice(2)], { windowsHide: true, env: childEnv, stdio: 'inherit' });
    child.once('error', error => { console.error(error.message); process.exitCode = 1; });
    child.once('exit', code => { process.exitCode = code ?? 1; });
    return;
  }
  if (process.versions.electron) return electronProbe();
  const result = await structuralProbe();
  const report = option('report');
  if (report) fs.writeFileSync(path.resolve(report), JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify(result, null, 2));
  if (process.argv.includes('--assert-fast') && result.signals.verdict === 'RED') process.exitCode = 1;
}

async function electronProbe() {
  const { app, BrowserWindow, ipcMain, nativeImage, nativeTheme } = require('electron');
  const cycles = Number(option('cycles') || 1);
  if (!Number.isInteger(cycles) || cycles < 1 || cycles > 5) throw new Error('截图测量轮数必须为1至5。');
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'pickgloss-capture-latency-'));
  app.setPath('userData', path.join(isolated, 'runtime'));
  app.setPath('sessionData', path.join(isolated, 'session'));
  app.setName('PickGloss 隐藏截图时序诊断');
  // 多轮测量之间会关闭所有隐藏窗口，宿主仍需留在后台完成下一轮。
  app.on('window-all-closed', () => {});
  const snapshotRenderer = path.join(isolated, 'src/renderer');
  fs.mkdirSync(path.dirname(snapshotRenderer), { recursive: true });
  fs.cpSync(option('renderer-dir') || path.join(__dirname, '../src/renderer'), snapshotRenderer, { recursive: true });
  const vendorPath = path.join(isolated, 'node_modules/markdown-it/dist/browser');
  fs.mkdirSync(vendorPath, { recursive: true });
  fs.copyFileSync(path.join(__dirname, '../node_modules/markdown-it/dist/browser/markdown-it.umd.min.js'), path.join(vendorPath, 'markdown-it.umd.min.js'));
  const preloadPath = path.join(isolated, 'preload.cjs');
  fs.writeFileSync(path.join(isolated, 'desktop-source.cjs'), source);
  const rendererSha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(snapshotRenderer, 'app.js'))).digest('hex');
  fs.writeFileSync(preloadPath, fs.readFileSync(path.join(__dirname, '../src/preload.cjs'), 'utf8') + `
// 仅诊断宿主使用：观察真正 renderer 的收包、DOM 插入与图片解码。
ipcRenderer.on('pickgloss:state', (_event, value) => {
  const receivedAt = performance.now();
  ipcRenderer.send('latency:mark', {stage:'received',rendererAt:receivedAt,hasImage:!!value.capture?.imageData});
  queueMicrotask(() => ipcRenderer.send('latency:mark', {stage:'processed',rendererAt:performance.now(),receivedAt,hasImage:!!value.capture?.imageData}));
});
ipcRenderer.on('latency:decode-preview', async (_event, value) => {
  const image = document.createElement('img');
  const started = performance.now();
  image.src = value.imageData;
  try {
    await image.decode();
    ipcRenderer.send('latency:mark', {stage:'preview-decoded',token:value.token,format:value.format,
      decodeMs:performance.now()-started,naturalWidth:image.naturalWidth,naturalHeight:image.naturalHeight});
  } catch (error) { ipcRenderer.send('latency:mark',{stage:'decode-error',message:error.message}); }
});
const observed = new WeakSet();
new MutationObserver(() => {
  const image = document.querySelector('.capture-image');
  if (!image || observed.has(image)) return;
  observed.add(image);
  const insertedAt = performance.now();
  ipcRenderer.send('latency:mark', {stage:'image-inserted',rendererAt:insertedAt});
  image.decode().then(() => {
    const decodedAt = performance.now();
    ipcRenderer.send('latency:mark', {stage:'image-decoded',rendererAt:decodedAt,insertedAt,decodedAt,
      decodeMs:decodedAt-insertedAt,naturalWidth:image.naturalWidth,naturalHeight:image.naturalHeight});
    requestAnimationFrame(() => requestAnimationFrame(() => ipcRenderer.send('latency:mark', {
      stage:'decoded',rendererAt:performance.now(),insertedAt,decodedAt,decodeMs:decodedAt-insertedAt,
      naturalWidth:image.naturalWidth,naturalHeight:image.naturalHeight
    })));
  }).catch(error => ipcRenderer.send('latency:mark',{stage:'decode-error',message:error.message}));
}).observe(document,{childList:true,subtree:true});
`, 'utf8');
  const marks = [], windows = [], encodes = [], requests = [], sends = [], replies = [], acknowledgements = [], runEvents = [];
  let currentRun = null, currentDesktop = null, bootstrapState = null;
  ipcMain.on('latency:mark', (event, value) => marks.push({ ...value, mainAt: performance.now(), webContentsId: event.sender.id, run: currentRun }));
  ipcMain.handle('pickgloss:action', async (event, action, payload) => {
    if (action === 'capture-ready' && currentDesktop?.captureReady) {
      const accepted = currentDesktop.captureReady(payload);
      acknowledgements.push({ run: currentRun, at: performance.now(), id: payload?.id, accepted, webContentsId: event.sender.id });
      return { ok: true, value: accepted };
    }
    if (action !== 'bootstrap') return { ok: false, error: '隔离诊断禁止真实操作。' };
    const capture = currentDesktop ? currentDesktop.captureState() : bootstrapState?.capture || null;
    let state = fakeState(capture);
    if (currentDesktop?.stateFor) {
      // renderer 加载的是只读源码副本；把相同窗口身份映射回正式 URL 再验证正式 surfaceState。
      const frame = { url: pathToFileURL(path.join(__dirname, '../src/renderer/index.html')).href + '?window=capture' };
      state = currentDesktop.stateFor({ sender: { id: event.sender.id, mainFrame: frame }, senderFrame: frame }, state);
    }
    replies.push({ run: currentRun, at: performance.now(), imageBytes: state.capture?.imageData ? Buffer.byteLength(state.capture.imageData) : 0 });
    return { ok: true, value: state };
  });
  for (const method of ['show', 'showInactive']) BrowserWindow.prototype[method] = function () { throw new Error('诊断禁止显示任何真实窗口。'); };
  class HiddenWindow extends BrowserWindow {
    constructor(options) {
      const webPreferences = { ...options.webPreferences, preload: preloadPath };
      if (process.argv.includes('--force-unthrottled')) webPreferences.backgroundThrottling = false;
      super({ ...options, show: false, webPreferences });
      this.probeBackgroundThrottling = webPreferences.backgroundThrottling !== false;
      this.probeKind = '';
      this.probeStarted = performance.now();
      windows.push(this);
      this.webContents.on('did-finish-load', () => runEvents.push({ stage: 'did-finish-load', at: performance.now(), webContentsId: this.webContents.id, run: currentRun }));
      this.once('ready-to-show', () => runEvents.push({ stage: 'ready-to-show', at: performance.now(), webContentsId: this.webContents.id, run: currentRun }));
      const originalSend = this.webContents.send.bind(this.webContents);
      this.webContents.send = (channel, value) => {
        const started = performance.now();
        const bytes = value?.capture?.imageData ? Buffer.byteLength(value.capture.imageData) : 0;
        originalSend(channel, value);
        sends.push({ channel, started, syncMs: performance.now() - started, imageBytes: bytes, kind: this.probeKind, webContentsId: this.webContents.id, run: currentRun });
      };
    }
    loadFile(_file, options = {}) {
      this.probeKind = options.query?.window || 'capture';
      runEvents.push({ stage: 'loadFile', at: performance.now(), webContentsId: this.webContents.id, run: currentRun });
      const destination = pathToFileURL(path.join(snapshotRenderer, 'index.html'));
      destination.searchParams.set('window', this.probeKind);
      return super.loadURL(destination.href);
    }
    show() { runEvents.push({ stage: 'show-intercepted', at: performance.now(), webContentsId: this.webContents.id, run: currentRun }); }
    showInactive() {} focus() {}
  }
  function fakeState(capture) {
    return { view: 'paste', session: null, history: [], settingsSection: 'service', pinned: false, wide: false,
      capture, settings: { prefs: { appearance: require('../src/core/appearance.cjs').defaultAppearance() }, text: {}, vision: {} },
      status: { error: '', shortcutErrors: [], selection: '虚构截图时序诊断' } };
  }
  async function until(check, description, timeoutMs = 8000) {
    const started = performance.now();
    while (performance.now() - started < timeoutMs) { const value = await check(); if (value) return value; await sleep(10); }
    throw new Error(description + '超时。');
  }
  async function decoded(win, after = 0, stage = 'decoded') {
    const mark = await until(() => marks.slice(after).find(value => value.webContentsId === win.webContents.id && value.stage === stage), '预制图解码');
    if (BrowserWindow.getAllWindows().some(value => value.isVisible())) throw new Error('诊断窗口意外可见。');
    return mark;
  }
  function fixture(width, height, mixed) {
    const bitmap = Buffer.alloc(width * height * 4);
    let random = 0x31a40d7b;
    for (let y = 0, at = 0; y < height; y++) for (let x = 0; x < width; x++, at += 4) {
      const ink = y % 48 > 18 && y % 48 < 28 && x % 360 > 32 && x % 360 < 300;
      let red = ink ? 35 : 245, green = ink ? 42 : 247, blue = ink ? 52 : 250;
      if (mixed && x > width * .67 && y > height * .2 && y < height * .8) {
        random ^= random << 13; random ^= random >>> 17; random ^= random << 5;
        red = random & 255; green = random >>> 8 & 255; blue = random >>> 16 & 255;
      }
      bitmap[at] = blue; bitmap[at + 1] = green; bitmap[at + 2] = red; bitmap[at + 3] = 255;
    }
    return nativeImage.createFromBitmap(bitmap, { width, height });
  }
  function encodeBench(image, label) {
    const pngMs = [], base64Ms = [], dataUrlMs = [], jpeg92Ms = [], jpegBase64Ms = [];
    let png, imageData, jpeg92, jpegImageData;
    for (let round = 0; round < 3; round++) {
      let started = performance.now(); png = image.toPNG(); pngMs.push(performance.now() - started);
      started = performance.now(); png.toString('base64'); base64Ms.push(performance.now() - started);
      started = performance.now(); imageData = image.toDataURL(); dataUrlMs.push(performance.now() - started);
      started = performance.now(); jpeg92 = image.toJPEG(92); jpeg92Ms.push(performance.now() - started);
      started = performance.now(); jpegImageData = 'data:image/jpeg;base64,' + jpeg92.toString('base64'); jpegBase64Ms.push(performance.now() - started);
    }
    return { label, dimensions: image.getSize(), pngBytes: png.length, dataUrlBytes: Buffer.byteLength(imageData),
      pngMs: distribution(pngMs), base64Ms: distribution(base64Ms), dataUrlMs: distribution(dataUrlMs),
      jpeg92Bytes: jpeg92.length, jpeg92DataUrlBytes: Buffer.byteLength(jpegImageData), jpeg92Ms: distribution(jpeg92Ms), jpegBase64Ms: distribution(jpegBase64Ms),
      raw: { pngMs, base64Ms, dataUrlMs, jpeg92Ms, jpegBase64Ms }, imageData, jpegImageData };
  }
  function createDesktopForImage(image) {
    const display = { id: 707, scaleFactor: 2, bounds: { x: 0, y: 0, width: image.getSize().width / 2, height: image.getSize().height / 2 } };
    display.workArea = display.bounds;
    const wrapped = new Proxy(image, { get(target, key) {
      if (key === 'toDataURL') return () => { const started = performance.now(); const data = target.toDataURL(); encodes.push({ started, ms: performance.now() - started, run: currentRun }); return data; };
      if (key === 'toJPEG') return quality => { const started = performance.now(); const data = target.toJPEG(quality); encodes.push({ started, ms: performance.now() - started, format: 'jpeg', quality, run: currentRun }); return data; };
      const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
    } });
    const electron = { app, BrowserWindow: HiddenWindow, ipcMain, nativeTheme, nativeImage,
      Menu: {}, Tray: class {}, systemPreferences: { getAnimationSettings: () => ({ prefersReducedMotion: true }) }, utilityProcess: {},
      screen: Object.assign(new EventEmitter(), { getCursorScreenPoint: () => ({ x: 100, y: 100 }), getDisplayNearestPoint: () => display, getDisplayMatching: () => display }),
      desktopCapturer: { async getSources(value) { requests.push({ ...value, at: performance.now(), run: currentRun }); return [{ id: 'screen:707:0', name: '虚构屏幕', display_id: '707', thumbnail: wrapped }]; } } };
    const loaded = new Module(sourcePath, module);
    loaded.filename = sourcePath; loaded.paths = module.paths;
    loaded.require = name => name === 'electron' ? electron : name === './screen-capture.cjs' ? { createScreenCapture: () => null } : Module.prototype.require.call(loaded, name);
    loaded._compile(source, sourcePath);
    return loaded.exports.createDesktop({ onAction() {}, onSelection() {}, onStatus() {} });
  }
  const deadline = setTimeout(() => { console.error('隐藏截图时序诊断超时。'); app.exit(1); }, 55000);
  await app.whenReady();
  try {
    const structural = await structuralProbe();
    const encoding = [], renderer = [], decoder = [], pipeline = [];
    const fixtures = [{ label: '全高清虚构文字', width: 1920, height: 1080 }, { label: '4K虚构文字', width: 3840, height: 2160 }, { label: '4K虚构文字与噪声图块', width: 3840, height: 2160, mixed: true }];
    if (option('fixture') && option('fixture') !== 'mixed') throw new Error('指定截图样本时只接受mixed。');
    for (const config of fixtures.filter(value => !option('fixture') || value.mixed)) {
      const image = fixture(config.width, config.height, config.mixed);
      const encoded = encodeBench(image, config.label);
      const capture = { id: 'fictional-' + config.width + '-' + !!config.mixed, imageData: encoded.imageData, width: config.width / 2, height: config.height / 2 };
      const { imageData: _omitted, jpegImageData: _omittedJpeg, ...summary } = encoded;
      encoding.push(summary);
      for (const warm of [false, true]) {
        currentRun = config.label + (warm ? '：预热界面' : '：冷界面');
        currentDesktop = null;
        bootstrapState = fakeState(warm ? null : capture);
        const markStart = marks.length;
        const started = performance.now();
        const win = new HiddenWindow({ width: capture.width, height: capture.height, frame: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } });
        await win.loadFile('', { query: { window: 'capture' } });
        let deliveryStarted = started;
        if (warm) {
          await until(() => win.webContents.executeJavaScript('Boolean(document.querySelector(".capture-surface"))'), '预热框选界面');
          // 等待空 renderer 完成首次布局，再交付图片。
          await sleep(60);
          deliveryStarted = performance.now();
          win.webContents.send('pickgloss:state', fakeState(capture));
        }
        const ready = await decoded(win, markStart);
        const beforeRepeat = marks.length;
        const repeatStarted = performance.now();
        win.webContents.send('pickgloss:state', fakeState(capture));
        const repeated = await until(() => marks.slice(beforeRepeat).find(value => value.stage === 'processed' && value.webContentsId === win.webContents.id), '重复状态处理');
        renderer.push({ label: config.label, warm, ctorToLoadMs: runEvents.find(value => value.run === currentRun && value.stage === 'did-finish-load').at - started,
          deliveryToDecodedTwoFramesMs: ready.mainAt - deliveryStarted, decodeMs: ready.decodeMs,
          naturalWidth: ready.naturalWidth, naturalHeight: ready.naturalHeight,
          repeatedStateRoundTripMs: repeated.mainAt - repeatStarted, repeatedStateRendererMs: repeated.rendererAt - repeated.receivedAt });
        win.destroy();
      }
      currentRun = config.label + '：空renderer冷解码对照';
      bootstrapState = fakeState(null);
      const decoderWindow = new HiddenWindow({ width: capture.width, height: capture.height, frame: false,
        webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } });
      await decoderWindow.loadFile('', { query: { window: 'capture' } });
      for (const format of ['png', 'jpeg92']) {
        const token = currentRun + '-' + format;
        const decodeStarted = performance.now();
        decoderWindow.webContents.send('latency:decode-preview', { token, format, imageData: format === 'png' ? encoded.imageData : encoded.jpegImageData });
        const sample = await until(() => marks.find(value => value.stage === 'preview-decoded' && value.token === token), '同像素预览冷解码');
        assert.equal(sample.naturalWidth, config.width, '预览解码必须保留物理像素宽度。');
        assert.equal(sample.naturalHeight, config.height, '预览解码必须保留物理像素高度。');
        decoder.push({ label: config.label, format, decodeMs: sample.decodeMs, sendThroughDecodeMs: sample.mainAt - decodeStarted,
          naturalWidth: sample.naturalWidth, naturalHeight: sample.naturalHeight, cacheState: '新建空renderer，每个格式仅解码一次' });
      }
      decoderWindow.destroy();
      bootstrapState = null;
      currentDesktop = createDesktopForImage(image);
      let priorCaptureWindow = null;
      for (let round = 0; round < cycles; round++) {
      currentRun = config.label + '：实际beginCapture管线：' + (round + 1);
      const markStart = marks.length, encodeStart = encodes.length, sendStart = sends.length, replyStart = replies.length, ackStart = acknowledgements.length;
      const started = performance.now();
      await currentDesktop.beginCapture();
      currentDesktop.broadcast(fakeState(currentDesktop.captureState()));
      const win = await until(() => windows.find(value => !value.isDestroyed() && value.probeKind === 'capture'), '实际框选窗口');
      const ready = await decoded(win, markStart, 'image-decoded');
      const ack = currentDesktop.captureReady ? await until(() => acknowledgements.slice(ackStart).find(value => value.accepted), '正式renderer就绪回执') : null;
      const encodesBeforeReady = encodes.length;
      const decodeToRendererAckMs = ack ? ack.at - ready.mainAt : null;
      // 250毫秒是隔离回归护栏，用来捕获隐藏两帧约2秒的等待，不是产品前台SLO。
      if (process.argv.includes('--assert-fast') && ack && decodeToRendererAckMs > 250) throw new Error('隐藏截图解码后等待就绪回执超过250毫秒。');
      if (currentDesktop.captureReady) assert.equal(win.probeBackgroundThrottling, false, '隐藏框选窗口必须自行配置关闭后台节流。');
      await win.webContents.executeJavaScript('globalThis.__captureLatencyImage = document.querySelector(".capture-image")');
      const beforeMetadata = marks.length, beforeMetadataSend = sends.length;
      currentDesktop.broadcast(fakeState(currentDesktop.captureState()));
      await until(() => marks.slice(beforeMetadata).find(value => value.stage === 'processed' && value.webContentsId === win.webContents.id), '后续状态处理');
      const imageNodePreserved = await win.webContents.executeJavaScript('globalThis.__captureLatencyImage === document.querySelector(".capture-image")');
      assert.equal(imageNodePreserved, true, '同次截图普通状态不能重建图片节点。');
      const metadataResentImageBytes = sends.slice(beforeMetadataSend).reduce((sum, value) => sum + value.imageBytes, 0);
      if (currentDesktop.stateFor) assert.equal(metadataResentImageBytes, 0, '后续普通状态不能重传整屏字段。');
      const captureSends = sends.slice(sendStart);
      pipeline.push({ label: config.label, round: round + 1, reusedCaptureWindow: win === priorCaptureWindow, startToDecodedMs: ready.mainAt - started,
        startToRendererAckMs: ack ? ack.at - started : null, rendererReadyAccepted: ack?.accepted || false,
        decodeToRendererAckMs,
        captureBackgroundThrottling: win.probeBackgroundThrottling, helperForcedUnthrottled: process.argv.includes('--force-unthrottled'),
        imageNodePreserved, metadataResentImageBytes,
        triggerToGetSourcesSubstituteMs: requests.at(-1).at - started,
        getSourcesSubstituteCalls: requests.filter(value => value.run === currentRun).length,
        requestedThumbnailSize: requests.at(-1).thumbnailSize,
        wholeScreenEncodes: encodes.length - encodeStart, wholeScreenEncodingMs: encodes.slice(encodeStart).reduce((sum, value) => sum + value.ms, 0),
        wholeScreenEncodesBeforeReady: encodesBeforeReady - encodeStart,
        wholeScreenEncodingBeforeReadyMs: encodes.slice(encodeStart, encodesBeforeReady).reduce((sum, value) => sum + value.ms, 0),
        fullImageSends: captureSends.filter(value => value.imageBytes).length,
        fullImageBroadcastBytes: captureSends.reduce((sum, value) => sum + value.imageBytes, 0),
        fullImageBootstrapReplies: replies.slice(replyStart).filter(value => value.imageBytes).length,
        totalFullImageDeliveries: captureSends.filter(value => value.imageBytes).length + replies.slice(replyStart).filter(value => value.imageBytes).length,
        sendSyncMs: distribution(captureSends.map(value => value.syncMs)), decodeMs: ready.decodeMs,
        naturalWidth: ready.naturalWidth, naturalHeight: ready.naturalHeight });
      currentDesktop.cancelCapture();
      priorCaptureWindow = win;
      }
      currentDesktop.dispose?.();
      currentDesktop = null;
    }
    const result = { description: '实际 Electron 隐藏窗口、正式 renderer 副本、预制虚构像素；desktopCapturer 为替身。',
      sourceSha256, rendererSha256, electron: process.versions.electron, isolated, cycles,
      allWindowsHidden: BrowserWindow.getAllWindows().every(value => !value.isVisible()),
      structural, encoding, renderer, decoder, pipeline, raw: { marks, encodes, requests, sends, replies, acknowledgements, events: runEvents },
      limitation: '没有读取真实屏幕、剪贴板、正常 userData 或密钥，没有模型调用。隐藏两帧不等于前台 DWM/HITL。取图替身耗时接近零，不能推断真实 desktopCapturer 耗时；噪声图仅提供大载荷压力证据。' };
    const reportPath = path.resolve(option('report') || path.join(isolated, 'report.json'));
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(result, null, 2), 'utf8');
    console.log(JSON.stringify({ description: result.description, reportPath, sourceSha256, rendererSha256,
      allWindowsHidden: result.allWindowsHidden, encoding, renderer, decoder, pipeline }, null, 2));
    if (process.argv.includes('--assert-fast') && structural.signals.verdict === 'RED') process.exitCode = 1;
  } catch (error) {
    const failurePath = path.resolve((option('report') || path.join(isolated, 'report.json')) + '.failed.json');
    const rendererState = await Promise.all(BrowserWindow.getAllWindows().map(async win => ({
      id: win.webContents.id, hidden: !win.isVisible(), state: await win.webContents.executeJavaScript(`({
        imageCount:document.querySelectorAll('.capture-image').length,
        imageType:document.querySelector('.capture-image')?.src?.slice(0,23),
        complete:document.querySelector('.capture-image')?.complete,
        naturalWidth:document.querySelector('.capture-image')?.naturalWidth,
        help:document.querySelector('.capture-help-message')?.textContent,
        error:document.querySelector('.capture-error')?.textContent
      })`).catch(() => null),
    })));
    fs.mkdirSync(path.dirname(failurePath), { recursive: true });
    fs.writeFileSync(failurePath, JSON.stringify({ description: '隔离诊断失败记录，不含完整像素或正常数据。', error: error.message,
      currentRun, sourceSha256, rendererSha256, marks, encodes, requests, sends, replies, acknowledgements, events: runEvents, rendererState }, null, 2), 'utf8');
    console.error(error.stack);
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
    for (const win of BrowserWindow.getAllWindows()) win.destroy();
    app.exit(process.exitCode || 0);
  }
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; });
