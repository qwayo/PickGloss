'use strict';

const dns = require('node:dns/promises');
const https = require('node:https');
const net = require('node:net');

const MAX_RESPONSE_BYTES = 64 * 1024;
const TIMEOUT_MS = 1800;
const PROXY_TIMEOUT_MS = 5000;
const CACHE_LIMIT = 64;
const SUCCESS_TTL_MS = 5 * 60 * 1000;
const FAILURE_TTL_MS = 30 * 1000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function ipv4Number(address) {
  const parts = address.split('.').map(Number);
  return (((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0);
}

function ipv4InRange(address, base, prefix) {
  const shift = 32 - prefix;
  return shift === 32 ? true : (ipv4Number(address) >>> shift) === (ipv4Number(base) >>> shift);
}

function parseIpv6(address) {
  let value = address.toLowerCase();
  if (value.includes('.')) {
    const lastColon = value.lastIndexOf(':');
    const embedded = value.slice(lastColon + 1);
    if (net.isIP(embedded) !== 4) return null;
    const number = ipv4Number(embedded);
    value = `${value.slice(0, lastColon)}:${(number >>> 16).toString(16)}:${(number & 0xffff).toString(16)}`;
  }
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const groups = [...left, ...Array(missing).fill('0'), ...right];
  if (groups.length !== 8 || groups.some(group => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.map(group => Number.parseInt(group, 16));
}

function ipv6InRange(groups, base, prefix) {
  const baseGroups = parseIpv6(base);
  if (!baseGroups) return false;
  const fullGroups = Math.floor(prefix / 16);
  const remainingBits = prefix % 16;
  for (let index = 0; index < fullGroups; index += 1) {
    if (groups[index] !== baseGroups[index]) return false;
  }
  if (!remainingBits) return true;
  const mask = (0xffff << (16 - remainingBits)) & 0xffff;
  return (groups[fullGroups] & mask) === (baseGroups[fullGroups] & mask);
}

function isPublicIp(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const blocked = [
      ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
      ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
      ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
      ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
    ];
    return !blocked.some(([base, prefix]) => ipv4InRange(address, base, prefix));
  }
  if (family === 6) {
    const groups = parseIpv6(address);
    if (!groups) return false;
    // IPv4 映射的 IPv6 地址沿用 IPv4 公网地址判定规则。
    if (groups.slice(0, 5).every(group => group === 0) && groups[5] === 0xffff) {
      return isPublicIp(`${groups[6] >>> 8}.${groups[6] & 0xff}.${groups[7] >>> 8}.${groups[7] & 0xff}`);
    }
    // 仅接受全球单播地址，并排除协议分配、6to4 与文档示例地址段。
    return ipv6InRange(groups, '2000::', 3) &&
      !ipv6InRange(groups, '2001::', 23) &&
      !ipv6InRange(groups, '2001:db8::', 32) &&
      !ipv6InRange(groups, '2002::', 16) &&
      !ipv6InRange(groups, '3fff::', 20);
  }
  return false;
}

function parseSourceUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  const hostname = url.hostname.toLowerCase();
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) return null;
  if (net.isIP(hostname) || hostname.length > 253 || hostname.endsWith('.') || !hostname.includes('.')) return null;
  const labels = hostname.split('.');
  if (labels.some(label => label.length < 1 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) return null;
  if (!/^[a-z]/.test(labels.at(-1)) || /\.(?:localhost|local|internal|home|lan|test|invalid|onion)$/.test(hostname)) return null;
  return { hostname, origin: `https://${hostname}` };
}

function normalizeAddresses(records) {
  if (!Array.isArray(records) || records.length === 0) return [];
  return records.map(record => typeof record === 'string' ? record : record?.address).filter(address => typeof address === 'string');
}

function readHeader(headers, name) {
  if (!headers || typeof headers !== 'object') return '';
  const key = Object.keys(headers).find(candidate => candidate.toLowerCase() === name);
  const value = key ? headers[key] : '';
  return Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '');
}

function safeSourceImageType(contentType) {
  const type = contentType.split(';', 1)[0].trim().toLowerCase();
  if (!type) return true;
  if (type === 'application/octet-stream') return true;
  return type.startsWith('image/') && !/(?:svg|xml)/.test(type);
}

function dimensionsFromImage(buffer) {
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(PNG_SIGNATURE) && buffer.toString('ascii', 12, 16) === 'IHDR') {
    return [buffer.readUInt32BE(16), buffer.readUInt32BE(20)];
  }
  if (buffer.length >= 10 && (buffer.toString('ascii', 0, 6) === 'GIF87a' || buffer.toString('ascii', 0, 6) === 'GIF89a')) {
    return [buffer.readUInt16LE(6), buffer.readUInt16LE(8)];
  }
  if (buffer.length >= 26 && buffer.toString('ascii', 0, 2) === 'BM') {
    return [Math.abs(buffer.readInt32LE(18)), Math.abs(buffer.readInt32LE(22))];
  }
  if (buffer.length >= 30 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buffer.toString('ascii', 12, 16);
    if (chunk === 'VP8X') return [1 + buffer.readUIntLE(24, 3), 1 + buffer.readUIntLE(27, 3)];
    if (chunk === 'VP8L' && buffer[20] === 0x2f) {
      const b1 = buffer[21], b2 = buffer[22], b3 = buffer[23], b4 = buffer[24];
      return [1 + ((b1 & 0x3f) | ((b2 & 0x3f) << 6)), 1 + (((b2 >>> 6) & 3) | (b3 << 2) | ((b4 & 0x0f) << 10))];
    }
    if (chunk === 'VP8 ' && buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) {
      return [buffer.readUInt16LE(26) & 0x3fff, buffer.readUInt16LE(28) & 0x3fff];
    }
  }
  if (buffer.length >= 6 && buffer.readUInt16LE(0) === 0 && buffer.readUInt16LE(2) === 1) {
    const count = buffer.readUInt16LE(4);
    if (!count || buffer.length < 6 + count * 16) return null;
    let maxWidth = 0, maxHeight = 0;
    for (let index = 0; index < count; index += 1) {
      const offset = 6 + index * 16;
      maxWidth = Math.max(maxWidth, buffer[offset] || 256);
      maxHeight = Math.max(maxHeight, buffer[offset + 1] || 256);
    }
    return [maxWidth, maxHeight];
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 <= buffer.length) {
      if (buffer[offset] !== 0xff) return null;
      while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
      const marker = buffer[offset++];
      if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > buffer.length) return null;
      const length = buffer.readUInt16BE(offset);
      if (length < 2 || offset + length > buffer.length) return null;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (length < 7) return null;
        return [buffer.readUInt16BE(offset + 5), buffer.readUInt16BE(offset + 3)];
      }
      offset += length;
    }
  }
  return null;
}

