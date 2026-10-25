import { brand } from './brand.js';
import { createAppearanceUI } from './appearance.js';
import { createShortcutsUI } from './shortcuts.js';
import { contextParts } from './context-highlight.mjs';

const root = document.getElementById('app');
const surface = new URLSearchParams(location.search).get('window') || 'panel';
const LIMITS = { text: 12000, context: 6000, question: 4000, note: 4000 };
const MODE_NAMES = { context: '语境解释', independent: '独立释义', visual: '截图讲解' };
const pending = new Set();
const errors = new Map();
const drafts = new Map();
const dirtyDrafts = new Map();
const draftVersions = new Map();
const questionSubmissions = new Map();
const notes = new Map();
const dirtyNotes = new Map();
const tests = new Map();
const serviceDrafts = { text: new Map(), vision: new Map(), search: new Map() };
const selectedProviders = { text: 'custom', vision: 'custom', search: 'exa' };
const webSearchOverrides = new Map();
const sourceIconCache = new Map();
const copyFeedback = new Map();
let state = null;
let renderedKey = '';
let lastContentView = 'paste';
let historySearch = '';
let historyFilter = 'all';
let historyVisible = 50;
let renameId = null;
let renameDraft = '';
let settingsTab = 'text';
let settingsSection = 'service';
let deleteId = null;
let composing = false;
let justFinishedComposition = false;
let compositionEndTimer = null;
let deferredRender = false;
let draftTimer = null;
let draftWork = Promise.resolve();
let unsubscribe = null;
let unsubscribeQuit = null;
let captureImage = '';
let crop = null;
let dragStart = null;
let captureDragging = false;
let dismissedStatusError = '';
let pressedAnswerControl = null;
let deferredAnswerUpdate = false;
let windowSizeFeedback = '';
let readingLayout = window.innerWidth >= 640;
let readingAnchor = null;
let transitionAnchor = null;
let restoringAnchor = false;
const tabPositions = new Map();
const contentTransitions = new Map();
let layoutViewport = '';
let menuGeneration = null, menuWasOpen = false, menuAnimation = null, menuSignature = '', menuBusy = false;
let menuMeasureKey = '';
let pinAudio, captureReady = false, captureId = null, captureLoadToken = 0;
const seenPinFeedback = new Set();
let layoutToken = null, layoutReveal = null;
window.pickgloss.onLayout?.((message, ready) => {
  if (surface !== 'panel') return;
  if (message.phase === 'prepare') {
    transitionAnchor ||= captureReadingAnchor();
    layoutToken = message.id;
    layoutReveal?.cancel(); layoutReveal = null;
    document.documentElement.classList.add('layout-preparing');
    requestAnimationFrame(() => requestAnimationFrame(() => { if (layoutToken === message.id) ready(); }));
  } else if (message.phase === 'commit' && layoutToken === message.id) {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (layoutToken !== message.id) return;
      syncWindowLayout();
      restoreReadingAnchor(transitionAnchor || readingAnchor);
      document.documentElement.classList.remove('layout-preparing');
      if (!document.documentElement.classList.contains('reduced-motion')) {
        const body = root.querySelector('.panel-body');
        if (body) layoutReveal = body.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 140, easing: 'ease-out' });
      }
      layoutToken = null;
    }));
  } else if (message.phase === 'cancel' && layoutToken === message.id) {
    layoutToken = null;
    document.documentElement.classList.remove('layout-preparing');
  }
});

// 两档排版保持字号；窗口拉伸只改变换行与可见面积。
function syncWindowLayout() {
  if (surface !== 'panel') return;
  const viewport = `${window.innerWidth}:${window.innerHeight}`;
  const resized = viewport !== layoutViewport;
  const reading = window.innerWidth >= 640;
  root.style.zoom = '1';
  root.style.width = '100%';
  root.style.height = '100%';
  root.querySelector('.panel')?.classList.toggle('reading-layout', reading);
  const toggle = root.querySelector('.layout-toggle');
  if (toggle) {
    const targetReading = typeof state?.wide === 'boolean' ? state.wide : reading;
    const label = targetReading ? '返回小窗' : '阅读视图';
    if (toggle.title !== label) {
      toggle.title = label;
      toggle.setAttribute('aria-label', label);
      toggle.replaceChildren(icon(targetReading ? 'narrow' : 'wide'));
    }
  }
  const body = root.querySelector('.explain-body');
  const answer = root.querySelector('.answer-pane');
  if (body && answer) {
    const oldScroller = root.querySelector('[data-scroll="body"]');
    const nextScroller = reading ? answer : body;
    if (oldScroller !== nextScroller) {
      oldScroller?.removeAttribute('data-scroll');
      nextScroller.dataset.scroll = 'body';
    }
  }
  readingLayout = reading;
  root.querySelector('.panel')?.classList.toggle('is-pinned', Boolean(state?.pinned));
  const panel = root.querySelector('.panel');
  if (panel && state?.status?.nativeRoundedFrame) {
    panel.style.setProperty('--actual-panel-border', getComputedStyle(panel).borderLeftWidth);
  }
  layoutViewport = viewport;
  syncModeIndicator();
  // 状态推送不等于尺寸变化；否则延迟的动画终态会覆盖刚发生的滚动。
  if (resized) restoreReadingAnchor(transitionAnchor || readingAnchor);
}

function captureReadingAnchor() {
  const scroller = root.querySelector('[data-scroll="body"]');
  if (!scroller || state?.view !== 'explain') return null;
  const edge = scroller.getBoundingClientRect().top;
  const blocks = [...root.querySelectorAll('.message-content > *')];
  const block = blocks.find(node => node.getBoundingClientRect().bottom > edge + 12);
  if (!block) return null;
  return { key: draftKey(), message: block.closest('[data-message]')?.dataset.message,
    index: [...block.parentElement.children].indexOf(block), offset: block.getBoundingClientRect().top - edge,
    bottom: scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop < 18 };
}

function restoreReadingAnchor(anchor) {
  if (!anchor || anchor.key !== draftKey()) return;
  const scroller = root.querySelector('[data-scroll="body"]');
  const message = [...root.querySelectorAll('[data-message]')].find(node => node.dataset.message === anchor.message);
  const block = message?.querySelector('.message-content')?.children[anchor.index];
  if (!scroller || !block) return;
  restoringAnchor = true;
  if (anchor.bottom) scroller.scrollTop = scroller.scrollHeight;
  else scroller.scrollTop += block.getBoundingClientRect().top - scroller.getBoundingClientRect().top - anchor.offset;
  requestAnimationFrame(() => { restoringAnchor = false; });
}

// 状态回推会重建节点，保留动画起点和时间，避免横条被重绘打断。
function syncTabIndicator(tabs, key, value) {
  const selected = tabs?.querySelector('[role="tab"][aria-selected="true"]');
  if (!selected) return;
  let indicator = tabs.querySelector('.mode-indicator');
  if (!indicator) { indicator = el('span', { class: 'mode-indicator', 'aria-hidden': 'true' }); tabs.append(indicator); }
  const now = Date.now(), previous = tabPositions.get(key);
  const next = { value, left: selected.offsetLeft, width: selected.offsetWidth, viewport: window.innerWidth };
  let transition = previous?.transition;
  if (previous && previous.viewport === next.viewport && previous.value !== value) {
    const progress = previous.animation?.effect?.getComputedTiming().progress ?? 1;
    const from = previous.transition ? {
      left: previous.transition.from.left + (previous.left - previous.transition.from.left) * progress,
      width: previous.transition.from.width + (previous.width - previous.transition.from.width) * progress,
    } : previous;
    transition = { from: { left: from.left, width: from.width }, start: now };
  } else if (previous?.viewport !== next.viewport || previous?.left !== next.left || previous?.width !== next.width) transition = null;
  indicator.style.left = `${next.left}px`; indicator.style.width = `${next.width}px`;
  for (const animation of indicator.getAnimations()) animation.cancel();
  if (transition && now - transition.start < 200 && !document.documentElement.classList.contains('reduced-motion')) {
    next.animation = indicator.animate([{ left: `${transition.from.left}px`, width: `${transition.from.width}px` },
      { left: `${next.left}px`, width: `${next.width}px` }], { duration: 200, easing: 'cubic-bezier(.2,.8,.2,1)' });
    next.animation.currentTime = now - transition.start;
    next.transition = transition;
  }
  tabPositions.set(key, next);
}

function revealTabContent(node, key, value, order) {
  if (!node) return;
  const previous = contentTransitions.get(key), now = Date.now();
  let transition = previous?.transition;
  if (previous && previous.value !== value) transition = { start: now, direction: order.indexOf(value) >= order.indexOf(previous.value) ? 1 : -1 };
  for (const animation of node.getAnimations()) animation.cancel();
  if (transition && now - transition.start < 180 && !document.documentElement.classList.contains('reduced-motion')) {
    const animation = node.animate([{ opacity: 0, transform: `translateX(${transition.direction * 10}px)` }, { opacity: 1, transform: 'translateX(0)' }],
      { duration: 180, easing: 'cubic-bezier(.2,.8,.2,1)' });
    animation.currentTime = now - transition.start;
  } else transition = null;
  contentTransitions.set(key, { value, transition });
}

function syncModeIndicator() {
  syncTabIndicator(root.querySelector('.mode-tabs[aria-label="解释模式"]'), `mode:${session()?.id}`, mode());
  syncTabIndicator(root.querySelector('.settings-navigation'), 'settings', settingsSection);
  syncTabIndicator(root.querySelector('.mode-tabs[aria-label="服务类型"]'), 'services', settingsTab);
}

function syncContentTransitions() {
  if (state?.view === 'settings') {
    revealTabContent(root.querySelector(`[data-settings-section="${settingsSection}"]`), 'settings', settingsSection, ['general', 'service', 'appearance', 'shortcuts']);
    if (settingsSection === 'service') revealTabContent(root.querySelector(`[data-provider="${settingsTab}"]`), 'services', settingsTab, ['text', 'vision', 'search']);
  } else if (state?.view === 'explain') revealTabContent(root.querySelector('.mode-content'), `mode:${session()?.id}`, mode(), ['context', 'independent']);
}

function stopTabMotion() {
  for (const position of tabPositions.values()) {
    position.animation?.cancel();
    position.animation = null; position.transition = null;
  }
  for (const transition of contentTransitions.values()) transition.transition = null;
  for (const node of root.querySelectorAll('.mode-content, [data-settings-section], [data-provider]')) {
    for (const animation of node.getAnimations()) animation.cancel();
  }
}

document.addEventListener('scroll', event => {
  if (!restoringAnchor && !state?.status?.windowTransitioning && event.target?.dataset?.scroll === 'body') readingAnchor = captureReadingAnchor();
}, true);
let layoutFrame;
window.addEventListener('resize', () => {
  cancelAnimationFrame(layoutFrame);
  // 排版在本次尺寸事件内提交，不晚一帧显示旧的单栏或双栏。
  syncWindowLayout();
  layoutFrame = requestAnimationFrame(() => {
    if (!state?.status?.windowTransitioning) for (const input of root.querySelectorAll('[data-field="question"]')) updateField(input);
  });
});

function statusErrorKey() { return `${state?.status?.errorId || ''}:${state?.status?.error || ''}`; }

// 仅创建本地 DOM；选定内容和错误按纯文本显示，回答交给允许标签的 Markdown 显示层。
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || (value === false && !key.startsWith('aria-'))) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (key === 'checked' || key === 'disabled' || key === 'hidden' || key === 'open') node[key] = value;
    else if (key === 'value') node.value = value;
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const iconPaths = {
  close: ['M5 5l14 14M19 5L5 19'],
  pin: ['M9 3h6l-1 6 4 4v2H6v-2l4-4-1-6M12 15v6'],
  wide: ['M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5'],
  narrow: ['M3 8h5V3M21 8h-5V3M8 21v-5H3M16 21v-5h5'],
  history: ['M4 11a8 8 0 1 1 2 6M4 4v7h7M12 7v5l3 2'],
  star: ['m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L2 9.6l6.2-.9L12 3Z'],
  shirt: ['M8 3 2 6l3 5 2-1v11h10V10l2 1 3-5-6-3M8 3a4 4 0 0 0 8 0'],
  settings: ['M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1 1-3Z'],
  crop: ['M8 3v13h13M3 8h13v13'],
  send: ['M12 20V4M5 11l7-7 7 7'],
  stop: ['M6 6h12v12H6Z'],
  text: ['M5 4h14M12 4v16M8 20h8'],
  back: ['M14 5l-7 7 7 7M7 12h14'],
  menu: ['M5 6h14M5 12h14M5 18h14'],
  trash: ['M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7'],
  retry: ['M20 10a8 8 0 1 0-1.8 7.5M20 4v6h-6'],
  chevron: ['m9 5 7 7-7 7'],
  copy: ['M9 9h12v12H9ZM15 9V3H3v12h6'],
  keyboard: ['M3 6h18v13H3ZM6 9h1m3 0h1m3 0h1m3 0h1M6 12h1m3 0h1m3 0h1m3 0h1M8 16h8'],
  pause: ['M8 4v16M16 4v16'],
  orb: ['M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M12 7v10M7 12h10'],
  search: ['M16 10a6 6 0 1 1-12 0 6 6 0 0 1 12 0M15 15l6 6'],
  globe: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z', 'M2 12h20', 'M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10Z'],
  edit: ['m15 4 5 5M4 20l4-1L21 6l-4-4L4 15v5Z'],
};

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of iconPaths[name] || iconPaths.text) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

