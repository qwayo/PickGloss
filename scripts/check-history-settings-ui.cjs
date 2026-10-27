'use strict';
const { applySettingsFixture } = require('./settings-fixture.cjs');
// 使用虚构状态和 IPC 检查历史批量操作与服务表单；不读取用户设置、密钥或访问外网。
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const { defaultAppearance } = require('../src/core/appearance.cjs');
const { setTimeout: delay } = require('node:timers/promises');

app.setPath('userData', path.join(os.tmpdir(), `pickgloss-history-settings-ui-${process.pid}`));
const root = path.join(__dirname, '..');
const calls = [], remoteRequests = [], consoleErrors = [];
const fullHistory = Array.from({ length: 52 }, (_, index) => ({
  id: `虚构会话-${String(index).padStart(2, '0')}`,
  title: `虚构会话标题 ${String(index).padStart(2, '0')}`,
  text: `虚构选定内容 ${index}`,
  preview: `虚构回答 ${index}`,
  kind: 'text',
  saved: index === 0 || index === 10,
  createdAt: '2026-10-25T01:00:00.000Z',
  lastActivityAt: '2026-10-25T01:00:00.000Z',
  modesWithMessages: ['context'],
}));
const current = {
  view: 'explain', history: fullHistory, historyQuery: '', historySavedOnly: false,
  settingsSection: 'service', settingsFilePath: '虚构设置文件路径', status: {},
  settings: {
    text: { providerId: 'custom', baseUrl: 'https://文字服务.mock.invalid/v1', model: '虚构文字模型', hasKey: false },
    vision: { providerId: 'custom', baseUrl: '', model: '', hasKey: false },
    translation: { providerId: 'custom', baseUrl: '', model: '', hasKey: true },
    search: { providerId: 'exa', baseUrl: 'https://搜索服务.mock.invalid', hasKey: false },
    serviceProfiles: { text: {}, vision: {}, translation: {}, search: {} },
    prefs: { launchAtLogin: false, captureDefaultMode: 'explain' },
  },
  serviceCatalog: {
    models: [{ id: 'custom', name: '自定义' }, { id: 'fixture', name: '虚构服务' }],
    search: [{ id: 'exa', name: '虚构搜索服务' }, { id: 'custom', name: '自定义' }],
  },
  session: {
    id: '虚构活动会话', kind: 'text', text: '被选中的虚构文本', context: '这是用于隔离检查的虚构上下文。',
    saved: true, activeMode: 'context', webSearchEnabled: false,
    threads: {
      context: { status: 'idle', messages: [], draft: '' },
      independent: { status: 'idle', messages: [], draft: '' },
      visual: { status: 'idle', messages: [], draft: '' },
    },
  },
};

let win;
let failConnection = false;
let failAppearanceSave = false;
let deleteAttempt = 0;

async function pushState() {
  const seen = new Promise(resolve => ipcMain.once('test:state-seen', resolve));
  win.webContents.send('test:state', current);
  await seen;
}

function filteredHistory() {
  const query = current.historyQuery.trim().toLocaleLowerCase();
  return fullHistory.filter(item => (!current.historySavedOnly || item.saved)
    && (!query || `${item.title} ${item.text} ${item.preview}`.toLocaleLowerCase().includes(query)));
}

