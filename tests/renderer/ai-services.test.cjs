'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function renderer(invoke = async () => ({ ok: true })) {
  const calls = [];
  let timestamp = 100000;
  const root = { style: {}, querySelector: () => null, querySelectorAll: () => [], setAttribute() {}, replaceChildren() {} };
  const context = {
    URL, URLSearchParams, Date: class extends Date { static now() { return timestamp; } },
    document: {
      documentElement: { classList: { toggle() {}, add() {}, remove() {} } },
      getElementById: () => root,
      addEventListener() {},
    },
    location: { search: '?window=panel' },
    createAppearanceUI: () => ({ receive() {}, mount() {}, dispose() {} }),
    createShortcutsUI: () => ({ receive() {}, mount() {}, dispose() {}, endRecording: async () => {} }),
    contextParts: source => [{ text: source, selected: false }],
    setTimeout: () => 1, clearTimeout() {},
    window: {
      innerWidth: 430, innerHeight: 690, addEventListener() {},
      pickgloss: {
        invoke: async (action, payload) => { calls.push({ action, payload }); return invoke(action, payload); },
        onLayout() {},
      },
    },
  };
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/app.js'), 'utf8');
  const harness = `
    function testElement(tag, attrs={}, ...children) {
      return {tag, attrs, children: children.flat(Infinity).filter(value => value !== null && value !== undefined && value !== false),
        className: attrs.class || '', textContent: attrs.text || '', classList: {add(){}},
        append(...items) { this.children.push(...items.flat(Infinity).filter(value => value !== null && value !== undefined && value !== false)); }};
    }
    el = testElement;
    icon = name => testElement('svg', {glyph:name});
    button = (label, action, options={}) => testElement('button', { type: options.type || 'button', label, title: options.title || label,
      'aria-label': options.iconOnly ? label : undefined, 'aria-pressed': options.pressed, 'aria-selected': options.selected,
      class: options.class || 'small-button', disabled: Boolean(options.disabled), onclick: action }, options.icon ? icon(options.icon) : null, options.iconOnly ? null : label);
    notice = (title, description, actions=[], error=false) => testElement('div', {class:error ? 'notice error' : 'notice', title, description}, actions);
    render = () => {};
    globalThis.audit = { setState: value => state=value, webSearchButton, toggleWebSearch, webSearchEnabled, retrySearch,
      searchStatusView, searchSourcesView, explainView, composer, serviceCatalog, loadSourceIcon, sourceSiteIcon };
  `;
  const autosave = fs.readFileSync(path.join(__dirname, '../../src/renderer/settings-autosave.js'), 'utf8').replace(/^export /gm, '');
  vm.runInContext(autosave + '\n' + source.replace(/^import .*;\s*$/gm, '').replace(/void bootstrap\(\);\s*$/, '') + harness, context);
  return { ...context.audit, calls, advanceTime: value => { timestamp += value; } };
}

function session({ webSearchEnabled = false, contextPending = false, activeMode = 'independent' } = {}) {
  return { id: '会话A', kind: 'text', text: 'selected text', context: '', contextPending, webSearchEnabled, activeMode,
    threads: { context: { status: 'idle', messages: [], draft: '' }, independent: { status: 'idle', messages: [], draft: '' }, visual: { status: 'idle', messages: [], draft: '' } } };
}

function text(tree) {
  if (tree === null || tree === undefined) return '';
  if (Array.isArray(tree)) return tree.map(text).join('');
  if (typeof tree === 'object') return `${tree.textContent || ''}${tree.children ? tree.children.map(text).join('') : ''}`;
  return String(tree);
}

