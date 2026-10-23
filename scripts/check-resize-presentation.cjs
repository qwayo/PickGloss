'use strict';
const { quoteJavaScriptString } = require('./javascript-string.cjs');

// 同一固定虚构标题的笔画按空白列分簇，避免把左侧来源标签接到回答标题上。
// 颜色、透明度、取样带和80像素连续性阈值保持不变。
function selectAnswerTitleInk(columnCounts) {
  const clusters = [], splitEmptyColumns = 12;
  let lastInkColumn = -Infinity;
  for (let x = 0; x < columnCounts.length; x++) {
    const count = columnCounts[x];
    if (!count) continue;
    if (!clusters.length || x - lastInkColumn - 1 >= splitEmptyColumns) clusters.push({ minX: x, maxX: x, count: 0 });
    const cluster = clusters.at(-1);
    cluster.maxX = x; cluster.count += count; lastInkColumn = x;
  }
  const selected = clusters.reduce((best, value) => !best || value.count > best.count ? value : best, null);
  return { minX: selected?.minX ?? null, maxX: selected?.maxX ?? null, count: selected?.count ?? 0,
    clusters, splitEmptyColumns, method: '固定虚构回答标题的最大墨迹簇',
    wholeBand: { minX: clusters[0]?.minX ?? null, maxX: clusters.at(-1)?.maxX ?? null, count: clusters.reduce((sum, value) => sum + value.count, 0) } };
}

// 纯Node离线入口：stdin为已有PNG按同一取样规则提取的逐列墨迹数，不创建Electron窗口。
if (process.argv.includes('--scan-ink-columns')) {
  const input = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
  console.log(JSON.stringify({ description: '仅用已有PNG的逐列墨迹数复算标题识别，未启动窗口。',
    frames: input.frames.map(({ columns, ...frame }) => ({ ...frame, contentInk: selectAnswerTitleInk(columns) })) }, null, 2));
  process.exit(0);
}

