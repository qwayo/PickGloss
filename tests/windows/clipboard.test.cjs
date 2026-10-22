'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness() {
  const writes = [], opened = [];
  const app = { setPath() {}, getPath: () => '', setName() {}, setAppUserModelId() {}, requestSingleInstanceLock: () => true, on() {}, whenReady: () => new Promise(() => {}) };
  const electron = { app, clipboard: { writeText: value => writes.push(value) }, shell: { openExternal: async value => opened.push(value) } };
  const selected = { id: '会话A', kind: 'text', threads: {
    context: { messages: [{ id: '回答A', role: 'assistant', status: 'stopped', content: '## 标题\r\n\r\n**粗体** 和 `代码`\n\n```js\nconst x = 1;\n```\n' }, { id: '问题A', role: 'user', content: '问题' }] },
    independent: { messages: [{ id: '回答B', role: 'assistant', status: 'streaming', content: '- 独立释义\n- 部分回答 **' }, { id: '空回答', role: 'assistant', content: '' }] },
  } };
  const context = { require: name => name === 'electron' ? electron : name.startsWith('./') ? {} : require(name), process: { argv: [], env: {}, pid: 1 }, URL, setTimeout, clearTimeout, selected };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../src/main.cjs'), 'utf8') + '\ncache.set(selected.id,selected); globalThis.handle = handle;', context);
  return { handle: context.handle, writes, opened, selected };
}

test('复制回答仅取指定会话模式的原始 Markdown，精确保留换行和围栏', async () => {
  const app = harness();
  assert.equal(app.writes.length, 0);
  await app.handle('copy-answer', { id: '会话A', mode: 'context', messageId: '回答A', content: '不能用界面参数替换实际回答' });
  await app.handle('copy-answer', { id: '会话A', mode: 'independent', messageId: '回答B' });
  assert.deepEqual(app.writes, [app.selected.threads.context.messages[0].content, app.selected.threads.independent.messages[0].content]);
});

test('复制拒绝错误归属、用户消息和空回答，不覆盖剪贴板', async () => {
  const app = harness();
  for (const payload of [
    { id: '不存在', mode: 'context', messageId: '回答A' },
    { id: '会话A', mode: 'independent', messageId: '回答A' },
    { id: '会话A', mode: 'context', messageId: '问题A' },
    { id: '会话A', mode: 'independent', messageId: '空回答' },
    { id: '会话A', mode: 'visual', messageId: '回答A' },
  ]) await assert.rejects(app.handle('copy-answer', payload));
  assert.deepEqual(app.writes, []);
});

test('Markdown 链接只允许 HTTP 和 HTTPS，不执行脚本或本地文件', async () => {
  const app = harness();
  for (const url of ['javascript:alert(1)', 'file:///C:/Windows/notepad.exe', 'data:text/html,test', 'ms-settings:', 'relative/path']) await assert.rejects(app.handle('open-link', { url }));
  await app.handle('open-link', { url: 'https://example.com/note?q=1' });
  assert.deepEqual(app.opened, ['https://example.com/note?q=1']);
});
