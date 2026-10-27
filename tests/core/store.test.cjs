'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../../src/core/store.cjs');
const { defaultAppearance, defaultWindowGeometry } = require('../../src/core/appearance.cjs');
const { DEFAULT_SHORTCUTS } = require('../../src/core/shortcuts.cjs');
const imageData = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC1kAAAAASUVORK5CYII=';

async function setup(options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pickgloss-core-'));
  // 测试专用变换，仅验证宿主加解密注入边界；产品使用 Windows safeStorage。
  const transform = (data) => Buffer.from(data).map((byte) => byte ^ 0xa5);
  const injections = { directory, encrypt: (text) => transform(Buffer.from(text, 'utf8')), decrypt: (data) => transform(data).toString('utf8'), ...options };
  const store = createStore(injections);
  await store.init();
  return { directory, store, injections };
}

test('并发保存截图语言和显示方式分别合并，重启后保留最新选择', async () => {
  const { store, injections } = await setup();
  await store.saveSettings({ prefs: { screenshotTranslation: { sourceLanguage: 'en', targetLanguage: 'zh-Hans' } } });
  await Promise.all([
    store.saveSettings({ prefs: { screenshotTranslation: { targetLanguage: 'ja' } } }),
    store.saveSettings({ prefs: { screenshotTranslation: { displayMode: 'compare' } } }),
  ]);
  const restarted = createStore(injections); await restarted.init();
  const saved = (await restarted.getSettings()).prefs.screenshotTranslation;
  assert.deepEqual(saved, { sourceLanguage: 'en', targetLanguage: 'ja', displayMode: 'compare', showOriginal: false, translationMode: 'standard', searchEnabled: true, searchScope: 'deep' });
  await assert.rejects(store.saveSettings({ prefs: { screenshotTranslation: null } }), /截图翻译设置/);
  await assert.rejects(store.saveSettings({ prefs: { screenshotTranslation: { targetLanguage: '无效语言' } } }), /目标语言无效/);
  assert.deepEqual((await store.getSettings()).prefs.screenshotTranslation, saved);
});

test('翻译深度与联网独立保存，语言和显示更新不会覆盖它们，重启后仍生效', async () => {
  const { store, injections, directory } = await setup();
  assert.equal((await store.getSettings()).prefs.screenshotTranslation.translationMode, 'standard');
  await store.saveSettings({ prefs: { screenshotTranslation: { translationMode: 'deep', searchEnabled: false, searchScope: 'deep' } } });
  await Promise.all([
    store.saveSettings({ prefs: { screenshotTranslation: { targetLanguage: 'ja' } } }),
    store.saveSettings({ prefs: { screenshotTranslation: { displayMode: 'compare' } } }),
  ]);
  const restarted = createStore(injections); await restarted.init();
  const prefs = (await restarted.getSettings()).prefs.screenshotTranslation;
  assert.equal(prefs.translationMode, 'deep'); assert.equal(prefs.searchEnabled, false); assert.equal(prefs.searchScope, 'deep');
  assert.equal(prefs.targetLanguage, 'ja'); assert.equal(prefs.displayMode, 'compare');
  await assert.rejects(restarted.saveSettings({ prefs: { screenshotTranslation: { translationMode: 'invalid' } } }), /翻译.*无效/);
  await assert.rejects(restarted.saveSettings({ prefs: { screenshotTranslation: { searchEnabled: 'false' } } }), /联网.*无效/);
  assert.deepEqual((await restarted.getSettings()).prefs.screenshotTranslation, prefs);
  const file = path.join(directory, 'settings.json'), raw = JSON.parse(await fs.readFile(file, 'utf8'));
  delete raw.prefs.screenshotTranslation.translationMode; delete raw.prefs.screenshotTranslation.searchEnabled; delete raw.prefs.screenshotTranslation.searchScope;
  await fs.writeFile(file, JSON.stringify(raw));
  const legacy = createStore(injections); await legacy.init();
  assert.equal((await legacy.getSettings()).prefs.screenshotTranslation.translationMode, 'standard');
  assert.equal((await legacy.getSettings()).prefs.screenshotTranslation.searchEnabled, true);
  assert.equal((await legacy.getSettings()).prefs.screenshotTranslation.searchScope, 'deep');
  assert.equal((await legacy.getSettings()).prefs.screenshotTranslation.targetLanguage, 'ja');
});

test('旧深度联网布尔值迁移为总开关且保存后只落盘规范字段', async () => {
  for (const legacyValue of [false, true]) {
    const { store, injections, directory } = await setup();
    const file = path.join(directory, 'settings.json');
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    Object.assign(raw.prefs.screenshotTranslation, { sourceLanguage: 'en', targetLanguage: 'ja', displayMode: 'compare', translationMode: 'deep', deepSearchEnabled: legacyValue });
    delete raw.prefs.screenshotTranslation.searchEnabled; delete raw.prefs.screenshotTranslation.searchScope;
    await fs.writeFile(file, JSON.stringify(raw));

    const migrated = createStore(injections); await migrated.init();
    const options = (await migrated.getSettings()).prefs.screenshotTranslation;
    assert.equal(options.searchEnabled, legacyValue);
    assert.equal(options.searchScope, 'deep');
    assert.equal(Object.hasOwn(options, 'deepSearchEnabled'), false);
    assert.equal(options.sourceLanguage, 'en'); assert.equal(options.targetLanguage, 'ja');
    assert.equal(options.displayMode, 'compare'); assert.equal(options.translationMode, 'deep');

    await migrated.saveSettings({ prefs: { screenshotTranslation: { targetLanguage: 'ko' } } });
    const persisted = JSON.parse(await fs.readFile(file, 'utf8')).prefs.screenshotTranslation;
    assert.equal(persisted.searchEnabled, legacyValue);
    assert.equal(persisted.searchScope, 'deep');
    assert.equal(Object.hasOwn(persisted, 'deepSearchEnabled'), false);
    assert.equal(persisted.sourceLanguage, 'en'); assert.equal(persisted.targetLanguage, 'ko');
    assert.equal(persisted.displayMode, 'compare'); assert.equal(persisted.translationMode, 'deep');
  }
});

