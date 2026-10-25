'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { searchWeb } = require('../../src/core/search.cjs');
const { SEARCH_PROVIDERS } = require('../../src/core/services.cjs');

const key = 'search-test-secret-do-not-leak';

test('三家搜索服务使用各自官方端点、认证头和请求体，统一返回可引用来源', async () => {
  const cases = [
    {
      providerId: 'exa',
      body: { results: [
        { title: 'Exa 来源', url: 'https://example.com/a#top', highlights: ['Exa 摘录'] },
        { title: '重复来源', url: 'https://example.com/a', highlights: ['重复'] },
        { title: '不安全来源', url: 'javascript:alert(1)', highlights: ['跳过'] },
      ] },
      checkRequest({ url, options }) {
        assert.equal(url, SEARCH_PROVIDERS.find(item => item.id === 'exa').baseUrl);
        assert.equal(options.headers['x-api-key'], key);
        assert.equal(options.headers.Authorization, undefined);
        assert.deepEqual(JSON.parse(options.body), { query: 'MiMo 模型更新', type: 'auto', numResults: 5, contents: { highlights: true } });
      },
      expected: [{ id: 1, title: 'Exa 来源', url: 'https://example.com/a', snippet: 'Exa 摘录' }],
    },
    {
      providerId: 'brave',
      body: { grounding: { generic: [
        { title: 'Brave 来源', url: 'https://brave.example/page', snippets: ['Brave 摘录'] },
      ] }, sources: { 'https://brave.example/page': { title: 'Brave 来源' } } },
      checkRequest({ url, options }) {
        assert.equal(url, SEARCH_PROVIDERS.find(item => item.id === 'brave').baseUrl);
        assert.equal(options.headers['X-Subscription-Token'], key);
        assert.equal(options.headers.Authorization, undefined);
        assert.deepEqual(JSON.parse(options.body), { q: 'MiMo 模型更新', count: 5, maximum_number_of_urls: 5, maximum_number_of_tokens: 2048 });
      },
      expected: [{ id: 1, title: 'Brave 来源', url: 'https://brave.example/page', snippet: 'Brave 摘录' }],
    },
    {
      providerId: 'deepseek',
      body: { results: [{ title: 'DeepSeek 来源', url: 'https://ds.example/article', content: 'DeepSeek 正文' }] },
      checkRequest({ url, options }) {
        assert.equal(url, SEARCH_PROVIDERS.find(item => item.id === 'deepseek').baseUrl);
        assert.equal(options.headers.Authorization, `Bearer ${key}`);
        assert.equal(options.headers['x-api-key'], undefined);
        assert.deepEqual(JSON.parse(options.body), { query: 'MiMo 模型更新', count: 5, need_content: true });
      },
      expected: [{ id: 1, title: 'DeepSeek 来源', url: 'https://ds.example/article', snippet: 'DeepSeek 正文' }],
    },
  ];

  for (const item of cases) {
    let calls = 0;
    const sources = await searchWeb({ config: { ...SEARCH_PROVIDERS.find(provider => provider.id === item.providerId), providerId: item.providerId, apiKey: key }, query: 'MiMo 模型更新',
      fetchImpl: async (url, options) => {
        calls++;
        assert.equal(options.method, 'POST');
        assert.equal(options.redirect, 'error');
        item.checkRequest({ url, options });
        return Response.json(item.body);
      } });
    assert.equal(calls, 1);
    assert.deepEqual(sources, item.expected);
  }
});

