'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { LIMITS, MODES, failure, string, uuid, png } = require('./validation.cjs');
const { normalizeConfig } = require('./provider.cjs');
const { historyEntry } = require('./history.cjs');
const { defaultAppearance, appearanceShape, defaultWindowGeometry, windowGeometryShape } = require('./appearance.cjs');
const { DEFAULT_SHORTCUTS, shortcutsShape } = require('./shortcuts.cjs');
const { MODEL_PROVIDERS, SEARCH_PROVIDERS } = require('./services.cjs');
const { translationOptions } = require('./translation.cjs');

const MODEL_PROVIDER_IDS = new Set(MODEL_PROVIDERS.map(provider => provider.id));
const SEARCH_PROVIDER_IDS = new Set(SEARCH_PROVIDERS.map(provider => provider.id));
const SEARCH_PROTOCOL_IDS = new Set(['exa', 'brave', 'deepseek']);
const SEARCH_STATUSES = new Set(['preparing', 'searching', 'complete', 'failed']);
const MAX_SEARCH_SOURCES = 10;

function providerConfigDefaults(name) {
  const providers = name === 'search' ? SEARCH_PROVIDERS : MODEL_PROVIDERS;
  return Object.fromEntries(providers.map(provider => [provider.id, {
    baseUrl: provider.baseUrl,
    ...(name === 'search' ? { protocol: provider.protocol ?? provider.id } : {}),
    ...(name === 'search' ? {} : { model: provider.model ?? '' }),
  }]));
}

function normalizedSearchProtocol(providerId, value, fallback = providerId) {
  // 官方预设的协议由厂商决定；仅自定义服务读取并保存可选协议。
  if (providerId !== 'custom') return providerId;
  const protocol = value === undefined ? fallback : string(value, '搜索协议', 80);
  if (!SEARCH_PROTOCOL_IDS.has(protocol)) throw failure('INVALID_INPUT', '自定义搜索协议无效。');
  return protocol;
}

function validCiphertext(value) {
  const ciphertext = string(value, '加密密钥', 65536);
  if (!ciphertext || Buffer.from(ciphertext, 'base64').toString('base64') !== ciphertext) throw failure('INVALID_INPUT', '加密密钥数据无效。');
  return ciphertext;
}

function searchSources(input) {
  if (!Array.isArray(input) || input.length > MAX_SEARCH_SOURCES) throw failure('INVALID_INPUT', '联网来源列表无效。');
  const ids = new Set();
  return input.map((source) => {
    object(source, '联网来源');
    if (!Number.isSafeInteger(source.id) || source.id <= 0 || ids.has(source.id)) throw failure('INVALID_INPUT', '联网来源编号无效。');
    ids.add(source.id);
    const title = string(source.title, '联网来源标题', 500).trim();
    const rawUrl = string(source.url, '联网来源地址', 2048).trim();
    let url;
    try { url = new URL(rawUrl); } catch { throw failure('INVALID_INPUT', '联网来源地址无效。'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !title) throw failure('INVALID_INPUT', '联网来源必须包含标题和 HTTP/HTTPS 地址。');
    const result = { id: source.id, title, url: rawUrl };
    if (source.snippet !== undefined) result.snippet = string(source.snippet, '联网来源摘录', 4000);
    return result;
  });
}

function searchMetadata(input) {
  object(input, '联网搜索记录');
  if (!SEARCH_STATUSES.has(input.status)) throw failure('INVALID_INPUT', '联网搜索状态无效。');
  if (!SEARCH_PROVIDER_IDS.has(input.providerId)) throw failure('INVALID_INPUT', '联网搜索服务无效。');
  const query = string(input.query, '联网搜索词', 256);
  if (Array.from(query).length > 128) throw failure('INVALID_INPUT', '联网搜索词超过 128 个 Unicode 字符。');
  const result = {
    status: input.status,
    providerId: input.providerId,
    query,
    sources: searchSources(input.sources),
  };
  if (input.error !== undefined) result.error = string(input.error, '联网搜索错误说明', 1000);
  return result;
}

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('INVALID_INPUT', `${name}必须是对象。`);
  return value;
}

function bool(value, name) {
  if (typeof value !== 'boolean') throw failure('INVALID_INPUT', `${name}必须是布尔值。`);
  return value;
}

