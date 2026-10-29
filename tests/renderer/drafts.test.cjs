'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// 在隔离上下文执行真实界面逻辑；只替换绘制和 IPC，不启动窗口或发送网络请求。
function renderer(invoke = async () => ({ ok: true })) {
  const calls = [], fields = new Map(), renders = [];
  let timer, beforeQuit;
  const root = { style: {}, querySelector: () => null, querySelectorAll: () => [], setAttribute() {} };
  const context = {
    document: { documentElement: { classList: { toggle() {} } }, getElementById: () => root, addEventListener() {} },
    location: { search: '?window=panel' }, URLSearchParams,
    contextParts: source => [{text: source, selected: false}],
    createAppearanceUI: () => ({ receive() {}, mount() {}, dispose() {} }), brand: () => ({}),
    mountPanelResize: () => ({ dispose() {} }),
    createShortcutsUI: () => ({ receive() {}, mount() {}, dispose() {}, endRecording: async () => {} }),
    setTimeout: fn => { timer = fn; return 1; }, clearTimeout: () => { timer = null; },
    window: {
      addEventListener() {},
      pickgloss: {
        invoke: async (action, payload) => { calls.push({ action, payload }); return invoke(action, payload); },
        onState: () => () => {},
        onBeforeQuit: callback => { beforeQuit = callback; return () => {}; },
      },
    },
  };
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/app.js'), 'utf8');
  const autosave = fs.readFileSync(path.join(__dirname, '../../src/renderer/settings-autosave.js'), 'utf8').replace(/^export /gm, '');
  vm.runInContext(autosave + '\n' + source.replace(/^import .*;\s*$/gm, '').replace(/void bootstrap\(\);\s*$/, '') + `
    render = () => testRenders.push(true);
    el = (tag, attrs, ...children) => ({tag, attrs, children, append(...items) { this.children.push(...items); }});
    icon = name => ({glyph: name});
    contextParts = source => [{text: source, selected: false}];
    button = (label, action) => ({label, action});
    notice = (title, description) => ({title, description});
    field = (label, name, value, options) => {
      const item = {control: {value}, options, wrap: {}};
      testFields.set(name, item);
      return item;
    };
    globalThis.audit = {receive, rememberDraft, scheduleDraft, flushDraft, sendQuestion,
      openSettings, previewView, explainView, footer, bootstrap, hasProvider, effectiveProvider, statusErrorKey, getSettingsSection: () => settingsSection, setState: value => state = value};
    globalThis.audit.draftValue = draftValue;
  `, Object.assign(context, { testFields: fields, testRenders: renders }));
  return { ...context.audit, calls, fields, renders, fireTimer() { const fn = timer; timer = null; fn?.(); }, quit: () => beforeQuit() };
}

function state(id, view = 'explain', kind = 'text') {
  return { view, settings: { text: { baseUrl: 'https://mock.invalid/v1', model: '测试模型' } }, session: {
    id, kind, context: '与本会话有关的段落', note: '', activeMode: kind === 'image' ? 'visual' : 'context',
    imageData: 'data:image/png;base64,AAAA',
    threads: { context: { messages: [], draft: '' }, independent: { messages: [], draft: '' }, visual: { messages: [], draft: '' } },
  } };
}

function input(id, value, mode = 'context') { return { dataset: { session: id, mode }, value }; }

test('从历史页重载后再次进入同一设置分类，使用主进程指定的分类', () => {
  const ui = renderer();
  const current = { ...state('会话A', 'history'), settingsSection: 'shortcuts' };
  ui.receive(current);
  ui.receive({ ...current, view: 'settings' });
  assert.equal(ui.getSettingsSection(), 'shortcuts');
});

