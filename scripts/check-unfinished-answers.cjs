'use strict';
// 用正式 Electron 渲染器与固定虚构会话核对旧回答状态；IPC 不访问真实服务或用户数据。
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { setTimeout: delay } = require('node:timers/promises');

app.setPath('userData', path.join(os.tmpdir(), `pickgloss-unfinished-${process.pid}`));
const rootArg = process.argv.indexOf('--app-root');
const sourceRoot = rootArg < 0 ? path.join(__dirname, '..') : path.resolve(process.argv[rootArg + 1]);
const thread = { status: 'stopped', draft: '', messages: [
  { id: '旧停止', role: 'assistant', content: '停止前的片段', status: 'stopped' },
] };
const current = {
  view: 'explain', history: [], settings: { text: { baseUrl: 'http://127.0.0.1', model: '隔离测试' } },
  session: { id: '固定会话', kind: 'text', text: 'retain', context: 'Please retain this note.', activeMode: 'context',
    threads: { context: thread, independent: { status: 'idle', draft: '', messages: [] } } },
};
let win;
const actions = [];
async function push() {
  const seen = new Promise(resolve => ipcMain.once('test:state-seen', resolve));
  win.webContents.send('test:state', current);
  await seen;
}
ipcMain.handle('test:invoke', async (_, action, payload) => {
  actions.push({ action, payload });
  if (action === 'bootstrap') return { ok: true, value: current };
  if (action === 'set-draft') { thread.draft = payload.draft; return { ok: true }; }
  if (action === 'send-question') {
    thread.messages.push({ id: '追问', role: 'user', content: payload.question, status: 'complete' },
      { id: '追问成功', role: 'assistant', content: '追问已有完整回答', status: 'complete' });
    thread.status = 'done'; thread.draft = '';
    await push();
  }
  if (action === 'start-explanation') {
    thread.messages.push({ id: '重试成功', role: 'assistant', content: '重试已有完整回答', status: 'complete' });
    thread.status = 'done'; thread.error = '';
    await push();
  }
  if (action === 'open-history') {
    current.view = 'history';
    current.history = [{ id: current.session.id, title: '固定会话', kind: 'text', modesWithMessages: ['context'], createdAt: '2026-10-16T00:00:00.000Z' }];
    await push();
  }
  if (action === 'open-session') { current.view = 'explain'; await push(); }
  return { ok: true };
});
async function waitFor(expression, description) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await win.webContents.executeJavaScript(expression)) return;
    await delay(10);
  }
  throw new Error(`等待${description}超时`);
}
async function visibleStates() {
  return win.webContents.executeJavaScript(`Object.fromEntries([...document.querySelectorAll('.conversation .message.assistant')].map(node => [node.dataset.message, node.querySelector('.message-state')?.textContent || '']))`);
}

app.whenReady().then(async () => {
  const watchdog = setTimeout(() => { console.error('未完成回答检查超时'); app.exit(1); }, 15000);
  try {
    win = new BrowserWindow({ show: false, width: 430, height: 690, useContentSize: true,
      webPreferences: { preload: path.join(__dirname, '../tests/renderer/streaming.preload.cjs'), contextIsolation: true, sandbox: true, backgroundThrottling: false, offscreen: true } });
    await win.loadFile(path.join(sourceRoot, 'src/renderer/index.html'));
    await waitFor(`Boolean(document.querySelector('[data-message="旧停止"]'))`, '已停止回答');
    assert.match((await visibleStates())['旧停止'], /未完成.*已停止/, '旧停止回答须逐条标记');

    await win.webContents.executeJavaScript(`(() => { const input=document.querySelector('[data-field="question"]'); input.value='继续追问'; input.dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('[title="发送追问"]').click(); })()`);
    await waitFor(`Boolean(document.querySelector('[data-message="追问成功"]'))`, '追问成功');
    let states = await visibleStates();
    assert.match(states['旧停止'], /未完成.*已停止/, '成功追问后旧停止状态须保留');
    assert.equal(states['追问成功'], '', '完整回答不应标记为未完成');

    thread.messages.push({ id: '旧失败', role: 'assistant', content: '失败前的片段', status: 'error' });
    thread.status = 'error'; thread.error = '隔离的服务故障';
    await push();
    assert.match((await visibleStates())['旧失败'], /未完成.*失败/, '失败回答须逐条标记');
    await win.webContents.executeJavaScript(`document.querySelector('.notice [title="重试"]').click()`);
    await waitFor(`Boolean(document.querySelector('[data-message="重试成功"]'))`, '重试成功');
    states = await visibleStates();
    assert.match(states['旧停止'], /未完成.*已停止/);
    assert.match(states['旧失败'], /未完成.*失败/, '成功重试后旧失败状态须保留');
    assert.equal(states['重试成功'], '');
    assert.equal(actions.filter(item => item.action === 'start-explanation').length, 1);
    assert.equal(thread.messages.filter(message => message.role === 'user').length, 1, '重试不得重复追问');

    await win.webContents.executeJavaScript(`document.querySelector('[title="历史"]').click()`);
    await waitFor(`Boolean(document.querySelector('[title="打开会话"]'))`, '历史会话');
    await win.webContents.executeJavaScript(`document.querySelector('[title="打开会话"]').click()`);
    await waitFor(`Boolean(document.querySelector('[data-message="重试成功"]'))`, '重开会话');
    states = await visibleStates();
    assert.match(states['旧停止'], /未完成.*已停止/, '历史重开仍显示旧停止状态');
    assert.match(states['旧失败'], /未完成.*失败/, '历史重开仍显示旧失败状态');
    assert.equal(states['重试成功'], '');
    console.log('未完成回答检查通过：成功追问、重试及历史重开后，旧停止／失败回答逐条保留状态。');
    clearTimeout(watchdog); win.destroy(); app.exit(0);
  } catch (error) { console.error(error.stack); clearTimeout(watchdog); win?.destroy(); app.exit(1); }
});
