'use strict';
// 普通 UI 使用固定识别材料；原生专项另用 Windows OCR。两者均不读取真实屏幕或密钥。
const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { setTimeout: delay } = require('node:timers/promises');
const { recognizeWindows } = require('../src/windows/ocr.cjs');
const { translateScreenshot, TRANSLATION_LANGUAGES, translationOptions, translationUsesSearch, ocrBlocks } = require('../src/core/translation.cjs');
const { groupOcrLines } = require('../src/windows/ocr-paragraphs.cjs');
const { translationLayout } = require('../src/windows/translation-layout.cjs');
const { createUiDriver } = require('./ui-driver.cjs');
const { quoteJavaScriptString } = require('./javascript-string.cjs');
const { defaultAppearance } = require('../src/core/appearance.cjs');
const outputIndex = process.argv.indexOf('--output-dir');
const output = outputIndex < 0 ? path.resolve(__dirname, '../output/verification/2026-10-26-translation-compact') : path.resolve(process.argv[outputIndex + 1]);
const nativeOcr = !process.argv.includes('--ui-only');
if (!nativeOcr && process.argv.includes('--native-ocr')) throw Error('普通 UI 与原生 OCR 模式不能同时指定');
app.setPath('userData', path.join(os.tmpdir(), `pickgloss-translation-ui-${process.pid}`));
app.on('window-all-closed', () => {});
let fixture, win, overlay, server, current, copied = '', failure = null, completeSelection, failLanguageSave = false;
let delayNextPreview = false, delayNextRetry = false;
const calls = [], requests = [], remote = [], consoleErrors = [];
const report = { 通过: false, 模式: nativeOcr ? 'Windows OCR 专项' : '普通 UI 合同',
  覆盖: nativeOcr ? '固定中英文图片实际识别、单次本机翻译、正式预加载及隐藏渲染器' : '固定识别材料、真实本机翻译请求、正式预加载及隐藏渲染器交互',
  未覆盖: nativeOcr ? ['真实远端翻译质量', '原生实屏', '其他机器的语言包'] : ['Windows OCR 能力和语言包', 'OCR 覆盖像素识别', '真实远端翻译质量', '原生实屏'] };
async function recognizeFixture(input, singleWord = false) {
  if (nativeOcr) return recognizeWindows(input);
  const { width, height } = nativeImage.createFromDataURL(input.imageData).getSize();
  return { language: 'en-US', angle: 0, blocks: (singleWord ? ['Desktop'] : ['Hello world.', 'Read and translate.']).map((text, index) => ({
    text, x: width * .03, y: height * (.1 + index * .36), width: width * .55, height: height * .15,
  })) };
}
const evaluate = code => win.webContents.executeJavaScript(code);
const driver = createUiDriver(evaluate);
const overlayDriver = createUiDriver(code => overlay.webContents.executeJavaScript(code));
async function changedFixture(script, previousImage) {
  await fixture.webContents.executeJavaScript(script);
  await fixture.webContents.executeJavaScript('document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))');
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    const data = (await fixture.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toDataURL();
    if (data !== previousImage) return data;
    await delay(16);
  }
  throw Error('固定图片的合成画面未更新，不能使用旧像素继续验证');
}
const actionVersion = async () => Number(await evaluate('document.getElementById("app")?.dataset.translationAction || 0'));
const waitForActionState = (previous, state, description, options) => driver.waitFor(
  `(()=>{const root=document.getElementById('app');return Number(root?.dataset.translationAction)>${previous} && root.dataset.translationBusy===${quoteJavaScriptString(state)} && root.dataset.translationAction===root.dataset.translationActionComplete;})()`, description, options);
const waitForActionBusy = (previous, description) => driver.waitFor(
  `(()=>{const root=document.getElementById('app');return Number(root?.dataset.translationAction)>${previous} && root.dataset.translationBusy==='true' && Number(root.dataset.translationActionComplete)<Number(root.dataset.translationAction);})()`, description);