function nativePinFrame() {
  const node = (tag, attributes = {}) => {
    const value = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, attribute] of Object.entries(attributes)) value.setAttribute(key, attribute);
    return value;
  };
  const svg = node('svg', { class: 'native-pin-frame', 'aria-hidden': 'true', focusable: 'false' });
  const definitions = node('defs');
  const mask = node('mask', { id: 'native-pin-hole', maskUnits: 'userSpaceOnUse', x: '0', y: '0', width: '100%', height: '100%' });
  mask.append(node('rect', { width: '100%', height: '100%', fill: 'white' }), node('rect', { class: 'native-pin-cutout', fill: 'black' }));
  definitions.append(mask);
  svg.append(definitions, node('rect', { width: '100%', height: '100%', fill: 'currentColor', mask: 'url(#native-pin-hole)' }));
  return svg;
}

function button(label, action, options = {}) {
  return el('button', {
    type: options.type || 'button',
    class: options.class || 'small-button',
    title: options.title || label,
    'aria-label': options.iconOnly ? label : undefined,
    'aria-pressed': options.pressed,
    'aria-selected': options.selected,
    role: options.role,
    disabled: options.disabled || (options.busy && pending.has(options.busy)),
    onclick: action,
  }, options.icon ? icon(options.icon) : null, options.iconOnly ? null : label);
}

const appearanceUI = createAppearanceUI({
  save: appearance => call('save-settings', { prefs: { appearance } }, { scope: 'appearance', render: false }),
  refresh: () => render(),
  onReducedMotion: () => {
    stopTabMotion();
    if (!state?.status?.windowTransitioning) { transitionAnchor = null; readingAnchor = captureReadingAnchor(); }
  },
});
const shortcutsUI = createShortcutsUI({
  invoke: (action, payload) => call(action, payload, { lock: false, render: false }),
  save: prefs => call('save-settings', { prefs }, { scope: 'shortcuts', render: false }),
});

function playPinFeedback(previous, next) {
  if (surface !== 'panel') return;
  if (next.pinFeedbackBaseline) seenPinFeedback.add(next.pinFeedbackBaseline);
  const event = next.pinFeedback;
  if (!event?.id) return;
  const seen = seenPinFeedback.has(event.id); seenPinFeedback.add(event.id);
  if (seenPinFeedback.size > 64) seenPinFeedback.delete(seenPinFeedback.values().next().value);
  if (!previous || seen || !event.enabled || next.settings?.prefs?.pinSound === false) return;
  try {
    pinAudio ||= new Audio('assets/pin-on.wav');
    pinAudio.volume = .85; pinAudio.currentTime = 0;
    void pinAudio.play().catch(() => {});
  } catch { /* 声音不可用时，置顶边框仍立即提供反馈。 */ }
}

function session() { return state?.session; }
function mode() { return session()?.activeMode || (session()?.kind === 'image' ? 'visual' : 'context'); }
function thread() { return session()?.threads?.[mode()] || { messages: [], draft: '' }; }
function draftKey() { return `${session()?.id || ''}:${mode()}`; }
function target() { return { id: session()?.id, mode: mode() }; }
function draftValue() { return drafts.has(draftKey()) ? drafts.get(draftKey()) : thread().draft || ''; }
function trackQuestionSubmission(selected, question, version) {
  const key = `${selected.id}:${selected.mode}`;
  const submission = { id: selected.id, mode: selected.mode, question, version, recovered: false };
  const pendingForThread = questionSubmissions.get(key) || [];
  pendingForThread.push(submission);
  questionSubmissions.set(key, pendingForThread);
  return submission;
}

function forgetQuestionSubmission(submission) {
  const key = `${submission.id}:${submission.mode}`;
  const pendingForThread = questionSubmissions.get(key) || [];
  const remaining = pendingForThread.filter(item => item !== submission);
  if (remaining.length) questionSubmissions.set(key, remaining);
  else questionSubmissions.delete(key);
}

function reconcileQuestionDrafts(next) {
  const active = next.session;
  if (!active?.id) return;
  for (const mode of ['context', 'independent', 'visual']) {
    const key = `${active.id}:${mode}`;
    const pendingForThread = questionSubmissions.get(key);
    if (!pendingForThread?.length) continue;
    const messages = active.threads?.[mode]?.messages || [];
    const remaining = [];
    for (const submission of pendingForThread) {
      const reply = [...messages].reverse().find(message => message.role === 'assistant' && message.requestQuestion === submission.question);
      if (!reply || ['streaming', 'loading', 'pending', 'generating', 'running'].includes(reply.status)) {
        remaining.push(submission);
        continue;
      }
      const failedBeforeOutput = ['error', 'stopped'].includes(reply.status) && !String(reply.content || '').trim();
      const currentVersion = draftVersions.get(key) || 0;
      // 只有发送后没有触发过输入事件才恢复；主动清空同样会递增版本。
      if (failedBeforeOutput && currentVersion === submission.version) {
        drafts.set(key, submission.question);
        submission.recovered = true;
      }
    }
    if (remaining.length) questionSubmissions.set(key, remaining);
    else questionSubmissions.delete(key);
  }
}

function webSearchEnabled(active = session()) {
  if (!active) return false;
  return webSearchOverrides.has(active.id) ? webSearchOverrides.get(active.id) : active.webSearchEnabled === true;
}
function isStreaming() {
  const current = thread();
  const status = current.status || [...(current.messages || [])].reverse().find(message => message.role === 'assistant')?.status;
  return ['streaming', 'loading', 'pending', 'generating', 'running'].includes(status);
}
function effectiveProvider(kind, settings=state?.settings) { return settings?.[kind === 'vision' && !settings?.vision?.model?.trim() ? 'text' : kind]; }
function hasProvider(kind) { const config = effectiveProvider(kind); return Boolean(config?.baseUrl?.trim() && config?.model?.trim()); }
function safeImage(data) { return typeof data === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=\r\n]+$/.test(data) ? data : ''; }
function errorNode(scope) { return el('p', { class: 'inline-error', role: 'alert' }, errors.get(scope) || ''); }
function setError(scope, message) { errors.set(scope, String(message)); render(); }

async function call(action, payload = {}, options = {}) {
  if (!window.pickgloss?.invoke) {
    setError(options.scope || 'global', '未连接桌面服务，请重新打开PickGloss。');
    return { ok: false, error: '未连接桌面服务' };
  }
  const lock = options.lock === false ? null : action;
  if (lock && pending.has(lock)) return { ok: false, duplicate: true };
  if (lock) pending.add(lock);
  errors.delete(options.scope || 'global');
  if (options.render !== false) render();
  try {
    const result = await window.pickgloss.invoke(action, payload);
    if (!result || result.ok !== true) {
      const error = result?.error || '操作未完成，请重试。';
      errors.set(options.scope || 'global', String(error));
      return { ok: false, error };
    }
    return result;
  } catch (error) {
    const message = error?.message || '桌面服务暂时没有响应，请重试。';
    errors.set(options.scope || 'global', message);
    return { ok: false, error: message };
  } finally {
    if (lock) pending.delete(lock);
    if (options.render !== false) render();
  }
}

function receive(next) {
  if (!next || typeof next !== 'object') return;
  const previous = state;
  if (next.status?.windowTransitioning && !previous?.status?.windowTransitioning && !transitionAnchor) transitionAnchor = captureReadingAnchor();
  state = next;
  reconcileQuestionDrafts(next);
  if (next.session && webSearchOverrides.has(next.session.id) && webSearchOverrides.get(next.session.id) === (next.session.webSearchEnabled === true)) {
    webSearchOverrides.delete(next.session.id);
  }
  document.documentElement.classList.toggle('native-rounded-frame', next.status?.nativeRoundedFrame === true);
  document.documentElement.classList.toggle('panel-surface', surface === 'panel');
  playPinFeedback(previous, next);
  appearanceUI.receive(next.settings?.prefs?.appearance, next.status || {});
  shortcutsUI.receive(next.settings?.prefs, next.status || {});
  if (!previous) { historySearch = next.historyQuery || ''; historyFilter = next.historySavedOnly ? 'saved' : 'all'; }
  if (state.view === 'history' && previous?.view !== 'history') historyVisible = 50;
  if (['paste', 'explain', 'preview', 'context'].includes(state.view)) lastContentView = state.view;
  if (state.view === 'settings' && (previous?.view !== 'settings' || previous?.settingsSection !== next.settingsSection)) settingsSection = next.settingsSection || 'service';
  if (previous?.session?.id !== next.session?.id || previous?.session?.activeMode !== next.session?.activeMode) readingAnchor = null;
  const contentState = value => {
    const { wide: _wide, status: nativeStatus, ...content } = value;
    const { wide, windowTransitioning, appearanceDark, appearanceMaterial, reducedMotion, ...visibleStatus } = nativeStatus || {};
    if (content.view === 'settings') { content.session = { kind: value.session?.kind }; content.history = null; }
    return JSON.stringify({ ...content, status: visibleStatus });
  };
  if (surface === 'panel' && previous && contentState(previous) === contentState(next)) {
    syncWindowLayout();
    if (!next.status?.windowTransitioning) {
      for (const input of root.querySelectorAll('[data-field="question"]')) updateField(input);
      transitionAnchor = null; readingAnchor = captureReadingAnchor();
    }
    return;
  }
  if (updateStreamingText(previous, next)) return;
  render();
  if (!next.status?.windowTransitioning) transitionAnchor = null;
}

// 流式片段不能替换正在被按下的按钮，否则 mouseup 无法形成一次 click。
// 只有正在生成的回答文字变化时原位更新；会话、模式、状态或其他字段变化仍完整绘制。
function updateStreamingText(previous, next) {
  if (surface !== 'panel' || composing || previous?.view !== 'explain' || next.view !== 'explain') return false;
  const currentMode = mode();
  if (renderedKey !== `explain:${next.session?.id || ''}:${currentMode}`) return false;
  function structure(value) {
    const active = value.session;
    const current = active?.threads?.[currentMode];
    if (!active || active.id !== next.session?.id || active.activeMode !== next.session?.activeMode || current?.status !== 'streaming') return null;
    // 历史列表和会话落盘时间不影响当前解释面板，也不应打断点击。
    return JSON.stringify({ ...value, history: null, session: { ...active, updatedAt: null, threads: { ...active.threads, [currentMode]: {
      ...current, messages: current.messages.map(message => message.role === 'assistant' && message.status === 'streaming' ? { ...message, content: null } : message),
    } } } });
  }
  const before = structure(previous);
  if (before === null || before !== structure(next)) return false;
  // 按住控件时先保留布局，松开并完成 click 后补绘，避免新增段落把控件推走。
  if (pressedAnswerControl?.isConnected) { deferredAnswerUpdate = true; return true; }
  const messages = thread().messages;
  const nodes = [...root.querySelectorAll('.conversation .message')];
  if (nodes.length !== messages.length || nodes.some((node, index) => node.dataset.message !== messages[index].id)) return false;
  const body = root.querySelector('[data-scroll="body"]');
  const atBottom = body && body.scrollHeight - body.clientHeight - body.scrollTop < 36;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    const content = message.content || '';
    const text = nodes[index].querySelector('.message-content');
    if (message.role === 'assistant' && message.content) renderAnswer(text, message.content);
    else if (text.textContent !== content) text.textContent = content;
    if (message.content) nodes[index].querySelector('.stream-status')?.remove();
    const copy = nodes[index].querySelector('[data-copy-answer]');
    if (copy) { copy.dataset.copyReady = String(Boolean(message.content)); syncCopyButton(copy); }
  }
  if (atBottom) body.scrollTop = body.scrollHeight;
  return true;
}

// 推送可能在流式回答中频繁到达；保留用户表单、选区和滚动位置。
function snapshot() {
  const fields = new Map();
  for (const node of root.querySelectorAll('[data-field]')) fields.set(node.dataset.field, {
    value: node.value,
    checked: node.checked,
    scrollTop: node.scrollTop,
  });
  const focused = document.activeElement;
  const focus = focused?.dataset.field ? {
    field: focused.dataset.field,
    start: focused.selectionStart,
    end: focused.selectionEnd,
    direction: focused.selectionDirection,
  } : null;
  const scroll = new Map([...root.querySelectorAll('[data-scroll]')].map(node => [node.dataset.scroll, {
    top: node.scrollTop,
    bottom: node.scrollHeight - node.clientHeight - node.scrollTop < 36,
  }]));
  const details = new Map([...root.querySelectorAll('details[data-detail]')].map(node => [node.dataset.detail, node.open]));
  return { fields, focus, scroll, details };
}

function restore(saved) {
  for (const node of root.querySelectorAll('[data-field]')) {
    const value = saved.fields.get(node.dataset.field);
    if (!value) continue;
    // 失败回推后的本地草稿优先于重绘前快照里的旧输入值。
    node.value = node.dataset.field === 'question' && drafts.has(draftKey()) ? drafts.get(draftKey()) : value.value;
    if (node.type === 'checkbox') node.checked = value.checked;
    node.scrollTop = value.scrollTop;
    updateField(node);
  }
  for (const node of root.querySelectorAll('details[data-detail]')) {
    if (saved.details.has(node.dataset.detail)) node.open = saved.details.get(node.dataset.detail);
  }
  if (saved.focus) {
    const target = [...root.querySelectorAll('[data-field]')].find(node => node.dataset.field === saved.focus.field);
    if (target && !target.disabled) {
      target.focus({ preventScroll: true });
      if (typeof saved.focus.start === 'number' && target.type !== 'checkbox') {
        try { target.setSelectionRange(saved.focus.start, saved.focus.end, saved.focus.direction); } catch { /* 非文本输入没有光标范围。 */ }
      }
    }
  }
  for (const node of root.querySelectorAll('[data-scroll]')) {
    const previous = saved.scroll.get(node.dataset.scroll);
    if (previous) node.scrollTop = previous.bottom && state.view === 'explain' ? node.scrollHeight : previous.top;
  }
}

