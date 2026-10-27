'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { app, ipcMain, globalShortcut, session: electronSession, safeStorage, shell, dialog, net, clipboard, nativeImage } = require('electron');
const { createStore } = require('./core/store.cjs');
const { historyEntry, queryHistory } = require('./core/history.cjs');
const { buildMessages, streamCompletion, testProvider, resolveProvider } = require('./core/provider.cjs');
const { streamSearchedAnswer } = require('./core/request-flow.cjs');
const { searchWeb } = require('./core/search.cjs');
const { createSourceIcons, decodeSourceIcon } = require('./core/source-icons.cjs');
const { createSourceIconProxy } = require('./core/source-icon-proxy.cjs');
const { MODEL_PROVIDERS, SEARCH_PROVIDERS } = require('./core/services.cjs');
const { listModels } = require('./core/models.cjs');
const { uuid } = require('./core/validation.cjs');
const { applyLoginSetting } = require('./windows/startup.cjs');
const { translationOptions, translationUsesSearch, translateScreenshot, TRANSLATION_LANGUAGES } = require('./core/translation.cjs');
const { recognizeWindows } = require('./windows/ocr.cjs');
const { createDesktop } = require('./windows/desktop.cjs');
const { COMMANDS, createShortcutController } = require('./core/shortcuts.cjs');

const smoke = process.argv.includes('--smoke-test');
const verificationArgs = process.argv.filter(value => value.startsWith('--verification-data-dir='));
if (verificationArgs.length > 1) throw new Error('只能指定一个隔离验证目录。');
const verificationDirectory = verificationArgs.length ? path.resolve(verificationArgs[0].slice('--verification-data-dir='.length)) : '';
if (verificationDirectory) {
  const temporaryRoot = path.resolve(os.tmpdir()).toLowerCase();
  if (path.dirname(verificationDirectory).toLowerCase() !== temporaryRoot ||
      !path.basename(verificationDirectory).startsWith('pickgloss-verification-')) {
    throw new Error('隔离验证目录必须是系统临时目录下以 pickgloss-verification- 开头的独立目录。');
  }
  const marker = path.join(verificationDirectory, 'verification.marker');
  if (fsSync.existsSync(verificationDirectory)) {
    const info = fsSync.lstatSync(verificationDirectory);
    if (!info.isDirectory() || info.isSymbolicLink() ||
        !fsSync.existsSync(marker) || fsSync.lstatSync(marker).isSymbolicLink() ||
        fsSync.readFileSync(marker, 'utf8') !== 'PickGloss 隔离验证目录\n') {
      throw new Error('隔离验证目录缺少有效标记；现有文件不会被读取或覆盖。');
    }
  } else {
    fsSync.mkdirSync(verificationDirectory);
    fsSync.writeFileSync(marker, 'PickGloss 隔离验证目录\n', { flag: 'wx' });
  }
  app.setPath('userData', verificationDirectory);
} else if (smoke) app.setPath('userData', path.join(os.tmpdir(), 'pickgloss-smoke-' + process.pid));
else app.setPath('userData', path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'PickGloss'));
app.setName('PickGloss');
app.setAppUserModelId('local.pickgloss.desktop');
if (!app.requestSingleInstanceLock()) { app.quit(); } else {
  app.on('second-instance', (_event, commandLine = []) => { if (!commandLine.includes('--autostart')) desktop?.openPanel(); });
  app.whenReady().then(start).catch(() => {
    dialog.showErrorBox('PickGloss 启动失败', '无法读取本地数据或创建界面。原数据已保留，请检查数据目录的访问权限。'); app.exit(1);
  });
}

let store, desktop, settings, activeId = null, view = 'paste', settingsReturn = 'paste';
let searchPreferenceWrite = Promise.resolve();
let sourceIcons, sourceIconFetch;
let settingsSection = 'service';
let shortcuts, pinFeedback = null;
let orbActivationWork = Promise.resolve();
let pinned = false, wide = false, quitting = false, readyToExit = false, emitTimer, bridgeReady = 0;
let historyCache = [], historyDirty = true;
let historyRevision = 0, historyLoad = null, historyQuery = '', historySavedOnly = false, historyOpenId = 0;
const cache = new Map(), jobs = new Map();
let translation = null, translationJob = null, captureMode = 'explain';
const selectionSessions = new Map();
const status = { selection: '正在启动划词入口…', shortcutErrors: [], error: '' };
if (verificationDirectory) status.selection = '隔离验证模式：划词入口已暂停。';
const active = () => cache.get(activeId);
const modes = new Set(['context','independent','visual']);