test('联网开关按会话状态显示并写入当前会话与模式', async () => {
  const ui = renderer();
  ui.setState({ settings: {}, session: session({ activeMode: 'independent' }) });
  const off = ui.webSearchButton();
  assert.equal(off.attrs['aria-pressed'], false);
  await off.attrs.onclick();
  assert.deepEqual(JSON.parse(JSON.stringify(ui.calls[0])), { action: 'set-web-search', payload: { id: '会话A', mode: 'independent', enabled: true } });
  assert.equal(ui.webSearchEnabled(), true);
  assert.equal(ui.webSearchButton().attrs['aria-pressed'], true);
});

test('搜索失败重试携带失败回答编号并分开联网与离线动作', async () => {
  const ui = renderer();
  ui.setState({ settings: {}, session: session({ activeMode: 'context' }) });
  await ui.retrySearch('assistant-失效', true);
  await ui.retrySearch('assistant-失效', false);
  assert.deepEqual(JSON.parse(JSON.stringify(ui.calls.map(call => [call.action, call.payload]))), [
    ['retry-search', { id: '会话A', mode: 'context', messageId: 'assistant-失效' }],
    ['retry-without-search', { id: '会话A', mode: 'context', messageId: 'assistant-失效' }],
  ]);
});

test('旧失败回答保留错误说明，但不提供会改写后续历史的重试入口', () => {
  const ui = renderer();
  const stale = ui.searchStatusView({ id: '旧失败', search: { status: 'failed', error: '旧请求失败' } }, false);
  assert.match(text(stale), /旧请求失败/);
  const nodes = [];
  const visit = value => { if (Array.isArray(value)) return value.forEach(visit); if (!value || typeof value !== 'object') return; nodes.push(value); (value.children || []).forEach(visit); };
  visit(stale);
  assert.equal(nodes.some(value => value.tag === 'button'), false);
});

test('来源折叠区只从真实 source 对象创建编号与安全链接', () => {
  const ui = renderer();
  const node = ui.searchSourcesView({ id: 'answer-a', search: { status: 'complete', sources: [
    { id: 7, title: '真实标题', url: 'https://source.invalid/page', snippet: '第一段\n\n第二段   &#x20; App Store\tsoftware' },
    { id: 'bad', title: '不安全链接', url: 'javascript:alert(1)' },
  ] } });
  assert.match(text(node), /联网来源（2）/);
  assert.match(text(node), /\[7\]真实标题/);
  assert.match(text(node), /\[2\]不安全链接/);
  assert.match(text(node), /第一段 第二段 App Store software/, '摘录合并空行、连续空格和空格实体');
  const nodes = [];
  const visit = value => { if (Array.isArray(value)) return value.forEach(visit); if (!value || typeof value !== 'object') return; nodes.push(value); (value.children || []).forEach(visit); };
  visit(node);
  const excerpt = nodes.find(value => value.attrs?.class === 'search-source-excerpt');
  assert.ok(excerpt); assert.notEqual(excerpt.attrs.open, true, '摘录默认折叠');
  assert.match(text(excerpt), /查看摘录/);
  assert.equal(nodes.filter(value => value.tag === 'a').length, 1, '非法链接不能成为可点击来源');
  assert.equal(ui.searchSourcesView({ id: 'empty', search: { status: 'complete', sources: [] } }), null, '没有来源时不生成引用');
});

test('上下文获取期间展示状态、保留独立释义并禁用语境发送', () => {
  const ui = renderer();
  ui.setState({ settings: { text: { baseUrl: 'https://mock.invalid/v1', model: '模型' } }, session: session({ activeMode: 'context', contextPending: true }) });
  const body = { classList: { add() {} }, children: [], append(...items) { this.children.push(...items); } };
  ui.explainView(body);
  const rendered = text(body.children);
  assert.match(rendered, /正在获取上下文/);
  assert.match(rendered, /独立释义/);
  const composer = ui.composer();
  const send = composer.children[0].children.at(-1);
  assert.equal(send.attrs.disabled, true);
});