function render() {
  if (composing) { deferredRender = true; return; }
  if (!state) return;
  root.setAttribute('aria-busy', 'false');
  if (surface === 'orb') { renderOrb(); return; }
  if (surface === 'menu') { renderMenu(); return; }
  if (surface === 'selection') { renderSelection(); return; }
  if (surface === 'capture') { renderCapture(); return; }
  const view = ['paste', 'explain', 'preview', 'context', 'settings', 'history'].includes(state.view) ? state.view : 'paste';
  const key = ['explain', 'preview', 'context'].includes(view) ? `${view}:${session()?.id || ''}:${view === 'explain' ? mode() : ''}` : view;
  const saved = key === renderedKey ? snapshot() : null;
  // 同一布局重绘优先读取当前 DOM，滚动事件可能还在派发队列中。
  const anchor = saved && layoutViewport === `${window.innerWidth}:${window.innerHeight}`
    ? captureReadingAnchor() : transitionAnchor || readingAnchor;
  const panel = el('main', { class: `panel${view === 'explain' && session() ? ' explain-panel' : ''}${renderedKey ? '' : ' is-entering'}` }, header(view));
  const body = el('section', { class: `panel-body${view === 'settings' ? ' settings-body' : ''}${view === 'paste' ? ' recognition-body' : view === 'preview' ? ' recognition-preview' : ''}`, 'data-scroll': 'body', 'aria-label': view === 'explain' ? '解释会话' : 'PickGloss内容' });
  if (view === 'paste') pasteView(body);
  if (view === 'explain') explainView(body);
  if (view === 'preview') previewView(body);
  if (view === 'context') contextView(body);
  if (view === 'settings') settingsView(body);
  if (view === 'history') historyView(body);
  panel.append(body);
  if (view === 'explain' && session()) panel.append(composer());
  panel.append(footer(view));
  const globalError = errors.get('global') || (statusErrorKey() !== dismissedStatusError ? state.status?.error : '');
  if (globalError) panel.append(el('div', { class: 'global-error', role: 'alert' },
    el('span', {}, globalError),
    button('关闭提示', () => { errors.delete('global'); dismissedStatusError = statusErrorKey(); render(); }, { icon: 'close', iconOnly: true, class: 'icon-button' })));
  if (state.status?.nativeRoundedFrame) panel.append(nativePinFrame());
  root.replaceChildren(panel);
  syncWindowLayout();
  renderedKey = key;
  if (saved) restore(saved);
  syncSelectedProviderDrafts();
  syncServiceProfileMetadata();
  restoreReadingAnchor(anchor);
  readingAnchor = captureReadingAnchor();
  for (const field of root.querySelectorAll('[data-limit]')) updateField(field);
  syncContentTransitions();
}

function header(view) {
  const back = ['settings', 'history', 'context'].includes(view);
  return el('header', { class: 'panel-bar' },
    back ? button('返回', () => navigate(view === 'context' ? 'explain' : lastContentView), { icon: 'back', iconOnly: true, class: 'icon-button', busy: 'navigate' }) : brand({ small: true, tile: true }),
    el('span', { class: 'name' }, 'PickGloss'),
    el('span', { class: 'spacer' }),
    button('更多操作', () => call('menu', { source: 'panel' }), { icon: 'menu', iconOnly: true, class: 'icon-button', busy: 'menu' }),
    button(state.pinned ? '取消置顶' : '置顶窗口', () => call('pin', { pinned: !state.pinned }), { icon: 'pin', iconOnly: true, class: `icon-button${state.pinned ? ' is-pinned' : ''}`, pressed: Boolean(state.pinned), busy: 'pin' }),
    button(readingLayout ? '返回小窗' : '阅读视图', async () => {
      transitionAnchor = captureReadingAnchor();
      const desired = typeof state?.wide === 'boolean' ? state.wide : readingLayout;
      const result = await call('wide', { wide: !desired }, { lock: false, render: false });
      if (!result.ok) { transitionAnchor = null; render(); }
    }, { icon: readingLayout ? 'narrow' : 'wide', iconOnly: true, class: 'icon-button layout-toggle' }),
    button('关闭窗口', async () => { if(await flushDraft())return call('close'); }, { icon: 'close', iconOnly: true, class: 'icon-button', busy: 'close' }));
}

function footer(view) {
  const kind = session()?.kind === 'image' ? 'vision' : 'text';
  const config = effectiveProvider(kind);
  const configured = hasProvider(kind);
  return el('footer', { class: 'panel-footer' },
    button(configured ? config.model : '配置 AI 服务', () => openSettings(), { class: 'provider', busy: 'open-settings' }),
    el('span', { class: 'spacer' }),
    session() && ['explain', 'preview', 'context'].includes(view) ? button(session().saved ? '取消收藏' : '收藏当前会话', async () => {
      const saved = !session().saved;
      const result = await call('favorite', { id: session().id, saved }, { render: false }); render();
      if (result.ok && saved && !document.documentElement.classList.contains('reduced-motion')) root.querySelector('.starred .icon')?.animate([{ transform: 'scale(.9)' }, { transform: 'scale(1.15)' }, { transform: 'scale(1)' }], { duration: 240, easing: 'cubic-bezier(.2,.8,.2,1)' });
    }, { icon: 'star', iconOnly: true, class: `icon-button${session().saved ? ' starred' : ''}`, pressed: Boolean(session().saved), busy: 'favorite' }) : null,
    button('会话历史', () => openHistory(), { icon: 'history', iconOnly: true, class: 'icon-button', busy: 'open-history' }));
}

async function navigate(view) { if(await flushDraft())return call('navigate', { view }); }
async function openSettings() { if(await flushDraft())return call('open-settings'); }
async function openHistory() { if(await flushDraft())return call('open-history'); }

function field(label, name, value, options = {}) {
  const id = `field-${name}`;
  const control = el(options.multiline ? 'textarea' : 'input', {
    id, name, type: options.type || (options.multiline ? undefined : 'text'),
    value: value || '', placeholder: options.placeholder || '',
    'data-field': name, 'data-limit': options.limit,
    'aria-describedby': options.limit ? `${id}-count` : undefined,
    autocomplete: options.type === 'password' ? 'new-password' : 'off',
    spellcheck: options.spellcheck === true ? 'true' : 'false',
    disabled: options.disabled,
    oninput: event => { updateField(event.target); options.oninput?.(event); },
  });
  const wrap = el('div', { class: 'field-wrap' },
    el('label', { class: 'label', for: id }, label, options.optional ? el('span', { class: 'optional' }, '选填') : null),
    control,
    options.limit ? el('p', { class: 'counter', id: `${id}-count`, 'data-count': name, 'aria-live': 'off' }) : null);
  return { wrap, control };
}

function updateField(control) {
  const limit = Number(control.dataset.limit);
  if (!limit) return;
  const count = control.value.length;
  const invalid = count > limit;
  control.setAttribute('aria-invalid', String(invalid));
  control.setCustomValidity(invalid ? `最多 ${limit} 字，当前 ${count} 字。` : '');
  const countNode = [...root.querySelectorAll('[data-count]')].find(node => node.dataset.count === control.dataset.field);
  if (countNode) {
    countNode.textContent = `${count} / ${limit} 字${invalid ? '，请缩短内容' : ''}`;
    countNode.hidden = control.dataset.field === 'question' && count < limit * 0.8;
    countNode.classList.toggle('danger', invalid);
  }
  if (control.dataset.field === 'question') {
    control.style.height = '30px';
    control.style.height = `${Math.min(control.scrollHeight, 105)}px`;
  }
}

function validate(value, limit, name, required = false) {
  if (required && !value.trim()) return `请填写${name}。`;
  if (value.length > limit) return `${name}最多 ${limit} 字，当前 ${value.length} 字，请缩短后再继续。`;
  return '';
}

function pasteView(body) {
  body.append(el('h1', {}, '粘贴要理解的文字'), el('p', { class: 'hint' }, '从阅读材料中复制文字，也可以补充所在段落。'));
  const text = field('选定内容', 'paste-text', '', { multiline: true, limit: LIMITS.text, placeholder: '粘贴单词、句子或一段文字' });
  const context = field('上下文', 'paste-context', '', { multiline: true, optional: true, limit: LIMITS.context, placeholder: '粘贴所在段落，帮助理解具体含义' });
  const submit = async event => {
    event.preventDefault();
    const error = validate(text.control.value, LIMITS.text, '选定内容', true) || validate(context.control.value, LIMITS.context, '上下文');
    if (error) { setError('paste', error); return; }
    const withContext = Boolean(context.control.value.trim());
    const result = await call('new-text', { text: text.control.value.trim(), context: context.control.value.trim() }, { scope: 'paste' });
    if (result.ok && result.value && withContext && hasProvider('text')) await call('start-explanation', result.value, { scope: 'explain' });
  };
  body.append(el('form', { onsubmit: submit, novalidate: true }, text.wrap, context.wrap, errorNode('paste'),
    el('div', { class: 'form-actions' }, button('截图框选', () => call('start-capture'), { icon: 'crop', class: 'secondary', busy: 'start-capture' }),
      button(pending.has('new-text') ? '正在打开…' : '开始解释', null, { type: 'submit', class: 'primary', busy: 'new-text' }))));
}

function notice(title, description, actions = [], error = false) {
  return el('div', { class: `notice${error ? ' error' : ''}`, role: error ? 'alert' : 'note' },
    el('h3', {}, title), el('p', {}, description), actions.length ? el('div', { class: 'actions' }, actions) : null);
}

function renderAnswer(container, content) {
  if (window.pickglossMarkdown) window.pickglossMarkdown.render(container, content, url => {
    void call('open-link', { url }, { render: false }).then(result => { if (!result.ok) render(); });
  });
  else container.textContent = content;
}

function syncCopyButton(node) {
  const feedback = copyFeedback.get(node.dataset.copyAnswer);
  node.disabled = node.dataset.copyReady !== 'true' || Boolean(feedback?.pending);
  node.querySelector('.copy-label').textContent = feedback?.label || '复制 Markdown';
  node.title = feedback?.label || '复制 Markdown';
  node.setAttribute('aria-label', node.title);
}

async function copyAnswer(selected, messageId) {
  const key = JSON.stringify([selected.id, selected.mode, messageId]);
  if (copyFeedback.get(key)?.pending) return;
  function refresh() {
    for (const node of root.querySelectorAll('[data-copy-answer]')) if (node.dataset.copyAnswer === key) syncCopyButton(node);
  }
  copyFeedback.set(key, { label: '正在复制…', pending: true }); refresh();
  const result = await call('copy-answer', { ...selected, messageId }, { render: false, lock: false, scope: `copy:${key}` });
  const feedback = { label: result.ok ? '已复制' : '复制失败，请重试', pending: false };
  copyFeedback.set(key, feedback); refresh();
  setTimeout(() => { if (copyFeedback.get(key) === feedback) { copyFeedback.delete(key); refresh(); } }, 2200);
}

function answerActions(message, latest) {
  const selected = target();
  const key = JSON.stringify([selected.id, selected.mode, message.id]);
  const node = el('button', { type: 'button', class: 'icon-button copy-answer', title: '复制 Markdown', 'aria-label': '复制 Markdown',
    'data-copy-answer': key, 'data-copy-ready': Boolean(message.content), onclick: () => copyAnswer(selected, message.id),
  }, icon('copy'), el('span', { class: 'copy-label', 'aria-live': 'polite' }, '复制 Markdown'));
  syncCopyButton(node);
  return el('div', { class: 'answer-actions' }, node,
    latest ? button('重新解释', startExplanation, { icon: 'retry', iconOnly: true, class: 'icon-button restart-answer', disabled: isStreaming(), busy: 'start-explanation' }) : null);
}

function contextParagraph(active) {
  return el('p', { class: 'context-text' }, ...contextParts(active.context, active.text).map(part =>
    part.selected ? el('mark', { class: 'context-match' }, part.text) : part.text));
}

function explanationProgress() {
  return el('div', { class: 'stream-status', role: 'status' }, el('span', { class: 'stream-dot', 'aria-hidden': 'true' }), '正在解释…');
}

function externalHttpUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

function searchStatusView(message, latest) {
  if (message.status === 'streaming') return null;
  const search = message.search;
  if (!search || typeof search !== 'object') return null;
  if (search.status === 'failed') {
    const actions = latest ? [
      button('重试联网', () => retrySearch(message.id, true), { class: 'secondary', busy: 'retry-search' }),
      button('不联网继续', () => retrySearch(message.id, false), { class: 'secondary', busy: 'retry-without-search' }),
    ] : [];
    return el('div', { class: 'search-failure', role: 'alert' },
      el('p', {}, '联网搜索失败。', search.error ? ` ${search.error}` : ' 未取得联网资料。'),
      latest ? el('p', { class: 'search-recovery-hint' }, '可以重试联网，或保留原问题并在不联网的情况下继续。') : null,
      actions.length ? el('div', { class: 'actions' }, actions) : null);
  }
  let label = '';
  const searchInProgress = ['preparing', 'searching'].includes(search.status);
  if (searchInProgress && message.status === 'stopped') label = '已停止联网搜索';
  else if (searchInProgress && message.status === 'error') label = '联网搜索未完成';
  else if (search.status === 'complete') {
    label = '已参考联网资料';
    if (!search.sources?.length) label = '没有找到可用的联网资料';
  }
  if (!label) return null;
  return el('p', { class: 'search-progress', role: 'status' }, label);
}