test('独立翻译模型加密保存且厂商密钥隔离，旧文件兼容默认截图模式', async () => {
  const { directory, store, injections } = await setup();
  const initial = await store.getSettings();
  assert.equal(initial.translation.model, ''); assert.equal(initial.prefs.captureDefaultMode, 'explain'); assert.equal(initial.prefs.captureExplainMode, 'immediate');
  await store.saveSettings({ translation: { providerId: 'custom', baseUrl: 'https://translate.invalid/v1', model: '专用翻译模型', apiKey: '虚构翻译密钥' }, prefs: { captureDefaultMode: 'translate' } });
  const restarted = createStore(injections); await restarted.init();
  assert.equal((await restarted.getSettings({ includeSecrets: true })).translation.apiKey, '虚构翻译密钥');
  assert.equal((await restarted.getSettings()).prefs.captureDefaultMode, 'translate');
  assert.equal((await restarted.getSettings()).translation.hasKey, true);
  assert.equal((await restarted.getSettings()).text.hasKey, false);
  await assert.rejects(restarted.saveSettings({ prefs: { captureDefaultMode: 'invalid' } }), /截图默认模式无效/);
  const file = path.join(directory, 'settings.json'), raw = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(JSON.stringify(raw).includes('虚构翻译密钥'), false);
  delete raw.translation; delete raw.serviceProfiles.translation; delete raw.prefs.captureDefaultMode;
  const legacy = JSON.stringify(raw); await fs.writeFile(file, legacy, 'utf8');
  const old = createStore(injections); await old.init();
  assert.equal((await old.getSettings()).translation.model, ''); assert.equal((await old.getSettings()).prefs.captureDefaultMode, 'explain');
  assert.equal(await fs.readFile(file, 'utf8'), legacy, '读取旧配置不能静默重写');
});

test('旧设置缺少外观和窗口状态时补齐黑银默认值，读取不重写旧文件', async () => {
  const { directory, store, injections } = await setup();
  await store.saveSettings({ text: { baseUrl: 'https://example.com/v1', model: '测试模型', apiKey: '仅测试密钥' }, prefs: { showOrb: false } });
  const file = path.join(directory, 'settings.json');
  const legacy = JSON.parse(await fs.readFile(file, 'utf8'));
  delete legacy.prefs.appearance; delete legacy.prefs.windowGeometry; delete legacy.prefs.shortcuts; delete legacy.prefs.pinSound; delete legacy.prefs.orbAction;
  const original = JSON.stringify(legacy);
  await fs.writeFile(file, original, 'utf8');
  const restarted = createStore(injections); await restarted.init();
  const settings = await restarted.getSettings();
  assert.deepEqual(settings.prefs.appearance, { current: { mode: 'dark', material: 'solid', accent: '#000000', tint: '#bfc2c8', opacity: 82, blur: 26 }, active: 'default', presets: [], reducedMotion: false, pinOutline: 'orange' });
  assert.deepEqual(settings.prefs.windowGeometry, { orb: null, panel: null, sizes: { compact: { width: 300, height: 483 }, reading: { width: 860, height: 690 } }, wide: false });
  assert.equal(settings.prefs.showOrb, false);
  assert.equal(settings.prefs.orbAction, 'chat');
  assert.deepEqual(settings.prefs.shortcuts, DEFAULT_SHORTCUTS); assert.equal(settings.prefs.pinSound, true);
  assert.equal(settings.text.hasKey, true);
  assert.equal('apiKey' in settings.text, false);
  assert.equal(await fs.readFile(file, 'utf8'), original);
  await restarted.saveSettings({ prefs: { appearance: defaultAppearance() } });
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).text.keyCiphertext, legacy.text.keyCiphertext);
});

test('悬浮球左键功能保存后重启仍生效，并拒绝未知功能',async()=>{
  const {store,injections}=await setup();
  assert.equal((await store.getSettings()).prefs.orbAction,'chat');
  await store.saveSettings({prefs:{orbAction:'capture'}});
  const restarted=createStore(injections);await restarted.init();
  assert.equal((await restarted.getSettings()).prefs.orbAction,'capture');
  await assert.rejects(restarted.saveSettings({prefs:{orbAction:'other'}}),/悬浮球左键功能无效/);
  assert.equal((await restarted.getSettings()).prefs.orbAction,'capture');
});

