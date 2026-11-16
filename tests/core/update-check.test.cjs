'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createUpdateCheck } = require('../../src/core/update-check.cjs');

const latest = {
  tag_name: 'v0.10.1', draft: false, prerelease: false,
  assets: [{ name: 'PickGloss-Setup-0.10.1.exe', state: 'uploaded' }],
};

test('更新检查只提示含同版型资产的较新正式版，链接指向官方仓库', async () => {
  for (const [kind, release, phase] of [
    ['setup', latest, 'available'],
    ['portable', latest, 'unavailable'],
    ['setup', { ...latest, prerelease: true }, 'unavailable'],
    ['setup', { ...latest, draft: true }, 'unavailable'],
    ['setup', { ...latest, tag_name: 'v0.9.9' }, 'current'],
  ]) {
    const checker = createUpdateCheck({ kind, version: '0.9.9', onChange() {}, fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.github.com/repos/qwayo/PickGloss/releases/latest');
      assert.equal(options.credentials, 'omit');
      assert.equal(options.redirect, 'error');
      return Response.json({ ...release, html_url: 'https://untrusted.invalid/' });
    } });
    const result = await checker.check();
    assert.equal(result.phase, phase);
    assert.deepEqual(result.available, phase === 'available'
      ? { version: '0.10.1', url: 'https://github.com/qwayo/PickGloss/releases/tag/v0.10.1' } : null);
    checker.dispose();
  }
});

test('启动延迟与六小时轮询生效，手动检查合并请求并复用 ETag', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const requests = [];
  const checker = createUpdateCheck({ kind: 'setup', version: '0.9.9', onChange() {}, fetchImpl: async (_url, { headers }) => {
    requests.push(headers);
    return requests.length === 1 ? Response.json(latest, { headers: { etag: '"test-etag"' } }) : new Response(null, { status: 304 });
  } });
  t.after(() => checker.dispose());
  checker.setAutomatic(true);
  t.mock.timers.tick(19_999);
  assert.equal(requests.length, 0);
  t.mock.timers.tick(1);
  const pending = checker.check();
  assert.strictEqual(checker.check(), pending);
  assert.equal((await pending).phase, 'available');
  t.mock.timers.tick(6 * 60 * 60 * 1000 - 1);
  assert.equal(requests.length, 1);
  t.mock.timers.tick(1);
  assert.equal((await checker.check()).phase, 'available');
  assert.equal(requests[1]['If-None-Match'], '"test-etag"');
  checker.setAutomatic(false);
  t.mock.timers.tick(6 * 60 * 60 * 1000);
  assert.equal(requests.length, 2);
  await checker.check();
  assert.equal(requests.length, 3, '关掉定时检查后仍可手动检查');
});

test('限流后遵守 Retry-After，退出时取消进行中的更新检查', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  let count = 0, inFlight;
  const checker = createUpdateCheck({ kind: 'setup', version: '0.9.9', onChange() {}, fetchImpl: async (_url, { signal }) => {
    count++;
    if (count === 1) return new Response(null, { status: 429, headers: { 'Retry-After': '120' } });
    inFlight = signal;
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  assert.match((await checker.check()).error, /限制检查频率/);
  t.mock.timers.tick(119_999);
  await checker.check();
  assert.equal(count, 1);
  t.mock.timers.tick(1);
  const pending = checker.check();
  assert.equal(count, 2);
  checker.dispose();
  await pending;
  assert.ok(inFlight.aborted);
});