function sourceSiteIcon(url) {
  const origin = url ? new URL(url).origin : '';
  const data = sourceIconCache.get(origin)?.data;
  return el('span', { class: 'source-site-icon', 'data-source-icon': origin, 'aria-hidden': 'true' },
    data ? el('img', { src: data, alt: '', width: 14, height: 14 }) : icon('globe'));
}

async function loadSourceIcon(url, selected, messageId, sourceId) {
  if (!url || !selected.id) return;
  const origin = new URL(url).origin;
  const previous = sourceIconCache.get(origin);
  if (previous && (previous.pending || previous.expiresAt > Date.now())) return;
  if (sourceIconCache.size >= 64) sourceIconCache.delete(sourceIconCache.keys().next().value);
  const entry = { data: '', pending: true, expiresAt: 0 }; sourceIconCache.set(origin, entry);
  try {
    const result = await window.pickgloss.invoke('get-source-icon', { ...selected, messageId, sourceId });
    if (!result?.ok || typeof result.value !== 'string' || result.value.length > 65536 || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(result.value)) return;
    entry.data = result.value;
    for (const node of root.querySelectorAll('[data-source-icon]')) {
      if (node.dataset.sourceIcon === origin) node.replaceChildren(el('img', { src: entry.data, alt: '', width: 14, height: 14 }));
    }
  } catch { /* 图标不可用时保留通用网站标记。 */ }
  finally { entry.pending = false; entry.expiresAt = Date.now() + (entry.data ? 300000 : 30000); }
}