const clickAction = async (label, description, options, waitOptions) => {
  const previous = await actionVersion();
  await driver.click(label, options);
  await waitForActionState(previous, 'false', description, waitOptions);
};
async function selectRegion() {
  const selected = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('松开框选后没有自动开始翻译')), 4000);
    completeSelection = value => { clearTimeout(timer); resolve(value); };
  });
  win.webContents.sendInputEvent({ type: 'mouseDown', x: 80, y: 80, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseMove', x: 350, y: 220, movementX: 270, movementY: 140 });
  win.webContents.sendInputEvent({ type: 'mouseUp', x: 350, y: 220, button: 'left', clickCount: 1 });
  return selected;
}
async function waitForCapture(id) {
  const deadline = Date.now() + 4000;
  while (!calls.some(call => call.action === 'capture-ready' && call.payload.id === id) && Date.now() < deadline) await delay(10);
  assert.ok(calls.some(call => call.action === 'capture-ready' && call.payload.id === id), '当前截图已完成解码并可框选');
}
async function waitForPreview(id, visible) {
  const deadline = Date.now() + 4000;
  while (current.translation?.id === id && current.translation.options.showOriginal !== visible && Date.now() < deadline) await delay(10);
  assert.equal(current.translation?.id, id, '预览状态仍绑定当前截图');
  assert.equal(current.translation.options.showOriginal, visible, `原图临时预览最终为 ${visible}`);
}
async function waitForPreviewActions(id, count) {
  const deadline = Date.now() + 4000;
  while (calls.filter(call => call.action === 'preview-translation-original' && call.payload.id === id).length < count && Date.now() < deadline) await delay(10);
  assert.ok(calls.filter(call => call.action === 'preview-translation-original' && call.payload.id === id).length >= count, '按下与松开动作均已送入独立预览队列');
}
async function readControlLayout() {
  return evaluate(`(()=>{const controls=document.querySelector('.translation-controls'),comparison=document.querySelector('.translation-comparison'),last=controls?.querySelector('.translation-pair:last-of-type');if(!controls)return null;const box=controls.getBoundingClientRect(),lastBox=last?.getBoundingClientRect(),style=getComputedStyle(controls);return {innerWidth,innerHeight,controls:{width:box.width,height:box.height,clientHeight:controls.clientHeight,scrollHeight:controls.scrollHeight,font:style.font,lineHeight:style.lineHeight},comparison:comparison?{clientHeight:comparison.clientHeight,scrollHeight:comparison.scrollHeight,scrollTop:comparison.scrollTop}:null,lastContentBottomGap:lastBox?box.bottom-lastBox.bottom:null};})()`);
}
async function waitForContentHeight(predicate, description, { id = current.translation?.id, after = 0 } = {}) {
  const deadline = Date.now() + 4000;
  const reports = () => calls.filter(call => call.action === 'translation-content-height' && call.payload.id === id).length;
  while (Date.now() < deadline) {
    const native = win.getBounds(), layout = await readControlLayout();
    const feedback = calls.findLast(call => call.action === 'translation-content-height' && call.payload.id === id)?.payload.contentHeight;
    const expectedHeight = Number.isFinite(feedback) ? Math.min(480, current.translation?.placement?.displayBounds?.height || 480, Math.ceil(feedback)) : null;
    if (reports() > after && predicate(native.height) && Math.abs(native.height - expectedHeight) <= 1 && layout?.innerWidth === native.width &&
        layout.innerHeight === native.height && layout.controls?.height === native.height) {
      const stableCount = reports();
      await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); await delay(40);
      const stableNative = win.getBounds(), stableLayout = await readControlLayout();
      if (reports() === stableCount && stableNative.width === native.width && stableNative.height === native.height &&
          stableLayout?.innerWidth === stableNative.width && stableLayout.innerHeight === stableNative.height && stableLayout.controls?.height === stableNative.height) return { native: stableNative, layout: stableLayout, feedback };
    }
    await delay(10);
  }
  const latest = await readControlLayout();
  const latestFeedback = calls.findLast(call => call.action === 'translation-content-height' && call.payload.id === id)?.payload.contentHeight;
  assert.fail(`${description}；native=${JSON.stringify(win.getBounds())}，renderer=${JSON.stringify(latest)}，最后自然高度=${latestFeedback}，反馈次数=${reports() - after}`);
}
const emit = () => { win.webContents.send('pickgloss:state', current); if (overlay && !overlay.isDestroyed()) overlay.webContents.send('pickgloss:state', current); };
ipcMain.handle('pickgloss:action', async (_event, action, payload) => {
  calls.push({ action, payload });
  if (action === 'bootstrap') return { ok: true, value: current };
  if (action === 'set-translation-preferences') {
    if (failLanguageSave) return { ok: false, error: '虚构语言保存失败' };
    current.settings.prefs.screenshotTranslation = translationOptions({ ...current.settings.prefs.screenshotTranslation, ...payload.options, showOriginal: false });
    emit(); return { ok: true };
  }
  if (action === 'set-translation-options') {
    current.translation.options = translationOptions({ ...current.translation.options, ...payload.options,
      showOriginal: payload.options.displayMode === 'compare' ? false : payload.options.showOriginal });
    current.translation.layout = translationLayout(current.translation.placement, current.translation.options.displayMode,
      { contentHeight: current.translation.options.displayMode === 'compare' ? current.translation.contentHeight : undefined });
    win.setBounds({ ...win.getBounds(), width: current.translation.layout.controlBounds.width, height: current.translation.layout.controlBounds.height });
    emit(); return { ok: true };
  }
  if (action === 'translation-content-height') {
    if (payload.id !== current.translation?.id || current.translation.options.displayMode !== 'compare') return { ok: true };
    current.translation.contentHeight = payload.contentHeight;
    current.translation.layout = translationLayout(current.translation.placement, current.translation.options.displayMode, { contentHeight: payload.contentHeight });
    win.setBounds({ ...win.getBounds(), height: current.translation.layout.controlBounds.height });
    return { ok: true };
  }
  if (action === 'preview-translation-original') {
    if (payload.id !== current.translation?.id) return { ok: true };
    if (delayNextPreview && payload.visible) { delayNextPreview = false; await delay(120); }
    if (payload.id !== current.translation?.id) return { ok: true };
    current.translation.options = translationOptions({ ...current.translation.options,
      showOriginal: payload.visible && current.translation.options.displayMode !== 'compare' });
    emit(); return { ok: true };
  }
  if (action === 'copy-translation') { copied = current.translation.blocks.map(block => block.translation).join('\n'); return { ok: true }; }
  if (action === 'retry-translation') {
    if (delayNextRetry) { delayNextRetry = false; await delay(140); }
    const options = translationOptions({ ...current.translation.options, ...payload.options });
    if (options.translationMode !== current.translation.options.translationMode || options.searchEnabled !== current.translation.options.searchEnabled || options.searchScope !== current.translation.options.searchScope) {
      current.settings.prefs.screenshotTranslation = options;
      current.translation = { ...current.translation, id: current.translation.id + '-切换', options, status: 'complete',
        search: translationUsesSearch(options)
          ? { status: 'complete', sources: [{ id: 1, title: '虚构官方译名来源', url: 'https://example.invalid/translation' }] }
          : { status: 'disabled', sources: [] } };
      emit();
    }
    return { ok: true };
  }
  if (action === 'start-capture' || action === 'open-link') return { ok: true };
  if (action === 'capture-ready') return { ok: true, value: true };
  if (action === 'capture-done') { completeSelection?.(payload); return { ok: true }; }
  if (action === 'close-translation') { current.translation = null; emit(); return { ok: true }; }
  return { ok: false, error: '此隔离夹具未授权该动作。' };
});

