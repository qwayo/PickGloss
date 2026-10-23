'use strict';
// 真实界面搭配隔离 IPC 数据检查交互；不访问用户会话、剪贴板、服务或回收站。
const { quoteJavaScriptString } = require('./javascript-string.cjs');
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const { setTimeout: delay } = require('node:timers/promises');
const { historyEntry, queryHistory } = require('../src/core/history.cjs');
app.setPath('userData', path.join(os.tmpdir(), `pickgloss-history-ui-${process.pid}`));
const rows = Array.from({ length: 60 }, (_, index) => ({
  id: `隔离会话-${index}`, kind: 'text', text: `原始材料 ${index}`, title: '', note: '',
  context: index === 0 ? '段落专属关键词' : '', saved: false, activeMode: 'context',
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
  updatedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
  lastActivityAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
  threads: { context: { messages: [], draft: '未发送的草稿不参与搜索' },
    independent: { messages: index === 0 ? [{ id: '独立回答', role: 'assistant', content: 'HiddenModeNeedle' }] : [], draft: '' },
    visual: { messages: [], draft: '' } },
}));
let win, query = '', savedOnly = false, removed, trashFailOnce = true;
const errors = [];
const snapshot = () => ({ view: 'history', session: null, settings: { text: {}, vision: {} }, status: {},
  history: queryHistory(rows.map(historyEntry), { query, savedOnly }), historyQuery: query, historySavedOnly: savedOnly });
ipcMain.handle('test:invoke', async (_, action, payload) => {
  if (action === 'bootstrap') return { ok: true, value: snapshot() };
  if (action === 'search-history') { query = payload.query; savedOnly = payload.savedOnly; }
  else if (action === 'rename-session') rows.find(row => row.id === payload.id).title = payload.title.trim();
  else if (action === 'favorite') rows.find(row => row.id === payload.id).saved = payload.saved;
  else if (action === 'delete-session') {
    if (trashFailOnce) { trashFailOnce = false; return { ok: false, error: '隔离注入：回收站不可用，原数据保留。' }; }
    removed = rows.splice(rows.findIndex(row => row.id === payload.id), 1)[0];
  }
  else if (action !== 'refresh-history') throw new Error(`隔离界面出现未预期操作：${action}`);
  win.webContents.send('test:state', snapshot());
  return { ok: true };
});
const run = code => win.webContents.executeJavaScript(code);
async function until(expression) {
  for (let attempt = 0; attempt < 100; attempt++) { if (await run(expression)) return; await delay(10); }
  throw new Error(`界面未达到预期状态：${expression}`);
}
async function search(value, count) {
  await run(`(() => { const input=document.querySelector('[data-field="history-search"]'); input.value=${quoteJavaScriptString(value)}; input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await until(`document.querySelector('.history-count')?.textContent === '${count} 个会话'`);
}
app.whenReady().then(async () => {
  const timeout = setTimeout(() => { console.error('会话管理隔离检查超时'); app.exit(1); }, 30000);
  try {
    win = new BrowserWindow({ show: false, width: 300, height: 483, useContentSize: true, webPreferences: {
      preload: path.join(__dirname, '../tests/renderer/streaming.preload.cjs'), contextIsolation: true, sandbox: true, offscreen: true, backgroundThrottling: false,
    } });
    win.webContents.on('console-message', (_, details) => { if (details.level === 'error') errors.push(details.message); });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_, callback) => callback({ cancel: true }));
    await win.loadFile(path.join(__dirname, '../src/renderer/index.html'));
    await until(`document.querySelectorAll('.history-item').length === 50`);
    await run(`document.querySelector('.history-more').click()`);
    assert.equal(await run(`document.querySelectorAll('.history-item').length`), 60);
    await run(`[...document.querySelector('.history-item').querySelectorAll('button')].find(button=>button.textContent==='改名').click()`);
    await until(`Boolean(document.querySelector('.history-rename input'))`);
    await run(`(() => { const input=document.querySelector('.history-rename input'); input.value='我的阅读标题'; input.dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('.history-rename').requestSubmit(); })()`);
    await until(`!document.querySelector('.history-rename') && document.querySelector('.history-title')?.textContent === '我的阅读标题'`);
    assert.equal(rows[59].text, '原始材料 59');
    await search('我的阅读标题', 1);
    await search('段落专属', 1);
    await search('hiddenmodeneedle', 1);
    assert.equal(await run(`document.querySelector('.history-title').textContent`), '原始材料 0', '搜索必须覆盖尚未加载的记录及另一模式');
    await run(`[...document.querySelectorAll('[role="tab"]')].find(button=>button.textContent==='手动收藏').click()`);
    await until(`document.querySelector('.history-count')?.textContent === '0 个会话'`);
    await run(`[...document.querySelectorAll('[role="tab"]')].find(button=>button.textContent==='全部会话').click()`);
    await until(`document.querySelector('.history-count')?.textContent === '1 个会话'`);
    await search('未发送的草稿', 0);
    await search('', 60);
    await run(`[...document.querySelector('.history-item').querySelectorAll('button')].find(button=>button.textContent==='移到回收站').click()`);
    await run(`[...document.querySelector('.delete-confirm').querySelectorAll('button')].find(button=>button.textContent==='取消').click()`);
    assert.equal(rows.length, 60, '取消确认不应发出删除动作');
    await run(`[...document.querySelector('.history-item').querySelectorAll('button')].find(button=>button.textContent==='移到回收站').click()`);
    await run(`[...document.querySelector('.delete-confirm').querySelectorAll('button')].find(button=>button.textContent==='确认移到回收站').click()`);
    await until(`document.querySelector('.inline-error')?.textContent.includes('回收站不可用')`);
    assert.equal(rows.length, 60, '宿主回收站失败后应保留会话并允许重试');
    await run(`[...document.querySelector('.delete-confirm').querySelectorAll('button')].find(button=>button.textContent==='确认移到回收站').click()`);
    await until(`document.querySelector('.history-count')?.textContent === '59 个会话'`);
    rows.push(removed);
    await run(`document.querySelector('[aria-label="刷新历史"]').click()`);
    await until(`document.querySelector('.history-count')?.textContent === '60 个会话'`);
    assert.equal(await run(`document.querySelector('.history-title').textContent`), '我的阅读标题');
    assert.equal(await run(`document.documentElement.scrollWidth > innerWidth`), false);
    await run(`[...document.querySelector('.history-item').querySelectorAll('button')].find(button=>button.textContent==='改名').click()`);
    await fs.mkdir(path.join(__dirname, '../output/verification'), { recursive: true });
    await run(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    await fs.writeFile(path.join(__dirname, '../output/verification/会话管理-最小实现.png'), (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
    assert.deepEqual(errors, []);
    console.log('会话管理隔离界面检查通过：改名、完整搜索、分页、收藏筛选、删除取消、回收站失败提示与重试、还原后刷新及 300 像素窗口布局。非性能测试，非真实回收站或人工验收。');
    clearTimeout(timeout); win.destroy(); app.exit(0);
  } catch (error) { console.error(error.stack); clearTimeout(timeout); win?.destroy(); app.exit(1); }
});