function text(value, max, title, allowEmpty = true) {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim())) throw new Error(`${title}${!allowEmpty?'不能为空，且':''}最多 ${max} 个字符。`);
  return value;
}
function requireSession(id) { const value = cache.get(id); if (!value) throw new Error('此会话已关闭或删除，请重新打开。'); return value; }
function requireMode(value, mode) {
  if (!modes.has(mode) || (value.kind === 'image') !== (mode === 'visual')) throw new Error('解释模式无效。');
  return mode;
}
function requireVerificationLocalService(config) {
  if (!verificationDirectory || !config?.baseUrl) return;
  const host = new URL(config.baseUrl).hostname.toLowerCase();
  if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) throw new Error('隔离验证模式只允许连接本机模型服务。');
}
async function persist(value) {
  // 标题通过独立字段更新，后台流式保存不能用旧快照覆盖已经改好的标题。
  const { imageData, id, title, createdAt, updatedAt, lastActivityAt, ...changes } = value;
  const saved = await store.updateSession(id, structuredClone(changes));
  if (saved) {
    value.updatedAt = saved.updatedAt; value.lastActivityAt = saved.lastActivityAt;
    rememberHistory(saved);
  }
}
async function createSession(input) {
  // 会话创建等候联网偏好写入及对应的会话更新完成，避免读到切换前的默认值。
  await searchPreferenceWrite;
  return store.createSession(input);
}
async function deleteSession(id) {
  uuid(id);
  for (const [key, job] of jobs) if (key.startsWith(id + ':')) { job.abort.abort(); await job.promise; }
  try { await store.deleteSession(id); }
  catch (error) {
    invalidateHistory();
    try { if (!(await store.getSession(id))) { forgetSession(id); error.absent = true; } }
    catch (lookupError) { if (['NOT_FOUND', 'ENOENT'].includes(lookupError.code)) { forgetSession(id); error.absent = true; } }
    throw error;
  }
  forgetSession(id);
  invalidateHistory();
}
function forgetSession(id) {
  cache.delete(id);
  for (const [ticket, sessionId] of selectionSessions) if (sessionId === id) selectionSessions.delete(ticket);
  if (activeId === id) activeId = null;
}
function rememberHistory(value) {
  historyRevision++;
  const entry = historyEntry(value), index = historyCache.findIndex(item => item.id === value.id);
  if (index < 0) historyCache.push(entry); else historyCache[index] = entry;
}
function invalidateHistory() { historyRevision++; historyDirty = true; }
async function loadHistory() {
  while (historyDirty) {
    if (!historyLoad) {
      const revision = historyRevision;
      historyLoad = store.listSessions().then(entries => {
        if (revision === historyRevision) { historyCache = entries; historyDirty = false; }
      }).finally(() => { historyLoad = null; });
    }
    await historyLoad;
  }
}
async function state() {
  await loadHistory();
  return { view, session: active() || null, history: queryHistory(historyCache, { query: historyQuery, savedOnly: historySavedOnly }),
    historyQuery, historySavedOnly, historyOpenId, settings, settingsSection,
    serviceCatalog: { models: MODEL_PROVIDERS || [], search: SEARCH_PROVIDERS || [] },
    translation, translationLanguages: TRANSLATION_LANGUAGES, captureMode,
    settingsFilePath: path.join(app.getPath('userData'), 'data', 'settings.json'),
    pinned, wide, pinFeedback, status, capture: desktop.captureState() };
}
async function emit() {
  if (!desktop || !store || quitting) return;
  try { desktop.broadcast(await state()); } catch { status.error = '本地数据读取失败，原文件已保留。'; }
}
function currentTranslation(id) {
  if (!translation || translation.id !== id) throw new Error('此截图翻译已关闭或更新，请重新框选。');
  return translation;
}
function layoutTranslation(item, { resetPosition = false, activate = false } = {}) {
  const extraHeight = item.status === 'failed' ? 56 : item.status === 'complete' && (item.method === 'vision' || item.unchangedCount > 0) ? 20 : 0;
  item.layout = desktop.showTranslation(item.placement, item.options.displayMode, { resetPosition, extraHeight,
    contentHeight: item.options.displayMode === 'compare' ? item.contentHeight : undefined, activate });
}
function startScreenshotTranslation(imageData, placement, input, recognitionMode = 'auto') {
  if (!['auto', 'vision'].includes(recognitionMode)) throw new Error('截图识别模式无效。');
  // 查看原图是本次结果的临时状态；新的翻译必须先呈现译文。
  const options = translationOptions({ ...settings.prefs.screenshotTranslation, ...input, showOriginal: false });
  const resetPosition = translation?.placement !== placement;
  translationJob?.abort.abort();
  const item = translation = { id: randomUUID(), imageData, placement, options, status: 'recognizing', method: recognitionMode === 'vision' ? 'vision' : 'windows-ocr', fallbackReason: recognitionMode === 'vision' ? 'manual' : '', blocks: [], error: '', warning: '' };
  layoutTranslation(item, { resetPosition, activate: true });
  const job = { id: item.id, abort: new AbortController(), promise: null };
  translationJob = job;
  job.promise = (async () => {
    try {
      settings = await store.saveSettings({ prefs: { screenshotTranslation: options } });
      const configs = await store.getSettings({ includeSecrets: true });
      requireVerificationLocalService(configs.text); requireVerificationLocalService(configs.vision); requireVerificationLocalService(configs.translation);
      if (translationUsesSearch(options)) requireVerificationLocalService(configs.search);
      const result = await translateScreenshot({ imageData, options, configs, recognize: recognizeWindows, recognitionMode,
        fetchImpl: (...args) => net.fetch(...args), signal: job.abort.signal,
        onStage(stage, details) {
          if (translation !== item || job.abort.signal.aborted) return;
          item.status = stage;
          if (details) {
            for (const key of ['method', 'fallbackReason', 'thinking', 'search']) if (details[key] !== undefined) item[key] = details[key];
            layoutTranslation(item);
          }
          scheduleEmit();
        } });
      if (translation !== item || job.abort.signal.aborted) return;
      Object.assign(item, result, { status: 'complete' });
      if (!result.overlayAvailable) {
        item.options = { ...options, displayMode: 'compare' };
      }
      layoutTranslation(item);
    } catch (error) {
      if (translation !== item || job.abort.signal.aborted) return;
      item.status = 'failed'; item.error = error.message || '截图翻译未完成，请重试。';
      layoutTranslation(item);
    } finally {
      if (translationJob === job) translationJob = null;
      await emit();
    }
  })();
}
function scheduleEmit() { if (!emitTimer) emitTimer = setTimeout(() => { emitTimer = null; void emit(); }, 45); }

