// 各设置字段合并编辑、串行落盘；旧响应不能盖掉更新的输入状态。
export function createSettingsAutosave({ persist, changed = () => {}, delay = 450 }) {
  const pending = new Map(), versions = new Map(), states = new Map(), failures = new Map(), waiters = new Map();
  let work = null, flushWork = null, flushing = false, disposed = false, sequence = 0;
  const publish = (key, value) => { states.set(key, value); if (!disposed) changed(key, value); };
  const status = key => states.get(key) || { status: 'idle', message: '' };
  const summary = () => {
    const values = [...states.values()];
    if (values.some(value => value.status === 'error')) return '部分更改未保存';
    if (values.some(value => ['pending', 'saving'].includes(value.status))) return '正在自动保存…';
    return values.length ? '已自动保存' : '更改自动保存';
  };
  function resolveThrough(key, version, result) {
    const entries = waiters.get(key) || [];
    entries.filter(item => item.version <= version).forEach(item => item.resolve(result));
    waiters.set(key, entries.filter(item => item.version > version));
  }
  function drain() {
    if (work) return work;
    work = (async () => {
      while (!disposed) {
        const job = [...pending.values()].filter(item => item.ready).sort((a, b) => a.order - b.order)[0];
        if (!job) break;
        pending.delete(job.key);
        if (versions.get(job.key) === job.version) publish(job.key, { status: 'saving', message: '正在保存…' });
        let result;
        try { result = await persist(typeof job.payload === 'function' ? job.payload() : job.payload); }
        catch (error) { result = { ok: false, error: error?.message || '自动保存失败，请重试。' }; }
        if (!result?.ok) result = { ok: false, error: result?.error || '自动保存失败，请重试。' };
        if (versions.get(job.key) === job.version) {
          if (result.ok) { failures.delete(job.key); publish(job.key, { status: 'saved', message: '已自动保存' }); }
          else { failures.set(job.key, job); publish(job.key, { status: 'error', message: result.error }); }
        }
        resolveThrough(job.key, job.version, result);
      }
    })().finally(() => { work = null; if (!disposed && [...pending.values()].some(item => item.ready)) void drain(); });
    return work;
  }
  function schedule(key, payload, { immediate = false } = {}) {
    if (disposed) return Promise.resolve({ ok: false, error: '设置窗口已关闭。' });
    const previous = pending.get(key);
    if (previous?.timer) clearTimeout(previous.timer);
    const version = (versions.get(key) || 0) + 1; versions.set(key, version); failures.delete(key);
    const job = { key, payload, version, order: ++sequence, ready: immediate || flushing, timer: null };
    pending.set(key, job); publish(key, { status: 'pending', message: '等待保存…' });
    const result = new Promise(resolve => { const entries = waiters.get(key) || []; entries.push({ version, resolve }); waiters.set(key, entries); });
    if (job.ready) void drain();
    else job.timer = setTimeout(() => { job.timer = null; job.ready = true; void drain(); }, delay);
    return result;
  }
  function flush() {
    if (flushWork) return flushWork;
    flushing = true;
    flushWork = (async () => {
      do {
        for (const job of pending.values()) { clearTimeout(job.timer); job.timer = null; job.ready = true; }
        await drain();
      } while (!disposed && pending.size);
      return failures.size === 0;
    })().finally(() => { flushing = false; flushWork = null; });
    return flushWork;
  }
  function retry(key) { const failed = failures.get(key); return failed ? schedule(key, failed.payload, { immediate: true }) : Promise.resolve({ ok: true }); }
  function expedite(key) {
    const job = pending.get(key);
    if (job) { clearTimeout(job.timer); job.timer = null; job.ready = true; void drain(); }
  }
  function discardFailure(key) {
    if (!failures.has(key) || status(key).status !== 'error') return false;
    failures.delete(key); publish(key, { status: 'idle', message: '' }); return true;
  }
  function dispose() {
    disposed = true;
    for (const job of pending.values()) { clearTimeout(job.timer); resolveThrough(job.key, job.version, { ok: false, error: '设置窗口已关闭。' }); }
    pending.clear();
  }
  return { schedule, commit: (key, payload) => schedule(key, payload, { immediate: true }), flush, retry, status, summary,
    failedKeys: () => [...failures.keys()], discardFailure, expedite, dispose };
}
