'use strict';
// 正式预加载与双渲染器的部分译文回归；只使用虚构图像和隔离 IPC，不联网。
const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createUiDriver } = require('./ui-driver.cjs');
const { translationOptions, TRANSLATION_LANGUAGES } = require('../src/core/translation.cjs');
const outputIndex = process.argv.indexOf('--output-dir');
const output = outputIndex >= 0 ? path.resolve(process.argv[outputIndex + 1]) : path.resolve(__dirname, '../output/verification/2026-10-31-translation-reliability/partial-ui');
app.setPath('userData', path.join(os.tmpdir(), `pickgloss-partial-ui-${process.pid}`));
app.on('window-all-closed', () => {});
const calls = [], unexpected = [], errors = [], windows = [];
const options = translationOptions({ sourceLanguage: 'en', targetLanguage: 'zh-Hans' });
const bytes = Buffer.alloc(360 * 180 * 4, 255);
for (const y of [20, 65, 110]) for (let dy = 0; dy < 4; dy++) for (let x = 60; x < 85; x++) {
  const index = ((y + dy) * 360 + x) * 4; bytes[index] = bytes[index + 1] = bytes[index + 2] = 0;
}
const current = { view: 'paste', session: null, history: [], status: {}, translationLanguages: TRANSLATION_LANGUAGES,
  settings: { text: {}, vision: {}, translation: {}, search: {}, serviceProfiles: {}, prefs: { screenshotTranslation: { ...options } } },
  translation: { id: '部分译文虚构截图', options: { ...options }, status: 'partial', method: 'windows-ocr', width: 360, height: 180,
    imageData: nativeImage.createFromBitmap(bytes, { width: 360, height: 180 }).toDataURL(), overlayAvailable: true,
    pendingIds: [2], failedCount: 1, search: { status: 'disabled', sources: [] },
    layout: { image: { left: 0, top: 0, width: 360, height: 180 }, controls: { left: 0, top: 0, width: 300, height: 350 } },
    blocks: [
      { id: 0, text: 'Open', translation: '打开', status: 'complete', x: 10, y: 10, width: 100, height: 24 },
      { id: 1, text: 'Obsidian', translation: '黑曜石', status: 'complete', x: 10, y: 55, width: 100, height: 24 },
      { id: 2, text: 'Retry', translation: '', status: 'failed', error: '虚构服务暂时不可用', x: 10, y: 100, width: 100, height: 24 },
    ] } };