function searchSourcesView(message) {
  if (message.status === 'streaming') return null;
  const sources = Array.isArray(message.search?.sources) ? message.search.sources.filter(source => source && typeof source === 'object') : [];
  if (!sources.length) return null;
  const items = sources.map((source, index) => {
    const rawId = Number(source.id);
    const number = Number.isSafeInteger(rawId) && rawId > 0 ? rawId : index + 1;
    const url = externalHttpUrl(source.url);
    const title = typeof source.title === 'string' && source.title.trim() ? source.title : (url || '');
    return el('li', { class: 'search-source' },
      el('span', { class: 'search-source-number' }, `[${number}]`),
      url ? el('a', { class: 'search-source-link', href: url, onclick: event => {
        event.preventDefault();
        void call('open-link', { url }, { render: false, lock: false });
      } }, sourceSiteIcon(url), el('span', {}, title || url)) : el('span', { class: 'search-source-title' }, sourceSiteIcon(''), el('span', {}, title || '未提供标题')),
      source.snippet ? el('details', { class: 'search-source-excerpt', 'data-detail': `excerpt:${message.id || ''}:${number}:${url || source.title || ''}` },
        el('summary', {}, icon('chevron'), '查看摘录'),
        el('p', { class: 'search-source-snippet' }, String(source.snippet).replace(/&(?:nbsp|#0*32|#x0*20);/gi, ' ').replace(/\s+/g, ' ').trim())) : null);
  });
  const selected = target();
  return el('details', { class: 'search-sources', 'data-detail': `sources:${message.id || ''}`, ontoggle: event => {
    if (event.target.open) for (const source of sources) void loadSourceIcon(externalHttpUrl(source.url), selected, message.id, source.id);
  } },
    el('summary', {}, icon('chevron'), `联网来源（${sources.length}）`),
    el('ol', {}, ...items));
}

async function retrySearch(messageId, useSearch) {
  const selected = target();
  const action = useSearch ? 'retry-search' : 'retry-without-search';
  return call(action, { ...selected, messageId }, { scope: 'explain' });
}

function explainView(body) {
  const active = session();
  if (!active) { pasteView(body); return; }
  body.classList.add('explain-body');
  const sourcePane = el('aside', { class: 'source-pane', 'aria-label': '本次材料', 'data-scroll': 'source' });
  const answerPane = el('div', { class: 'answer-pane' });
  body.append(sourcePane, answerPane);
  sourcePane.append(el('p', { class: 'reading-label' }, active.kind === 'image' ? '本次截图' : '选定内容'));
  const image = active.kind === 'image';
  if (image) {
    sourcePane.append(el('h1', {}, '截图讲解'));
    if (safeImage(active.imageData)) sourcePane.append(el('img', { class: 'preview-image image-thumb', src: active.imageData, alt: '本次框选的图像' }));
    if (active.note) sourcePane.append(el('p', { class: 'source-line' }, '截图说明：', active.note));
  } else {
    sourcePane.append(el('div', { class: `selected-word${active.text?.length > 45 || active.text?.includes('\n') ? ' long' : ''}`, 'data-scroll': 'selected', role: 'heading', 'aria-level': '1' }, active.text || '选定内容'));
    const origin = active.source;
    if (origin?.app || origin?.title) sourcePane.append(el('p', { class: 'source-line' },
      origin.app ? el('span', { class: 'source-app' }, origin.app) : null,
      origin.app && origin.title ? el('span', { class: 'source-separator' }, ' · ') : null,
      origin.title ? el('span', { class: 'source-title' }, origin.title) : null));
    if (active.context) sourcePane.append(el('details', { class: 'context-disclosure', 'data-detail': 'context' },
      el('summary', {}, icon('chevron'), active.contextOrigin === 'manual' || active.contextOrigin?.includes('手动') ? '已补充的上下文' : '查看上下文'),
      contextParagraph(active),
      !active.threads?.context?.messages?.length ? button('编辑上下文', () => navigate('context'), { class: 'text-button' }) : null));
    if (active.context) sourcePane.append(el('section', { class: 'reading-context' },
      el('p', { class: 'reading-label' }, '所在段落'), contextParagraph(active),
      !active.threads?.context?.messages?.length ? button('编辑上下文', () => navigate('context'), { class: 'text-button' }) : null));
    if (active.contextPending === true) sourcePane.append(el('p', { class: 'context-pending', role: 'status' },
      el('span', { class: 'stream-dot', 'aria-hidden': 'true' }), '正在获取上下文…'));
  }
  body = answerPane;
  if (!image) {
    body.append(el('div', { class: 'mode-tabs', role: 'tablist', 'aria-label': '解释模式' },
      ...['context', 'independent'].map(value => button(MODE_NAMES[value], () => switchMode(value), { role: 'tab', selected: mode() === value, busy: 'set-mode' }))));
  }
  const content = el('div', { class: 'mode-content' });
  body.append(content); body = content;
  const current = thread();
  const messages = current.messages || [];
  const latestAnswer = messages.findLast(message => message.role === 'assistant');
  const generatingAnswer = isStreaming() && messages.at(-1)?.role === 'assistant' ? messages.at(-1) : null;
  if (!image && mode() === 'context' && (active.contextPending === true || !active.context?.trim())) {
    const contextPending = active.contextPending === true;
    const actions = contextPending ? [] : [button('补充上下文', () => navigate('context'), { class: 'primary' })];
    actions.push(button('独立释义', () => switchMode('independent'), { class: contextPending ? 'primary' : 'secondary', busy: 'set-mode' }));
    body.append(notice(contextPending ? '正在获取上下文' : '还没有上下文', contextPending
      ? '语境解释会在上下文就绪后开放；你也可以先查看独立释义。'
      : active.contextReason ? `${active.contextReason} 也可以先查看独立释义。` : '补充所在段落，可以理解这处用法；也可以先查看独立释义。', actions));
  }
  if (!hasProvider(image ? 'vision' : 'text')) body.append(notice(`配置${image ? '识图' : '文字'}模型后继续`, '选定内容和会话已经保留。填写服务地址与模型名称后即可开始。', [button('配置 AI 服务', () => openSettings(), { class: 'primary', busy: 'open-settings' })]));
  const conversation = el('div', { class: 'conversation', role: 'log', 'aria-label': MODE_NAMES[mode()], 'aria-live': 'off' });
  for (const message of messages) {
    const user = message.role === 'user';
    const content = el(user ? 'p' : 'div', { class: `message-content${user ? '' : ' markdown-body'}` });
    if (!user && message.content) renderAnswer(content, message.content);
    else content.textContent = message.content || '';
    conversation.append(el('article', { class: `message ${user ? 'user' : 'assistant'}`, 'data-message': message.id || '' },
      user ? el('div', { class: 'message-label' }, '追问') : null,
      content,
      !user ? searchStatusView(message, message === latestAnswer && messages.at(-1) === message) : null,
      !user ? searchSourcesView(message) : null,
      message === generatingAnswer && !message.content ? explanationProgress() : null,
      !user && message.search?.status !== 'failed' && ['stopped', 'error'].includes(message.status) ? el('p', { class: 'message-state' }, message.status === 'stopped' ? '未完成 · 已停止' : '未完成 · 请求失败') : null,
      user || message === generatingAnswer ? null : answerActions(message, message === latestAnswer)));
  }
  body.append(conversation);
  if (isStreaming()) { if (!generatingAnswer) conversation.append(explanationProgress()); }
  else if ((current.error || current.status === 'error' || messages.at(-1)?.status === 'error') && latestAnswer?.search?.status !== 'failed') body.append(notice('这次请求没有完成', current.error || '请检查服务配置或连接后重试。已有内容与追问草稿会保留。', [button('重试', retryExplanation, { icon: 'retry', class: 'primary', busy: 'start-explanation' }), button('服务设置', () => openSettings(), { class: 'secondary' })], true));
  else if (current.status === 'stopped' || messages.at(-1)?.status === 'stopped') body.append(el('div', { class: 'stream-status', role: 'status' }, '已停止，已生成的内容已保留。'));
  else if (!messages.length && hasProvider(image ? 'vision' : 'text') && (image || mode() === 'independent' || active.context?.trim() && active.contextPending !== true)) body.append(el('div', { class: 'empty' }, el('p', {}, image ? '解释图像中的内容，也可以围绕细节继续追问。' : mode() === 'independent' ? '查看一般含义和常见用法。这个模式会分别保留回答与追问。' : '结合上下文，理解选定内容在这里的含义。'), button(image ? '解释截图' : '开始释义', () => startExplanation(), { class: 'primary', busy: 'start-explanation' })));
  body.append(errorNode('explain'));
}

async function switchMode(next) {
  if (next === mode() || pending.has('set-mode')) return;
  const id=session()?.id;
  if(!await flushDraft())return;
  errors.delete('question');
  errors.delete('explain');
  await call('set-mode', { id, mode: next }, { scope: 'explain' });
}

async function startExplanation() {
  const selected=target();
  if (session()?.kind !== 'image' && mode() === 'context' && session()?.contextPending === true) {
    setError('explain', '正在获取上下文，请等上下文就绪后再开始语境解释。');
    return { ok: false, error: '正在获取上下文' };
  }
  if(!await flushDraft())return;
  return call('start-explanation', selected, { scope: 'explain' });
}

async function retryExplanation() {
  // 核心根据当前线程中失败的最后一轮重试，避免重复追加用户追问。
  return startExplanation();
}

function composer() {
  const selected=target();
  const blocked = isStreaming() || pending.has('send-question');
  const missingContext = session()?.kind !== 'image' && mode() === 'context' && (session()?.contextPending === true || !session()?.context?.trim());
  const configured = hasProvider(session()?.kind === 'image' ? 'vision' : 'text');
  const textarea = el('textarea', {
    'data-field': 'question', 'data-limit': LIMITS.question, 'data-session': selected.id, 'data-mode': selected.mode,
    'aria-label': '继续追问', 'aria-describedby': 'question-count',
    placeholder: '继续问一句…', value: draftValue(), disabled: pending.has('send-question'),
    rows: 1, spellcheck: 'false',
    oninput: event => { rememberDraft(event.target); updateField(event.target); scheduleDraft(); },
    onkeydown: event => {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing || composing) return;
      event.preventDefault();
      if (!justFinishedComposition && !blocked) sendQuestion();
    },
  });
  const send = isStreaming()
    ? button('停止回答', () => call('stop', selected), { icon: 'stop', iconOnly: true, class: 'send', busy: 'stop' })
    : button('发送追问', sendQuestion, { icon: 'send', iconOnly: true, class: 'send', title: session()?.contextPending ? '正在获取上下文，暂时不能发送语境解释' : '发送追问', disabled: blocked || missingContext || !configured, busy: 'send-question' });
  return el('section', { class: 'composer-wrap', 'aria-label': '追问' }, el('div', { class: 'composer' }, textarea, webSearchButton(), send),
    el('p', { class: 'counter', id: 'question-count', 'data-count': 'question' }), errorNode('question'), errorNode('web-search'));
}

function webSearchButton() {
  const enabled = webSearchEnabled();
  return button(enabled ? '关闭联网搜索' : '开启联网搜索', toggleWebSearch, {
    icon: 'globe', iconOnly: true, pressed: enabled,
    class: `icon-button web-search-toggle${enabled ? ' is-enabled' : ''}`,
    title: enabled ? '联网搜索已开启；点击关闭' : '联网搜索已关闭；点击开启',
    busy: 'set-web-search',
  });
}

async function toggleWebSearch() {
  const active = session();
  if (!active) return { ok: false, error: '当前没有解释会话。' };
  const id = active.id;
  const enabled = !webSearchEnabled(active);
  webSearchOverrides.set(id, enabled);
  const result = await call('set-web-search', { id, mode: mode(), enabled }, { scope: 'web-search' });
  if (!result.ok) webSearchOverrides.delete(id);
  else if (session()?.id === id) {
    state = { ...state, session: { ...session(), webSearchEnabled: enabled } };
    webSearchOverrides.delete(id);
  }
  render();
  return result;
}

function scheduleDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => { draftTimer = null; void flushDraft(); }, 350);
}

function rememberDraft(input) {
  const item={id:input.dataset.session,mode:input.dataset.mode,draft:input.value};
  const key=`${item.id}:${item.mode}`;
  // 每次真实输入都递增，包括用户主动清空。
  draftVersions.set(key, (draftVersions.get(key) || 0) + 1);
  drafts.set(key,item.draft);dirtyDrafts.set(key,item);
}

function flushDraft() {
  clearTimeout(draftTimer);
  draftTimer = null;
  draftWork = draftWork.then(async () => {
    let ok=true;
    for(const [key,item] of [...dirtyDrafts]) {
      if(item.draft.length>LIMITS.question){errors.set('global','有追问超过 4000 字，缩短后才能保存。');ok=false;continue;}
      const result=await call('set-draft',item,{scope:'global',lock:false,render:false});
      if(result.ok&&dirtyDrafts.get(key)===item)dirtyDrafts.delete(key);
      if(!result.ok)ok=false;
    }
    for(const [id,item] of [...dirtyNotes]) {
      if(item.note.length>LIMITS.note){errors.set('global','截图说明超过 4000 字，缩短后才能保存。');ok=false;continue;}
      const result=await call('set-note',item,{scope:'global',lock:false,render:false});
      if(result.ok&&dirtyNotes.get(id)===item)dirtyNotes.delete(id);
      if(!result.ok)ok=false;
    }
    if(!ok)render();
    return ok;
  });
  return draftWork;
}

async function sendQuestion() {
  if (isStreaming() || pending.has('send-question')) return;
  const question = draftValue();
  const error = validate(question, LIMITS.question, '追问', true);
  if (error) { setError('question', error); return; }
  if (!hasProvider(session()?.kind === 'image' ? 'vision' : 'text')) { setError('question', '请先配置 AI 服务。'); return; }
  if (mode() === 'context' && session()?.contextPending === true) { setError('question', '正在获取上下文，请等上下文就绪后再发送语境解释。'); return; }
  if (mode() === 'context' && !session()?.context?.trim()) { setError('question', '请先补充上下文，或切换到独立释义。'); return; }
  const key = draftKey();
  const selected=target();
  const version = draftVersions.get(key) || 0;
  if(!await flushDraft())return;
  const submission = trackQuestionSubmission(selected, question.trim(), version);
  const result = await call('send-question', { ...selected, question: question.trim() }, { scope: 'question' });
  if (result.ok) {
    const unchanged = (draftVersions.get(key) || 0) === version && (!drafts.has(key) || drafts.get(key) === question);
    if (!submission.recovered) {
      if (unchanged) drafts.set(key, '');
      else if (drafts.has(key)) { dirtyDrafts.set(key, { ...selected, draft: drafts.get(key) }); scheduleDraft(); }
    }
    const input = root.querySelector('[data-field="question"]');
    if (input && key === draftKey() && unchanged && !submission.recovered) { input.value = ''; updateField(input); input.focus({ preventScroll: true }); }
    const body = root.querySelector('[data-scroll="body"]');
    if (body) body.scrollTop = body.scrollHeight;
  } else forgetQuestionSubmission(submission);
}

function previewView(body) {
  const active = session();
  body.append(el('h1', {}, '确认截图'), el('p', { class: 'hint' }, '直接解释，也可以补充背景或指出想了解的内容。'));
  if (!safeImage(active?.imageData)) {
    body.append(notice('没有取得截图', '请重新框选需要理解的区域。', [button('重新框选', () => call('start-capture'), { icon: 'crop', class: 'primary', busy: 'start-capture' })], true));
    return;
  }
  body.append(el('img', { class: 'preview-image', src: active.imageData, alt: '本次框选的图像预览' }));
  const note = field('截图说明', 'image-note', notes.get(active.id) ?? active.note ?? '', { multiline: true, optional: true, limit: LIMITS.note, placeholder: '例如：解释图中两条曲线有什么区别', oninput:event=>{
    notes.set(active.id,event.target.value);dirtyNotes.set(active.id,{id:active.id,note:event.target.value});scheduleDraft();
  } });
  body.append(note.wrap, errorNode('preview'), errorNode('web-search'), el('div', { class: 'form-actions' },
    button('重新框选', () => call('start-capture'), { icon: 'crop', class: 'secondary', busy: 'start-capture' }),
    webSearchButton(),
    button(pending.has('set-note') || pending.has('start-explanation') ? '正在准备…' : '直接解释', async () => {
      if (pending.has('set-note') || pending.has('start-explanation')) return;
      const value = note.control.value;
      const error = validate(value, LIMITS.note, '截图说明');
      if (error) { setError('preview', error); return; }
      dirtyNotes.set(active.id,{id:active.id,note:value.trim()});
      if(await flushDraft())await call('start-explanation', {id:active.id,mode:'visual'}, { scope: 'preview' });
    }, { class: 'primary', disabled: pending.has('set-note') || pending.has('start-explanation') })));
  if (!hasProvider('vision')) body.append(notice('还没有可用的识图服务', '截图和说明会保留。可配置支持图片的文字模型，或单独填写识图模型。', [button('配置 AI 服务', () => { settingsTab = state.settings?.vision?.model?.trim() ? 'vision' : 'text'; return openSettings(); }, { class: 'secondary' })]));
}

function contextView(body) {
  const id=session()?.id;
  body.append(el('h1', {}, '补充上下文'), el('p', { class: 'hint' }, '粘贴选定内容所在的段落，或补充帮助判断含义的周边文字。'));
  const context = field('上下文', 'context-edit', session()?.context || '', { multiline: true, limit: LIMITS.context, placeholder: '填写与选定内容相关的原文段落' });
  body.append(el('form', { novalidate: true, onsubmit: async event => {
    event.preventDefault();
    const value = context.control.value;
    const error = validate(value, LIMITS.context, '上下文', true);
    if (error) { setError('context', error); return; }
    await call('set-context', { id, context: value.trim() }, { scope: 'context' });
  } }, context.wrap, errorNode('context'), el('div', { class: 'form-actions' },
    button('取消', () => navigate('explain'), { class: 'secondary' }),
    button('使用这段上下文', null, { type: 'submit', class: 'primary', busy: 'set-context' }))));
}

function settingsView(body) {
  const general = el('div', { class: 'general-settings', 'data-settings-section': 'general', hidden: settingsSection !== 'general' });
  const service = el('div', { 'data-settings-section': 'service', hidden: settingsSection !== 'service' });
  const appearance = el('div', { 'data-settings-section': 'appearance', hidden: settingsSection !== 'appearance' });
  const shortcuts = el('div', { 'data-settings-section': 'shortcuts', hidden: settingsSection !== 'shortcuts' });
  const sections = { general, service, appearance, shortcuts };
  const entries = [['general', '常规设置'], ['service', 'AI 服务'], ['appearance', '外观与主题'], ['shortcuts', '快捷键']];
  const tabs = el('div', { class: 'settings-navigation', role: 'tablist', 'aria-label': '设置分类' });
  for (const [value, label] of entries) tabs.append(button(label, () => {
    if (value !== 'shortcuts') void shortcutsUI.endRecording();
    settingsSection = value;
    for (const [key, node] of Object.entries(sections)) node.hidden = key !== value;
    [...tabs.querySelectorAll('[role="tab"]')].forEach((tab, i) => tab.setAttribute('aria-selected', String(entries[i][0] === value)));
    syncModeIndicator(); syncContentTransitions();
    body.scrollTop = 0;
    void call(({ appearance: 'open-appearance', shortcuts: 'open-shortcuts' })[value] || 'open-settings', value === 'general' ? { section: 'general' } : {}, { lock: false, render: false }).then(result => { if (!result.ok) render(); });
  }, { role: 'tab', selected: settingsSection === value }));
  generalSettingsView(general);
  serviceSettingsView(service);
  appearanceUI.mount(appearance);
  shortcutsUI.mount(shortcuts);
  body.append(tabs, general, service, appearance, shortcuts);
}

const FALLBACK_SERVICE_CATALOG = {
  models: [
    { id: 'custom', name: '自定义', baseUrl: '', model: '', keyUrl: '' },
    { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', keyUrl: 'https://platform.deepseek.com/api_keys' },
    { id: 'mimo', name: '小米 MiMo', baseUrl: 'https://api.xiaomimimo.com/v1', model: 'mimo-v2.6-pro', keyUrl: 'https://platform.xiaomimimo.com/#/console/api-keys' },
  ],
  search: [
    { id: 'exa', name: 'Exa', baseUrl: 'https://api.exa.ai/search', keyUrl: '' },
    { id: 'brave', name: 'Brave', baseUrl: 'https://api.search.brave.com/res/v1/llm/context', keyUrl: '' },
    { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1/tools/search', keyUrl: 'https://platform.deepseek.com/api_keys' },
    { id: 'custom', name: '自定义', protocol: 'exa', baseUrl: '', keyUrl: '' },
  ],
};

function serviceCatalog(kind) {
  const key = kind === 'search' ? 'search' : 'models';
  const provided = state?.serviceCatalog?.[key];
  const items = Array.isArray(provided) ? provided : FALLBACK_SERVICE_CATALOG[key];
  const options = items.filter(item => item && typeof item.id === 'string').map(item => ({ ...item }));
  if (!options.some(item => item.id === 'custom')) {
    if (kind === 'search') options.push(FALLBACK_SERVICE_CATALOG.search.find(item => item.id === 'custom'));
    else options.unshift(FALLBACK_SERVICE_CATALOG.models[0]);
  }
  return options;
}

function syncSelectedProviderDrafts() {
  if (state?.view !== 'settings' || settingsSection !== 'service') return;
  for (const kind of ['text', 'vision', 'search']) {
    const select = root.querySelector(`[name="${kind}-provider"]`);
    if (select?.value) selectedProviders[kind] = select.value;
  }
}

function syncServiceProfileMetadata() {
  if (state?.view !== 'settings' || settingsSection !== 'service') return;
  const form = root.querySelector('[data-settings-section="service"] form');
  if (!form) return;
  for (const kind of ['text', 'vision', 'search']) {
    const providerId = selectedProviderId(form, kind);
    const config = resolveServiceProfile(kind, providerId);
    const key = form.querySelector(`[name="${kind}-apiKey"]`);
    if (kind === 'search') form.querySelector('.search-protocol-select').hidden = providerId !== 'custom';
    if (key) key.placeholder = config.hasKey ? '已配置，留空保留原 Key' : '未配置，按服务要求填写';
    const link = form.querySelector(`[data-key-link="${kind}"]`);
    if (link) link.hidden = !externalHttpUrl(config.keyUrl);
  }
}

function selectedProviderId(form, kind) {
  return form.querySelector(`[name="${kind}-provider"]`)?.value || state.settings?.[kind]?.providerId || 'custom';
}

function readServiceDraft(form, kind) {
  return kind === 'search' ? searchProviderConfig(form) : providerConfig(form, kind);
}

function captureServiceDraft(form, kind, providerId = selectedProviderId(form, kind)) {
  const config = readServiceDraft(form, kind);
  config.providerId = providerId;
  if (kind === 'search' && providerId === 'custom') config.protocol = form.querySelector('[name="search-protocol"]').value;
  const saved = state.settings?.serviceProfiles?.[kind]?.[config.providerId] || {};
  const active = state.settings?.[kind] || {};
  config.hasKey = saved.hasKey === true || active.providerId === config.providerId && active.hasKey === true || !active.providerId && config.providerId === 'custom' && active.hasKey === true;
  serviceDrafts[kind].set(config.providerId, config);
}

function resolveServiceProfile(kind, providerId) {
  const catalog = serviceCatalog(kind).find(item => item.id === providerId) || {};
  const profile = state.settings?.serviceProfiles?.[kind]?.[providerId] || {};
  const active = state.settings?.[kind] || {};
  const isActive = active.providerId === providerId || (!active.providerId && providerId === 'custom');
  const merged = { ...catalog, ...profile, ...(isActive ? active : {}) };
  const draft = serviceDrafts[kind].get(providerId);
  return draft ? { ...merged, ...draft } : merged;
}

function applyServiceProfile(form, kind, providerId) {
  const config = resolveServiceProfile(kind, providerId);
  const assign = (name, value) => {
    const control = form.querySelector(`[name="${kind}-${name}"]`);
    if (control) control.value = value || '';
  };
  assign('baseUrl', config.baseUrl);
  if (kind === 'search') {
    assign('protocol', config.protocol || 'exa');
    form.querySelector('.search-protocol-select').hidden = providerId !== 'custom';
  }
  if (kind !== 'search') assign('model', config.model);
  assign('apiKey', config.apiKey);
  const clearKey = form.querySelector(`[name="${kind}-clearKey"]`);
  if (clearKey) clearKey.checked = config.clearKey === true;
  const key = form.querySelector(`[name="${kind}-apiKey"]`);
  if (key) key.placeholder = config.hasKey ? '已配置，留空保留原 Key' : '未配置，按服务要求填写';
  const link = form.querySelector(`[data-key-link="${kind}"]`);
  if (link) link.hidden = !externalHttpUrl(config.keyUrl);
}

function providerSelect(form, kind, providerId) {
  const providers = serviceCatalog(kind);
  selectedProviders[kind] = providerId;
  const select = el('select', { id: `field-${kind}-provider`, name: `${kind}-provider`, 'data-field': `${kind}-provider`, 'aria-label': kind === 'search' ? '搜索服务提供商' : '模型服务提供商',
    onchange: event => {
      captureServiceDraft(form, kind, selectedProviders[kind] || providerId);
      selectedProviders[kind] = event.target.value;
      applyServiceProfile(form, kind, event.target.value);
    } }, ...providers.map(item => el('option', { value: item.id, selected: item.id === providerId }, item.name)));
  return el('div', { class: 'field-wrap service-provider-select' },
    el('label', { class: 'label', for: `field-${kind}-provider` }, kind === 'search' ? '搜索服务提供商' : '模型厂商'),
    select);
}

function serviceKeyLink(kind) {
  const link = button('获取 API Key', () => {
    const config = resolveServiceProfile(kind, selectedProviderId(root.querySelector('[data-settings-section="service"] form'), kind));
    const url = externalHttpUrl(config.keyUrl);
    if (url) void call('open-link', { url }, { scope: 'settings', render: false, lock: false });
  }, { class: 'text-button', title: '在系统浏览器打开官方密钥页面' });
  link.dataset.keyLink = kind;
  return link;
}

function apiKeyNote() {
  return el('p', { class: 'hint api-key-note' }, `本机 DPAPI 加密。路径：${state.settingsFilePath || '暂不可用'}`);
}

function profilePayload(config, kind) {
  const result = { baseUrl: config.baseUrl || '' };
  if (kind === 'search' && config.protocol) result.protocol = config.protocol;
  if (kind !== 'search') result.model = config.model || '';
  if (config.apiKey) result.apiKey = config.apiKey;
  if (config.clearKey === true) result.clearKey = true;
  return result;
}

function serviceProfilesPayload(form) {
  const result = { text: {}, vision: {}, search: {} };
  for (const kind of ['text', 'vision', 'search']) {
    for (const [id, profile] of Object.entries(state.settings?.serviceProfiles?.[kind] || {})) result[kind][id] = profilePayload(profile, kind);
    for (const [id, draft] of serviceDrafts[kind]) result[kind][id] = profilePayload(draft, kind);
    const current = readServiceDraft(form, kind);
    result[kind][current.providerId] = profilePayload(current, kind);
  }
  return result;
}

function serviceSettingsView(body) {
  body.append(el('h1', {}, 'AI 服务'), el('p', { class: 'hint' }, '识图模型留空时，截图使用文字模型的整套配置。API Key 留空会保留已保存的密钥。'));
  const kinds = ['text', 'vision', 'search'];
  const tabs = el('div', { class: 'mode-tabs', role: 'tablist', 'aria-label': '服务类型' });
  for (const kind of kinds) tabs.append(button(({ text: '文字模型', vision: '识图模型', search: '联网搜索' })[kind], () => {
    settingsTab = kind;
    for (const section of root.querySelectorAll('[data-provider]')) section.hidden = section.dataset.provider !== kind;
    for (const tab of tabs.querySelectorAll('[role="tab"]')) tab.setAttribute('aria-selected', String(tab.dataset.kind === kind));
    syncModeIndicator(); syncContentTransitions();
  }, { role: 'tab', selected: settingsTab === kind }));
  [...tabs.children].forEach((tab, index) => { tab.dataset.kind = kinds[index]; });
  body.append(tabs);
  const form = el('form', { novalidate: true, onsubmit: async event => {
    event.preventDefault();
    const text = providerConfig(form, 'text');
    const vision = providerConfig(form, 'vision');
    const search = searchProviderConfig(form);
    const payload = {
      text, vision, search, serviceProfiles: serviceProfilesPayload(form),
    };
    const result = await call('save-settings', payload, { scope: 'settings' });
    if (result.ok) { tests.clear(); for (const kind of kinds) serviceDrafts[kind].clear(); }
  } });
  for (const kind of ['text', 'vision']) {
    const config = state.settings?.[kind] || {};
    const providerId = config.providerId || 'custom';
    const section = el('section', { class: 'settings-section', 'data-provider': kind, hidden: settingsTab !== kind });
    section.append(providerSelect(form, kind, providerId));
    if (kind === 'vision') section.append(el('p', { class: 'hint' }, '可选：模型名称留空时，使用文字模型的地址、模型和密钥，忽略下面的识图配置。文字模型需要支持图片输入。'));
    section.append(field('服务地址', `${kind}-baseUrl`, config.baseUrl || '', { placeholder: '兼容服务的 API 地址' }).wrap,
      field('模型名称', `${kind}-model`, config.model || '', { optional: kind === 'vision', placeholder: kind === 'vision' ? '留空使用文字模型' : '文字模型名称' }).wrap,
      field('API Key', `${kind}-apiKey`, '', { type: 'password', optional: true, placeholder: config.hasKey ? '已配置，留空保留原 Key' : '未配置，按服务要求填写' }).wrap,
      apiKeyNote(),
      serviceKeyLink(kind),
      el('label', { class: 'check-label' }, el('input', { type: 'checkbox', name: `${kind}-clearKey`, 'data-field': `${kind}-clearKey` }), '清除已保存的 API Key'),
      el('p', { class: 'hint' }, kind === 'vision' ? '测试连接会向识图模型发送小图片；模型名称留空时使用当前文字配置。可能产生服务费用。' : '点击“测试连接”会向上方服务发送测试内容，并可能产生服务费用。'),
      button(pending.has('test-provider') && tests.get(kind)?.pending ? '正在测试…' : '测试连接', async () => {
        if (pending.has('test-provider')) return;
        const config = providerConfig(form, kind);
        const fallbackConfig = kind === 'vision' && !config.model ? providerConfig(form, 'text') : undefined;
        const selected = fallbackConfig || config;
        if (!selected.baseUrl || !selected.model) { tests.set(kind, { error: true, message: fallbackConfig ? '请先填写文字模型的服务地址和模型名称，或单独配置识图模型。' : '请先填写服务地址和模型名称。' }); render(); return; }
        tests.set(kind, { pending: true, message: fallbackConfig ? '正在使用文字模型发送识图测试图片…' : '正在向指定服务发送测试内容…' });
        const result = await call('test-provider', { kind, config, fallbackConfig }, { scope: `test-${kind}` });
        tests.set(kind, { error: !result.ok, message: result.ok ? (typeof result.value === 'string' ? result.value : result.value?.message || '连接成功，服务已返回测试结果。') : result.error || '测试没有完成，请重试。' });
        render();
      }, { class: 'secondary', busy: 'test-provider' }),
      el('p', { class: `test-result${tests.get(kind)?.error ? ' danger' : ' success'}`, role: 'status' }, tests.get(kind)?.message || ''),
      errorNode(`test-${kind}`));
    form.append(section);
    applyServiceProfile(form, kind, providerId);
  }
  {
    const kind = 'search';
    const config = state.settings?.search || {};
    const providerId = config.providerId || 'exa';
    const section = el('section', { class: 'settings-section', 'data-provider': kind, hidden: settingsTab !== kind });
    section.append(providerSelect(form, kind, providerId),
      el('div', { class: 'field-wrap search-protocol-select', hidden: providerId !== 'custom' },
        el('label', { class: 'label', for: 'search-protocol' }, '接口格式'),
        el('select', { id: 'search-protocol', name: 'search-protocol', 'data-field': 'search-protocol', 'aria-label': '自定义搜索接口格式' },
          ...[['exa', 'Exa 兼容'], ['brave', 'Brave 兼容'], ['deepseek', 'DeepSeek 兼容']].map(([value, label]) => el('option', { value }, label))),
        el('p', { class: 'hint' }, '填写完整搜索地址，接口需兼容所选格式。')),
      field('搜索服务地址', 'search-baseUrl', config.baseUrl || '', { placeholder: '所选搜索服务的 API 地址' }).wrap,
      field('API Key', 'search-apiKey', '', { type: 'password', optional: true, placeholder: config.hasKey ? '已配置，留空保留原 Key' : '未配置，按服务要求填写' }).wrap,
      apiKeyNote(),
      serviceKeyLink(kind),
      el('label', { class: 'check-label' }, el('input', { type: 'checkbox', name: 'search-clearKey', 'data-field': 'search-clearKey' }), '清除已保存的 API Key'),
      el('p', { class: 'hint' }, '测试会向所选搜索服务发送一次短查询，可能产生服务费用。'),
      button(pending.has('test-search-provider') && tests.get(kind)?.pending ? '正在测试…' : '测试搜索服务', async () => {
        if (pending.has('test-search-provider')) return;
        const config = searchProviderConfig(form);
        if (!config.baseUrl) { tests.set(kind, { error: true, message: '请先填写搜索服务地址。' }); render(); return; }
        tests.set(kind, { pending: true, message: '正在向指定搜索服务发送测试查询…' });
        const result = await call('test-search-provider', { config }, { scope: 'test-search' });
        tests.set(kind, { error: !result.ok, message: result.ok ? (typeof result.value === 'string' ? result.value : result.value?.message || '搜索服务已返回测试结果。') : result.error || '测试没有完成，请重试。' });
        render();
      }, { class: 'secondary', busy: 'test-search-provider' }),
      el('p', { class: `test-result${tests.get(kind)?.error ? ' danger' : ' success'}`, role: 'status' }, tests.get(kind)?.message || ''),
      errorNode('test-search'));
    form.append(section);
    applyServiceProfile(form, kind, providerId);
  }
  form.append(errorNode('settings'),
    el('div', { class: 'form-actions' }, button('取消', () => navigate(lastContentView), { class: 'secondary' }), button(pending.has('save-settings') ? '正在保存…' : '保存设置', null, { type: 'submit', class: 'primary', busy: 'save-settings' })));
  body.append(form);
}

function generalSettingsView(body) {
  body.append(el('h1', {}, '常规设置'));
  const form = el('form', { novalidate: true, onsubmit: async event => {
    event.preventDefault();
    const checked = name => form.querySelector(`[name="${name}"]`).checked;
    await call('save-settings', { prefs: { showOrb: checked('showOrb'), selectionEnabled: checked('selectionEnabled'),
      autoExplainCapture: checked('autoExplainCapture'), pinSound: checked('pinSound'), orbAction: form.querySelector('[name="orbAction"]').value } }, { scope: 'general' });
  } });
  form.append(el('label', { class: 'label', for: 'orb-action' }, '悬浮球左键功能'),
    el('select', { id: 'orb-action', class: 'orb-action-select', name: 'orbAction', 'data-field': 'orbAction', 'aria-label': '悬浮球左键功能' },
      el('option', { value: 'chat', selected: state.settings?.prefs?.orbAction !== 'capture' }, '打开 / 关闭最新会话（默认）'),
      el('option', { value: 'capture', selected: state.settings?.prefs?.orbAction === 'capture' }, '截图框选')),
    el('p', { class: 'hint' }, '选择会话时，再次点击会关闭窗口；选择截图时，点击直接开始框选。右键始终打开菜单。'),
    el('label', { class: 'check-label' }, el('input', { type: 'checkbox', name: 'autoExplainCapture', 'data-field': 'autoExplainCapture', checked: state.settings?.prefs?.autoExplainCapture === true }), '截图框选完成后自动解释'),
    el('p', { class: 'hint' }, '关闭时仍会先显示截图预览，由你确认后再开始解释。联网沿用上次开关。'),
    el('label', { class: 'check-label' }, el('input', { type: 'checkbox', name: 'showOrb', 'data-field': 'showOrb', checked: Boolean(state.settings?.prefs?.showOrb) }), '显示悬浮球'),
    el('label', { class: 'check-label' }, el('input', { type: 'checkbox', name: 'selectionEnabled', 'data-field': 'selectionEnabled', checked: Boolean(state.settings?.prefs?.selectionEnabled) }), '启用划词入口'),
    el('label', { class: 'check-label' }, el('input', { type: 'checkbox', name: 'pinSound', 'data-field': 'pinSound', checked: state.settings?.prefs?.pinSound !== false }), '置顶时播放提示音'),
    errorNode('general'),
    el('div', { class: 'form-actions' }, button(pending.has('save-settings') ? '正在保存…' : '保存设置', null, { type: 'submit', class: 'primary', busy: 'save-settings' })));
  body.append(form);
  windowSettingsView(body);
  const status = state.status || {};
  if (status.selection || status.shortcutErrors?.length) body.append(el('section', { class: 'status-details' }, el('h3', {}, '系统状态'), status.selection ? el('p', {}, status.selection) : null, ...(status.shortcutErrors || []).map(message => el('p', { class: 'danger' }, message))));
}

function windowSettingsView(body) {
  body.append(el('section', { class: 'window-settings', 'aria-label': '窗口设置' },
    el('div', { class: 'window-settings-row' },
      el('div', { class: 'window-settings-copy' }, el('h3', {}, '窗口大小'), el('p', {}, '恢复两种视图的默认尺寸。')),
      button('恢复默认', async () => {
      windowSizeFeedback = '';
      const result = await call('reset-window-size', {}, { scope: 'window-size' });
      if (result.ok) windowSizeFeedback = '已恢复默认大小';
      render();
    }, { class: 'window-reset', title: '恢复窗口默认大小', icon: 'retry', busy: 'reset-window-size' })),
    el('p', { role: 'status', 'data-window-size-feedback': true }, windowSizeFeedback), errorNode('window-size')));
}

function providerConfig(form, kind) {
  const read = name => form.querySelector(`[name="${kind}-${name}"]`);
  const config = { providerId: selectedProviderId(form, kind), baseUrl: read('baseUrl').value.trim(), model: read('model').value.trim() };
  const key = read('apiKey').value.trim();
  if (key) config.apiKey = key;
  if (read('clearKey').checked) config.clearKey = true;
  return config;
}

function searchProviderConfig(form) {
  const read = name => form.querySelector(`[name="search-${name}"]`);
  const config = { providerId: selectedProviderId(form, 'search'), baseUrl: read('baseUrl').value.trim() };
  if (config.providerId === 'custom') config.protocol = read('protocol').value;
  const key = read('apiKey').value.trim();
  if (key) config.apiKey = key;
  if (read('clearKey').checked) config.clearKey = true;
  return config;
}

function historyView(body) {
  body.classList.add('history-body');
  const page = el('div', { class: 'history-page' });
  page.append(el('div', { class: 'history-heading' }, el('h1', {}, '会话历史'),
    button('新建', () => navigate('paste'), { icon: 'text', class: 'secondary' })));
  const search = el('input', { type: 'search', maxlength: 1000, 'data-field': 'history-search', 'aria-label': '搜索标题、原文、截图说明或问答', placeholder: '搜索会话、原文或回答', value: historySearch, oninput: event => {
    historySearch = event.target.value;
    historyVisible = 50; void searchHistory();
  } });
  const tools = el('div', { class: 'history-tools' }, el('div', { class: 'history-toolbar' }, el('label', { class: 'history-search' }, icon('search'), search),
    button('刷新历史', () => call('refresh-history', {}, { scope: 'history' }), { icon: 'retry', iconOnly: true, class: 'icon-button', busy: 'refresh-history' })));
  const tabs = el('div', { class: 'filter-tabs', role: 'tablist', 'aria-label': '历史筛选' },
    ...[['all', '全部会话'], ['saved', '手动收藏']].map(([value, label]) => button(label, () => { historyFilter = value; historyVisible = 50; void searchHistory(); render(); }, { selected: historyFilter === value, role: 'tab' })));
  const count = el('p', { class: 'history-count', role: 'status' });
  tools.append(el('div', { class: 'history-filter-row' }, tabs, count)); page.append(tools, errorNode('history'));
  const list = el('div', { 'data-history-list': 'true' });
  page.append(list); body.append(page);
  renderHistoryList(list, count);
}

async function searchHistory() {
  renderHistoryList(root.querySelector('[data-history-list]'));
  await call('search-history', { query: historySearch, savedOnly: historyFilter === 'saved' }, { scope: 'history', lock: false, render: false });
  if (state?.view === 'history') render();
}

const historyDateFormat = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
function dateLabel(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : historyDateFormat.format(date);
}

function historyDay(value) {
  const date = new Date(value), today = new Date();
  if (Number.isNaN(date.getTime())) return { key: 'unknown', label: '时间未知' };
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const current = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const days = Math.round((current - start) / 86400000);
  return { key: `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`, label: days === 0 ? '今天' : days === 1 ? '昨天' : new Intl.DateTimeFormat('zh-CN', { ...(date.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}), month: 'long', day: 'numeric' }).format(date) };
}

function renderHistoryList(list, count = root.querySelector('.history-count')) {
  if (!list) return;
  const query = historySearch.trim().toLocaleLowerCase();
  if (state.historyQuery !== undefined && (state.historyQuery !== historySearch || state.historySavedOnly !== (historyFilter === 'saved'))) {
    if (count) count.textContent = '正在搜索…'; list.replaceChildren(); return;
  }
  const items = state.history || [];
  if (count) count.textContent = `${query ? '找到 ' : ''}${items.length} 个会话`;
  list.replaceChildren();
  if (!items.length) {
    list.append(el('div', { class: 'empty' }, el('div', { class: 'symbol' }, icon(historyFilter === 'saved' ? 'star' : 'history')), el('h2', {}, query ? '没有找到相关会话' : historyFilter === 'saved' ? '还没有收藏' : '从第一次解释开始'),
      el('p', {}, query ? '试试更短的词，或清除搜索条件。' : historyFilter === 'saved' ? '在解释窗口点星形图标，就能在这里再次找到。' : '粘贴一段文字，或框选图片。'),
      query ? button('清除搜索', () => { historySearch = ''; historyVisible = 50; const input = root.querySelector('[data-field="history-search"]'); if (input) input.value = ''; void searchHistory(); }, { class: 'secondary' }) : button('粘贴文字', () => navigate('paste'), { class: 'primary' })));
    return;
  }
  let dayKey = '';
  for (const item of items.slice(0, historyVisible)) {
    const day = historyDay(item.lastActivityAt || item.createdAt);
    if (day.key !== dayKey) { dayKey = day.key; list.append(el('h2', { class: 'history-day' }, day.label)); }
    const names = (item.modesWithMessages || []).map(value => MODE_NAMES[value]).filter(Boolean).join(' · ') || '待解释';
    const title = item.title || (item.kind === 'image' ? item.note || '截图讲解' : item.text || '文字解释');
    const summary = item.preview || (item.kind === 'image' ? item.note : item.text) || '';
    const open = button('', async () => {
      deleteId = null; renameId = null;
      await call('open-session', { id: item.id }, { scope: 'history' });
    }, { class: 'history-main', busy: 'open-session', title: `打开会话：${title}` });
    open.setAttribute('aria-label', `打开会话：${title}`);
    open.append(el('span', { class: 'history-copy' }, el('span', { class: 'history-title' }, title), summary && summary !== title ? el('span', { class: 'history-summary' }, summary) : null));
    const star = button(item.saved ? '取消收藏' : '收藏会话', () => call('favorite', { id: item.id, saved: !item.saved }, { scope: 'history' }), { icon: 'star', iconOnly: true, class: `icon-button history-star${item.saved ? ' starred' : ''}`, pressed: Boolean(item.saved), busy: 'favorite' });
    const entry = el('article', { class: 'history-item', 'data-history-id': item.id }, el('div', { class: 'history-topline' }, open, star));
    const activity = new Date(item.lastActivityAt || item.createdAt);
    const time = Number.isNaN(activity.getTime()) ? '' : new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(activity);
    entry.append(el('div', { class: 'history-bottom' }, el('span', { class: 'history-meta', title: `${names} · ${dateLabel(item.lastActivityAt || item.createdAt)}` }, `${item.sourceLabel || (item.kind === 'image' ? '截图' : '文字')}${time ? ` · ${time}` : ''}`),
      el('div', { class: 'history-actions' }, button('修改标题', () => {
        renameId = item.id; renameDraft = item.title || (item.kind === 'image' ? item.note || '截图讲解' : item.text || '文字解释'); deleteId = null; render();
        const input = root.querySelector(`[data-field="history-title-${item.id}"]`); input?.focus(); input?.select();
      }, { icon: 'edit', iconOnly: true, class: 'icon-button', busy: 'rename-session' }),
      button('移到回收站', () => { deleteId = item.id; renameId = null; render(); }, { icon: 'trash', iconOnly: true, class: 'icon-button danger' }))));
    if (renameId === item.id) {
      const title = field('会话标题', `history-title-${item.id}`, renameDraft, { limit: 200, oninput: event => { renameDraft = event.target.value; } });
      entry.append(el('form', { class: 'history-rename', onsubmit: async event => {
        event.preventDefault(); if (composing) return;
        if (!renameDraft.trim() || renameDraft.length > 200) { setError('history', '会话标题须为 1 至 200 个字符。'); return; }
        const result = await call('rename-session', { id: item.id, title: renameDraft }, { scope: 'history' });
        if (result.ok) { renameId = null; render(); }
      } }, title.wrap, el('div', { class: 'actions' },
        button('取消', () => { renameId = null; render(); }, { class: 'secondary' }),
        button('保存标题', undefined, { type: 'submit', class: 'primary', busy: 'rename-session' }))));
    }
    if (deleteId === item.id) entry.append(el('div', { class: 'delete-confirm', role: 'group', 'aria-label': '确认移到回收站' }, el('p', {}, '将此会话移到回收站？其中的回答与追问会一起移走。'), el('div', { class: 'actions' },
      button('取消', () => { deleteId = null; render(); }, { class: 'secondary' }),
      button(pending.has('delete-session') ? '正在移动…' : '确认移到回收站', async () => {
        const result = await call('delete-session', { id: item.id }, { scope: 'history' });
        if (result.ok) {
          deleteId = null;notes.delete(item.id);dirtyNotes.delete(item.id);
          for(const key of drafts.keys())if(key.startsWith(item.id+':')){drafts.delete(key);dirtyDrafts.delete(key);}
          render();
        }
      }, { class: 'secondary danger', busy: 'delete-session' }))));
    list.append(entry);
  }
  if (historyVisible < items.length) list.append(button(`加载更多（还有 ${items.length - historyVisible} 个）`, () => {
    historyVisible += 50; renderHistoryList(list);
  }, { class: 'secondary history-more' }));
}

function renderOrb() {
  // 状态推送不替换正在捕获指针的球，拖动中也能接收主题变化。
  const label = state.settings?.prefs?.orbAction === 'capture' ? '截图框选；右键打开菜单，拖动移动悬浮球' : '打开或关闭最新会话；右键打开菜单，拖动移动悬浮球';
  const existing = root.querySelector('.orb');
  if (existing) { existing.title=label;existing.setAttribute('aria-label',label);return; }
  let gesture = null, suppressClick = false, moveFrame = null, latest = null;
  let dragWork = Promise.resolve();
  const send = payload => { dragWork = dragWork.then(() => window.pickgloss.invoke('orb-drag', payload)).catch(() => ({ ok: false })); return dragWork; };
  const orb = button(label, () => {
    if (suppressClick) { suppressClick = false; return; }
    void call('orb-activate', {}, { render: false, lock: false });
  }, { class: 'orb', iconOnly: true });
  orb.append(brand());
  orb.addEventListener('contextmenu', event => {
    event.preventDefault();
    void call('menu', { source: 'orb' }, { render: false });
  });
  orb.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    suppressClick = false;
    gesture = { id: event.pointerId, x: event.screenX, y: event.screenY, dragging: false };
    orb.setPointerCapture(event.pointerId);
  });
  orb.addEventListener('pointermove', event => {
    if (!gesture || event.pointerId !== gesture.id) return;
    if (!gesture.dragging && Math.hypot(event.screenX - gesture.x, event.screenY - gesture.y) >= 5) {
      gesture.dragging = true; suppressClick = true; orb.classList.add('dragging');
      void send({ phase: 'start', x: gesture.x, y: gesture.y });
    }
    if (!gesture.dragging) return;
    orb.style.setProperty('--drag-tilt', `${Math.max(-9, Math.min(9, (event.screenX - gesture.x) * .1))}deg`);
    latest = { phase: 'move', x: event.screenX, y: event.screenY };
    if (moveFrame === null) moveFrame = requestAnimationFrame(() => { moveFrame = null; void send(latest); });
  });
  const finish = event => {
    if (!gesture || event.pointerId !== gesture.id) return;
    const current = gesture, dragging = current.dragging; gesture = null;
    if (moveFrame !== null) { cancelAnimationFrame(moveFrame); moveFrame = null; }
    orb.classList.remove('dragging');
    orb.style.removeProperty('--drag-tilt');
    if (dragging) {
      const point = event.type === 'pointerup' ? event : latest || { screenX: current.x, screenY: current.y };
      void send({ phase: 'end', x: point.screenX ?? point.x, y: point.screenY ?? point.y });
      setTimeout(() => { suppressClick = false; }, 0);
    }
    if (orb.hasPointerCapture(event.pointerId)) orb.releasePointerCapture(event.pointerId);
  };
  orb.addEventListener('pointerup', finish); orb.addEventListener('pointercancel', finish);
  orb.addEventListener('lostpointercapture', event => { if (gesture) finish(event); });
  root.replaceChildren(el('main', { class: 'orb-surface' }, orb));
}

function renderSelection() {
  const entry = button('解释选定内容', () => call('selection-open'), { class: 'selection-action', busy: 'selection-open', iconOnly: true });
  entry.append(brand({ small: true, tile: true, selection: true }));
  const previous = root.querySelector('.selection-action');
  const selectionKey = String(state?.selectionEntry || 0);
  if (previous?.dataset.selectionKey === selectionKey && !errors.get('global') && !root.querySelector('.small-error')) return;
  entry.dataset.selectionKey = selectionKey;
  root.replaceChildren(el('main', { class: 'selection-surface' }, entry, errors.get('global') ? el('p', { class: 'small-error', role: 'alert' }, errors.get('global')) : null));
}

function renderMenu() {
  const signature = JSON.stringify({ pinned: state.pinned, wide: state.wide, showOrb: state.settings?.prefs?.showOrb, selectionEnabled: state.settings?.prefs?.selectionEnabled, shortcuts: state.settings?.prefs?.shortcuts, streaming: isStreaming() });
  let menu = root.querySelector('.quick-menu');
  const focused = document.activeElement?.dataset.menuCommand;
  if (!menu || menuSignature !== signature) {
    menuSignature = signature;
    menu = el('section', { class: 'quick-menu', role: 'menu', 'aria-label': 'PickGloss 快捷菜单', tabindex: '-1' });
    const close = button('收起菜单', () => call('menu-close', { generation: menuGeneration }, { render: false }), { icon: 'close', iconOnly: true, class: 'icon-button menu-close' });
    menu.append(el('div', { class: 'quick-menu-heading' }, brand({ small: true, tile: true }), el('span', {}, 'PickGloss'), close));
    const groups = [
      [['paste', '粘贴文字', 'text'], ['capture', '截图框选', 'crop'], ['history', '会话历史', 'history']],
      [['toggle-pin', state.pinned ? '取消置顶' : '置顶窗口', 'pin', state.pinned], ['toggle-wide', state.wide ? '收回小窗' : '展开阅读视图', state.wide ? 'narrow' : 'wide']],
      [['appearance', '外观与主题', 'shirt'], ['settings', 'AI 服务', 'settings'], ['shortcuts', '快捷键', 'keyboard']],
      [['toggle-orb', state.settings?.prefs?.showOrb === false ? '显示悬浮球' : '隐藏悬浮球', 'orb'], ['toggle-selection', state.settings?.prefs?.selectionEnabled === false ? '开启划词入口' : '关闭划词入口', 'pause']],
      [...(isStreaming() ? [['stop', '停止回答', 'stop']] : []), ['quit', '退出 PickGloss', 'back']],
    ];
    for (const items of groups) {
      const group = el('div', { class: 'quick-menu-group', role: 'group' });
      for (const [command, label, glyph, checked] of items) {
        const accelerator = state.settings?.prefs?.shortcuts?.[command];
        const row = el('button', { type: 'button', class: 'quick-menu-item', role: checked === undefined ? 'menuitem' : 'menuitemcheckbox', 'aria-checked': checked, 'data-menu-command': command, onclick: async () => {
          if (menuBusy) return;
          menuBusy = true;
          const direct = { settings: 'open-settings', shortcuts: 'open-shortcuts', quit: 'quit' }[command];
          try { await call(direct || 'shortcut-command', direct ? {} : { command }, { render: false, scope: 'menu' }); }
          finally { menuBusy = false; renderMenu(); }
        } }, icon(glyph), el('span', { class: 'menu-label' }, label), accelerator ? el('kbd', {}, accelerator.replaceAll('Super', 'Win')) : null, checked ? el('span', { class: 'quick-menu-check', 'aria-hidden': 'true' }, '✓') : null);
        group.append(row);
      }
      menu.append(group);
    }
    menu.append(el('p', { class: 'quick-menu-note', role: 'alert' }, errors.get('menu') || ''));
    const layer = el('main', { class: 'menu-surface', onpointerdown: event => { if (event.target === layer) void call('menu-close', { generation: menuGeneration }, { render: false }); } }, menu);
    menu.addEventListener('keydown', event => {
      const items = [...menu.querySelectorAll('.quick-menu-item')];
      const index = items.indexOf(document.activeElement);
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); void call('menu-close', { generation: menuGeneration }, { render: false }); }
      else if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }
    });
    root.replaceChildren(layer);
    if (focused) menu.querySelector(`[data-menu-command="${focused}"]`)?.focus({ preventScroll: true });
  }
  const generation = state.status?.menuGeneration;
  const note = menu.querySelector('.quick-menu-note');
  if (note) note.textContent = errors.get('menu') || '';
  menu.style.transformOrigin = (state.status?.menuOrigin || 'top-left').replace('-', ' ');
  const reduced = document.documentElement.classList.contains('reduced-motion');
  if (generation !== undefined && generation !== menuGeneration) {
    menuGeneration = generation; menuWasOpen = false; menuAnimation?.cancel(); menu.style.opacity = '0';
  }
  const measureKey = `${generation}:${signature}:${errors.get('menu') || ''}`;
  if (generation !== undefined && menuMeasureKey !== measureKey) {
    menuMeasureKey = measureKey;
    queueMicrotask(() => {
      // 使用未缩放的内容高度，加边框和透明阴影留白，避免固定窗口高度留下大段空白。
      const height = Math.ceil(menu.scrollHeight + menu.offsetHeight - menu.clientHeight + 14);
      if (menuGeneration === generation) void call('menu-ready', { generation, height }, { lock: false, render: false });
    });
  }
  const open = state.status?.menuOpen === true;
  if (open && !menuWasOpen) {
    menuWasOpen = true; menu.style.opacity = '1'; menuAnimation?.cancel();
    if (!reduced) menuAnimation = menu.animate([{ opacity: 0, transform: 'translateY(4px) scale(.96)' }, { opacity: 1, transform: 'none' }], { duration: 170, easing: 'cubic-bezier(.16,1,.3,1)' });
    menu.querySelector('.quick-menu-item')?.focus({ preventScroll: true });
  } else if (!open && menuWasOpen) {
    menuWasOpen = false; menuAnimation?.cancel();
    const finish = () => { if (menuGeneration === generation && !state.status?.menuOpen) void call('menu-close', { generation, finished: true }, { lock: false, render: false }); };
    if (reduced) { menu.style.opacity = '0'; finish(); }
    else { menuAnimation = menu.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(3px) scale(.98)' }], { duration: 110, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards' }); void menuAnimation.finished.then(finish).catch(() => {}); }
  }
}