function boundedDimensions(dimensions) {
  if (!Array.isArray(dimensions) || dimensions.length !== 2) return false;
  const [width, height] = dimensions;
  return Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0 &&
    width <= 1024 && height <= 1024 && width * height <= 1024 * 1024;
}

function safePng(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 24 && buffer.length <= MAX_RESPONSE_BYTES &&
    buffer.subarray(0, 8).equals(PNG_SIGNATURE) && buffer.toString('ascii', 12, 16) === 'IHDR' &&
    boundedDimensions([buffer.readUInt32BE(16), buffer.readUInt32BE(20)]) &&
    buffer.readUInt32BE(16) <= 32 && buffer.readUInt32BE(20) <= 32;
}

function pngResourceDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 33 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE) ||
      buffer.readUInt32BE(8) !== 13 || buffer.toString('ascii', 12, 16) !== 'IHDR') return null;
  const dimensions = [buffer.readUInt32BE(16), buffer.readUInt32BE(20)];
  return boundedDimensions(dimensions) ? dimensions : null;
}

function parseIcoEntries(buffer) {
  if (buffer.length < 6 || buffer.readUInt16LE(0) !== 0 || buffer.readUInt16LE(2) !== 1) return null;
  const count = buffer.readUInt16LE(4);
  const tableEnd = 6 + count * 16;
  if (!count || count > 256 || tableEnd > buffer.length) return null;
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    const offset = 6 + index * 16;
    const width = buffer[offset] || 256;
    const height = buffer[offset + 1] || 256;
    const resourceSize = buffer.readUInt32LE(offset + 8);
    const resourceOffset = buffer.readUInt32LE(offset + 12);
    if (buffer[offset + 3] !== 0 || resourceSize < 8 || resourceSize > MAX_RESPONSE_BYTES ||
        resourceOffset < tableEnd || resourceOffset > buffer.length || resourceSize > buffer.length - resourceOffset ||
        !boundedDimensions([width, height])) return null;
    entries.push({ width, height, bytes: buffer.subarray(resourceOffset, resourceOffset + resourceSize) });
  }
  return entries;
}