async function selectSession(id) {
  const loaded = cache.get(id) || await store.getSession(id);
  if (!loaded) throw new Error('此会话已经移入回收站。');
  cache.set(id, loaded); activeId = id; view = 'explain';
  if (loaded.contextPending && ![...selectionSessions.values()].includes(id)) {
    loaded.contextPending = false;
    loaded.contextReason = '上次上下文读取已经结束，可手动补充或使用独立释义。';
    await persist(loaded);
  }
  // 上次进程中断保留部分回答，不在重新打开时偷偷重发请求。
  for (const [mode, thread] of Object.entries(loaded.threads)) {
    if ((thread.status === 'streaming' || thread.messages.some(m=>m.status==='streaming')) && !jobs.has(id + ':' + mode)) {
      thread.status='stopped'; for(const m of thread.messages)if(m.status==='streaming')m.status='stopped';
    }
  }
}

async function startRequest(target, question = '', options = {}) {
  await searchPreferenceWrite;
  if(quitting)throw new Error('正在保存并退出，请稍后再试。');
  const s=requireSession(target.id), mode=requireMode(s,target.mode), key=s.id+':'+mode;
  if(jobs.has(key))throw new Error('当前模式正在生成，请先停止或等待完成。');
  const configs=await store.getSettings({includeSecrets:true});
  if(cache.get(s.id)!==s)throw new Error('此会话已删除。');
  if(jobs.has(key))throw new Error('当前模式正在生成，请先停止或等待完成。');
  if(quitting)throw new Error('正在保存并退出，请稍后再试。');
  const {config}=resolveProvider(configs,s.kind==='image'?'vision':'text');
  if(!config?.baseUrl||!config?.model) { settingsReturn=view;settingsSection='service';view='settings';throw new Error('请先配置对应的 AI 服务地址和模型。'); }
  requireVerificationLocalService(config);
  const thread=s.threads[mode];
  const previous = options.retryReply;
  let history = thread.messages.slice();
  if (previous) {
    if (history.at(-1) !== previous) throw new Error('请重试最新的失败回答，或重新提出问题。');
    history = history.slice(0, -1);
    if (question && history.at(-1)?.role === 'user' && history.at(-1).content === question) history.pop();
  }
  const snapshot = { ...s, threads: { ...s.threads, [mode]: { ...thread, messages: history } } };
  const messages=buildMessages(snapshot,mode,question);
  const useSearch = options.withoutSearch !== true && (options.forceSearch === true || s.webSearchEnabled === true);
  if (useSearch) requireVerificationLocalService(configs.search);
  if(question && !previous)thread.messages.push({id:randomUUID(),role:'user',content:question,status:'complete'});
  const reply=previous || {id:randomUUID(),role:'assistant'};
  Object.assign(reply, { content:'', status:'streaming', requestQuestion:question });
  delete reply.error;
  if (useSearch) reply.search = { status:'preparing', providerId:configs.search?.providerId || '', query:'', sources:[] };
  else delete reply.search;
  if (!previous) thread.messages.push(reply);
  if(question)thread.draft='';thread.status='streaming';thread.error='';
  const abort=new AbortController();
  const job={abort,promise:null};jobs.set(key,job);
  scheduleEmit();
  let lastSave=Date.now();
  job.promise=(async()=>{
    try {
      try {await persist(s);} catch {throw new Error('本地保存失败，本次请求尚未发送。');}
      const request = {config,messages,signal:abort.signal,fetchImpl:(...args)=>net.fetch(...args),onDelta:delta=>{
        if(abort.signal.aborted||cache.get(s.id)!==s)return;
        reply.content+=delta;scheduleEmit();
        if(Date.now()-lastSave>2000){lastSave=Date.now();void persist(s).catch(()=>{status.error='会话暂未写入磁盘，请检查本机剩余空间。';scheduleEmit();});}
      }};
      if (useSearch) await streamSearchedAnswer({ ...request, session:snapshot,mode,question,searchConfig:configs.search,
        onSearch: search => { if (!abort.signal.aborted && cache.get(s.id) === s) { reply.search = search; scheduleEmit(); } } });
      else await streamCompletion(request);
      reply.status=abort.signal.aborted?'stopped':'complete';thread.status=abort.signal.aborted?'stopped':'done';
    } catch(error) {
      if(abort.signal.aborted){reply.status='stopped';thread.status='stopped';if(question&&!reply.content&&!thread.draft)thread.draft=question;}
      else {
        reply.status='error';thread.status='error';thread.error=error.message||'请求失败，请检查服务配置后重试。';reply.error=thread.error;
        if (useSearch && reply.search?.status !== 'complete') {
          reply.search = { ...reply.search, status:'failed', error:thread.error };
          if (question && !thread.draft) thread.draft = question;
        }
      }
    } finally {
      jobs.delete(key);
      try {await persist(s);} catch {status.error='会话暂未写入磁盘，当前内容仍在内存中。';}
      scheduleEmit();
    }
  })();
}

