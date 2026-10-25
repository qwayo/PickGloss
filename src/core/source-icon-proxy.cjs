'use strict';

const net = require('node:net');

function publicHostname(value) {
  if (typeof value !== 'string' || value.length > 253 || net.isIP(value)) return false;
  return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*$/i.test(value) &&
    !/\.(?:localhost|local|internal|home|lan|test|invalid|onion)$/i.test(value);
}

function isSourceIconProxyUrl(value) {
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return false;
  if (url.hostname === 'icons.duckduckgo.com') {
    const match = /^\/ip3\/([^/]+)\.ico$/.exec(url.pathname);
    return Boolean(match && publicHostname(match[1]) && !url.search);
  }
  if (url.hostname === 'www.google.com' && url.pathname === '/s2/favicons') {
    const keys = [...url.searchParams.keys()];
    return keys.length === 2 && new Set(keys).size === 2 && keys.every(key => ['domain', 'sz'].includes(key)) &&
      publicHostname(url.searchParams.get('domain')) && ['32', '64'].includes(url.searchParams.get('sz'));
  }
  if (/^(?:www|t[0-3])\.gstatic\.com$/.test(url.hostname) && url.pathname === '/faviconV2') {
    let source;
    try { source = new URL(url.searchParams.get('url')); } catch { return false; }
    return ['https:', 'http:'].includes(source.protocol) && !source.username && !source.password && !source.port &&
      publicHostname(source.hostname) && source.pathname === '/' && !source.search && !source.hash;
  }
  return false;
}

function createSourceIconProxy(iconSession) {
  // 限制独立会话的每一跳，而非只检查 fetch 的首个地址；不执行来源网页或其脚本。
  iconSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    callback({ cancel: !isSourceIconProxyUrl(details.url) });
  });
  return async (url, options = {}) => {
    if (!isSourceIconProxyUrl(url)) throw new Error('图标服务地址无效。');
    const response = await iconSession.fetch(url, {
      method: 'GET', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
      redirect: options.redirect === 'follow' ? 'follow' : 'error',
      headers: { Accept: 'image/png,image/x-icon,image/jpeg,image/webp;q=0.8' }, signal: options.signal,
    });
    // Electron 的网络 Response 可能不提供 url；真正的逐跳约束由上面的会话守卫完成。
    if (response.url && !isSourceIconProxyUrl(response.url)) throw new Error('图标服务跳转地址无效。');
    return response;
  };
}

module.exports = { isSourceIconProxyUrl, createSourceIconProxy };
