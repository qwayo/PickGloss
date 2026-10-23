'use strict';
// 真实正式渲染器与隔离存储；显示、声音与全局按键均使用替身，不干扰用户桌面。
const { quoteJavaScriptString } = require('./javascript-string.cjs');
const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const rootOption = process.argv.indexOf('--app-root'), outOption = process.argv.indexOf('--output-dir');
const sourceRoot = rootOption >= 0 ? path.resolve(process.argv[rootOption + 1]) : path.resolve(__dirname, '..');
const output = outOption >= 0 ? path.resolve(process.argv[outOption + 1]) : path.join(__dirname, '../output/verification/ui-refinement-20261016/ui');
const { createStore } = require(path.join(sourceRoot, 'src/core/store.cjs'));
const { createDesktop } = require(path.join(sourceRoot, 'src/windows/desktop.cjs'));
const { createShortcutController } = require(path.join(sourceRoot, 'src/core/shortcuts.cjs'));
const { queryHistory } = require(path.join(sourceRoot, 'src/core/history.cjs'));
app.setPath('userData', path.join(os.tmpdir(), `pickgloss-refinement-${process.pid}`));
const showCalls = [], calls = [], errors = [], records = [], dates = new Map();
BrowserWindow.prototype.show = function () { showCalls.push({ id: this.id, type: 'show' }); };
BrowserWindow.prototype.showInactive = function () { showCalls.push({ id: this.id, type: 'showInactive' }); };
BrowserWindow.prototype.focus = function () {};
let desktop, controller, store, panel, fixture, failSave = false, failRename = false;
const evaluate = source => panel.webContents.executeJavaScript(source);
async function until(predicate, label) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(15); }
  throw Error(`等待${label}超时`);
}
async function click(win, selector) {
  await win.webContents.executeJavaScript(`(()=>{const node=document.querySelector(${quoteJavaScriptString(selector)});if(!node||!node.getClientRects().length||node.closest('[hidden]')||node.disabled)throw Error('操作目标不可用：'+${quoteJavaScriptString(selector)});node.click()})()`);
}
async function input(selector, value) {
  await evaluate(`(()=>{const node=document.querySelector(${quoteJavaScriptString(selector)});node.focus();node.value=${quoteJavaScriptString(value)};node.dispatchEvent(new Event('input',{bubbles:true}));})()`);
}
async function screenshot(win, filename) {
  await win.webContents.executeJavaScript(`Promise.all(document.getAnimations().filter(item=>item.effect?.getTiming().iterations!==Infinity).map(item=>item.finished.catch(()=>{})))`);
  // 隐藏合成器首张复制偶尔仍是旧视图；取连续相同像素的静态帧再归档，不改变产品就绪协议。
  let previous;
  for (let attempt = 0; attempt < 6; attempt++) {
    await win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    try {
      const png = (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG();
      if (previous?.equals(png)) { await fs.writeFile(path.join(output, filename), png); return; }
      previous = png;
    } catch (error) { if (attempt === 5) throw error; await delay(60); }
  }
  throw Error(`隐藏静态取证画面未稳定：${filename}`);
}
function emit() { desktop?.broadcast(fixture); }
async function history(query = fixture.historyQuery || '', savedOnly = fixture.historySavedOnly || false) {
  const entries = (await store.listSessions()).map(item => ({ ...item, lastActivityAt: dates.get(item.id) || item.lastActivityAt }));
  fixture.historyQuery = query; fixture.historySavedOnly = savedOnly;
  fixture.history = queryHistory(entries, { query, savedOnly });
}
async function handle(action, payload = {}) {
  calls.push({ action, payload });
  if (action === 'bootstrap') return { ...fixture, pinFeedback: null, pinFeedbackBaseline: fixture.pinFeedback?.id || null };
  if (action === 'menu') return desktop.menu(payload);
  if (action === 'menu-ready') return desktop.menuReady(payload);
  if (action === 'menu-close') return desktop.closeMenu(payload);
  if (action === 'shortcut-recording') { await controller.setRecording(payload.active); return controller.snapshot(); }
  if (action === 'shortcut-command') {
    if (payload.command === 'toggle-pin') return handle('pin', { pinned: !fixture.pinned });
    if (payload.command === 'toggle-wide') return handle('wide', { wide: !fixture.wide });
    if (payload.command === 'history') return handle('open-history');
    if (payload.command === 'appearance') return handle('open-appearance');
    if (payload.command === 'paste') return handle('navigate', { view: 'paste' });
    throw Error('此隔离检查不运行系统操作');
  }
  if (action === 'pin') { fixture.pinned = payload.pinned; desktop.setPinned(payload.pinned); fixture.pinFeedback = { id: randomUUID(), enabled: payload.pinned }; }
  else if (action === 'wide') { fixture.wide = payload.wide; desktop.setWide(payload.wide); }
  else if (['open-settings', 'open-appearance', 'open-shortcuts'].includes(action)) { fixture.view = 'settings'; fixture.settingsSection = { 'open-settings': 'service', 'open-appearance': 'appearance', 'open-shortcuts': 'shortcuts' }[action]; }
  else if (action === 'save-settings') {
    if (failSave) throw Error('隔离检查：设置保存失败');
    const persist = () => store.saveSettings(payload);
    fixture.settings = payload.prefs?.shortcuts ? await controller.apply(payload.prefs.shortcuts, persist) : await controller.save(persist);
    desktop.setAppearance(fixture.settings.prefs.appearance);
  } else if (action === 'open-history') { fixture.view = 'history'; await history(); }
  else if (action === 'search-history') { await history(payload.query, payload.savedOnly); }
  else if (action === 'refresh-history') await history();
  else if (action === 'rename-session') { if (failRename) throw Error('隔离检查：改名保存失败'); await store.updateSession(payload.id, { title: payload.title }); await history(); }
  else if (action === 'favorite') { await store.updateSession(payload.id, { saved: payload.saved }); if (fixture.session?.id === payload.id) fixture.session = await store.getSession(payload.id); await history(); }
  else if (action === 'open-session') { fixture.session = await store.getSession(payload.id); fixture.view = 'explain'; }
  else if (action === 'navigate') fixture.view = payload.view;
  else if (action === 'set-draft') fixture.session = await store.updateSession(payload.id, { threads: { [payload.mode]: { draft: payload.draft } } });
  else throw Error(`隔离检查不允许：${action}`);
  if (!['bootstrap', 'shortcut-recording'].includes(action)) desktop.closeMenu();
  emit(); return fixture.settings;
}
ipcMain.handle('pickgloss:action', async (event, action, payload) => {
  if (!desktop.authorize(event, action)) return { ok: false, error: '此测试窗口未授权' };
  try { const value = await handle(action, payload); return { ok: true, value: action === 'bootstrap' ? desktop.stateFor(event, value) : value }; }
  catch (error) { return { ok: false, error: error.message }; }
});
app.whenReady().then(async () => {
  const timeout = setTimeout(() => { console.error('界面精修检查超时'); desktop?.dispose(); app.exit(1); }, 60000);
  try {
    await fs.mkdir(output, { recursive: true });
    store = createStore({ directory: path.join(app.getPath('userData'), 'data') }); await store.init();
    await store.saveSettings({ text: { baseUrl: 'http://127.0.0.1/v1', model: '本地阅读' } });
    const seeds = [
      ['从小习惯理解复利', 'compound', '这里的 compound 表示逐渐累积、产生叠加效果。每一次小变化都在为下一次蓄力。', 'Microsoft Edge', 0, true],
      ['为什么模型需要上下文', 'context window', '上下文帮助模型理解这次提问的范围，独立问题不携带其他解释模式的对话。', 'Microsoft Word', 0, false],
      ['阅读笔记：可逆操作与清楚的状态反馈', 'reversible interaction', '可逆操作让人放心尝试；状态应留在对象旁，错误发生时保留当前输入和位置。', 'Microsoft Edge', 1, true],
      ['长标题在小窗内也应保持清楚，不需要缩小字体来容纳全部文字', 'hierarchy', '主次层级来自内容的重要性。标题、摘要、来源与时间各有自己的位置。', 'PDF 阅读器', 9, false],
    ];
    for (const [title, text, answer, source, days, saved] of seeds) {
      const item = await store.createSession({ title, text, context: '虚构的固定阅读材料。', source: { app: source, title: '阅读材料', method: '预制材料' }, saved, threads: { context: { status: 'done', draft: '', messages: [{ id: randomUUID(), role: 'assistant', content: answer, status: 'complete' }] }, independent: { status: 'idle', draft: '', messages: [] }, visual: { status: 'idle', draft: '', messages: [] } } });
      records.push(item); dates.set(item.id, new Date(Date.now() - days * 86400000).toISOString());
    }
    fixture = { view: 'explain', session: records[0], settings: await store.getSettings(), settingsSection: 'service', wide: false, pinned: false, pinFeedback: null, status: {}, history: [] };
    desktop = createDesktop({ onAction() {}, onSelection() {}, onStatus(patch) { Object.assign(fixture.status, patch); if (typeof patch.wide === 'boolean') fixture.wide = patch.wide; emit(); } });
    controller = createShortcutController({ isolated: true, globalShortcut: { register() { throw Error('禁止系统注册'); }, unregister() { throw Error('禁止系统注销'); } }, onCommand() {}, onStatus(value) { fixture.status.shortcuts = value; emit(); } });
    await controller.apply(fixture.settings.prefs.shortcuts);
    desktop.restoreWindowState(fixture.settings.prefs.windowGeometry); desktop.setAppearance(fixture.settings.prefs.appearance); desktop.setWide(false);
    panel = BrowserWindow.getAllWindows()[0]; panel.webContents.setBackgroundThrottling(false);
    panel.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
    await until(() => evaluate(`Boolean(document.querySelector('.panel'))`), '正式界面');
    await evaluate(`(()=>{window.soundCount=0;window.Audio=class{play(){window.soundCount++;return Promise.resolve()}};})()`);
    assert.equal(await evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--paper').trim()`), '#252525');
    await click(panel, '[aria-label="置顶窗口"]');
    await until(() => evaluate(`document.querySelector('.panel').classList.contains('is-pinned')`), '置顶描边');
    assert.equal(await evaluate('window.soundCount'), 1);
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('.panel-footer .starred .icon')).fill`), 'rgb(242, 193, 79)');
    await click(panel, '.panel-footer [aria-label="取消收藏"]');
    await until(() => evaluate(`!document.querySelector('.panel-footer .starred')`), '取消星形填充');
    await click(panel, '.panel-footer [aria-label="收藏当前会话"]');
    await until(() => evaluate(`Boolean(document.querySelector('.panel-footer .starred'))`), '点击收藏后黄色实心星');
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('.panel-footer .starred .icon')).fill`), 'rgb(242, 193, 79)');
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('.panel'),'::after').borderTopWidth`), '2px');
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('.panel')).borderColor`), 'rgb(220, 135, 61)');
    emit(); await evaluate('Promise.resolve()'); assert.equal(await evaluate('window.soundCount'), 1, '普通推送不重复声音');
    await screenshot(panel, '炭黑小窗-置顶.png');
    assert.equal(BrowserWindow.getAllWindows().some(win => win.webContents.getURL().includes('pin-glow.html')), false, '置顶柔光不再创建第二扇透明窗');
    assert.ok(await evaluate(`getComputedStyle(document.querySelector('.panel'),'::after').boxShadow.includes('inset')`));
    await click(panel, '[aria-label="取消置顶"]'); await until(() => evaluate(`!document.querySelector('.panel').classList.contains('is-pinned')`), '取消描边');
    assert.equal(await evaluate('window.soundCount'), 1);
    desktop.menu({ source: 'panel' });
    await until(() => BrowserWindow.getAllWindows().some(win => win.webContents.getURL().includes('window=menu')), '菜单窗口创建');
    const menu = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('window=menu')); menu.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
    await until(() => menu.webContents.executeJavaScript(`Boolean(document.querySelector('.quick-menu'))&&document.querySelector('.quick-menu').style.opacity==='1'`), '菜单就绪');
    assert.equal(fixture.status.menuOpen, true);
    assert.equal(await menu.webContents.executeJavaScript(`document.querySelectorAll('.quick-menu-item').length`), 11);
    await screenshot(menu, '炭黑快捷菜单.png');
    await menu.webContents.executeJavaScript(`document.querySelector('.menu-surface').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`);
    await until(() => !fixture.status.menuOpen && calls.some(call => call.action === 'menu-close' && call.payload.finished), '外部区域关闭及动画确认');
    desktop.menu({ source: 'panel' });
    await until(() => fixture.status.menuOpen, '再次打开菜单');
    await click(menu, '[data-menu-command="shortcuts"]');
    await until(() => evaluate(`document.querySelector('[data-settings-section="shortcuts"]')?.hidden===false`), '快捷键入口');
    await click(panel, '[data-field="shortcut-history"]');
    await until(() => evaluate(`document.querySelector('[data-field="shortcut-history"]').getAttribute('aria-pressed')==='true'`), '开始录制');
    await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'h',code:'KeyH',ctrlKey:true,altKey:true,bubbles:true,cancelable:true}))`);
    assert.equal(controller.snapshot().recording, true, '按下录制键时不提前重新注册');
    await evaluate(`document.dispatchEvent(new KeyboardEvent('keyup',{key:'h',code:'KeyH',ctrlKey:true,altKey:true,bubbles:true,cancelable:true}))`);
    await until(() => !controller.snapshot().recording, '松开录制键后恢复');
    await click(panel, '.shortcut-actions .primary');
    await until(async () => (await store.getSettings()).prefs.shortcuts.history === 'Ctrl+Alt+H', '组合键写盘');
    await click(panel, '[data-field="shortcut-appearance"]');
    await until(() => evaluate(`document.querySelector('[data-field="shortcut-appearance"]').getAttribute('aria-pressed')==='true'`), '第二项录制');
    await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'h',code:'KeyH',ctrlKey:true,altKey:true,bubbles:true,cancelable:true}))`);
    assert.match(await evaluate(`document.querySelector('.shortcut-notice').textContent`), /已用于/);
    await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true,cancelable:true}))`);
    await until(() => !controller.snapshot().recording, 'Esc取消录制');
    await click(panel, '[data-field="shortcut-history"]'); await until(() => controller.snapshot().recording, '失败保存前录制');
    await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'j',code:'KeyJ',ctrlKey:true,altKey:true,bubbles:true,cancelable:true}));document.dispatchEvent(new KeyboardEvent('keyup',{key:'j',code:'KeyJ',ctrlKey:true,altKey:true,bubbles:true,cancelable:true}))`);
    await until(() => !controller.snapshot().recording, '录制完成'); failSave = true;
    await click(panel, '.shortcut-actions .primary'); await until(() => evaluate(`document.querySelector('.shortcut-notice').classList.contains('is-error')`), '保存失败反馈');
    assert.match(await evaluate(`document.querySelector('[data-field="shortcut-history"]').textContent`), /J/);
    assert.equal((await store.getSettings()).prefs.shortcuts.history, 'Ctrl+Alt+H'); failSave = false;
    await click(panel, '.shortcut-actions .primary'); await until(async () => (await store.getSettings()).prefs.shortcuts.history === 'Ctrl+Alt+J', '重试保存');
    await evaluate(`document.querySelector('[data-scroll="body"]').scrollTop=0`); await screenshot(panel, '小窗快捷键设置.png');
    await evaluate(`document.querySelector('[data-scroll="body"]').scrollTop=99999`); await screenshot(panel, '小窗快捷键设置-底部.png');
    assert.equal(await evaluate(`(()=>{const save=document.querySelector('.shortcut-actions .primary').getBoundingClientRect();return save.bottom<document.querySelector('.panel-footer').getBoundingClientRect().top&&save.top>document.querySelector('.panel-bar').getBoundingClientRect().bottom})()`), true, '小窗设置底部保存可达');
    fixture.wide = true; desktop.setAppearance({ ...fixture.settings.prefs.appearance, reducedMotion: true }); desktop.setWide(true); emit();
    await until(() => evaluate(`document.querySelector('.panel').classList.contains('reading-layout')`), '宽版设置');
    await evaluate(`document.querySelector('[data-scroll="body"]').scrollTop=0`); await screenshot(panel, '阅读视图快捷键设置.png');
    await handle('open-history'); await until(() => evaluate(`document.querySelectorAll('.history-item').length===4`), '历史列表');
    assert.equal(await evaluate(`document.querySelectorAll('.history-day').length`), 3);
    assert.equal(await evaluate(`document.querySelectorAll('.history-icon').length`), 0, '会话左侧不再显示图标');
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('.history-star.starred .icon')).fill`), 'rgb(242, 193, 79)');
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('.history-tools')).backgroundColor`), 'rgba(0, 0, 0, 0)');
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('.history-search')).backgroundColor`), 'rgba(0, 0, 0, 0)');
    await screenshot(panel, '炭黑会话历史.png');
    for (const mode of ['dark', 'light']) {
      fixture.settings = await store.saveSettings({ prefs: { appearance: { ...fixture.settings.prefs.appearance, current: { ...fixture.settings.prefs.appearance.current, mode, material: 'glass' } } } });
      desktop.setAppearance(fixture.settings.prefs.appearance); emit();
      await until(() => evaluate(`document.documentElement.dataset.appearance===${quoteJavaScriptString(mode)}`), '搜索区主题同步');
      assert.equal(await evaluate(`getComputedStyle(document.querySelector('.history-tools')).backgroundColor`), 'rgba(0, 0, 0, 0)');
      await screenshot(panel, mode === 'dark' ? '历史搜索-炭黑磨砂.png' : '历史搜索-暖白磨砂.png');
    }
    fixture.settings = await store.saveSettings({ prefs: { appearance: { ...fixture.settings.prefs.appearance, current: { ...fixture.settings.prefs.appearance.current, mode: 'dark', material: 'solid' } } } });
    desktop.setAppearance(fixture.settings.prefs.appearance); emit();
    await click(panel, '.filter-tabs button:nth-child(2)'); await until(() => evaluate(`document.querySelectorAll('.history-item').length===2`), '收藏筛选');
    await click(panel, '.filter-tabs button:first-child'); await input('[data-field="history-search"]', '蓄力');
    await until(() => evaluate(`document.querySelectorAll('.history-item').length===1`), '回答内容搜索');
    await input('[data-field="history-search"]', ''); await until(() => evaluate(`document.querySelectorAll('.history-item').length===4`), '清除搜索');
    const row = `[data-history-id="${records[0].id}"]`;
    await click(panel, `${row} [aria-label="修改标题"]`); await input(`[data-field="history-title-${records[0].id}"]`, '复利：每天一点进步'); failRename = true;
    await click(panel, `${row} .history-rename button[type="submit"]`); await until(() => evaluate(`Boolean(document.querySelector('.inline-error:not(:empty)'))`), '改名失败');
    assert.equal(await evaluate(`document.querySelector('[data-field="history-title-${records[0].id}"]').value`), '复利：每天一点进步'); failRename = false;
    await click(panel, `${row} .history-rename button[type="submit"]`); await until(async () => (await store.getSession(records[0].id)).title === '复利：每天一点进步', '改名重试');
    await click(panel, `${row} [aria-label="移到回收站"]`); await until(() => evaluate(`Boolean(document.querySelector('.delete-confirm'))`), '回收站确认');
    await screenshot(panel, '会话历史-回收站确认.png');
    await click(panel, `${row} .delete-confirm button:first-child`);
    fixture.settings = await store.saveSettings({ prefs: { appearance: { ...fixture.settings.prefs.appearance, current: { ...fixture.settings.prefs.appearance.current, mode: 'light' } } } }); desktop.setAppearance(fixture.settings.prefs.appearance); emit();
    await screenshot(panel, '暖白会话历史.png');
    fixture.wide = false; desktop.setAppearance({ ...fixture.settings.prefs.appearance, reducedMotion: true }); desktop.setWide(false); emit();
    await until(() => evaluate(`!document.querySelector('.panel').classList.contains('reading-layout')`), '小窗历史');
    await screenshot(panel, '小窗会话历史.png');
    assert.ok(await evaluate(`document.querySelector('.history-title').getBoundingClientRect().top`) < 240, '小窗首条会话不被管理头部挤到下半屏');
    await evaluate(`document.querySelector('[data-scroll="body"]').scrollTop=99999`); await screenshot(panel, '小窗会话历史-底部.png');
    await input('[data-field="history-search"]', '不存在的固定验证关键词'); await until(() => evaluate(`Boolean(document.querySelector('.history-page .empty'))`), '搜索空态');
    await evaluate(`document.querySelector('[data-scroll="body"]').scrollTop=0`); await screenshot(panel, '小窗会话历史-搜索空态.png');
    await click(panel, '.history-page .empty .secondary'); await until(() => evaluate(`document.querySelectorAll('.history-item').length===4`), '空态清除搜索');
    await panel.webContents.reload(); await until(() => evaluate(`document.querySelectorAll('.history-item').length===4`), '历史重载');
    await handle('open-shortcuts'); await until(() => evaluate(`document.querySelector('[data-settings-section="shortcuts"]')?.hidden===false`), '快捷键重载');
    assert.match(await evaluate(`document.querySelector('[data-field="shortcut-history"]').textContent`), /J/);
    assert.equal(BrowserWindow.getAllWindows().every(win => !win.isVisible()), true); assert.deepEqual(errors, []);
    await fs.writeFile(path.join(output, '界面精修检查.json'), JSON.stringify({ 通过: true, 源码位置: sourceRoot, 隐藏窗口: true, 置顶边框与声音事件: true, 外部关闭菜单: true, 录制松键后恢复: true, 重复组合拒绝: true, 快捷键保存失败保留与重载: true, 历史分组搜索收藏改名失败保留与取消删除: true, 未注册系统热键: true, 未播放真实声音: true, 未读取真实屏幕: true, 显示调用由替身拦截次数: showCalls.length }, null, 2));
    await controller.dispose(); clearTimeout(timeout); desktop.dispose(); console.log('界面精修：置顶、菜单外部关闭、快捷键录制与保存读回、历史完整流程通过。'); app.exit(0);
  } catch (error) { console.error(error); console.error(errors); if (panel && !panel.isDestroyed()) console.error(await evaluate('document.body.innerText')); clearTimeout(timeout); desktop?.dispose(); app.exit(1); }
});
