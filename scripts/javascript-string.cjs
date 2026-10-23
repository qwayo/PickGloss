'use strict';

// 只用于把字符串嵌入 JavaScript 源码；JSON 文件、协议消息仍使用 JSON.stringify。
// 先处理引号、反斜杠和控制字符，再转义 HTML 边界与 Unicode 行分隔符。
// 转义只改变源码表示，执行后得到的字符串与原值一致。
function quoteJavaScriptString(value) {
  if (typeof value !== 'string') throw new TypeError('JavaScript 字符串参数必须是字符串。');
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

module.exports = { quoteJavaScriptString };
