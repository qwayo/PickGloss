'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createBrowserContext, validSource } = require('../../src/windows/browser-context.cjs');

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdin = Object.assign(new EventEmitter(), {
      writable: true, writes: [], ended: false,
      write(value, callback) { this.writes.push(value); callback?.(null); return true; },
      end() { this.ended = true; this.writable = false; },
    });
    this.stdout = Object.assign(new EventEmitter(), { setEncoding(value) { this.encoding = value; } });
    this.stderr = Object.assign(new EventEmitter(), { resume() { this.resumed = true; } });
    this.killed = false; this.killCount = 0;
  }
  send(value) { this.stdout.emit('data', `${typeof value === 'string' ? value : JSON.stringify(value)}\n`); }
  kill() { this.killed = true; this.killCount++; return true; }
}

function fakeTimers() {
  let time = 0, nextId = 0;
  const tasks = new Map();
  return {
    now: () => time,
    setTimer(callback, delay) {
      const timer = { id: ++nextId, due: time + delay, callback, unref() {} };
      tasks.set(timer.id, timer); return timer;
    },
    clearTimer(timer) { if (timer) tasks.delete(timer.id); },
    tick(duration) {
      const end = time + duration;
      while (true) {
        const due = [...tasks.values()].filter(timer => timer.due <= end).sort((a, b) => a.due - b.due || a.id - b.id)[0];
        if (!due) break;
        tasks.delete(due.id); time = due.due; due.callback();
      }
      time = end;
    },
    get pending() { return tasks.size; },
  };
}

function harness(options = {}) {
  const timers = fakeTimers(), children = [], spawns = [], changes = [];
  const bridge = createBrowserContext({ helperPath: 'Edge上下文助手.exe', platform: 'win32', exists: () => true,
    spawnHelper(file, args, spawnOptions) {
      spawns.push({ file, args, spawnOptions });
      const child = new FakeChild(); children.push(child);
      if (options.throwSpawn) throw new Error('此异常不得进入协议或日志');
      return child;
    }, onChange: value => changes.push(value), now: timers.now, setTimer: timers.setTimer, clearTimer: timers.clearTimer,
    ...options });
  return { bridge, timers, children, spawns, changes };
}

const source = { handle: '123456789', pid: 2468 };
const ready = { type: 'ready', valid: true, state: 'active', reason: 'tab' };
const heartbeat = { type: 'heartbeat' };

test('后台预热只启动无来源助手，capture 复用同进程并在 standby 后才交付来源', async () => {
  const h = harness(); h.bridge.prepare(); h.bridge.prepare();
  assert.equal(h.children.length, 1);
  assert.deepEqual(h.spawns[0].args, ['--standby', String(process.pid)]);
  const child = h.children[0], pending = h.bridge.capture(source);
  assert.equal(child.stdin.writes.length, 0, '运行时未就绪不能开始页面查询。');
  child.send({ type: 'standby' });
  assert.deepEqual(child.stdin.writes, [`start ${source.handle} ${source.pid}\n`]);
  child.send(ready);
  assert.deepEqual(await pending, { key: 1, state: 'active', revision: 1 });
  assert.equal(h.children.length, 1, '不能在触发时重新支付进程冷启动。');
  h.bridge.dispose(); h.timers.tick(150); assert.equal(child.killCount, 1);
});

test('预热完成后可以闲置；未就绪超时与闲置 dispose 均清理助手', async () => {
  const h = harness(); h.bridge.prepare(); const child = h.children[0]; child.send({ type: 'standby' });
  h.timers.tick(10000); assert.equal(child.stdin.ended, false, '未绑定页面无需伪造心跳。');
  const pending = h.bridge.capture(source); child.send(ready); await pending;
  h.bridge.dispose(); h.timers.tick(150); assert.equal(child.killCount, 1);
  const failed = harness(); failed.bridge.prepare(); failed.timers.tick(2000); failed.timers.tick(150);
  assert.equal(failed.children[0].killCount, 1);
  const retry = failed.bridge.capture(source); failed.children[1].send(ready); assert.equal((await retry).state, 'active');
  failed.bridge.dispose();
  const idle = harness(); idle.bridge.prepare(); idle.children[0].send({ type: 'standby' }); idle.bridge.dispose(); idle.timers.tick(150);
  assert.equal(idle.children[0].killCount, 1);
});

test('仅在 Windows 且助手存在时启用，并校验来源句柄与进程号', () => {
  assert.equal(createBrowserContext({ platform: 'linux', helperPath: 'helper.exe', exists: () => true }), null);
  assert.equal(createBrowserContext({ platform: 'win32', helperPath: 'helper.exe', exists: () => false }), null);
  assert.deepEqual(validSource(source), source);
  for (const invalid of [null, {}, { handle: '0', pid: 1 }, { handle: '18446744073709551616', pid: 1 },
    { handle: '12;command', pid: 1 }, { handle: '12', pid: 0 }, { handle: '12', pid: 0x100000000 }]) assert.equal(validSource(invalid), null);
});

