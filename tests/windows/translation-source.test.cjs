'use strict';
// 用虚构子进程管道核对来源窗口协议，不启动原生助手，也不访问真实窗口。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createTranslationSource, sourceSnapshot, sourceForRegion, windowHandle } = require('../../src/windows/translation-source.cjs');
const { validPhysicalRect } = require('../../src/windows/screen-capture.cjs');

const helperSource = fs.readFileSync(path.join(__dirname, '../../src/windows/TranslationSource.cs'), 'utf8');
const source = { handle: '55', pid: 1234, bounds: { x: -20, y: 30, width: 800, height: 600 } };
const appWindows = { overlay: 101, controls: 102 };
const isWindows = process.platform === 'win32';

function windowSnapshot(handle, bounds, pid = 2345) {
  return { handle: String(handle), pid, bounds };
}

function physicalRect(x, y, width, height) {
  return { x, y, width, height };
}

function handleBuffer(value, bytes = 8) {
  const buffer = Buffer.alloc(bytes);
  if (bytes === 8) buffer.writeBigUInt64LE(BigInt(value));
  else buffer.writeUInt32LE(Number(value));
  return buffer;
}

function appWindow(value) {
  return { getNativeWindowHandle: () => handleBuffer(value) };
}

function harness({ onWrite, onChange, writable = true } = {}) {
  const child = new EventEmitter();
  const writes = [];
  const starts = [];
  child.stdin = Object.assign(new EventEmitter(), {
    writable,
    write(value, done) {
      writes.push(value);
      onWrite?.(value, done);
      if (!onWrite) done?.();
      return true;
    },
    end() { child.ended = true; },
  });
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => { child.kills = (child.kills || 0) + 1; };
  const bridge = createTranslationSource({
    helperPath: '虚构来源助手.exe',
    exists: () => true,
    onChange: onChange || (() => {}),
    spawnHelper(file, args, options) {
      starts.push({ file, args, options });
      return child;
    },
  });
  return { bridge, child, writes, starts };
}

test('来源恢复由独立短命助手执行，只携带身份边界并在取消时终止迟到操作', { skip: !isWindows }, async () => {
  const children = [], starts = [];
  const bridge = createTranslationSource({ helperPath: '虚构来源助手.exe', exists: () => true, spawnHelper(file, args, options) {
    const child = new EventEmitter();
    child.stdin = Object.assign(new EventEmitter(), { writable: true, write(_line, done) { done?.(); }, end() {} });
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => { child.killed = true; };
    children.push(child); starts.push({ args, options }); return child;
  } });
  try {
    const abort = new AbortController();
    const pending = bridge.restore({ ...source, title: '不得传递的标题', text: '不得传递的内容' }, { capture: appWindow(103), signal: abort.signal });
    assert.equal(children.length, 2, '恢复助手与持续监视助手分离');
    assert.deepEqual(starts[1].args, [String(process.pid), 'restore', '55', '1234', '-20', '30', '800', '600', '103']);
    assert.equal(starts[1].options.windowsHide, true);
    abort.abort(); assert.equal(await pending, false); assert.equal(children[1].killed, true);
    send(children[1], { type: 'restore', id: 1, restored: true });
    assert.equal(await pending, false, '取消后的迟到应答不能改为成功');
    const completed = bridge.restore(source, { capture: appWindow(103) });
    send(children[2], { type: 'restore', id: 1, restored: true });
    assert.equal(await completed, true); assert.equal(children[2].killed, true);
  } finally { bridge.dispose(); }
});

function send(child, value) {
  child.stdout.emit('data', Buffer.from(`${JSON.stringify(value)}\n`, 'utf8'));
}