function parseIcoDib(entry) {
  const { bytes, width: directoryWidth, height: directoryHeight } = entry;
  if (bytes.length < 40) return { unsupported: true };
  const headerSize = bytes.readUInt32LE(0);
  if (headerSize < 40 || headerSize > bytes.length) return { invalid: true };
  const width = bytes.readInt32LE(4);
  const doubledHeight = bytes.readInt32LE(8);
  const planes = bytes.readUInt16LE(12);
  const bitCount = bytes.readUInt16LE(14);
  const compression = bytes.readUInt32LE(16);
  const imageSize = bytes.readUInt32LE(20);
  const height = Math.abs(doubledHeight) / 2;
  if (width <= 0 || doubledHeight === 0 || !Number.isInteger(height) || width !== directoryWidth || height !== directoryHeight ||
      !boundedDimensions([width, height])) return { invalid: true };
  if (planes !== 1 || ![24, 32].includes(bitCount) || compression !== 0) return { unsupported: true };

  const xorStride = Math.ceil((width * bitCount) / 32) * 4;
  const andStride = Math.ceil(width / 32) * 4;
  const xorBytes = xorStride * height;
  const andBytes = andStride * height;
  const requiredBytes = headerSize + xorBytes + andBytes;
  if ((imageSize !== 0 && (imageSize < xorBytes || imageSize > bytes.length - headerSize)) || requiredBytes > bytes.length) {
    return { invalid: true };
  }
  return {
    width,
    height,
    headerSize,
    bitCount,
    xorStride,
    andStride,
    xorOffset: headerSize,
    andOffset: headerSize + xorBytes,
    topDown: doubledHeight < 0,
  };
}

function imageSize(image) {
  if (!image || typeof image.isEmpty !== 'function' || image.isEmpty() || typeof image.getSize !== 'function') return null;
  const size = image.getSize();
  const width = Array.isArray(size) ? size[0] : size?.width;
  const height = Array.isArray(size) ? size[1] : size?.height;
  return boundedDimensions([width, height]) ? { width, height } : null;
}

function imageToPng(image) {
  let size = imageSize(image);
  if (!size) return null;
  if (Math.max(size.width, size.height) > 32) {
    const scale = 32 / Math.max(size.width, size.height);
    const width = Math.max(1, Math.round(size.width * scale));
    const height = Math.max(1, Math.round(size.height * scale));
    if (typeof image.resize !== 'function') return null;
    image = image.resize({ width, height, quality: 'best' });
    size = imageSize(image);
    if (!size || size.width > 32 || size.height > 32) return null;
  }
  if (typeof image.toPNG !== 'function') return null;
  const png = image.toPNG();
  return safePng(png) ? png : null;
}

function bitmapFromIcoDib(entry, dib) {
  const { bytes } = entry;
  const { width, height, bitCount, xorStride, andStride, xorOffset, andOffset, topDown } = dib;
  const pixelBytes = width * height * 4;
  const bitmap = Buffer.alloc(pixelBytes);
  let hasAlpha = false;
  if (bitCount === 32) {
    for (let y = 0; y < height; y += 1) {
      const sourceY = topDown ? y : height - 1 - y;
      const sourceRow = xorOffset + sourceY * xorStride;
      for (let x = 0; x < width; x += 1) {
        if (bytes[sourceRow + x * 4 + 3] !== 0) hasAlpha = true;
      }
    }
  }
  for (let y = 0; y < height; y += 1) {
    const sourceY = topDown ? y : height - 1 - y;
    const xorRow = xorOffset + sourceY * xorStride;
    const andRow = andOffset + sourceY * andStride;
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      const source = xorRow + x * (bitCount / 8);
      const target = pixel * 4;
      bitmap[target] = bytes[source];
      bitmap[target + 1] = bytes[source + 1];
      bitmap[target + 2] = bytes[source + 2];
      const masked = (bytes[andRow + Math.floor(x / 8)] & (0x80 >>> (x % 8))) !== 0;
      const alpha = bitCount === 32 ? (hasAlpha ? bytes[source + 3] : 255) : 255;
      bitmap[target + 3] = masked ? 0 : alpha;
    }
  }
  return bitmap;
}

