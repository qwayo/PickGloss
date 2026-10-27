'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const { createWindowAppearance, frameCssValues } = require('../../src/windows/window-appearance.cjs');

test('固定光条按物理客户区与四边非客户区补偿，覆盖分数缩放与奇数尺寸', () => {
  for (const dpi of [96, 120, 144, 192, 240, 288]) {
    const metrics = { width: 748, height: 1209, left: 3, top: 0, right: 3, bottom: 3, dpi };
    const css = frameCssValues(metrics), scale = dpi / 96, expected = Math.round(3 * scale);
    assert.ok(Math.abs(parseFloat(css['--native-client-width']) * scale - metrics.width) < .001);
    assert.ok(Math.abs(parseFloat(css['--native-client-height']) * scale - metrics.height) < .001);
    for (const edge of ['left', 'top', 'right', 'bottom']) {
      assert.ok(Math.abs(parseFloat(css[`--native-pin-${edge}`]) * scale + metrics[edge] - expected) < .001, `${dpi} DPI ${edge} 总色带必须一致`);
    }
  }
});

test('无效原生几何不能变成页面样式', () => {
  const valid = { width: 748, height: 1209, left: 3, top: 0, right: 3, bottom: 3, dpi: 240 };
  for (const bad of [null, {}, { ...valid, width: -1 }, { ...valid, dpi: 0 }, { ...valid, left: 0.5 }, { ...valid, top: '0; color:red' }]) assert.equal(frameCssValues(bad), null);
});

function harness(options = {}) {
  const win = new EventEmitter(), child = new EventEmitter(), writes = [], scripts = [], hooks = new Map(), values = new Map();
  Object.assign(win, { isDestroyed: () => false, getNativeWindowHandle: () => { const handle = Buffer.alloc(8); handle.writeBigUInt64LE(123n); return handle; },
    hookWindowMessage: (id, callback) => hooks.set(id, callback), unhookWindowMessage: id => hooks.delete(id) });
  const document = { documentElement: { style: { setProperty: (key, value) => values.set(key, value), removeProperty: key => values.delete(key) } } };
  win.webContents = Object.assign(new EventEmitter(), { executeJavaScript(code) { scripts.push(code); vm.runInNewContext(code, { document }); return Promise.resolve(); } });
  child.stdin = Object.assign(new EventEmitter(), { write(value, done) { writes.push(value); done?.(); }, end() { child.ended = true; } });
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => { child.killed = true; }; child.pid = 5678;
  const errors = [], readyCalls = [], spawns = [];
  const controller = createWindowAppearance(win, { ...options, helperPath: '自有窗口助手.exe', exists: () => true, onReady: () => { readyCalls.push(true); options.onReady?.(); }, onError: error => errors.push(error), spawnHelper(file, args, spawnOptions) {
    spawns.push({ file, args, options: spawnOptions });
    assert.equal(file, '自有窗口助手.exe'); assert.deepEqual(args, ['123', String(process.pid), ...(options.clipRadius !== undefined ? [String(options.clipRadius)] : [])]); assert.equal(spawnOptions.windowsHide, true); return child;
  } });
  return { controller, win, child, writes, scripts, hooks, errors, readyCalls, spawns, values };
}

test('外观助手只接受预定边色，旧响应不覆盖新几何，关闭窗口时释放助手和钩子', () => {
  const h = harness();
  assert.equal(h.controller.apply('none'), true); assert.equal(h.controller.apply('#dc873d'), true);
  assert.equal(h.controller.apply('任意命令'), false);
  const metrics = { width: 748, height: 1209, left: 3, top: 0, right: 3, bottom: 3, dpi: 240 };
  h.child.stdout.emit('data', JSON.stringify({ ...metrics, sequence: 1 }) + '\n');
  assert.equal(h.scripts.length, 0);
  h.child.stdout.emit('data', JSON.stringify({ ...metrics, sequence: 2 }) + '\n');
  assert.equal(h.scripts.length, 1); assert.match(h.scripts[0], /299\.2px/);
  h.win.emit('closed');
  assert.equal(h.child.ended, true); assert.equal(h.child.killed, true); assert.equal(h.hooks.size, 0);
  assert.equal(h.win.webContents.listenerCount('did-finish-load'), 0);
  assert.equal(h.controller.apply('none'), false);
});