async function handle(action,payload={}) {
  if(!payload || typeof payload!=='object' || Array.isArray(payload))throw new Error('操作参数无效。');
  if (shortcuts?.snapshot().recording && (action === 'close' || ['open-settings','open-appearance','open-history','open-session','open-latest-session','navigate','new-text','start-capture','selection-open'].includes(action))) {
    try { await shortcuts.setRecording(false); } catch (error) { status.error=error.message; }
  }
  let result=null;
  switch(action) {
    case 'orb-activate': {
      const work = orbActivationWork.then(async () => {
        if (settings.prefs.orbAction === 'capture') return handle('start-capture');
        if (desktop.isPanelVisible()) {
          if (!(await desktop.flushDrafts())) throw new Error('有更改尚未保存，请检查当前提示后重试。');
          desktop.hidePanel();desktop.closeMenu?.();await emit();return null;
        }
        return handle('open-latest-session');
      });
      // 连续点击依次执行开关，失败不阻塞后续点击；不并行唤回同一个原生窗口。
      orbActivationWork = work.catch(() => {});
      return work;
    }
    case 'bootstrap': return { ...await state(), pinFeedback: null, pinFeedbackBaseline: pinFeedback?.id || null };
    case 'get-source-icon': {
      if (verificationDirectory) return '';
      const s = requireSession(payload.id), mode = requireMode(s, payload.mode);
      const answer = s.threads[mode].messages.find(message => message.id === payload.messageId && message.role === 'assistant');
      const source = answer?.search?.sources?.find(item => item.id === payload.sourceId);
      sourceIcons ||= createSourceIcons({
        decodeImage: buffer => decodeSourceIcon(buffer, nativeImage),
        proxyFetch: (url, options) => {
          sourceIconFetch ||= createSourceIconProxy(electronSession.fromPartition('pickgloss-source-icons', { cache: false }));
          return sourceIconFetch(url, options);
        },
      });
      return source ? sourceIcons.get(source.url) : '';
    }
    case 'menu-ready': return desktop.menuReady(payload);
    case 'menu-close': return desktop.closeMenu(payload);
    case 'shortcut-recording': {
      if (Object.keys(payload).some(key => key !== 'active') || typeof payload.active !== 'boolean') throw new Error('快捷键录制参数无效。');
      if (payload.active && (view !== 'settings' || settingsSection !== 'shortcuts')) throw new Error('请先打开快捷键设置。');
      result=await shortcuts.setRecording(payload.active);break;
    }
    case 'shortcut-command': {
      if (Object.keys(payload).some(key => key !== 'command') || !COMMANDS.includes(payload.command)) throw new Error('快捷功能不存在。');
      const command = payload.command;
      const actions = { paste: ['navigate', { view: 'paste' }], capture: ['start-capture', {}],
        'toggle-pin': ['pin', { pinned: !pinned }], 'toggle-wide': ['wide', { wide: !wide }], history: ['open-history', {}],
        appearance: ['open-appearance', {}], 'toggle-orb': ['show-orb', { visible: settings.prefs.showOrb === false }],
        'toggle-selection': ['toggle-selection', {}], 'close-panel': ['close', {}] };
      if (command === 'stop') {
        const current = active();
        if (!current) { desktop.closeMenu?.(); return null; }
        return handle('stop', { id: current.id, mode: current.activeMode });
      }
      if (command === 'toggle-pin' || command === 'toggle-wide') desktop.openPanel(undefined, { preserveTransition: true });
      return handle(...actions[command]);
    }
    case 'new-text': {
      const selected=text(payload.text,12000,'选定文字',false).trim();
      const context=text(payload.context||'',6000,'上下文').trim();
      const s=await createSession({kind:'text',text:selected,context,contextOrigin:context?'手动补充的段落':'',source:{app:'手动粘贴',title:'',method:'用户输入'},activeMode:'context'});
      cache.set(s.id,s);activeId=s.id;view='explain';rememberHistory(s);result={id:s.id,mode:s.activeMode};break;
    }
    case 'set-context': {
      const s=requireSession(payload.id);if(s.kind!=='text')throw new Error('截图会话请使用截图说明。');
      if(s.threads.context.messages.length)throw new Error('这段上下文已用于解释；修改材料请新建会话。');
      s.context=text(payload.context,6000,'上下文',false).trim();s.contextOrigin='手动补充的段落';s.contextReason='';s.contextPending=false;s.activeMode='context';await persist(s);if(activeId===s.id)view='explain';break;
    }
    case 'set-note': {
      const s=requireSession(payload.id);if(s.kind!=='image')throw new Error('当前不是截图会话。');
      if(s.threads.visual.messages.length)throw new Error('截图说明已用于解释；更多要求可以继续追问。');
      s.note=text(payload.note||'',4000,'截图说明');await persist(s);break;
    }
    case 'set-mode': {
      const s=requireSession(payload.id);requireMode(s,payload.mode);
      s.activeMode=payload.mode;if(activeId===s.id)view='explain';await persist(s);break;
    }
    case 'set-draft': {const s=requireSession(payload.id),mode=requireMode(s,payload.mode);s.threads[mode].draft=text(payload.draft||'',4000,'追问');await persist(s);break;}
    case 'set-web-search': {
      if (typeof payload.enabled !== 'boolean') throw new Error('联网搜索状态无效。');
      const s = requireSession(payload.id);
      const update = searchPreferenceWrite.catch(() => {}).then(async () => {
        const previousSessionValue = s.webSearchEnabled;
        const previousDefaultValue = settings.prefs.webSearchEnabled;
        const savedSettings = await store.saveSettings({prefs:{webSearchEnabled:payload.enabled}});
        settings = savedSettings;
        s.webSearchEnabled = payload.enabled;
        try { await persist(s); }
        catch (error) {
          s.webSearchEnabled = previousSessionValue;
          try { settings = await store.saveSettings({prefs:{webSearchEnabled:previousDefaultValue}}); }
          catch { settings = savedSettings; throw new Error('会话状态保存失败，且无法恢复全局联网默认值。'); }
          throw error;
        }
      });
      searchPreferenceWrite = update.catch(() => {});
      await update;break;
    }
    case 'retry-search':
    case 'retry-without-search': {
      const s = requireSession(payload.id), mode = requireMode(s,payload.mode);
      const reply = s.threads[mode].messages.find(item => item.id === payload.messageId && item.role === 'assistant');
      if (!reply || reply.search?.status !== 'failed') throw new Error('这条回答没有可重试的联网请求。');
      await startRequest(payload,reply.requestQuestion || '',{retryReply:reply,forceSearch:action==='retry-search',withoutSearch:action==='retry-without-search'});break;
    }
    case 'start-explanation': if(activeId===payload.id)view='explain';await startRequest(payload);break;
    case 'send-question': {const q=text(payload.question,4000,'追问',false).trim();if(activeId===payload.id)view='explain';await startRequest(payload,q);break;}
    case 'stop': {const s=requireSession(payload.id);jobs.get(s.id+':'+requireMode(s,payload.mode))?.abort.abort();break;}
    case 'copy-answer': {
      if (verificationDirectory) throw new Error('隔离验证模式不会改动系统剪贴板。');
      const s = requireSession(payload.id), mode = requireMode(s, payload.mode);
      const message = s.threads[mode].messages.find(item => item.id === payload.messageId && item.role === 'assistant');
      if (!message?.content) throw new Error('这条回答还没有可复制的内容。');
      clipboard.writeText(message.content);
      return null;
    }
    case 'open-link': {
      if (verificationDirectory) throw new Error('隔离验证模式不会打开外部链接。');
      const url = new URL(text(payload.url, 8192, '链接地址', false));
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('只支持打开网页链接。');
      await shell.openExternal(url.href);
      return null;
    }
    case 'favorite': {
      const s=cache.get(payload.id)||await store.getSession(payload.id);if(!s)throw new Error('会话不存在。');
      s.saved=!!payload.saved;cache.set(s.id,s);await persist(s);break;
    }
    case 'rename-session': {
      const title = text(payload.title, 200, '会话标题', false).trim();
      const saved = await store.updateSession(payload.id, { title });
      const cached = cache.get(saved.id);
      if (cached) { cached.title = saved.title; cached.updatedAt = saved.updatedAt; cached.lastActivityAt = saved.lastActivityAt; }
      rememberHistory(saved); break;
    }
    case 'open-session': await selectSession(payload.id);desktop.openPanel();break;
    case 'open-latest-session': {
      if (!(await desktop.flushDrafts())) throw new Error('有更改尚未保存，请检查当前提示后重试。');
      await loadHistory();
      // 不沿用管理页的搜索与收藏筛选，也不创建空白会话或重新请求模型。
      const latest = queryHistory(historyCache)[0];
      if (latest) await selectSession(latest.id); else view = 'paste';
      desktop.openPanel(); break;
    }
    case 'open-history': historyOpenId++;invalidateHistory();view='history';await loadHistory();desktop.openPanel();break;
    case 'refresh-history': invalidateHistory();await loadHistory();break;
    case 'search-history':
      historyQuery=text(payload.query ?? '',1000,'搜索关键词');historySavedOnly=payload.savedOnly===true;break;
    case 'delete-session': {
      await deleteSession(payload.id);view='history';break;
    }
    case 'delete-sessions': {
      if (!Array.isArray(payload.ids) || !payload.ids.length || payload.ids.length > 500) throw new Error('请选择 1 至 500 个会话移入回收站。');
      // 先校验全部标识，避免非法请求在处理中途才失败。
      const ids = [...new Set(payload.ids.map(id => uuid(id)))], deletedIds = [], failed = [];
      for (const id of ids) {
        try { await deleteSession(id); deletedIds.push(id); }
        catch (error) {
          const uncertain = error.code === 'TRASH_UNCERTAIN' || error.absent === true;
          failed.push({ id, uncertain, absent: error.absent === true,
            error: uncertain ? '无法确认回收结果，请刷新历史并检查系统回收站，避免重复操作。' : ['TRASH_FAILED', 'TRASH_UNAVAILABLE'].includes(error.code) ? error.message : '此会话未能移入回收站，请刷新历史核对后再操作。' });
        }
      }
      view='history';await emit();return { deletedIds, failed };
    }
    case 'open-settings': if(view!=='settings')settingsReturn=view;settingsSection=payload.section==='general'?'general':'service';view='settings';desktop.openPanel();break;
    case 'open-appearance': if(view!=='settings')settingsReturn=view;settingsSection='appearance';view='settings';desktop.openPanel();break;
    case 'open-shortcuts': if(view!=='settings')settingsReturn=view;settingsSection='shortcuts';view='settings';desktop.openPanel();break;
    case 'save-settings': {
      if (payload.autosave !== undefined && typeof payload.autosave !== 'boolean') throw new Error('自动保存状态无效。');
      await searchPreferenceWrite;
      if (verificationDirectory) {
        for (const config of [payload.text, payload.vision, payload.translation, payload.search]) requireVerificationLocalService(config);
        for (const profiles of Object.values(payload.serviceProfiles || {})) for (const config of Object.values(profiles || {})) requireVerificationLocalService(config);
      }
      let previous;
      const persistSettings = async () => { previous=settings; settings=await store.saveSettings(payload); return settings; };
      if (shortcuts && payload.prefs?.shortcuts !== undefined) await shortcuts.apply(payload.prefs.shortcuts, persistSettings);
      else if (shortcuts) await shortcuts.save(persistSettings);
      else await persistSettings();
      if (previous.prefs.launchAtLogin !== settings.prefs.launchAtLogin) {
        try { applyLoginSetting({ app, isolated: !!verificationDirectory || smoke }, settings.prefs.launchAtLogin); }
        catch (error) {
          const rollback = Object.fromEntries(Object.keys(payload.prefs || {}).map(key => [key, previous.prefs[key]]));
          settings = await store.saveSettings({ prefs: rollback });
          throw error;
        }
      }
      if (previous.prefs.showOrb !== settings.prefs.showOrb) desktop.setOrb(!verificationDirectory && settings.prefs.showOrb!==false);
      if (previous.prefs.selectionEnabled !== settings.prefs.selectionEnabled) desktop.startSelection(!verificationDirectory && settings.prefs.selectionEnabled!==false);
      if (JSON.stringify(previous.prefs.appearance) !== JSON.stringify(settings.prefs.appearance)) desktop.setAppearance(settings.prefs.appearance);
      // 外观编辑会连续预览与保存，保存后留在当前页面以便继续调整。
      if (payload.autosave !== true && (payload.text !== undefined || payload.vision !== undefined || payload.translation !== undefined || payload.search !== undefined || (payload.prefs?.appearance === undefined && payload.prefs?.shortcuts === undefined && payload.prefs?.pinSound === undefined))) view=settingsReturn;
      result = settings;
      break;
    }
    case 'fetch-models': {
      if (!['text', 'vision', 'translation'].includes(payload.kind)) throw new Error('模型类型无效。');
      const input = payload.config || {}, configs = await store.getSettings({ includeSecrets: true });
      const providerId = input.providerId || configs[payload.kind]?.providerId;
      if (!MODEL_PROVIDERS.some(provider => provider.id === providerId)) throw new Error('模型服务无效。');
      const current = providerId === configs[payload.kind]?.providerId ? configs[payload.kind] : configs.serviceProfiles?.[payload.kind]?.[providerId] || {};
      const baseUrl = input.baseUrl ?? current.baseUrl;
      if (current.apiKey && !input.apiKey && !input.clearKey && new URL(baseUrl).origin !== new URL(current.baseUrl).origin) throw new Error('服务地址已变更，请重新输入密钥或明确清除已有密钥。');
      const config = { baseUrl, apiKey: input.clearKey ? '' : input.apiKey || current.apiKey || '' };
      requireVerificationLocalService(config);
      return listModels({ config, fetchImpl: (...args) => net.fetch(...args) });
    }
    case 'test-provider': {
      if(!['text','vision','translation'].includes(payload.kind))throw new Error('模型类型无效。');
      const configs=await store.getSettings({includeSecrets:true});
      const requested=payload.config||{};
      const {source}=resolveProvider({...configs,[payload.kind]:requested},payload.kind);
      const selectedId=(source!==payload.kind ? payload.fallbackConfig : requested)?.providerId;
      const current=selectedId && selectedId!==configs[source]?.providerId ? configs.serviceProfiles?.[source]?.[selectedId] || {} : configs[source];
      const input=source!==payload.kind ? payload.fallbackConfig||current : requested;
      if(current?.apiKey&&!input.apiKey&&!input.clearKey&&new URL(input.baseUrl).origin!==new URL(current.baseUrl).origin)throw new Error('服务地址已变更，请重新输入密钥或明确清除已有密钥。');
      const config={baseUrl:input.baseUrl,model:input.model,apiKey:input.clearKey?'':input.apiKey||current?.apiKey||''};
      requireVerificationLocalService(config);
      await testProvider({config,vision:payload.kind==='vision',translation:payload.kind==='translation',fetchImpl:(...args)=>net.fetch(...args)});
      return {message:source!==payload.kind?`已使用文字模型完成${payload.kind==='translation'?'翻译':'识图'}测试；实际效果仍需用具体内容体验。`:'测试请求成功；具体模型回答质量仍需用实际内容体验。'};
    }
    case 'test-search-provider': {
      const input=payload.config || {}, configs=await store.getSettings({includeSecrets:true});
      const providerId=input.providerId || configs.search?.providerId;
      const current=providerId && providerId!==configs.search?.providerId ? configs.serviceProfiles?.search?.[providerId] || {} : configs.search || {};
      const config={providerId,protocol:providerId==='custom'?(input.protocol ?? current.protocol ?? 'exa'):providerId,
        baseUrl:input.baseUrl ?? current.baseUrl,apiKey:input.clearKey?'':input.apiKey||current.apiKey||''};
      if(current.apiKey&&!input.apiKey&&!input.clearKey&&new URL(config.baseUrl).origin!==new URL(current.baseUrl).origin)throw new Error('搜索服务地址已变更，请重新输入密钥或明确清除已有密钥。');
      requireVerificationLocalService(config);
      const sources=await searchWeb({config,query:'PickGloss 搜索连接测试',fetchImpl:(...args)=>net.fetch(...args)});
      return {message:`搜索服务已响应，返回 ${sources.length} 条可用来源。`};
    }
    case 'start-capture':
      if(verificationDirectory)throw new Error('隔离验证模式不会读取实际屏幕。');
      if (payload.mode !== undefined && !['explain', 'translate'].includes(payload.mode)) throw new Error('截图模式无效。');
      // 等待此前语言选择落盘；重新框选也直接带入当前选框，避免沿用上次译文的语言。
      settings = payload.options === undefined ? await store.getSettings()
        : await store.saveSettings({ prefs: { screenshotTranslation: { ...payload.options, showOriginal: false } } });
      captureMode = payload.mode ?? settings.prefs.captureDefaultMode ?? 'explain';
      if (translationJob) { translationJob.abort.abort(); if (translation) translation.status='stopped'; }
      await desktop.beginCapture({ mode: captureMode });break;
    case 'capture-ready': return desktop.captureReady(payload);
    case 'capture-done': {
      if (payload.mode !== undefined && !['explain', 'translate'].includes(payload.mode)) throw new Error('截图模式无效。');
      if (payload.mode === 'translate') {
        const options = translationOptions(payload.options ?? settings.prefs.screenshotTranslation);
        const captured = desktop.finishCaptureWithPlacement(payload.rect);
        startScreenshotTranslation(captured.imageData, captured.placement, options);
        break;
      }
      const imageData=desktop.finishCapture(payload.rect);
      const s=await createSession({kind:'image',text:'截图讲解',imageData,note:'',source:{app:'屏幕框选',title:'',method:'用户框选'},activeMode:'visual'});
      cache.set(s.id,s);activeId=s.id;view='preview';rememberHistory(s);desktop.openPanel();
      if (settings.prefs.captureExplainMode === 'prompt') break;
      try { await startRequest({id:s.id,mode:'visual'});view='explain'; }
      catch (error) { view='preview';status.error=error.message || '截图已保留，请检查识图配置后重试。'; }
      break;
    }
    case 'capture-cancel': desktop.cancelCapture();break;
    case 'retry-translation': {
      const item = currentTranslation(payload.id);
      startScreenshotTranslation(item.imageData, item.placement, payload.options ?? item.options, payload.recognitionMode ?? 'auto');
      break;
    }
    case 'set-translation-preferences': {
      const options = payload.options;
      if (!options || typeof options !== 'object' || Array.isArray(options) ||
          Object.keys(options).some(key => !['sourceLanguage', 'targetLanguage', 'translationMode', 'searchEnabled', 'searchScope'].includes(key))) throw new Error('截图翻译设置无效。');
      settings = await store.saveSettings({ prefs: { screenshotTranslation: { ...options, showOriginal: false } } });
      break;
    }
    case 'set-translation-options': {
      const item = currentTranslation(payload.id), options = translationOptions({ ...item.options, ...payload.options });
      if (options.displayMode === 'compare') options.showOriginal = false;
      if (['sourceLanguage', 'targetLanguage', 'translationMode', 'searchEnabled', 'searchScope'].some(key => options[key] !== item.options[key])) throw new Error('修改翻译设置后请重新翻译。');
      // 显示切换不覆盖下拉框刚保存的语言，也不保存临时的原图状态。
      settings = await store.saveSettings({ prefs: { screenshotTranslation: { displayMode: options.displayMode, showOriginal: false } } });
      currentTranslation(payload.id);
      item.options = options; layoutTranslation(item, { activate: true });
      break;
    }
    case 'translation-content-height': {
      const item = translation && payload?.id === translation.id ? translation : null;
      if (!item) return null;
      const contentHeight = payload?.contentHeight;
      if (typeof contentHeight !== 'number' || !Number.isFinite(contentHeight) || contentHeight < 80 || contentHeight > 1_000_000) {
        throw new Error('截图翻译内容高度无效。');
      }
      if (item.options.displayMode !== 'compare') return null;
      item.contentHeight = contentHeight;
      const bounds = desktop.resizeTranslationHeight(item.placement, contentHeight);
      if (bounds) item.layout = { ...item.layout, controlBounds: bounds, controls: { ...item.layout.controls, width: bounds.width, height: bounds.height } };
      // 专用测量反馈只调整临时窗口，不重播状态，以免打断展开来源或滚动位置。
      return null;
    }
    case 'preview-translation-original': {
      const item = currentTranslation(payload.id);
      if (typeof payload.visible !== 'boolean') throw new Error('原图预览状态无效。');
      item.options = { ...item.options, showOriginal: item.options.displayMode === 'overlay' && payload.visible };
      break;
    }
    case 'copy-translation': {
      const item = currentTranslation(payload.id);
      if (item.status !== 'complete') throw new Error('翻译尚未完成。');
      clipboard.writeText(item.blocks.map(block => payload.includeOriginal ? `${block.text}\n${block.translation}` : block.translation).join('\n\n'));
      return null;
    }
    case 'close-translation':
      currentTranslation(payload.id);translationJob?.abort.abort();translation=null;desktop.hideTranslation();break;
    case 'selection-open': await desktop.acceptSelection();break;
    case 'navigate':
      if(!['paste','explain','preview','context','settings','history'].includes(payload.view))throw new Error('页面不存在。');
      if(payload.view==='history'){historyOpenId++;invalidateHistory();}view=payload.view;desktop.openPanel();break;
    case 'pin': {
      const next=!!payload.pinned;
      if(next!==pinned){pinned=next;desktop.setPinned(pinned);pinFeedback={id:randomUUID(),enabled:pinned};}
      break;
    }
    case 'wide': wide=!!payload.wide;desktop.setWide(wide);break;
    case 'orb-drag': return desktop.dragOrb(payload);
    case 'reset-window-size': wide=desktop.resetPanelSize();break;
    case 'show-orb': if(verificationDirectory)throw new Error('隔离验证模式不会显示悬浮球。');await store.saveSettings({prefs:{showOrb:!!payload.visible}});settings=await store.getSettings();desktop.setOrb(settings.prefs.showOrb);break;
    case 'toggle-selection': if(verificationDirectory)throw new Error('隔离验证模式不会开启划词入口。');await store.saveSettings({prefs:{selectionEnabled:settings.prefs.selectionEnabled===false}});settings=await store.getSettings();desktop.startSelection(settings.prefs.selectionEnabled!==false);break;
    case 'close': desktop.hidePanel();break;
    case 'menu': desktop.menu(payload);break;
    case 'quit': await quit();break;
    default: throw new Error('不支持此操作。');
  }
  if(action!=='menu')desktop.closeMenu?.();
  await emit();return result;
}