function decodeSourceIcon(buffer, nativeImage) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_RESPONSE_BYTES || !nativeImage ||
      typeof nativeImage.createFromBuffer !== 'function' || typeof nativeImage.createFromBitmap !== 'function') return null;
  try {
    if (buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
      const dimensions = pngResourceDimensions(buffer);
      if (!dimensions) return null;
      return imageToPng(nativeImage.createFromBuffer(buffer));
    }
    if (buffer[0] === 0xff && buffer[1] === 0xd8) {
      const dimensions = dimensionsFromImage(buffer);
      if (!boundedDimensions(dimensions)) return null;
      return imageToPng(nativeImage.createFromBuffer(buffer));
    }

    const entries = parseIcoEntries(buffer);
    if (!entries) return null;
    const pngEntries = [];
    const dibEntries = [];
    for (const entry of entries) {
      if (entry.bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
        const dimensions = pngResourceDimensions(entry.bytes);
        if (!dimensions || dimensions[0] !== entry.width || dimensions[1] !== entry.height) return null;
        pngEntries.push({ ...entry, area: dimensions[0] * dimensions[1] });
        continue;
      }
      const dib = parseIcoDib(entry);
      if (dib.invalid) return null;
      if (!dib.unsupported) dibEntries.push({ ...entry, dib, area: entry.width * entry.height });
    }

    pngEntries.sort((left, right) => right.area - left.area);
    for (const entry of pngEntries) {
      const decoded = imageToPng(nativeImage.createFromBuffer(entry.bytes));
      if (decoded) return decoded;
    }
    dibEntries.sort((left, right) => right.area - left.area);
    for (const entry of dibEntries) {
      const bitmap = bitmapFromIcoDib(entry, entry.dib);
      const image = nativeImage.createFromBitmap(bitmap, { width: entry.width, height: entry.height, scaleFactor: 1 });
      const decoded = imageToPng(image);
      if (decoded) return decoded;
    }
    return null;
  } catch {
    return null;
  }
}

function requestFavicon({ hostname, address, signal, httpsRequest = https.request }) {
  const family = net.isIP(address);
  if (!family) return Promise.reject(new Error('invalid pinned address'));
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = () => request.destroy(new Error('request aborted'));
    const request = httpsRequest({
      hostname,
      path: '/favicon.ico',
      method: 'GET',
      agent: false,
      servername: hostname,
      headers: {
        Accept: 'image/png,image/jpeg,image/gif,image/webp,image/x-icon,image/bmp,application/octet-stream;q=0.8',
        Host: hostname,
      },
      lookup: (_name, options, callback) => {
        if (options?.all) callback(null, [{ address, family }]);
        else callback(null, address, family);
      },
    }, response => {
      const statusCode = Number(response.statusCode || 0);
      const contentType = readHeader(response.headers, 'content-type');
      if (statusCode !== 200) {
        response.destroy();
        finish(null, { statusCode, contentType, body: Buffer.alloc(0) });
        return;
      }
      const declaredLength = Number(readHeader(response.headers, 'content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
        finish(new Error('response too large'));
        response.destroy();
        return;
      }
      response.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          finish(new Error('response too large'));
          response.destroy();
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => finish(null, { statusCode, contentType, body: Buffer.concat(chunks, size) }));
      response.on('error', error => finish(error));
    });
    request.setTimeout(TIMEOUT_MS, () => request.destroy(new Error('request timed out')));
    request.on('error', error => finish(error));
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    request.end();
  });
}