function push() { for (const win of windows) win.webContents.send('pickgloss:state', current); }
ipcMain.handle('pickgloss:action', async (_event, action, payload) => {
  calls.push({ action, payload });
  if (action === 'bootstrap') return { ok: true, value: current };
  if (action === 'set-translation-options') { Object.assign(current.translation.options, payload.options); push(); }
  if (action === 'set-translation-preferences') { Object.assign(current.settings.prefs.screenshotTranslation, payload.options); push(); }
  return { ok: true };
});
app.whenReady().then(async () => {
  const timer = setTimeout(() => { console.error('部分译文界面验证超时'); app.exit(1); }, 30000);
  try {
    await fs.mkdir(output, { recursive: true });
    for (const surface of ['translation', 'translation-overlay']) {
      const win = new BrowserWindow({ width: surface === 'translation' ? 300 : 360, height: surface === 'translation' ? 400 : 180, show: false,
        webPreferences: { preload: path.resolve(__dirname, '../src/preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } });
      windows.push(win);
      win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => { unexpected.push(details.url); callback({ cancel: true }); });
      win.webContents.on('console-message', (...args) => { const details = args[1]; if (typeof details === 'object' ? details.level === 'error' : args[1] >= 2) errors.push(typeof details === 'object' ? details.message : args[2]); });
      await win.loadFile(path.resolve(__dirname, '../src/renderer/index.html'), { query: { window: surface } });
    }
    const controls = windows[0], overlay = windows[1];
    const evaluate = code => controls.webContents.executeJavaScript(code);
    const driver = createUiDriver(evaluate);
    await driver.waitFor('document.querySelector(".translation-status")?.textContent.includes("部分完成")', '部分完成状态');
    assert.equal(await evaluate('document.querySelector("button[title=复制译文]").disabled'), false, '部分结果可复制');
    assert.equal(await evaluate('/待处理|待核对/.test(document.body.textContent)'), false, '已取得的译文不应交给用户核对');
    await driver.click('重试失败内容（1）');
    await driver.waitFor('document.getElementById("app").dataset.translationBusy==="false"', '局部重试回执');
    assert.equal(calls.findLast(item => item.action === 'retry-translation').payload.pendingOnly, true);
    await driver.click('重新翻译全部');
    await driver.waitFor('document.getElementById("app").dataset.translationBusy==="false"', '全量重译回执');
    assert.equal(calls.findLast(item => item.action === 'retry-translation').payload.pendingOnly, undefined);
    await overlay.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const overlayDriver = createUiDriver(code => overlay.webContents.executeJavaScript(code));
    await overlayDriver.waitFor('Boolean(document.querySelector("canvas"))', '成功块与未完成块共同覆盖');
    const pixels = await overlay.webContents.executeJavaScript('(()=>{const ctx=document.querySelector("canvas").getContext("2d");return {complete:[...ctx.getImageData(75,21,1,1).data],failed:[...ctx.getImageData(75,111,1,1).data]}})()');
    assert.deepEqual(pixels.complete, [255, 255, 255, 255], '成功位置擦除原文');
    assert.deepEqual(pixels.failed, [0, 0, 0, 255], '失败位置保留原图内容');
    await driver.click('对照');
    await driver.waitFor('document.querySelectorAll(".translation-pair").length===3', '对照保留全部文字块');
    assert.equal(await evaluate('document.querySelectorAll(".translation-pair.needs-review").length'), 0);
    assert.equal(await evaluate('[...document.querySelectorAll(".translation-target-text")].some(node => node.textContent === "黑曜石")'), true);
    assert.equal(await evaluate('/待处理|待核对/.test(document.body.textContent)'), false);
    assert.equal(await evaluate('document.querySelector(".translation-pair.is-failed").textContent.includes("虚构服务暂时不可用")'), true);
    await evaluate('document.querySelector("[aria-label=目标语言]").value="ja";document.querySelector("[aria-label=目标语言]").dispatchEvent(new Event("change",{bubbles:true}))');
    await driver.waitFor('document.querySelector(".translation-pending-retry")?.disabled===true && document.querySelector(".translation-status").textContent.includes("语言已更改") && document.getElementById("app").dataset.translationBusy==="false"', '更换语言不能继续按旧语言局部重试');
    // 隐藏窗口先唤醒合成，再等待新一帧，避免把上一个显示模式保存成证据。
    for (const win of windows) {
      await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
      await win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    }
    await fs.writeFile(path.join(output, '部分译文对照.png'), (await controls.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
    await fs.writeFile(path.join(output, '部分译文覆盖.png'), (await overlay.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
    await evaluate('document.querySelector("[aria-label=目标语言]").value="zh-Hans";document.querySelector("[aria-label=目标语言]").dispatchEvent(new Event("change",{bubbles:true}))');
    await driver.waitFor('document.querySelector(".translation-pending-retry")?.disabled===false', '恢复本次结果语言');
    current.translation.status = 'translating'; push();
    await driver.waitFor('document.querySelector(".translation-status")?.dataset.busy==="true" && document.querySelectorAll(".translation-pair.is-failed").length===0', '自动重试期间不提前显示最终失败');
    assert.equal(await evaluate('[...document.querySelectorAll(".translation-target-text")].some(node => node.textContent === "翻译中…")'), true);
    current.translation.blocks[2] = { ...current.translation.blocks[2], translation: '重试', status: 'complete' };
    delete current.translation.blocks[2].error;
    Object.assign(current.translation, { status: 'complete', pendingIds: [], failedCount: 0 }); push();
    await driver.waitFor('document.querySelector(".translation-status")?.textContent==="本地 OCR · 完成" && !document.querySelector(".translation-pending-retry")', '恢复成功后直接完成且移除失败重试入口');
    assert.equal(await evaluate('/待处理|待核对|翻译失败|模型请求失败/.test(document.body.textContent)'), false);
    assert.equal(await evaluate('document.querySelectorAll(".translation-pair.is-failed").length'), 0);
    await controls.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    await fs.writeFile(path.join(output, '完整译文对照.png'), (await controls.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
    assert.deepEqual(unexpected, []); assert.deepEqual(errors, []);
    await fs.writeFile(path.join(output, '部分译文检查.json'), JSON.stringify({ 通过: true, 覆盖: ['局部和全量重试入口分开', '部分结果可复制', '成功位置覆盖及失败位置保留原图', '对照状态和单块错误', '语言改变后禁用旧局部重试', '自动重试期间不提前报错，成功后完整交付且没有待核对状态'], 边界: '隐藏双渲染器与虚构 IPC，不能代替实屏或真实模型验收。' }, null, 2));
    console.log(`部分译文界面检查通过：${output}`);
    clearTimeout(timer); for (const win of windows) win.destroy(); app.exit(0);
  } catch (error) { console.error(error.stack || error, errors); clearTimeout(timer); for (const win of windows) win.destroy(); app.exit(1); }
});
