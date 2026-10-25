'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isSourceIconProxyUrl, createSourceIconProxy } = require('../../src/core/source-icon-proxy.cjs');

const GOOGLE = 'https://www.google.com/s2/favicons?domain=juejin.cn&sz=64';
const CDN = 'https://www.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&url=https%3A%2F%2Fjuejin.cn&size=64';

test('图标会话仅接纳固定服务及已知图标 CDN 路径', () => {
  for (const url of [GOOGLE, CDN, 'https://t2.gstatic.com/faviconV2?url=https://github.com/', 'https://icons.duckduckgo.com/ip3/www.baidu.com.ico']) {
    assert.equal(isSourceIconProxyUrl(url), true, url);
  }
  for (const url of [
    'http://www.google.com/s2/favicons?domain=juejin.cn&sz=64',
    'https://www.google.com:444/s2/favicons?domain=juejin.cn&sz=64',
    'https://user:pass@www.google.com/s2/favicons?domain=juejin.cn&sz=64',
    'https://www.google.com/s2/favicons?domain=127.0.0.1&sz=64',
    'https://www.google.com/s2/favicons?domain=printer.local&sz=64',
    GOOGLE + '&domain=localhost', GOOGLE + '&apiKey=不可携带',
    'https://icons.duckduckgo.com/ip3/foo.ico?url=https://localhost/',
    'https://icons.duckduckgo.com/ip3/127.0.0.1.ico',
    'https://www.gstatic.com/other?url=https://juejin.cn/',
    'https://other.gstatic.com/faviconV2?url=https://juejin.cn/',
    'https://www.gstatic.com/faviconV2?url=https://juejin.cn/private/article',
    'https://www.gstatic.com/faviconV2?url=https://127.0.0.1/',
    'https://evil.example/favicon.ico', 'file:///favicon.ico',
  ]) assert.equal(isSourceIconProxyUrl(url), false, url);
});

test('每跳网络守卫拦截陌生跳转，强制匿名 GET 且保留取消信号', async () => {
  let guard, request;
  const session = {
    webRequest: { onBeforeRequest(filter, handler) { assert.deepEqual(filter.urls, ['<all_urls>']); guard = handler; } },
    async fetch(url, options) { request = { url, options }; return { url: CDN }; },
  };
  const fetchIcon = createSourceIconProxy(session);
  const controller = new AbortController();
  await fetchIcon(GOOGLE, { redirect: 'follow', signal: controller.signal, headers: { Authorization: '不可携带' }, credentials: 'include' });
  assert.equal(request.options.credentials, 'omit');
  assert.equal(request.options.method, 'GET');
  assert.equal(request.options.referrerPolicy, 'no-referrer');
  assert.equal(request.options.signal, controller.signal);
  assert.equal(request.options.headers.Authorization, undefined);
  assert.equal(request.options.redirect, 'follow');
  for (const [url, cancel] of [[CDN, false], ['https://127.0.0.1/favicon.ico', true], ['https://evil.example/favicon.ico', true]]) {
    let result; guard({ url }, value => { result = value; });
    assert.equal(result.cancel, cancel);
  }
  await assert.rejects(fetchIcon('https://evil.example/favicon.ico'), /地址无效/);
  session.fetch = async () => ({ url: 'https://evil.example/favicon.ico' });
  await assert.rejects(fetchIcon(GOOGLE), /跳转地址无效/);
  session.fetch = async () => ({ url: '', status: 200 });
  assert.equal((await fetchIcon(GOOGLE)).status, 200, 'Electron 返回空响应地址时仍由逐跳守卫保证来源');
});
