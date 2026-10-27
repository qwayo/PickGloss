'use strict';
// 仅使用虚构管道和像素，不启动原生助手，不访问真实屏幕。
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createScreenCapture, validPhysicalRect } = require('../../src/windows/screen-capture.cjs');

function packet({ kind = 0, id = 0, width = 0, height = 0, payload = Buffer.alloc(0), length = payload.length, microseconds = 0 } = {}) {
  const header = Buffer.alloc(32); header.write('PGSC'); header.writeUInt16LE(1, 4); header.writeUInt16LE(kind, 6);
  header.writeUInt32LE(id, 8); header.writeUInt32LE(width, 12); header.writeUInt32LE(height, 16); header.writeUInt32LE(length, 20); header.writeUInt32LE(microseconds, 24);
  return Buffer.concat([header, payload]);
}
function harness(options = {}) {
  const child = new EventEmitter(), writes = [], starts = [];
  child.stdin = Object.assign(new EventEmitter(), { write(value, done) { writes.push(value); done?.(); return true; }, end() { child.ended = true; } });
  child.stdout = new EventEmitter(); child.stderr = Object.assign(new EventEmitter(), { resume() {} }); child.kill = () => { child.kills = (child.kills || 0) + 1; };
  const capture = createScreenCapture({ helperPath: '虚构屏幕助手.exe', platform: 'win32', exists: () => true,
    spawnHelper(file, args, spawnOptions) { starts.push({ file, args, spawnOptions }); return child; }, ...options });
  return { capture, child, writes, starts };
}
async function ready(h) { const pending = h.capture.prepare(); h.child.stdout.emit('data', packet()); await pending; }
const rect = { x: -2, y: 0, width: 2, height: 1 }, pixels = Buffer.from([10, 20, 30, 255, 40, 50, 60, 255]);
const tick = () => Promise.resolve();
function reply(h, id = 1) { h.child.stdout.emit('data', packet({ kind: 1, id, width: 2, height: 1, payload: pixels, microseconds: 1250 })); }

test('矩形限制允许负坐标和完整 8K 位图，拒绝非法尺寸及内存越界', () => {
  for (const value of [rect, { x: 0, y: 0, width: 7680, height: 4320 }, { x: 0, y: 0, width: 16384, height: 2048 }]) assert.equal(validPhysicalRect(value), true);
  for (const value of [null, {}, { ...rect, x: NaN }, { ...rect, y: .5 }, { ...rect, width: 0 }, { ...rect, width: 16385 },
    { ...rect, x: 2147483647 }, { x: 0, y: 0, width: 16384, height: 2049 }]) assert.ok(!validPhysicalRect(value));
});

test('非 Windows 或助手缺失时返回空值，不启动进程', () => {
  const spawnHelper = () => { throw Error('不应启动'); };
  assert.equal(createScreenCapture({ platform: 'linux', exists: () => true, spawnHelper }), null);
  assert.equal(createScreenCapture({ platform: 'win32', exists: () => false, spawnHelper }), null);
});

test('预热延迟启动隐藏进程，只有就绪握手且不会发送采集命令', async () => {
  const h = harness(); assert.equal(h.starts.length, 0);
  const first = h.capture.prepare(); assert.equal(h.capture.prepare(), first);
  assert.equal(h.starts.length, 1); assert.equal(h.starts[0].file, '虚构屏幕助手.exe');
  assert.deepEqual(h.starts[0].args, [String(process.pid)]); assert.equal(h.starts[0].spawnOptions.windowsHide, true);
  assert.deepEqual(h.writes, []);
  const bytes = packet();
  for (const byte of bytes) h.child.stdout.emit('data', Buffer.from([byte]));
  await first; assert.deepEqual(h.writes, []); h.capture.dispose();
});

test('BGRA 帧支持任意头部及正文分片，尺寸、字节与原生耗时正确返回', async () => {
  const h = harness(); await ready(h);
  const pending = h.capture.capture(rect); await tick();
  assert.equal(h.writes[0], 'C 1 -2 0 2 1\n');
  const bytes = packet({ kind: 1, id: 1, width: 2, height: 1, payload: pixels, microseconds: 1250 });
  for (const [start, end] of [[0, 5], [5, 19], [19, 33], [33, 35], [35, bytes.length]]) h.child.stdout.emit('data', bytes.subarray(start, end));
  const result = await pending;
  assert.deepEqual(result, { bitmap: pixels, width: 2, height: 1, nativeMilliseconds: 1.25 });
  h.capture.dispose();
});

test('同一时刻只允许一个请求，完成后可复用进程与新请求编号', async () => {
  const h = harness(); await ready(h);
  const first = h.capture.capture(rect); await tick();
  await assert.rejects(h.capture.capture(rect), /已有截图/); assert.equal(h.writes.length, 1);
  reply(h); await first;
  const second = h.capture.capture(rect); await tick(); reply(h, 2); await second;
  assert.equal(h.starts.length, 1); assert.match(h.writes[1], /^C 2 /); h.capture.dispose();
});

