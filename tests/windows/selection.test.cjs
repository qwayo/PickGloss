'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

// 执行真实选区工作进程逻辑；用事件代替鼠标和 UIA，不读取桌面内容。
function selectionWorker() {
  const messages = [], children = [];
  let hook;
  class Hook extends EventEmitter {
    static SelectionMethod = { CLIPBOARD: 99 };
    static INVALID_COORDINATE = -9999;
    constructor() { super(); hook = this; }
    disableClipboard() {}
    start() { return true; }
  }
  const parentPort = Object.assign(new EventEmitter(), { postMessage: value => messages.push(value) });
  const source = path.join(__dirname, '../../src/windows/selection-worker.cjs');
  vm.runInNewContext(fs.readFileSync(source, 'utf8'), {
    require: name => name === 'selection-hook' ? Hook : name === 'node:child_process' ? {
      spawn() {
        const child = Object.assign(new EventEmitter(), {
          stdout: Object.assign(new EventEmitter(), { setEncoding() {} }),
          stdin: Object.assign(new EventEmitter(), { write(value) { child.input = value; }, end(value) { child.input = value; child.inputEnded = true; } }),
          kill() { child.killed = true; },
        });
        children.push(child); return child;
      },
    } : require(name),
    process: { parentPort, argv: ['', '', '测试助手', ''] },
    setTimeout() {}, clearTimeout() {}, setInterval() {}, clearInterval() {},
  });
  return { messages, children,
    select: (text, point = { x: 240, y: 360 }) => hook.emit('text-selection', { text, method: 1, mousePosEnd: point }),
    scroll: () => hook.emit('mouse-wheel', { x: 240, y: 360 }),
    cancel: kind => kind === 'Escape' ? hook.emit('key-down', { uniKey: 'Escape' }) : hook.emit('mouse-down', { x: 10, y: 10 }),
    command: data => parentPort.emit('message', { data }),
  };
}

test('段落助手只读取一次材料，不保持位置跟随进程', () => {
  const worker = selectionWorker();
  worker.select('compound');
  const probe = worker.children[0];
  assert.notEqual(JSON.parse(probe.input).track, true);
  assert.equal(probe.inputEnded, true, '一次读取后关闭输入，不保留跟随管道');
  const result = JSON.stringify({ valid: true, text: 'compound', context: 'Small changes compound over time.' });
  probe.stdout.emit('data', result.slice(0, 17));
  probe.stdout.emit('data', result.slice(17));
  probe.emit('close');
  const selected = worker.messages.find(message => message.type === 'selection');
  assert.equal(selected.text, 'compound');
  assert.equal(selected.context, 'Small changes compound over time.');
  assert.equal(worker.messages.filter(message => message.type === 'selection').length, 1);
  assert.equal(worker.messages.some(message => message.type === 'selection-ended'), false, '助手正常退出不取消已采集的材料');
});

test('旧段落读取迟到不能覆盖新划词', () => {
  const worker = selectionWorker();
  worker.select('compound');
  const old = worker.children[0];
  worker.select('retain');
  const current = worker.children[1];
  old.stdout.emit('data', JSON.stringify({ valid: true, text: 'compound' }));
  old.emit('close');
  current.stdout.emit('data', JSON.stringify({ valid: true, text: 'retain' }));
  current.emit('close');
  assert.equal(old.killed, true);
  assert.deepEqual(worker.messages.filter(message => message.type === 'selection').map(message => message.text), ['retain']);
});

test('段落读取延迟时仍保留松开瞬间的坐标，不使用段落锚点或后来鼠标位置', () => {
  const worker = selectionWorker(), released = { x: 700, y: 420 };
  worker.select('EXA', released); released.x = 900; released.y = 600;
  worker.scroll();
  worker.children[0].stdout.emit('data', JSON.stringify({ valid: true, text: 'EXA', point: { x: 10, y: 20 }, anchor: { point: { x: 30, y: 40 } } }));
  worker.children[0].emit('close');
  assert.deepEqual(JSON.parse(JSON.stringify(worker.messages.find(message => message.type === 'selection').point)), { x: 700, y: 420 });
});