test('页面票据仅归属采图时的同一来源，选到另一Edge窗口不能借用其票据', () => {
  const first = { handle: '991', pid: 111, bounds: { x: 0, y: 0, width: 400, height: 300 }, browserContextRequired: true };
  const other = { handle: '992', pid: 111, bounds: { x: 500, y: 0, width: 400, height: 300 }, browserContextRequired: true };
  const captured = { ...first, pageContext: { key: 7 }, candidates: [other, first] };
  assert.deepEqual(sourceForRegion(captured, { x: 20, y: 20, width: 30, height: 30 }), { ...first, pageContext: { key: 7 } });
  assert.deepEqual(sourceForRegion(captured, { x: 520, y: 20, width: 30, height: 30 }), other);
  assert.equal(sourceSnapshot({ ...first, pageContext: { key: '秘密' } }).pageContext, undefined);
});

function bind(h, value = source) {
  return h.bridge.bind(value, { overlay: appWindow(appWindows.overlay), controls: appWindow(appWindows.controls) });
}

async function settledWithin(promise, milliseconds = 50) {
  let timer;
  return Promise.race([
    promise.then(value => ({ settled: true, value })),
    new Promise(resolve => { timer = setTimeout(() => resolve({ settled: false }), milliseconds); }),
  ]).finally(() => clearTimeout(timer));
}

test('来源快照只保留合法的窗口身份、进程号和物理边界', () => {
  assert.deepEqual(sourceSnapshot({ ...source, extra: '忽略的字段', bounds: { ...source.bounds, extra: true } }), source);
  for (const invalid of [
    null,
    {},
    { ...source, handle: '0' },
    { ...source, handle: '01' },
    { ...source, handle: '-1' },
    { ...source, handle: '18446744073709551616' },
    { ...source, pid: 0 },
    { ...source, pid: 4294967296 },
    { ...source, pid: 1.5 },
    { ...source, bounds: { ...source.bounds, x: 0.5 } },
    { ...source, bounds: { ...source.bounds, y: 200001 } },
    { ...source, bounds: { ...source.bounds, width: 0 } },
    { ...source, bounds: { ...source.bounds, height: 100001 } },
  ]) assert.equal(sourceSnapshot(invalid), null, `应拒绝非法快照：${JSON.stringify(invalid)}`);
});

test('原生窗口句柄按小端无符号值读取，拒绝无效缓冲区', () => {
  assert.equal(windowHandle(appWindow(101)), '101');
  assert.equal(windowHandle({ getNativeWindowHandle: () => handleBuffer(102, 4) }), '102');
  assert.equal(windowHandle({ getNativeWindowHandle: () => Buffer.alloc(3) }), null);
  assert.equal(windowHandle({ getNativeWindowHandle: () => '101' }), null);
  assert.equal(windowHandle(null), null);
});

test('来源采集编号递增且乱序应答仍归还各自快照', { skip: !isWindows }, async () => {
  const h = harness();
  try {
    assert.equal(h.starts.length, 1);
    assert.deepEqual(h.starts[0].args, [String(process.pid)]);
    assert.equal(h.starts[0].options.windowsHide, true);
    const first = h.bridge.capture();
    const second = h.bridge.capture();
    assert.deepEqual(h.writes, ['capture 1\n', 'capture 2\n']);
    send(h.child, { type: 'capture', id: 2, source });
    send(h.child, { type: 'capture', id: 1, source: { ...source, handle: '77' } });
    assert.deepEqual(await Promise.all([first, second]), [
      { ...source, handle: '77' },
      source,
    ]);
  } finally {
    h.bridge?.dispose();
  }
});

test('无效捕获快照返回空值，未知编号的迟到应答不改变其他请求', { skip: !isWindows }, async () => {
  const h = harness();
  try {
    const pending = h.bridge.capture();
    send(h.child, { type: 'capture', id: 99, source });
    send(h.child, { type: 'capture', id: 1, source: { ...source, bounds: { ...source.bounds, width: 0 } } });
    assert.equal(await pending, null);
    assert.equal(h.child.kills || 0, 0);
  } finally {
    h.bridge?.dispose();
  }
});