ipcMain.handle('test:invoke', async (_, action, payload) => {
  calls.push({ action, payload });
  if (action === 'bootstrap') return { ok: true, value: current };
  if (action === 'open-history') {
    current.historyOpenId = (current.historyOpenId || 0) + 1;
    current.view = 'history'; current.historyQuery = ''; current.historySavedOnly = false; current.history = filteredHistory();
    await pushState();
  } else if (action === 'search-history') {
    current.historyQuery = payload.query || ''; current.historySavedOnly = payload.savedOnly === true; current.history = filteredHistory();
    await pushState();
  } else if (action === 'open-settings') {
    current.view = 'settings'; current.settingsSection = payload.section === 'general' ? 'general' : 'service';
    await pushState();
  } else if (action === 'navigate') {
    current.view = payload.view; await pushState();
  } else if (action === 'save-settings') {
    if (failAppearanceSave && payload.prefs?.appearance) return { ok: false, error: '虚构配色保存失败' };
    current.settings = applySettingsFixture(current.settings, payload); await pushState();
    return { ok: true, value: current.settings };
  } else if (action === 'fetch-models') {
    if (payload.kind === 'vision') return { ok: true, value: { models: [] } };
    return { ok: true, value: { models: ['虚构模型甲', '虚构模型乙'] } };
  } else if (action === 'test-provider') {
    await delay(30);
    return failConnection ? { ok: false, error: '虚构连接失败' } : { ok: true, value: { message: '虚构连接成功' } };
  } else if (action === 'delete-sessions') {
    deleteAttempt++;
    const failedId = deleteAttempt === 1 ? payload.ids[0] : null;
    const deletedIds = payload.ids.filter(id => id !== failedId);
    const failed = failedId ? [{ id: failedId, error: '虚构存储占用错误' }] : [];
    for (const id of deletedIds) fullHistory.splice(fullHistory.findIndex(item => item.id === id), 1);
    current.history = filteredHistory(); await pushState();
    return { ok: true, value: { deletedIds, failed } };
  }
  return { ok: true };
});

async function waitFor(expression, label, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await win.webContents.executeJavaScript(expression)) return;
    await delay(35);
  }
  const state = await win.webContents.executeJavaScript(`({query:document.querySelector('[data-field="history-search"]')?.value,selected:document.querySelectorAll('.history-select-checkbox:checked').length,selection:document.querySelector('[data-history-selection]')?.hidden,count:document.querySelector('.history-selection-count')?.textContent,warning:document.querySelector('.history-selection-warning')?.textContent,historyQuery:document.querySelector('.history-count')?.textContent,body:document.querySelector('.panel-body')?.className,sections:[...document.querySelectorAll('[data-settings-section]')].map(node=>node.dataset.settingsSection),app:document.querySelector('#app')?.innerText?.slice(0,500)})`).catch(() => null);
  throw new Error(`等待界面状态超时：${label}；界面状态=${JSON.stringify(state)}；视图=${current.view}/${current.settingsSection}；调用=${JSON.stringify(calls.map(item => item.action))}；控制台=${JSON.stringify(consoleErrors)}`);
}

async function click(expression, label) {
  const found = await win.webContents.executeJavaScript(`(() => { const node = ${expression}; if (!node || node.disabled) return false; node.click(); return true; })()`);
  assert.equal(found, true, `无法点击控件：${label}`);
}

async function waitForCall(action, predicate = () => true) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const found = calls.find(item => item.action === action && predicate(item));
    if (found) return found;
    await delay(30);
  }
  throw new Error(`等待虚构 IPC 操作超时：${action}`);
}

async function colorFor(variable) {
  return win.webContents.executeJavaScript(`(() => {const node=document.createElement('span');node.style.color='var(${variable})';document.body.append(node);const color=getComputedStyle(node).color;node.remove();return color;})()`);
}