test('外观助手异常只回报一次并停止继续写入', () => {
  const h = harness(); h.controller.apply('none');
  h.child.stdout.emit('data', '{坏数据}\n'); h.child.emit('error', new Error('后续错误'));
  assert.equal(h.errors.length, 1); assert.equal(h.child.killed, true); assert.equal(h.controller.apply('none'), false);
});

test('原生窗口已销毁时，清理不再调用已失效的窗口和 webContents 访问器', () => {
  const h = harness();
  h.win.isDestroyed = () => true;
  Object.defineProperty(h.win, 'webContents', { get() { throw new Error('窗口对象已销毁'); } });
  assert.doesNotThrow(() => h.win.emit('closed'));
  assert.equal(h.child.killed, true);
});

test('助手在几何已生效后退出会清除固定尺寸，迟到应答不能恢复旧边框', () => {
  const h = harness(); h.controller.apply('none');
  const metrics = { width: 300, height: 480, left: 0, top: 0, right: 0, bottom: 0, dpi: 96, sequence: 1 };
  h.child.stdout.emit('data', JSON.stringify(metrics) + '\n');
  assert.equal(h.values.get('--native-client-width'), '300px');
  h.child.emit('exit', 1);
  assert.equal(h.errors.length, 1); assert.equal(h.values.size, 0, '回退不能保留旧的固定尺寸或非客户区内孔');
  h.child.stdout.emit('data', JSON.stringify(metrics) + '\n');
  assert.equal(h.values.size, 0, '已退出助手的缓冲应答不得重写旧尺寸');
});

test('默认解释窗口保持两字段协议，不启用翻译工具条背景窗', () => {
  const h = harness(); h.controller.apply('none');
  assert.deepEqual(h.writes, ['1 none\n']);
  assert.equal(h.controller.setBackdrop(true), false);
  assert.equal(h.controller.getBackdropInfo(), null);
  h.controller.dispose();
});

test('仅显式圆角背景参数启动独立材质，启停与取证信息绑定当前助手进程', () => {
  const h = harness({ clipRadius: 14 });
  assert.equal(h.controller.isReady, false);
  assert.equal(h.controller.getBackdropInfo(), null);
  h.controller.apply('none');
  assert.deepEqual(h.writes, ['1 none 0\n'], '默认关闭背景，减少透明或高对比回退不会先露出材质');
  const metrics = { width: 700, height: 280, left: 0, top: 0, right: 0, bottom: 0, dpi: 240,
    backdrop: { handle: '456', pid: 5678, enabled: false, visible: false, radius: 14 } };
  h.child.stdout.emit('data', JSON.stringify({ ...metrics, sequence: 1 }) + '\n');
  assert.equal(h.controller.isReady, true); assert.equal(h.readyCalls.length, 1);
  assert.deepEqual(h.controller.getBackdropInfo(), metrics.backdrop);
  h.controller.setBackdrop(true);
  assert.equal(h.writes.at(-1), '2 none 1\n');
  h.child.stdout.emit('data', JSON.stringify({ ...metrics, sequence: 2, backdrop: { ...metrics.backdrop, enabled: true, visible: true } }) + '\n');
  const snapshot = h.controller.getBackdropInfo(); snapshot.visible = false;
  assert.equal(h.controller.getBackdropInfo().visible, true, '调用者不能改写已核验的助手状态');
  assert.equal(h.readyCalls.length, 1, '重复几何响应不能重复触发就绪');
  h.controller.dispose();
  assert.equal(h.controller.isReady, false); assert.equal(h.controller.getBackdropInfo(), null);
  assert.equal(h.controller.setBackdrop(true), false);
  for (const event of ['show', 'hide', 'resize', 'move', 'minimize', 'restore']) assert.equal(h.win.listenerCount(event), 0);
});