test('旧外观补齐置顶描边设置，六种颜色和无描边可读回，非法值不覆盖磁盘', async () => {
  const { directory, store, injections } = await setup();
  const file = path.join(directory, 'settings.json');
  const old = JSON.parse(await fs.readFile(file, 'utf8')); delete old.prefs.appearance.pinOutline;
  const original = JSON.stringify(old); await fs.writeFile(file, original);
  const restarted = createStore(injections); await restarted.init();
  assert.equal((await restarted.getSettings()).prefs.appearance.pinOutline, 'orange');
  assert.equal(await fs.readFile(file, 'utf8'), original);
  for (const pinOutline of ['orange', 'amber', 'blue', 'violet', 'mint', 'silver', 'none']) {
    const appearance = { ...defaultAppearance(), pinOutline };
    await restarted.saveSettings({ prefs: { appearance } });
    const reopened = createStore(injections); await reopened.init();
    assert.equal((await reopened.getSettings()).prefs.appearance.pinOutline, pinOutline);
  }
  for (const pinOutline of ['red', '#ff0000', null, false]) await assert.rejects(() => restarted.saveSettings({ prefs: { appearance: { ...defaultAppearance(), pinOutline } } }), /置顶描边颜色无效/);
  assert.equal((await store.getSettings()).prefs.appearance.pinOutline, 'none');
});

test('外观预设可以保存更新切换并重启恢复，公开设置不含密钥', async () => {
  const { store, injections } = await setup();
  await store.saveSettings({ vision: { baseUrl: 'https://example.com/v1', model: '视觉模型', apiKey: '虚构密钥' } });
  const appearance = defaultAppearance();
  appearance.presets = [
    { id: 'preset-one', name: '  夜间阅读  ', values: { ...appearance.current, tint: '#ABCDEF' } },
    { id: 'preset-two', name: '日间阅读', values: { ...appearance.current, mode: 'light', material: 'glass', opacity: 96, blur: 40 } },
  ];
  appearance.active = 'preset-one'; appearance.current = appearance.presets[0].values;
  let saved = await store.saveSettings({ prefs: { appearance } });
  assert.equal(saved.prefs.appearance.presets[0].name, '夜间阅读');
  assert.equal(saved.prefs.appearance.current.tint, '#abcdef');
  appearance.presets[1].values.blur = 8;
  appearance.current = appearance.presets[1].values; appearance.active = 'preset-two'; appearance.reducedMotion = true;
  saved = await store.saveSettings({ prefs: { appearance } });
  const restarted = createStore(injections); await restarted.init();
  assert.deepEqual((await restarted.getSettings()).prefs.appearance, saved.prefs.appearance);
  assert.equal(saved.vision.hasKey, true); assert.equal('apiKey' in saved.vision, false);
});

test('非法外观值和预设拒绝保存，磁盘原设置保持完整', async () => {
  const { directory, store } = await setup();
  const file = path.join(directory, 'settings.json'), before = await fs.readFile(file, 'utf8');
  const invalid = [
    a => { a.current.mode = 'auto'; }, a => { a.current.material = 'url(恶意地址)'; },
    a => { a.current.accent = '#fff'; }, a => { a.current.tint = '#ffffff;background:red'; },
    a => { a.current.opacity = 71; }, a => { a.current.opacity = 97; }, a => { a.current.opacity = NaN; },
    a => { a.current.blur = 7; }, a => { a.current.blur = 41; }, a => { a.current.blur = 26.5; },
    a => { a.current.css = '任意样式'; }, a => { a.reducedMotion = 'false'; },
    a => { a.active = 'missing'; }, a => { a.presets = Array.from({ length: 51 }, (_, i) => ({ id: `preset-${i}`, name: `预设${i}`, values: a.current })); },
  ];
  for (const preset of [
    { id: '../escape', name: '名称' }, { id: 'default', name: '名称' },
    { id: 'valid', name: '   ' }, { id: 'valid', name: '长'.repeat(25) }, { id: 'valid', name: '第一行\n第二行' },
  ]) invalid.push(a => { a.presets = [{ ...preset, values: a.current }]; });
  invalid.push(a => { a.presets = [{ id: 'same', name: '第一套', values: a.current }, { id: 'same', name: '第二套', values: a.current }]; });
  invalid.push(a => { a.presets = [{ id: 'first', name: 'Read', values: a.current }, { id: 'second', name: ' read ', values: a.current }]; });
  for (const change of invalid) {
    const appearance = defaultAppearance(); change(appearance);
    await assert.rejects(store.saveSettings({ prefs: { appearance } }), { code: 'INVALID_INPUT' });
    assert.equal(await fs.readFile(file, 'utf8'), before);
  }
});

test('窗口状态保存负坐标和独立布局尺寸，拒绝非有限越界或附加字段', async () => {
  const { directory, store, injections } = await setup();
  const geometry = { orb: { x: -1920, y: 48 }, panel: { x: -1400, y: -300 }, sizes: { compact: { width: 215, height: 483 }, reading: { width: 1024, height: 768 } }, wide: true };
  await store.saveSettings({ prefs: { windowGeometry: geometry } });
  const restarted = createStore(injections); await restarted.init();
  assert.deepEqual((await restarted.getSettings()).prefs.windowGeometry, geometry);
  const file = path.join(directory, 'settings.json'), before = await fs.readFile(file, 'utf8');
  for (const change of [
    g => { g.orb = { x: Infinity, y: 0 }; }, g => { g.panel = { x: 100001, y: 0 }; },
    g => { g.panel = { x: 1.5, y: 0 }; }, g => { g.sizes.compact.width = 214; },
    g => { g.sizes.reading.height = 8193; }, g => { g.sizes.compact.height = 179; },
    g => { g.wide = 1; }, g => { g.panel = { x: 0, y: 0, width: 300 }; },
  ]) {
    const invalid = structuredClone(geometry); change(invalid);
    await assert.rejects(store.saveSettings({ prefs: { windowGeometry: invalid } }), { code: 'INVALID_INPUT' });
    assert.equal(await fs.readFile(file, 'utf8'), before);
  }
});

