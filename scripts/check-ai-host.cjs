'use strict';

const { app, safeStorage, net, shell } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../src/core/store.cjs');
const { streamCompletion } = require('../src/core/provider.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pickgloss-ai-host-'));
fs.mkdirSync(path.join(root, 'runtime'));
app.setPath('userData', path.join(root, 'runtime'));

app.whenReady().then(async () => {
  const received = [];
  const server = http.createServer(async (request, response) => {
    received.push({ path: request.url, authorization: request.headers.authorization || '' });
    for await (const _chunk of request) { /* 仅消费虚构测试材料，不输出请求体。 */ }
    if (request.url === '/redirect/chat/completions') {
      response.writeHead(307, { Location: '/must-not-visit' });
      response.end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: '本机宿主测试回答' } }] }));
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    assert.equal(safeStorage.isEncryptionAvailable(), true, 'Windows 密钥加密不可用');
    const key = 'fictional-host-key-only';
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    const store = createStore({ directory: path.join(root, 'data'),
      encrypt: value => safeStorage.encryptString(value), decrypt: value => safeStorage.decryptString(value) });
    await store.init();
    await store.saveSettings({ text: { baseUrl, model: '虚构宿主模型', apiKey: key } });
    const publicSettings = await store.getSettings();
    assert.equal('apiKey' in publicSettings.text, false);
    assert.equal((await store.getSettings({ includeSecrets: true })).text.apiKey, key);
    assert.equal((await fsp.readFile(path.join(root, 'data', 'settings.json'), 'utf8')).includes(key), false);
    const config = { baseUrl, model: '虚构宿主模型', apiKey: key };
    assert.equal(await streamCompletion({ config, messages: [{ role: 'user', content: '虚构材料' }], fetchImpl: (...args) => net.fetch(...args) }), '本机宿主测试回答');
    assert.deepEqual(received, [{ path: '/v1/chat/completions', authorization: `Bearer ${key}` }]);
    await assert.rejects(streamCompletion({ config: { ...config, baseUrl: `http://127.0.0.1:${server.address().port}/redirect` },
      messages: [{ role: 'user', content: '虚构重定向材料' }], fetchImpl: (...args) => net.fetch(...args) }), { code: 'NETWORK_ERROR' });
    assert.deepEqual(received.map(item => item.path), ['/v1/chat/completions', '/redirect/chat/completions']);
    console.log(JSON.stringify({ windowsEncryption: true, plaintextHidden: true, electronLocalRequest: true, redirectBlocked: true }));
    await new Promise(resolve => server.close(resolve));
    await shell.trashItem(path.join(root, 'data'));
    app.exit(0);
  } catch (error) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    console.error(error.message);
    try { await shell.trashItem(path.join(root, 'data')); } catch { /* 清理失败时保留隔离目录。 */ }
    app.exit(1);
  }
}).catch(error => { console.error(error.message); app.exit(1); });