test('联网过程不增加提示，回答完成后才展示联网状态和来源', () => {
  const ui = renderer();
  ui.setState({ settings: {}, session: session() });
  for (const status of ['preparing', 'searching', 'complete']) {
    const message = { status: 'streaming', search: { status, query: '简短查询', sources: [{ id: 1, title: '来源', url: 'https://source.invalid/' }] } };
    assert.equal(ui.searchStatusView(message, true), null);
    assert.equal(ui.searchSourcesView(message), null);
  }
  assert.match(text(ui.searchStatusView({ status: 'complete', search: { status: 'complete', sources: [{}] } }, true)), /已参考联网资料/);
  assert.match(text(ui.searchSourcesView({ status: 'complete', search: { status: 'complete', sources: [{ title: '已完成来源' }] } })), /已完成来源/);
});

test('停止中的回答不再显示仍在准备或搜索的状态', () => {
  const ui = renderer();
  const stopped = { id: '停止回答', status: 'stopped', search: { status: 'searching', query: '短查询', sources: [
    { id: 1, title: '停止前已取得来源', url: 'https://source.invalid/article' },
  ] } };
  const status = ui.searchStatusView(stopped, true);
  assert.doesNotMatch(text(status), /正在提炼|正在联网搜索/);
  assert.match(text(ui.searchSourcesView(stopped)), /停止前已取得来源/, '停止后保留已经取得的来源');
});

test('旧的已完成联网回答不会跟随线程新状态显示为回答中', () => {
  const ui = renderer();
  const active = session();
  active.threads.independent.status = 'streaming';
  ui.setState({ settings: {}, session: active });
  const oldComplete = { id: '旧回答', status: 'complete', search: { status: 'complete', sources: [{ id: 1, title: '旧来源', url: 'https://source.invalid/old' }] } };
  assert.match(text(ui.searchStatusView(oldComplete, false)), /已参考联网资料/);
  assert.doesNotMatch(text(ui.searchStatusView(oldComplete, false)), /正在根据联网资料回答/);

  const stopped = { ...oldComplete, status: 'stopped' };
  assert.match(text(ui.searchStatusView(stopped, false)), /已参考联网资料/);
  assert.match(text(ui.searchSourcesView(stopped)), /旧来源/, '旧回答保留已取得的来源');
});

test('搜索服务下拉支持自定义接口，模型下拉保留自定义项', () => {
  const ui = renderer();
  ui.setState({ serviceCatalog: {
    models: [{ id: 'custom', name: '自定义' }, { id: 'deepseek', name: 'DeepSeek' }],
    search: [{ id: 'exa', name: 'Exa' }, { id: 'brave', name: 'Brave' }],
  }, settings: {} });
  assert.deepEqual(ui.serviceCatalog('search').map(item => item.id), ['exa', 'brave', 'custom']);
  assert.deepEqual(ui.serviceCatalog('text').map(item => item.id), ['custom', 'deepseek']);
});

test('网站图标失败只短时缓存，过期展开时重试，成功后同域名复用', async () => {
  let attempts = 0;
  const ui = renderer(async () => ++attempts === 1 ? { ok: true, value: '' } : { ok: true, value: 'data:image/png;base64,AAAA' });
  const target = { id: '会话A', mode: 'context' };
  await ui.loadSourceIcon('https://first.example.com/a', target, '回答A', 1);
  await ui.loadSourceIcon('https://first.example.com/b', target, '回答B', 2);
  assert.equal(ui.calls.length, 1, '失败缓存期内不重复请求');
  ui.advanceTime(31000);
  await ui.loadSourceIcon('https://first.example.com/b', target, '回答B', 2);
  assert.equal(ui.calls.length, 2, '失败过期后能重试');
  assert.equal(ui.sourceSiteIcon('https://first.example.com/c').children[0].tag, 'img');
  await ui.loadSourceIcon('https://first.example.com/c', target, '回答C', 3);
  assert.equal(ui.calls.length, 2, '成功图标在同域名复用');
});
