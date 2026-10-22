'use strict';
// 用真实 renderer 和隔离 IPC 检查 Markdown、复制目标和流式交互；剪贴板只用内存替身。
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { setTimeout: delay } = require('node:timers/promises');
app.setPath('userData', path.join(os.tmpdir(), `pickgloss-markdown-${process.pid}`));
const requestedRoot = process.argv.indexOf('--app-root');
const sourceRoot = requestedRoot < 0 ? path.join(__dirname, '..') : path.resolve(process.argv[requestedRoot + 1]);
const outputArg = process.argv.indexOf('--output-dir');
const outputRoot = outputArg < 0 ? path.join(__dirname, '../output/verification') : path.resolve(process.argv[outputArg + 1]);
const sample = [
  '## retain 的用法', '', '**保留**重要的信息，也可以表示*保持*某种状态。', '',
  '- retain a note', '  - 保留一条笔记', '- retain control', '',
  '> Please retain this note.', '',
  '| 表达 | 含义 |', '| :--- | ---: |', '| retain information | 保留信息 |', '',
  '行内代码：`const retained = true`。~~过时的说法~~', '',
  '```js', 'const retained = "<img src=x onerror=alert(1)>";', 'console.log(retained);', '```', '',
  '[参考链接](https://example.com/note)', '',
  '<script>window.markdownAttack = true</script>',
  '<img src="https://example.com/secret" onerror="window.markdownAttack=true">',
  '[危险链接](javascript:alert(1))',
  '[本地链接](file:///C:/Windows/notepad.exe)',
  '![图片说明](https://example.com/image.png)',
].join('\n');
let current, win, failCopy = false;
const copies = [], opens = [], consoleErrors = [];
ipcMain.handle('test:invoke', (_, action, payload) => {
  if (action === 'bootstrap') return { ok: true, value: current };
  if (action === 'copy-answer') {
    if (failCopy) return { ok: false, error: '隔离的剪贴板失败' };
    assert.equal(payload.id, current.session.id);
    const message = current.session.threads[payload.mode].messages.find(item => item.id === payload.messageId);
    copies.push({ ...payload, source: message.content });
  }
  if (action === 'open-link') opens.push(payload.url);
  return { ok: true };
});
async function push() {
  const done = new Promise(resolve => ipcMain.once('test:state-seen', resolve));
  win.webContents.send('test:state', current); await done;
}
async function clickCopy(duringClick) {
  const point = await win.webContents.executeJavaScript(`(() => { const b=document.querySelectorAll('[data-copy-answer]')[1]; b.scrollIntoView({block:'nearest'}); window.testCopyButton=b; const r=b.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}; })()`);
  for (const type of ['mouseDown', 'mouseUp']) {
    const seen = new Promise(resolve => {
      const listener = (_, name) => { if (name === type.toLowerCase()) { ipcMain.removeListener('test:input', listener); resolve(); } };
      ipcMain.on('test:input', listener);
    });
    win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 }); await seen;
    if (type === 'mouseDown' && duringClick) {
      await duringClick();
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('[data-copy-answer]')[1] === window.testCopyButton && window.testCopyButton.isConnected`), true,
        '流式落盘更新时间不能替换按下的复制按钮');
    }
  }
  await delay(35);
}
app.whenReady().then(async () => {
  const timeout = setTimeout(() => { console.error('Markdown 检查超时'); app.exit(1); }, 25000);
  try {
    win = new BrowserWindow({ show: false, width: 430, height: 690, useContentSize: true,
      webPreferences: { preload: path.join(__dirname, '../tests/renderer/streaming.preload.cjs'), contextIsolation: true, sandbox: true, backgroundThrottling: false, offscreen: true } });
    win.webContents.on('console-message', (_, details) => { if (details.level === 'error') consoleErrors.push(details.message); });
    const remoteRequests = [];
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => { remoteRequests.push(details.url); callback({ cancel: true }); });
    for (const mode of ['context', 'independent', 'visual']) {
      current = { view: 'explain', history: [], settings: { text: { baseUrl: 'http://127.0.0.1', model: '隔离测试' } }, session: {
        id: '固定测试会话', kind: mode === 'visual' ? 'image' : 'text', text: 'retain', context: 'Please retain this note.', updatedAt: '2026-10-16T00:00:00.000Z', activeMode: mode,
        threads: Object.fromEntries(['context', 'independent', 'visual'].map(name => [name, { status: 'streaming', draft: '', messages: [
          { id: '旧回答', role: 'assistant', content: sample, status: 'complete' },
          { id: '追问', role: 'user', content: '**用户原始问题**', status: 'complete' },
          { id: '新回答', role: 'assistant', content: '### 后续回答\n\n- **流式片段**', status: 'streaming' },
        ] }])) } };
      await win.loadFile(path.join(sourceRoot, 'src/renderer/index.html'));
      let ready = false;
      for (let i = 0; i < 100 && !ready; i++) { ready = await win.webContents.executeJavaScript(`Boolean(document.querySelector('.markdown-body h2'))`); if (!ready) await delay(10); }
      assert.ok(ready, '标题必须实际渲染为 Markdown');
      const result = await win.webContents.executeJavaScript(`(() => { const body=document.querySelector('.markdown-body'); return {heading:body.querySelector('h2')?.textContent,strong:body.querySelector('strong')?.textContent,table:body.querySelectorAll('table td').length,list:body.querySelectorAll('ul ul li').length,quote:Boolean(body.querySelector('blockquote')),code:body.querySelector('pre code')?.textContent,unsafe:body.querySelectorAll('script,img,iframe,object,[onclick],[onerror]').length,unsafeLinks:[...body.querySelectorAll('a')].filter(a=>!/^https?:/.test(a.href)).length,user:document.querySelector('.message.user .message-content').textContent,buttons:document.querySelectorAll('[data-copy-answer]').length,attack:Boolean(window.markdownAttack),overflow:document.documentElement.scrollWidth>innerWidth}; })()`);
      assert.equal(result.heading, 'retain 的用法'); assert.equal(result.strong, '保留'); assert.equal(result.table, 2); assert.equal(result.list, 1); assert.ok(result.quote);
      assert.match(result.code, /<img src=x onerror=alert\(1\)>/); assert.equal(result.unsafe, 0); assert.equal(result.unsafeLinks, 0); assert.equal(result.attack, false);
      assert.equal(result.user, '**用户原始问题**'); assert.equal(result.buttons, 2); assert.equal(result.overflow, false);
      const before = copies.length;
      await clickCopy(async () => { current.session.threads[mode].messages[2].content += '\n- 第二个片段'; current.session.updatedAt = '2026-10-16T00:00:01.000Z'; await push(); });
      assert.equal(copies.length, before + 1, '流式更新期间单击复制不能丢失');
      assert.equal(copies.at(-1).mode, mode); assert.equal(copies.at(-1).messageId, '新回答');
      assert.equal(copies.at(-1).source, current.session.threads[mode].messages[2].content);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.copy-label')[1].textContent`), '已复制');
      if (mode === 'context') {
        failCopy = true; await clickCopy(); failCopy = false;
        assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.copy-label')[1].textContent`), '复制失败，请重试');
        assert.equal(copies.length, before + 1);
        await fs.mkdir(outputRoot, { recursive: true });
        await win.webContents.executeJavaScript(`document.querySelector('[data-scroll="body"]').scrollTop=0`);
        await win.webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
        await fs.writeFile(path.join(outputRoot, 'Markdown回答-顶部.png'), (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
        await win.webContents.executeJavaScript(`document.querySelector('[data-copy-answer]').scrollIntoView({block:'end'})`);
        await win.webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
        await fs.writeFile(path.join(outputRoot, 'Markdown回答-代码与复制.png'), (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
      }
      current.session.threads[mode].messages[2].status = 'stopped'; current.session.threads[mode].status = 'stopped'; await push();
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.markdown-body h3').length`), 1, '停止片段也按 Markdown 显示');
    }
    assert.deepEqual(remoteRequests, [], '显示回答不应自动加载远程资源');
    assert.deepEqual(opens, [], '显示回答不应自动打开链接');
    assert.deepEqual(consoleErrors, [], '页面不应产生加载或脚本错误');
    console.log('Markdown 三模式渲染、流式复制、失败反馈、内容隔离及安全检查通过；实际剪贴板未修改。');
    clearTimeout(timeout); win.destroy(); app.exit(0);
  } catch (error) { console.error(error.stack); clearTimeout(timeout); win?.destroy(); app.exit(1); }
});
