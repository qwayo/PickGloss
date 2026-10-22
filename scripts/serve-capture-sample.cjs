'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const samples = {
  web: '采集验证样本.html',
  scroll: '滚动保留入口验证样本.html',
  screen: '单屏位置与截图验证样本.html',
};
const kind = process.argv[2] || 'web';
if (!Object.hasOwn(samples, kind)) {
  console.error('样本须为 web、scroll 或 screen。');
  process.exit(1);
}
const file = path.join(__dirname, '..', 'prototypes', 'windows-capture', samples[kind]);
const body = fs.readFileSync(file);
const server = http.createServer((request, response) => {
  if (request.url !== '/' && request.url !== '/favicon.ico') {
    response.writeHead(404); response.end(); return;
  }
  if (request.url === '/favicon.ico') { response.writeHead(204); response.end(); return; }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(body);
});
server.listen(0, '127.0.0.1', () => {
  console.log(`只读固定样本：${samples[kind]}\n本机地址：http://127.0.0.1:${server.address().port}/\n按 Ctrl+C 结束。`);
});
