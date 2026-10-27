'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { listModels } = require('../../src/core/models.cjs');

test('按当前地址和密钥获取模型，兼容完整聊天端点、去重排序且无需已有模型', async () => {
  const requests = [];
  const result = await listModels({ config: { baseUrl: 'https://example.com/v1/chat/completions/', apiKey: '测试用密钥' },
    fetchImpl: async (url, options) => { requests.push({ url, options }); return Response.json({ data: [{ id: 'z' }, { id: 'a' }, { id: 'a' }, { id: '' }, { id: 4 }] }); } });
  assert.deepEqual(result.models, ['a', 'z']);
  assert.equal(requests[0].url, 'https://example.com/v1/models');
  assert.equal(requests[0].options.method, 'GET');
  assert.equal(requests[0].options.redirect, 'error');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer 测试用密钥');
  assert.equal(requests[0].options.body, undefined);
});

test('获取模型拒绝不安全地址且错误不转发服务原文', async () => {
  let requests = 0;
  const fetchImpl = async () => { requests++; return new Response('敏感响应不得泄漏', { status: 401 }); };
  await assert.rejects(listModels({ config: { baseUrl: 'http://remote.example' }, fetchImpl }), /HTTPS/);
  assert.equal(requests, 0);
  await assert.rejects(listModels({ config: { baseUrl: 'https://example.com' }, fetchImpl }), error => error.code === 'HTTP_ERROR' && !error.message.includes('敏感响应'));
  await assert.rejects(listModels({ config: { baseUrl: 'https://example.com' }, fetchImpl: async () => { const error = new Error('不得泄漏的请求细节'); error.code='ENOTFOUND'; throw error; } }), error => error.code === 'NETWORK_ERROR' && !error.message.includes('细节'));
});

test('模型列表对无响应、正文挂起和过大响应有确定的终止边界', async () => {
  const config = { baseUrl: 'http://127.0.0.1/v1' };
  await assert.rejects(listModels({ config, timeoutMs: 20, fetchImpl: () => new Promise(() => {}) }), { code: 'TIMEOUT' });
  await assert.rejects(listModels({ config, timeoutMs: 20, fetchImpl: async () => new Response(new ReadableStream({ start() {} })) }), { code: 'TIMEOUT' });
  await assert.rejects(listModels({ config, fetchImpl: async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)) }), { code: 'RESPONSE_TOO_LARGE' });
});