function orbAction(value) {
  if (!['chat', 'capture'].includes(value)) throw failure('INVALID_INPUT', '悬浮球左键功能无效。');
  return value;
}

function date(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw failure('INVALID_INPUT', '解释会话时间无效。');
  return value;
}

function sessionShape(input) {
  object(input, '解释会话');
  const id = uuid(input.id);
  if (!['text', 'image'].includes(input.kind)) throw failure('INVALID_INPUT', '选定内容类型无效。');
  if (!MODES.includes(input.activeMode)) throw failure('INVALID_MODE', '解释模式无效。');
  const source = object(input.source, '来源');
  const threads = object(input.threads, '解释记录');
  const result = {
    id, kind: input.kind,
    title: string(input.title ?? '', '会话标题', 200).trim(),
    text: string(input.text, '选定内容', LIMITS.text),
    context: string(input.context, '上下文', LIMITS.context),
    contextPending: bool(input.contextPending ?? false, '上下文提取状态'),
    contextOrigin: string(input.contextOrigin, '上下文来源', 1000),
    contextReason: string(input.contextReason ?? '', '上下文缺失原因', 1000),
    source: { app: string(source.app, '来源应用', 1000), title: string(source.title, '来源标题', 2000), method: string(source.method, '采集方式', 200) },
    note: string(input.note, '截图说明', 4000),
    createdAt: date(input.createdAt), updatedAt: date(input.updatedAt),
    saved: bool(input.saved, '收藏状态'), activeMode: input.activeMode,
    webSearchEnabled: bool(input.webSearchEnabled ?? false, '联网搜索状态'), threads: {},
  };
  for (const mode of MODES) {
    const thread = object(threads[mode], '解释记录');
    if (!Array.isArray(thread.messages)) throw failure('INVALID_INPUT', '解释消息必须是列表。');
    result.threads[mode] = {
      messages: thread.messages.map((message) => {
        object(message, '解释消息');
        if (!['user', 'assistant'].includes(message.role)) throw failure('INVALID_INPUT', '解释消息角色无效。');
        const item = { id: string(message.id, '消息标识', 200), role: message.role, content: string(message.content, '消息内容', 1024 * 1024) };
        if (!item.id) throw failure('INVALID_INPUT', '消息标识不能为空。');
        if (message.status !== undefined) item.status = string(message.status, '消息状态', 100);
        if (message.error !== undefined) item.error = string(message.error, '消息错误说明', 4000);
        if (message.requestQuestion !== undefined) {
          if (message.role !== 'assistant') throw failure('INVALID_INPUT', '只有助手消息可以保存本次问题。');
          item.requestQuestion = string(message.requestQuestion, '本次问题', 4000);
        }
        if (message.search !== undefined) {
          if (message.role !== 'assistant') throw failure('INVALID_INPUT', '只有助手消息可以保存联网搜索记录。');
          item.search = searchMetadata(message.search);
        }
        return item;
      }),
      draft: string(thread.draft, '追问草稿', 4000),
    };
    if (thread.status !== undefined) result.threads[mode].status = string(thread.status, '解释记录状态', 100);
    if (thread.error !== undefined) result.threads[mode].error = string(thread.error, '解释记录错误说明', 4000);
  }
  // 旧记录没有独立问答时间：有问答时以原更新时间近似，无问答时使用建立时间。
  // 下一次正常保存会固定这个值，之后改名、草稿、收藏等不再推动历史排序。
  const hasMessages = MODES.some(mode => result.threads[mode].messages.length > 0);
  result.lastActivityAt = date(input.lastActivityAt ?? (hasMessages ? result.updatedAt : result.createdAt));
  return result;
}

function captureDefaultMode(value) {
  if (!['explain', 'translate'].includes(value)) throw failure('INVALID_INPUT', '截图默认模式无效。');
  return value;
}

function captureExplainMode(value) {
  if (!['immediate', 'prompt'].includes(value)) throw failure('INVALID_INPUT', '截图解释模式无效。');
  return value;
}