function renderCapture() {
  const id = state.capture?.id || null;
  const preview = state.capture?.imageData;
  const incoming = typeof preview === 'string' && /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=\r\n]+$/.test(preview) ? preview : '';
  const data = incoming || (id && id === captureId ? captureImage : '');
  if (captureId === id && captureImage === data && root.querySelector('.capture-surface')) { updateCaptureControls(); return; }
  captureId = id; captureImage = data; captureReady = false;
  const token = ++captureLoadToken;
  crop = null;
  const layer = el('main', { class: 'capture-surface', 'aria-label': '截图框选' });
  if (!data) layer.append(el('div', { class: 'capture-loading', role: 'status' }, '正在准备屏幕画面…'));
  else layer.append(el('img', { class: 'capture-image', src: data, alt: '待框选的屏幕画面', draggable: 'false' }));
  layer.append(el('div', { class: 'capture-shade' }), el('div', { class: 'crop-box', hidden: true }, el('span', { class: 'crop-size' })),
    el('div', { class: 'capture-help' }, el('span', { class: 'capture-help-message' }, '正在准备截图… · Esc 取消'), el('div', { class: 'actions' },
      button('取消', () => call('capture-cancel'), { class: 'secondary', busy: 'capture-cancel' }),
      button('完成', completeCapture, { class: 'primary', disabled: true, busy: 'capture-done' }))),
    el('div', { class: 'capture-error', role: 'alert', hidden: true }));
  layer.addEventListener('pointerdown', event => {
    if (!captureReady || !data || pending.has('capture-done') || event.button !== 0 || event.target.closest('.capture-help')) return;
    event.preventDefault();
    layer.setPointerCapture(event.pointerId);
    dragStart = capturePoint(event, layer);
    crop = { x: dragStart.x, y: dragStart.y, width: 0, height: 0 };
    captureDragging = true;
    errors.delete('capture');
    updateCaptureControls();
  });
  layer.addEventListener('pointermove', event => {
    if (!captureDragging || !dragStart) return;
    const point = capturePoint(event, layer);
    crop = { x: Math.min(point.x, dragStart.x), y: Math.min(point.y, dragStart.y), width: Math.abs(point.x - dragStart.x), height: Math.abs(point.y - dragStart.y) };
    updateCaptureControls();
  });
  layer.addEventListener('pointerup', event => {
    if (!captureDragging) return;
    captureDragging = false;
    if (layer.hasPointerCapture(event.pointerId)) layer.releasePointerCapture(event.pointerId);
    if (!crop || crop.width < 8 || crop.height < 8) { crop = null; errors.set('capture', '选区太小，请重新框选。'); }
    updateCaptureControls();
  });
  layer.addEventListener('pointercancel', () => { captureDragging = false; crop = null; updateCaptureControls(); });
  root.replaceChildren(layer);
  updateCaptureControls();
  const image = layer.querySelector('.capture-image');
  if (image && id) {
    void image.decode().then(() => {
      if (token !== captureLoadToken || captureId !== id) return;
      if (!image.naturalWidth || !image.naturalHeight) throw Error('截图预览没有有效尺寸');
      captureReady = true;
      layer.querySelector('.capture-help-message').textContent = '拖动框选，松开后确认 · Esc 取消';
      updateCaptureControls();
      return call('capture-ready', { id }, { lock: false, render: false });
    }).catch(() => {
      if (token !== captureLoadToken) return;
      void call('capture-cancel', {}, { render: false });
    });
  }
}