test('原生窗口的布局状态保留节点，单独到达的保存错误仍重绘提示', () => {
  const ui = renderer();
  ui.receive(state('会话A'));
  assert.equal(ui.renders.length, 1);
  const layout = state('会话A'); layout.wide = true; layout.status = { windowTransitioning: true, appearanceDark: true };
  ui.receive(layout);
  assert.equal(ui.renders.length, 1, '单独的布局更新不替换输入节点');
  const error = state('会话A'); error.wide = true; error.status = { windowTransitioning: true, appearanceDark: true, error: '窗口写入失败', errorId: '这一次失败' };
  ui.receive(error);
  assert.equal(ui.renders.length, 2, '错误必须显示，不能被布局优化吞掉');
});

test('相同超限文字在新一次操作中可以重新提示，其他错误仍能区分', () => {
  const ui = renderer();
  const current = state('会话A');
  current.status = { error: '超过上限，请缩短。', errorId: '第一次' };
  ui.setState(current);
  const first = ui.statusErrorKey();
  current.status.errorId = '第二次';
  assert.notEqual(ui.statusErrorKey(), first);
  const second = ui.statusErrorKey();
  current.status.error = '另一项操作失败';
  assert.notEqual(ui.statusErrorKey(), second);
});

test('缺少上下文时显示实际原因，补充段落后不再显示旧原因', () => {
  const ui = renderer();
  const current = state('会话A');
  current.session.text = '选定内容';
  current.session.context = '';
  current.session.contextReason = '所在段落超过 6000 个字符，请手动精简上下文。';
  ui.setState(current);
  let parts = [];
  ui.explainView({ classList: { add() {} }, append: (...values) => parts.push(...values) });
  assert.ok(JSON.stringify(parts).includes(current.session.contextReason));
  current.session.context = '补充后的段落';
  parts = [];
  ui.explainView({ classList: { add() {} }, append: (...values) => parts.push(...values) });
  assert.ok(!JSON.stringify(parts).includes(current.session.contextReason));
});

test('只配置文字模型时截图追问可发送，独立识图配置不完整时仍提示配置',async()=>{
  const ui=renderer();
  const image=state('截图A','explain','image');
  ui.setState(image);
  assert.equal(ui.hasProvider('vision'),true);
  assert.equal(ui.effectiveProvider('vision').model,image.settings.text.model);
  ui.rememberDraft(input('截图A','解释这张截图','visual'));
  await ui.sendQuestion();
  assert.equal(ui.calls.find(call=>call.action==='send-question').payload.mode,'visual');
  image.settings.vision={baseUrl:'',model:'独立识图模型'};
  ui.setState(image);
  assert.equal(ui.hasProvider('vision'),false);
  image.settings.vision.model=' ';
  assert.equal(ui.hasProvider('vision'),true);
});

test('截图页服务入口显示实际沿用或独立使用的模型', () => {
  const ui = renderer();
  const image = state('截图模型显示', 'explain', 'image');
  image.settings.text.model = '当前文字模型';
  image.settings.vision = { baseUrl: 'https://unused.invalid/v1', model: '  ' };
  ui.setState(image);
  assert.equal(ui.footer('explain').children[0].label, '当前文字模型');
  image.settings.vision = { baseUrl: 'https://vision.invalid/v1', model: '独立识图模型' };
  ui.setState(image);
  assert.equal(ui.footer('explain').children[0].label, '独立识图模型');
});

test('外部入口切换会话后，延迟草稿仍保存到原会话', async () => {
  const ui = renderer();
  ui.setState(state('会话A'));
  ui.rememberDraft(input('会话A', 'A 的未发送追问'));
  ui.scheduleDraft();
  ui.receive(state('会话B'));
  ui.fireTimer();
  await ui.flushDraft();
  const writes = ui.calls.filter(call => call.action === 'set-draft');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].payload.id, '会话A');
  assert.equal(writes[0].payload.mode, 'context');
  assert.equal(writes[0].payload.draft, 'A 的未发送追问');
});