function createSourceIcons(options = {}) {
  const {
    decodeImage,
    lookup = (hostname, lookupOptions) => dns.lookup(hostname, lookupOptions),
    request,
    httpsRequest = https.request,
    proxyFetch,
    proxyTimeoutMs = PROXY_TIMEOUT_MS,
    now = Date.now,
  } = options;
  if (typeof decodeImage !== 'function') throw new TypeError('decodeImage must be a function');
  if (typeof lookup !== 'function' || (request !== undefined && typeof request !== 'function') ||
      typeof httpsRequest !== 'function' || (proxyFetch !== undefined && typeof proxyFetch !== 'function') ||
      !Number.isFinite(proxyTimeoutMs) || proxyTimeoutMs <= 0 || typeof now !== 'function') {
    throw new TypeError('lookup, request, httpsRequest and now must be functions');
  }
  const requestIcon = request || (requestOptions => requestFavicon({ ...requestOptions, httpsRequest }));

  const cache = new Map();
  const inFlight = new Map();

  function remember(origin, icon, timestamp) {
    cache.delete(origin);
    cache.set(origin, { icon, expiresAt: timestamp + (icon ? SUCCESS_TTL_MS : FAILURE_TTL_MS) });
    while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  }

  async function loadDirect(hostname) {
    const controller = new AbortController();
    let rejectTimeout;
    const timeout = new Promise((_, reject) => { rejectTimeout = reject; });
    const timer = setTimeout(() => {
      controller.abort();
      rejectTimeout(new Error('source icon lookup timed out'));
    }, TIMEOUT_MS);
    timer.unref?.();
    const wait = promise => Promise.race([Promise.resolve(promise), timeout]);
    try {
      const records = await wait(Promise.resolve().then(() => lookup(hostname, { all: true, verbatim: true })));
      const addresses = normalizeAddresses(records);
      if (!addresses.length || addresses.some(address => !isPublicIp(address))) return '';
      const address = addresses[0];
      const response = await wait(Promise.resolve().then(() => requestIcon({
        hostname,
        address,
        path: '/favicon.ico',
        timeoutMs: TIMEOUT_MS,
        maxBytes: MAX_RESPONSE_BYTES,
        signal: controller.signal,
      })));
      if (Number(response?.statusCode) !== 200 || !safeSourceImageType(String(response?.contentType || ''))) return '';
      const body = Buffer.isBuffer(response.body) ? response.body : Buffer.from(response.body || []);
      if (!body.length || body.length > MAX_RESPONSE_BYTES || !boundedDimensions(dimensionsFromImage(body))) return '';
      const decoded = await wait(Promise.resolve().then(() => decodeImage(body)));
      const png = Buffer.isBuffer(decoded) ? decoded : (decoded instanceof Uint8Array ? Buffer.from(decoded) : null);
      if (!png || !safePng(png)) return '';
      return `data:image/png;base64,${png.toString('base64')}`;
    } catch {
      return '';
    } finally {
      clearTimeout(timer);
    }
  }

  async function loadProxyImage(url, redirect) {
    if (!proxyFetch) return '';
    const controller = new AbortController();
    let rejectTimeout;
    const timeout = new Promise((_, reject) => { rejectTimeout = reject; });
    const timer = setTimeout(() => {
      controller.abort();
      rejectTimeout(new Error('proxy source icon lookup timed out'));
    }, proxyTimeoutMs);
    let reader;
    const wait = promise => Promise.race([Promise.resolve(promise), timeout]);
    try {
      const response = await wait(Promise.resolve().then(() => proxyFetch(url, {
        method: 'GET', credentials: 'omit', redirect, cache: 'no-store',
        headers: { Accept: 'image/png,image/x-icon,image/jpeg;q=0.8' }, signal: controller.signal,
      })));
      reader = response?.body?.getReader?.();
      if (response?.status !== 200 || !safeSourceImageType(response.headers?.get?.('content-type') || '') ||
          Number(response.headers?.get?.('content-length')) > MAX_RESPONSE_BYTES || !reader) return '';
      const chunks = []; let size = 0;
      while (true) {
        const { done, value } = await wait(reader.read());
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) return '';
        chunks.push(Buffer.from(value));
      }
      const body = Buffer.concat(chunks, size);
      if (!size || !boundedDimensions(dimensionsFromImage(body))) return '';
      const decoded = await wait(decodeImage(body));
      const png = Buffer.isBuffer(decoded) ? decoded : decoded instanceof Uint8Array ? Buffer.from(decoded) : null;
      return png && safePng(png) ? `data:image/png;base64,${png.toString('base64')}` : '';
    } catch {
      return '';
    } finally {
      clearTimeout(timer);
      controller.abort();
      reader?.cancel().catch(() => {});
    }
  }

  async function load(hostname) {
    const direct = await loadDirect(hostname);
    if (direct || !proxyFetch) return direct;
    // 仅向固定图标服务发送来源域名，不发送网页路径、搜索词或会话内容。
    const services = [
      {
        url: `https://icons.duckduckgo.com/ip3/${hostname}.ico`,
        redirect: 'error',
      },
      {
        url: `https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostname)}&sz=64`,
        redirect: 'follow',
      },
    ];
    for (const service of services) {
      const icon = await loadProxyImage(service.url, service.redirect);
      if (icon) return icon;
    }
    return '';
  }

  function get(value) {
    const parsed = parseSourceUrl(value);
    if (!parsed) return Promise.resolve('');
    const timestamp = now();
    const cached = cache.get(parsed.origin);
    if (cached && cached.expiresAt > timestamp) {
      cache.delete(parsed.origin);
      cache.set(parsed.origin, cached);
      return Promise.resolve(cached.icon);
    }
    if (cached) cache.delete(parsed.origin);
    if (inFlight.has(parsed.origin)) return inFlight.get(parsed.origin);

    const operation = load(parsed.hostname).then(icon => {
      remember(parsed.origin, icon, now());
      return icon;
    }).catch(() => {
      remember(parsed.origin, '', now());
      return '';
    }).finally(() => inFlight.delete(parsed.origin));
    inFlight.set(parsed.origin, operation);
    return operation;
  }

  return { get };
}

module.exports = { createSourceIcons, decodeSourceIcon };
