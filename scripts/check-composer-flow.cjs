'use strict';
// 在隐藏的正式 Electron 渲染器里重放输入事件；IPC 和模型由固定样本替代。
const { quoteJavaScriptString } = require('./javascript-string.cjs');
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { setTimeout: delay } = require('node:timers/promises');
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, '../tests/fixtures/ticket-16-interaction.json'), 'utf8'));
const rootArg = process.argv.indexOf('--app-root');
const sourceRoot = rootArg < 0 ? path.join(__dirname, '..') : path.resolve(process.argv[rootArg + 1]);
app.setPath('userData', path.join(os.tmpdir(), `pickgloss-composer-${process.pid}`));
const calls = [];
const current = {
  view: 'explain', history: [], settings: { text: { baseUrl: 'http://127.0.0.1', model: '隔离测试' } },
  session: {
    id: fixture.sessionId, kind: 'text', text: fixture.text, context: fixture.context, activeMode: 'context',
    threads: { context: { status: 'complete', messages: [], draft: '' }, independent: { status: 'idle', messages: [], draft: '' } },
  },
};
let win;
ipcMain.handle('test:invoke', async (_, action, payload) => {
  calls.push({ action, payload });
  if (action === 'bootstrap') return { ok: true, value: current };
  if (action === 'set-draft') {
    await delay(90);
    current.session.threads[payload.mode].draft = payload.draft;
  }
  if (action === 'set-note') current.session.note = payload.note;
  if (action === 'set-mode') current.session.activeMode = payload.mode;
  if (action === 'open-settings') current.view = 'settings';
  if (action === 'navigate') current.view = payload.view;
  if (['set-mode', 'open-settings', 'navigate'].includes(action)) win.webContents.send('test:state', current);
  return { ok: true };
});
async function waitFor(script, description) {
  for (let i = 0; i < 100; i++) {
    if (await win.webContents.executeJavaScript(script)) return;
    await delay(10);
  }
  throw Error(`等待${description}超时`);
}
app.whenReady().then(async () => {
  const watchdog = setTimeout(() => { console.error('追问输入检查超时'); app.exit(1); }, 15000);
  try {
    win = new BrowserWindow({ show: false, width: 430, height: 690, useContentSize: true,
      webPreferences: { preload: path.join(__dirname, '../tests/renderer/streaming.preload.cjs'), contextIsolation: true, sandbox: true, backgroundThrottling: false, offscreen: true } });
    await win.loadFile(path.join(sourceRoot, 'src/renderer/index.html'));
    await waitFor(`Boolean(document.querySelector('[data-field="question"]'))`, '追问框');
    const composition = await win.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('[data-field="question"]');
      input.focus(); input.value = ${quoteJavaScriptString(fixture.contextQuestion)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const key = options => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...options }));
      const composing = key({ isComposing: true });
      input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      const stillComposing = key({});
      input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
      const confirmed = key({});
      return { composing, stillComposing, confirmed, focused: document.activeElement === input };
    })()`);
    assert.equal(composition.composing, true, '输入法组合 Enter 不得拦截');
    assert.equal(composition.stillComposing, true, '候选确认时不得拦截');
    assert.equal(composition.confirmed, false, '组合结束紧接的候选确认 Enter 不得发送或插入额外换行');
    assert.equal(calls.filter(call => call.action === 'send-question').length, 0);
    await delay(20);
    const interactions = await win.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('[data-field="question"]');
      const key = options => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...options }));
      const newline = key({ shiftKey: true });
      key({}); key({});
      return { newline, focused: document.activeElement === input };
    })()`);
    assert.equal(interactions.newline, true, 'Shift+Enter 应保留换行输入');
    await delay(350);
    const sent = calls.filter(call => call.action === 'send-question');
    assert.equal(sent.length, 1, '保存尚未完成时连续 Enter 只能发送一条追问');
    assert.deepEqual(sent[0].payload, { id: fixture.sessionId, mode: 'context', question: fixture.contextQuestion });
    assert.equal(calls.filter(call => call.action === 'set-draft').length, 1);
    await win.webContents.executeJavaScript(`(() => { const input=document.querySelector('[data-field="question"]'); input.value='语境模式未发送草稿'; input.dispatchEvent(new Event('input',{bubbles:true})); document.querySelectorAll('.mode-tabs button')[1].click(); })()`);
    await waitFor(`document.querySelector('[data-field="question"]')?.dataset.mode==='independent'`, '独立释义');
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-field="question"]').value`), '');
    await win.webContents.executeJavaScript(`(() => { const input=document.querySelector('[data-field="question"]'); input.value=${quoteJavaScriptString(fixture.independentDraft)}; input.dispatchEvent(new Event('input',{bubbles:true})); document.querySelectorAll('.mode-tabs button')[0].click(); })()`);
    await waitFor(`document.querySelector('[data-field="question"]')?.dataset.mode==='context'`, '语境解释');
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-field="question"]').value`), '语境模式未发送草稿');
    await win.webContents.executeJavaScript(`document.querySelector('.panel-footer .provider').click()`);
    await waitFor(`Boolean(document.querySelector('.settings-section'))`, '服务设置');
    const savedDrafts = calls.filter(call => call.action === 'set-draft').map(call => call.payload);
    assert.ok(savedDrafts.some(item => item.id === fixture.sessionId && item.mode === 'context' && item.draft === '语境模式未发送草稿'));
    assert.ok(savedDrafts.some(item => item.id === fixture.sessionId && item.mode === 'independent' && item.draft === fixture.independentDraft));
    await win.webContents.executeJavaScript(`document.querySelector('[title="返回"]').click()`);
    await waitFor(`document.querySelector('[data-field="question"]')?.dataset.mode==='context'`, '设置返回');
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-field="question"]').value`), '语境模式未发送草稿');

    current.view = 'preview';
    current.session = { id: '工单16固定截图会话', kind: 'image', imageData: fixture.imageData, note: '', activeMode: 'visual', threads: { visual: { status: 'idle', messages: [], draft: '' } } };
    await win.loadFile(path.join(sourceRoot, 'src/renderer/index.html'));
    await waitFor(`Boolean(document.querySelector('[data-field="image-note"]'))`, '截图说明');
    await win.webContents.executeJavaScript(`(() => { const input=document.querySelector('[data-field="image-note"]'); input.value=${quoteJavaScriptString(fixture.imageNote)}; input.dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('.panel-footer .provider').click(); })()`);
    await waitFor(`Boolean(document.querySelector('.settings-section'))`, '截图服务设置');
    assert.ok(calls.some(call => call.action === 'set-note' && call.payload.id === current.session.id && call.payload.note === fixture.imageNote));
    await win.webContents.executeJavaScript(`document.querySelector('[title="返回"]').click()`);
    await waitFor(`Boolean(document.querySelector('[data-field="image-note"]'))`, '截图预览返回');
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-field="image-note"]').value`), fixture.imageNote);
    console.log('隐藏 Electron 输入检查通过：组合结束后的确认 Enter、Shift+Enter 未拦截、连续 Enter 单次发送、双模式草稿与截图说明设置往返。');
    clearTimeout(watchdog); win.destroy(); app.exit(0);
  } catch (error) { console.error(error.stack); clearTimeout(watchdog); win?.destroy(); app.exit(1); }
});