test('并发保存外观窗口状态和服务设置时合并独立偏好与加密配置', async () => {
  const { directory, store } = await setup();
  await store.saveSettings({ text: { baseUrl: 'https://example.com/v1', model: '原模型', apiKey: '隔离的测试密钥' } });
  const file = path.join(directory, 'settings.json');
  const cipher = JSON.parse(await fs.readFile(file, 'utf8')).text.keyCiphertext;
  const appearance = defaultAppearance(); appearance.current.mode = 'system';
  const geometry = defaultWindowGeometry(); geometry.panel = { x: 20, y: 30 };
  await Promise.all([
    store.saveSettings({ prefs: { appearance } }),
    store.saveSettings({ prefs: { windowGeometry: geometry } }),
    store.saveSettings({ text: { model: '新模型' }, prefs: { selectionEnabled: false } }),
    store.saveSettings({ prefs: { shortcuts: { ...DEFAULT_SHORTCUTS, history: 'control+h' }, pinSound: false } }),
  ]);
  const saved = await store.getSettings();
  assert.deepEqual(saved.prefs.appearance, appearance); assert.deepEqual(saved.prefs.windowGeometry, geometry);
  assert.equal(saved.prefs.selectionEnabled, false); assert.equal(saved.text.model, '新模型');
  assert.equal(saved.prefs.shortcuts.history, 'Ctrl+H'); assert.equal(saved.prefs.pinSound, false);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).text.keyCiphertext, cipher);
  assert.equal('apiKey' in saved.text, false);
});

test('非法快捷键及提示音设置不能覆盖本地配置，支持清空和恢复默认', async () => {
  const { directory, store } = await setup();
  const file = path.join(directory, 'settings.json'), before = await fs.readFile(file, 'utf8');
  for (const prefs of [{ pinSound: 'true' }, { shortcuts: {} }, { shortcuts: { ...DEFAULT_SHORTCUTS, paste: 'G' } },
    { shortcuts: { ...DEFAULT_SHORTCUTS, paste: DEFAULT_SHORTCUTS.capture } }]) {
    await assert.rejects(store.saveSettings({ prefs }), { code: 'INVALID_INPUT' });
    assert.equal(await fs.readFile(file, 'utf8'), before);
  }
  await store.saveSettings({ prefs: { shortcuts: { ...DEFAULT_SHORTCUTS, paste: '' }, pinSound: false } });
  assert.equal((await store.getSettings()).prefs.shortcuts.paste, '');
  await store.saveSettings({ prefs: { shortcuts: { ...DEFAULT_SHORTCUTS }, pinSound: true } });
  assert.deepEqual((await store.getSettings()).prefs.shortcuts, DEFAULT_SHORTCUTS);
});

test('上下文缺失原因随会话保存，旧记录缺少该字段仍可恢复', async () => {
  const { directory, store, injections } = await setup();
  const reason = '所在段落超过 6000 个字符，请手动精简上下文。';
  const created = await store.createSession({ text: '选定内容', contextReason: reason });
  const restarted = createStore(injections);
  await restarted.init();
  assert.equal((await restarted.getSession(created.id)).contextReason, reason);
  await restarted.updateSession(created.id, { context: '用户补充的简短段落', contextReason: '' });
  assert.equal((await restarted.getSession(created.id)).contextReason, '');
  const file = path.join(directory, 'sessions', created.id, 'session.json');
  const legacy = JSON.parse(await fs.readFile(file, 'utf8'));
  delete legacy.contextReason;
  await fs.writeFile(file, JSON.stringify(legacy), 'utf8');
  assert.equal((await restarted.getSession(created.id)).contextReason, '');
});

test('会话和裁剪截图独立保存，重启恢复完整三模式记录且列表不暴露图像与路径', async () => {
  const { directory, store, injections } = await setup();
  const created = await store.createSession({ kind: 'image', imageData, note: '截图说明', source: { app: '浏览器', title: '测试标题', method: '截图框选' } });
  assert.equal(created.imageData, imageData);
  const updated = await store.updateSession(created.id, { saved: true, activeMode: 'visual', threads: { visual: { messages: [{ id: '消息一', role: 'assistant', content: '未完成解释', status: 'stopped', error: '用户中止' }], draft: '继续追问', status: 'stopped', error: '线程中止说明' } } });
  assert.ok(updated.updatedAt > created.updatedAt);
  assert.equal(updated.threads.visual.status, 'stopped');
  assert.equal(updated.threads.visual.error, '线程中止说明');
  const restarted = createStore(injections);
  await restarted.init();
  assert.deepEqual(await restarted.getSession(created.id), updated);
  const list = await restarted.listSessions();
  assert.equal(list.length, 1);
  assert.equal(list[0].saved, true);
  assert.deepEqual(list[0].modesWithMessages, ['visual']);
  assert.equal('imageData' in list[0], false);
  assert.equal(JSON.stringify(list).includes(directory), false);
  const disk = JSON.parse(await fs.readFile(path.join(directory, 'sessions', created.id, 'session.json'), 'utf8'));
  assert.equal(disk.threads.visual.status, 'stopped');
  assert.equal(disk.threads.visual.error, '线程中止说明');
  assert.equal('imageData' in disk, false);
  assert.deepEqual(await fs.readFile(path.join(directory, 'sessions', created.id, 'crop.png')), Buffer.from(imageData.split(',')[1], 'base64'));
});