app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ show: false, width: 570, height: 760, useContentSize: true, offscreen: true,
      webPreferences: { preload: path.join(root, 'tests/renderer/streaming.preload.cjs'), contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    win.webContents.on('console-message', event => { if (event.level >= 3) consoleErrors.push(event.message); });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
      remoteRequests.push(details.url); callback({ cancel: true });
    });
    await win.loadFile(path.join(root, 'src/renderer/index.html'));
    await waitFor(`Boolean(document.querySelector('.panel-footer button[aria-label="会话历史"]'))`, '解释页加载');

    const contextStyle = await win.webContents.executeJavaScript(`(() => {const node=document.querySelector('.context-disclosure'),text=node?.querySelector('.context-text');return {margin:getComputedStyle(node).marginTop,font:getComputedStyle(text).fontSize};})()`);
    assert.equal(contextStyle.margin, '4px', '查看上下文顶部间距收紧');
    assert.equal(contextStyle.font, '12px', '查看上下文正文字号缩小');
    const starStyle = await win.webContents.executeJavaScript(`(() => {const node=document.querySelector('.panel-footer .starred');return {pressed:node?.getAttribute('aria-pressed'),background:getComputedStyle(node).backgroundColor,fill:getComputedStyle(node.querySelector('.icon')).fill};})()`);
    assert.equal(starStyle.pressed, 'true');
    assert.equal(starStyle.background, 'rgba(0, 0, 0, 0)', '已收藏星形没有灰底');
    assert.notEqual(starStyle.fill, 'none', '已收藏星形保持填充');
    const tabRect = await win.webContents.executeJavaScript(`(() => {const r=document.querySelector('.mode-tabs[aria-label="解释模式"] button').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
    win.webContents.sendInputEvent({ type: 'mouseMove', ...tabRect });
    await delay(350);
    const tabHover = await win.webContents.executeJavaScript(`(() => {const node=document.querySelector('.mode-tabs[aria-label="解释模式"] button');return {hover:node.matches(':hover'),background:getComputedStyle(node).backgroundColor,pillOpacity:getComputedStyle(node,'::before').opacity,pillRadius:getComputedStyle(node,'::before').borderRadius,indicator:document.querySelector('.mode-tabs[aria-label="解释模式"] .mode-indicator')?.getBoundingClientRect().height};})()`);
    assert.equal(tabHover.hover, true, '解释模式标签有实际悬停');
    assert.equal(tabHover.background, 'rgba(0, 0, 0, 0)', '标签本身不铺矩形背景');
    assert.equal(tabHover.pillRadius, '6px'); assert.ok(Number(tabHover.pillOpacity) > 0.5, `文字周围显示轻微圆角底色：${JSON.stringify(tabHover)}`);
    assert.ok(Math.abs(tabHover.indicator - 2) < .1, '选中下划线仍保留');

    await click(`document.querySelector('.panel-footer button[aria-label="会话历史"]')`, '打开会话历史');
    await waitFor(`Boolean(document.querySelector('[data-history-list] .history-item'))`, '会话历史列表');
    const headingButtons = await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.history-heading-actions button')).map(node=>({label:node.getAttribute('aria-label'),text:node.textContent.trim(),width:node.getBoundingClientRect().width,icon:node.querySelector('svg')?.getBoundingClientRect().width}))`);
    assert.equal(headingButtons[0].label, '多选'); assert.equal(headingButtons[0].text, '');
    assert.ok(headingButtons.every(node => node.width <= 28 && node.icon <= 15), '会话标题操作使用小图标按钮');
    await click(`document.querySelector('.history-heading-actions button')`, '进入多选');
    win.setContentSize(300, 483);
    await win.webContents.executeJavaScript('document.querySelector(".panel-body").scrollTop=500');
    await delay(80);
    const sticky = await win.webContents.executeJavaScript(`(()=>{const body=document.querySelector('.panel-body'),node=document.querySelector('[data-history-selection]');return {top:node.getBoundingClientRect().top,body:body.getBoundingClientRect().top+parseFloat(getComputedStyle(body).paddingTop),scroll:body.scrollTop,position:getComputedStyle(node).position,height:node.querySelector('.history-selection-toolbar').getBoundingClientRect().height};})()`);
    assert.equal(sticky.position, 'sticky'); assert.ok(Math.abs(sticky.top-sticky.body) <= 2, '下滑后多选工具条仍固定在滚动区域顶部：'+JSON.stringify(sticky));
    assert.ok(sticky.height <= 30, '300像素小窗的多选工具条保持单行紧凑');
    const outputIndex = process.argv.indexOf('--output-dir');
    const screenshots = outputIndex < 0 ? path.join(root, 'output/verification/2026-10-25-compact-batch') : path.resolve(process.argv[outputIndex + 1]);
    await fs.mkdir(screenshots, { recursive: true });
    await fs.writeFile(path.join(screenshots, '会话多选-滚动固定.png'), (await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript('document.querySelector(".panel-body").scrollTop=0'); win.setContentSize(570, 760);
    await click(`document.querySelector('.history-select-checkbox')`, '选择一条会话');
    assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.history-select-checkbox:checked').length`), 1, '单行复选框应保存所选会话');
    await click(`document.querySelector('.history-heading-actions button[aria-label="新建"]')`, '在多选状态离开会话历史');
    await waitFor(`Boolean(document.querySelector('[data-field="paste-text"]'))`, '新建会话界面');
    await click(`document.querySelector('.panel-footer button[aria-label="会话历史"]')`, '再次进入会话历史');
    await waitFor(`Boolean(document.querySelector('[data-history-list] .history-item'))`, '重新显示会话历史');
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-history-selection]').hidden`), true, '再次进入会话历史应退出之前的多选状态');
    await click(`document.querySelector('.history-heading-actions button')`, '重新开始多选');
    assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.history-select-checkbox:checked').length`), 0, '新一轮多选不继承之前所选会话');
    await click(`document.querySelector('.history-select-checkbox')`, '为后续批量回收检查重新选择会话');
    await pushState();
    assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.history-select-checkbox:checked').length`), 1, '同一轮历史状态推送保留当前多选');
    await win.webContents.executeJavaScript(`window.pickgloss.invoke('open-history')`);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-history-selection]').hidden`), true, '历史已打开时，从入口再次进入也退出旧的多选');
    await click(`document.querySelector('.history-heading-actions button')`, '显式再次进入后重新开始多选');
    assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.history-select-checkbox:checked').length`), 0, '重复进入后的会话选择为空');
    await click(`document.querySelector('.history-select-checkbox')`, '继续批量回收检查');
    await win.webContents.executeJavaScript(`(() => {const old=Object.getOwnPropertyDescriptor(document,'hidden');try{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));}finally{if(old)Object.defineProperty(document,'hidden',old);else delete document.hidden;}})()`);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-history-selection]').hidden`), true, '历史窗口隐藏后直接唤回也不继承旧多选');
    await click(`document.querySelector('.history-heading-actions button')`, '隐藏再唤回后开始新一轮多选');
    assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.history-select-checkbox:checked').length`), 0);
    await click(`document.querySelector('.history-select-checkbox')`, '恢复后续批量回收检查的选择');
    const firstSearch = win.webContents.executeJavaScript(`(() => {const node=document.querySelector('[data-field="history-search"]');node.value='虚构会话标题 10';node.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
    await firstSearch;
    await waitFor(`document.querySelector('.history-selection-warning')?.textContent.includes('被搜索')`, '筛选隐藏选择的提醒');
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.history-selection-toolbar button.danger')?.disabled`), true, '搜索隐藏所选后暂停批量删除');
    await click(`document.querySelector('.history-selection-warning .text-button')`, '清除筛选隐藏的选择');
    await win.webContents.executeJavaScript(`(() => {const node=document.querySelector('[data-field="history-search"]');node.value='';node.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await waitFor(`document.querySelectorAll('[data-history-list] .history-item').length===50`, '恢复全部筛选结果');
    await click(`document.querySelector('.history-selection-toolbar button')`, '全选当前筛选结果');
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.history-selection-count')?.textContent`), '已选 52 个会话');
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.history-selection-toolbar button.danger')?.disabled`), true, '分页隐藏选择时暂停批量删除');
    await click(`document.querySelector('.history-more')`, '加载其余会话');
    await waitFor(`document.querySelectorAll('[data-history-list] .history-item').length===52`, '显示完整筛选结果');
    await click(`document.querySelector('.history-selection-toolbar button.danger')`, '请求批量删除确认');
    const confirmation = await win.webContents.executeJavaScript(`document.querySelector('.batch-delete-confirm')?.textContent`);
    assert.match(confirmation, /52 个会话/);
    assert.match(confirmation, /已收藏会话随整条会话一起移走|已收藏会话。/);
    await click(`document.querySelector('.batch-delete-confirm .danger')`, '确认批量移到回收站');
    await waitFor(`document.querySelector('.history-batch-status.failure')?.textContent.includes('虚构存储占用错误')`, '显示部分失败并保留选择');
    assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.history-select-checkbox:checked').length`), 1, '部分失败的所选会话仍被选中');
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.history-selection-count')?.textContent`), '已选 1 个会话');
    await click(`document.querySelector('.history-selection-toolbar button.danger')`, '重试剩余会话');
    await click(`document.querySelector('.batch-delete-confirm .danger')`, '确认重试');
    await waitFor(`document.querySelector('.history-batch-status.success')?.textContent.includes('1 个会话')`, '显示批量完成状态');

    await click(`document.querySelector('.history-heading-actions button')`, '退出多选');
    const historyWindow = win;
    current.view = 'settings'; current.settingsSection = 'service';
    win = new BrowserWindow({ show: false, width: 570, height: 760, useContentSize: true, offscreen: true,
      webPreferences: { preload: path.join(root, 'tests/renderer/streaming.preload.cjs'), contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    win.webContents.on('console-message', event => { if (event.level >= 3) consoleErrors.push(event.message); });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
      remoteRequests.push(details.url); callback({ cancel: true });
    });
    await win.loadFile(path.join(root, 'src/renderer/index.html'));
    await waitFor(`document.querySelector('[data-settings-section="service"]')?.hidden===false`, '服务设置打开');
    historyWindow.destroy();
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-provider="text"] .api-key-status')?.classList.contains('missing')`), true, '未配置的 API 密钥显示为缺失状态');
    assert.equal(await win.webContents.executeJavaScript(`getComputedStyle(document.querySelector('[data-provider="text"] .api-key-status')).color`), await colorFor('--danger'));
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-provider="translation"] .api-key-status')?.classList.contains('configured')`), true, '已有翻译密钥显示为已配置');
    assert.equal(await win.webContents.executeJavaScript(`getComputedStyle(document.querySelector('[data-provider="translation"] .api-key-status')).color`), await colorFor('--success'));
    const keyNoteStyle = await win.webContents.executeJavaScript(`(() => {const node=document.querySelector('.api-key-note');return {font:getComputedStyle(node).fontSize,color:getComputedStyle(node).color,muted:getComputedStyle(document.documentElement).getPropertyValue('--muted').trim()};})()`);
    assert.equal(keyNoteStyle.font, '11px', '密钥路径说明使用较小字号');
    await click(`document.querySelector('.settings-navigation button')`, '打开常规设置');
    await waitFor(`document.querySelector('[data-settings-section="general"]')?.hidden===false`, '常规设置显示');
    const startup = await win.webContents.executeJavaScript(`({checked:document.querySelector('[name="launchAtLogin"]')?.checked,mode:document.querySelector('[name="captureDefaultMode"]')?.value,translationMode:document.querySelector('[name="translationMode"]').value,captureExplainMode:document.querySelector('[name="captureExplainMode"]').value,groups:[...document.querySelectorAll('.settings-group h2')].map(node=>node.textContent)})`);
    assert.equal(startup.checked, false, '开机自启动默认关闭');
    assert.equal(startup.mode, 'explain', '截图默认模式兼容并默认为解释');
    assert.deepEqual(startup.groups, ['桌面入口','截图与翻译','启动与提示']);
    assert.equal(startup.translationMode, 'standard'); assert.equal(startup.captureExplainMode, 'immediate');
    await win.webContents.executeJavaScript(`(() => {for(const [name,value] of [['launchAtLogin',true],['captureDefaultMode','translate'],['translationMode','deep'],['captureExplainMode','prompt']]){const node=document.querySelector('[name="'+name+'"]');if(node.type==='checkbox')node.checked=value;else node.value=value;node.dispatchEvent(new Event('change',{bubbles:true}));}})()`);
    await waitForCall('save-settings', item => item.payload.prefs?.captureExplainMode === 'prompt');
    await waitFor(`document.querySelector('[data-settings-save-summary]').textContent==='已自动保存'`, '常规设置无需按钮即完成保存');
    assert.equal(current.settings.prefs.launchAtLogin, true); assert.equal(current.settings.prefs.captureDefaultMode, 'translate');
    assert.equal(current.settings.prefs.screenshotTranslation.translationMode, 'deep'); assert.equal(current.settings.prefs.captureExplainMode, 'prompt');
    await click(`document.querySelectorAll('.settings-navigation button')[1]`, '打开 AI 服务');
    await waitFor(`document.querySelector('[data-settings-section="service"]')?.hidden===false`, 'AI 服务显示');

    await win.webContents.executeJavaScript(`(() => {const set=(name,value)=>{const node=document.querySelector('[name="'+name+'"]');node.value=value;node.dispatchEvent(new Event('input',{bubbles:true}));};set('text-baseUrl','https://当前文字服务.mock.invalid/v2');set('text-apiKey','虚构文字密钥');})()`);
    await click(`document.querySelector('[data-provider="text"] .model-fetch-button')`, '获取当前文字服务模型');
    await waitFor(`document.querySelector('[data-provider="text"] .model-option')?.textContent==='虚构模型甲'`, '显示服务返回的模型 ID');
    const fetchCall = calls.find(item => item.action === 'fetch-models' && item.payload.kind === 'text');
    assert.deepEqual(JSON.parse(JSON.stringify(fetchCall.payload)), { kind: 'text', config: {
      providerId: 'custom', baseUrl: 'https://当前文字服务.mock.invalid/v2', model: '虚构文字模型', apiKey: '虚构文字密钥',
    } });
    assert.match(await win.webContents.executeJavaScript(`document.querySelector('[data-provider="text"] .model-fetch-hint').textContent`), /仅显示当前服务返回的模型 ID/);
    assert.match(await win.webContents.executeJavaScript(`document.querySelector('[data-provider="vision"] .model-fetch-hint').textContent`), /不代表模型支持识图/);
    await click(`document.querySelector('[data-provider="text"] .model-option:nth-child(2)')`, '使用服务返回的模型 ID');
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[name="text-model"]').value`), '虚构模型乙');
    await win.webContents.executeJavaScript(`(() => {const node=document.querySelector('[name="text-baseUrl"]');node.value='https://另一个文字服务.mock.invalid/v1';node.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-provider="text"] .model-option')`), null, '地址变化后不显示旧模型列表');
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[name="text-model"]').disabled`), false, '模型仍可手动填写');

    await click(`document.querySelector('[data-kind="vision"]')`, '切换到识图服务');
    await win.webContents.executeJavaScript(`(() => {const set=(name,value)=>{const node=document.querySelector('[name="'+name+'"]');node.value=value;node.dispatchEvent(new Event('input',{bubbles:true}));};set('vision-baseUrl','https://当前识图服务.mock.invalid/v1');set('vision-apiKey','虚构识图密钥');})()`);
    await click(`document.querySelector('[data-provider="vision"] .model-fetch-button')`, '获取当前识图服务模型');
    await waitFor(`document.querySelector('[data-provider="vision"] .model-fetch-status')?.textContent.includes('手动填写')`, '空模型列表允许手动填写');
    const visionFetch = calls.find(item => item.action === 'fetch-models' && item.payload.kind === 'vision');
    assert.deepEqual(JSON.parse(JSON.stringify(visionFetch.payload)), { kind: 'vision', config: {
      providerId: 'custom', baseUrl: 'https://当前识图服务.mock.invalid/v1', model: '', apiKey: '虚构识图密钥',
    } }, '识图获取使用当前识图配置，不继承文字模型配置');

    await click(`document.querySelector('[data-kind="translation"]')`, '切换到翻译服务');
    assert.match(await win.webContents.executeJavaScript(`document.querySelector('[data-provider="translation"] .hint').textContent`), /截图翻译沿用文字模型的整套配置/);
    await win.webContents.executeJavaScript(`(() => {const set=(name,value)=>{const node=document.querySelector('[name="'+name+'"]');node.value=value;node.dispatchEvent(new Event('input',{bubbles:true}));};set('translation-baseUrl','https://当前翻译服务.mock.invalid/v1');set('translation-apiKey','虚构翻译密钥');})()`);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-provider="translation"] .api-key-status')?.classList.contains('pending')`), true, '新输入的密钥标记为待保存');
    await click(`document.querySelector('[data-provider="translation"] .model-fetch-button')`, '获取当前翻译服务模型');
    await waitFor(`document.querySelector('[data-provider="translation"] .model-option')?.textContent==='虚构模型甲'`, '显示翻译服务返回的模型 ID');
    const translationFetch = calls.find(item => item.action === 'fetch-models' && item.payload.kind === 'translation');
    assert.deepEqual(JSON.parse(JSON.stringify(translationFetch.payload)), { kind: 'translation', config: {
      providerId: 'custom', baseUrl: 'https://当前翻译服务.mock.invalid/v1', model: '', apiKey: '虚构翻译密钥',
    } }, '翻译模型列表仅按当前翻译服务配置获取');
    assert.doesNotMatch(await win.webContents.executeJavaScript(`document.querySelector('[data-provider="translation"] .model-fetch-hint').textContent`), /支持识图/);
    await click(`document.querySelector('[data-provider="translation"] .model-option:nth-child(2)')`, '选择翻译模型 ID');
    await win.webContents.executeJavaScript(`(() => {const node=document.querySelector('[name="translation-model"]');node.value='';node.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await click(`document.querySelector('[data-provider="translation"] button.secondary:not(.model-fetch-button)')`, '测试沿用文字模型的翻译配置');
    await waitFor(`document.querySelector('[data-provider="translation"] .test-result.success')`, '翻译服务测试成功');
    const translationTest = calls.find(item => item.action === 'test-provider' && item.payload.kind === 'translation');
    assert.deepEqual(JSON.parse(JSON.stringify(translationTest.payload)), { kind: 'translation',
      config: { providerId: 'custom', baseUrl: 'https://当前翻译服务.mock.invalid/v1', model: '', apiKey: '虚构翻译密钥' },
      fallbackConfig: { providerId: 'custom', baseUrl: 'https://另一个文字服务.mock.invalid/v1', model: '虚构模型乙', apiKey: '虚构文字密钥' },
    }, '翻译测试保留 translation 类型，并显式传递当前文字模型回退配置');
    await win.webContents.executeJavaScript(`document.querySelector('[data-settings-section="service"] form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))`);
    const savedService = await waitForCall('save-settings', item => Boolean(item.payload.translation));
    assert.equal(savedService.payload.translation.model, '', '留空的翻译模型交由后端沿用文字模型');
    assert.equal(savedService.payload.translation.apiKey, '虚构翻译密钥');
    assert.equal(savedService.payload.serviceProfiles.translation.custom.apiKey, '虚构翻译密钥');

    await click(`document.querySelector('[data-kind="text"]')`, '切回文字服务测试');
    await click(`document.querySelector('[data-provider="text"] button.secondary:not(.model-fetch-button)')`, '开始连接测试');
    await waitFor(`document.querySelector('[data-provider="text"] .test-result.pending')`, '显示中性测试状态');
    assert.equal(await win.webContents.executeJavaScript(`getComputedStyle(document.querySelector('[data-provider="text"] .test-result')).color`), await colorFor('--muted'));
    await waitFor(`document.querySelector('[data-provider="text"] .test-result.success')`, '连接成功反馈');
    assert.equal(await win.webContents.executeJavaScript(`getComputedStyle(document.querySelector('[data-provider="text"] .test-result')).color`), await colorFor('--success'));
    failConnection = true;
    await click(`document.querySelector('[data-provider="text"] button.secondary:not(.model-fetch-button)')`, '再次测试连接');
    await waitFor(`document.querySelector('[data-provider="text"] .test-result.failure')`, '连接失败反馈');
    assert.equal(await win.webContents.executeJavaScript(`getComputedStyle(document.querySelector('[data-provider="text"] .test-result')).color`), await colorFor('--danger'));

    await win.webContents.executeJavaScript(`document.documentElement.dataset.appearance='light'`);
    failConnection = false;
    await click(`document.querySelector('[data-provider="text"] button.secondary:not(.model-fetch-button)')`, '浅色主题再次测试连接');
    await waitFor(`document.querySelector('[data-provider="text"] .test-result.success')`, '浅色主题连接成功反馈');
    assert.equal(await win.webContents.executeJavaScript(`getComputedStyle(document.querySelector('[data-provider="text"] .test-result')).color`), await colorFor('--success'));

    const appearance = defaultAppearance();
    appearance.current = { ...appearance.current, accent: '#487eaa', tint: '#b7c9d4' };
    appearance.presets = ['第一套', '第二套', '第三套'].map((name, index) => ({ id: `preset-${index}`, name, values: { ...appearance.current } })); appearance.active = 'preset-0';
    current.settings.prefs.appearance = appearance; await pushState();
    await click(`Array.from(document.querySelectorAll('.settings-navigation button')).find(node=>node.textContent.includes('外观'))`, '打开外观与主题');
    await waitFor(`document.querySelector('[data-settings-section="appearance"]').hidden===false`, '外观设置显示');
    const manage = await win.webContents.executeJavaScript(`(()=>{const row=document.querySelector('.appearance-preset-heading'),node=row.querySelector('button');return {label:node.getAttribute('aria-label'),width:node.getBoundingClientRect().width,icon:node.querySelector('svg').getBoundingClientRect().width,right:row.getBoundingClientRect().right-node.getBoundingClientRect().right};})()`);
    assert.equal(manage.label, '多选删除配色'); assert.ok(manage.width <= 26 && manage.icon <= 15 && Math.abs(manage.right) <= 1, '配色多选入口为标题右侧的小图标');
    await click(`document.querySelector('.appearance-preset-heading button')`, '进入配色多选');
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-preset="default"]').disabled`), true, '默认配色不能加入删除选择');
    await click(`document.querySelector('[data-preset="preset-0"]')`, '选择当前配色预设');
    assert.equal(current.settings.prefs.appearance.active, 'preset-0', '多选不触发配色切换');
    await click(`document.querySelector('.appearance-preset-toolbar button')`, '全选新增配色');
    assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.appearance-preset[aria-pressed=true]').length`), 3, '全选仅包括新增预设');
    win.setContentSize(300, 483);
    await win.webContents.executeJavaScript('Promise.all(document.getAnimations().filter(animation=>animation.effect?.getTiming().iterations!==Infinity).map(animation=>animation.finished.catch(()=>{})))');
    await win.webContents.executeJavaScript(`document.querySelector('.appearance-preset-heading').scrollIntoView({block:'start'});new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    await fs.writeFile(path.join(screenshots, '配色多选.png'), (await win.webContents.capturePage()).toPNG());
    await click(`document.querySelector('.appearance-preset-toolbar .is-danger')`, '请求批量删除配色');
    await click(`document.querySelector('.appearance-preset-confirm button')`, '取消配色删除');
    assert.equal(current.settings.prefs.appearance.presets.length, 3, '取消不改变已保存配色');
    await click(`document.querySelector('.appearance-preset-toolbar .is-danger')`, '再次请求删除配色');
    failAppearanceSave = true;
    await click(`document.querySelector('.appearance-preset-confirm .is-danger')`, '模拟删除配色保存失败');
    await waitFor(`document.querySelector('.appearance-notice.is-error')?.textContent.includes('虚构配色保存失败')`, '删除失败保留选择');
    assert.equal(current.settings.prefs.appearance.presets.length, 3);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.appearance-preset[aria-pressed=true]').length`), 3);
    failAppearanceSave = false;
    await click(`document.querySelector('.appearance-preset-confirm .is-danger')`, '重试批量删除配色');
    await waitFor(`document.querySelectorAll('.appearance-preset').length===1 && document.querySelector('.appearance-preset-selection').hidden`, '删除后只保留默认配色');
    assert.equal(current.settings.prefs.appearance.presets.length, 0);
    assert.deepEqual(current.settings.prefs.appearance.current, appearance.current, '删除当前预设后保留窗口颜色');
    assert.equal(current.settings.prefs.appearance.active, 'default');
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-preset="default"]').getAttribute('aria-pressed')`), 'false', '保留的自定义颜色不冒充默认配色');
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.appearance-preset-heading button').disabled`), true, '无新增预设时禁用删除入口');
    assert.deepEqual(remoteRequests, [], '隔离检查没有发出网络请求');
    assert.deepEqual(consoleErrors, [], 'renderer 没有脚本或样式错误');
    console.log('历史批量操作与设置界面隔离检查通过；所有服务请求由虚构 IPC 返回。');
    win.destroy(); app.exit(0);
  } catch (error) {
    console.error(error.stack || error.message);
    win?.destroy(); app.exit(1);
  }
});