test('预热等待期间调用方修改矩形不会扩大已经授权的采集范围', async () => {
  const h = harness(), request = { ...rect };
  const pending = h.capture.capture(request); request.width = 16000;
  h.child.stdout.emit('data', packet()); await tick();
  assert.equal(h.writes[0], 'C 1 -2 0 2 1\n'); reply(h); await pending; h.capture.dispose();
});

test('非法输入在进程启动前拒绝', async () => {
  const h = harness(); await assert.rejects(h.capture.capture({ ...rect, height: 0 }), /物理矩形/);
  assert.equal(h.starts.length, 0); h.capture.dispose();
});

test('错误编号、位图尺寸或超长帧立即拒绝，不接受旧请求数据', async () => {
  for (const fields of [{ id: 2 }, { width: 3 }, { length: 0xffffffff }, { kind: 3 }]) {
    const h = harness(); await ready(h); const pending = h.capture.capture(rect); await tick();
    h.child.stdout.emit('data', packet({ kind: 1, id: 1, width: 2, height: 1, length: 8, ...fields }));
    await assert.rejects(pending, /截图助手/); assert.equal(h.child.kills, 1);
  }
});

test('助手返回受控错误时拒绝本次捕获，后续有效请求仍可成功', async () => {
  const h = harness(); await ready(h); const failed = h.capture.capture(rect); await tick();
  h.child.stdout.emit('data', packet({ kind: 2, id: 1, payload: Buffer.from('不是完整显示器') }));
  await assert.rejects(failed, /完整显示器/);
  const recovered = h.capture.capture(rect); await tick(); reply(h, 2); await recovered; h.capture.dispose();
});

test('协议就绪帧格式错误时停止助手且不发送采集命令', async () => {
  const h = harness(); const preparing = h.capture.prepare();
  h.child.stdout.emit('data', packet({ id: 1 }));
  await assert.rejects(preparing, /就绪应答/); assert.equal(h.child.kills, 1); assert.equal(h.writes.length, 0);
});

test('半帧期间进程退出或管道结束，等待者失败并释放助手', async () => {
  for (const event of ['exit', 'end']) {
    const h = harness(); await ready(h); const pending = h.capture.capture(rect); await tick();
    h.child.stdout.emit('data', packet({ kind: 1, id: 1, width: 2, height: 1, length: 8 }).subarray(0, 32));
    if (event === 'exit') h.child.emit('exit', 1); else h.child.stdout.emit('end');
    await assert.rejects(pending, /退出|管道/); assert.equal(h.child.kills, 1);
  }
});

test('输入、输出和错误管道异常均可拒绝等待者，不触发未处理错误', async () => {
  for (const stream of ['stdin', 'stdout', 'stderr']) {
    const h = harness(); await ready(h); const pending = h.capture.capture(rect); await tick();
    assert.doesNotThrow(() => h.child[stream].emit('error', new Error('虚构管道异常')));
    await assert.rejects(pending, /管道异常/); assert.equal(h.child.kills, 1);
    assert.doesNotThrow(() => h.child[stream].emit('error', new Error('关闭后的迟到错误')));
  }
  for (const stream of ['stdin', 'stdout']) {
    const h = harness(); await ready(h); const pending = h.capture.capture(rect); await tick();
    h.child[stream].emit('close'); await assert.rejects(pending, /管道已关闭/); assert.equal(h.child.kills, 1);
  }
});

test('启动和取图超时均拒绝并关闭进程，不留下永久等待', async () => {
  // 虚构管道不持有事件循环资源，额外计时器让被测超时有机会触发。
  const keepAlive = setTimeout(() => {}, 500);
  try {
    const cold = harness({ startupTimeoutMs: 10 }); await assert.rejects(cold.capture.prepare(), /预热超时/);
    assert.equal(cold.child.kills, 1); await assert.rejects(cold.capture.prepare(), /预热超时/); assert.equal(cold.starts.length, 1);
    const warm = harness({ captureTimeoutMs: 10 }); await ready(warm);
    const pending = warm.capture.capture(rect); await tick();
    warm.child.stdout.emit('data', packet({ kind: 1, id: 1, width: 2, height: 1, length: 8 }).subarray(0, 32));
    await assert.rejects(pending, /读取超时/); assert.equal(warm.child.kills, 1);
    reply(warm); await assert.rejects(warm.capture.capture(rect), /读取超时/);
  } finally { clearTimeout(keepAlive); }
});

test('关闭会拒绝预热或进行中的捕获，迟到数据不再恢复状态', async () => {
  const cold = harness(), starting = cold.capture.prepare(); cold.capture.dispose(); cold.capture.dispose();
  await assert.rejects(starting, /已关闭/); assert.equal(cold.child.kills, 1);
  const warm = harness(); await ready(warm); const pending = warm.capture.capture(rect); await tick(); warm.capture.dispose();
  await assert.rejects(pending, /已关闭/); reply(warm); await assert.rejects(warm.capture.capture(rect), /已关闭/);
  assert.equal(warm.child.ended, true); assert.equal(warm.child.kills, 1);
});
