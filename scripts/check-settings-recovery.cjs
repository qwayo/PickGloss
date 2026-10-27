'use strict';
// 正式预加载与隐藏渲染器的保存失败回路；不读真实设置、不注册系统快捷键、不改登录项。
const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { setTimeout: delay } = require('node:timers/promises');
const { DEFAULT_SHORTCUTS } = require('../src/core/shortcuts.cjs');
const { applySettingsFixture } = require('./settings-fixture.cjs');
const { createUiDriver } = require('./ui-driver.cjs');
const outputIndex = process.argv.indexOf('--output-dir');
const output = outputIndex >= 0 ? path.resolve(process.argv[outputIndex + 1]) : path.resolve(__dirname, '../output/verification/2026-10-27-settings-recovery');
app.setPath('userData', path.join(os.tmpdir(), `pickgloss-recovery-${process.pid}`));
app.on('window-all-closed', () => {});
let win, panelWin, failStartup = true, failShortcuts = true, closed = 0, phase = '初始化';
const calls = [], unexpected = [], consoleErrors = [];
const current = { view: 'settings', settingsSection: 'general', history: [], session: null, status: {},
  settings: { text: {}, vision: {}, translation: {}, search: {}, serviceProfiles: {}, prefs: {
    launchAtLogin: false, showOrb: true, selectionEnabled: true,
    shortcuts: { ...DEFAULT_SHORTCUTS, capture: 'Ctrl+Alt+X' },
  } } };