async function acceptCapturedSelection(data) {
  const s=await createSession({kind:'text',text:data.text,context:data.context || '',contextOrigin:data.contextOrigin || '',
    contextReason:data.reason || '',contextPending:data.contextPending === true,
    source:{app:data.app,title:data.title,method:data.method},activeMode:'context'});
  cache.set(s.id,s);activeId=s.id;view='explain';rememberHistory(s);
  if (s.contextPending && data.requestId) selectionSessions.set(data.requestId,s.id);
  if(s.context&&settings.text?.model&&settings.text?.baseUrl)await startRequest({id:s.id,mode:s.activeMode});
  scheduleEmit();
}

async function applySelectionContext(data) {
  const id=selectionSessions.get(data.requestId);
  if (!id) return;
  selectionSessions.delete(data.requestId);
  const s=cache.get(id);
  if (!s || !s.contextPending) return;
  s.contextPending=false;
  // 手动材料和已经用于语境解释的快照优先，迟到段落只属于它原先的会话。
  if (!s.context && !s.contextOrigin?.includes('手动') && !s.threads.context.messages.length) {
    s.context=text(data.context || '',6000,'上下文');
    s.contextOrigin=s.context ? text(data.contextOrigin || 'UIA 所在段落',1000,'上下文来源') : '';
    s.contextReason=s.context ? '' : text(data.reason || '当前应用未提供可靠的所在段落，可手动补充或使用独立释义。',1000,'上下文说明');
  }
  await persist(s);scheduleEmit();
}

