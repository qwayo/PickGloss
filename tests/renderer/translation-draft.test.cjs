'use strict';
// 控制窗语言草稿回归：加载正式渲染模块，不启动窗口、不读日常配置、不连接服务。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Element {
  constructor(tag) {
    this.tag = tag; this.children = []; this.attrs = {}; this.dataset = {}; this.style = {};
    this.events = {}; this.value = ''; this.className = ''; this.textContent = '';
    this.classList = { add() {}, toggle() {} };
    this.disabled = false; this.hidden = false;
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(key, value) { this.attrs[key] = String(value); }
  getAttribute(key) { return this.attrs[key]; }
  removeAttribute(key) { delete this.attrs[key]; }
  addEventListener(name, callback) { (this.events[name] ||= []).push(callback); }
  querySelectorAll(selector) {
    const result = [];
    const matches = element => selector.startsWith('.') ? element.className.split(' ').includes(selector.slice(1))
      : selector === '[id]' ? Boolean(element.attrs.id) : element.tag === selector;
    const visit = element => {
      for (const child of element.children) { if (matches(child)) result.push(child); visit(child); }
    };
    visit(this); return result;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  getBoundingClientRect() { return { width: 280, height: 112 }; }
  cloneNode() { return new Element(this.tag); }
  remove() {}
  getContext() { return { measureText: value => ({ width: [...value].length * 8 }) }; }
}

const settle = () => new Promise(resolve => setImmediate(resolve));
function page({ retryCreatesFailedItem = false } = {}) {
  const root = new Element('div');
  const document = {
    createElement: tag => new Element(tag), createElementNS: (_namespace, tag) => new Element(tag),
    documentElement: new Element('html'), body: new Element('body'),
  };
  const context = vm.createContext({ document, window: { addEventListener() {} }, URL,
    requestAnimationFrame: () => 1, cancelAnimationFrame() {} });
  const source = fs.readFileSync(path.resolve(__dirname, '../../src/renderer/translation.js'), 'utf8');
  vm.runInContext(source.replace(/^export /gm, '') + '\nglobalThis.createUI = createTranslationUI;', context);
  let prefs = { sourceLanguage: 'en', targetLanguage: 'zh-Hans', translationMode: 'standard', searchEnabled: false, searchScope: 'deep' };
  let data = { id: 'capture-1', status: 'complete', options: { ...prefs, displayMode: 'overlay' },
    method: 'windows-ocr', blocks: [], layout: { controls: { left: 0, top: 0, width: 280, height: 112 } } };
  let failLanguageSave = true;
  const calls = [];
  const languages = [{ id: 'en', name: '英语' }, { id: 'ja', name: '日语' }, { id: 'zh-Hans', name: '简体中文' }];
  const render = () => ui.render(data, languages, prefs);
  const ui = context.createUI({ root, invoke: async (action, payload) => {
    calls.push({ action, payload });
    if (action === 'set-translation-preferences') {
      if (failLanguageSave) return { ok: false, error: '模拟写盘失败' };
      prefs = { ...prefs, ...payload.options }; render();
    } else if (action === 'set-translation-options') {
      data = { ...data, options: { ...data.options, ...payload.options } }; render();
    } else if (action === 'retry-translation' && retryCreatesFailedItem) {
      // 正式主进程为同图重译分配新 ID；偏好落盘失败时，结果仍记录本次传入的语言。
      data = { ...data, id: 'retry-2', status: 'failed', error: '模拟写盘失败', options: { ...payload.options } }; render();
    }
    return { ok: true };
  } });
  render();
  const selectSource = async value => {
    const sourceSelect = root.querySelectorAll('select')[0];
    sourceSelect.value = value;
    sourceSelect.events.change[0]();
    await settle();
  };
  const click = async label => {
    const button = root.querySelectorAll('button').find(element => element.textContent === label || element.getAttribute('aria-label') === label);
    assert.ok(button, `应存在按钮：${label}`);
    assert.equal(button.disabled, false, `按钮可操作：${label}`);
    button.events.click[0](); await settle();
  };
  return { root, calls, selectSource, click, source: () => root.querySelectorAll('select')[0].value,
    succeed: () => { failLanguageSave = false; },
    setPreferences: next => { prefs = { ...prefs, ...next }; render(); },
    nextScreenshot: () => { data = { ...data, id: 'capture-2', options: { ...prefs, displayMode: 'overlay' } }; render(); } };
}

test('控制窗语言保存失败后切换显示仍保留本次语言，重译携带该语言', async () => {
  const editor = page();
  await editor.selectSource('ja');
  assert.equal(editor.source(), 'ja', '失败后应保留当前选框');
  await editor.click('对照');
  assert.equal(editor.source(), 'ja', '普通显示操作不能用旧默认值覆盖失败语言草稿');
  await editor.click('重新翻译');
  assert.equal(editor.calls.findLast(item => item.action === 'retry-translation').payload.options.sourceLanguage, 'ja');
});

test('换截图清除失败语言草稿，采用新截图默认值', async () => {
  const editor = page();
  await editor.selectSource('ja');
  editor.nextScreenshot();
  assert.equal(editor.source(), 'en');
});

test('同图重译生成新编号但保存仍失败时保留本次请求语言', async () => {
  const editor = page({ retryCreatesFailedItem: true });
  await editor.selectSource('ja');
  await editor.click('重新翻译');
  assert.equal(editor.calls.findLast(item => item.action === 'retry-translation').payload.options.sourceLanguage, 'ja');
  assert.equal(editor.source(), 'ja', '重译的保存失败不能使控制窗回退旧默认语言');
});

test('后续语言成功保存解除草稿保护，后来的真实默认值仍可同步', async () => {
  const editor = page();
  await editor.selectSource('ja');
  editor.succeed();
  await editor.selectSource('ja');
  assert.equal(editor.source(), 'ja');
  editor.setPreferences({ sourceLanguage: 'en' });
  assert.equal(editor.source(), 'en', '保存成功后不能永久锁定旧草稿');
});
