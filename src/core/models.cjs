'use strict';

const { normalizeConfig } = require('./provider.cjs');
const { failure } = require('./validation.cjs');

// 模型发现独立于连通测试；列表只表示接口公开的模型 ID，不推断模型能力。
async function listModels({ config, fetchImpl = globalThis.fetch, timeoutMs = 15000 }) {
  const endpoint = normalizeConfig({ ...config, model: '模型列表' });
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60000) throw failure('INVALID_CONFIG', '获取模型的超时时间无效。');
  const controller = new AbortController();
  let reader, rejectTimeout;
  const timedOut = new Promise((_, reject) => { rejectTimeout = reject; });
  const timer = setTimeout(() => {
    rejectTimeout(failure('TIMEOUT', '获取模型超时，请稍后重试，或手动填写模型名称。'));
    controller.abort();
    void reader?.cancel().catch(() => {});
  }, timeoutMs);
  const wait = promise => Promise.race([promise, timedOut]);
  try {
    const response = await wait(fetchImpl(`${endpoint.baseUrl}/models`, {
      method: 'GET', redirect: 'error', signal: controller.signal,
      headers: { Accept: 'application/json', ...(endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {}) },
    }));
    if (!response.ok) throw failure('HTTP_ERROR', `获取模型失败（HTTP ${response.status}），请检查地址与密钥；服务也可能不支持模型列表，可手动填写。`);
    reader = response.body?.getReader();
    if (!reader) throw failure('INVALID_RESPONSE', '服务未返回模型列表，请手动填写模型名称。');
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await wait(reader.read());
      if (done) break;
      size += value.byteLength;
      if (size > 2 * 1024 * 1024) throw failure('RESPONSE_TOO_LARGE', '模型列表过大，请手动填写模型名称。');
      chunks.push(Buffer.from(value));
    }
    let data;
    try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw failure('INVALID_RESPONSE', '服务返回的模型列表格式无效，请手动填写模型名称。'); }
    if (!Array.isArray(data?.data) || data.data.length > 10000) throw failure('INVALID_RESPONSE', '服务未提供兼容的模型列表，请手动填写模型名称。');
    const models = [...new Set(data.data.map(item => item?.id).filter(id => typeof id === 'string' && id.trim() && id.length <= 300 && !/[\u0000-\u001f]/.test(id)).map(id => id.trim()))].sort();
    if (models.length > 3000) throw failure('RESPONSE_TOO_LARGE', '可选模型数量过多，请手动填写模型名称。');
    return { models };
  } catch (error) {
    if (['HTTP_ERROR', 'INVALID_RESPONSE', 'RESPONSE_TOO_LARGE', 'TIMEOUT'].includes(error.code)) throw error;
    throw failure(controller.signal.aborted ? 'TIMEOUT' : 'NETWORK_ERROR', controller.signal.aborted ? '获取模型超时，请稍后重试。' : '无法获取模型列表，请检查网络与服务地址，或手动填写模型名称。');
  } finally { clearTimeout(timer); void reader?.cancel().catch(() => {}); }
}

module.exports = { listModels };