test('历史列表只查询截图文件元数据，打开会话仍读取并校验完整截图', async (t) => {
  const { directory, store } = await setup();
  const session = await store.createSession({ kind: 'image', imageData });
  const imagePath = path.join(directory, 'sessions', session.id, 'crop.png');
  const originalReadFile = fs.readFile;
  let imageReads = 0;
  t.mock.method(fs, 'readFile', async (target, ...args) => {
    if (target === imagePath) imageReads++;
    return originalReadFile(target, ...args);
  });
  const list = await store.listSessions();
  assert.equal(imageReads, 0);
  assert.equal('imageData' in list[0], false);
  assert.equal((await store.getSession(session.id)).imageData, imageData);
  assert.equal(imageReads, 1);
  await fs.writeFile(imagePath, Buffer.alloc(33));
  assert.equal((await store.listSessions()).length, 1);
  assert.equal(imageReads, 1);
  await assert.rejects(store.getSession(session.id), { code: 'DATA_CORRUPT' });
  await fs.rename(imagePath, `${imagePath}.保留原测试文件`);
  await assert.rejects(store.listSessions(), { code: 'DATA_CORRUPT' });
});

test('已有密钥只允许同来源路径更改，跨来源必须重新输入或清除密钥', async () => {
  const { directory, store } = await setup();
  for (const name of ['text', 'vision']) {
    await store.saveSettings({ [name]: { baseUrl: 'https://first.example/v1', model: '测试模型', apiKey: 'first-test-key' } });
    await store.saveSettings({ [name]: { baseUrl: 'https://first.example/new/v1/chat/completions', apiKey: '' } });
    assert.equal((await store.getSettings({ includeSecrets: true }))[name].apiKey, 'first-test-key');
    const before = await fs.readFile(path.join(directory, 'settings.json'), 'utf8');
    for (const baseUrl of ['https://second.example/v1', 'https://first.example:8443/v1', '']) {
      await assert.rejects(store.saveSettings({ [name]: { baseUrl } }), { code: 'KEY_ORIGIN_CHANGED' });
      await assert.rejects(store.saveSettings({ [name]: { baseUrl, apiKey: '  ' } }), { code: 'KEY_ORIGIN_CHANGED' });
      assert.equal(await fs.readFile(path.join(directory, 'settings.json'), 'utf8'), before);
    }
    await store.saveSettings({ [name]: { baseUrl: 'https://second.example/v1', apiKey: 'second-test-key' } });
    assert.equal((await store.getSettings({ includeSecrets: true }))[name].apiKey, 'second-test-key');
    await store.saveSettings({ [name]: { baseUrl: 'https://third.example/v1', clearKey: true } });
    assert.equal((await store.getSettings())[name].hasKey, false);
  }
  await store.saveSettings({ text: { baseUrl: 'http://localhost:11434/v1', apiKey: 'local-test-key' } });
  await assert.rejects(store.saveSettings({ text: { baseUrl: 'https://localhost:11434/v1' } }), { code: 'KEY_ORIGIN_CHANGED' });
});

test('密钥加密落盘、默认查询从不返回密钥，空字段保留且显式清除', async () => {
  const { directory, store, injections } = await setup();
  const key = '仅测试的密钥-secret-123';
  const settings = await store.saveSettings({ text: { baseUrl: 'https://example.com/v1/chat/completions', model: '测试模型', apiKey: key }, prefs: { selectionEnabled: false } });
  assert.equal(settings.text.hasKey, true);
  assert.equal('apiKey' in settings.text, false);
  const disk = await fs.readFile(path.join(directory, 'settings.json'), 'utf8');
  assert.ok(!disk.includes(key));
  assert.ok(!disk.includes('apiKey'));
  const restarted = createStore(injections);
  await restarted.init();
  assert.equal((await restarted.getSettings({ includeSecrets: true })).text.apiKey, key);
  await restarted.saveSettings({ text: { apiKey: '' }, vision: { baseUrl: 'http://localhost:11434/v1', model: '本地视觉模型' } });
  assert.equal((await restarted.getSettings({ includeSecrets: true })).text.apiKey, key);
  assert.equal((await restarted.getSettings()).prefs.selectionEnabled, false);
  await restarted.saveSettings({ text: { clearKey: true, apiKey: '不应保存' } });
  assert.equal((await restarted.getSettings()).text.hasKey, false);
  assert.equal((await restarted.getSettings({ includeSecrets: true })).text.apiKey, '');
});

test('没有宿主加密能力时拒绝保存密钥并保留原设置', async () => {
  const { directory, store } = await setup({ encrypt: undefined });
  const before = await fs.readFile(path.join(directory, 'settings.json'), 'utf8');
  await assert.rejects(store.saveSettings({ text: { baseUrl: 'https://example.com/v1', model: '模型', apiKey: '私密测试值' } }), { code: 'ENCRYPTION_UNAVAILABLE' });
  assert.equal(await fs.readFile(path.join(directory, 'settings.json'), 'utf8'), before);
});