function capturePoint(event, layer) {
  const bounds = layer.getBoundingClientRect();
  return { x: Math.max(0, Math.min(event.clientX - bounds.left, bounds.width)), y: Math.max(0, Math.min(event.clientY - bounds.top, bounds.height)) };
}

function updateCaptureControls() {
  const box = root.querySelector('.crop-box');
  if (!box) return;
  box.hidden = !crop;
  root.querySelector('.capture-shade').hidden = Boolean(crop);
  if (crop) {
    box.style.left = `${crop.x}px`; box.style.top = `${crop.y}px`;
    box.style.width = `${crop.width}px`; box.style.height = `${crop.height}px`;
    const label = box.querySelector('.crop-size');
    label.textContent = `${Math.round(crop.width)} × ${Math.round(crop.height)}`;
    label.style.top = crop.y < 29 ? '3px' : '-27px';
  }
  const finish = root.querySelector('.capture-help .primary');
  finish.disabled = !captureReady || !crop || captureDragging || crop.width < 8 || crop.height < 8 || pending.has('capture-done');
  finish.textContent = pending.has('capture-done') ? '正在处理…' : '完成';
  const message = root.querySelector('.capture-error');
  message.textContent = errors.get('capture') || errors.get('global') || '';
  message.hidden = !message.textContent;
}