app.whenReady().then(async () => {
  const timeout = setTimeout(() => { console.error('截图翻译检查超时'); fixture?.destroy(); win?.destroy(); overlay?.destroy(); server?.close(); app.exit(1); }, nativeOcr ? 120000 : 45000);
  try {
    await fs.mkdir(output, { recursive: true });
    fixture = new BrowserWindow({ width: 920, height: 300, show: false, webPreferences: { sandbox: true, backgroundThrottling: false } });
    fixture.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => { remote.push(details.url); callback({ cancel: true }); });
    await fixture.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<style>html,body{margin:0;background:white;color:#111;font:38px/2.6 "Segoe UI","Microsoft YaHei",sans-serif}main{padding:20px}</style><main>Hello world.<br>Read and translate.</main>'));
    report.阶段 = '生成英文固定图片';
    await fixture.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const imageData = (await fixture.webContents.capturePage()).toDataURL();
    const started = performance.now();
    const recognized = await recognizeFixture({ imageData, sourceLanguage: 'en' });
    if (nativeOcr) report.英文识别毫秒 = Math.round(performance.now() - started);
    assert.match(recognized.blocks.map(block => block.text).join(' '), /Hello world/i);
    assert.ok(recognized.blocks.every(block => block.x >= 0 && block.y >= 0 && block.width > 0 && block.height > 0));
    assert.equal(recognized.blocks.length, 2, '真实 OCR 对明显大行距保持两段');
    if (nativeOcr) {
    const paragraphImage = await changedFixture('document.querySelector("main").style.lineHeight="1.3"', imageData);
    const paragraph = await recognizeWindows({ imageData: paragraphImage, sourceLanguage: 'en' });
    assert.equal(paragraph.blocks.length, 1, '真实 OCR 对相近换行合并为一段');
    assert.match(paragraph.blocks[0].text, /Hello.*\nRead/is);
    report.真实OCR分段 = { 大行距段数: recognized.blocks.length, 近行距段数: paragraph.blocks.length };
    const chineseImage = await changedFixture('document.querySelector("main").textContent="截图翻译测试。原文与译文对照。"', paragraphImage);
    report.阶段 = '生成中文固定图片';
    await fixture.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const chinese = await recognizeWindows({ imageData: chineseImage, sourceLanguage: 'zh-Hans' });
    assert.match(chinese.blocks.map(block => block.text).join('').replace(/\s/g, ''), /截图翻译测试/);
    report.已验证识别语言 = [recognized.language, chinese.language];
    }
    server = http.createServer(async (req, res) => {
      try {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const serialized = Buffer.concat(chunks).toString();
        let body;
        try { body = JSON.parse(serialized); }
        catch { report.本机夹具收到非JSON请求体 = serialized.slice(0, 120); res.writeHead(400); res.end('测试请求体无效'); return; }
        requests.push({ method: req.method, url: req.url });
        const content = body.messages[1].content;
        let result;
        if (typeof content === 'string') {
          const payload = JSON.parse(content);
          if (!Array.isArray(payload.lines)) throw Error('文本翻译消息必须以 JSON 字符串携带 lines。');
          result = { translations: [...payload.lines].reverse().map(line => ({ id: line.id, translation: line.text === 'Desktop' ? '桌面' : line.id === 0 ? '你好，世界。' : '阅读并翻译。' })) };
        } else if (Array.isArray(content)) {
          const prompt = content.find(part => part?.type === 'text')?.text || '';
          if (prompt.includes('识别并翻译这张截图')) result = { sourceText: 'Desktop', translation: '桌面' };
          else if (prompt.includes('识别可见原文并整理搜索词')) result = { sourceText: 'Desktop', query: 'Desktop' };
          else throw Error('本机夹具收到未覆盖的多模态翻译提示。');
        } else throw Error('本机夹具的翻译消息 content 类型无效。');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }));
      } catch (error) {
        report.本机夹具请求错误 = error.message;
        if (!res.headersSent) res.writeHead(500);
        res.end('测试夹具请求无效');
      }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const result = await translateScreenshot({ imageData, recognize: recognizeFixture, options: { sourceLanguage: 'en' },
      configs: { text: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: '隔离翻译模型' } } });
    assert.equal(requests.length, 1, '多行文字只发送一次翻译请求');
    assert.equal(result.blocks[0].translation, '你好，世界。', '按编号恢复服务返回的乱序译文');
    const placement = { region: { x: 10, y: 10, width: 310, height: 102 }, displayBounds: { x: 0, y: 0, width: 860, height: 690 } };
    current = { view: 'paste', session: null, history: [], status: {}, settings: { text: {}, prefs: { screenshotTranslation: translationOptions({ sourceLanguage: 'en' }) } }, translationLanguages: TRANSLATION_LANGUAGES,
      translation: { id: '隔离截图翻译', imageData, placement, options: translationOptions({ sourceLanguage: 'en' }), status: 'complete', ...result, layout: translationLayout(placement) } };
    win = new BrowserWindow({ ...current.translation.layout.controlBounds, frame: false, transparent: true, show: false, webPreferences: { preload: path.join(__dirname, '../src/preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
    win.webContents.on('console-message', (...args) => { const details = args[1]; if (typeof details === 'object' ? details.level === 'error' : args[1] >= 2) consoleErrors.push(typeof details === 'object' ? details.message : args[2]); });
    await win.loadFile(path.join(__dirname, '../src/renderer/index.html'), { query: { window: 'translation' } });
    overlay = new BrowserWindow({ ...current.translation.layout.bounds, frame: false, show: false, transparent: true, webPreferences: { preload: path.join(__dirname, '../src/preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
    await overlay.loadFile(path.join(__dirname, '../src/renderer/index.html'), { query: { window: 'translation-overlay' } });
    report.阶段 = '正式截图翻译界面';
    await overlayDriver.waitFor('Boolean(document.querySelector(".translation-overlay"))', '原位译文绘制完成');
    assert.equal(await overlay.webContents.executeJavaScript('document.querySelector(".translation-image").getBoundingClientRect().left'), current.translation.layout.image.left);
    assert.equal(await evaluate('Boolean(document.querySelector(".translation-image"))'), false, '控制窗不包含截图');
    assert.equal(await overlay.webContents.executeJavaScript('Boolean(document.querySelector(".translation-controls"))'), false, '覆盖窗不包含控制区');
    const fixedBounds = overlay.getBounds(); win.setPosition(220, 120);
    assert.deepEqual(overlay.getBounds(), fixedBounds, '实际独立窗口移动不改变覆盖坐标');
    await overlay.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const painted = await overlay.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
    await fs.writeFile(path.join(output, '截图翻译-覆盖.png'), painted.toPNG());
    if (nativeOcr) {
    const paintedText = await recognizeWindows({ imageData: painted.toDataURL(), sourceLanguage: 'zh-Hans' });
    assert.match(paintedText.blocks.map(block => block.text).join('').replace(/\s/g, ''), /你好.*世界/, '覆盖区域实际像素呈现译文');
    assert.doesNotMatch(paintedText.blocks.map(block => block.text).join(' '), /Hello world/i, '覆盖区域不再显示原英文');
    }
    assert.equal(await evaluate('document.querySelector(".translation-warning").hidden'), true, '正常完成不显示常驻帮助小字');
    await fs.writeFile(path.join(output, '截图翻译-紧凑菜单.png'), (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
    await clickAction('识图重试', '识图重试操作结束');
    assert.equal(calls.findLast(call => call.action === 'retry-translation').payload.recognitionMode, 'vision', '漏字时可直接使用识图重试');
    assert.equal(await evaluate('document.querySelectorAll(".translation-display button").length'), 2, '主模式只有互斥的覆盖和对照');
    assert.equal(await evaluate(`Boolean([...document.querySelectorAll('.translation-display button')].some(button=>button.getAttribute('aria-label')==='原图'))`), false, '原图不再是第三个选中模式');
    assert.equal(await evaluate('document.querySelector(".translation-original-preview").getAttribute("aria-label")'), '按住查看原图', '眼睛按钮保留可访问名称');
    const pointer = (type, pointerId = 21) => `new PointerEvent(${JSON.stringify(type)},{bubbles:true,button:0,pointerId:${pointerId},isPrimary:true})`;
    let previewId = current.translation.id;
    await evaluate(`document.querySelector('.translation-original-preview').dispatchEvent(${pointer('pointerdown')})`);
    await driver.waitFor('document.querySelector(".translation-original-preview")?.getAttribute("aria-pressed")==="true"', '按住期间标记原图临时预览');
    await waitForPreview(previewId, true);
    await overlayDriver.waitFor('!document.querySelector(".translation-overlay")', '按住时显示原图');
    await evaluate(`window.dispatchEvent(${pointer('pointerup')})`);
    await waitForPreview(previewId, false);
    await overlayDriver.waitFor('Boolean(document.querySelector(".translation-overlay"))', '松开后恢复覆盖译文');
    assert.equal(current.translation.options.showOriginal, false, '松开动作最终清除原图状态');
    await evaluate(`document.querySelector('.translation-original-preview').dispatchEvent(${pointer('pointerdown',27)})`);
    await waitForPreview(previewId, true);
    await overlayDriver.waitFor('!document.querySelector(".translation-overlay")', '取消用例先显示原图');
    await evaluate(`window.dispatchEvent(${pointer('pointercancel',27)})`);
    await waitForPreview(previewId, false);
    await overlayDriver.waitFor('Boolean(document.querySelector(".translation-overlay"))', 'pointercancel 后恢复覆盖译文');
    await evaluate(`document.querySelector('.translation-original-preview').dispatchEvent(${pointer('pointerdown',28)})`);
    await waitForPreview(previewId, true);
    await overlayDriver.waitFor('!document.querySelector(".translation-overlay")', '丢失捕获用例先显示原图');
    await evaluate(`document.getElementById('app').dispatchEvent(new PointerEvent('lostpointercapture',{bubbles:true,pointerId:28}))`);
    await waitForPreview(previewId, false);
    await overlayDriver.waitFor('Boolean(document.querySelector(".translation-overlay"))', 'lostpointercapture 后恢复覆盖译文');
    // 同一事件循环内快速按下再松开，串行预览队列仍必须保留最后的 false。
    delayNextPreview = true;
    const beforeQuickPreview = calls.filter(call => call.action === 'preview-translation-original' && call.payload.id === previewId).length;
    await evaluate(`(()=>{const button=document.querySelector('.translation-original-preview');button.dispatchEvent(${pointer('pointerdown',22)});window.dispatchEvent(${pointer('pointerup',22)});})()`);
    await waitForPreviewActions(previewId, beforeQuickPreview + 2);
    await waitForPreview(previewId, false);
    await overlayDriver.waitFor('Boolean(document.querySelector(".translation-overlay"))', '延迟的按下 IPC 完成后仍执行松开 IPC');
    assert.equal(current.translation.options.showOriginal, false, '快速松开不受延迟预览 IPC 影响');
    const quickPreview = calls.filter(call => call.action === 'preview-translation-original').slice(-2).map(call => call.payload.visible);
    assert.deepEqual(quickPreview, [true, false], '快速按下与松开按顺序到达预览队列');
    // 失焦必须释放预览；Space 和 Enter 的键盘按住操作也遵循相同生命周期。
    await evaluate(`document.querySelector('.translation-original-preview').dispatchEvent(${pointer('pointerdown',23)})`);
    await driver.waitFor('document.querySelector(".translation-original-preview")?.getAttribute("aria-pressed")==="true"', '失焦用例进入按住状态');
    await overlayDriver.waitFor('!document.querySelector(".translation-overlay")', '失焦用例先显示原图');
    await evaluate('window.dispatchEvent(new Event("blur"))');
    await waitForPreview(previewId, false);
    await overlayDriver.waitFor('Boolean(document.querySelector(".translation-overlay"))', '失焦后恢复覆盖译文');
    for (const key of [' ', 'Enter']) {
      await evaluate(`(()=>{const button=document.querySelector('.translation-original-preview');button.focus();button.dispatchEvent(new KeyboardEvent('keydown',{key:${quoteJavaScriptString(key)},bubbles:true,cancelable:true}));})()`);
      await driver.waitFor('document.querySelector(".translation-original-preview")?.getAttribute("aria-pressed")==="true"', '键盘按住显示临时原图');
      await overlayDriver.waitFor('!document.querySelector(".translation-overlay")', '键盘按住期间显示原图');
      await evaluate(`window.dispatchEvent(new KeyboardEvent('keyup',{key:${quoteJavaScriptString(key)},bubbles:true}))`);
      await waitForPreview(previewId, false);
      await overlayDriver.waitFor('Boolean(document.querySelector(".translation-overlay"))', '键盘松开恢复覆盖译文');
    }
    // 全局操作锁忙时，预览仍走独立 lock:false 队列，松开请求不可被丢弃。
    delayNextRetry = true;
    const busySequence = await actionVersion();
    const retriesBeforeBusy = calls.filter(call => call.action === 'retry-translation').length;
    await driver.click('重新翻译');
    await waitForActionBusy(busySequence, '翻译重试期间菜单显示忙碌状态');
    assert.equal(await evaluate(`[...document.querySelectorAll('button')].find(button=>button.getAttribute('aria-label')==='重新翻译')?.disabled`), true, '非预览操作在忙碌时明确禁用');
    assert.equal(await evaluate('document.querySelector(".translation-original-preview")?.disabled'), false, '原图预览在忙碌时仍可操作');
    const retryDeadline = Date.now() + 4000;
    while (calls.filter(call => call.action === 'retry-translation').length <= retriesBeforeBusy && Date.now() < retryDeadline) await delay(10);
    assert.ok(calls.filter(call => call.action === 'retry-translation').length > retriesBeforeBusy, '翻译重试已占用全局操作锁');
    const beforeBusyPreview = calls.filter(call => call.action === 'preview-translation-original' && call.payload.id === previewId).length;
    await evaluate(`(()=>{const button=document.querySelector('.translation-original-preview');button.dispatchEvent(${pointer('pointerdown',24)});window.dispatchEvent(${pointer('pointerup',24)});})()`);
    await waitForPreviewActions(previewId, beforeBusyPreview + 2);
    await waitForPreview(previewId, false);
    await overlayDriver.waitFor('Boolean(document.querySelector(".translation-overlay"))', '全局翻译操作忙时仍排空原图释放请求');
    assert.equal(current.translation.options.showOriginal, false, 'busy 锁期间松开仍恢复译文');
    await waitForActionState(busySequence, 'false', '忙碌操作结束后菜单恢复就绪');
    // 新截图到来时取消旧 hold；旧请求即使延迟返回，也不能设置新结果的原图状态。
    delayNextPreview = true;
    const beforeStalePreview = calls.filter(call => call.action === 'preview-translation-original' && call.payload.id === previewId).length;
    await evaluate(`document.querySelector('.translation-original-preview').dispatchEvent(${pointer('pointerdown',25)})`);
    await waitForPreviewActions(previewId, beforeStalePreview + 1);
    const staleId = previewId;
    current.translation = { ...current.translation, id: `${staleId}-新结果`, options: translationOptions({ ...current.translation.options, showOriginal: false }) };
    emit();
    await evaluate(`window.dispatchEvent(${pointer('pointerup',25)})`);
    await delay(180);
    previewId = current.translation.id;
    assert.equal(current.translation.options.showOriginal, false, '旧截图迟到的原图请求不能影响新结果');
    assert.equal(await evaluate('document.querySelector(".translation-original-preview")?.getAttribute("aria-pressed")'), 'false', '换截图后清除按住状态');
    await overlayDriver.waitFor('Boolean(document.querySelector(".translation-overlay"))', '新结果继续显示覆盖译文');
    // 切换到对照时即使仍在按住，也会清除临时原图状态并移除眼睛按钮。
    await evaluate(`document.querySelector('.translation-original-preview').dispatchEvent(${pointer('pointerdown',26)})`);
    await waitForPreview(previewId, true);
    await overlayDriver.waitFor('!document.querySelector(".translation-overlay")', '切换模式前正在查看原图');
    const shortFeedbackCount = calls.filter(call => call.action === 'translation-content-height' && call.payload.id === previewId).length;
    await clickAction('对照', '切换对照操作结束');
    await waitForPreview(previewId, false);
    await driver.waitFor('document.querySelectorAll(".translation-pair").length>=2', '原文译文完整对照');
    const stableShort = await waitForContentHeight(height => height > 144 && height < 272, '短文对照应按内容收缩并完成原生resize', { id: previewId, after: shortFeedbackCount });
    const shortComparison = stableShort.layout;
    report.短文对照高度 = shortComparison;
    const shortMeasurement = await evaluate(`(()=>{const controls=document.querySelector('.translation-controls'),live=controls.querySelector('.translation-comparison'),clone=controls.cloneNode(true),surface=document.createElement('main');clone.removeAttribute('id');clone.querySelectorAll('[id]').forEach(node=>node.removeAttribute('id'));surface.className='translation-surface';Object.assign(surface.style,{position:'fixed',left:'-10000px',top:'0',width:controls.getBoundingClientRect().width+'px',height:'auto',visibility:'hidden'});Object.assign(clone.style,{position:'relative',left:'auto',top:'auto',width:'100%',height:'auto',maxHeight:'none',overflow:'visible'});const comparison=clone.querySelector('.translation-comparison');Object.assign(comparison.style,{flex:'none',height:'auto',minHeight:'45px',maxHeight:'none',overflow:'visible'});surface.append(clone);document.body.append(surface);const style=getComputedStyle(controls),measure={naturalHeight:clone.getBoundingClientRect().height,pairCount:comparison.querySelectorAll('.translation-pair').length,sourceLengths:[...comparison.querySelectorAll('.translation-source-text')].map(node=>node.textContent.length),targetLengths:[...comparison.querySelectorAll('.translation-target-text')].map(node=>node.textContent.length),width:controls.getBoundingClientRect().width,font:style.font,lineHeight:style.lineHeight,comparison:{clientHeight:live.clientHeight,scrollHeight:live.scrollHeight}};surface.remove();return measure;})()`);
    const shortFeedback = calls.findLast(call => call.action === 'translation-content-height' && call.payload.id === previewId).payload.contentHeight;
    report.短文测量诊断 = { ...shortMeasurement, feedbackHeight: shortFeedback, nativeHeight: stableShort.native.height };
    assert.equal(shortMeasurement.pairCount, 2);
    assert.equal(shortFeedback, Math.ceil(shortMeasurement.naturalHeight), '最后测量须对应当前两个原文/译文条目和实际字体宽度');
    assert.ok(shortComparison.comparison.scrollHeight <= shortComparison.comparison.clientHeight + 1, '短文对照不产生内部滚动');
    await fs.writeFile(path.join(output, '截图翻译-短文对照.png'), (await win.webContents.capturePage()).toPNG());
    assert.ok(shortComparison.lastContentBottomGap >= -1 && shortComparison.lastContentBottomGap <= 32, `短文对照底部应留少量padding且不溢出：${JSON.stringify(shortComparison)}`);
    assert.equal(await evaluate('Boolean(document.querySelector(".translation-original-preview"))'), false, '对照模式隐藏按住原图图标');
    assert.equal(current.translation.options.showOriginal, false, '进入对照模式清除临时原图状态');
    assert.match(await evaluate('document.querySelector(".translation-comparison").textContent'), /Hello world/i);
    await fs.writeFile(path.join(output, '截图翻译-对照.png'), (await win.webContents.capturePage()).toPNG());
    await clickAction('复制译文', '复制操作结束'); assert.match(copied, /你好/);
    failLanguageSave = true;
    await evaluate('document.querySelector("select[aria-label=目标语言]").value="ja";document.querySelector("select[aria-label=目标语言]").dispatchEvent(new Event("change",{bubbles:true}))');
    await driver.waitFor('document.querySelector(".translation-error")?.textContent.includes("虚构语言保存失败")', '控制窗语言保存失败保留提示', { allowErrors: true });
    await clickAction('覆盖', '语言保存失败后仍可切换覆盖', undefined, { allowErrors: true });
    await clickAction('对照', '语言保存失败后仍可切换对照', undefined, { allowErrors: true });
    await clickAction('已复制', '语言保存失败后仍可复制', undefined, { allowErrors: true });
    assert.equal(await evaluate('document.querySelector("select[aria-label=目标语言]").value'), 'ja', '显示和复制操作不能让未保存的目标语言退回旧值');
    assert.match(await evaluate('document.querySelector(".translation-error").textContent'), /虚构语言保存失败/, '其他操作成功不能清除语言保存失败提示');
    await clickAction('重新翻译', '语言保存失败后的重译操作结束', undefined, { allowErrors: true });
    assert.equal(calls.findLast(call => call.action === 'retry-translation').payload.options.targetLanguage, 'ja');
    failLanguageSave = false;
    await evaluate('document.querySelector("select[aria-label=目标语言]").value="ja";document.querySelector("select[aria-label=目标语言]").dispatchEvent(new Event("change",{bubbles:true}))');
    await driver.waitFor('document.querySelector(".translation-status").textContent.includes("语言已更改")', '当前选择已保存并提示应用到下一次翻译');
    const languageDeadline = Date.now() + 4000;
    while (current.settings.prefs.screenshotTranslation.targetLanguage !== 'ja' && Date.now() < languageDeadline) await delay(10);
    assert.equal(current.settings.prefs.screenshotTranslation.targetLanguage, 'ja', '语言选框一改动就保存后续默认语言');
    emit();
    await driver.waitFor('document.querySelector("select[aria-label=目标语言]").value==="ja"', '状态推送保留未提交的语言选择');
    await clickAction('重新框选', '重新框选操作结束');
    assert.equal(calls.findLast(call => call.action === 'start-capture').payload.options?.targetLanguage, 'ja', '重新框选须使用选框当前的目标语言');
    await clickAction('重新翻译', '重新翻译操作结束');
    assert.equal(calls.findLast(call => call.action === 'retry-translation').payload.options.targetLanguage, 'ja');
    await evaluate('document.querySelector("select[aria-label=目标语言]").value="zh-Hans";document.querySelector("select[aria-label=目标语言]").dispatchEvent(new Event("change",{bubbles:true}))');
    await driver.waitFor('document.querySelector(".translation-status").textContent.includes("完成")', '目标语言切回中文并完成保存');
    assert.equal(current.settings.prefs.screenshotTranslation.targetLanguage, 'zh-Hans');
    await clickAction('重新框选', '中文语言的重新框选操作结束');
    assert.equal(calls.findLast(call => call.action === 'start-capture').payload.options.targetLanguage, 'zh-Hans', '日语切回中文后使用当前选框');
    current.translation.blocks[0].translation = '<img src=x onerror=alert(1)>按文字显示'; emit();
    await driver.waitFor('document.querySelector(".translation-target-text").textContent.includes("<img")', '译文按文字显示');
    assert.equal(await evaluate('Boolean(document.querySelector(".translation-pair img"))'), false);
    const longFeedbackCount = calls.filter(call => call.action === 'translation-content-height' && call.payload.id === current.translation.id).length;
    current.translation.blocks[0].translation = '完整长译文'.repeat(300); emit();
    await clickAction('覆盖', '切回覆盖操作结束');
    await driver.waitFor('document.querySelector(".translation-warning").textContent.includes("译文较长")', '长译文明确提示查看完整对照');
    await clickAction('查看完整对照', '打开完整对照操作结束');
    await driver.waitFor('document.querySelector(".translation-target-text").textContent.length===1500', '对照保留完整长译文');
    await waitForContentHeight(height => height === 480, '长文对照应增长至 480 CSS 像素上限', { id: current.translation.id, after: longFeedbackCount });
    // 正式主进程保留本图测量高度；重复对照回执不能依赖渲染器重复发送相同测量。
    await evaluate(`window.pickgloss.invoke("set-translation-options",{id:${quoteJavaScriptString(current.translation.id)},options:{displayMode:"compare"}})`);
    assert.equal(win.getBounds().height, 480, '重复对照回执必须保留已测量的长文高度');
    report.长文对照高度 = win.getBounds().height;
    await fs.writeFile(path.join(output, '截图翻译-长文对照.png'), (await win.webContents.capturePage()).toPNG());
    const longFeedbackBeforeRepaint = calls.filter(call => call.action === 'translation-content-height' && call.payload.id === current.translation.id).length;
    const longScrollTop = await evaluate('(()=>{const node=document.querySelector(".translation-comparison");node.scrollTop=240;node.dispatchEvent(new Event("scroll"));return node.scrollTop;})()');
    assert.ok(longScrollTop > 0, '长文对照可滚动到中段');
    emit(); await driver.waitFor('document.querySelector(".translation-comparison")?.scrollTop>0', '同一截图状态重绘后保留对照滚动位置');
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); await delay(40);
    assert.equal(calls.filter(call => call.action === 'translation-content-height' && call.payload.id === current.translation.id).length, longFeedbackBeforeRepaint, '重复状态重绘不重复发送相同高度反馈');
    report.长文滚动位置 = await evaluate('document.querySelector(".translation-comparison").scrollTop');
    const originalWindowWidth = win.getBounds().width;
    const originalMeasurement = calls.findLast(call => call.action === 'translation-content-height' && call.payload.id === current.translation.id).payload.contentHeight;
    let widthFeedbackCount = calls.filter(call => call.action === 'translation-content-height' && call.payload.id === current.translation.id).length;
    win.setBounds({ ...win.getBounds(), width: originalWindowWidth - 60 });
    await waitForContentHeight(height => height === 480, '工作区收窄后仍保持长文高度上限', { id: current.translation.id, after: widthFeedbackCount });
    const narrowMeasurement = calls.findLast(call => call.action === 'translation-content-height' && call.payload.id === current.translation.id).payload.contentHeight;
    assert.ok(narrowMeasurement > originalMeasurement, '宽度变窄后长文换行增加并重新测量自然高度');
    assert.equal(await evaluate('innerWidth'), originalWindowWidth - 60, 'renderer实际采用收窄后的视口宽度');
    widthFeedbackCount = calls.filter(call => call.action === 'translation-content-height' && call.payload.id === current.translation.id).length;
    win.setBounds({ ...win.getBounds(), width: originalWindowWidth });
    await waitForContentHeight(height => height === 480, '工作区恢复后重新测量当前宽度', { id: current.translation.id, after: widthFeedbackCount });
    const restoredMeasurement = calls.findLast(call => call.action === 'translation-content-height' && call.payload.id === current.translation.id).payload.contentHeight;
    assert.equal(restoredMeasurement, originalMeasurement, '视口宽度恢复后自然高度恢复');
    report.宽度变化后内容重测 = { narrow: originalWindowWidth - 60, original: originalWindowWidth, narrowMeasurement, restoredMeasurement };
    // 用用户报告的单词核对最终屏幕像素，而非仅检查 canvas 存在或对照文字正确。
    await fixture.webContents.executeJavaScript('document.querySelector("main").textContent="Desktop";new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const desktopImage = (await fixture.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toDataURL();
    await fs.writeFile(path.join(output, '截图翻译-Desktop原图.png'), Buffer.from(desktopImage.split(',')[1], 'base64'));
    const desktopResult = await translateScreenshot({ imageData: desktopImage, recognize: async input => {
      const recognition = await recognizeFixture(input, true); report.单词识别角度 = recognition.angle; return recognition;
    }, options: { sourceLanguage: 'en' },
      configs: { text: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: '隔离翻译模型' } } });
    assert.equal(desktopResult.blocks[0].text, 'Desktop'); assert.equal(desktopResult.blocks[0].translation, '桌面');
    assert.equal(desktopResult.overlayAvailable, true, `水平单词应可覆盖；Windows OCR 估计角度=${report.单词识别角度}`);
    // 文字按原始像素显示；不能将整张宽图硬缩为窄选区，使 OCR 核对的汉字小于可识别尺寸。
    const pixelRatio = await overlay.webContents.executeJavaScript('devicePixelRatio');
    const desktopPlacement = { region: { x: 0, y: 0, width: desktopResult.width / pixelRatio, height: desktopResult.height / pixelRatio },
      displayBounds: { x: 0, y: 0, width: Math.ceil(desktopResult.width / pixelRatio) + 100, height: 800 } };
    current.translation = { ...current.translation, ...desktopResult, id: '桌面覆盖回归', imageData: desktopImage, placement: desktopPlacement, options: translationOptions({ sourceLanguage: 'en' }), layout: translationLayout(desktopPlacement) };
    overlay.setBounds(current.translation.layout.bounds); emit();
    await overlayDriver.waitFor(`Boolean(document.querySelector('.translation-overlay')) && document.querySelector('.translation-image img')?.src === ${quoteJavaScriptString(desktopImage)}`, '单词覆盖译文完成');
    await overlay.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const desktopPaint = await overlay.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
    await fs.writeFile(path.join(output, '截图翻译-Desktop覆盖.png'), desktopPaint.toPNG());
    if (nativeOcr) {
    const desktopText = (await recognizeWindows({ imageData: desktopPaint.toDataURL(), sourceLanguage: 'zh-Hans' })).blocks.map(block => block.text).join('').replace(/\s/g, '');
    assert.match(desktopText, /桌面/, '覆盖区域可实际识别出中文“桌面”'); assert.doesNotMatch(desktopText, /Desktop/i);
    report.单词覆盖像素检查 = 'Desktop → 桌面';
    }
    const savedDesktop = current.translation;
    const paragraphBounds = { width: 220, height: 180 };
    const paragraphBlocks = ocrBlocks({ blocks: groupOcrLines(Array.from({ length: 6 }, (_, index) => ({
      text: `Line ${index + 1}`, x: 10, y: 10 + index * 25, width: 170, height: 20,
    })), paragraphBounds) }, paragraphBounds.width, paragraphBounds.height);
    paragraphBlocks[0].translation = ['第一行译文', '第二行译文', '第三行译文', '第四行译文', '第五行译文', '第六行译文'].join('\n');
    const paragraphPlacement = { region: { x: 0, y: 0, width: paragraphBounds.width / pixelRatio, height: paragraphBounds.height / pixelRatio }, displayBounds: desktopPlacement.displayBounds };
    const blankParagraph = nativeImage.createFromBitmap(Buffer.alloc(paragraphBounds.width * paragraphBounds.height * 4, 255), paragraphBounds).toDataURL();
    current.translation = { ...savedDesktop, ...paragraphBounds, id: '六行段落覆盖回归', imageData: blankParagraph, blocks: paragraphBlocks,
      placement: paragraphPlacement, layout: translationLayout(paragraphPlacement) };
    overlay.setBounds(current.translation.layout.bounds); emit();
    await overlayDriver.waitFor(`Boolean(document.querySelector('.translation-overlay')) && document.querySelector('.translation-image img')?.src === ${quoteJavaScriptString(blankParagraph)}`, '六行段落覆盖绘制');
    await overlay.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
    await overlay.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const paragraphPaint = await overlay.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
    await fs.writeFile(path.join(output, '截图翻译-六行段落覆盖.png'), paragraphPaint.toPNG());
    const paragraphText = nativeOcr ? (await recognizeWindows({ imageData: paragraphPaint.toDataURL(), sourceLanguage: 'zh-Hans' })).blocks.map(block => block.text).join('').replace(/\s/g, '') : null;
    const paragraphPixels = paragraphPaint.toBitmap(), paragraphSize = paragraphPaint.getSize(), inkBands = [];
    for (let y = 0; y < paragraphSize.height; y++) {
      let ink = 0;
      for (let x = 0; x < paragraphSize.width; x++) {
        const offset = (y * paragraphSize.width + x) * 4;
        if (paragraphPixels[offset + 3] > 200 && paragraphPixels[offset] < 160 && paragraphPixels[offset + 1] < 160 && paragraphPixels[offset + 2] < 160) ink++;
      }
      if (ink < 3) continue;
      const last = inkBands.at(-1);
      if (last && y - last.bottom <= 3) last.bottom = y; else inkBands.push({ top: y, bottom: y });
    }
    assert.equal(inkBands.length, 6, '白底实际像素应有六行文字，不能只剩一个箭头');
    if (nativeOcr) assert.match(paragraphText, /第六行译文/, '末行译文完整显示');
    report.段落覆盖像素检查 = { 文字行数: inkBands.length, 墨迹范围: inkBands, 原生OCR末行: nativeOcr ? '第六行译文' : '未验证' };
    current.translation = savedDesktop; overlay.setBounds(savedDesktop.layout.bounds); emit();
    await overlayDriver.waitFor(`document.querySelector('.translation-image img')?.src === ${quoteJavaScriptString(desktopImage)}`, '恢复单词场景');
    report.显示选中态 = [];
    for (const theme of ['dark', 'light']) {
      const appearance = defaultAppearance(); appearance.current.mode = theme;
      current.settings.prefs.appearance = appearance; emit();
      await driver.waitFor(`document.documentElement.dataset.appearance===${quoteJavaScriptString(theme)}`, '主题已应用到翻译菜单');
      await clickAction('覆盖', `${theme}主题覆盖操作结束`);
      await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      await evaluate('Promise.all(document.getAnimations().filter(animation=>animation.effect?.getTiming().iterations!==Infinity).map(animation=>animation.finished.catch(()=>{})))');
      const selected = await evaluate(`(()=>{const buttons=[...document.querySelectorAll('.translation-display button')],active=buttons.find(node=>node.getAttribute('aria-pressed')==='true');const sample=document.createElement('span');sample.style.color='var(--accent)';document.body.append(sample);const accent=getComputedStyle(sample).color;sample.remove();return {theme:document.documentElement.dataset.appearance,background:getComputedStyle(active).backgroundColor,accent,unselected:getComputedStyle(buttons[1]).backgroundColor,width:document.querySelector('.translation-mode-switch').getBoundingClientRect().width,overflow:document.querySelector('.translation-controls').scrollWidth>document.querySelector('.translation-controls').clientWidth};})()`);
      assert.equal(selected.background, selected.accent, '选中按钮使用当前主题不透明强调底色');
      assert.notEqual(selected.background, selected.unselected, '选中背景明显区别于未选中按钮');
      assert.ok(selected.width <= 50); assert.equal(selected.overflow, false);
      report.显示选中态.push(selected);
      await fs.writeFile(path.join(output, `截图翻译-${theme}-选中态.png`), (await win.webContents.capturePage()).toPNG());
    }
    await clickAction('快速翻译', '快速翻译切换操作结束');
    await driver.waitFor('document.querySelector(".translation-mode-switch")?.textContent==="深度"', '快捷切换深度后显示当前模式');
    assert.equal(calls.findLast(call => call.action === 'retry-translation').payload.options.translationMode, 'deep');
    assert.equal(current.settings.prefs.screenshotTranslation.translationMode, 'deep');
    const collapsedFeedbackCount = calls.filter(call => call.action === 'translation-content-height' && call.payload.id === current.translation.id).length;
    await clickAction('对照', '深度结果对照操作结束');
    await driver.waitFor('Boolean(document.querySelector(".translation-sources"))', '深度联网结果保留真实来源入口');
    await waitForContentHeight(height => height < 480, '收起来源时控制窗按实际内容收缩', { id: current.translation.id, after: collapsedFeedbackCount });
    report.来源收起高度 = win.getBounds().height;
    await fs.writeFile(path.join(output, '截图翻译-来源收起.png'), (await win.webContents.capturePage()).toPNG());
    const expandedFeedbackCount = calls.filter(call => call.action === 'translation-content-height' && call.payload.id === current.translation.id).length;
    await evaluate('document.querySelector(".translation-sources").open=true');
    await waitForContentHeight(height => height > report.来源收起高度, '展开来源后控制窗随来源列表增长', { id: current.translation.id, after: expandedFeedbackCount });
    report.来源展开高度 = win.getBounds().height;
    await fs.writeFile(path.join(output, '截图翻译-来源展开.png'), (await win.webContents.capturePage()).toPNG());
    const stableExpandedHeight = win.getBounds().height;
    emit(); await driver.waitFor('document.querySelector(".translation-sources")?.open===true', '同一截图状态重绘后仍保留展开来源');
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    assert.equal(win.getBounds().height, stableExpandedHeight, '窗口高度反馈后重绘不会收起来源或继续振荡');
    const recollapseFeedbackCount = calls.filter(call => call.action === 'translation-content-height' && call.payload.id === current.translation.id).length;
    await evaluate('document.querySelector(".translation-sources").open=false');
    await waitForContentHeight(height => height < stableExpandedHeight, '收起来源后控制窗缩回短文高度', { id: current.translation.id, after: recollapseFeedbackCount });
    assert.equal(await evaluate('document.querySelector(".translation-sources")?.open'), false);
    const reexpandFeedbackCount = calls.filter(call => call.action === 'translation-content-height' && call.payload.id === current.translation.id).length;
    await evaluate('document.querySelector(".translation-sources").open=true');
    await waitForContentHeight(height => height === stableExpandedHeight, '重新展开来源恢复原有高度', { id: current.translation.id, after: reexpandFeedbackCount });
    await clickAction('虚构官方译名来源', '来源打开操作结束', { selector: 'a' });
    assert.equal(calls.findLast(call => call.action === 'open-link').payload.url, 'https://example.invalid/translation');
    assert.equal(await evaluate('document.querySelector(".translation-network-switch").getAttribute("aria-pressed")'), 'true', '深度联网初始状态');
    await clickAction('联网翻译', '关闭当前深度联网并重译');
    await driver.waitFor('document.querySelector(".translation-network-switch").getAttribute("aria-pressed")==="false"', '深度联网关闭');
    await clickAction('深度翻译', '切回常规翻译操作结束');
    await driver.waitFor('document.querySelector(".translation-mode-switch")?.textContent==="快速"', '快捷切回快速');
    assert.equal(calls.findLast(call => call.action === 'retry-translation').payload.options.searchEnabled, false);
    const offNetworkBackground = await evaluate('getComputedStyle(document.querySelector(".translation-network-switch")).backgroundColor');
    await clickAction('联网翻译', '开启当前快速联网并重译');
    await driver.waitFor('document.querySelector(".translation-network-switch").getAttribute("aria-pressed")==="true"', '快速联网开启');
    assert.equal(calls.findLast(call => call.action === 'retry-translation').payload.options.searchScope, 'standard');
    await evaluate('Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))');
    assert.notEqual(await evaluate('getComputedStyle(document.querySelector(".translation-network-switch")).backgroundColor'), offNetworkBackground, '地球选中状态有明确填充');
    assert.equal(await evaluate('document.querySelector(".translation-mode-switch").textContent'), '快速');
    await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    await fs.writeFile(path.join(output, '截图翻译-快速联网.png'), (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
    await clickAction('快速翻译', '两种模式联网下切深度');
    await driver.waitFor('document.querySelector(".translation-mode-switch")?.textContent==="深度"', '深度仍联网');
    assert.equal(await evaluate('document.querySelector(".translation-network-switch").getAttribute("aria-pressed")'), 'false', '快速开关不影响深度原先的关闭值');
    await clickAction('联网翻译', '单独开启深度联网');
    await driver.waitFor('document.querySelector(".translation-network-switch").getAttribute("aria-pressed")==="true"', '深度也开启');
    await clickAction('深度翻译', '两种模式联网下切回快速');
    await driver.waitFor('document.querySelector(".translation-mode-switch")?.textContent==="快速" && Boolean(document.querySelector(".translation-sources"))', '快速联网保留来源入口');
    assert.equal(calls.findLast(call => call.action === 'retry-translation').payload.options.searchScope, 'both');
    await clickAction('联网翻译', '仅关闭快速联网');
    assert.equal(calls.findLast(call => call.action === 'retry-translation').payload.options.searchScope, 'deep');
    await clickAction('快速翻译', '再次切深度保留其联网');
    await driver.waitFor('document.querySelector(".translation-network-switch").getAttribute("aria-pressed")==="true"', '深度联网独立保持开启');
    report.翻译模式切换 = '正式菜单经隔离IPC验证：常规/深度、联网偏好、来源打开';
    await clickAction('关闭', '关闭翻译操作结束');
    await driver.waitFor('!document.querySelector(".translation-controls")', '关闭后清除图像和结果');
    await overlayDriver.waitFor('!document.querySelector(".translation-image")', '关闭后同时清除覆盖'); overlay.destroy(); overlay = null;
    win.destroy();
    // 故意提供上一次的全局模式；本次截图绑定的 mode 必须优先，避免复用窗口时串模式。
    await fixture.webContents.executeJavaScript(`(()=>{document.documentElement.style.background='#000';document.body.style.background='#000';document.body.style.color='#fff';document.querySelector('main').style.cssText='padding:20px;background:#000;color:#fff';return new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));})()`);
    const darkCaptureImage = (await fixture.webContents.capturePage()).toDataURL();
    const captureAppearance = defaultAppearance(); captureAppearance.current.mode = 'dark';
    current = { ...current, settings: { ...current.settings, prefs: { ...current.settings.prefs, appearance: captureAppearance } }, captureMode: 'explain',
      capture: { id: '固定截图预览', mode: 'translate', imageData: darkCaptureImage, width: 860, height: 690 } };
    win = new BrowserWindow({ width: 860, height: 690, show: false, webPreferences: { preload: path.join(__dirname, '../src/preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
    await win.loadFile(path.join(__dirname, '../src/renderer/index.html'), { query: { window: 'capture' } });
    await driver.waitFor('document.querySelector(".capture-help-message")?.textContent.includes("松开即翻译")', '截图翻译模式准备完成');
    const captureModeLabels = await evaluate('[...document.querySelectorAll("[data-capture-mode]")].map(button=>button.textContent.trim())');
    assert.deepEqual(captureModeLabels, ['识图', '翻译'], '框选模式切换按钮使用识图和翻译文案');
    assert.match(await evaluate('getComputedStyle(document.querySelector(".capture-surface")).cursor'), /capture-crosshair\.svg.*16 16/, '框选使用高亮白色描边光标并保持中心热点');
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".capture-help")).cursor'), 'default', '工具条保留正常指针');
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    await fs.writeFile(path.join(output, '截图翻译-黑底框选.png'), (await win.webContents.capturePage()).toPNG());
    const selectedPayload = await selectRegion();
    assert.equal(selectedPayload.mode, 'translate'); assert.equal(selectedPayload.rect.width, 270);
    assert.equal(selectedPayload.options.targetLanguage, 'zh-Hans');
    const completedCount = calls.filter(call => call.action === 'capture-done').length;
    current.captureMode = 'translate'; current.capture = { ...current.capture, id: '第二次固定截图', mode: 'explain' }; emit();
    await driver.waitFor('document.querySelector(".capture-help-message")?.textContent.includes("松开即识图")', '复用窗口切回识图');
    const visionSelection = await selectRegion();
    assert.equal(visionSelection.mode, 'explain');
    assert.equal(calls.filter(call => call.action === 'capture-done').length, completedCount + 1, '识图模式松开提交一次，无需确认');
    assert.equal(calls.findLast(call => call.action === 'capture-done').payload.mode, 'explain');
    for (const [index, targetLanguage] of ['ja', 'zh-Hans'].entries()) {
      const id = `语言切换截图-${index}`;
      current.capture = { ...current.capture, id, mode: 'translate' }; emit(); await waitForCapture(id);
      assert.equal(await evaluate('document.querySelector("select[aria-label=目标语言]").value'), index ? 'ja' : 'zh-Hans', '复用截图窗口继承上次选框已保存的语言');
      await evaluate(`document.querySelector('select[aria-label="目标语言"]').value=${quoteJavaScriptString(targetLanguage)};document.querySelector('select[aria-label="目标语言"]').dispatchEvent(new Event('change',{bubbles:true}))`);
      const selection = await selectRegion();
      assert.equal(selection.options.targetLanguage, targetLanguage, '切换语言后立即框选使用选框当前值');
      assert.equal(current.settings.prefs.screenshotTranslation.targetLanguage, targetLanguage, '框选界面的目标语言也保存为后续默认值');
    }
    current.capture = { ...current.capture, id: '语言保存失败截图', mode: 'translate' }; emit(); await waitForCapture(current.capture.id);
    failLanguageSave = true;
    await evaluate('document.querySelector("select[aria-label=目标语言]").value="ja";document.querySelector("select[aria-label=目标语言]").dispatchEvent(new Event("change",{bubbles:true}))');
    await driver.waitFor('document.querySelector(".capture-error").textContent.includes("虚构语言保存失败")', '语言偏好保存失败明确显示', { allowErrors: true });
    emit(); await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    assert.equal(await evaluate('document.querySelector("select[aria-label=目标语言]").value'), 'ja', '保存失败或随后状态推送不能撤销当前语言选择');
    assert.equal((await selectRegion()).options.targetLanguage, 'ja', '偏好保存失败时本次翻译仍使用当前选框语言');
    assert.equal(current.settings.prefs.screenshotTranslation.targetLanguage, 'zh-Hans', '保存失败不伪称已改变持久化默认值');
    failLanguageSave = false;
    await evaluate('(()=>{const select=document.querySelector("select[aria-label=目标语言]");for(const language of ["zh-Hans","ja"]){select.value=language;select.dispatchEvent(new Event("change",{bubbles:true}));}})()');
    await driver.waitFor('window.pickgloss.invoke("bootstrap").then(result=>result.value.settings.prefs.screenshotTranslation.targetLanguage==="ja")', '恢复后最新语言已保存', { allowErrors: true });
    await driver.waitFor('document.querySelector(".capture-error").hidden', '恢复保存后清除失败反馈');
    assert.equal((await selectRegion()).options.targetLanguage, 'ja', '恢复保存后仍按当前语言翻译');
    current.capture = { ...current.capture, id: '保存恢复后的新截图' }; emit(); await waitForCapture(current.capture.id);
    assert.equal(await evaluate('document.querySelector("select[aria-label=目标语言]").value'), 'ja', '新截图继承恢复保存后的最新语言');
    assert.equal(await evaluate('document.querySelector(".capture-error").hidden'), true, '新截图不继承上一轮失败反馈');
    report.语言偏好保存失败与恢复 = '失败保留选框与本次翻译语言，恢复后保存最新选择';
    assert.equal(remote.length, 0, '正式渲染器不请求外网');
    assert.equal(consoleErrors.length, 0, '正式渲染器没有脚本错误');
    report.翻译请求数 = requests.length; report.通过 = true;
    console.log(`截图翻译检查通过：${report.模式}；单次批量翻译、双模式与原图预览、语言保存失败恢复、常规/深度切换、联网来源、对照/复制/重试/长文；报告 ${output}`);
  } catch (error) {
    failure = error; report.错误 = error.message; report.错误码 = error.code;
    if (win && !win.isDestroyed()) {
      report.界面诊断 = await evaluate('({image:document.querySelector(".translation-image img")?{complete:document.querySelector(".translation-image img").complete,width:document.querySelector(".translation-image img").naturalWidth}:null,warning:document.querySelector(".translation-warning")?.textContent,status:document.querySelector(".translation-status")?.textContent,canvas:Boolean(document.querySelector("canvas"))})').catch(() => null);
    }
    report.覆盖能力 = current?.translation?.overlayAvailable;
    console.error(error.stack); console.error(JSON.stringify(report));
  }
  finally {
    clearTimeout(timeout); fixture?.destroy(); win?.destroy(); overlay?.destroy(); server?.closeAllConnections(); server?.close();
    await fs.writeFile(path.join(output, '截图翻译检查.json'), JSON.stringify(report, null, 2), 'utf8');
    app.exit(failure ? 1 : 0);
  }
});
