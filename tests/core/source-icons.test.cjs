'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { createSourceIcons, decodeSourceIcon } = require('../../src/core/source-icons.cjs');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function png(width, height) {
  const buffer = Buffer.alloc(33);
  PNG_SIGNATURE.copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer[24] = 8;
  buffer[25] = 6;
  return buffer;
}

function jpeg(width, height) {
  const buffer = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0, 0, 0, 0, 3, 1, 0x11, 0, 0xff, 0xd9]);
  buffer.writeUInt16BE(height, 7);
  buffer.writeUInt16BE(width, 9);
  return buffer;
}

function ico(entries) {
  const table = Buffer.alloc(6 + entries.length * 16);
  table.writeUInt16LE(0, 0);
  table.writeUInt16LE(1, 2);
  table.writeUInt16LE(entries.length, 4);
  let offset = table.length;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const position = 6 + index * 16;
    table[position] = entry.width === 256 ? 0 : entry.width;
    table[position + 1] = entry.height === 256 ? 0 : entry.height;
    table.writeUInt32LE(entry.resource.length, position + 8);
    table.writeUInt32LE(offset, position + 12);
    offset += entry.resource.length;
  }
  return Buffer.concat([table, ...entries.map(entry => entry.resource)]);
}

function dib32(width, height, xorPixels, andMask, options = {}) {
  const xorStride = width * 4;
  const andStride = Math.ceil(width / 32) * 4;
  const bytes = Buffer.alloc(40 + xorStride * height + andStride * height);
  bytes.writeUInt32LE(40, 0);
  bytes.writeInt32LE(width, 4);
  bytes.writeInt32LE(height * 2, 8);
  bytes.writeUInt16LE(1, 12);
  bytes.writeUInt16LE(32, 14);
  bytes.writeUInt32LE(0, 16);
  bytes.writeUInt32LE(options.imageSize ?? xorStride * height, 20);
  xorPixels.copy(bytes, 40);
  andMask.copy(bytes, 40 + xorStride * height);
  return bytes;
}

function dib24(width, height, xorPixels, andMask) {
  const xorStride = Math.ceil((width * 24) / 32) * 4;
  const andStride = Math.ceil(width / 32) * 4;
  const bytes = Buffer.alloc(40 + xorStride * height + andStride * height);
  bytes.writeUInt32LE(40, 0);
  bytes.writeInt32LE(width, 4);
  bytes.writeInt32LE(height * 2, 8);
  bytes.writeUInt16LE(1, 12);
  bytes.writeUInt16LE(24, 14);
  bytes.writeUInt32LE(0, 16);
  xorPixels.copy(bytes, 40);
  andMask.copy(bytes, 40 + xorStride * height);
  return bytes;
}

