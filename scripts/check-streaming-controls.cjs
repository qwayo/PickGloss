'use strict';
// 使用实际 Electron DOM 和鼠标事件，在按下与松开之间确定性插入流式状态。
// 窗口隐藏、数据隔离，测试桥不调用实际模型，也不读取用户数据。
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const { setTimeout: delay } = require('node:timers/promises');
app.setPath('userData', path.join(os.tmpdir(), `pickgloss-stream-controls-${process.pid}`));
const rootArg = process.argv.indexOf('--app-root');
const sourceRoot = rootArg < 0 ? path.join(__dirname, '..') : path.resolve(process.argv[rootArg + 1]);
const outputArg = process.argv.indexOf('--output-dir');
const outputRoot = outputArg < 0 ? path.join(__dirname, '../build') : path.resolve(process.argv[outputArg + 1]);
const initial = () => ({
  view: 'explain', history: [], settings: { text: { baseUrl: 'http://127.0.0.1', model: '隔离测试' } },
  session: { id: '测试会话', kind: 'text', text: 'retain', context: 'Please retain this note.', updatedAt: '2026-10-16T00:00:00.000Z', activeMode: 'context',
    threads: { context: { status: 'streaming', messages: [{ id: '测试回答', role: 'assistant', content: '已经生成的片段。', status: 'streaming' }], draft: '' }, independent: { messages: [], draft: '' } } },
});
let current, win;
const calls = [], report = [];
ipcMain.handle('test:invoke', (_, action, payload) => {
  calls.push({ action, payload });
  return { ok: true, value: action === 'bootstrap' ? current : undefined };
});
async function push() {
  const seen = new Promise(resolve => ipcMain.once('test:state-seen', resolve));
  win.webContents.send('test:state', current);
  await seen;
}
async function input(type, x, y) {
  const wanted = type.toLowerCase();
  const seen = new Promise(resolve => {
    const listener = (_, name) => { if (name === wanted) { ipcMain.removeListener('test:input', listener); resolve(); } };
    ipcMain.on('test:input', listener);
  });
  win.webContents.sendInputEvent({ type, x, y, button: 'left', clickCount: 1 });
  await seen;
}
app.whenReady().then(async () => {
  const watchdog = setTimeout(() => { console.error('界面交互检查超时'); app.exit(1); }, 20000);
  try {
    const width = Number(process.argv.find(arg => arg.startsWith('--width='))?.split('=')[1]) || 430;
    win = new BrowserWindow({ show: false, width, height: width < 300 ? 345 : 690, useContentSize: true,
      webPreferences: { preload: path.join(__dirname, '../tests/renderer/streaming.preload.cjs'), contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    for (const mode of ['context', 'independent', 'visual']) {
      const label = '停止回答';
      current = initial(); calls.length = 0;
      const active = current.session;
      active.activeMode = mode;
      active.kind = mode === 'visual' ? 'image' : 'text';
      active.threads[mode] = structuredClone(active.threads.context);
      active.threads[mode].messages[0].content = '';
      await win.loadFile(path.join(sourceRoot, 'src/renderer/index.html'));
      const selector = `[title="${label}"]`;
      let point;
      for (let attempt = 0; attempt < 100 && !point; attempt++) {
        point = await win.webContents.executeJavaScript(`(() => { const b = document.querySelector(${JSON.stringify(selector)}); if (!b) return null; b.scrollIntoView({block:'nearest'}); const r = b.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2)}; })()`);
        if (!point) await delay(10);
      }
      assert.ok(point, '停止控件应出现');
      const progressCheck = `(()=>{const progress=document.querySelector('.stream-status');return document.querySelectorAll('.stream-status').length===1&&Boolean(progress?.querySelector('.stream-dot'))&&progress.closest('.message')===document.querySelector('.message.assistant')&&document.querySelectorAll('.answer-actions').length===0&&document.querySelector('.message-content').textContent==='';})()`;
      assert.equal(await win.webContents.executeJavaScript(progressCheck), true, '空回答只显示一处呼吸圆点提示，不显示回答操作栏');
      if (mode === 'context') {
        await fs.mkdir(outputRoot, { recursive: true });
        await win.webContents.executeJavaScript(`Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))`);
        for (let attempt=0;attempt<4;attempt++) {
          await win.webContents.executeJavaScript(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
          try { await fs.writeFile(path.join(outputRoot, '单一生成提示.png'), (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());break; }
          catch(error) { if(attempt===3)throw error;await delay(50); }
        }
      }
      current.session.updatedAt='2026-10-16T00:00:00.500Z';
      await push();
      assert.equal(await win.webContents.executeJavaScript(progressCheck), true, '空片段增量不能重新生成重复的纯文字占位');
      current.session.threads[mode].messages[0].content='开始生成的内容。';
      await push();
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.stream-status,.stream-dot').length`), 0, '首段回答出现后立即移除正在解释和呼吸圆点');
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.answer-actions').length`), 0, '首段出现后仍隐藏复制和重新解释');
      current.session.source={app:'隔离来源'};
      await push();
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.stream-status,.stream-dot').length`), 0, '已有内容时完整重绘也不再显示正在解释');
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.answer-pane [title="停止"]').length`), 0, '内容区不重复提供停止按钮');
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.answer-actions').length`), 0, '生成中完整重绘仍不显示回答操作栏');
      await win.webContents.executeJavaScript(`window.testPressedButton = document.querySelector(${JSON.stringify(selector)})`);
      await input('mouseDown', point.x, point.y);
      if (!process.argv.includes('--no-stream')) {
        current.session.threads[mode].messages[0].content += '新的流式片段。';
        current.session.updatedAt = '2026-10-16T00:00:01.000Z';
        current.history = [{ id: active.id, updatedAt: '2026-10-16T00:00:01.000Z' }];
        await push();
      }
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.stream-status,.stream-dot').length`), 0, '继续输出内容时不再显示正在解释');
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.answer-actions').length`), 0, '继续输出时也不提前显示复制和重新解释');
      const retained = await win.webContents.executeJavaScript(`(() => { const b=document.querySelector(${JSON.stringify(selector)}); const r=b.getBoundingClientRect(); return {同一个按钮:b===window.testPressedButton, 原点击仍在按钮范围:${point.x}>=r.left && ${point.x}<=r.right && ${point.y}>=r.top && ${point.y}<=r.bottom}; })()`);
      await input('mouseUp', point.x, point.y);
      await delay(30);
      const stops = calls.filter(call => call.action === 'stop');
      report.push({ 模式: mode, 控件: label, 单次按下松开: true, 期间推送片段与落盘时间: !process.argv.includes('--no-stream'), ...retained, 停止请求数: stops.length });
      assert.equal(retained.同一个按钮, true, '流式落盘更新时间不能替换按下的停止按钮');
      if (stops.length) assert.deepEqual(stops[0].payload, { id: active.id, mode }, '停止应只发送到当前会话和模式');
      const partial = current.session.threads[mode].messages[0].content;
      current.session.threads[mode].status = 'stopped';
      current.session.threads[mode].messages[0].status = 'stopped';
      await push();
      const stopped = await win.webContents.executeJavaScript(`({text:document.querySelector('.message-content').textContent,status:document.querySelector('.stream-status').textContent,stopButtons:document.querySelectorAll('[title="停止回答"], [title="停止"]').length})`);
      assert.equal(stopped.text, partial, '停止状态应显示已有片段');
      assert.match(stopped.status, /已停止/);
      assert.equal(stopped.stopButtons, 0, '停止后不应残留生成中的控件');
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.answer-actions button').length`), 2, '停止后显示复制和重新解释，以便处理已有内容');
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.answer-pane [title="重新解释"]').length`), 1, '重新解释只出现在最新回答操作行');
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.answer-actions [title="重新解释"]').textContent`), '', '重新解释仅显示图标');
      await win.webContents.executeJavaScript(`document.querySelector('.answer-actions [title="重新解释"]').click()`);
      for (let attempt=0;attempt<100&&!calls.some(c=>c.action==='start-explanation');attempt++) await delay(10);
      assert.deepEqual(calls.filter(c=>c.action==='start-explanation').map(c=>c.payload), [{id:active.id,mode}], '重新解释图标调用当前会话与模式');
    }
    // 长回答增量保持输入节点与滚动位置；模式或完成状态变化不能被误当成文字增量。
    current = initial(); await push();
    await win.webContents.executeJavaScript(`window.testComposer = document.querySelector('[data-field="question"]'); window.testComposer.focus();`);
    current.session.threads.context.messages[0].content += '\n较长的流式片段。'.repeat(100);
    await push();
    assert.equal(await win.webContents.executeJavaScript(`document.activeElement === window.testComposer && window.testComposer.isConnected`), true, '流式文字更新不能使输入框失焦');
    await win.webContents.executeJavaScript(`document.querySelector('[data-scroll="body"]').scrollTop = 0`);
    current.session.threads.context.messages[0].content += '\n继续生成。';
    await push();
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-scroll="body"]').scrollTop`), 0, '阅读前文时不应强行滚到底部');
    current.session.activeMode = 'independent'; await push();
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-field="question"]').dataset.mode`), 'independent', '切换模式应完整更新输入框归属');
    current.session.activeMode = 'context';
    current.session.threads.context.status = 'done';
    current.session.threads.context.messages[0].status = 'complete';
    await push();
    assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('[title="停止回答"], [title="停止"]').length`), 0, '完成时应正常退出生成状态');
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.answer-actions [title="重新解释"]')?.disabled`), false, '生成完成后可重新解释');
    assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.answer-actions button').length`), 2, '全部生成完成后同时显示复制和重新解释');
    current.session.threads.context.status='error';
    current.session.threads.context.messages[0].status='error';
    await push();
    assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.answer-actions button').length`), 2, '请求失败后仍提供已有内容的复制和重新解释入口');
    current.session.threads.context.status='done';
    current.session.threads.context.messages[0].status='complete';
    current.session.threads.context.messages.push({id:'测试追问',role:'user',content:'继续解释'}, {id:'最新回答',role:'assistant',status:'complete',content:'最新的回答内容。'});
    await push();
    assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.answer-actions [title="重新解释"]').length`),1,'多轮对话中仅最新回答提供重新解释');
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[title="重新解释"]').closest('.message').dataset.message`),'最新回答');
    const startAt=calls.length;
    await win.webContents.executeJavaScript(`(()=>{const input=document.querySelector('[data-field="question"]');input.value='重新解释时保留的草稿';input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[title="重新解释"]').click()})()`);
    for(let attempt=0;attempt<100&&!calls.slice(startAt).some(c=>c.action==='start-explanation');attempt++)await delay(10);
    const restartCalls=calls.slice(startAt);
    assert.ok(restartCalls.findIndex(c=>c.action==='set-draft')>=0&&restartCalls.findIndex(c=>c.action==='set-draft')<restartCalls.findIndex(c=>c.action==='start-explanation'),'重新解释前先保存未发送的追问草稿');
    assert.equal(restartCalls.some(c=>c.action==='send-question'),false,'重新解释不发送追问草稿');
    console.log(JSON.stringify(report, null, 2));
    await fs.mkdir(outputRoot, { recursive: true });
    await fs.writeFile(path.join(outputRoot, 'streaming-controls.json'), JSON.stringify(report, null, 2));
    assert.ok(report.every(item => item.停止请求数 === 1), '持续生成期间单击一次应发送且只发送一次停止请求');
    console.log('流式回答期间停止控件交互检查通过。');
    clearTimeout(watchdog); win.destroy(); app.exit(0);
  } catch (error) { console.error(error.message); clearTimeout(watchdog); win?.destroy(); app.exit(1); }
});
