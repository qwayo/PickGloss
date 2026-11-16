'use strict';

const { compareStableVersions, distributionFileName, isStableVersion } = require('./distribution.cjs');

const LATEST_RELEASE_API = 'https://api.github.com/repos/qwayo/PickGloss/releases/latest';
const RELEASE_PAGE = 'https://github.com/qwayo/PickGloss/releases/tag/';
const STARTUP_DELAY = 20_000;
const POLL_INTERVAL = 6 * 60 * 60 * 1000;
const REQUEST_TIMEOUT = 12_000;
const MIN_CHECK_INTERVAL = 15_000;

function readRelease(release, kind, currentVersion) {
  if (release?.draft === true || release?.prerelease === true) return { phase: 'unavailable', available: null };
  const tag = release?.tag_name;
  const version = typeof tag === 'string' && tag.startsWith('v') ? tag.slice(1) : null;
  if (!isStableVersion(version) || release.draft !== false || release.prerelease !== false || !Array.isArray(release.assets)) {
    throw new Error('发布信息格式有误。');
  }
  if (compareStableVersions(version, currentVersion) <= 0) return { phase: 'current', available: null };
  const name = distributionFileName(kind, version);
  if (!release.assets.some(asset => asset?.name === name && asset.state === 'uploaded')) {
    return { phase: 'unavailable', available: null };
  }
  return { phase: 'available', available: { version, url: `${RELEASE_PAGE}${tag}` } };
}

function retryDelay(response) {
  const retryAfter = response.headers.get('retry-after');
  const reset = response.headers.get('x-ratelimit-reset');
  if (retryAfter && /^\d+$/.test(retryAfter)) return Number(retryAfter) * 1000;
  if (retryAfter && Number.isFinite(Date.parse(retryAfter))) return Date.parse(retryAfter) - Date.now();
  if (response.headers.get('x-ratelimit-remaining') === '0' && reset && /^\d+$/.test(reset)) {
    return Number(reset) * 1000 - Date.now();
  }
  return 0;
}

function createUpdateCheck({ kind, version, fetchImpl, onChange }) {
  distributionFileName(kind, version);
  let state = { kind, version, phase: 'idle', available: null, error: '' };
  let automatic = false, closed = false, timer, pending, controller;
  let cached = null, etag = null, failures = 0, notBefore = 0;

  function update(patch) {
    state = { ...state, ...patch };
    onChange(state);
    return state;
  }

  function schedule(delay) {
    clearTimeout(timer);
    timer = null;
    if (automatic && !closed) timer = setTimeout(() => {
      timer = null;
      void check();
    }, Math.min(delay, 24 * 60 * 60 * 1000)).unref();
  }

  async function fetchRelease(signal) {
    const headers = { Accept: 'application/vnd.github+json' };
    if (etag) headers['If-None-Match'] = etag;
    const response = await fetchImpl(LATEST_RELEASE_API, { headers, signal, credentials: 'omit', redirect: 'error', cache: 'no-store' });
    if (response.status === 304 && cached) return cached;
    if (response.status === 403 || response.status === 429) {
      const error = new Error('GitHub 暂时限制检查频率。');
      error.retryAfter = retryDelay(response);
      throw error;
    }
    if (!response.ok) throw new Error(`发布信息请求失败：${response.status}`);
    const outcome = readRelease(await response.json(), kind, version);
    etag = response.headers.get('etag');
    cached = outcome;
    return outcome;
  }

  function check() {
    if (pending) return pending;
    if (closed) return Promise.resolve(state);
    const wait = notBefore - Date.now();
    if (wait > 0) {
      if (!timer) schedule(wait);
      return Promise.resolve(state);
    }
    clearTimeout(timer);
    timer = null;
    controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT)]);
    let next = POLL_INTERVAL;
    pending = fetchRelease(signal).then(outcome => {
      if (closed) return state;
      failures = 0;
      notBefore = Date.now() + MIN_CHECK_INTERVAL;
      return update({ ...outcome, error: '' });
    }).catch(error => {
      if (closed) return state;
      const backoff = Math.min(60_000 * 2 ** failures, 60 * 60 * 1000);
      failures++;
      next = Math.min(Math.max(backoff, error?.retryAfter || 0), 24 * 60 * 60 * 1000);
      notBefore = Date.now() + next;
      return update({ phase: 'error', error: error?.retryAfter !== undefined
        ? 'GitHub 暂时限制检查频率，请稍后再试。' : '暂时无法检查更新，请稍后再试。' });
    }).finally(() => { pending = null; controller = null; schedule(Math.max(next, notBefore - Date.now())); });
    update({ phase: 'checking', error: '' });
    return pending;
  }

  return {
    snapshot: () => state,
    check,
    setAutomatic(enabled) {
      if (closed || automatic === enabled) return;
      automatic = enabled;
      if (!pending) schedule(Math.max(STARTUP_DELAY, notBefore - Date.now()));
    },
    dispose() { closed = true; clearTimeout(timer); controller?.abort(); },
  };
}

module.exports = { createUpdateCheck };