function fakeNativeImage() {
  const calls = { buffers: [], bitmaps: [] };
  const createImage = (width, height) => ({
    isEmpty: () => width < 1 || height < 1,
    getSize: () => ({ width, height }),
    resize: options => createImage(options.width, options.height),
    toPNG: () => png(width, height),
  });
  const nativeImage = {
    createFromBuffer(buffer) {
      calls.buffers.push(Buffer.from(buffer));
      if (buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return createImage(buffer.readUInt32BE(16), buffer.readUInt32BE(20));
      if (buffer[0] === 0xff && buffer[1] === 0xd8) return createImage(buffer.readUInt16BE(9), buffer.readUInt16BE(7));
      return createImage(0, 0);
    },
    createFromBitmap(buffer, options) {
      calls.bitmaps.push({ buffer: Buffer.from(buffer), options });
      return createImage(options.width, options.height);
    },
  };
  return { nativeImage, calls };
}

function mockHttpsRequest(spec, calls) {
  return (options, onResponse) => {
    calls.options = options;
    calls.count = (calls.count || 0) + 1;
    const request = new EventEmitter();
    request.setTimeout = timeoutMs => { calls.timeoutMs = timeoutMs; };
    request.destroy = error => {
      calls.requestDestroyed = true;
      if (error) queueMicrotask(() => request.emit('error', error));
    };
    request.end = () => queueMicrotask(() => {
      const response = new EventEmitter();
      response.statusCode = spec.statusCode;
      response.headers = spec.headers;
      response.destroy = error => {
        calls.responseDestroyed = true;
        calls.responseDestroyHadError = Boolean(error);
        if (error) response.emit('error', error);
      };
      response.resume = () => { calls.responseResumed = true; };
      onResponse(response);
      if (calls.responseDestroyed) {
        calls.responseBodySent = false;
        return;
      }
      for (const chunk of spec.chunks || []) response.emit('data', chunk);
      response.emit('end');
    });
    return request;
  };
}

function makeIcons(overrides = {}) {
  const calls = { lookup: [], request: [], decode: [] };
  const icons = createSourceIcons({
    lookup: async (hostname, options) => {
      calls.lookup.push({ hostname, options });
      return [{ address: '8.8.8.8', family: 4 }];
    },
    request: async options => {
      calls.request.push(options);
      return { statusCode: 200, contentType: 'image/x-icon', body: png(16, 16) };
    },
    decodeImage: async buffer => {
      calls.decode.push(buffer);
      return png(16, 12);
    },
    ...overrides,
  });
  return { icons, calls };
}

test('按来源 origin 请求 /favicon.ico，并只返回经过解码验证的 PNG data URI', async () => {
  const { icons, calls } = makeIcons();
  const result = await icons.get('https://www.example.com/article?id=3#section');

  assert.equal(result, `data:image/png;base64,${png(16, 12).toString('base64')}`);
  assert.deepEqual(calls.lookup[0], {
    hostname: 'www.example.com',
    options: { all: true, verbatim: true },
  });
  assert.equal(calls.request[0].hostname, 'www.example.com');
  assert.equal(calls.request[0].address, '8.8.8.8');
  assert.equal(calls.request[0].path, '/favicon.ico');
  assert.equal(calls.request[0].maxBytes, 64 * 1024);
  assert.equal(calls.request[0].timeoutMs, 1800);
  assert.equal('cookie' in calls.request[0], false);
  assert.equal('headers' in calls.request[0], false);
  assert.equal(calls.decode.length, 1);
});

test('拒绝非网页协议、凭据、非标准端口、本机地址和非公共域名，且不做 DNS 或 HTTP 请求', async () => {
  const { icons, calls } = makeIcons();
  const rejected = [
    'ftp://www.example.com/',
    'https://user:secret@www.example.com/',
    'https://www.example.com:444/',
    'https://127.0.0.1/',
    'https://[::1]/',
    'https://localhost/',
    'https://printer.local/',
    'https://service.internal/',
    'file:///favicon.ico',
    'https://www.example.com.evil.test/',
  ];

  for (const url of rejected) assert.equal(await icons.get(url), '', url);
  assert.equal(calls.lookup.length, 0);
  assert.equal(calls.request.length, 0);
});

test('HTTP 网页来源也通过 HTTPS 补取网站图标，不携带来源路径', async () => {
  const { icons, calls } = makeIcons();
  assert.match(await icons.get('http://www.example.com/article'), /^data:image\/png;base64,/);
  assert.equal(calls.request[0].hostname, 'www.example.com');
  assert.equal(calls.request[0].path, '/favicon.ico');
});

test('DNS 结果必须全部是公网地址，并把请求固定到已验证地址', async () => {
  const unsafeAnswers = [
    [{ address: '8.8.8.8', family: 4 }, { address: '10.1.2.3', family: 4 }],
    [{ address: '127.0.0.1', family: 4 }],
    [{ address: '169.254.1.2', family: 4 }],
    [{ address: '198.18.0.1', family: 4 }],
    [{ address: '192.0.2.7', family: 4 }],
    [{ address: '::1', family: 6 }],
    [{ address: 'fe80::1', family: 6 }],
    [{ address: 'fc00::1', family: 6 }],
    [{ address: '::ffff:127.0.0.1', family: 6 }],
    [{ address: '2001:db8::1', family: 6 }],
  ];
  for (let index = 0; index < unsafeAnswers.length; index += 1) {
    const { icons, calls } = makeIcons({ lookup: async () => unsafeAnswers[index] });
    assert.equal(await icons.get(`https://source-${index}.example.com/`), '');
    assert.equal(calls.request.length, 0, `不应连接 DNS 返回的非公网地址：${JSON.stringify(unsafeAnswers[index])}`);
  }

  const { icons, calls } = makeIcons({
    lookup: async () => [
      { address: '2606:4700:4700::1111', family: 6 },
      { address: '8.8.8.8', family: 4 },
    ],
  });
  await icons.get('https://public.example.com/');
  assert.equal(calls.request[0].address, '2606:4700:4700::1111');
});

test('拒绝重定向、HTML、SVG、非图片内容、超过 64 KiB 的正文和不安全解码结果', async () => {
  const rejectedResponses = [
    { statusCode: 302, contentType: 'image/png', body: png(16, 16) },
    { statusCode: 200, contentType: 'text/html', body: Buffer.from('<html>remote content</html>') },
    { statusCode: 200, contentType: 'image/svg+xml', body: Buffer.from('<svg/>') },
    { statusCode: 200, contentType: 'image/png', body: Buffer.from('<html>wrong body</html>') },
    { statusCode: 200, contentType: 'image/png', body: Buffer.concat([png(16, 16), Buffer.alloc(64 * 1024)]) },
  ];
  for (const response of rejectedResponses) {
    let decodeCount = 0;
    const { icons } = makeIcons({ request: async () => response, decodeImage: async () => { decodeCount += 1; return png(16, 16); } });
    assert.equal(await icons.get('https://response.example.com/'), '');
    assert.equal(decodeCount, 0);
  }

  for (const output of [Buffer.from('<svg/>'), png(33, 16), png(16, 40)]) {
    const { icons } = makeIcons({ decodeImage: async () => output });
    assert.equal(await icons.get('https://decoded.example.com/'), '');
  }
});

test('相同 origin 的并发请求合并，成功与失败都短时缓存且超时后重新获取', async () => {
  let resolveRequest;
  let resolveRequestStarted;
  let now = 1000;
  let requestCount = 0;
  const requestStarted = new Promise(resolve => { resolveRequestStarted = resolve; });
  const { icons } = makeIcons({
    now: () => now,
    request: () => {
      requestCount += 1;
      resolveRequestStarted();
      return new Promise(resolve => { resolveRequest = resolve; });
    },
  });
  const first = icons.get('https://cache.example.com/one');
  const second = icons.get('https://cache.example.com/two');
  assert.equal(first, second);
  await requestStarted;
  assert.equal(requestCount, 1);
  resolveRequest({ statusCode: 200, contentType: 'image/png', body: png(16, 16) });
  assert.equal(await first, `data:image/png;base64,${png(16, 12).toString('base64')}`);
  assert.equal(await icons.get('https://cache.example.com/three'), await first);
  assert.equal(requestCount, 1);

  let failureRequests = 0;
  const failures = createSourceIcons({
    now: () => now,
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    request: async () => { failureRequests += 1; return { statusCode: 503, body: Buffer.alloc(0) }; },
    decodeImage: async () => png(16, 16),
  });
  assert.equal(await failures.get('https://failed.example.com/'), '');
  assert.equal(await failures.get('https://failed.example.com/again'), '');
  assert.equal(failureRequests, 1);
  now += 31 * 1000;
  assert.equal(await failures.get('https://failed.example.com/'), '');
  assert.equal(failureRequests, 2);
});

test('缓存最多保留 64 个来源 origin', async () => {
  let requestCount = 0;
  const { icons } = makeIcons({ request: async () => {
    requestCount += 1;
    return { statusCode: 200, contentType: 'image/png', body: png(16, 16) };
  } });

  for (let index = 0; index < 65; index += 1) await icons.get(`https://source-${index}.example.com/`);
  assert.equal(requestCount, 65);
  await icons.get('https://source-64.example.com/');
  assert.equal(requestCount, 65, '最近使用的 origin 仍在缓存中');
  await icons.get('https://source-0.example.com/');
  assert.equal(requestCount, 66, '最早的 origin 已从有界缓存淘汰');
});

test('安全的 PNG/JPEG 直接解码并缩小到 32 像素以内', () => {
  const { nativeImage, calls } = fakeNativeImage();
  const result = decodeSourceIcon(png(128, 64), nativeImage);
  assert.deepEqual(calls.buffers, [png(128, 64)]);
  assert.equal(calls.bitmaps.length, 0);
  assert.deepEqual([result.readUInt32BE(16), result.readUInt32BE(20)], [32, 16]);

  const jpegImage = fakeNativeImage();
  const jpegResult = decodeSourceIcon(jpeg(20, 10), jpegImage.nativeImage);
  assert.equal(jpegImage.calls.buffers.length, 1);
  assert.deepEqual([jpegResult.readUInt32BE(16), jpegResult.readUInt32BE(20)], [20, 10]);
});

test('ICO 优先提取嵌入 PNG 条目，并校验目录尺寸与 PNG 实际尺寸一致', () => {
  const embedded = png(64, 64);
  const { nativeImage, calls } = fakeNativeImage();
  const dib = dib32(2, 2, Buffer.alloc(16), Buffer.alloc(8));
  const result = decodeSourceIcon(ico([
    { width: 2, height: 2, resource: dib },
    { width: 64, height: 64, resource: embedded },
  ]), nativeImage);
  assert.equal(calls.buffers.length, 1);
  assert.deepEqual(calls.buffers[0], embedded);
  assert.equal(calls.bitmaps.length, 0);
  assert.deepEqual([result.readUInt32BE(16), result.readUInt32BE(20)], [32, 32]);

  const liedAboutSize = fakeNativeImage();
  const oversized = decodeSourceIcon(ico([{ width: 16, height: 16, resource: png(2048, 2048) }]), liedAboutSize.nativeImage);
  assert.equal(oversized, null, '目录的小尺寸不能掩盖 PNG 资源的真实大尺寸');
  assert.equal(liedAboutSize.calls.buffers.length, 0);
});

test('标准 32 位 DIB 转换为 BGRA，并同时应用 alpha 通道与 AND 掩码', () => {
  const xor = Buffer.from([
    1, 2, 3, 0, 4, 5, 6, 0, // 文件中的第一行是图像底行
    7, 8, 9, 128, 10, 11, 12, 255,
  ]);
  const mask = Buffer.from([
    0x80, 0, 0, 0, // 底行首像素透明
    0x40, 0, 0, 0, // 顶行次像素透明
  ]);
  const dib = dib32(2, 2, xor, mask);
  const { nativeImage, calls } = fakeNativeImage();
  const result = decodeSourceIcon(ico([{ width: 2, height: 2, resource: dib }]), nativeImage);

  assert.equal(calls.buffers.length, 0);
  assert.equal(calls.bitmaps.length, 1);
  assert.deepEqual(calls.bitmaps[0].options, { width: 2, height: 2, scaleFactor: 1 });
  assert.deepEqual([...calls.bitmaps[0].buffer], [
    7, 8, 9, 128, 10, 11, 12, 0,
    1, 2, 3, 0, 4, 5, 6, 0,
  ]);
  assert.deepEqual([result.readUInt32BE(16), result.readUInt32BE(20)], [2, 2]);
});

test('标准 24 位 DIB 补全不透明 alpha，32 位全零 alpha 时使用 AND 掩码', () => {
  const pixels24 = Buffer.from([1, 2, 3, 4, 5, 6, 0, 0]);
  const mask24 = Buffer.from([0x40, 0, 0, 0]);
  const image24 = fakeNativeImage();
  decodeSourceIcon(ico([{ width: 2, height: 1, resource: dib24(2, 1, pixels24, mask24) }]), image24.nativeImage);
  assert.deepEqual([...image24.calls.bitmaps[0].buffer], [1, 2, 3, 255, 4, 5, 6, 0]);

  const pixels32 = Buffer.from([9, 8, 7, 0, 6, 5, 4, 0]);
  const mask32 = Buffer.from([0x80, 0, 0, 0]);
  const image32 = fakeNativeImage();
  decodeSourceIcon(ico([{ width: 2, height: 1, resource: dib32(2, 1, pixels32, mask32) }]), image32.nativeImage);
  assert.deepEqual([...image32.calls.bitmaps[0].buffer], [9, 8, 7, 0, 6, 5, 4, 255]);
});

test('ICO 拒绝越界资源偏移、截断资源、错误目录尺寸和超限 DIB 实际尺寸', () => {
  const valid = ico([{ width: 16, height: 16, resource: png(16, 16) }]);
  const native = fakeNativeImage();

  const badOffset = Buffer.from(valid);
  badOffset.writeUInt32LE(0xfffffff0, 18);
  assert.equal(decodeSourceIcon(badOffset, native.nativeImage), null);

  const wrongDirectorySize = decodeSourceIcon(ico([{ width: 16, height: 16, resource: png(32, 32) }]), native.nativeImage);
  assert.equal(wrongDirectorySize, null);

  const hugeDib = Buffer.alloc(40);
  hugeDib.writeUInt32LE(40, 0);
  hugeDib.writeInt32LE(2048, 4);
  hugeDib.writeInt32LE(2048, 8);
  hugeDib.writeUInt16LE(1, 12);
  hugeDib.writeUInt16LE(32, 14);
  hugeDib.writeUInt32LE(0, 16);
  assert.equal(decodeSourceIcon(ico([{ width: 16, height: 16, resource: hugeDib }]), native.nativeImage), null);

  const truncated = Buffer.from(valid.subarray(0, valid.length - 1));
  assert.equal(decodeSourceIcon(truncated, native.nativeImage), null);
});

test('默认 HTTPS request helper 在无网络 mock 下销毁非 200 与超限响应，并固定 TLS 请求参数', async () => {
  async function withResponse(spec) {
    const calls = {};
    const icons = createSourceIcons({
      lookup: async () => [{ address: '8.8.8.8', family: 4 }],
      httpsRequest: mockHttpsRequest(spec, calls),
      decodeImage: async () => png(16, 16),
    });
    return { calls, icon: await icons.get('https://favicon.example.com/page') };
  }

  const redirect = await withResponse({
    statusCode: 302,
    headers: { location: 'https://other.example.com/favicon.ico', 'content-length': '100000' },
    chunks: [Buffer.alloc(100000)],
  });
  assert.equal(redirect.icon, '');
  assert.equal(redirect.calls.responseDestroyed, true);
  assert.equal(redirect.calls.responseBodySent, false, '重定向正文未被排空或接收');
  assert.equal(redirect.calls.count, 1, '不会跟随重定向');

  const tooLarge = await withResponse({
    statusCode: 200,
    headers: { 'content-type': 'image/png', 'content-length': String(64 * 1024 + 1) },
    chunks: [png(16, 16)],
  });
  assert.equal(tooLarge.icon, '');
  assert.equal(tooLarge.calls.responseDestroyed, true);
  assert.equal(tooLarge.calls.responseDestroyHadError, false, '在未注册响应 error listener 前不注入 destroy(error)');

  const body = png(16, 16);
  const success = await withResponse({
    statusCode: 200,
    headers: { 'content-type': 'image/png', 'content-length': String(body.length) },
    chunks: [body],
  });
  assert.equal(success.icon, `data:image/png;base64,${png(16, 16).toString('base64')}`);
  assert.equal(success.calls.options.hostname, 'favicon.example.com');
  assert.equal(success.calls.options.servername, 'favicon.example.com');
  assert.equal(success.calls.options.path, '/favicon.ico');
  assert.equal(success.calls.options.method, 'GET');
  assert.equal(success.calls.options.agent, false);
  assert.equal(success.calls.timeoutMs, 1800);
  assert.equal('cookie' in success.calls.options.headers, false);
  assert.equal('Authorization' in success.calls.options.headers, false);
  let pinned;
  success.calls.options.lookup('favicon.example.com', {}, (error, address, family) => {
    assert.equal(error, null);
    pinned = { address, family };
  });
  assert.deepEqual(pinned, { address: '8.8.8.8', family: 4 });
});

test('系统代理图标补取：虚拟 DNS 不能直连时仍可按域名取得真实图标', async () => {
  const calls = [];
  const { icons } = makeIcons({
    lookup: async () => [{ address: '198.18.1.234', family: 4 }],
    proxyFetch: async (url, options) => {
      calls.push({ url, options });
      return new Response(png(16, 16), { status: 200, headers: { 'content-type': 'image/png' } });
    },
  });
  const value = await icons.get('https://www.baidu.com/private/article?secret=unused');
  assert.match(value, /^data:image\/png;base64,/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://icons.duckduckgo.com/ip3/www.baidu.com.ico');
  assert.equal(calls[0].options.credentials, 'omit');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal('Authorization' in calls[0].options.headers, false);
  assert.equal('Cookie' in calls[0].options.headers, false);
});

test('DuckDuckGo 无图标时再请求 Google，域名以外的页面信息不会发送，结果按来源缓存', async () => {
  const calls = [];
  const { icons } = makeIcons({
    lookup: async () => [{ address: '198.18.2.5', family: 4 }],
    proxyFetch: async (url, options) => {
      calls.push({ url, options });
      if (calls.length === 1) return new Response('', { headers: { 'content-type': 'text/plain' } });
      return new Response(png(64, 64), { headers: { 'content-type': 'image/png' } });
    },
  });
  const value = await icons.get('https://juejin.cn/post/private-article?token=secret');
  assert.equal(value, `data:image/png;base64,${png(16, 12).toString('base64')}`);
  assert.equal(await icons.get('https://juejin.cn/another-private-page'), value);
  assert.equal(calls.length, 2, '来源成功结果在缓存有效期内不重复请求');
  assert.equal(calls[0].url, 'https://icons.duckduckgo.com/ip3/juejin.cn.ico');
  assert.equal(calls[1].url, 'https://www.google.com/s2/favicons?domain=juejin.cn&sz=64');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[1].options.redirect, 'follow', '重定向交给主进程图标 session 的目标 URL 守卫');
  for (const { options } of calls) {
    assert.equal(options.credentials, 'omit');
    assert.equal(options.cache, 'no-store');
    assert.deepEqual(options.headers, { Accept: 'image/png,image/x-icon,image/jpeg;q=0.8' });
    assert.equal('Cookie' in options.headers, false);
    assert.equal('Authorization' in options.headers, false);
  }
});

test('DuckDuckGo 与 Google 都没有可用图片时返回空，并短时缓存失败', async () => {
  let now = 5000;
  const calls = [];
  const { icons } = makeIcons({
    now: () => now,
    lookup: async () => [],
    proxyFetch: async url => {
      calls.push(url);
      return new Response('', { status: 200, headers: { 'content-type': 'text/plain' } });
    },
  });
  assert.equal(await icons.get('https://unknown.example.com/article'), '');
  assert.equal(await icons.get('https://unknown.example.com/another-article'), '');
  assert.deepEqual(calls, [
    'https://icons.duckduckgo.com/ip3/unknown.example.com.ico',
    'https://www.google.com/s2/favicons?domain=unknown.example.com&sz=64',
  ]);
  now += 30 * 1000 - 1;
  assert.equal(await icons.get('https://unknown.example.com/'), '');
  assert.equal(calls.length, 2, '失败缓存未到期时不再请求服务');
  now += 2;
  assert.equal(await icons.get('https://unknown.example.com/'), '');
  assert.equal(calls.length, 4, '失败缓存到期后重新尝试两个固定服务');
});

test('图标服务 3xx 不由核心跟随，未验证的 Location 不会变成额外请求', async () => {
  const calls = [];
  const { icons } = makeIcons({ lookup: async () => [], proxyFetch: async (url, options) => {
    calls.push({ url, redirect: options.redirect });
    return new Response('', { status: 302, headers: { location: 'https://attacker.example/collect' } });
  } });
  assert.equal(await icons.get('https://redirect.example.com/'), '');
  assert.deepEqual(calls, [
    { url: 'https://icons.duckduckgo.com/ip3/redirect.example.com.ico', redirect: 'error' },
    { url: 'https://www.google.com/s2/favicons?domain=redirect.example.com&sz=64', redirect: 'follow' },
  ]);
  assert.equal(calls.some(call => call.url.includes('attacker.example')), false);
});

test('服务代理超时会中止并缓存失败，到期后重新尝试', async () => {
  let now = 1000;
  const signals = [];
  const { icons } = makeIcons({
    now: () => now,
    lookup: async () => [],
    proxyTimeoutMs: 10,
    proxyFetch: async (_url, options) => {
      signals.push(options.signal);
      return new Promise(() => {});
    },
  });
  assert.equal(await icons.get('https://slow.example.com/'), '');
  assert.equal(signals.length, 2, '两个固定服务均有独立超时');
  assert.ok(signals.every(signal => signal.aborted), '超时时会取消各自的请求');
  assert.equal(await icons.get('https://slow.example.com/again'), '');
  assert.equal(signals.length, 2, '缓存期内不会立即重试');
  now += 30 * 1000 + 1;
  assert.equal(await icons.get('https://slow.example.com/again'), '');
  assert.equal(signals.length, 4, '失败缓存到期后可以重试');
});

test('图标补取不会请求本地来源，也拒绝重定向、超限流、HTML 和解码失败的内容', async () => {
  const cases = [
    () => new Response(png(16, 16), { status: 302 }),
    () => new Response('<html/>', { headers: { 'content-type': 'text/html' } }),
    () => new Response(png(16, 16), { headers: { 'content-type': 'image/png', 'content-length': '9999999' } }),
    () => new Response(Buffer.alloc(65537), { headers: { 'content-type': 'image/png' } }),
    () => new Response('<svg/>', { headers: { 'content-type': 'image/png' } }),
  ];
  for (const createResponse of cases) {
    let fetches = 0;
    const { icons } = makeIcons({ lookup: async () => [], proxyFetch: async () => { fetches++; return createResponse(); } });
    assert.equal(await icons.get('https://127.0.0.1/private'), '');
    assert.equal(fetches, 0);
    assert.equal(await icons.get('https://public.example.com/'), '');
    assert.equal(fetches, 2, 'DuckDuckGo 响应无效后会检查 Google，仍不接受无效内容');
  }
});

test('网站直连成功时不经过图标服务，不同网站的补取结果各自缓存', async () => {
  const { icons: direct } = makeIcons({ proxyFetch: async () => { throw new Error('不应补取'); } });
  assert.match(await direct.get('https://first.example.com/'), /^data:image\/png;base64,/);
  const hosts = [];
  const { icons } = makeIcons({
    lookup: async () => [], decodeImage: bytes => bytes,
    proxyFetch: async url => {
      hosts.push(url);
      return new Response(png(url.includes('first') ? 16 : 24, 16), { headers: { 'content-type': 'image/png' } });
    },
  });
  const first = await icons.get('https://first.example.com/');
  const second = await icons.get('https://second.example.com/');
  assert.notEqual(first, second);
  assert.equal(await icons.get('https://first.example.com/other'), first);
  assert.equal(hosts.length, 2);
});