function defaults() {
  return {
    version: 1,
    text: { providerId: 'custom', baseUrl: '', model: '' },
    vision: { providerId: 'custom', baseUrl: '', model: '' },
    translation: { providerId: 'custom', baseUrl: '', model: '' },
    search: { providerId: 'exa', baseUrl: SEARCH_PROVIDERS.find(provider => provider.id === 'exa').baseUrl },
    serviceProfiles: { text: providerConfigDefaults('text'), vision: providerConfigDefaults('vision'), translation: providerConfigDefaults('translation'), search: providerConfigDefaults('search') },
    prefs: {
      showOrb: true, selectionEnabled: true, orbAction: 'chat', autoExplainCapture: false, launchAtLogin: false,
      screenshotTranslation: translationOptions(), captureDefaultMode: 'explain', captureExplainMode: 'immediate',
      webSearchEnabled: false, appearance: defaultAppearance(), windowGeometry: defaultWindowGeometry(), shortcuts: { ...DEFAULT_SHORTCUTS }, pinSound: true,
    },
  };
}

function settingsShape(input) {
  object(input, '设置');
  if (input.version !== 1) throw failure('INVALID_INPUT', '设置版本不受支持。');
  const result = { version: 1, prefs: {}, serviceProfiles: {} };
  for (const name of ['text', 'vision', 'translation']) {
    const config = object(name === 'translation' && input[name] === undefined ? { baseUrl: '', model: '' } : input[name], '接口设置');
    const providerId = config.providerId === undefined ? 'custom' : string(config.providerId, '模型服务', 80);
    if (!MODEL_PROVIDER_IDS.has(providerId)) throw failure('INVALID_INPUT', '模型服务无效。');
    result[name] = { providerId, baseUrl: string(config.baseUrl, '接口地址', 2048), model: string(config.model, '模型名称', 300) };
    if (config.keyCiphertext !== undefined) {
      result[name].keyCiphertext = validCiphertext(config.keyCiphertext);
    }
    // 明文密钥不能作为合法的磁盘格式读取或再次写入。
    if ('apiKey' in config) throw failure('INVALID_INPUT', '检测到不受支持的明文密钥设置。');
  }
  const suppliedProfiles = input.serviceProfiles === undefined ? {} : object(input.serviceProfiles, '服务配置草稿');
  const oldSearch = input.search === undefined ? {} : object(input.search, '联网搜索设置');
  const searchProviderId = oldSearch.providerId === undefined ? 'exa' : string(oldSearch.providerId, '搜索服务', 80);
  if (!SEARCH_PROVIDER_IDS.has(searchProviderId)) throw failure('INVALID_INPUT', '搜索服务无效。');
  const searchProvider = SEARCH_PROVIDERS.find(provider => provider.id === searchProviderId);
  const defaultSearchUrl = searchProvider.baseUrl;
  const searchProfilesInput = suppliedProfiles.search === undefined ? {} : object(suppliedProfiles.search, '服务配置草稿');
  const activeSearchProfileInput = searchProfilesInput[searchProviderId] === undefined ? {} : object(searchProfilesInput[searchProviderId], '厂商配置');
  result.search = {
    providerId: searchProviderId,
    protocol: normalizedSearchProtocol(searchProviderId, oldSearch.protocol, activeSearchProfileInput.protocol ?? searchProvider.protocol ?? searchProviderId),
    baseUrl: string(oldSearch.baseUrl ?? defaultSearchUrl, '搜索接口地址', 2048),
  };
  if (oldSearch.keyCiphertext !== undefined) result.search.keyCiphertext = validCiphertext(oldSearch.keyCiphertext);
  if ('apiKey' in oldSearch) throw failure('INVALID_INPUT', '检测到不受支持的明文搜索密钥设置。');

  for (const name of ['text', 'vision', 'translation', 'search']) {
    const providers = name === 'search' ? SEARCH_PROVIDER_IDS : MODEL_PROVIDER_IDS;
    const profiles = providerConfigDefaults(name);
    if (suppliedProfiles[name] !== undefined) {
      const source = object(suppliedProfiles[name], '服务配置草稿');
      for (const [providerId, value] of Object.entries(source)) {
        if (!providers.has(providerId)) throw failure('INVALID_INPUT', '服务配置草稿中的厂商无效。');
        const config = object(value, '厂商配置');
        if (config.providerId !== undefined && config.providerId !== providerId) throw failure('INVALID_INPUT', '厂商配置标识不匹配。');
        profiles[providerId].baseUrl = string(config.baseUrl ?? profiles[providerId].baseUrl, '接口地址', 2048);
        if (name === 'search') profiles[providerId].protocol = normalizedSearchProtocol(providerId, config.protocol, profiles[providerId].protocol);
        else profiles[providerId].model = string(config.model ?? profiles[providerId].model, '模型名称', 300);
        if (config.keyCiphertext !== undefined) profiles[providerId].keyCiphertext = validCiphertext(config.keyCiphertext);
        if ('apiKey' in config) throw failure('INVALID_INPUT', '检测到不受支持的明文密钥设置。');
      }
    }
    result.serviceProfiles[name] = profiles;
    // 平面配置是当前选中配置的兼容视图。旧 version 1 数据没有 profiles 时，
    // 把原地址、模型和密钥放入 custom 草稿，之后切换厂商不会借用旧密钥。
    const active = result[name];
    const profile = profiles[active.providerId];
    profile.baseUrl = active.baseUrl;
    if (name === 'search') profile.protocol = active.protocol;
    else profile.model = active.model;
    if (active.keyCiphertext !== undefined) profile.keyCiphertext = active.keyCiphertext;
    else delete profile.keyCiphertext;
  }
  const prefs = object(input.prefs, '偏好设置');
  result.prefs.showOrb = bool(prefs.showOrb, '悬浮球显示状态');
  result.prefs.selectionEnabled = bool(prefs.selectionEnabled, '划词状态');
  result.prefs.orbAction = orbAction(prefs.orbAction === undefined ? 'chat' : prefs.orbAction);
  result.prefs.autoExplainCapture = prefs.autoExplainCapture === undefined ? false : bool(prefs.autoExplainCapture, '截图后自动解释状态');
  result.prefs.launchAtLogin = prefs.launchAtLogin === undefined ? false : bool(prefs.launchAtLogin, '开机自启动状态');
  result.prefs.screenshotTranslation = translationOptions(prefs.screenshotTranslation);
  result.prefs.captureDefaultMode = captureDefaultMode(prefs.captureDefaultMode ?? 'explain');
  result.prefs.captureExplainMode = captureExplainMode(prefs.captureExplainMode ?? 'immediate');
  result.prefs.webSearchEnabled = prefs.webSearchEnabled === undefined ? false : bool(prefs.webSearchEnabled, '默认联网搜索状态');
  // 旧版没有这些字段时只补齐默认值，仍保留原服务配置与加密密钥。
  result.prefs.appearance = prefs.appearance === undefined ? defaultAppearance() : appearanceShape(prefs.appearance);
  result.prefs.windowGeometry = prefs.windowGeometry === undefined ? defaultWindowGeometry() : windowGeometryShape(prefs.windowGeometry);
  result.prefs.shortcuts = prefs.shortcuts === undefined ? { ...DEFAULT_SHORTCUTS } : shortcutsShape(prefs.shortcuts);
  result.prefs.pinSound = prefs.pinSound === undefined ? true : bool(prefs.pinSound, '置顶提示音状态');
  return result;
}