test('自定义搜索服务按所选协议复用现有请求与响应适配', async () => {
  assert.deepEqual(SEARCH_PROVIDERS.find(item => item.id === 'custom'), {
    id: 'custom', name: '自定义', protocol: 'exa', baseUrl: '', keyUrl: '',
  });
  const cases = [
    {
      protocol: 'exa',
      response: { results: [{ title: 'Exa 兼容来源', url: 'https://example.com/exa', highlights: ['摘录'] }] },
      check({ options }) {
        assert.equal(options.headers['x-api-key'], key);
        assert.deepEqual(JSON.parse(options.body), { query: '自定义测试', type: 'auto', numResults: 5, contents: { highlights: true } });
      },
      title: 'Exa 兼容来源',
    },
    {
      protocol: 'brave',
      response: { grounding: { generic: [{ title: 'Brave 兼容来源', url: 'https://example.com/brave', snippets: ['摘录'] }] }, sources: {} },
      check({ options }) {
        assert.equal(options.headers['X-Subscription-Token'], key);
        assert.deepEqual(JSON.parse(options.body), { q: '自定义测试', count: 5, maximum_number_of_urls: 5, maximum_number_of_tokens: 2048 });
      },
      title: 'Brave 兼容来源',
    },
    {
      protocol: 'deepseek',
      response: { results: [{ title: 'DeepSeek 兼容来源', url: 'https://example.com/deepseek', content: '摘录' }] },
      check({ options }) {
        assert.equal(options.headers.Authorization, `Bearer ${key}`);
        assert.deepEqual(JSON.parse(options.body), { query: '自定义测试', count: 5, need_content: true });
      },
      title: 'DeepSeek 兼容来源',
    },
  ];

  for (const item of cases) {
    let calls = 0;
    const sources = await searchWeb({
      config: { providerId: 'custom', protocol: item.protocol, baseUrl: 'https://search.example.test/api/search', apiKey: key },
      query: '自定义测试',
      fetchImpl: async (url, options) => {
        calls++;
        assert.equal(url, 'https://search.example.test/api/search');
        assert.equal(options.method, 'POST');
        item.check({ options });
        return Response.json(item.response);
      },
    });
    assert.equal(calls, 1);
    assert.deepEqual(sources, [{ id: 1, title: item.title, url: `https://example.com/${item.protocol}`, snippet: '摘录' }]);
  }
});

test('自定义搜索协议默认使用 Exa 适配，预设忽略外来协议，非法协议不发请求', async () => {
  let requests = 0;
  const fetchImpl = async (_url, options) => {
    requests++;
    assert.equal(options.headers['x-api-key'], key);
    return Response.json({ results: [{ title: '兼容来源', url: 'https://example.com', highlights: ['摘录'] }] });
  };
  await searchWeb({ config: { providerId: 'custom', baseUrl: 'https://search.example.test', apiKey: key }, query: '默认协议', fetchImpl });
  await searchWeb({ config: { providerId: 'exa', protocol: 'deepseek', baseUrl: 'https://exa.example.test', apiKey: key }, query: '固定协议', fetchImpl });
  assert.equal(requests, 2);
  await assert.rejects(searchWeb({ config: { providerId: 'custom', protocol: 'other', baseUrl: 'https://search.example.test', apiKey: key }, query: '无效协议', fetchImpl }), { code: 'INVALID_CONFIG' });
  assert.equal(requests, 2);
});

test('查询配置、取消、超时、空结果和错误响应有稳定错误码且不泄露密钥', async () => {
  const config = { providerId: 'deepseek', baseUrl: 'https://api.deepseek.com/v1/tools/search', apiKey: key };
  let calls = 0;
  await assert.rejects(searchWeb({ config: { ...config, apiKey: '' }, query: '问题', fetchImpl: async () => { calls++; } }), { code: 'SEARCH_NOT_CONFIGURED' });
  await assert.rejects(searchWeb({ config, query: '字'.repeat(129), fetchImpl: async () => { calls++; } }), { code: 'INVALID_INPUT' });
  assert.equal(calls, 0);

  const canceled = new AbortController(); canceled.abort();
  await assert.rejects(searchWeb({ config, query: '问题', signal: canceled.signal, fetchImpl: async () => { calls++; } }), { code: 'ABORTED' });
  await assert.rejects(searchWeb({ config, query: '问题', timeoutMs: 10, fetchImpl: () => new Promise(() => {}) }), { code: 'TIMEOUT' });
  await assert.rejects(searchWeb({ config, query: '问题', fetchImpl: async () => Response.json({ results: [] }) }), { code: 'SEARCH_EMPTY' });

  for (const fetchImpl of [
    async () => new Response(`上游私密内容 ${key}`, { status: 401 }),
    async () => new Response('无法解析', { headers: { 'Content-Type': 'application/json' } }),
    async () => { throw new Error(`内部网络异常 ${key}`); },
  ]) {
    await assert.rejects(searchWeb({ config, query: '问题', fetchImpl }), error => {
      assert.equal(error.code, 'SEARCH_FAILED');
      assert.equal(error.message.includes(key), false);
      assert.equal(error.message.includes('上游私密内容'), false);
      assert.equal(error.stack.includes(key), false);
      return true;
    });
  }
});