// 隐藏离屏诊断：只回放虚构解释会话，记录实际 Chromium 绘制与逐帧布局。
// 不加载正式主进程，不展示窗口，不读取正常数据、屏幕、剪贴板或全局热键。
const electron = require('electron');
const { app, BrowserWindow, ipcMain } = electron;
// 初始化失败也必须只写终端，禁止 Electron 默认错误框占用桌面。
electron.dialog.showErrorBox = (title, content) => { console.error(title + '\n' + content); app.exit(1); };
process.on('uncaughtException', error => { console.error(error.stack); app.exit(1); });
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const { performance } = require('node:perf_hooks');
const arg = key => process.argv.find(value => value.startsWith('--' + key + '='))?.slice(key.length + 3);
const sourceRoot = path.resolve(__dirname, '..');
const outputRoot = path.resolve(arg('output') || path.join(sourceRoot, 'output/verification/pin-polish-20261016/motion/baseline'));
const variant = arg('variant') || 'source';
const scrollPosition = arg('scroll') || 'middle';
const material = arg('material') ?? 'solid';
const pinned=arg('pinned')==='true';
const glow=arg('glow')||'source';
const sequence=arg('sequence')||'roundtrip';
const cycles = Number(arg('cycles') || 2);
if (!['source', 'lock-compact', 'sync-layout', 'freeze-content', 'freeze-content-commit', 'flip-x', 'flip-xy', 'sync-flip-x', 'flip-x-protected', 'sync-flip-x-protected', 'sync-guarded-flip'].includes(variant)) throw new Error('实验类型无效。');
if(!['source','disabled'].includes(glow))throw new Error('外光实验开关无效。');
if(!['roundtrip','rapid'].includes(sequence))throw new Error('动作序列无效。');
if (!['solid', 'glass'].includes(material)) throw new Error('材质必须为 solid 或 glass。');
if (!['top', 'middle', 'bottom'].includes(scrollPosition)) throw new Error('滚动位置无效。');
if (!Number.isInteger(cycles) || cycles < 1 || cycles > 8) throw new Error('测量轮数必须为1至8。');
fs.mkdirSync(outputRoot, { recursive: true });
const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'pickgloss-resize-presentation-'));
app.setPath('userData', path.join(isolated, 'user-data'));
app.setPath('sessionData', path.join(isolated, 'session-data'));
app.setName('PickGloss 隐藏布局呈现诊断');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
const snapshotRoot = path.resolve(arg('snapshot') || path.join(outputRoot, 'sources'));
if (!arg('snapshot')) {
  fs.cpSync(path.join(sourceRoot, 'src/renderer'), path.join(snapshotRoot, 'src/renderer'), { recursive: true });
  for (const relative of ['src/windows/desktop.cjs', 'src/windows/geometry.cjs', 'src/preload.cjs', 'node_modules/markdown-it/dist/browser/markdown-it.umd.min.js']) {
    const destination = path.join(snapshotRoot, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(sourceRoot, relative), destination);
  }
}
const originalSource = fs.readFileSync(path.join(snapshotRoot, 'src/windows/desktop.cjs'), 'utf8');
let runtimeRoot=snapshotRoot;
const experimentChanges=[];
if(variant!=='source'){
  runtimeRoot=path.join(outputRoot,'experiment-sources');
  fs.cpSync(snapshotRoot,runtimeRoot,{recursive:true});
  const rendererPath=path.join(runtimeRoot,'src/renderer/app.js');
  let rendererSource=fs.readFileSync(rendererPath,'utf8').replace(/\r\n/g,'\n');
  const replaceOnce=(before,after,description)=>{
    if(!rendererSource.includes(before))throw new Error('实验边界不存在：'+description);
    rendererSource=rendererSource.replace(before,after);experimentChanges.push(description);
  };
  if(variant==='lock-compact')replaceOnce('const reading = window.innerWidth >= 640;','const reading = false;','只锁定为小窗排版，原生动画、宽度变化与阅读锚点逻辑原样保留。');
  if(variant==='sync-layout' || variant==='sync-flip-x' || variant==='sync-flip-x-protected' || variant==='sync-guarded-flip'){
    replaceOnce("  layoutFrame = requestAnimationFrame(() => {\n    syncWindowLayout();", "  syncWindowLayout();\n  layoutFrame = requestAnimationFrame(() => {",'只把尺寸布局同步从下一rAF提前至resize回调当次，输入框检查仍留在rAF。');
  }
  if(variant==='freeze-content' || variant==='freeze-content-commit'){
    replaceOnce("let layoutViewport = '';", "let layoutViewport = '';\nlet presentationWidth = null;",'保留一个仅隔离实验使用的动效起始内容宽度。');
    replaceOnce('const reading = window.innerWidth >= 640;','const reading = (presentationWidth ?? window.innerWidth) >= 640;','宽度冻结时按该内容宽度选择排版，避免读到原生外壳的中间尺寸。');
    replaceOnce("root.style.width = '100%';", "root.style.width = presentationWidth === null ? '100%' : `${presentationWidth}px`;",'动效期间保持起始内容宽度，终态一次提交最终宽度。');
    replaceOnce('  const previous = state;\n  if (next.status?.windowTransitioning', '  const previous = state;\n  if (next.status?.windowTransitioning && !previous?.status?.windowTransitioning) presentationWidth = window.innerWidth;\n  if (!next.status?.windowTransitioning) presentationWidth = null;\n  if (next.status?.windowTransitioning','只以原生动效开始和完成状态协调内容宽度冻结。');
    if(variant==='freeze-content-commit')replaceOnce('  if (!next.status?.windowTransitioning) presentationWidth = null;', "  if (!next.status?.windowTransitioning) { if (presentationWidth !== null) layoutViewport = ''; presentationWidth = null; }",'终态内容宽度变更即强制一次布局提交与原锚点恢复，不能只靠原生viewport变化。');
  }
  if(['flip-x','flip-xy','sync-flip-x','flip-x-protected','sync-flip-x-protected','sync-guarded-flip'].includes(variant)){
    const xy=variant==='flip-xy';
    const guarded=variant==='sync-guarded-flip';
    const protectedFlip=variant.endsWith('-protected')||guarded;
    replaceOnce("let layoutViewport = '';",`let layoutViewport = '';
const presentationFlips = new Map();
function presentationAnchorNode() {
  const anchor = transitionAnchor || readingAnchor;
  const message = [...root.querySelectorAll('[data-message]')].find(node => node.dataset.message === anchor?.message);
  return message?.querySelector('.message-content')?.children[anchor?.index] || root.querySelector('.message-content > *');
}`,'隔离实验仅记录两栏纯位移动画及当前阅读锚点。');
    replaceOnce('  const reading = window.innerWidth >= 640;',`  const reading = window.innerWidth >= 640;
  const modeChanged = reading !== readingLayout;
  const prefersReduced = document.documentElement.classList.contains('reduced-motion');
  const flipBefore = modeChanged ? ['.source-pane', '.answer-pane'].map(selector => {
    const node = root.querySelector(selector);
    const point = ${xy?'node':"selector === '.answer-pane' ? presentationAnchorNode() : node?.querySelector('.selected-word') || node"};
    return node && point ? { node, point, before: point.getBoundingClientRect(), paneBefore:node.getBoundingClientRect(), edge:root.querySelector('[data-scroll="body"]')?.getBoundingClientRect().top ?? 0 } : null;
  }).filter(Boolean) : [];
  if (modeChanged || prefersReduced) {
    for (const animation of presentationFlips.values()) { animation.presentationRestore?.(); animation.cancel(); }
    presentationFlips.clear();
  }`,'排版切换前测量当前实际呈现位置；反向先读现有transform再取消旧动画。');
    replaceOnce('  if (resized) restoreReadingAnchor(transitionAnchor || readingAnchor);',`  if (resized) restoreReadingAnchor(transitionAnchor || readingAnchor);
  if (modeChanged && !prefersReduced) for (const {node, point, before, paneBefore, edge} of flipBefore) {
    const after = point.getBoundingClientRect();
    const dx = before.x - after.x, dy = ${xy?'before.y - after.y':guarded?"paneBefore.y >= edge - 1 && node.getBoundingClientRect().y >= (root.querySelector('[data-scroll=\"body\"]')?.getBoundingClientRect().top ?? 0) - 1 && Math.abs(before.y-after.y) <= 260 ? before.y-after.y : 0":'0'};
    let presentationRestore = () => {};
    ${protectedFlip?`if (node.classList.contains('answer-pane')) {
      const body = root.querySelector('.explain-body');
      const saved = { background:node.style.background, position:node.style.position, zIndex:node.style.zIndex, overflowX:body.style.overflowX };
      node.style.background='var(--paper)'; node.style.position='relative'; node.style.zIndex='1'; body.style.overflowX='hidden';
      presentationRestore = () => { node.style.background=saved.background; node.style.position=saved.position; node.style.zIndex=saved.zIndex; body.style.overflowX=saved.overflowX; };
    }`:''}
    const animation = node.animate([{transform: \`translate(\${dx}px, \${dy}px)\`}, {transform:'translate(0px, 0px)'}], {duration:200, easing:'linear'});
    animation.presentationRestore = presentationRestore;
    presentationFlips.set(node, animation);
    animation.onfinish = () => { if (presentationFlips.get(node) === animation) { presentationFlips.delete(node); presentationRestore(); } animation.cancel(); };
  }`,'只在单/双栏切换时启动200毫秒真实DOM纯位移，持续resize保持同一动画；锚点先恢复。');
  }
  fs.writeFileSync(rendererPath,rendererSource);
}
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const hashes = {};
for (const relative of ['src/windows/desktop.cjs', 'src/windows/geometry.cjs', 'src/preload.cjs', ...fs.readdirSync(path.join(snapshotRoot, 'src/renderer')).filter(name => /\.(html|js|css)$/.test(name)).map(name => 'src/renderer/' + name)]) hashes[relative] = sha256(fs.readFileSync(path.join(snapshotRoot, relative)));
for (const method of ['show', 'showInactive']) BrowserWindow.prototype[method] = function () { throw new Error('隐藏诊断禁止展示窗口。'); };
const createdWindows = [];
const nativeWindowCalls=[];
let measurementPhase='idle';
class HiddenWindow extends BrowserWindow {
  constructor(options) {
    super({ ...options, show: false, webPreferences: { ...options.webPreferences, offscreen: true, backgroundThrottling: false } });
    this._probeKind=options.parent?'pin-glow':'panel';
    createdWindows.push(this);
  }
  setBounds(bounds,...rest){
    const started=performance.now();
    const result=super.setBounds(bounds,...rest);
    if(measurementPhase!=='idle')nativeWindowCalls.push({at:started,cost:performance.now()-started,phase:measurementPhase,kind:this._probeKind,bounds:{...bounds}});
    return result;
  }
}
const forbidden = name => () => { throw new Error('隐藏诊断禁止调用：' + name); };
const safeElectron = { ...electron, BrowserWindow: HiddenWindow,
  Tray: class { constructor() { throw new Error('隐藏诊断禁止建立托盘。'); } },
  desktopCapturer: { getSources: forbidden('屏幕采集') }, utilityProcess: { fork: forbidden('选区进程') },
  clipboard: new Proxy({}, { get: () => forbidden('剪贴板') }), globalShortcut: new Proxy({}, { get: () => forbidden('全局热键') }) };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const distribution = values => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const at = q => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q))] ?? null;
  return { count: sorted.length, median: at(.5), p95: at(.95), max: at(1), over25ms: sorted.filter(value => value > 25).length };
};
const gaps = values => values.slice(1).map((value, index) => value - values[index]);
function fakeState() {
  const content = Array.from({ length: 24 }, (_, index) => `### 虚构段落 ${index + 1}\n\n这是一段仅用于隐藏布局诊断的虚构材料。窗口展开时文字保持固定字号，并按可用宽度重新换行。观察同一阅读位置是否突然移动，可帮助区分原生尺寸调度和内容重排。\n\n- 虚构观察项\n- 虚构解释项`).join('\n\n');
  const thread = { draft: '', status: 'complete', error: '', messages: [{ id: 'fictional-answer', role: 'assistant', content, status: 'complete' }] };
  return { view: 'explain', session: { id: 'fictional-presentation-session', kind: 'text', text: '虚构布局诊断', context: '这是固定的虚构上下文，用于回放解释窗口展开和收窄。', contextOrigin: 'manual', activeMode: 'context', saved: false, source: { app: '虚构应用', title: '虚构页面' }, createdAt: '2026-10-16T00:00:00.000Z', threads: { context: thread, independent: { ...thread, messages: [] }, visual: { ...thread, messages: [] } } }, history: [], settingsSection: 'service', pinned, wide: false, capture: null, settings: { prefs: { appearance: { current: { mode: 'light', material }, reducedMotion: false } }, text: { model: '虚构模型', baseUrl: 'http://127.0.0.1', hasKey: false }, vision: {} }, status: { error: '', shortcutErrors: [], selection: '隐藏诊断；未启动划词' } };
}
const probeCode = `(() => {
  const probe = globalThis.resizePresentation = { samples: [], active: false, anchor: null, phase: 'idle', observerEvents: [] };
  const rect = node => { if (!node) return null; const r = node.getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height }; };
  probe.sample = at => {
    if (!probe.active) return;
    const scroller = document.querySelector('[data-scroll="body"]'), panel = document.querySelector('.panel');
    const anchorRect = rect(probe.anchor), scrollRect = rect(scroller), tabs = document.querySelector('.mode-tabs');
    const selected = tabs?.querySelector('[aria-selected="true"]');
    const paragraph=probe.anchor?.tagName==='P'?probe.anchor:probe.anchor?.nextElementSibling;
    const paragraphRect=rect(paragraph); let paragraphLines=null;
    if(paragraph?.tagName==='P'){const range=document.createRange();range.selectNodeContents(paragraph);paragraphLines=new Set([...range.getClientRects()].map(value=>Math.round(value.top))).size;}
    const overflowX=scroller?getComputedStyle(scroller).overflowX:null;
    probe.samples.push({ at, phase:probe.phase, width:innerWidth, height:innerHeight, reading:panel?.classList.contains('reading-layout'), scroller:scroller?.className, scrollTop:scroller?.scrollTop, scrollLeft:scroller?.scrollLeft,scrollWidth:scroller?.scrollWidth,clientWidth:scroller?.clientWidth,overflowX,horizontalScrollbar:scroller && scroller.scrollWidth>scroller.clientWidth+1 && !['hidden','clip'].includes(overflowX),scrollHeight:scroller?.scrollHeight, clientHeight:scroller?.clientHeight, anchor:anchorRect, anchorOffset:anchorRect && scrollRect ? anchorRect.y-scrollRect.y : null, paragraph:paragraphRect,paragraphLines,answer:rect(document.querySelector('.answer-pane')), source:rect(document.querySelector('.source-pane')), tabs:rect(tabs), selected:rect(selected), indicator:rect(tabs?.querySelector('.mode-indicator')), composer:rect(document.querySelector('.composer-wrap')), fontSize:getComputedStyle(document.querySelector('.message')).fontSize });
  };
  probe.start = position => {
    const scroller = document.querySelector('[data-scroll="body"]');
    scroller.scrollTop = position === 'middle' ? Math.round((scroller.scrollHeight-scroller.clientHeight)*.45) : position === 'bottom' ? scroller.scrollHeight : 0;
    const edge = scroller.getBoundingClientRect().top;
    probe.anchor = [...document.querySelectorAll('.message-content > *')].find(node => node.getBoundingClientRect().bottom > edge+12);
    probe.active = true; probe.phase='settle'; probe.sample(performance.now());
  };
  let probeFrame;
  const frame = at => { probe.sample(at); if (!probe.stopped) probeFrame=requestAnimationFrame(frame); };
  probeFrame=requestAnimationFrame(frame);
  addEventListener('resize', () => {
    if (probe.active) probe.observerEvents.push({type:'resize',at:performance.now(),width:innerWidth,height:innerHeight});
    // 正式应用先登记布局rAF，探针后登记；避免把布局修正前的DOM中间态当作已绘制内容。
    cancelAnimationFrame(probeFrame); probeFrame=requestAnimationFrame(frame);
  });
  new MutationObserver(() => { if (probe.active) probe.observerEvents.push({type:'layout-class',at:performance.now(),className:document.querySelector('.panel')?.className}); }).observe(document.querySelector('.panel'),{attributes:true,attributeFilter:['class']});
  return {visibility:document.visibilityState,devicePixelRatio,accent:getComputedStyle(document.documentElement).getPropertyValue('--accent-ink').trim()};
})()`;
const timeout = setTimeout(() => { console.error('隐藏布局呈现诊断超时。'); app.exit(1); }, 45000);
app.whenReady().then(async () => {
  let desktop;
  try {
    const state = fakeState(), statusChanges = [], nativeCalls = [], paints = [];
    const errors = [];
    ipcMain.handle('pickgloss:action', (_event, action, payload) => {
      if (action === 'bootstrap') return { ok: true, value: state };
      if (action === 'wide') { desktop.setWide(payload.wide); return { ok: true, value: payload.wide }; }
      throw new Error('隐藏诊断收到范围外操作：' + action);
    });
    const filename = path.join(runtimeRoot, 'src/windows/desktop.cjs');
    const loaded = new Module(filename, module);
    loaded.filename = filename; loaded.paths = module.paths;
    const originalRequire = loaded.require.bind(loaded);
    loaded.require = request => request === 'electron' ? safeElectron : originalRequire(request);
    const measuredSource=glow==='disabled'?originalSource.replace('  function syncPinGlow() {','  function syncPinGlow() { return;'):originalSource;
    if(glow==='disabled' && measuredSource===originalSource)throw new Error('外光实验源码没有syncPinGlow边界。');
    loaded._compile(measuredSource, filename);
    desktop = loaded.exports.createDesktop({ onAction: forbidden('真实操作'), onSelection: forbidden('真实划词'), onStatus(change) {
      statusChanges.push({ at: performance.now(), ...change });
      Object.assign(state.status, change); if (typeof change.wide === 'boolean') state.wide = change.wide;
      desktop?.broadcast(state);
    } });
    desktop.setAppearance(state.settings.prefs.appearance);
    await desktop.smoke();
    const win = createdWindows[0];
    desktop.setPinned(pinned);
    win.webContents.on('console-message', (_event, details) => { if (details.level === 'error') errors.push(details.message); });
    win.webContents.setFrameRate(60);
    win.webContents.setAudioMuted(true);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await win.webContents.executeJavaScript('Boolean(document.querySelector(".message-content"))')) break;
      await sleep(20);
    }
    if (!(await win.webContents.executeJavaScript('Boolean(document.querySelector(".message-content"))'))) throw new Error('正式界面的虚构解释会话未完成加载。');
    await sleep(320);
    const environment = await win.webContents.executeJavaScript(probeCode);
    const rawSetBounds = win.setBounds.bind(win);
    let phase = 'idle';
    win.setBounds = bounds => {
      const started = performance.now(); rawSetBounds(bounds);
      nativeCalls.push({ at: started, cost: performance.now()-started, phase, requested:{...bounds}, actual:win.getBounds() });
    };
    win.webContents.on('paint', (_event, dirty, image) => {
      if (phase === 'idle') return;
      paints.push({ at:performance.now(), phase, dirty:{...dirty}, size:image.getSize(), image });
    });
    await win.webContents.executeJavaScript(`resizePresentation.start(${quoteJavaScriptString(scrollPosition)})`);
    await sleep(100);
    const rounds = [];
    const actions=Array.from({length:cycles},()=>sequence==='rapid'?[{wide:true,wait:145},{wide:false,wait:85},{wide:true,wait:440},{wide:false,wait:370}]:[{wide:true,wait:440},{wide:false,wait:370}]).flat();
    for (let round = 0; round < actions.length; round++) {
      const {wide,wait}=actions[round];
      phase = `${round+1}-${wide?'expand':'contract'}`;
      measurementPhase=phase;
      const start = performance.now();
      const rendererStart = await win.webContents.executeJavaScript(`resizePresentation.phase=${quoteJavaScriptString(phase)}; performance.now()`);
      desktop.setWide(wide);
      await sleep(wait);
      const rendererEnd = await win.webContents.executeJavaScript('performance.now()');
      rounds.push({ phase, wide, start, end:performance.now(), rendererStart, rendererEnd });
    }
    phase = 'idle';
    measurementPhase='idle';
    const renderer = await win.webContents.executeJavaScript('resizePresentation.active=false; resizePresentation.stopped=true; ({samples:resizePresentation.samples,observerEvents:resizePresentation.observerEvents,visibility:document.visibilityState})');
    // 在真实离屏像素中定位窗口顶端正文的深色笔画；分析安排在动画结束后。
    // 固定虚构锚点标题位于58至95行；玻璃材质下左栏标签也可能命中颜色阈值。
    // 按较大空白列分簇后取标题的最大墨迹簇，不跨对象使用整个取样带的minX。
    for (const frame of paints) {
      const bytes=frame.image.toBitmap(), {width,height}=frame.size;
      const columnCounts = new Uint16Array(width);
      for(let y=58;y<Math.min(96,height-10);y++)for(let x=10;x<width-12;x++){
        const offset=(y*width+x)*4;
        if(bytes[offset]<90 && bytes[offset+1]<90 && bytes[offset+2]<90 && bytes[offset+3]>180)columnCounts[x]++;
      }
      frame.contentInk = selectAnswerTitleInk(columnCounts);
      frame.pixelReading=scrollPosition==='middle' && frame.contentInk.count>=8 ? frame.contentInk.minX>120 : null;
      frame.layoutWidthMismatch=frame.pixelReading===null || !['source','sync-layout'].includes(variant)?null:frame.pixelReading!==(frame.size.width>=640);
    }
    const structuralJumps = [], paintedContentJumps=[];
    for (const round of rounds) {
      const samples = renderer.samples.filter(value => value.phase === round.phase);
      const calls = nativeCalls.filter(value => value.phase === round.phase);
      const frames = paints.filter(value => value.phase === round.phase);
      const jumps = [];
      for(let index=1;index<frames.length;index++){
        const previous=frames[index-1],current=frames[index];
        if(previous.contentInk.count<8 || current.contentInk.count<8)continue;
        const deltaX=current.contentInk.minX-previous.contentInk.minX;
        if(scrollPosition==='middle' && Math.abs(deltaX)>80)paintedContentJumps.push({phase:round.phase,index,frameGap:current.at-previous.at,fromWidth:previous.size.width,toWidth:current.size.width,fromX:previous.contentInk.minX,toX:current.contentInk.minX,deltaX});
      }
      for (let index=1; index<samples.length; index++) {
        const previous=samples[index-1], current=samples[index];
        const deltaX=current.anchor && previous.anchor ? current.anchor.x-previous.anchor.x : 0;
        const deltaY=current.anchor && previous.anchor ? current.anchor.y-previous.anchor.y : 0;
        const deltaOffset=current.anchorOffset-previous.anchorOffset;
        // scroller本身也可能被纯位移；用锚点相对视口的实际位置判断抖动，保留相对offset作锚点核对。
        if (Math.abs(deltaX)>80 || Math.abs(deltaY)>30) {
          const jump={phase:round.phase,at:current.at,frameGap:current.at-previous.at,fromWidth:previous.width,toWidth:current.width,layoutChanged:current.reading!==previous.reading,fromReading:previous.reading,toReading:current.reading,deltaX,deltaY,deltaOffset,from:previous,to:current};
          jumps.push(jump); structuralJumps.push(jump);
        }
      }
      round.nativeCadence=distribution(gaps(calls.map(value=>value.at)));
      round.paintCadence=distribution(gaps(frames.map(value=>value.at)));
      round.rendererCadence=distribution(gaps(samples.map(value=>value.at)));
      round.nativeCost=distribution(calls.map(value=>value.cost));
      round.paintedSizes=frames.map(value=>value.size);
      round.sampleCount=samples.length; round.paintCount=frames.length; round.jumps=jumps.length;
      round.paintedContentJumps=paintedContentJumps.filter(value=>value.phase===round.phase).length;
      round.layoutWidthMismatches=frames.filter(value=>value.layoutWidthMismatch).map(({at,size,contentInk})=>({at,size,contentInk}));
      round.paragraphLineChanges=samples.slice(1).filter((value,index)=>value.paragraphLines!==samples[index].paragraphLines).length;
      round.paragraphLineSequence=samples.filter((value,index)=>index===0 || value.paragraphLines!==samples[index-1].paragraphLines).map(value=>({at:value.at,width:value.width,lines:value.paragraphLines}));
      round.finalAnchorOffset=samples.at(-1)?.anchorOffset;
      round.horizontalOverflowSamples=samples.filter(value=>value.scrollWidth>value.clientWidth+1).length;
      round.horizontalScrollbarSamples=samples.filter(value=>value.horizontalScrollbar).length;
      round.extraNativeCalls=nativeWindowCalls.filter(value=>value.phase===round.phase && value.kind==='pin-glow').length;
      round.extraNativeCost=distribution(nativeWindowCalls.filter(value=>value.phase===round.phase && value.kind==='pin-glow').map(value=>value.cost));
    }
    // 动画结束后才编码图像，避免PNG编码阻塞干扰动效测量。
    const framesDirectory=path.join(outputRoot,'frames'); fs.mkdirSync(framesDirectory,{recursive:true});
    for (const round of rounds) {
      const frames=paints.filter(value=>value.phase===round.phase);
      const selected=new Set([0,frames.length-1]);
      const crossing=frames.findIndex((value,index)=>index>0 && (value.size.width>=640)!==(frames[index-1].size.width>=640));
      if (crossing>=0) for(let index=Math.max(0,crossing-2);index<=Math.min(frames.length-1,crossing+5);index++)selected.add(index);
      for(const jump of paintedContentJumps.filter(value=>value.phase===round.phase))for(let index=Math.max(0,jump.index-1);index<=jump.index;index++)selected.add(index);
      for(const index of selected)if(frames[index]){
        frames[index].file=`frames/${round.phase}-${String(index).padStart(3,'0')}-${frames[index].size.width}x${frames[index].size.height}.png`;
        fs.writeFileSync(path.join(outputRoot,frames[index].file),frames[index].image.toPNG());
      }
    }
    const hidden=createdWindows.every(value=>value.isDestroyed() || !value.isVisible());
    const continuityPass=structuralJumps.length===0 && paintedContentJumps.length===0;
    const measurementAvailable=rounds.every(round=>round.paintCount>=3 && round.sampleCount>=3);
    const report={description:'真实正式界面与原生尺寸路径的隐藏离屏绘制和逐帧布局诊断。虚构材料；不代表Windows前台DWM呈现或真人验收。',variant,pinned,glow,sequence,createdWindows:createdWindows.map(value=>({kind:value._probeKind,visible:value.isDestroyed()?false:value.isVisible()})),experimentChanges,experimentRendererSha256:sha256(fs.readFileSync(path.join(runtimeRoot,'src/renderer/app.js'))),scrollPosition,cycles,outputRoot,snapshotRoot,runtimeRoot,isolated,hashes,environment,electron:process.versions.electron,platform:process.platform,release:os.release(),hidden,errors,measurementAvailable,continuityPass,pixelProbeAvailable:scrollPosition==='middle',criterion:'正式resize监听器完成布局rAF之后，同一阅读锚点相对视口的相邻帧横移超过80 CSS像素或纵移超过30 CSS像素，记录为布局不连续；相对scroller的offset另记，避免scroller本身参与transform时误判。中部固定虚构材料的真实离屏paint顶端正文笔画横移超过80像素另行记录；顶部像素仅保存人工看图。每动作必须至少有3次实际绘制。阈值未放宽。',rounds,structuralJumps,paintedContentJumps,statusChanges,raw:{nativeCalls,nativeWindowCalls,paints:paints.map(({image,...value})=>value),renderer},limits:['离屏绘制包括真实布局和Chromium像素生成，但不包括可见桌面的DWM、显示刷新和用户主观抖动判断。','rAF几何与paint只按同一动作关联；不声称每个DOM样本均已一一呈现。','像素笔画定位仅适用于此固定虚构材料，不能直接套用任意用户会话。','本判据捕获内容跳变；断点重排本身是现有设计行为，需要单变量实验判定改善与副作用。']};
    report.material = material;
    report.effectiveMaterial = state.status.appearanceMaterial ?? null;
    report.pixelProbeMethod = '固定虚构标题取样带按12列连续空白分簇，选择最大墨迹簇；保留全带minX及各簇用于排除来源标签。颜色、透明度、80像素横移阈值均未修改。';
    fs.writeFileSync(path.join(outputRoot,'report.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify({report:path.join(outputRoot,'report.json'),variant,material,effectiveMaterial:report.effectiveMaterial,hidden,measurementAvailable,continuityPass,structuralJumps:structuralJumps.map(({from,to,...value})=>value),paintedContentJumps,rounds:rounds.map(({paintedSizes,...value})=>value)},null,2));
    desktop.dispose();clearTimeout(timeout);
    app.exit(hidden && measurementAvailable && errors.length===0 && (!process.argv.includes('--assert-continuity') || continuityPass)?0:1);
  }catch(error){console.error(error.stack);desktop?.dispose();clearTimeout(timeout);app.exit(1);}
});