test('带窗口列表的捕获只返回规范快照与经过校验且限量的候选', { skip: !isWindows }, async () => {
  const h = harness();
  try {
    const small = h.bridge.capture();
    send(h.child, {
      type: 'capture', id: 1,
      source: { ...source, title: '不应返回的标题' },
      windows: [
        { ...windowSnapshot('201', { x: 0, y: 0, width: 800, height: 600 }), title: '不应返回的窗口标题', text: '不应读取的文字' },
        { ...windowSnapshot('202', { x: 800, y: 0, width: 800, height: 600 }), pixels: '不应保留的像素' },
        { ...windowSnapshot('0', { x: 0, y: 0, width: 10, height: 10 }) },
      ],
      atlas: { text: '不应保留的整屏材料' },
    });
    const canonical = await small;
    assert.deepEqual(canonical, {
      ...source,
      candidates: [
        windowSnapshot('201', { x: 0, y: 0, width: 800, height: 600 }),
        windowSnapshot('202', { x: 800, y: 0, width: 800, height: 600 }),
      ],
    });
    assert.equal('atlas' in canonical, false);
    assert.equal('title' in canonical, false);

    const many = h.bridge.capture();
    const windows = Array.from({ length: 70 }, (_, index) => ({
      ...windowSnapshot(String(300 + index), { x: index * 10, y: 0, width: 100, height: 100 }),
      title: '不得透传的窗口标题',
    }));
    send(h.child, { type: 'capture', id: 2, source, windows, atlas: ['整屏内容'] });
    const bounded = await many;
    assert.ok(bounded.candidates.length <= 64);
    assert.ok(bounded.candidates.length > 0);
    assert.ok(bounded.candidates.every(item => Object.keys(item).sort().join(',') === 'bounds,handle,pid'));
    assert.equal('atlas' in bounded, false);
  } finally {
    h.bridge?.dispose();
  }
});

test('截图时前台窗口 A 未覆盖并排 B 的选区时归属给 B', () => {
  const foreground = windowSnapshot('401', { x: 0, y: 0, width: 1000, height: 800 });
  const beside = windowSnapshot('402', { x: 1000, y: 0, width: 1000, height: 800 });
  const captured = { ...foreground, candidates: [foreground, beside] };
  assert.equal(sourceForRegion(captured, physicalRect(1120, 40, 320, 240)).handle, '402');
});

test('跨显示器与负坐标选区按候选窗口边界归属', () => {
  const foreground = windowSnapshot('411', { x: 0, y: 0, width: 1920, height: 1080 });
  const leftMonitor = windowSnapshot('412', { x: -1600, y: -100, width: 1600, height: 900 });
  const rightMonitor = windowSnapshot('413', { x: 1920, y: 0, width: 2560, height: 1440 });
  const captured = { ...foreground, candidates: [foreground, leftMonitor, rightMonitor] };
  assert.equal(sourceForRegion(captured, physicalRect(-1450, 80, 360, 240)).handle, '412');
  assert.equal(sourceForRegion(captured, physicalRect(2240, 140, 500, 300)).handle, '413');
});

test('横跨多个窗口或被前景窗口部分遮挡的选区不归属给背景窗口', () => {
  const left = windowSnapshot('421', { x: 0, y: 0, width: 100, height: 100 });
  const right = windowSnapshot('422', { x: 100, y: 0, width: 100, height: 100 });
  assert.equal(sourceForRegion({ candidates: [left, right] }, physicalRect(90, 10, 20, 30)), null);

  const occluder = windowSnapshot('423', { x: 100, y: 100, width: 100, height: 100 });
  const background = windowSnapshot('424', { x: 0, y: 0, width: 400, height: 400 });
  assert.equal(sourceForRegion({ candidates: [occluder, background] }, physicalRect(50, 130, 100, 30)), null);
});