test('搜索响应有字节上限，接口返回的网页来源去重并拒绝非 HTTP 地址', async () => {
  const config = { providerId: 'exa', baseUrl: 'https://api.exa.ai/search', apiKey: key };
  await assert.rejects(searchWeb({ config, query: '来源大小', fetchImpl: async () => new Response('x'.repeat(1024 * 1024 + 1)) }), { code: 'SEARCH_FAILED' });
  const sources = await searchWeb({ config, query: '去重', fetchImpl: async () => Response.json({ results: [
    { title: '同一来源', url: 'https://example.com/page', highlights: ['第一条'] },
    { title: '重复来源', url: 'https://example.com/page#part', highlights: ['第二条'] },
    { title: '不安全来源', url: 'file:///private', highlights: ['不应保留'] },
  ] }) });
  assert.deepEqual(sources, [{ id: 1, title: '同一来源', url: 'https://example.com/page', snippet: '第一条' }]);
});

test('Brave 没有 grounding.generic 正文时，即使 sources 有元数据也报告无结果', async () => {
  const config = { providerId: 'brave', baseUrl: 'https://api.search.brave.com/res/v1/llm/context', apiKey: key };
  await assert.rejects(searchWeb({ config, query: '无正文', fetchImpl: async () => Response.json({
    grounding: { generic: [] },
    sources: { 'https://example.com/page': { title: '只有元数据', description: '没有提取正文' } },
  }) }), { code: 'SEARCH_EMPTY' });
});

test('响应大小、超时与读取异常时取消 body 或 reader，且不等待无响应的 cancel', async () => {
  const config = { providerId: 'exa', baseUrl: 'https://api.exa.ai/search', apiKey: key };
  let bodyCanceled = 0;
  await assert.rejects(searchWeb({ config, query: '声明过大', fetchImpl: async () => ({
    ok: true,
    headers: { get: name => name === 'content-length' ? String(2 * 1024 * 1024) : null },
    body: { cancel() { bodyCanceled++; return Promise.resolve(); } },
  }) }), { code: 'SEARCH_FAILED' });
  assert.equal(bodyCanceled, 1);

  let readerCanceled = 0;
  await assert.rejects(searchWeb({ config, query: '读取超时', timeoutMs: 15, fetchImpl: async () => ({
    ok: true,
    headers: { get: () => null },
    body: { getReader: () => ({
      read: () => new Promise(() => {}),
      cancel() { readerCanceled++; return new Promise(() => {}); },
      releaseLock() {},
    }) },
  }) }), { code: 'TIMEOUT' });
  assert.equal(readerCanceled, 1);

  let erroredReaderCanceled = 0;
  await assert.rejects(searchWeb({ config, query: '读取错误', fetchImpl: async () => ({
    ok: true,
    headers: { get: () => null },
    body: { getReader: () => ({
      read: async () => { throw new Error('reader 内部错误'); },
      cancel() { erroredReaderCanceled++; return Promise.resolve(); },
      releaseLock() {},
    }) },
  }) }), { code: 'SEARCH_FAILED' });
  assert.equal(erroredReaderCanceled, 1);
});

test('搜索查询按 Unicode 码点计数，最多 128 个补充平面字符可合法发送', async () => {
  const config = { providerId: 'deepseek', baseUrl: 'https://api.deepseek.com/v1/tools/search', apiKey: key };
  const query = '𠮷'.repeat(128);
  let sent;
  await searchWeb({ config, query, fetchImpl: async (_url, options) => {
    sent = JSON.parse(options.body).query;
    return Response.json({ results: [{ title: '结果', url: 'https://example.com', snippet: '摘录' }] });
  } });
  assert.equal(sent, query);
});