test('服务厂商草稿分别保存密钥，公开设置不含密文，切换时不继承其他厂商密钥', async () => {
  const { directory, store, injections } = await setup();
  await store.saveSettings({
    text: { providerId: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: 'deepseek-虚构密钥' },
    search: { providerId: 'exa', baseUrl: 'https://api.exa.ai/search', apiKey: 'exa-虚构密钥' },
    serviceProfiles: {
      text: { mimo: { baseUrl: 'https://api.xiaomimimo.com/v1', model: 'mimo-v2.6-pro', apiKey: 'mimo-虚构密钥' } },
    },
  });
  const publicView = await store.getSettings();
  assert.deepEqual(publicView.text, { providerId: 'deepseek', baseUrl: 'https://api.deepseek.com', hasKey: true, model: 'deepseek-flash' });
  assert.equal(publicView.search.providerId, 'exa');
  assert.equal(publicView.serviceProfiles.text.deepseek.hasKey, true);
  assert.equal('apiKey' in publicView.serviceProfiles.text.deepseek, false);
  assert.equal(JSON.stringify(publicView).includes('keyCiphertext'), false);
  assert.equal(JSON.stringify(publicView).includes('deepseek-虚构密钥'), false);

  const privateView = await store.getSettings({ includeSecrets: true });
  assert.equal(privateView.serviceProfiles.text.deepseek.apiKey, 'deepseek-虚构密钥');
  assert.equal(privateView.serviceProfiles.search.exa.apiKey, 'exa-虚构密钥');

  await store.saveSettings({ text: { providerId: 'mimo' } });
  const selected = await store.getSettings({ includeSecrets: true });
  assert.equal(selected.text.providerId, 'mimo');
  assert.equal(selected.text.apiKey, 'mimo-虚构密钥');
  assert.equal(selected.serviceProfiles.text.deepseek.apiKey, 'deepseek-虚构密钥');

  const before = await fs.readFile(path.join(directory, 'settings.json'), 'utf8');
  await assert.rejects(store.saveSettings({ serviceProfiles: { text: { mimo: { baseUrl: 'https://other.example/v1' } } } }), { code: 'KEY_ORIGIN_CHANGED' });
  assert.equal(await fs.readFile(path.join(directory, 'settings.json'), 'utf8'), before);

  const disk = await fs.readFile(path.join(directory, 'settings.json'), 'utf8');
  for (const secret of ['deepseek-虚构密钥', 'mimo-虚构密钥', 'exa-虚构密钥']) assert.equal(disk.includes(secret), false);
  const restarted = createStore(injections); await restarted.init();
  assert.equal((await restarted.getSettings({ includeSecrets: true })).serviceProfiles.text.deepseek.apiKey, 'deepseek-虚构密钥');
});

test('自定义搜索协议随服务草稿保存，预设协议固定且各 provider 密钥隔离', async () => {
  const { directory, store, injections } = await setup();
  const initial = await store.getSettings();
  assert.equal(initial.serviceProfiles.search.custom.protocol, 'exa');
  assert.equal(initial.serviceProfiles.search.custom.baseUrl, '');
  await store.saveSettings({
    search: { providerId: 'custom', protocol: 'brave', baseUrl: 'https://custom.example.test/search', apiKey: 'custom-虚构密钥' },
    serviceProfiles: {
      search: {
        exa: { protocol: 'deepseek', baseUrl: 'https://api.exa.ai/search', apiKey: 'exa-虚构密钥' },
        custom: { protocol: 'deepseek' },
      },
    },
  });

  const publicView = await store.getSettings();
  assert.deepEqual(publicView.search, {
    providerId: 'custom', protocol: 'brave', baseUrl: 'https://custom.example.test/search', hasKey: true,
  });
  assert.equal(publicView.serviceProfiles.search.custom.protocol, 'brave');
  assert.equal(publicView.serviceProfiles.search.exa.protocol, 'exa');
  assert.equal('apiKey' in publicView.serviceProfiles.search.custom, false);

  let privateView = await store.getSettings({ includeSecrets: true });
  assert.equal(privateView.serviceProfiles.search.custom.apiKey, 'custom-虚构密钥');
  assert.equal(privateView.serviceProfiles.search.custom.protocol, 'brave');
  assert.equal(privateView.serviceProfiles.search.exa.apiKey, 'exa-虚构密钥');
  assert.equal(privateView.serviceProfiles.search.exa.protocol, 'exa');

  await store.saveSettings({ search: { providerId: 'exa', protocol: 'deepseek' } });
  privateView = await store.getSettings({ includeSecrets: true });
  assert.equal(privateView.search.protocol, 'exa');
  assert.equal(privateView.search.apiKey, 'exa-虚构密钥');
  await store.saveSettings({ search: { providerId: 'custom' } });
  privateView = await store.getSettings({ includeSecrets: true });
  assert.equal(privateView.search.protocol, 'brave');
  assert.equal(privateView.search.apiKey, 'custom-虚构密钥');

  const disk = await fs.readFile(path.join(directory, 'settings.json'), 'utf8');
  assert.equal(disk.includes('custom-虚构密钥'), false);
  assert.equal(disk.includes('exa-虚构密钥'), false);
  const restarted = createStore(injections); await restarted.init();
  privateView = await restarted.getSettings({ includeSecrets: true });
  assert.equal(privateView.search.protocol, 'brave');
  assert.equal(privateView.serviceProfiles.search.custom.apiKey, 'custom-虚构密钥');
  assert.equal(privateView.serviceProfiles.search.exa.protocol, 'exa');
});

test('自定义搜索协议只接受三个已支持适配', async () => {
  const { directory, store } = await setup();
  const before = await fs.readFile(path.join(directory, 'settings.json'), 'utf8');
  await assert.rejects(store.saveSettings({ search: { providerId: 'custom', protocol: 'arbitrary-template' } }), { code: 'INVALID_INPUT' });
  assert.equal(await fs.readFile(path.join(directory, 'settings.json'), 'utf8'), before);
});