test('主动进入其他流程后，旧段落结果失效且后续新划词仍可用', () => {
  const worker = selectionWorker();
  worker.select('compound');
  const old = worker.children[0];
  worker.command({ type: 'cancel-pending' });
  old.stdout.emit('data', JSON.stringify({ valid: true, text: 'compound' }));
  old.emit('close');
  assert.equal(old.killed, true);
  assert.equal(worker.messages.some(message => message.type === 'selection'), false);
  assert.equal(worker.messages.at(-1).type, 'pending-cancelled');

  worker.select('retain');
  const current = worker.children[1];
  current.stdout.emit('data', JSON.stringify({ valid: true, text: 'retain' }));
  current.emit('close');
  assert.deepEqual(worker.messages.filter(message => message.type === 'selection').map(message => message.text), ['retain']);
});

test('滚动不关闭划词入口，也不作废正在复核的选区', () => {
  const worker = selectionWorker();
  worker.select('compound');
  const probe = worker.children[0];
  worker.scroll();
  assert.notEqual(probe.killed, true, '滚动期间应继续复核原选区');
  probe.stdout.emit('data', JSON.stringify({ valid: true, text: 'compound', context: 'Small changes compound over time.' }));
  probe.emit('close');
  worker.scroll();
  const selections = worker.messages.filter(message => message.type === 'selection');
  assert.equal(selections.length, 1);
  assert.equal(selections[0].text, 'compound');
  assert.equal(worker.messages.some(message => message.type === 'dismiss'), false, '滚动前后都不应发送关闭入口事件');
});

test('点击别处与 Esc 仍取消待完成的复核，迟到结果不能恢复旧入口', () => {
  for (const kind of ['pointer', 'Escape']) {
    const worker = selectionWorker();
    worker.select('旧选区');
    const probe = worker.children[0];
    worker.cancel(kind);
    probe.stdout.emit('data', JSON.stringify({ valid: true, text: '旧选区', context: '旧段落' }));
    probe.emit('close');
    assert.equal(probe.killed, true);
    assert.equal(worker.messages.some(message => message.type === 'selection'), false);
    assert.equal(worker.messages.at(-1).type, kind === 'Escape' ? 'dismiss' : 'pointer-down');
  }
});

test('超限划词保留可点击的提示入口，不传送原文、不启动段落读取', () => {
  const worker = selectionWorker();
  worker.select('字'.repeat(12001));
  const warning = worker.messages.find(message => message.type === 'selection-too-long');
  assert.ok(warning, '超过上限时应通知桌面入口，而不是静默消失');
  assert.deepEqual(JSON.parse(JSON.stringify(warning.point)), { x: 240, y: 360 });
  assert.equal('text' in warning, false);
  assert.equal(worker.children.length, 0);
});

test('新的超限选区会作废先前仍在读取的结果', () => {
  const worker = selectionWorker();
  worker.select('先前选区');
  const old = worker.children[0];
  worker.select('字'.repeat(12001));
  old.stdout.emit('data', JSON.stringify({ valid: true, text: '先前选区', context: '先前段落' }));
  old.emit('close');
  assert.equal(old.killed, true);
  assert.equal(worker.messages.some(message => message.type === 'selection'), false);
});

test('边界内选区继续进行 UIA 复核并传递上下文缺失原因', () => {
  const worker = selectionWorker();
  const text = '字'.repeat(12000);
  worker.select(text);
  assert.equal(worker.children.length, 1);
  assert.equal(JSON.parse(worker.children[0].input).text, text);
  worker.children[0].stdout.emit('data', JSON.stringify({ valid: true, text, context: '', reason: '所在段落超过 6000 个字符，请手动精简上下文。' }));
  worker.children[0].emit('close');
  assert.match(worker.messages.find(message => message.type === 'selection').reason, /6000/);
});
