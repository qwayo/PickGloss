'use strict';

const { failure, string } = require('./validation.cjs');
const { SEARCH_PROVIDERS } = require('./services.cjs');

const SEARCH_PROVIDER_IDS = new Set(SEARCH_PROVIDERS.map(provider => provider.id));
const SEARCH_PROTOCOL_IDS = new Set(['exa', 'brave', 'deepseek']);
const MAX_QUERY_CHARS = 128;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_RESULTS = 5;
const MAX_SNIPPET_CHARS = 1600;

function endpoint(config) {
  if (!config || typeof config !== 'object') throw failure('SEARCH_NOT_CONFIGURED', '请先配置联网搜索服务。');
  const providerId = config.providerId;
  if (!SEARCH_PROVIDER_IDS.has(providerId)) throw failure('SEARCH_NOT_CONFIGURED', '请先选择联网搜索服务。');
  const protocol = providerId === 'custom' ? (config.protocol ?? 'exa') : providerId;
  if (!SEARCH_PROTOCOL_IDS.has(protocol)) throw failure('INVALID_CONFIG', '自定义搜索协议无效。');
  const baseUrl = typeof config.baseUrl === 'string' ? config.baseUrl.trim() : '';
  const apiKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : '';
  if (!baseUrl || !apiKey) throw failure('SEARCH_NOT_CONFIGURED', '请先填写搜索服务地址和 API Key。');
  if (/[\r\n]/.test(apiKey)) throw failure('INVALID_CONFIG', '搜索服务密钥格式无效。');
  let url;
  try { url = new URL(baseUrl); } catch { throw failure('INVALID_CONFIG', '搜索服务地址无效。'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase()))) {
    throw failure('INVALID_CONFIG', '搜索服务地址只允许 HTTPS；HTTP 仅允许本机地址，且不能包含凭据、查询参数或片段。');
  }
  return { providerId, protocol, url: url.toString().replace(/\/+$/, ''), apiKey };
}

function cleanText(value, max = MAX_SNIPPET_CHARS) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function safeUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return '';
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    url.hash = '';
    return url.toString();
  } catch { return ''; }
}

function cancelBody(body) {
  try { void Promise.resolve(body?.cancel?.()).catch(() => {}); } catch { /* cancellation is best effort and must not delay the original error */ }
}

function cancelReader(reader) {
  try { void Promise.resolve(reader?.cancel?.()).catch(() => {}); } catch { /* cancellation is best effort and must not delay the original error */ }
}

function candidateList(protocol, payload) {
  if (protocol === 'exa') {
    return Array.isArray(payload?.results) ? payload.results.map(item => ({
      title: item?.title,
      url: item?.url,
      snippet: Array.isArray(item?.highlights) ? item.highlights.filter(part => typeof part === 'string').join('\n') : (item?.summary || item?.text),
    })) : [];
  }
  if (protocol === 'deepseek') {
    return Array.isArray(payload?.results) ? payload.results.map(item => ({
      title: item?.title,
      url: item?.url,
      snippet: item?.content || item?.summary || item?.snippet,
    })) : [];
  }

  const metadata = payload?.sources && typeof payload.sources === 'object' ? payload.sources : {};
  const grounding = Array.isArray(payload?.grounding?.generic) ? payload.grounding.generic : [];
  return grounding.flatMap(item => {
    const url = item?.url;
    const source = typeof url === 'string' ? metadata[url] : undefined;
    const snippets = Array.isArray(item?.snippets) ? item.snippets.filter(part => typeof part === 'string').join('\n') : item?.snippet;
    const snippet = cleanText(snippets);
    // Brave 的 sources 字典只包含 URL 元数据；grounding.generic 才承载供模型阅读的正文。
    if (!snippet) return [];
    return [{
      title: item?.title || source?.title,
      url,
      snippet,
    }];
  });
}

function normalizeSources(protocol, payload) {
  const unique = new Set();
  const sources = [];
  for (const candidate of candidateList(protocol, payload)) {
    const url = safeUrl(candidate?.url);
    const title = cleanText(candidate?.title, 500);
    if (!url || !title || unique.has(url)) continue;
    unique.add(url);
    const snippet = cleanText(candidate?.snippet);
    const source = { id: sources.length + 1, title, url };
    if (snippet) source.snippet = snippet;
    sources.push(source);
    if (sources.length === MAX_RESULTS) break;
  }
  return sources;
}