test('物理矩形非法或没有命中候选时返回空值', () => {
  const candidate = windowSnapshot('431', { x: -100, y: -100, width: 500, height: 500 });
  const captured = { candidates: [candidate] };
  const invalidRects = [
    null,
    {},
    physicalRect(Number.NaN, 0, 10, 10),
    physicalRect(0.5, 0, 10, 10),
    physicalRect(0, 0, 0, 10),
    physicalRect(0, 0, 16385, 10),
    physicalRect(2147483648, 0, 10, 10),
  ];
  for (const region of invalidRects) {
    assert.ok(!validPhysicalRect(region), `测试输入必须违反物理矩形约定：${JSON.stringify(region)}`);
    assert.equal(sourceForRegion(captured, region), null, `非法选区不得绑定来源窗口：${JSON.stringify(region)}`);
  }
  assert.equal(sourceForRegion(captured, physicalRect(500, 500, 20, 20)), null);
  assert.equal(sourceForRegion({ candidates: [] }, physicalRect(0, 0, 10, 10)), null);
});

test('没有候选窗口时仅在原前台快照完整包含选区时使用兼容回退', () => {
  const foreground = windowSnapshot('441', { x: -200, y: 50, width: 600, height: 400 });
  assert.deepEqual(sourceForRegion(foreground, physicalRect(-150, 80, 120, 100)), foreground);
  assert.equal(sourceForRegion(foreground, physicalRect(350, 80, 120, 100)), null);
  assert.equal(sourceForRegion({ ...foreground, candidates: [] }, physicalRect(-150, 80, 120, 100)), null);
});