const push = () => win.webContents.send('pickgloss:state', current);
ipcMain.handle('pickgloss:action', async (_, action, payload = {}) => {
  calls.push({ action, payload });
  if (action === 'bootstrap') return { ok: true, value: current };
  if (action === 'save-settings') {
    await delay(90);
    if (failStartup && payload.prefs?.launchAtLogin !== undefined) return { ok: false, error: '虚构 Windows 登录项写入失败' };
    if (failShortcuts && payload.prefs?.shortcuts) return { ok: false, error: '虚构快捷键无法注册' };
    current.settings = applySettingsFixture(current.settings, payload); push();
    return { ok: true, value: current.settings };
  }
  if (action === 'open-shortcuts') { current.settingsSection = 'shortcuts'; current.view = 'settings'; push(); }
  if (action === 'open-settings') { current.settingsSection = payload.section === 'general' ? 'general' : 'service'; current.view = 'settings'; push(); }
  if (action === 'navigate') { current.view = payload.view; push(); }
  if (action === 'close') closed++;
  return { ok: true };
});
app.whenReady().then(async () => {
  const timeout = setTimeout(() => { console.error('设置恢复验证超时'); win?.destroy(); app.exit(1); }, 30000);
  try {
    await fs.mkdir(output, { recursive: true });
    win = new BrowserWindow({ width: 380, height: 670, show: false, webPreferences: {
      preload: path.resolve(__dirname, '../src/preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false,
    } });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => { unexpected.push(details.url); callback({ cancel: true }); });
    win.webContents.on('console-message', (...args) => { const details = args[1]; if (typeof details === 'object' ? details.level === 'error' : args[1] >= 2) consoleErrors.push(typeof details === 'object' ? details.message : args[2]); });
    const evaluate = code => win.webContents.executeJavaScript(code);
    const rawDriver = createUiDriver(evaluate);
    const driver = { ...rawDriver, waitFor: (expression, label, options) => rawDriver.waitFor(expression, label, { allowErrors: true, ...options }) };
    await win.loadFile(path.resolve(__dirname, '../src/renderer/index.html'), { query: { window: 'panel' } });
    await driver.waitFor('Boolean(document.querySelector("[name=launchAtLogin]"))', '常规设置出现');
    await evaluate('Promise.all(document.getAnimations().filter(animation=>animation.effect?.getTiming().iterations!==Infinity).map(animation=>animation.finished.catch(()=>{})))');
    phase = '自启动失败';
    await evaluate('window.originalPanel=document.querySelector(".panel");document.querySelector("[name=launchAtLogin]").click()');
    await driver.waitFor('[...document.querySelectorAll("[data-autosave]")].find(node=>node.dataset.autosave==="general:launchAtLogin").textContent.includes("开关已还原")', '自启动失败回滚', { allowErrors: true });
    assert.equal(await evaluate('document.querySelector("[name=launchAtLogin]").checked'), false);
    assert.equal(await evaluate('document.querySelector("[data-settings-save-issues]").hidden'), true);
    await driver.click('关闭窗口', { allowErrors: true });
    await driver.waitFor('document.querySelector("button[title=关闭窗口]")?.disabled===false', '关闭动作回执完成');
    assert.equal(closed, 1, '系统开关失败后能直接关闭，无需手动拨回');
    failStartup = false;
    phase = '节点保留';
    await evaluate('window.originalPanel=document.querySelector(".panel");window.originalOrb=document.querySelector("[name=showOrb]");window.originalOrb.click()');
    await driver.waitFor('document.querySelector("[data-settings-save-summary]").textContent==="已自动保存"', '开关成功保存');
    assert.equal(current.settings.prefs.showOrb, false);
    assert.equal(await evaluate('window.originalPanel===document.querySelector(".panel") && window.originalOrb===document.querySelector("[name=showOrb]")'), true, '保存回声保留面板和控件节点');
    assert.equal(await evaluate('document.querySelectorAll(".settings-navigation [role=tab] svg").length'), 4);
    assert.deepEqual(await evaluate('[...document.querySelectorAll(".settings-navigation [role=tab]")].map(node=>node.textContent)'), ['常规', 'AI', '外观', '快捷键']);
    assert.equal(await evaluate('document.querySelector(".general-settings h1").textContent'), '常规设置', '精简仅作用于导航，不改页面标题');
    phase = '识图偏好';
    await evaluate('document.querySelector("[name=captureExplainMode]").value="prompt";document.querySelector("[name=captureExplainMode]").dispatchEvent(new Event("change",{bubbles:true}))');
    await driver.waitFor('document.querySelector("[data-settings-save-summary]").textContent==="已自动保存"', '识图提示词模式已保存');
    assert.equal(current.settings.prefs.captureExplainMode, 'prompt');
    assert.equal(await evaluate('document.querySelector("[name=captureExplainMode]").value'), 'prompt');
    assert.equal(await evaluate('Boolean(document.querySelector("[name=searchEnabled], [name=searchScope]"))'), false, '设置页不再提供翻译联网控件');
    await evaluate('document.querySelector("[name=captureExplainMode]").scrollIntoView({block:"center"})');
    await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    await fs.writeFile(path.join(output, '识图模式偏好.png'), (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
    phase = '快捷键恢复';
    await evaluate('[...document.querySelectorAll(".settings-navigation button")].find(node=>node.textContent==="快捷键").click()');
    await driver.waitFor('document.querySelector("[data-settings-section=shortcuts]").hidden===false', '快捷键页');
    await evaluate('document.querySelector(".shortcut-actions button").click()');
    await driver.waitFor('document.querySelector("[data-settings-save-issues]").textContent.includes("快捷键未保存")', '快捷键保存失败有恢复入口');
    await evaluate('document.querySelector(".settings-save-issue button").click()');
    await driver.waitFor('Boolean([...document.querySelectorAll(".shortcut-actions button")].find(node=>node.title==="放弃未保存的快捷键修改"))', '查看失败后有恢复操作', { allowErrors: true });
    await evaluate('[...document.querySelectorAll(".settings-save-issue button")].find(node=>node.textContent==="恢复已保存值").click()');
    await driver.waitFor('document.querySelector("[data-settings-save-issues]").hidden && document.querySelector("[data-field=shortcut-capture]").textContent.replace(/\\s+/g, "").includes("Ctrl+Alt+X")', '恢复快捷键原值');
    await driver.click('关闭窗口'); await driver.waitFor('document.querySelector("button[title=关闭窗口]")?.disabled===false', '快捷键恢复关闭回执');
    assert.equal(closed, 2, '快捷键失败恢复后可以关闭');
    // 本页恢复按钮也必须清除共享保存队列中的失败。
    await evaluate('document.querySelector(".shortcut-actions button").click()');
    await driver.waitFor('!document.querySelector("[data-settings-save-issues]").hidden', '再次失败');
    await evaluate('[...document.querySelectorAll(".shortcut-actions button")].find(node=>node.title==="放弃未保存的快捷键修改").click()');
    await driver.waitFor('document.querySelector("[data-settings-save-issues]").hidden', '本页恢复同步解除失败');
    await driver.click('关闭窗口'); await driver.waitFor('document.querySelector("button[title=关闭窗口]")?.disabled===false', '再次关闭回执'); assert.equal(closed, 3);
    current.view = 'paste'; push();
    phase = '截图入口';
    await driver.waitFor('Boolean(document.querySelector(".recognition-body form"))', '空会话入口');
    await driver.click('AI 识图'); assert.equal(calls.findLast(item => item.action === 'start-capture').payload.mode, 'explain');
    await driver.waitFor('[...document.querySelectorAll("button")].find(node=>node.textContent==="OCR 翻译")?.disabled===false', '首次截图入口调用结束');
    await driver.click('OCR 翻译'); assert.equal(calls.findLast(item => item.action === 'start-capture').payload.mode, 'translate');
    await fs.writeFile(path.join(output, '空会话入口.png'), (await win.webContents.capturePage()).toPNG());
    current.view = 'preview'; current.settings.vision = { baseUrl: 'https://vision.invalid/v1', model: '虚构识图模型' };
    current.session = { id: '提示词图片', kind: 'image', note: '', activeMode: 'visual', webSearchEnabled: false,
      imageData: nativeImage.createFromBitmap(Buffer.alloc(40 * 40 * 4, 255), { width: 40, height: 40 }).toDataURL(),
      threads: { visual: { status: 'idle', messages: [], draft: '' } } }; push();
    await driver.waitFor('Boolean(document.querySelector("[data-field=image-note]"))', '识图提示词输入');
    const beforePrompt = calls.length;
    await evaluate('document.querySelector("[data-field=image-note]").value="请描述图片颜色";document.querySelector("[data-field=image-note]").dispatchEvent(new Event("input",{bubbles:true}))');
    await driver.click('开始识图');
    const promptDeadline = Date.now() + 3000;
    while (!calls.slice(beforePrompt).some(item => item.action === 'start-explanation') && Date.now() < promptDeadline) await delay(10);
    const promptActions = calls.slice(beforePrompt).filter(item => ['set-note', 'start-explanation'].includes(item.action));
    assert.deepEqual(promptActions.map(item => item.action), ['set-note', 'start-explanation']);
    assert.equal(promptActions[0].payload.note, '请描述图片颜色');
    assert.equal(promptActions[1].payload.mode, 'visual');
    await driver.waitFor('[...document.querySelectorAll("button")].some(node=>node.textContent==="开始识图"&&!node.disabled)', '识图请求回执完成后再切换页面');
    await fs.writeFile(path.join(output, '识图提示词预览.png'), (await win.webContents.capturePage()).toPNG());
    phase = '菜单';
    // 正式菜单使用独立窗口，避免在带图片的面板上导航成另一种 surface。
    panelWin = win;
    win = new BrowserWindow({ width: 380, height: 670, show: false, webPreferences: {
      preload: path.resolve(__dirname, '../src/preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false,
    } });
    win.webContents.on('console-message', (...args) => { const details = args[1]; if (typeof details === 'object' ? details.level === 'error' : args[1] >= 2) consoleErrors.push(typeof details === 'object' ? details.message : args[2]); });
    await win.loadFile(path.resolve(__dirname, '../src/renderer/index.html'), { query: { window: 'menu' } });
    await driver.waitFor('Boolean(document.querySelector(".quick-menu"))', '悬浮球菜单');
    assert.equal(await evaluate('Boolean(document.querySelector("[data-menu-command=toggle-pin], [data-menu-command=toggle-wide]"))'), false);
    assert.deepEqual(unexpected, []); assert.deepEqual(consoleErrors, []);
    await fs.writeFile(path.join(output, '设置恢复检查.json'), JSON.stringify({ 通过: true,
      覆盖: ['自启动失败回滚且可关闭', '保存回声保留节点', '快捷键顶部及本页恢复可关闭', '两个入口指定模式', '移除菜单两行', '联网不在设置页控制', '识图提示词先保存再请求'],
      证据范围: '正式预加载及隐藏 Electron；虚构 IPC 故障，无真实登录项/全局快捷键写入', 调用数量: calls.length }, null, 2));
    console.log(`设置恢复及截图入口检查通过：${output}`);
    clearTimeout(timeout); win.destroy(); panelWin?.destroy(); app.exit(0);
  } catch (error) { console.error(phase, error.stack || error, consoleErrors); clearTimeout(timeout); win?.destroy(); panelWin?.destroy(); app.exit(1); }
});
