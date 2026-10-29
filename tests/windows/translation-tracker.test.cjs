'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTranslationTracker } = require('../../src/windows/translation-tracker.cjs');
const source = { handle: '10', pid: 99, bounds: { x: 0, y: 0, width: 600, height: 400 }, browserContextRequired: true };
function harness() {
  let windowChange, sequence = 0, current = source; const clients = [], changes = [];
  const windowClient = { capture: async () => ({ ...current }), bind: () => ++sequence, restore: async () => true, clear() {}, dispose() {} };
  const tracker = createTranslationTracker({ onChange: value => changes.push(value), windowFactory(options) { windowChange = options.onChange; return windowClient; },
    browserFactory({ onChange }) {
      const client = { disposed: false, prepared: false, state: 'active', revision: 0, onChange, prepare() { client.prepared = true; },
        capture: async () => ({ key: 1, state: client.state, revision: client.revision }),
        checkpoint: async () => ({ state: client.state, revision: client.revision }),
        invalidate() { client.state = 'invalid'; }, dispose() { client.disposed = true; } };
      clients.push(client); return client;
    } });
  return { tracker, clients, changes, window(state, binding = sequence) { windowChange({ binding, state }); },
    page(state, revision = 0, index = clients.length - 1, reason = 'tab') { const client = clients[index]; client.state = state; client.revision = revision; client.onChange({ key: 1, state, revision, reason }); },
    source(value) { current = value; } };
}

test('空闲预热不查询来源页面，随后 Edge capture 复用预热客户端，退出时释放闲置助手', async () => {
  const h = harness(); h.tracker.prepare(); h.tracker.prepare();
  assert.equal(h.clients.length, 1); assert.equal(h.clients[0].prepared, true);
  assert.equal(h.changes.length, 0);
  const captured = await h.tracker.capture(); assert.equal(h.clients.length, 1);
  await h.tracker.sealCapture(captured); h.tracker.bind(captured, {}); h.window('active');
  h.tracker.prepare(); assert.equal(h.clients.length, 2);
  h.tracker.dispose(); assert.ok(h.clients.every(client => client.disposed));
});
test('窗口与页面都匹配才显示：切标签隐藏、回原标签恢复，切其他应用仍隐藏', async () => {
  const h = harness(), captured = await h.tracker.capture();
  assert.equal(await h.tracker.sealCapture(captured), true);
  h.tracker.bind(captured, {}); h.window('active');
  h.page('inactive', 1); h.page('active', 2); h.window('inactive'); h.page('active', 2); h.window('active');
  assert.deepEqual(h.changes.map(value => value.state), ['active', 'inactive', 'active', 'inactive', 'active']);
  h.tracker.dispose();
});
test('采图前后页面代际变化不能把截图绑定到新页面', async () => {
  const h = harness(), captured = await h.tracker.capture();
  h.page('inactive', 1); h.page('active', 2);
  assert.equal(await h.tracker.sealCapture(captured), false);
  h.tracker.bind(captured, {}); h.window('active');
  assert.equal(h.changes.at(-1).state, 'context-invalid'); h.tracker.dispose();
});
test('导航、滚动或租约失效后锁存，即使迟到active也不能恢复；后台不带出菜单', async () => {
  const h = harness(), captured = await h.tracker.capture(); await h.tracker.sealCapture(captured);
  h.tracker.bind(captured, {}); h.window('active'); h.page('invalid', 1); h.page('active', 2);
  assert.equal(h.changes.at(-1).state, 'context-invalid');
  h.window('inactive'); assert.equal(h.changes.at(-1).state, 'inactive');
  h.window('active'); assert.equal(h.changes.at(-1).state, 'context-invalid'); h.tracker.dispose();
});
test('取消新截图只释放待定上下文，不破坏已绑定旧翻译', async () => {
  const h = harness(), first = await h.tracker.capture(); await h.tracker.sealCapture(first);
  h.tracker.bind(first, {}); h.window('active');
  const second = await h.tracker.capture(); h.tracker.cancelCapture(second);
  assert.equal(h.clients[0].disposed, false); assert.equal(h.clients[1].disposed, true);
  h.page('inactive', 1, 0); assert.equal(h.changes.at(-1).state, 'inactive'); h.tracker.dispose();
});
test('新窗口绑定前的clear保留待定页面，旧事件不能影响新绑定', async () => {
  const h = harness(), first = await h.tracker.capture(); await h.tracker.sealCapture(first);
  h.tracker.bind(first, {}); h.window('active');
  const second = await h.tracker.capture(); await h.tracker.sealCapture(second); h.tracker.clear();
  assert.equal(h.clients[0].disposed, true); assert.equal(h.clients[1].disposed, false);
  h.tracker.bind(second, {}); h.window('active'); h.page('invalid', 1, 0); h.window('moved', 1);
  assert.equal(h.changes.at(-1).state, 'active'); h.tracker.dispose();
});
test('缺少截图时的可信页面票据或未封存时关闭覆盖，普通桌面不启动UIA', async () => {
  const h = harness(); h.tracker.bind(source, {}); h.window('active');
  assert.equal(h.changes.at(-1).state, 'context-invalid');
  h.source({ handle: '20', pid: 98, bounds: source.bounds });
  const desktop = await h.tracker.capture(); assert.equal(h.clients.length, 0);
  assert.equal(await h.tracker.sealCapture(desktop), true);
  h.tracker.bind(desktop, {}); h.window('active'); assert.equal(h.changes.at(-1).state, 'active'); h.tracker.dispose();
});