test('旧 version 1 平面密钥迁移到 custom 草稿且截图自动解释默认关闭', async () => {
  const { directory, store, injections } = await setup();
  await store.saveSettings({ text: { baseUrl: 'https://legacy.example/v1', model: '旧模型', apiKey: '旧配置虚构密钥' } });
  const file = path.join(directory, 'settings.json');
  const legacy = JSON.parse(await fs.readFile(file, 'utf8'));
  delete legacy.serviceProfiles; delete legacy.search; delete legacy.text.providerId; delete legacy.vision.providerId;
  delete legacy.prefs.autoExplainCapture; delete legacy.prefs.webSearchEnabled;
  await fs.writeFile(file, JSON.stringify(legacy), 'utf8');
  const restarted = createStore(injections); await restarted.init();
  const migrated = await restarted.getSettings();
  assert.equal(migrated.text.providerId, 'custom');
  assert.equal(migrated.serviceProfiles.text.custom.hasKey, true);
  assert.equal(migrated.prefs.autoExplainCapture, false);
  assert.equal(migrated.prefs.captureExplainMode, 'immediate', '旧 autoExplainCapture=false 不迁移成提示词模式');
  assert.equal(migrated.prefs.webSearchEnabled, false);
  await restarted.saveSettings({ prefs: { autoExplainCapture: true } });
  const privateView = await restarted.getSettings({ includeSecrets: true });
  assert.equal(privateView.serviceProfiles.text.custom.apiKey, '旧配置虚构密钥');
  assert.equal(privateView.prefs.autoExplainCapture, true);
});

test('截图解释模式只接受立即识别或先补充提示词，旧配置默认立即识别', async () => {
  const { directory, store, injections } = await setup();
  assert.equal((await store.getSettings()).prefs.captureExplainMode, 'immediate');
  await store.saveSettings({ prefs: { captureExplainMode: 'prompt' } });
  const restarted = createStore(injections); await restarted.init();
  assert.equal((await restarted.getSettings()).prefs.captureExplainMode, 'prompt');
  const file = path.join(directory, 'settings.json'), raw = JSON.parse(await fs.readFile(file, 'utf8'));
  await assert.rejects(restarted.saveSettings({ prefs: { captureExplainMode: 'unknown' } }), /截图解释模式无效/);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).prefs.captureExplainMode, raw.prefs.captureExplainMode);

  raw.prefs.autoExplainCapture = false;
  delete raw.prefs.captureExplainMode;
  await fs.writeFile(file, JSON.stringify(raw), 'utf8');
  const legacy = createStore(injections); await legacy.init();
  assert.equal((await legacy.getSettings()).prefs.captureExplainMode, 'immediate');
  assert.equal((await legacy.getSettings()).prefs.autoExplainCapture, false, '保留旧字段，但不据此推导新模式');
});

test('联网开关、contextPending、requestQuestion 与安全来源随会话历史保存', async () => {
  const { store, injections } = await setup();
  const created = await store.createSession({ text: '选定内容', contextPending: true });
  assert.equal(created.webSearchEnabled, false);
  assert.equal(created.contextPending, true);
  const source = { id: 1, title: '官方资料', url: 'https://example.com/docs', snippet: '可引用的内容' };
  await store.updateSession(created.id, {
    webSearchEnabled: true,
    contextPending: false,
    threads: { context: { messages: [{ id: 'assistant-1', role: 'assistant', content: '回答 [1]', requestQuestion: '补充解释', search: { status: 'complete', providerId: 'exa', query: '简短问题', sources: [source] } }] } },
  });
  const restarted = createStore(injections); await restarted.init();
  const loaded = await restarted.getSession(created.id);
  assert.equal(loaded.webSearchEnabled, true);
  assert.equal(loaded.contextPending, false);
  assert.equal(loaded.threads.context.messages[0].requestQuestion, '补充解释');
  assert.deepEqual(loaded.threads.context.messages[0].search.sources, [source]);

  for (const invalidUrl of ['file:///private.txt', 'javascript:alert(1)', 'https://user:pass@example.com']) {
    await assert.rejects(store.updateSession(created.id, { threads: { context: { messages: [{ id: 'unsafe', role: 'assistant', content: 'x', search: { status: 'complete', providerId: 'exa', query: 'x', sources: [{ id: 1, title: '不安全', url: invalidUrl }] } }] } } }), { code: 'INVALID_INPUT' });
  }
  await assert.rejects(store.updateSession(created.id, { threads: { context: { messages: [{ id: 'too-many', role: 'assistant', content: 'x', search: { status: 'complete', providerId: 'exa', query: 'x', sources: Array.from({ length: 11 }, (_, index) => ({ id: index + 1, title: '标题', url: `https://example.com/${index}` })) } }] } } }), { code: 'INVALID_INPUT' });
});

test('全局联网偏好默认关闭、供新会话继承并在重启后保留', async () => {
  const { store, injections } = await setup();
  const existing = await store.createSession({ text: '既有材料' });
  assert.equal(existing.webSearchEnabled, false);

  const savedSettings = await store.saveSettings({ prefs: { webSearchEnabled: true } });
  assert.equal(savedSettings.prefs.webSearchEnabled, true);
  const inherited = await store.createSession({ text: '新材料' });
  assert.equal(inherited.webSearchEnabled, true);
  const explicitOverride = await store.createSession({ text: '显式关闭的新材料', webSearchEnabled: false });
  assert.equal(explicitOverride.webSearchEnabled, false);
  assert.equal((await store.getSession(existing.id)).webSearchEnabled, false, '全局默认值不能改写既有会话');

  const restarted = createStore(injections);
  await restarted.init();
  assert.equal((await restarted.getSettings()).prefs.webSearchEnabled, true);
  const afterRestart = await restarted.createSession({ text: '重启后的新材料' });
  assert.equal(afterRestart.webSearchEnabled, true);
  assert.equal((await restarted.getSession(existing.id)).webSearchEnabled, false);
});