async function start() {
  if(process.platform!=='win32')throw new Error('此版本仅面向 Windows。');
  electronSession.defaultSession.setPermissionRequestHandler((_webContents,_permission,callback)=>callback(false));
  electronSession.defaultSession.setPermissionCheckHandler(()=>false);
  store=createStore({directory:path.join(app.getPath('userData'),'data'),
    encrypt:value=>{if(!safeStorage.isEncryptionAvailable())throw new Error('Windows 密钥加密暂不可用。');return safeStorage.encryptString(value);},
    decrypt:value=>safeStorage.decryptString(value),trash:target=>shell.trashItem(target)});
  await store.init();settings=await store.getSettings();
  const safeAction=(action,payload)=>void handle(action,payload).catch(error=>{status.error=error.message;scheduleEmit();});
  desktop=createDesktop({onAction:safeAction,onStatus:patch=>{if(typeof patch.wide==='boolean')wide=patch.wide;Object.assign(status,patch);scheduleEmit();},onWindowState:async geometry=>{
    // 存储队列按最新磁盘设置合并，窗口移动不能覆盖随后保存的服务或外观设置。
    settings=await store.saveSettings({prefs:{windowGeometry:geometry}});
  },onSelection:acceptCapturedSelection,onSelectionContext:applySelectionContext});
  ipcMain.handle('pickgloss:action',async(event,action,payload)=>{
    if(!desktop.authorize(event,action))return{ok:false,error:'此窗口不能执行该操作。'};
    if(action==='bootstrap')bridgeReady++;
    try{
      let value=await handle(action,payload);
      if(action==='bootstrap'&&desktop.stateFor)value=await desktop.stateFor(event,value);
      return{ok:true,value};
    }catch(error){if(action!=='orb-drag')await emit();return{ok:false,error:error.message||'操作未完成，请重试。'};}
  });
  wide=desktop.restoreWindowState(settings.prefs.windowGeometry);
  desktop.setAppearance(settings.prefs.appearance);
  if(!verificationDirectory)desktop.initTray();
  if (!process.argv.includes('--autostart') || smoke || verificationDirectory) desktop.openPanel();
  desktop.setOrb(!verificationDirectory && settings.prefs.showOrb!==false);desktop.startSelection(!verificationDirectory && settings.prefs.selectionEnabled!==false);
  shortcuts=createShortcutController({globalShortcut,isolated:!!verificationDirectory,initial:settings.prefs.shortcuts,onCommand:command=>safeAction('shortcut-command',{command}),onStatus:value=>{
    status.shortcuts=value;status.shortcutErrors=value.error?[value.error]:[];scheduleEmit();
  }});
  try { await shortcuts.apply(settings.prefs.shortcuts); } catch {}
  if (!verificationDirectory && !smoke) desktop.prepareCapture();
  app.on('window-all-closed',()=>{});
  app.on('before-quit',event=>{if(!readyToExit){event.preventDefault();void quit();}});
  if(smoke){
    await new Promise(resolve=>setTimeout(resolve,1200));
    const info={...await desktop.smoke(),rendererBridge:bridgeReady>0,encryptionAvailable:safeStorage.isEncryptionAvailable(),shortcutErrors:status.shortcutErrors,selection:status.selection};
    // 宿主检查结果写在隔离用户目录，运行候选包不会改变包内容指纹。
    const target=path.join(app.getPath('userData'),'smoke.json');await fs.writeFile(target,JSON.stringify(info,null,2),'utf8');await quit();
  }
}