test('圆角背景跟随移动、显隐、最小化与恢复刷新，旧响应不能恢复背景', async () => {
  const h = harness({ clipRadius: 14 });
  h.controller.setBackdrop(true);
  for (const event of ['hide', 'show', 'move', 'resize', 'minimize', 'restore']) {
    const before = h.writes.length; h.win.emit(event);
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(h.writes.length, before + 1, `${event} 必须把当前状态交给独立原生材质`);
  }
  h.child.stdout.emit('data', JSON.stringify({ sequence: 1 }) + '\n');
  assert.equal(h.controller.getBackdropInfo(), null);
  h.child.emit('exit', 1);
  assert.equal(h.errors.length, 1); assert.equal(h.controller.isReady, false);
  assert.equal(h.controller.getBackdropInfo(), null); assert.equal(h.hooks.size, 0);
});

test('无效圆角参数和伪造的背景归属不能启动或留下材质', () => {
  for (const clipRadius of [null, 0, -1, NaN, Infinity, 65, '14', '14;命令']) {
    const h = harness({ clipRadius });
    assert.equal(h.controller, null); assert.equal(h.spawns.length, 0); assert.equal(h.errors.length, 1);
  }
  const metrics = { width: 700, height: 280, left: 0, top: 0, right: 0, bottom: 0, dpi: 240, sequence: 1,
    backdrop: { handle: '456', pid: 5678, enabled: true, visible: true, radius: 14 } };
  for (const backdrop of [null, { ...metrics.backdrop, pid: 9999 }, { ...metrics.backdrop, handle: '0' }, { ...metrics.backdrop, handle: '18446744073709551616' },
    { ...metrics.backdrop, radius: 8 }, { ...metrics.backdrop, enabled: 'true' }, { ...metrics.backdrop, visible: 1 }]) {
    const h = harness({ clipRadius: 14 }); h.controller.setBackdrop(true);
    h.child.stdout.emit('data', JSON.stringify({ ...metrics, backdrop }) + '\n');
    assert.equal(h.errors.length, 1); assert.equal(h.child.killed, true);
    assert.equal(h.controller.getBackdropInfo(), null); assert.equal(h.controller.isReady, false);
  }
});

test('就绪回调更改材质或关闭助手时，当前响应不能再恢复旧样式', () => {
  const metrics = { width: 700, height: 280, left: 0, top: 0, right: 0, bottom: 0, dpi: 240,
    backdrop: { handle: '456', pid: 5678, enabled: false, visible: false, radius: 14 } };
  for (const close of [false, true]) {
    let h;
    h = harness({ clipRadius: 14, onReady() { if (close) h.controller.dispose(); else h.controller.setBackdrop(true); } });
    h.controller.apply('none');
    h.child.stdout.emit('data', JSON.stringify({ ...metrics, sequence: 1 }) + '\n');
    assert.equal(h.values.size, 0, '就绪回调改变状态后不能写入旧响应');
    if (!close) {
      h.child.stdout.emit('data', JSON.stringify({ ...metrics, sequence: 2, backdrop: { ...metrics.backdrop, enabled: true, visible: true } }) + '\n');
      assert.equal(h.values.get('--native-client-width'), '280px');
      assert.equal(h.controller.getBackdropInfo().enabled, true); h.controller.dispose();
    }
  }
});

test('圆角背景助手无响应时会终止，避免留下无法跟随尺寸的背景窗', context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness({ clipRadius: 14 }); h.controller.setBackdrop(true);
  context.mock.timers.tick(5000);
  assert.equal(h.errors.length, 1); assert.match(h.errors[0].message, /未及时应答/);
  assert.equal(h.child.killed, true); assert.equal(h.controller.isReady, false);
  assert.equal(h.controller.getBackdropInfo(), null);
});