async function readBody(response, wait) {
  const declaredLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    cancelBody(response.body);
    throw failure('SEARCH_FAILED', '搜索服务响应内容过大，已停止接收。');
  }
  if (response.body?.getReader) {
    let reader;
    const chunks = [];
    let length = 0;
    try {
      reader = response.body.getReader();
      while (true) {
        const { done, value } = await wait(reader.read());
        if (done) break;
        length += value.byteLength;
        if (length > MAX_RESPONSE_BYTES) throw failure('SEARCH_FAILED', '搜索服务响应内容过大，已停止接收。');
        chunks.push(Buffer.from(value));
      }
    } catch (error) {
      // 不等待 cancel()：底层连接可能永远不完成清理。
      if (reader) cancelReader(reader);
      else cancelBody(response.body);
      throw error;
    } finally {
      try { reader.releaseLock(); } catch { /* reader may already be released */ }
    }
    return Buffer.concat(chunks, length).toString('utf8');
  }
  if (typeof response.text !== 'function') {
    cancelBody(response.body);
    throw failure('SEARCH_FAILED', '搜索服务返回了无法读取的响应。');
  }
  let text;
  try { text = await wait(response.text()); }
  catch (error) { cancelBody(response.body); throw error; }
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw failure('SEARCH_FAILED', '搜索服务响应内容过大，已停止接收。');
  return text;
}

async function searchWeb({ config, query, signal, fetchImpl = globalThis.fetch, timeoutMs = 20000 } = {}) {
  const selected = endpoint(config);
  const searchQuery = string(query, '联网搜索词', 256).trim();
  const queryLength = Array.from(searchQuery).length;
  if (!searchQuery || queryLength > MAX_QUERY_CHARS) throw failure('INVALID_INPUT', `联网搜索词必须为 1 到 ${MAX_QUERY_CHARS} 个字符。`);
  if (typeof fetchImpl !== 'function') throw failure('SEARCH_FAILED', '当前环境不支持联网搜索。');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 600000) throw failure('INVALID_CONFIG', '搜索请求超时时间无效。');
  if (signal?.aborted) throw failure('ABORTED', '已取消联网搜索。');

  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(failure(signal?.aborted ? 'ABORTED' : 'TIMEOUT', signal?.aborted ? '已取消联网搜索。' : '联网搜索超时，请稍后重试。'));
  controller.signal.addEventListener('abort', onAbort, { once: true });
  const wait = promise => controller.signal.aborted ? aborted : Promise.race([promise, aborted]);

  try {
    const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
    let body;
    if (selected.protocol === 'exa') {
      headers['x-api-key'] = selected.apiKey;
      body = { query: searchQuery, type: 'auto', numResults: MAX_RESULTS, contents: { highlights: true } };
    } else if (selected.protocol === 'brave') {
      headers['X-Subscription-Token'] = selected.apiKey;
      body = { q: searchQuery, count: MAX_RESULTS, maximum_number_of_urls: MAX_RESULTS, maximum_number_of_tokens: 2048 };
    } else {
      headers.Authorization = `Bearer ${selected.apiKey}`;
      body = { query: searchQuery, count: MAX_RESULTS, need_content: true };
    }
    const response = await wait(fetchImpl(selected.url, {
      method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal, redirect: 'error',
    }));
    if (!response?.ok) {
      void Promise.resolve(response?.body?.cancel?.()).catch(() => {});
      throw failure('SEARCH_FAILED', `搜索服务请求失败（HTTP ${Number(response?.status) || '未知'}），请检查配置或稍后重试。`);
    }
    const raw = await readBody(response, wait);
    let payload;
    try { payload = JSON.parse(raw); } catch { throw failure('SEARCH_FAILED', '搜索服务返回了无法识别的内容。'); }
    const sources = normalizeSources(selected.protocol, payload);
    if (!sources.length) throw failure('SEARCH_EMPTY', '搜索服务没有返回可用来源。');
    return sources;
  } catch (error) {
    if (controller.signal.aborted) throw failure(signal?.aborted ? 'ABORTED' : 'TIMEOUT', signal?.aborted ? '已取消联网搜索。' : '联网搜索超时，请稍后重试。');
    if (['SEARCH_FAILED', 'SEARCH_EMPTY', 'SEARCH_NOT_CONFIGURED', 'INVALID_CONFIG', 'INVALID_INPUT'].includes(error?.code)) throw error;
    throw failure('SEARCH_FAILED', '无法完成联网搜索，请检查网络和服务配置。');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', onAbort);
  }
}

module.exports = { searchWeb, normalizeSources };
