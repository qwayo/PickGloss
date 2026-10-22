'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { streamCompletion, testProvider } = require('../src/core/provider.cjs');

async function main() {
  let requests = 0;
  const server = http.createServer(async (request, response) => {
    requests++;
    for await (const _chunk of request) { /* 仅消费虚构测试请求。 */ }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (requests === 2) response.write('data: {"choices":[{"delta":{"content":"超时前片段"}}]}\n\n');
    else response.write(': 本机保持连接，等待连接测试超时\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: '虚构超时模型', apiKey: 'fictional-timeout-key' };
  try {
    let started = Date.now();
    await assert.rejects(testProvider({ config }), { code: 'TIMEOUT' });
    const connectionMs = Date.now() - started;
    assert.ok(connectionMs >= 14500 && connectionMs < 25000, `连接测试超时时间异常：${connectionMs} 毫秒`);
    const partial = [];
    started = Date.now();
    await assert.rejects(streamCompletion({ config, messages: [{ role: 'user', content: '虚构解释材料' }], onDelta: delta => partial.push(delta) }), { code: 'TIMEOUT' });
    const explanationMs = Date.now() - started;
    assert.ok(explanationMs >= 59000 && explanationMs < 70000, `解释超时时间异常：${explanationMs} 毫秒`);
    assert.deepEqual(partial, ['超时前片段']);
    assert.equal(requests, 2);
    console.log(JSON.stringify({ connectionMs, explanationMs, requests, partialRetained: true, realProvider: false }));
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
