'use strict';

const LIMITS = Object.freeze({ text: 12000, context: 6000, request: 40000, imageBytes: 15 * 1024 * 1024 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODES = Object.freeze(['context', 'independent', 'visual']);

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

function string(value, name, max = LIMITS.request) {
  if (typeof value !== 'string') throw failure('INVALID_INPUT', `${name}必须是文本。`);
  if (value.length > max) throw failure('INPUT_TOO_LONG', `${name}超过 ${max} 字符，请缩短后重试。`);
  return value;
}

function uuid(id) {
  if (typeof id !== 'string' || !UUID.test(id)) throw failure('INVALID_ID', '解释会话标识无效。');
  return id.toLowerCase();
}

function png(dataURL) {
  if (typeof dataURL !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(dataURL)) {
    throw failure('INVALID_IMAGE', '截图必须是 PNG 数据。');
  }
  const encoded = dataURL.slice('data:image/png;base64,'.length);
  if (encoded.length > Math.ceil(LIMITS.imageBytes / 3) * 4) throw failure('IMAGE_TOO_LARGE', '截图超过 15 MiB，请缩小框选区域。');
  const buffer = Buffer.from(encoded, 'base64');
  if (buffer.toString('base64') !== encoded || buffer.length < 33 ||
      !buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      buffer.toString('ascii', 12, 16) !== 'IHDR' || buffer.readUInt32BE(16) === 0 || buffer.readUInt32BE(20) === 0) {
    throw failure('INVALID_IMAGE', '截图 PNG 数据无效。');
  }
  return buffer;
}

module.exports = { LIMITS, MODES, failure, string, uuid, png };