function createStore({ directory, encrypt, decrypt, trash } = {}) {
  if (typeof directory !== 'string' || !directory.trim()) throw failure('INVALID_CONFIG', '本地保存目录无效。');
  const root = path.resolve(directory);
  const sessionsRoot = path.join(root, 'sessions');
  const settingsPath = path.join(root, 'settings.json');
  let initialized;
  let queue = Promise.resolve();

  async function ensureDirectory(target, create = false) {
    if (create) await fs.mkdir(target, { recursive: true });
    const stat = await fs.lstat(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('UNSAFE_PATH', '本地保存目录不是普通目录。');
  }

  async function readJSON(target) {
    const stat = await fs.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024) throw failure('DATA_CORRUPT', '本地数据文件无效，请保留原文件并检查备份。');
    try { return JSON.parse(await fs.readFile(target, 'utf8')); }
    catch (error) {
      if (error instanceof SyntaxError) throw failure('DATA_CORRUPT', '本地数据已损坏，已停止操作以保留原文件。');
      throw error;
    }
  }

  async function atomic(target, content) {
    const temporary = `${target}.${randomUUID()}.tmp`;
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(content); await handle.sync(); }
    finally { await handle.close(); }
    // 写入失败时保留临时文件，以便恢复；不执行永久删除。
    await fs.rename(temporary, target);
  }

  async function diskSettings() {
    try { return settingsShape(await readJSON(settingsPath)); }
    catch (error) {
      if (['INVALID_INPUT', 'INPUT_TOO_LONG', 'INVALID_CONFIG'].includes(error.code)) throw failure('DATA_CORRUPT', '本地设置无效，已停止操作以保留原文件。');
      throw error;
    }
  }

  async function publicSettings(settings, includeSecrets) {
    const result = { prefs: { ...settings.prefs }, serviceProfiles: {} };
    const decryptKey = async (ciphertext) => {
      if (!ciphertext) return '';
      if (typeof decrypt !== 'function') throw failure('ENCRYPTION_UNAVAILABLE', '当前环境无法解密已保存的接口密钥。');
      try { return string(await decrypt(Buffer.from(ciphertext, 'base64')), '接口密钥', 8192); }
      catch { throw failure('DECRYPTION_FAILED', '无法解密已保存的接口密钥，请重新填写接口密钥。'); }
    };
    for (const name of ['text', 'vision', 'translation', 'search']) {
      const config = settings[name];
      result[name] = { providerId: config.providerId, baseUrl: config.baseUrl, hasKey: Boolean(config.keyCiphertext) };
      if (name === 'search') result[name].protocol = config.protocol;
      if (name !== 'search') result[name].model = config.model;
      if (includeSecrets) {
        result[name].apiKey = await decryptKey(config.keyCiphertext);
      }
      result.serviceProfiles[name] = {};
      for (const [providerId, profile] of Object.entries(settings.serviceProfiles[name])) {
        const visible = {
          baseUrl: profile.baseUrl,
          ...(name === 'search' ? { protocol: profile.protocol } : {}),
          ...(name === 'search' ? {} : { model: profile.model }),
          hasKey: Boolean(profile.keyCiphertext),
        };
        if (includeSecrets) visible.apiKey = await decryptKey(profile.keyCiphertext);
        result.serviceProfiles[name][providerId] = visible;
      }
    }
    return result;
  }

  async function readSession(id, { includeImage = true } = {}) {
    const canonical = uuid(id);
    const folder = path.join(sessionsRoot, canonical);
    try {
      await ensureDirectory(folder);
      const raw = await readJSON(path.join(folder, 'session.json'));
      let session;
      try { session = sessionShape(raw); }
      catch { throw failure('DATA_CORRUPT', '解释会话数据无效，已停止操作以保留原文件。'); }
      if (session.id !== canonical) throw failure('DATA_CORRUPT', '解释会话标识与保存目录不一致。');
      if (session.kind === 'image') {
        const imagePath = path.join(folder, 'crop.png');
        const imageStat = await fs.lstat(imagePath);
        if (!imageStat.isFile() || imageStat.isSymbolicLink() || imageStat.size < 33 || imageStat.size > LIMITS.imageBytes) throw failure('DATA_CORRUPT', '解释会话截图数据无效。');
        if (includeImage) {
          session.imageData = `data:image/png;base64,${(await fs.readFile(imagePath)).toString('base64')}`;
          try { png(session.imageData); } catch { throw failure('DATA_CORRUPT', '解释会话截图数据已损坏。'); }
        }
      }
      return session;
    } catch (error) {
      if (error.code === 'ENOENT') {
        // 目录存在但文件缺失属于损坏，不应被当作可新建的空会话。
        try { await fs.lstat(folder); }
        catch (statError) { if (statError.code === 'ENOENT') throw failure('NOT_FOUND', '解释会话不存在或已移入回收站。'); throw statError; }
        throw failure('DATA_CORRUPT', '解释会话文件缺失，已停止操作以保留现有数据。');
      }
      throw error;
    }
  }

  async function applyServiceChange(config, change, name, providerId = config.providerId) {
    const previousBaseUrl = config.baseUrl;
    if (change.baseUrl !== undefined) config.baseUrl = string(change.baseUrl, '接口地址', 2048).trim();
    if (name === 'search') config.protocol = normalizedSearchProtocol(providerId, change.protocol, config.protocol ?? providerId);
    else if (change.model !== undefined) config.model = string(change.model, '模型名称', 300).trim();
    if (config.baseUrl) {
      if (name === 'search') {
        let url;
        try { url = new URL(config.baseUrl); } catch { throw failure('INVALID_CONFIG', '搜索接口地址必须是有效的 HTTP 或 HTTPS 地址。'); }
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
            (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase()))) {
          throw failure('INVALID_CONFIG', '搜索接口地址只允许 HTTPS；HTTP 仅允许本机地址，且不能包含凭据、查询参数或片段。');
        }
        config.baseUrl = url.toString().replace(/\/+$/, '');
      } else config.baseUrl = normalizeConfig({ ...config, model: config.model || '待配置' }).baseUrl;
    }
    const key = change.clearKey === true || change.apiKey === undefined ? '' : string(change.apiKey, '接口密钥', 8192).trim();
    if (/[\r\n]/.test(key)) throw failure('INVALID_CONFIG', '接口密钥格式无效。');
    if (config.keyCiphertext && change.baseUrl !== undefined && change.clearKey !== true && !key) {
      const origin = (address) => { try { return new URL(address).origin; } catch { return null; } };
      if (origin(previousBaseUrl) !== origin(config.baseUrl)) {
        throw failure('KEY_ORIGIN_CHANGED', '服务地址已跨主机、协议或端口更改，请重新输入该服务的密钥或明确清除原密钥。');
      }
    }
    if (change.clearKey === true) delete config.keyCiphertext;
    else if (change.apiKey !== undefined && key) {
      if (typeof encrypt !== 'function') throw failure('ENCRYPTION_UNAVAILABLE', 'Windows 加密存储不可用，无法保存接口密钥。');
      let encrypted;
      try { encrypted = await encrypt(key); } catch { throw failure('ENCRYPTION_FAILED', '接口密钥加密失败，设置未保存。'); }
      if (!(encrypted instanceof Uint8Array) || !encrypted.length) throw failure('ENCRYPTION_FAILED', '接口密钥加密失败，设置未保存。');
      config.keyCiphertext = Buffer.from(encrypted).toString('base64');
    }
  }

  async function applyProfileChanges(settings, changes) {
    if (changes === undefined) return;
    const profileChanges = object(changes, '服务配置草稿');
    for (const name of ['text', 'vision', 'translation', 'search']) {
      if (profileChanges[name] === undefined) continue;
      const profiles = object(profileChanges[name], '服务配置草稿');
      const known = name === 'search' ? SEARCH_PROVIDER_IDS : MODEL_PROVIDER_IDS;
      for (const [providerId, rawChange] of Object.entries(profiles)) {
        if (!known.has(providerId)) throw failure('INVALID_INPUT', '服务配置草稿中的厂商无效。');
        const change = object(rawChange, '厂商配置');
        if (change.providerId !== undefined && change.providerId !== providerId) throw failure('INVALID_INPUT', '厂商配置标识不匹配。');
        await applyServiceChange(settings.serviceProfiles[name][providerId], change, name, providerId);
      }
    }
  }

  async function applyActiveConfigChanges(settings, changes) {
    for (const name of ['text', 'vision', 'translation', 'search']) {
      if (changes[name] === undefined) continue;
      const change = object(changes[name], name === 'search' ? '联网搜索设置' : '接口设置');
      const ids = name === 'search' ? SEARCH_PROVIDER_IDS : MODEL_PROVIDER_IDS;
      const providerId = change.providerId === undefined ? settings[name].providerId : string(change.providerId, '服务提供商', 80);
      if (!ids.has(providerId)) throw failure('INVALID_INPUT', '服务提供商无效。');
      if (providerId !== settings[name].providerId) {
        const profile = settings.serviceProfiles[name][providerId];
        settings[name] = { providerId, ...structuredClone(profile) };
      }
      await applyServiceChange(settings[name], change, name, providerId);
      settings[name].providerId = providerId;
      settings.serviceProfiles[name][providerId] = structuredClone(Object.fromEntries(
        Object.entries(settings[name]).filter(([key]) => key !== 'providerId'),
      ));
    }
  }

  function synchronizeActiveProfiles(settings) {
    for (const name of ['text', 'vision', 'translation', 'search']) {
      const providerId = settings[name].providerId;
      settings.serviceProfiles[name][providerId] = structuredClone(Object.fromEntries(
        Object.entries(settings[name]).filter(([key]) => key !== 'providerId'),
      ));
    }
  }

  function run(action) {
    const next = queue.then(async () => {
      if (!initialized) throw failure('NOT_INITIALIZED', '本地存储尚未初始化。');
      await initialized;
      return action();
    });
    queue = next.catch(() => {});
    return next;
  }

  const api = {
    async init() {
      if (!initialized) initialized = (async () => {
        await ensureDirectory(root, true);
        await ensureDirectory(sessionsRoot, true);
        try { await diskSettings(); }
        catch (error) {
          if (error.code !== 'ENOENT') throw error;
          await atomic(settingsPath, JSON.stringify(defaults(), null, 2));
        }
      })();
      await initialized;
    },
    createSession(input = {}) {
      return run(async () => {
        object(input, '解释会话');
        const id = randomUUID();
        const now = new Date().toISOString();
        const webSearchEnabled = input.webSearchEnabled ?? (await diskSettings()).prefs.webSearchEnabled;
        const emptyThreads = Object.fromEntries(MODES.map((mode) => [mode, { messages: [], draft: '' }]));
        const session = sessionShape({ id, kind: input.kind ?? 'text', title: input.title ?? '', text: input.text ?? '', context: input.context ?? '', contextPending: input.contextPending ?? false, contextOrigin: input.contextOrigin ?? '', contextReason: input.contextReason ?? '',
          source: { app: '', title: '', method: '', ...input.source }, note: input.note ?? '', createdAt: now, updatedAt: now,
          saved: input.saved ?? false, activeMode: input.activeMode ?? (input.kind === 'image' ? 'visual' : 'context'), webSearchEnabled, threads: input.threads ?? emptyThreads });
        const image = session.kind === 'image' ? png(input.imageData) : null;
        const folder = path.join(sessionsRoot, id);
        await fs.mkdir(folder);
        if (image) await atomic(path.join(folder, 'crop.png'), image);
        await atomic(path.join(folder, 'session.json'), JSON.stringify(session, null, 2));
        return readSession(id);
      });
    },
    getSession(id) { return run(() => readSession(id)); },
    listSessions() {
      return run(async () => {
        const entries = await fs.readdir(sessionsRoot, { withFileTypes: true });
        const candidates = entries.filter(entry => (entry.isDirectory() || entry.isSymbolicLink()) && /^[0-9a-f-]{36}$/i.test(entry.name));
        const result = new Array(candidates.length);
        let cursor = 0;
        // 限制同时读取数量；大历史无需逐个串行等待，也不会一次打开上千个文件。
        const reads = await Promise.allSettled(Array.from({ length: Math.min(12, candidates.length) }, async () => {
          while (cursor < candidates.length) {
            const index = cursor++;
            result[index] = historyEntry(await readSession(candidates[index].name, { includeImage: false }));
          }
        }));
        const failed = reads.find(result => result.status === 'rejected');
        if (failed) throw failed.reason;
        return result.sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt) || a.id.localeCompare(b.id));
      });
    },
    updateSession(id, changes) {
      return run(async () => {
        object(changes, '会话更新');
        const old = await readSession(id);
        const merged = { ...old, source: { ...old.source }, threads: structuredClone(old.threads) };
        for (const key of ['title', 'text', 'context', 'contextPending', 'contextOrigin', 'contextReason', 'note', 'saved', 'activeMode', 'webSearchEnabled']) if (changes[key] !== undefined) merged[key] = changes[key];
        if (changes.source !== undefined) merged.source = { ...old.source, ...object(changes.source, '来源') };
        if (changes.threads !== undefined) {
          object(changes.threads, '解释记录');
          for (const mode of MODES) if (changes.threads[mode] !== undefined) merged.threads[mode] = { ...old.threads[mode], ...object(changes.threads[mode], '解释记录') };
        }
        merged.updatedAt = new Date(Math.max(Date.now(), Date.parse(old.updatedAt) + 1)).toISOString();
        const session = sessionShape(merged);
        const newActivity = MODES.some(mode => {
          const known = new Set(old.threads[mode].messages.map(message => message.id));
          return session.threads[mode].messages.some(message => !known.has(message.id));
        });
        if (newActivity) session.lastActivityAt = new Date(Math.max(Date.parse(session.updatedAt), Date.parse(old.lastActivityAt) + 1)).toISOString();
        await atomic(path.join(sessionsRoot, uuid(id), 'session.json'), JSON.stringify(session, null, 2));
        return readSession(id);
      });
    },
    deleteSession(id) {
      return run(async () => {
        uuid(id);
        if (typeof trash !== 'function') throw failure('TRASH_UNAVAILABLE', '当前环境无法移入回收站，已保留解释会话。');
        const target = path.join(sessionsRoot, uuid(id));
        await ensureDirectory(target);
        let trashError;
        try { await trash(target); } catch (error) { trashError = error; }
        let remains;
        try { await fs.lstat(target); remains = true; }
        catch (error) {
          if (error.code !== 'ENOENT') throw failure('TRASH_UNCERTAIN', '无法确认回收站操作结果，请检查会话目录与系统回收站。');
          remains = false;
        }
        if (trashError && !remains) throw failure('TRASH_UNCERTAIN', '回收站接口报错，但会话目录已移走；请检查系统回收站，避免重复操作。');
        if (trashError || remains) throw failure('TRASH_FAILED', '无法将解释会话移入回收站，现有数据已保留。');
        return { id: uuid(id), deleted: true };
      });
    },
    getSettings({ includeSecrets = false } = {}) { return run(async () => publicSettings(await diskSettings(), includeSecrets)); },
    saveSettings(changes) {
      return run(async () => {
        object(changes, '设置');
        const settings = await diskSettings();
        await applyProfileChanges(settings, changes.serviceProfiles);
        for (const name of ['text', 'vision', 'translation', 'search']) settings[name] = { providerId: settings[name].providerId, ...structuredClone(settings.serviceProfiles[name][settings[name].providerId]) };
        await applyActiveConfigChanges(settings, changes);
        synchronizeActiveProfiles(settings);
        if (changes.prefs !== undefined) {
          const prefs = object(changes.prefs, '偏好设置');
          for (const key of ['showOrb', 'selectionEnabled']) if (prefs[key] !== undefined) settings.prefs[key] = bool(prefs[key], '偏好设置');
          if (prefs.orbAction !== undefined) settings.prefs.orbAction = orbAction(prefs.orbAction);
          if (prefs.autoExplainCapture !== undefined) settings.prefs.autoExplainCapture = bool(prefs.autoExplainCapture, '截图后自动解释状态');
          if (prefs.launchAtLogin !== undefined) settings.prefs.launchAtLogin = bool(prefs.launchAtLogin, '开机自启动状态');
          if (prefs.screenshotTranslation !== undefined) {
            const screenshotChanges = object(prefs.screenshotTranslation, '截图翻译设置');
            const mergedTranslationOptions = { ...settings.prefs.screenshotTranslation, ...screenshotChanges };
            // 旧客户端仅提供 deepSearchEnabled；迁移为总开关并保留它原有的深度范围含义。
            if (screenshotChanges.deepSearchEnabled !== undefined && screenshotChanges.searchEnabled === undefined && screenshotChanges.searchScope === undefined) {
              mergedTranslationOptions.searchEnabled = screenshotChanges.deepSearchEnabled;
              mergedTranslationOptions.searchScope = 'deep';
            }
            settings.prefs.screenshotTranslation = translationOptions(mergedTranslationOptions);
          }
          if (prefs.captureDefaultMode !== undefined) settings.prefs.captureDefaultMode = captureDefaultMode(prefs.captureDefaultMode);
          if (prefs.captureExplainMode !== undefined) settings.prefs.captureExplainMode = captureExplainMode(prefs.captureExplainMode);
          if (prefs.webSearchEnabled !== undefined) settings.prefs.webSearchEnabled = bool(prefs.webSearchEnabled, '默认联网搜索状态');
          if (prefs.appearance !== undefined) settings.prefs.appearance = appearanceShape(prefs.appearance);
          if (prefs.windowGeometry !== undefined) settings.prefs.windowGeometry = windowGeometryShape(prefs.windowGeometry);
          if (prefs.shortcuts !== undefined) settings.prefs.shortcuts = shortcutsShape(prefs.shortcuts);
          if (prefs.pinSound !== undefined) settings.prefs.pinSound = bool(prefs.pinSound, '置顶提示音状态');
        }
        await atomic(settingsPath, JSON.stringify(settingsShape(settings), null, 2));
        return publicSettings(settings, false);
      });
    },
  };
  return api;
}

module.exports = { createStore };
