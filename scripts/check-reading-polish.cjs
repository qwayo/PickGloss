'use strict';
// 正式渲染器中的阅读区检查；只使用虚构材料与 IPC 替身，不接入真实数据和服务。
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { defaultAppearance } = require('../src/core/appearance.cjs');
const outputOption = process.argv.indexOf('--output-dir');
const output = outputOption >= 0 ? path.resolve(process.argv[outputOption + 1]) : path.resolve(__dirname, '../output/verification/reading-polish-20261021');
const before = process.argv.includes('--before');
app.setPath('userData', path.join(os.tmpdir(), `pickgloss-reading-polish-${process.pid}`));
const windows = [], calls = [], errors = [];
let fixture = { view: 'explain', pinned: false, wide: false, status: { appearanceDark: true, appearanceMaterial: 'solid', menuOpen: true, menuGeneration: 1 },
  settings: { text: { baseUrl: 'http://127.0.0.1', model: '隔离模型' }, prefs: { appearance: defaultAppearance(), shortcuts: { paste: 'Ctrl+Alt+P', capture: 'Ctrl+Alt+S', history: 'Ctrl+Alt+H' } } },
  session: { id: '隔离会话', kind: 'text', text: 'EXA', context: '12345EXA67890\n\n在这段原文中，EXA 是需要解释的选定内容，其余文字用于帮助理解所在语境。', activeMode: 'context', source: { app: 'Microsoft Edge' },
    threads: { context: { status: 'done', draft: '', messages: [{ id: '隔离回答', role: 'assistant', content: '这里解释选定的 **EXA**。\n\n查看上下文，可以确认它与前后内容的关系。', status: 'complete' }] }, independent: { status: 'idle', draft: '', messages: [] } } } };