test('绑定行按 C# 命令解析器的字段顺序携带来源与两个本应用窗口句柄', { skip: !isWindows }, () => {
  const h = harness();
  try {
    assert.equal(bind(h), 1);
    const line = h.writes[0].trimEnd();
    const fields = line.split(' ');
    assert.deepEqual(fields, ['bind', '1', '55', '1234', '-20', '30', '800', '600', '2', '101', '102']);
    assert.equal(fields.length, 11);
    assert.deepEqual(fields.slice(9), ['101', '102']);

    // 对照原生解析器的实际索引，避免 JS 和 C# 两侧协议各自漂移。
    assert.match(helperSource, /p\.Length\s*!=\s*11\s*\|\|\s*p\[0\]\s*!=\s*"bind"/);
    assert.match(helperSource, /long\s+next\s*=\s*Number\(p\[1\]\)[\s\S]*?IntPtr\s+s\s*=\s*new\s+IntPtr\(Number\(p\[2\]\)\),\s*a\s*=\s*new\s+IntPtr\(Number\(p\[9\]\)\),\s*b\s*=\s*new\s+IntPtr\(Number\(p\[10\]\)\)/);
    assert.match(helperSource, /uint\s+pid\s*=\s*uint\.Parse\(p\[3\]/);
    assert.match(helperSource, /int\s+x\s*=\s*int\.Parse\(p\[4\][\s\S]*?y\s*=\s*int\.Parse\(p\[5\][\s\S]*?width\s*=\s*int\.Parse\(p\[6\][\s\S]*?height\s*=\s*int\.Parse\(p\[7\]/);
    assert.match(helperSource, /p\[8\]\s*!=\s*"2"/);
  } finally {
    h.bridge?.dispose();
  }
});

test('旧绑定的迟到状态事件不能覆盖新绑定，清除后状态事件全部隔离', { skip: !isWindows }, () => {
  const changes = [];
  const h = harness({ onChange: event => changes.push(event) });
  try {
    assert.equal(bind(h, source), 1);
    assert.equal(bind(h, { ...source, handle: '77' }), 2);
    send(h.child, { type: 'state', binding: 1, state: 'active' });
    send(h.child, { type: 'state', binding: 2, state: 'inactive' });
    send(h.child, { type: 'state', binding: 2, state: '未知状态' });
    assert.deepEqual(changes, [{ binding: 2, state: 'inactive' }]);
    h.bridge.clear();
    send(h.child, { type: 'state', binding: 2, state: 'active' });
    assert.deepEqual(changes, [{ binding: 2, state: 'inactive' }]);
    assert.equal(h.writes.at(-1), 'clear\n');
  } finally {
    h.bridge?.dispose();
  }
});

test('畸形或超长助手输出会关闭助手并让待处理采集失败关闭', { skip: !isWindows }, async t => {
  for (const scenario of ['畸形 JSON', '超长输出']) {
    await t.test(scenario, async () => {
      const changes = [];
      const h = harness({ onChange: event => changes.push(event) });
      try {
        assert.equal(bind(h), 1);
        const pending = h.bridge.capture();
        if (scenario === '畸形 JSON') h.child.stdout.emit('data', Buffer.from('{坏 JSON}\n'));
        else h.child.stdout.emit('data', Buffer.from('x'.repeat(16385)));
        assert.equal(await pending, null);
        assert.equal(h.child.kills, 1);
        assert.equal(h.child.ended, true);
        assert.deepEqual(changes, [{ binding: 1, state: 'unavailable' }]);
        assert.equal(await h.bridge.capture(), null);
      } finally {
        h.bridge?.dispose();
      }
    });
  }
});

test('助手退出或输入管道报错会立即结束待处理采集并报告不可用', { skip: !isWindows }, async t => {
  for (const failure of ['助手错误', '助手退出', '输入管道错误', '输入写入回调错误']) {
    await t.test(failure, async () => {
      const changes = [];
      const h = harness({
        onChange: event => changes.push(event),
        onWrite: (_line, done) => done?.(),
      });
      try {
        assert.equal(bind(h), 1);
        const pending = h.bridge.capture();
        if (failure === '助手错误') h.child.emit('error', new Error('虚构助手错误'));
        else if (failure === '助手退出') h.child.emit('exit', 1);
        else if (failure === '输入管道错误') h.child.stdin.emit('error', new Error('虚构输入管道错误'));
        else {
          // 当前 harness 的正常写入回调没有错误；用一个后续请求模拟异步写入失败。
          h.child.stdin.write = (line, done) => { h.writes.push(line); done?.(new Error('虚构写入错误')); return true; };
          const failed = h.bridge.capture();
          assert.equal(await failed, null);
        }
        const outcome = await settledWithin(pending);
        assert.deepEqual(outcome, { settled: true, value: null });
        assert.equal(h.child.kills, 1);
        assert.equal(h.child.ended, true);
        assert.deepEqual(changes, [{ binding: 1, state: 'unavailable' }]);
      } finally {
        h.bridge?.dispose();
      }
    });
  }
});

test('输出管道错误或结束会立即失败关闭，不留下悬挂采集', { skip: !isWindows }, async t => {
  for (const event of ['错误', '结束']) {
    await t.test(event, async () => {
      const changes = [];
      const h = harness({ onChange: value => changes.push(value) });
      try {
        assert.equal(bind(h), 1);
        const pending = h.bridge.capture();
        assert.doesNotThrow(() => {
          if (event === '错误') h.child.stdout.emit('error', new Error('虚构输出管道错误'));
          else h.child.stdout.emit('end');
        });
        const outcome = await settledWithin(pending);
        assert.deepEqual(outcome, { settled: true, value: null });
        assert.equal(h.child.kills, 1);
        assert.deepEqual(changes, [{ binding: 1, state: 'unavailable' }]);
      } finally {
        h.bridge?.dispose();
      }
    });
  }
});

test('释放桥接会清理待处理采集，迟到应答不能恢复绑定状态', { skip: !isWindows }, async () => {
  const changes = [];
  const h = harness({ onChange: event => changes.push(event) });
  assert.equal(bind(h), 1);
  const pending = h.bridge.capture();
  h.bridge.dispose();
  h.bridge.dispose();
  assert.equal(await pending, null);
  send(h.child, { type: 'capture', id: 2, source });
  send(h.child, { type: 'state', binding: 1, state: 'active' });
  assert.deepEqual(changes, []);
  assert.equal(h.child.ended, true);
  assert.equal(h.child.kills, 1);
  assert.equal(await h.bridge.capture(), null);
});