test('capture 只传 HWND、来源 PID 和 Electron PID；ready 后 checkpoint 用固定 nonce 协议', async () => {
  const h = harness();
  const started = h.bridge.capture(source), child = h.children[0];
  assert.equal(h.spawns[0].file, 'Edge上下文助手.exe');
  assert.deepEqual(h.spawns[0].args, [source.handle, String(source.pid), String(process.pid)]);
  assert.deepEqual(h.spawns[0].spawnOptions, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  assert.equal(child.stderr.resumed, true);
  child.send(ready);
  const bound = await started;
  assert.deepEqual(bound, { key: 1, state: 'active', revision: 1 });
  assert.deepEqual(h.bridge.verify(bound.key), { state: 'active', revision: 1 });

  const checking = h.bridge.checkpoint(bound.key);
  const request = JSON.parse(child.stdin.writes.at(-1));
  assert.deepEqual(Object.keys(request).sort(), ['nonce', 'type']);
  assert.equal(request.type, 'check');
  child.send({ type: 'checkpoint', nonce: request.nonce, valid: true, state: 'active', reason: 'tab' });
  assert.deepEqual(await checking, { state: 'active', revision: 1 });
  assert.equal(h.bridge.release(bound.key), true);
  assert.equal(child.stdin.ended, true, '释放先关闭 stdin，让助手正常退出');
  h.timers.tick(150);
  assert.equal(child.killed, true, '宽限期后强制结束仍未退出的助手');
});

test('接受 C# Console.WriteLine 的 CRLF，拒绝多余回车符', async t => {
  await t.test('单个尾随回车', async () => {
    const h = harness(), pending = h.bridge.capture(source), child = h.children[0];
    child.stdout.emit('data', `${JSON.stringify(ready)}\r\n`);
    assert.deepEqual(await pending, { key: 1, state: 'active', revision: 1 });
  });
  await t.test('额外回车', async () => {
    const h = harness(), pending = h.bridge.capture(source), child = h.children[0];
    child.stdout.emit('data', `${JSON.stringify(ready)}\r\r\n`);
    assert.deepEqual(await pending, { key: 1, state: 'invalid', revision: 1 });
  });
});

test('状态变化递增 revision；相同状态不递增，迟到的旧助手消息不能修改新 capture', async () => {
  const h = harness();
  const firstPromise = h.bridge.capture(source), firstChild = h.children[0]; firstChild.send(ready);
  const first = await firstPromise;
  firstChild.send({ type: 'state', state: 'inactive', reason: 'tab' });
  assert.deepEqual(h.bridge.verify(first.key), { state: 'inactive', revision: 2 });
  firstChild.send({ type: 'state', state: 'inactive', reason: 'tab' });
  assert.deepEqual(h.bridge.verify(first.key), { state: 'inactive', revision: 2 });
  firstChild.send({ type: 'state', state: 'active', reason: 'tab' });
  assert.deepEqual(h.bridge.verify(first.key), { state: 'active', revision: 3 });

  const secondPromise = h.bridge.capture({ handle: '987654321', pid: 8642 }), secondChild = h.children[1];
  assert.equal(firstChild.stdin.ended, true);
  secondChild.send(ready); const second = await secondPromise;
  const before = h.changes.length;
  firstChild.send({ type: 'state', state: 'invalid', reason: 'navigation' });
  assert.equal(h.changes.length, before, '迟到进程不得通知当前绑定');
  assert.deepEqual(h.bridge.verify(second.key), { state: 'active', revision: 1 });
  assert.equal(h.bridge.release(first.key), false, '旧 key 不能释放新进程');
  assert.equal(h.bridge.release(second.key), true);
});

test('助手 ready 无效、启动失败或启动超时均返回 invalid 并关闭本次进程', async t => {
  await t.test('ready 明确拒绝', async () => {
    const h = harness(), pending = h.bridge.capture(source), child = h.children[0];
    child.send({ type: 'ready', valid: false, state: 'invalid', reason: 'ambiguous' });
    assert.deepEqual(await pending, { key: 1, state: 'invalid', revision: 1 });
    assert.equal(h.bridge.verify(1).state, 'invalid'); assert.equal(child.stdin.ended, true);
    child.send(ready); assert.equal(h.bridge.verify(1).state, 'invalid', '无效 ready 之后不能复活');
  });
  await t.test('invalid ready 后 dispose 仍保留卡退助手的强杀', async () => {
    const h = harness(), pending = h.bridge.capture(source), child = h.children[0];
    child.send({ type: 'ready', valid: false, state: 'invalid', reason: 'ambiguous' });
    await pending; h.bridge.dispose(); h.timers.tick(150);
    assert.equal(child.stdin.ended, true);
    assert.equal(child.killCount, 1, 'dispose 不能取消已排定的唯一强杀');
  });
  await t.test('spawn 抛错', async () => {
    const h = harness({ throwSpawn: true });
    assert.deepEqual(await h.bridge.capture(source), { key: 1, state: 'invalid', revision: 1 });
  });
  await t.test('ready 超时', async () => {
    const h = harness(), pending = h.bridge.capture(source);
    h.timers.tick(2000);
    assert.deepEqual(await pending, { key: 1, state: 'invalid', revision: 1 });
    assert.equal(h.children[0].stdin.ended, true);
    h.timers.tick(150); assert.equal(h.children[0].killed, true);
  });
});

test('心跳租约过期立即失效并停止助手；心跳可续租但不能改 revision', async () => {
  const h = harness(), pending = h.bridge.capture(source), child = h.children[0]; child.send(ready);
  const bound = await pending;
  h.timers.tick(1000); child.send(heartbeat); h.timers.tick(1000);
  assert.deepEqual(h.bridge.verify(bound.key), { state: 'active', revision: 1 });
  child.send(heartbeat); h.timers.tick(1499);
  assert.equal(h.bridge.verify(bound.key).state, 'active');
  h.timers.tick(1);
  assert.deepEqual(h.bridge.verify(bound.key), { state: 'invalid', revision: 2 });
  assert.equal(child.stdin.ended, true);
  child.send({ type: 'state', state: 'active', reason: 'tab' });
  assert.equal(h.bridge.verify(bound.key).state, 'invalid', '租约失效后 active 不得复活');
});

test('checkpoint 超时或 nonce 不匹配会锁存 invalid', async t => {
  await t.test('超时', async () => {
    const h = harness(), pending = h.bridge.capture(source), child = h.children[0]; child.send(ready);
    const { key } = await pending, checking = h.bridge.checkpoint(key);
    h.timers.tick(1000);
    assert.deepEqual(await checking, { state: 'invalid', revision: 2 });
    assert.equal(child.stdin.ended, true);
  });
  await t.test('nonce 不匹配', async () => {
    const h = harness(), pending = h.bridge.capture(source), child = h.children[0]; child.send(ready);
    const { key } = await pending, checking = h.bridge.checkpoint(key);
    child.send({ type: 'checkpoint', nonce: '999999', valid: true, state: 'active', reason: 'tab' });
    assert.deepEqual(await checking, { state: 'invalid', revision: 2 });
    assert.equal(child.stdin.ended, true);
  });
});

test('checkpoint 回读到 Tab 暂离/返回会改变 revision；主动 invalidate 锁存失效', async () => {
  const h = harness(), pending = h.bridge.capture(source), child = h.children[0]; child.send(ready);
  const { key } = await pending;
  let checking = h.bridge.checkpoint(key), request = JSON.parse(child.stdin.writes.at(-1));
  child.send({ type: 'checkpoint', nonce: request.nonce, valid: true, state: 'inactive', reason: 'tab' });
  assert.deepEqual(await checking, { state: 'inactive', revision: 2 });

  checking = h.bridge.checkpoint(key); request = JSON.parse(child.stdin.writes.at(-1));
  child.send({ type: 'checkpoint', nonce: request.nonce, valid: true, state: 'active', reason: 'tab' });
  assert.deepEqual(await checking, { state: 'active', revision: 3 });

  assert.equal(h.bridge.invalidate(key), true);
  assert.deepEqual(h.bridge.verify(key), { state: 'invalid', revision: 4 });
  child.send({ type: 'state', state: 'active', reason: 'tab' });
  assert.deepEqual(h.bridge.verify(key), { state: 'invalid', revision: 4 });
  assert.equal(h.bridge.invalidate(key), false);
});

test('协议字段和原因白名单拒绝页面标识；stderr 内容不保留或回传', async () => {
  const h = harness(), pending = h.bridge.capture(source), child = h.children[0]; child.send(ready);
  const bound = await pending;
  child.stderr.emit('data', 'https://private.example/页面标题');
  child.send({ type: 'state', state: 'inactive', reason: 'tab', url: 'https://private.example/secret' });
  assert.deepEqual(h.bridge.verify(bound.key), { state: 'invalid', revision: 2 });
  const serialized = JSON.stringify(h.changes);
  assert.equal(serialized.includes('private.example'), false);
  assert.deepEqual(h.changes.at(-1), { key: 1, state: 'invalid', reason: 'unknown', revision: 2 });
});

test('release 只匹配当前 key，实例可重新 capture，dispose 全部释放', async () => {
  const h = harness(), firstPending = h.bridge.capture(source), firstChild = h.children[0]; firstChild.send(ready);
  const first = await firstPending;
  assert.equal(h.bridge.release(first.key + 1), false); assert.equal(firstChild.stdin.ended, false);
  assert.equal(h.bridge.release(first.key), true); assert.equal(firstChild.stdin.ended, true);
  const secondPending = h.bridge.capture(source), secondChild = h.children[1]; secondChild.send(ready);
  const second = await secondPending;
  h.bridge.dispose(); assert.equal(secondChild.stdin.ended, true);
  const afterDispose = await h.bridge.capture(source);
  assert.deepEqual(afterDispose, { key: 3, state: 'invalid', revision: 1 });
  assert.equal(h.spawns.length, 2);
});