async function quit() {
  if(quitting)return;quitting=true;clearTimeout(emitTimer);emitTimer=null;
  let draftsSaved = true;
  try { if(desktop)draftsSaved = await desktop.flushDrafts(); }
  catch { draftsSaved = false; }
  if(!draftsSaved) {
    quitting=false;status.error='有更改尚未保存，已取消退出。请检查当前提示后重试。';desktop.openPanel();await emit();return;
  }
  let windowSaved = true;
  try { if(desktop)windowSaved = await desktop.flushWindowState(); }
  catch { windowSaved = false; }
  if(!windowSaved) {
    quitting=false;status.error='窗口位置或尺寸尚未保存，已取消退出。请检查磁盘空间或权限后重试。';desktop.openPanel();await emit();return;
  }
  for(const job of jobs.values())job.abort.abort();
  translationJob?.abort.abort();
  if (translationJob) await translationJob.promise;
  await Promise.allSettled([...jobs.values()].map(job=>job.promise));
  const saved=await Promise.allSettled([...cache.values()].map(persist));
  if(saved.some(result=>result.status==='rejected')) {
    quitting=false;status.error='部分会话未能写入磁盘，已取消退出。请检查磁盘空间或权限后重试。';desktop.openPanel();await emit();return;
  }
  await shortcuts?.dispose();desktop?.dispose();readyToExit=true;app.quit();
}
