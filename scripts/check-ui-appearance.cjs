'use strict';
// 隐藏的正式渲染器与原生窗口，使用真实设置存储、真实 preload 和虚构会话。
const { quoteJavaScriptString } = require('./javascript-string.cjs');
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { setTimeout: delay } = require('node:timers/promises');
const rootIndex = process.argv.indexOf('--app-root');
const sourceRoot = rootIndex >= 0 ? path.resolve(process.argv[rootIndex + 1]) : path.resolve(__dirname, '..');
const { createStore } = require(path.join(sourceRoot, 'src/core/store.cjs'));
const { createDesktop } = require(path.join(sourceRoot, 'src/windows/desktop.cjs'));
const directory = path.join(os.tmpdir(), `pickgloss-ui-check-${process.pid}`);
const outputIndex = process.argv.indexOf('--output-dir');
const output = outputIndex >= 0 ? path.resolve(process.argv[outputIndex + 1]) : path.join(__dirname, '../output/verification/ui-theme-motion-20261016');
app.setPath('userData', directory);
let desktop, win, store, fixture, failSave = false;
const consoleErrors = [], calls = [], observations = [];
const evaluate = source => win.webContents.executeJavaScript(source);
async function waitFor(predicate, label) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(15); }
  throw Error(`等待${label}超时：${await evaluate('document.body.innerText')}`);
}
const ready = () => waitFor(() => evaluate(`Boolean(document.querySelector('.panel'))`), '正式界面');
async function click(selector) { await evaluate(`(()=>{const node=document.querySelector(${quoteJavaScriptString(selector)});if(!node||!node.getClientRects().length||node.closest('[hidden]')||node.disabled)throw Error('操作目标不可见或禁用');node.click();})()`); }
async function input(selector, value) { await evaluate(`(()=>{const node=document.querySelector(${quoteJavaScriptString(selector)});if(!node||!node.getClientRects().length||node.closest('[hidden]'))throw Error('输入目标不可见');node.focus();node.value=${quoteJavaScriptString(value)};node.dispatchEvent(new Event('input',{bubbles:true}));})()`); }
async function shot(name) {
  await evaluate(`Promise.all(document.getAnimations().filter(animation=>animation.effect?.getTiming().iterations!==Infinity).map(animation=>animation.finished.catch(()=>{})))`);
  await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  await fs.writeFile(path.join(output, name), (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
}
async function centeredTabs(selector, label) {
  const geometry = await evaluate(`(()=>{const tabs=document.querySelector(${quoteJavaScriptString(selector)}),box=tabs.getBoundingClientRect(),buttons=[...tabs.querySelectorAll('[role="tab"]')];return {width:box.width,items:buttons.map(node=>{const r=node.getBoundingClientRect();return {left:r.left-box.left,right:box.right-r.right,width:r.width,align:getComputedStyle(node).textAlign,overflow:node.scrollWidth>node.clientWidth}})}})()`);
  assert.equal(geometry.items.length,4,label);
  for (const item of geometry.items) { assert.ok(Math.abs(item.width-geometry.width/4)<1,label); assert.equal(item.align,'center',label); assert.equal(item.overflow,false,label); }
  assert.ok(Math.abs(geometry.items[0].left-geometry.items[3].right)<1,label);
  observations.push({ 检查: label, 布局: geometry });
}
async function picker(selector, name) {
  assert.equal(await evaluate(`CSS.supports('appearance','base-select')`),true,'当前 Electron 支持原生主题选择器');
  await win.webContents.executeJavaScript(`(()=>{const node=document.querySelector(${quoteJavaScriptString(selector)});node.scrollIntoView({block:'center'});node.focus();node.showPicker()})()`, true);
  await waitFor(()=>evaluate(`document.querySelector(${quoteJavaScriptString(selector)}).matches(':open')`),'主题选择器展开');
  await shot(name);
  win.webContents.debugger.attach('1.3');
  try {
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  } finally { win.webContents.debugger.detach(); }
  await waitFor(()=>evaluate(`!document.querySelector(${quoteJavaScriptString(selector)}).matches(':open')`),'Esc 收起选择器');
  assert.equal(calls.includes('close'),false,'Esc 只收起选择器，不关闭设置');
}
async function keyboardSelectCaptureMode() {
  await win.webContents.executeJavaScript(`document.querySelector('[name="captureDefaultMode"]').showPicker()`,true);
  win.webContents.debugger.attach('1.3');
  try {
    for (const [key,code,virtualKey] of [['ArrowDown','ArrowDown',40],['Enter','Enter',13]]) {
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode:virtualKey});
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode:virtualKey});
    }
  } finally { win.webContents.debugger.detach(); }
  await waitFor(async()=>(await store.getSettings()).prefs.captureDefaultMode==='translate','键盘选中翻译并自动保存');
  assert.equal(await evaluate(`document.querySelector('[name="captureDefaultMode"]').value`),'translate');
  observations.push({ 检查: '原生选择器键盘选项触发自动保存，Esc 仅收起弹层', 通过: true });
}
async function emit() { desktop.broadcast(fixture); }
async function handle(action, payload = {}) {
  calls.push(action);
  if (action === 'bootstrap') return fixture;
  if (action === 'wide') { fixture.wide = payload.wide; desktop.setWide(payload.wide); }
  else if (action === 'save-settings') {
    if (failSave) throw Error('隔离验证的设置写入失败');
    fixture.settings = await store.saveSettings(payload); desktop.setAppearance(fixture.settings.prefs.appearance);
  } else if (action === 'set-draft') {
    fixture.session = await store.updateSession(payload.id, { threads: { [payload.mode]: { draft: payload.draft } } });
  } else if (action === 'set-mode') fixture.session = await store.updateSession(payload.id, { activeMode: payload.mode });
  else if (action === 'favorite') fixture.session = await store.updateSession(payload.id, { saved: payload.saved });
  else if (['open-settings','open-appearance','open-shortcuts'].includes(action)) { fixture.view = 'settings'; fixture.settingsSection = action === 'open-shortcuts' ? 'shortcuts' : action === 'open-appearance' ? 'appearance' : payload.section === 'general' ? 'general' : 'service'; }
  else if (action === 'navigate') fixture.view = payload.view;
  else if (action === 'open-history') { fixture.view = 'history'; fixture.history = await store.listSessions(); }
  else if (action === 'reset-window-size') fixture.wide = desktop.resetPanelSize();
  else if (action === 'pin') { fixture.pinned = payload.pinned; desktop.setPinned(payload.pinned); }
  else throw Error(`此检查不允许操作：${action}`);
  await emit();
  return fixture.settings;
}
ipcMain.handle('pickgloss:action', async (event, action, payload) => {
  if (!desktop.authorize(event, action)) return { ok: false, error: '隔离窗口未授权' };
  try { return { ok: true, value: await handle(action, payload) }; }
  catch (error) { return { ok: false, error: error.message }; }
});
app.whenReady().then(async () => {
  const timeout = setTimeout(() => { console.error('正式 UI 隐藏检查超时'); desktop?.dispose(); app.exit(1); }, 60000);
  try {
    await fs.mkdir(output, { recursive: true });
    store = createStore({ directory: path.join(directory, 'data') }); await store.init();
    await store.saveSettings({ text: { baseUrl: 'http://127.0.0.1/v1', model: '隔离界面检查' } });
    const answer = '## 这里的 compound 是什么意思？\n\n这里作动词，意思是**逐渐累积、产生叠加效果**。强调每一次小变化，都在之前的基础上继续积累。\n\n> Small changes compound over time.\n\n微小的改变，会随着时间逐渐累积，带来更大的效果。\n\n' + Array.from({ length: 12 }, (_, i) => `### 阅读段落 ${i + 1}\n\n每天练习一点，起初可能看不出明显差别。坚持一段时间后，之前的练习会帮助你更快掌握新的内容。阅读位置应该围绕同一段内容保持稳定。`).join('\n\n');
    const selected = await store.createSession({ text: 'compound', context: 'Small changes compound over time. A short daily practice can make a lasting difference.', source: { app: 'Microsoft Edge', title: '每天一点进步', method: '隔离准备材料' }, threads: {
      context: { status: 'done', draft: '', messages: [{ id: '固定回答', role: 'assistant', content: answer, status: 'complete' }] },
      independent: { status: 'idle', draft: '', messages: [] }, visual: { status: 'idle', draft: '', messages: [] }
    } });
    fixture = { view: 'explain', settingsSection: 'service', session: selected, settings: await store.getSettings(), history: [], wide: false, pinned: false, status: {} };
    desktop = createDesktop({ onAction() {}, onSelection() {}, onStatus(patch) { if (!fixture) return; Object.assign(fixture.status, patch); if (typeof patch.wide === 'boolean') fixture.wide = patch.wide; void emit(); }, onWindowState: async geometry => { fixture.settings = await store.saveSettings({ prefs: { windowGeometry: geometry } }); } });
    desktop.restoreWindowState(fixture.settings.prefs.windowGeometry); desktop.setAppearance(fixture.settings.prefs.appearance);
    desktop.setWide(false); win = BrowserWindow.getAllWindows()[0]; win.webContents.setBackgroundThrottling(false);
    win.webContents.on('console-message', event => { if (event.level === 'error') consoleErrors.push(event.message); });
    await ready();
    assert.equal(win.isVisible(), false, '所有验证窗口保持隐藏');
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('.message')).fontSize`), '14px');
    assert.equal(await evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--paper').trim()`), '#252525');
    assert.equal(await evaluate(`[...document.querySelectorAll('.panel-footer .icon-button')].every(node=>!node.textContent.trim()&&node.getAttribute('aria-label')&&node.title)`), true);
    await shot('正式程序-黑银小窗.png');
    for (let loop = 1; loop <= 3; loop++) {
      await input('[data-field="question"]', `快速切换草稿 ${loop}`);
      await click('.layout-toggle');
      await waitFor(async () => fixture.wide === true && await evaluate(`document.querySelector('.layout-toggle')?.getAttribute('aria-label') === '返回小窗'`), '展开目标状态');
      await click('.layout-toggle');
      await waitFor(async () => !fixture.status.windowTransitioning && Math.abs(win.getBounds().width - 300) <= 2, '反向收窄');
      assert.equal(await evaluate(`document.querySelector('[data-field="question"]').value`), `快速切换草稿 ${loop}`);
    }
    observations.push({ 检查: '三轮快速反向', 草稿保留: true, 最终尺寸: win.getBounds() });
    await evaluate(`(()=>{window.__anchorTrace=[];const record=kind=>{const scroller=document.querySelector('[data-scroll="body"]'),edge=scroller?.getBoundingClientRect().top,block=[...document.querySelectorAll('.message-content > *')].find(node=>node.getBoundingClientRect().bottom>edge+12);window.__anchorTrace.push({kind,width:innerWidth,scroll:scroller?.scrollTop,owner:scroller?.className,text:block?.textContent,offset:block?.getBoundingClientRect().top-edge,time:performance.now()});if(window.__anchorTrace.length>80)window.__anchorTrace.shift();};document.addEventListener('scroll',()=>record('scroll'),true);window.addEventListener('resize',()=>record('resize'));window.pickgloss.onState(value=>record('state:'+value.status?.windowTransitioning));record('before-scroll');})()`);
    await evaluate(`(()=>{const scroller=document.querySelector('[data-scroll="body"]'),block=[...document.querySelectorAll('.message-content > h3')][3];scroller.scrollTop+=block.getBoundingClientRect().top-scroller.getBoundingClientRect().top-18;})()`);
    await delay(35);
    const beforeAnchor = await evaluate(`(()=>{const scroller=document.querySelector('[data-scroll="body"]'),nodes=[...document.querySelectorAll('.message-content > *')],edge=scroller.getBoundingClientRect().top;const block=nodes.find(node=>node.getBoundingClientRect().bottom>edge+12);return {text:block.textContent,offset:block.getBoundingClientRect().top-edge};})()`);
    await emit();
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const pushedAnchor = await evaluate(`(()=>{const scroller=document.querySelector('[data-scroll="body"]'),nodes=[...document.querySelectorAll('.message-content > *')],edge=scroller.getBoundingClientRect().top;const block=nodes.find(node=>node.getBoundingClientRect().bottom>edge+12);return {text:block.textContent,offset:block.getBoundingClientRect().top-edge};})()`);
    assert.equal(pushedAnchor.text, beforeAnchor.text, '同尺寸状态推送不覆盖刚发生的滚动');
    assert.ok(Math.abs(pushedAnchor.offset - beforeAnchor.offset) <= 3, JSON.stringify({ beforeAnchor, pushedAnchor }));
    await click('.layout-toggle'); await waitFor(async () => !fixture.status.windowTransitioning && win.getBounds().width >= 858, '阅读终态');
    await waitFor(()=>evaluate(`document.querySelector('.panel').classList.contains('reading-layout')&&document.querySelector('[data-scroll="body"]').classList.contains('answer-pane')`),'渲染器阅读布局');
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('.message')).fontSize`), '16px');
    const afterAnchor = await evaluate(`(()=>{const scroller=document.querySelector('[data-scroll="body"]'),nodes=[...document.querySelectorAll('.message-content > *')],edge=scroller.getBoundingClientRect().top;const block=nodes.find(node=>node.getBoundingClientRect().bottom>edge+12);return {text:block.textContent,offset:block.getBoundingClientRect().top-edge};})()`);
    const anchorEvidence = JSON.stringify({ beforeAnchor, afterAnchor, bounds: win.getBounds(), trace: await evaluate('window.__anchorTrace') });
    assert.equal(afterAnchor.text, beforeAnchor.text, anchorEvidence); assert.ok(Math.abs(afterAnchor.offset - beforeAnchor.offset) <= 3, anchorEvidence);
    observations.push({ 检查: '跨布局保持同一阅读段落', 之前: beforeAnchor, 之后: afterAnchor });
    await click('.layout-toggle'); await waitFor(async () => !fixture.status.windowTransitioning && win.getBounds().width <= 302, '阅读收回终态');
    await waitFor(()=>evaluate(`!document.querySelector('.panel').classList.contains('reading-layout')&&document.querySelector('[data-scroll="body"]').classList.contains('explain-body')`),'渲染器小窗布局');
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const returnedAnchor = await evaluate(`(()=>{const scroller=document.querySelector('[data-scroll="body"]'),nodes=[...document.querySelectorAll('.message-content > *')],edge=scroller.getBoundingClientRect().top;const block=nodes.find(node=>node.getBoundingClientRect().bottom>edge+12);return {text:block.textContent,offset:block.getBoundingClientRect().top-edge};})()`);
    assert.equal(returnedAnchor.text, beforeAnchor.text); assert.ok(Math.abs(returnedAnchor.offset - beforeAnchor.offset) <= 3, JSON.stringify({ beforeAnchor, returnedAnchor }));
    observations.push({ 检查: '状态推送与往返布局不覆盖阅读位置', 推送后: pushedAnchor, 收回后: returnedAnchor });
    await click('.layout-toggle'); await waitFor(async () => !fixture.status.windowTransitioning && win.getBounds().width >= 858, '再次阅读终态');
    await waitFor(()=>evaluate(`document.querySelector('.panel').classList.contains('reading-layout')&&document.querySelector('[data-scroll="body"]').classList.contains('answer-pane')`),'再次阅读布局');
    await evaluate(`document.querySelector('[data-scroll="body"]').scrollTop=0`); await shot('正式程序-黑银阅读.png');
    await evaluate(`window.pickgloss.invoke('open-settings')`); await waitFor(() => evaluate(`Boolean(document.querySelector('[data-field="text-model"]'))`), '服务设置');
    await evaluate(`window.pickgloss.invoke('open-settings',{section:'general'})`); await waitFor(() => evaluate(`!document.querySelector('[data-settings-section="general"]').hidden`), '常规设置');
    assert.equal(await evaluate(`Boolean(document.querySelector('[name="searchEnabled"], [name="searchScope"]'))`), false, '联网在截图翻译菜单控制');
    await shot('常规设置-深色分组.png');
    await centeredTabs('.settings-navigation','宽窗设置分类四等分居中');
    assert.deepEqual(await evaluate(`[...document.querySelector('[name="captureDefaultMode"]').options].map(node=>node.textContent)`),['识图','翻译']);
    assert.deepEqual(await evaluate(`[...document.querySelector('[name="translationMode"]').options].map(node=>node.textContent)`),['快速','深度']);
    await picker('[name="captureDefaultMode"]','截图默认模式-深色展开.png');
    await keyboardSelectCaptureMode();
    assert.equal(await evaluate(`document.querySelector('[name="orbAction"]').value`),'chat');
    await input('[name="orbAction"]','capture'); await evaluate(`document.querySelector('[name="orbAction"]').dispatchEvent(new Event('change',{bubbles:true}))`);
    await waitFor(async()=>(await store.getSettings()).prefs.orbAction==='capture','悬浮球截图设置写盘');
    await win.webContents.reload();await ready();
    assert.equal(await evaluate(`document.querySelector('[name="orbAction"]').value`),'capture','悬浮球功能刷新后读回');
    observations.push({ 检查: '常规选项更改后自动保存并重载读回', 方式: '无提交按钮' });
    failSave=true;await input('[name="orbAction"]','chat'); await evaluate(`document.querySelector('[name="orbAction"]').dispatchEvent(new Event('change',{bubbles:true}))`);
    await waitFor(()=>evaluate(`document.querySelector('[data-settings-section="general"]').textContent.includes('隔离验证的设置写入失败')`),'悬浮球设置失败反馈');
    assert.equal(await evaluate(`document.querySelector('[name="orbAction"]').value`),'chat','失败时保留选择以便重试');
    assert.equal((await store.getSettings()).prefs.orbAction,'capture','失败不覆盖已保存功能');
    failSave=false;await click('[data-autosave="general:orbAction"] button');
    await waitFor(async()=>(await store.getSettings()).prefs.orbAction==='chat','恢复默认左键功能');
    await click('.settings-navigation button:nth-child(2)');
    await centeredTabs('.mode-tabs[aria-label="服务类型"]','宽窗服务分类四等分居中');
    await shot('AI服务-居中分类.png');
    assert.equal(await evaluate(`document.querySelector('[name="text-clearKey"]').closest('label').hidden`), true, '没有密钥时不出现清除动作');
    const savedText = (await store.getSettings()).text;
    await input('[name="text-baseUrl"]', 'invalid-host');
    await waitFor(() => evaluate(`Boolean(document.querySelector('[data-provider="text"] .setting-save-state.is-error'))`), '无效服务地址明确未保存');
    await input('[name="text-provider"]', 'mimo'); await evaluate(`document.querySelector('[name="text-provider"]').dispatchEvent(new Event('change',{bubbles:true}))`);
    await waitFor(async () => (await store.getSettings()).text.providerId === 'mimo', '其他厂商仍可独立保存');
    await waitFor(() => evaluate(`!document.querySelector('[data-settings-save-issues]').hidden && document.querySelector('[data-settings-save-issues]').textContent.includes('自定义')`), '后台失败配置始终可定位');
    await shot('后台服务保存失败-可定位.png');
    await click('[data-settings-save-issues] button:first-of-type');
    await waitFor(() => evaluate(`document.querySelector('[name="text-provider"]').value==='custom' && document.querySelector('[name="text-baseUrl"]').value==='invalid-host'`), '定位失败厂商并保留原输入');
    await click('[data-settings-save-issues] button:nth-of-type(2)');
    await waitFor(() => evaluate(`document.querySelector('[data-settings-save-issues]').hidden && document.querySelector('[name="text-provider"]').value==='mimo'`), '显式恢复后解除保存阻断');
    assert.equal((await store.getSettings()).text.providerId, 'mimo', '放弃未保存修改不改动当前已生效的厂商');
    await input('[name="text-provider"]', 'custom'); await evaluate(`document.querySelector('[name="text-provider"]').dispatchEvent(new Event('change',{bubbles:true}))`);
    await waitFor(async () => (await store.getSettings()).text.providerId === 'custom', '恢复原服务用于后续检查');
    assert.equal((await store.getSettings()).text.baseUrl, savedText.baseUrl);
    observations.push({ 检查: '后台厂商失败可定位及显式恢复', 草稿保留: true, 有效配置未被恢复动作改写: true });
    await input('[data-field="text-model"]', '自动保存的服务草稿');
    await click('.settings-navigation button:nth-child(3)');
    await waitFor(async () => fixture.settingsSection === 'appearance', '设置分类同步');
    await click('.settings-navigation button:nth-child(2)'); await waitFor(async () => fixture.settingsSection === 'service', '服务分类同步');
    await evaluate(`window.pickgloss.invoke('open-appearance')`);
    await waitFor(() => evaluate(`document.querySelector('.settings-navigation button:nth-child(3)').getAttribute('aria-selected')==='true'`), '外部入口重新打开外观');
    assert.equal(await evaluate(`document.querySelector('[aria-label="窗口设置"]').closest('[data-settings-section]').dataset.settingsSection`),'general');
    await evaluate(`window.pickgloss.invoke('open-settings',{section:'general'})`); await waitFor(() => evaluate(`!document.querySelector('[data-settings-section="general"]').hidden`), '窗口设置所在分类');
    await evaluate(`document.querySelector('[title="恢复窗口默认大小"]').scrollIntoView({block:'nearest'})`);
    await click('[title="恢复窗口默认大小"]');
    await waitFor(()=>evaluate(`document.querySelector('[data-window-size-feedback]').textContent==='已恢复默认大小'`),'恢复窗口默认大小反馈');
    assert.equal(await evaluate(`document.querySelector('[data-settings-section="general"]').hidden`),false,'恢复窗口后留在常规分类');
    await evaluate(`window.pickgloss.invoke('open-appearance')`); await waitFor(() => evaluate(`!document.querySelector('[data-settings-section="appearance"]').hidden`), '回到外观分类');
    observations.push({ 检查: '本地分类切换后外部入口重开', 正确打开外观: true });
    await click('[data-mode="light"]');
    await waitFor(async () => (await store.getSettings()).prefs.appearance.current.mode === 'light', '浅色写盘');
    assert.equal(await evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--paper').trim()`), '#ffffff');
    assert.equal(await evaluate(`document.querySelector('[data-field="text-model"]').value`), '自动保存的服务草稿');
    assert.equal((await store.getSettings()).text.model, '自动保存的服务草稿', '切换设置分类前服务输入已自动保存');
    await input('.appearance-name', '后台推送期间输入');
    fixture.session.threads.context.messages[0].content += '\n\n后台完成的另一段回答。'; await emit();
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    assert.equal(await evaluate(`document.activeElement===document.querySelector('.appearance-name')`), true);
    assert.equal(await evaluate(`document.querySelector('.appearance-name').value`), '后台推送期间输入');
    observations.push({ 检查: '外观编辑时后台推送', 焦点与名称保留: true });
    await input('.appearance-name', '暖白细读'); await click('.appearance-primary');
    await waitFor(async () => (await store.getSettings()).prefs.appearance.presets.length === 1, '第一个预设写盘');
    await click('[data-mode="dark"]'); await waitFor(async () => (await store.getSettings()).prefs.appearance.current.mode === 'dark', '深色写盘');
    await input('.appearance-name', '黑银夜读'); await click('.appearance-primary');
    await waitFor(async () => (await store.getSettings()).prefs.appearance.presets.length === 2, '第二个预设写盘');
    await input('.appearance-name', '黑银微雾'); await click('[data-material="glass"]');
    await waitFor(async () => (await store.getSettings()).prefs.appearance.current.material === 'glass', '材质写盘');
    await waitFor(async () => (await store.getSettings()).prefs.appearance.presets.some(preset => preset.name === '黑银夜读' && preset.values.material === 'glass'), '活动预设配色自动更新');
    assert.equal((await store.getSettings()).prefs.appearance.presets.length, 2);
    failSave = true; await input('.appearance-name', '失败时保留的名字');
    await input('[aria-label="强调色十六进制色值"]', '#424242'); await click('.appearance-primary');
    await waitFor(() => evaluate(`Boolean(document.querySelector('.appearance-notice.is-error'))`), '保存失败反馈');
    assert.equal(await evaluate(`document.querySelector('.appearance-name').value`), '失败时保留的名字');
    assert.equal(await evaluate(`document.querySelector('[aria-label="强调色十六进制色值"]').value`), '#424242');
    assert.equal((await store.getSettings()).prefs.appearance.presets.length, 2);
    failSave = false;
    await click('.appearance-retry'); await waitFor(async () => (await store.getSettings()).prefs.appearance.presets.length === 3, '失败恢复后自动保存重试');
    fixture.settings = await store.getSettings(); await win.webContents.reload(); await ready();
    await click('.settings-navigation button:nth-child(3)');
    await waitFor(() => evaluate(`document.querySelectorAll('.appearance-preset').length===4`), '重载读回预设');
    assert.equal(await evaluate(`document.querySelector('.appearance-name').value`), '', '新预设名称不是尚待提交的当前设置');
    observations.push({ 检查: '预设创建自动更新、失败保留与重试后重载', 预设名称: fixture.settings.prefs.appearance.presets.map(preset => preset.name), 失败不新增: true, 字段失败保留: true, 实际材质: fixture.status.appearanceMaterial });
    await click('[data-mode="system"]'); await waitFor(async () => (await store.getSettings()).prefs.appearance.current.mode === 'system', '跟随系统写盘');
    observations.push({ 检查: '跟随系统', 模式: 'system', 当前系统明暗: fixture.status.appearanceDark, 未更改系统外观: true });
    await evaluate(`(()=>{const box=document.querySelector('.appearance-motion input');box.checked=true;box.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await waitFor(async () => (await store.getSettings()).prefs.appearance.reducedMotion, '减少动态效果写盘');
    assert.equal(await evaluate(`document.documentElement.classList.contains('reduced-motion')`), true);
    await click('.layout-toggle'); await waitFor(async () => !fixture.status.windowTransitioning && win.getBounds().width <= 302, '减少动画切换');
    await shot('正式程序-小窗主题设置.png');
    await click('.layout-toggle'); await waitFor(async () => !fixture.status.windowTransitioning && win.getBounds().width >= 858, '恢复阅读尺寸');
    await click('[data-mode="light"]'); await waitFor(async () => (await store.getSettings()).prefs.appearance.current.mode === 'light', '暖白主题设置');
    await click('[data-material="solid"]'); await waitFor(async () => (await store.getSettings()).prefs.appearance.current.material === 'solid', '实色回退');
    await shot('正式程序-暖白主题设置.png');
    await evaluate(`window.pickgloss.invoke('open-settings',{section:'general'})`); await waitFor(() => evaluate(`!document.querySelector('[data-settings-section="general"]').hidden`), '浅色常规设置');
    await shot('常规设置-浅色分组.png');
    await handle('wide', { wide: false }); await waitFor(async () => !fixture.status.windowTransitioning && win.getBounds().width <= 302, '浅色设置小窗');
    await shot('常规设置-浅色小窗.png');
    await centeredTabs('.settings-navigation','小窗设置分类四等分居中');
    await picker('[name="captureDefaultMode"]','截图默认模式-浅色展开.png');
    await click('.settings-navigation button:nth-child(4)');
    await shot('快捷键-末项对齐.png');
    await click('.settings-navigation button:nth-child(2)');
    await centeredTabs('.mode-tabs[aria-label="服务类型"]','小窗服务分类四等分居中');
    await shot('AI服务-小窗居中.png');
    await click('.settings-navigation button:nth-child(1)');
    await handle('wide', { wide: true }); await waitFor(async () => !fixture.status.windowTransitioning && win.getBounds().width >= 858, '恢复检查宽布局');
    fixture.view = 'explain'; await emit(); await waitFor(() => evaluate(`Boolean(document.querySelector('.message'))`), '解释返回');
    await evaluate(`document.querySelector('[data-scroll="body"]').scrollTop=0`); await shot('正式程序-暖白阅读.png');
    await desktop.flushWindowState();
    assert.equal(calls.includes('send-question'), false); assert.equal(calls.includes('copy-answer'), false);
    assert.equal(win.isVisible(), false); assert.deepEqual(consoleErrors, []);
    await fs.writeFile(path.join(output, '正式UI检查.json'), JSON.stringify({ 通过: true, 隐藏窗口: true, 真实设置与预加载: true, 未使用正常应用数据: true, 未调用真实模型或剪贴板: true, observations }, null, 2));
    clearTimeout(timeout); desktop.dispose(); console.log('正式 UI：隐藏窗口、固定字号、三轮反向、阅读位置、主题预设读回与失败保留检查通过。'); app.exit(0);
  } catch (error) { console.error(error); console.error(consoleErrors); clearTimeout(timeout); desktop?.dispose(); app.exit(1); }
});
