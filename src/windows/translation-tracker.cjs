'use strict';
const { createTranslationSource } = require('./translation-source.cjs');

// 窗口归属与页面归属分别判断；只有两者都确认匹配时才恢复覆盖。
function createTranslationTracker({ onChange = () => {}, windowFactory = createTranslationSource, browserFactory, ...options } = {}) {
  let disposed = false, sequence = 0, captureGeneration = 0, bound = null, pending = null, prepared = null;
  const entries = new Map();
  const windows = windowFactory({ ...options, onChange: windowChanged });
  if (!windows) return null;

  function release(entry) {
    if (!entry || entry.closed) return;
    entry.closed = true; entries.delete(entry.key);
    try { entry.client?.dispose(); } catch { /* 已失效的观察器不能阻止释放其余窗口。 */ }
    if (pending === entry) pending = null;
  }
  function emit() {
    const current = bound;
    if (disposed || !current || !current.windowState || !current.binding) return;
    let state = current.windowState;
    if (state === 'active' && current.browserRequired) {
      const page = current.page;
      state = !page || !page.sealed || page.state === 'invalid' || page.state === 'inactive' && page.reason === 'unknown' ? 'context-invalid'
        : page.state === 'active' ? 'active' : 'inactive';
    }
    const signature = `${state}:${current.windowState === 'active'}`;
    if (signature === current.emitted) return;
    current.emitted = signature;
    onChange({ binding: current.binding, state, windowActive: current.windowState === 'active' });
  }
  function windowChanged(value) {
    if (!bound || disposed) return;
    if (bound.binding === null) { queueMicrotask(() => windowChanged(value)); return; }
    if (value.binding !== bound.binding) return;
    bound.windowState = value.state; emit();
  }
  function pageChanged(entry, value) {
    if (disposed || entry.closed || entry.state === 'invalid') return;
    if (!['active', 'inactive', 'invalid'].includes(value.state)) return;
    if (value.state !== 'invalid' && (!Number.isSafeInteger(value.revision) || value.revision < 0)) { invalidate(entry); return; }
    if (value.state === 'invalid') { invalidate(entry); return; }
    entry.state = value.state;
    entry.reason = value.reason === 'tab' || value.reason === 'window' ? value.reason : 'unknown';
    if (Number.isSafeInteger(value.revision)) entry.revision = value.revision;
    if (bound?.page === entry) emit();
  }
  function ticket(source) {
    const key = source?.pageContext?.key;
    const entry = Number.isSafeInteger(key) ? entries.get(key) : null;
    return entry && !entry.closed && entry.handle === source.handle && entry.pid === source.pid ? entry : null;
  }
  function invalidate(entry) {
    if (!entry || entry.closed) return;
    entry.state = 'invalid';
    try { entry.client?.invalidate?.(entry.localKey); } catch { /* 保持失效状态。 */ }
    try { entry.client?.dispose(); } catch { /* 不再复用此观察器。 */ }
    if (bound?.page === entry) emit();
  }

  return {
    prepare() {
      if (disposed || prepared) return;
      const slot = { client: null, entry: null };
      try {
        const factory = browserFactory || require('./browser-context.cjs').createBrowserContext;
        slot.client = factory({ onChange: value => { if (slot.entry) pageChanged(slot.entry, value); } });
        if (!slot.client?.prepare) { slot.client?.dispose(); return; }
        slot.client.prepare(); prepared = slot;
      } catch { slot.client?.dispose(); }
    },
    async capture() {
      if (disposed) return null;
      const generation = ++captureGeneration;
      if (pending && pending !== bound?.page) release(pending);
      const source = await windows.capture();
      if (disposed || generation !== captureGeneration) return null;
      if (!source || source.browserContextRequired !== true) return source;
      const entry = { key: ++sequence, handle: source.handle, pid: source.pid, state: 'inactive', reason: 'unknown', revision: 0,
        captureRevision: null, localKey: null, sealed: false, closed: false, client: null };
      entries.set(entry.key, entry); pending = entry;
      try {
        if (prepared) { const slot = prepared; prepared = null; slot.entry = entry; entry.client = slot.client; }
        else {
          const factory = browserFactory || require('./browser-context.cjs').createBrowserContext;
          entry.client = factory({ onChange: value => pageChanged(entry, value) });
        }
        const page = await entry.client?.capture(source);
        if (Number.isSafeInteger(page?.key) && page.key > 0) entry.localKey = page.key;
        if (!page || entry.closed || disposed || entry.state === 'invalid' || page.state !== 'active'
          || !Number.isSafeInteger(page.key) || page.key < 1 || !Number.isSafeInteger(page.revision) || page.revision < 0) invalidate(entry);
        else {
          entry.state = 'active'; entry.reason = 'tab'; entry.revision = page.revision;
          entry.captureRevision = page.revision;
        }
      } catch { invalidate(entry); }
      if (disposed || entry.closed || generation !== captureGeneration) { release(entry); return null; }
      return { ...source, pageContext: { key: entry.key } };
    },
    async sealCapture(source) {
      if (source?.browserContextRequired !== true) return true;
      const entry = ticket(source);
      if (!entry || entry.state === 'invalid' || entry.captureRevision === null) return false;
      try {
        const checked = await entry.client.checkpoint(entry.localKey);
        if (disposed || entry.closed || entry.state === 'invalid' || checked?.state !== 'active'
          || checked.revision !== entry.captureRevision || entry.revision !== checked.revision) {
          invalidate(entry); return false;
        }
        entry.state = 'active'; entry.revision = checked.revision; entry.sealed = true; return true;
      } catch { invalidate(entry); return false; }
    },
    cancelCapture(source) {
      const entry = ticket(source);
      if (!source) { captureGeneration++; if (pending && pending !== bound?.page) release(pending); }
      else if (entry && entry !== bound?.page) { if (entry === pending) captureGeneration++; release(entry); }
    },
    bind(source, surfaces) {
      if (disposed) return null;
      const page = ticket(source), previous = bound?.page;
      if (previous && previous !== page) release(previous);
      bound = { binding: null, browserRequired: source?.browserContextRequired === true, page, windowState: null, emitted: '' };
      const binding = windows.bind(source, surfaces);
      if (!binding) { bound = null; return null; }
      bound.binding = binding;
      if (pending === page) pending = null;
      return binding;
    },
    restore(source, request) { return windows.restore(source, request); },
    clear() {
      const previous = bound?.page; bound = null; windows.clear(); release(previous);
    },
    dispose() {
      if (disposed) return;
      disposed = true; captureGeneration++; bound = null; pending = null;
      for (const entry of [...entries.values()]) release(entry);
      prepared?.client?.dispose(); prepared = null;
      windows.dispose();
    },
  };
}
module.exports = { createTranslationTracker };