test('联网搜索词按 Unicode 码点计数并与搜索请求上限一致', async () => {
  const { store } = await setup();
  const session = await store.createSession({ text: '选定内容' });
  const query = '𠮷'.repeat(128);
  await store.updateSession(session.id, { threads: { context: { messages: [{ id: 'unicode-query', role: 'assistant', content: '完成', search: { status: 'complete', providerId: 'deepseek', query, sources: [] } }] } } });
  const loaded = await store.getSession(session.id);
  assert.equal(loaded.threads.context.messages[0].search.query, query);
  await assert.rejects(store.updateSession(session.id, { threads: { context: { messages: [{ id: 'too-long-query', role: 'assistant', content: '失败', search: { status: 'failed', providerId: 'deepseek', query: '𠮷'.repeat(129), sources: [] } }] } } }));
});

test('删除整会话委托宿主回收站，可从宿主保留的目录恢复', async () => {
  let trashed;
  const { directory, store } = await setup({ trash: async (target) => { trashed = `${target}.回收站测试`; await fs.rename(target, trashed); } });
  const session = await store.createSession({ kind: 'image', imageData, note: '可恢复截图' });
  assert.deepEqual(await store.deleteSession(session.id), { id: session.id, deleted: true });
  await assert.rejects(store.getSession(session.id), { code: 'NOT_FOUND' });
  assert.equal((await fs.readFile(path.join(trashed, 'crop.png'))).length > 0, true);
  await fs.rename(trashed, path.join(directory, 'sessions', session.id));
  assert.equal((await store.getSession(session.id)).imageData, imageData);
});

test('回收站不可用或失败时保留会话', async () => {
  const { store } = await setup();
  const session = await store.createSession({ text: '保留的选定内容' });
  await assert.rejects(store.deleteSession(session.id), { code: 'TRASH_UNAVAILABLE' });
  assert.equal((await store.getSession(session.id)).text, session.text);
  const failed = await setup({ trash: async () => { throw new Error('宿主错误'); } });
  const other = await failed.store.createSession({ text: '另一个保留会话' });
  await assert.rejects(failed.store.deleteSession(other.id), { code: 'TRASH_FAILED' });
  assert.equal((await failed.store.getSession(other.id)).text, other.text);
});

test('宿主声称已回收但会话目录仍在时，不报告删除成功', async () => {
  const { directory, store } = await setup({ trash: async () => {} });
  const session = await store.createSession({ kind: 'image', imageData, note: '虚构截图说明' });
  const folder = path.join(directory, 'sessions', session.id);
  const before = {
    record: await fs.readFile(path.join(folder, 'session.json')),
    image: await fs.readFile(path.join(folder, 'crop.png')),
  };
  await assert.rejects(store.deleteSession(session.id), { code: 'TRASH_FAILED' });
  assert.deepEqual(await fs.readFile(path.join(folder, 'session.json')), before.record);
  assert.deepEqual(await fs.readFile(path.join(folder, 'crop.png')), before.image);
  assert.equal((await store.listSessions()).length, 1);
});

test('非法会话标识被所有读写删入口拒绝，不能目录穿越', async () => {
  const { store } = await setup({ trash: async () => { assert.fail('不应调用宿主'); } });
  for (const id of ['../settings.json', '..', '', '1234', '00000000-0000-0000-0000-000000000000/../', null]) {
    await assert.rejects(store.getSession(id), { code: 'INVALID_ID' });
    await assert.rejects(store.updateSession(id, { note: '更改' }), { code: 'INVALID_ID' });
    await assert.rejects(store.deleteSession(id), { code: 'INVALID_ID' });
  }
});

test('损坏会话不能被更新悄悄覆盖，损坏设置不能重新初始化覆盖', async () => {
  const { directory, store, injections } = await setup();
  const session = await store.createSession({ text: '原始材料' });
  const sessionPath = path.join(directory, 'sessions', session.id, 'session.json');
  await fs.writeFile(sessionPath, '{损坏JSON', 'utf8');
  await assert.rejects(store.updateSession(session.id, { text: '替换材料' }), { code: 'DATA_CORRUPT' });
  await assert.rejects(store.listSessions(), { code: 'DATA_CORRUPT' });
  assert.equal(await fs.readFile(sessionPath, 'utf8'), '{损坏JSON');
  const settingsPath = path.join(directory, 'settings.json');
  await fs.writeFile(settingsPath, '{损坏设置', 'utf8');
  await assert.rejects(createStore(injections).init(), { code: 'DATA_CORRUPT' });
  assert.equal(await fs.readFile(settingsPath, 'utf8'), '{损坏设置');
});

test('并发更新串行落盘，保留独立字段与原有线程', async () => {
  const { store } = await setup();
  const session = await store.createSession({ text: '选定内容' });
  assert.equal(session.activeMode, 'context');
  await Promise.all([
    store.updateSession(session.id, { context: '上下文段落', threads: { context: { draft: '语境追问' } } }),
    store.updateSession(session.id, { saved: true, threads: { independent: { draft: '独立追问' } } }),
  ]);
  const updated = await store.getSession(session.id);
  assert.equal(updated.saved, true);
  assert.equal(updated.context, '上下文段落');
  assert.equal(updated.threads.context.draft, '语境追问');
  assert.equal(updated.threads.independent.draft, '独立追问');
});