ipcMain.handle('test:invoke', (event, action, payload) => { calls.push({ action, payload }); if (!before && action === 'menu-ready' && Number.isFinite(payload.height)) BrowserWindow.fromWebContents(event.sender).setSize(240, Math.ceil(payload.height)); return { ok: true, value: action === 'bootstrap' ? fixture : null }; });
async function until(predicate, label) { const end = Date.now() + 5000; while (Date.now() < end) { if (await predicate()) return; await delay(15); } throw Error(`等待${label}超时`); }
async function create(surface, width, height) {
  const win = new BrowserWindow({ show: false, frame: false, width, height, useContentSize: true, transparent: true, webPreferences: { preload: path.resolve(__dirname, '../tests/renderer/streaming.preload.cjs'), offscreen: true, backgroundThrottling: false, contextIsolation: true, sandbox: true } });
  windows.push(win); win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  await win.loadFile(path.resolve(__dirname, '../src/renderer/index.html'), { query: { window: surface } }); return win;
}
async function shot(win, name) {
  await win.webContents.executeJavaScript('Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))');
  await win.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  await fs.writeFile(path.join(output, `${before ? '调整前-' : ''}${name}.png`), (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
}
app.whenReady().then(async () => {
  const timeout = setTimeout(() => app.exit(1), 40000);
  try {
    await fs.mkdir(output, { recursive: true });
    const panel = await create('panel', 300, 483), run = code => panel.webContents.executeJavaScript(code);
    await until(() => run('Boolean(document.querySelector(".context-disclosure"))'), '解释窗口');
    await run('document.querySelector(".context-disclosure").open=true'); await shot(panel, '深色上下文');
    if (!before) {
      assert.deepEqual(await run('[...document.querySelectorAll(".context-disclosure mark")].map(n=>n.textContent)'), ['EXA', 'EXA']);
      assert.equal(await run('document.querySelector(".context-disclosure .context-text").textContent'), fixture.session.context);
      assert.equal(await run('getComputedStyle(document.querySelector(".context-disclosure summary")).fontSize'), '12px');
      assert.equal(await run('getComputedStyle(document.querySelector(".context-disclosure .context-text")).fontSize'), '13px');
      const centers = await run('(()=>{const t=document.querySelector(".composer textarea").getBoundingClientRect(),s=document.querySelector(".composer .send").getBoundingClientRect();return {text:t.y+t.height/2,icon:s.y+s.height/2}})()');
      assert.ok(Math.abs(centers.text-centers.icon) < 1, '输入框与发送按钮应垂直居中');
      assert.ok(await run('getComputedStyle(document.querySelector(".copy-label")).clipPath!=="none"'), '复制按钮仅图标可见');
      await run('document.querySelector("[data-copy-answer]").click()');
      await until(() => calls.some(c => c.action === 'copy-answer'), '复制图标');
      await until(() => run('document.querySelector("[data-copy-answer]").title==="已复制"'), '图标复制反馈');
      await run('(()=>{const t=document.querySelector(".composer textarea");t.value="第一行追问\\n第二行追问\\n第三行追问";t.dispatchEvent(new Event("input",{bubbles:true}))})()');
      assert.ok(await run('(()=>{const t=document.querySelector(".composer textarea").getBoundingClientRect(),s=document.querySelector(".composer .send").getBoundingClientRect();return t.height>30&&Math.abs(t.y+t.height/2-s.y-s.height/2)<1})()'), '多行输入也应居中');
      await run('(()=>{const t=document.querySelector(".composer textarea");t.value="";t.dispatchEvent(new Event("input",{bubbles:true}))})()');
    }
    fixture = { ...fixture, status: { ...fixture.status, appearanceDark: false }, settings: { ...fixture.settings, prefs: { ...fixture.settings.prefs, appearance: { ...defaultAppearance(), current: { ...defaultAppearance().current, mode: 'light' } } } } };
    panel.webContents.send('test:state', fixture); await until(() => run('document.documentElement.dataset.appearance==="light"'), '浅色'); await shot(panel, '浅色上下文');
    panel.setSize(860, 690); await until(() => run('Boolean(document.querySelector(".reading-layout"))'), '阅读视图'); await shot(panel, '双栏上下文');
    if (!before) assert.equal(await run('document.querySelectorAll(".reading-context mark").length'), 2);
    if (!before) {
      for (const appearanceMode of ['dark', 'light']) for (const material of ['solid', 'glass']) {
        fixture = { ...fixture, status: { ...fixture.status, appearanceDark: appearanceMode === 'dark', appearanceMaterial: material }, settings: { ...fixture.settings, prefs: { ...fixture.settings.prefs, appearance: { ...defaultAppearance(), current: { ...defaultAppearance().current, mode: appearanceMode, material } } } } };
        panel.webContents.send('test:state', fixture);
        await until(() => run(`document.documentElement.dataset.appearance==="${appearanceMode}"&&document.documentElement.dataset.material==="${material}"`), '阅读区主题切换');
        await run('(()=>{const t=document.querySelector(".composer textarea");t.value="第一行追问\\n第二行追问\\n第三行追问";t.dispatchEvent(new Event("input",{bubbles:true}))})()');
        await shot(panel, `双栏-${appearanceMode}-${material}`);
        const sample = await run('(()=>{const s=document.querySelector(".source-pane").getBoundingClientRect(),c=document.querySelector(".composer-wrap").getBoundingClientRect();return {edge:Math.floor(s.right-1),above:Math.floor(s.bottom-3),below:Math.floor(c.bottom-3)}})()');
        const capture = await panel.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true }), bitmap = capture.toBitmap(), stride = capture.getSize().width;
        function pixel(x,y) { const offset=(y*stride+x)*4;return [...bitmap.subarray(offset,offset+3)]; }
        for (const x of [20, sample.edge]) assert.ok(pixel(x,sample.above).every((v,i)=>Math.abs(v-pixel(x,sample.below)[i])<=2), `${appearanceMode}/${material} 下多行输入框左侧的背景和分界线应连续`);
      }
      const original = fixture.session;
      fixture = { ...fixture, session: { ...original, text: '<img onerror=x>', context: '前文<img onerror=x>后文' } };
      panel.webContents.send('test:state', fixture);
      await until(() => run('document.querySelector(".reading-context mark")?.textContent==="<img onerror=x>"'), '按纯文本标记');
      assert.equal(await run('document.querySelectorAll(".context-text img").length'), 0, '上下文不得生成 HTML 元素');
      fixture = { ...fixture, session: original };
    }
    const menu = await create('menu', before ? 272 : 240, before ? 548 : 452);
    await until(() => menu.webContents.executeJavaScript('Boolean(document.querySelector(".quick-menu"))'), '右键菜单'); await shot(menu, '紧凑菜单');
    if (!before) {
      assert.ok(await menu.webContents.executeJavaScript('(()=>{const m=document.querySelector(".quick-menu");return m.scrollHeight<=m.clientHeight})()'), '菜单全部命令可见');
      assert.equal(await menu.webContents.executeJavaScript('document.querySelectorAll(".quick-menu-item").length'), 11);
      assert.equal(await menu.webContents.executeJavaScript('document.querySelector("[data-menu-command=toggle-selection] .menu-label").textContent'), '关闭划词入口');
      assert.equal(await menu.webContents.executeJavaScript('Boolean(document.querySelector("[data-menu-command=close-panel]"))'), false);
      assert.equal(await menu.webContents.executeJavaScript('document.querySelector("[data-menu-command=appearance] .icon path").getAttribute("d").startsWith("M8 3 2 6")'), true);
      assert.ok(await menu.webContents.executeJavaScript('(()=>{const r=document.querySelector("[data-menu-command=appearance] .icon").getBoundingClientRect();return r.width>r.height})()'), '衣服图标保持描边并加宽');
      assert.equal(await menu.webContents.executeJavaScript('getComputedStyle(document.querySelector("[data-menu-command=appearance] .icon")).fill'), 'none');
      assert.ok(await menu.webContents.executeJavaScript('(()=>{const m=document.querySelector(".quick-menu").getBoundingClientRect(),q=document.querySelector("[data-menu-command=quit]").getBoundingClientRect();return m.bottom-q.bottom<=10&&q.height<=27})()'), '退出项更紧凑，底部不留大块空白');
      const normalHeight = menu.getBounds().height, original = fixture.session;
      fixture = { ...fixture, session: { ...original, threads: { ...original.threads, context: { ...original.threads.context, status: 'streaming' } } } };
      menu.webContents.send('test:state', fixture);
      await until(async () => await menu.webContents.executeJavaScript('Boolean(document.querySelector("[data-menu-command=stop]"))') && menu.getBounds().height > normalHeight, '生成中菜单自动增高');
      assert.ok(await menu.webContents.executeJavaScript('(()=>{const m=document.querySelector(".quick-menu");return m.scrollHeight<=m.clientHeight})()'), '增加停止项仍完整显示');
      fixture = { ...fixture, session: original }; menu.webContents.send('test:state', fixture);
      await until(() => menu.getBounds().height === normalHeight, '停止项消失后收掉留白');
    }
    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(output, before ? '调整前检查.json' : '阅读区检查.json'), JSON.stringify({ 通过: true, 虚构材料: true, 默认视口: [300,483], 阅读视口: [860,690], 菜单视口: [menu.getBounds().width, menu.getBounds().height], 检查: ['上下文标记及原文保留','单行输入和发送按钮垂直对齐','图标复制入口','菜单完整可见','明暗和双栏截图'] }, null, 2));
    clearTimeout(timeout); windows.forEach(w=>w.destroy()); console.log('阅读区检查通过。'); app.exit(0);
  } catch(error) { console.error(error); clearTimeout(timeout); windows.forEach(w=>w.destroy()); app.exit(1); }
});