test('发送等待保存时切换会话，问题仍绑定原会话与模式', async () => {
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const ui = renderer(async action => {
    if (action === 'set-draft') { entered(); await new Promise(resolve => { release = resolve; }); }
    return { ok: true };
  });
  ui.setState(state('会话A'));
  ui.rememberDraft(input('会话A', '只针对 A 的问题'));
  const sending = ui.sendQuestion();
  await waiting;
  ui.receive(state('会话B'));
  release();
  await sending;
  const sent = ui.calls.find(call => call.action === 'send-question');
  assert.equal(sent.payload.id, '会话A');
  assert.equal(sent.payload.mode, 'context');
  assert.equal(sent.payload.question, '只针对 A 的问题');
});

test('联网失败状态在发送 IPC 返回前到达时，草稿应恢复为本次问题', async () => {
  let ui;
  let current = state('会话A');
  ui = renderer(async (action, payload) => {
    if (action === 'set-draft') {
      current = structuredClone(current);
      current.session.threads[payload.mode].draft = payload.draft;
      return { ok: true };
    }
    if (action === 'send-question') {
      current = structuredClone(current);
      const thread = current.session.threads[payload.mode];
      thread.draft = payload.question;
      thread.status = 'error';
      thread.messages = [{ id: '失败回答', role: 'assistant', requestQuestion: payload.question, status: 'error', content: '',
        search: { status: 'failed', error: '虚构搜索失败' } }];
      ui.receive(current);
    }
    return { ok: true };
  });
  ui.setState(current);
  const question = '需要联网的问题';
  ui.rememberDraft(input('会话A', question));
  await ui.sendQuestion();
  assert.equal(current.session.threads.context.draft, question, '核心已持久化恢复本次问题');
  assert.equal(ui.draftValue(), question, '界面应在本次操作失败后显示恢复的问题');
});

test('截图说明先保存再进入服务设置，返回预览保留原输入', async () => {
  const ui = renderer();
  const image = state('截图A', 'preview', 'image');
  ui.setState(image);
  ui.previewView({ append() {} });
  ui.fields.get('image-note').options.oninput({ target: { value: '解释两条曲线的差异' } });
  await ui.openSettings();
  assert.deepEqual(ui.calls.map(call => call.action), ['set-note', 'open-settings']);
  assert.equal(ui.calls[0].payload.id, '截图A');
  assert.equal(ui.calls[0].payload.note, '解释两条曲线的差异');
  ui.receive({ ...image, view: 'settings' });
  ui.receive(image);
  ui.previewView({ append() {} });
  assert.equal(ui.fields.get('image-note').control.value, '解释两条曲线的差异');
});

test('历史页退出也会保存所有会话的待存草稿与截图说明', async () => {
  const ui = renderer(async action => action === 'bootstrap' ? { ok: true, value: state('会话A') } : { ok: true });
  await ui.bootstrap();
  ui.rememberDraft(input('会话A', '语境草稿'));
  ui.rememberDraft(input('会话B', '独立草稿', 'independent'));
  ui.setState(state('截图A', 'preview', 'image'));
  ui.previewView({ append() {} });
  ui.fields.get('image-note').options.oninput({ target: { value: '退出前的截图说明' } });
  ui.receive({ ...state('会话B'), view: 'history' });
  assert.equal(await ui.quit(), true);
  const writes = ui.calls.filter(call => ['set-draft', 'set-note'].includes(call.action));
  assert.deepEqual(writes.map(call => call.payload.id).sort(), ['会话A', '会话B', '截图A']);
  assert.equal(writes.find(call => call.payload.id === '会话B').payload.mode, 'independent');
});

test('草稿保存失败时阻止离开，并保留输入供重试', async () => {
  let failing = true;
  const ui = renderer(async action => action === 'set-draft' && failing ? { ok: false, error: '测试存储失败' } : { ok: true });
  ui.setState(state('会话A'));
  ui.rememberDraft(input('会话A', '不能丢失的草稿'));
  await ui.openSettings();
  assert.equal(ui.calls.some(call => call.action === 'open-settings'), false);
  failing = false;
  await ui.openSettings();
  assert.equal(ui.calls.filter(call => call.action === 'set-draft').length, 2);
  assert.equal(ui.calls.at(-1).action, 'open-settings');
});