async function completeCapture() {
  if (!crop || captureDragging || pending.has('capture-done')) return;
  const rect = Object.fromEntries(Object.entries(crop).map(([key, value]) => [key, Math.round(value)]));
  await call('capture-done', { rect }, { scope: 'capture' });
}

document.addEventListener('compositionstart', () => { composing = true; justFinishedComposition = false; clearTimeout(compositionEndTimer); });
document.addEventListener('pointerdown', event => {
  const control = event.target.closest?.('button');
  if (control && (control.closest('.message.assistant') || control.title === '停止' || control.title === '停止回答')) pressedAnswerControl = control;
});
function finishAnswerPointer() {
  pressedAnswerControl = null;
  if (deferredAnswerUpdate) {
    deferredAnswerUpdate = false;
    setTimeout(() => render(), 0);
  }
}
document.addEventListener('pointerup', finishAnswerPointer);
document.addEventListener('pointercancel', finishAnswerPointer);
window.addEventListener('blur', finishAnswerPointer);
window.addEventListener('focus', () => {
  if (surface === 'panel' && state?.view === 'history') void call('refresh-history', {}, { scope: 'history', render: false }).then(() => render());
});
document.addEventListener('compositionend', event => {
  composing = false;
  // 某些输入法在 compositionend 后才派发确认候选的 Enter，此事件仍属于本次组合。
  justFinishedComposition = true;
  clearTimeout(compositionEndTimer);
  compositionEndTimer = setTimeout(() => { justFinishedComposition = false; compositionEndTimer = null; }, 0);
  if (event.target.dataset?.field === 'question') { rememberDraft(event.target); scheduleDraft(); }
  if (deferredRender) { deferredRender = false; render(); }
});
document.addEventListener('keydown', event => {
  if (event.isComposing || composing) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    if (surface === 'capture') void call('capture-cancel');
    else if (renameId !== null) { renameId = null; render(); }
    else if (deleteId !== null) { deleteId = null; render(); }
    else if (surface === 'panel') { void flushDraft().then(ok => ok && call('close')); }
  }
  if (surface === 'capture' && event.key === 'Enter' && !captureDragging) { event.preventDefault(); void completeCapture(); }
});
window.addEventListener('resize', () => {
  if (surface === 'capture' && crop) { crop = null; errors.set('capture', '画面尺寸已变化，请重新框选。'); updateCaptureControls(); }
});
window.addEventListener('pagehide', () => {
  clearTimeout(draftTimer);
  clearTimeout(compositionEndTimer);
  appearanceUI.dispose();
  shortcutsUI.dispose();
  if (typeof unsubscribe === 'function') unsubscribe();
  if (typeof unsubscribeQuit === 'function') unsubscribeQuit();
});

async function bootstrap() {
  if (!window.pickgloss?.invoke || !window.pickgloss?.onState) {
    root.replaceChildren(el('main', { class: 'app-failure' }, el('h1', {}, '无法连接PickGloss'), el('p', {}, '请从桌面应用打开此窗口。')));
    root.setAttribute('aria-busy', 'false');
    return;
  }
  if (typeof unsubscribe === 'function') unsubscribe();
  if (typeof unsubscribeQuit === 'function') unsubscribeQuit();
  unsubscribe = window.pickgloss.onState(receive);
  unsubscribeQuit = window.pickgloss.onBeforeQuit?.(flushDraft);
  const result = await call('bootstrap', {}, { render: false });
  if (result.ok && result.value) receive(result.value);
  else if (!state) {
    root.replaceChildren(el('main', { class: 'app-failure' }, el('h1', {}, 'PickGloss暂时无法打开'), el('p', { role: 'alert' }, result.error || '没有取得应用状态。'), button('重试', bootstrap, { class: 'primary' })));
    root.setAttribute('aria-busy', 'false');
  }
}

void bootstrap();
