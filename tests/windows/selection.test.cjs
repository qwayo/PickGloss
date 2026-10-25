'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

// 执行真实选区工作进程逻辑；用事件代替鼠标和 UIA，不读取桌面内容。
function selectionWorker({ autoWarm = true } = {}) {
  const messages = [], children = [], timers = [];
  let hook;
  class Hook extends EventEmitter {
    static SelectionMethod = { CLIPBOARD: 99 };
    static INVALID_COORDINATE = -9999;
    constructor() { super(); hook = this; }
    disableClipboard() {}
    start() { return true; }
    cleanup() {}
  }
  const parentPort = Object.assign(new EventEmitter(), { postMessage: value => messages.push(value) });
  const source = path.join(__dirname, '../../src/windows/selection-worker.cjs');
  vm.runInNewContext(fs.readFileSync(source, 'utf8'), {
    require: name => name === 'selection-hook' ? Hook : name === 'node:child_process' ? {
      spawn(binary, args) {
        const child = Object.assign(new EventEmitter(), {
          standby: args.includes('--standby'),
          stdinFrames: [],
          stdout: Object.assign(new EventEmitter(), { setEncoding() {} }),
          stdin: Object.assign(new EventEmitter(), {
            write(value) { child.input = value; child.stdinFrames.push({ operation: 'write', value }); },
            end(value) { child.input = value; child.stdinFrames.push({ operation: 'end', value }); child.inputEnded = true; },
          }),
          kill() { child.killed = true; },
        });
        children.push(child); return child;
      },
    } : require(name),
    process: { parentPort, argv: ['', '', '测试助手', ''], exit() {} },
    setTimeout(fn) { const timer = { fn }; timers.push(timer); return timer; }, clearTimeout(timer) { if (timer) timer.cleared = true; }, setInterval() {}, clearInterval() {},
  });
  const warm = () => children.filter(child => child.standby && !child.input && !child.warmed).forEach(child => {
    child.warmed = true; child.stdout.emit('data', '{"standby":true}\n');
  });
  if (autoWarm) warm();
  return { messages, get children() { return children.filter(child => child.input); }, allChildren: children, warm, timers,
    down: (point = { x: 240, y: 360, button: 0 }) => { hook.emit('mouse-down', point); if (autoWarm) warm(); },
    up: (point = { x: 300, y: 360, button: 0 }) => { hook.emit('mouse-up', point); if (autoWarm) warm(); },
    select: (text, point = { x: 240, y: 360 }) => hook.emit('text-selection', { text, method: 1, mousePosEnd: point }),
    scroll: () => hook.emit('mouse-wheel', { x: 240, y: 360 }),
    cancel: kind => kind === 'Escape' ? hook.emit('key-down', { uniKey: 'Escape' }) : hook.emit('mouse-down', { x: 10, y: 10 }),
    command: data => parentPort.emit('message', { data }),
  };
}

function finish(child, result) { child.stdout.emit('data', JSON.stringify(result) + '\n'); child.emit('close'); }
function frame(child, result) { child.stdout.emit('data', JSON.stringify(result) + '\n'); }

test('监听开启时提前预热，快速拖选复用现成助手并补充待用进程', () => {
  const worker = selectionWorker();
  assert.equal(worker.allChildren.length, 1, '按下之前应已有待用助手');
  const standby = worker.allChildren[0];
  assert.equal(standby.standby, true);
  assert.equal(standby.input, undefined, '待用时不采集正文或选区');
  worker.down();
  assert.equal(worker.children[0], standby, '按下后不等待新进程启动');
  assert.equal(worker.allChildren.length, 1, '取得基线的关键路径不能并发启动下一份备用助手');
  standby.stdout.emit('data', '{"ready":true}\n'); worker.up();
  finish(standby, { valid: true, text: '快速拖选' });
  assert.equal(worker.messages.filter(m => m.type === 'selection').length, 1);
  assert.equal(worker.allChildren.length, 2, '使用后应补充一个备用');
});

test('待用握手分块且与选区准备帧合并时仍能正确识别本次基线', () => {
  const worker = selectionWorker(), standby = worker.allChildren[0];
  worker.down();
  standby.stdout.emit('data', '{"stand');
  standby.stdout.emit('data', 'by":true}\n{"rea');
  standby.stdout.emit('data', 'dy":true}\n'); worker.up();
  finish(standby, { valid: true, text: '快速选区' });
  assert.equal(worker.messages.filter(m => m.type === 'selection').length, 1);
});

test('连续拖选分别使用补充的助手，取消后的旧结果和旧关闭不污染新手势', () => {
  const worker = selectionWorker(); worker.down(); const first = worker.children[0];
  first.stdout.emit('data', '{"ready":true}\n'); worker.up();
  worker.down(); const second = worker.children[1];
  finish(first, { valid: true, text: '过期选区' });
  second.stdout.emit('data', '{"ready":true}\n'); worker.up();
  finish(second, { valid: true, text: '新选区' });
  assert.equal(worker.allChildren.length, 3);
  assert.deepEqual(worker.messages.filter(m => m.type === 'selection').map(m => m.text), ['新选区']);
});

test('停止时关闭活跃与待用助手，任何迟到帧都不能复活或补充助手', () => {
  const worker = selectionWorker(); worker.down();
  worker.children[0].stdout.emit('data', '{"ready":true}\n'); worker.up();
  worker.command({ type: 'stop' });
  for (const child of worker.allChildren) {
    assert.equal(child.killed, true);
    child.stdout.emit('data', '{"standby":true}\n{"ready":true}\n');
    finish(child, { valid: true, text: '过期' });
  }
  assert.equal(worker.allChildren.length, 2);
  assert.equal(worker.messages.some(m => m.type === 'selection'), false);
});

test('待用进程失败不循环重启，下次手势退回有期限的冷启动', () => {
  for (const kind of ['error', 'close']) {
    const worker = selectionWorker(), idle = worker.allChildren[0]; idle.emit(kind);
    assert.equal(worker.allChildren.length, 1);
    worker.down(); assert.notEqual(worker.children[0], idle);
    assert.equal(worker.allChildren.length, 2);
    worker.up();
    assert.equal(worker.allChildren.length, 3);
  }
});

test('冷启动手势保持助手 stdin 打开，直到松开帧写入后再结束', () => {
  const worker = selectionWorker(), staleStandby = worker.allChildren[0];
  staleStandby.emit('error');
  worker.down();
  const child = worker.children[0];
  assert.ok(child && child !== staleStandby, '待用助手失败后应启动冷助手');
  assert.equal(child.inputEnded, undefined, '手势开始帧不能提前结束 stdin，否则助手读不到松开帧');
  assert.deepEqual(child.stdinFrames.map(frame => [frame.operation, JSON.parse(frame.value).mode]), [['write', 'gesture']]);
  child.stdout.emit('data', '{"ready":true}\n');
  worker.up();
  assert.equal(child.inputEnded, true, '松开帧发送后结束一次输入流');
  assert.deepEqual(child.stdinFrames.map(frame => [frame.operation, JSON.parse(frame.value).mode]), [
    ['write', 'gesture'], ['end', 'gesture-end'],
  ]);
});

test('预热超时移除备用槽而不循环重启，迟到握手不影响下一次助手', () => {
  const worker = selectionWorker({ autoWarm: false }), idle = worker.allChildren[0];
  worker.timers[0].fn(); assert.equal(idle.killed, true);
  assert.equal(worker.allChildren.length, 1);
  worker.down(); const current = worker.children[0];
  assert.notEqual(current, idle);
  idle.stdout.emit('data', '{"standby":true}\n'); idle.emit('close');
  current.stdout.emit('data', '{"ready":true}\n'); worker.up();
  finish(current, { valid: true, text: '新选区' });
  assert.equal(worker.messages.filter(m => m.type === 'selection').length, 1);
});

test('待用交接和松开后分别重设超时，结果超时会终止助手', () => {
  const worker = selectionWorker(), idleTimer = worker.timers[0];
  assert.equal(idleTimer.cleared, true, '待用握手后不保留启动期限');
  worker.down(); const child = worker.children[0], beforeUp = worker.timers.find(t => !t.cleared);
  assert.ok(beforeUp);
  child.stdout.emit('data', '{"ready":true}\n'); worker.up();
  assert.equal(beforeUp.cleared, true, '松开后替换为结果期限');
  worker.timers.find(t => !t.cleared).fn(); assert.equal(child.killed, true);
  child.emit('close');
  assert.equal(worker.messages.some(m => m.type === 'selection'), false);
});

test('底层库无选区事件时，有准备完成的真实拖选仍走只读后备采集', () => {
  const worker = selectionWorker(); worker.down();
  const child = worker.children[0];
  assert.ok(child, '鼠标按下应启动可终止的只读手势助手');
  assert.equal(JSON.parse(child.input).mode, 'gesture');
  child.stdout.emit('data', '{"ready":true}\n');
  worker.up();
  assert.equal(JSON.parse(child.input).mode, 'gesture-end');
  finish(child, { valid: true, text: '目标词', context: '虚构目标词材料' });
  assert.equal(worker.messages.filter(m => m.type === 'selection').length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(worker.messages.at(-1).point)), { x: 300, y: 360 });
});

test('普通点击、右键和无按下的松开不产生后备采集', () => {
  const worker = selectionWorker(); worker.up(); assert.equal(worker.children.length, 0);
  worker.down({ x: 240, y: 360, button: 2 }); assert.equal(worker.children.length, 0);
  worker.down(); const child = worker.children[0]; assert.ok(child);
  child.stdout.emit('data', '{"ready":true}\n'); worker.up({ x: 240, y: 360, button: 0 });
  assert.equal(child.killed, true);
  finish(child, { valid: true, text: '残留高亮' });
  assert.equal(worker.messages.some(m => m.type === 'selection'), false);
});

test('快松开时尚未收到基线帧仍拒绝迟到结果，不能用最终范围变化代替采样时序', () => {
  const worker = selectionWorker(); worker.down(); const child = worker.children[0]; assert.ok(child);
  worker.up();
  assert.equal(child.killed, true);
  child.stdout.emit('data', '{"ready":true}\n');
  finish(child, { valid: true, text: '迟到选区' });
  assert.equal(worker.messages.some(m => m.type === 'selection'), false);
});

test('早期基线帧不等于正式验证通过，归属复核失败仍不产生入口', () => {
  const worker = selectionWorker(); worker.down(); const child = worker.children[0];
  child.stdout.emit('data', '{"ready":true}\n'); worker.up();
  finish(child, { valid: false });
  assert.equal(worker.messages.filter(m => m.type === 'selection').length, 0);
});

test('正常选区事件优先，后备结果迟到不得重复或覆盖', () => {
  const worker = selectionWorker(); worker.down(); const fallback = worker.children[0]; assert.ok(fallback);
  fallback.stdout.emit('data', '{"ready":true}\n'); worker.up(); worker.select('正常选区');
  const normal = worker.children.at(-1); assert.notEqual(normal, fallback);
  finish(fallback, { valid: true, text: '后备选区' }); finish(normal, { valid: true, text: '正常选区' });
  assert.deepEqual(worker.messages.filter(m => m.type === 'selection').map(m => m.text), ['正常选区']);
});

test('后备采集已完成时，同一手势迟到的底层事件不重复弹出', () => {
  const worker = selectionWorker(); worker.down(); const child = worker.children[0]; assert.ok(child);
  child.stdout.emit('data', '{"ready":true}\n'); worker.up();
  finish(child, { valid: true, text: '目标词' }); worker.select('目标词', { x: 300, y: 360 });
  assert.equal(worker.messages.filter(m => m.type === 'selection').length, 1);
  assert.equal(worker.children.length, 1);
});

test('后备超限仅发提示，取消手势后任何迟到数据均失效', () => {
  const worker = selectionWorker(); worker.down(); const child = worker.children[0]; assert.ok(child);
  child.stdout.emit('data', '{"ready":true}\n'); worker.up(); finish(child, { valid: true, tooLong: true });
  assert.equal(worker.messages.at(-1).type, 'selection-too-long'); assert.equal('text' in worker.messages.at(-1), false);
  worker.down(); const next = worker.children.at(-1); worker.cancel('Escape');
  finish(next, { valid: true, text: '旧选区' });
  assert.equal(worker.messages.some(m => m.type === 'selection'), false);
});

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

test('分阶段复核先发布已验证文字，再按同一 requestId 返回上下文', () => {
  const worker = selectionWorker();
  worker.select('正文块。\ngit status --short');
  const probe = worker.children[0];
  assert.equal(JSON.parse(probe.input).progressive, true);
  frame(probe, { valid: true, text: '正文块。\ngit status --short', contextPending: true, app: 'electron', title: '固定材料' });
  const selected = worker.messages.find(message => message.type === 'selection');
  assert.equal(typeof selected.requestId, 'number');
  assert.equal(selected.text, '正文块。\ngit status --short');
  assert.equal(selected.context, '');
  assert.equal(selected.contextPending, true);
  assert.equal(worker.messages.some(message => message.type === 'selection-context'), false);
  frame(probe, { contextComplete: true, context: '正文块。\n\ngit status --short', contextOrigin: 'UIA 所在段落', reason: '' });
  probe.emit('close');
  const context = worker.messages.find(message => message.type === 'selection-context');
  assert.equal(context.requestId, selected.requestId);
  assert.equal(context.context, '正文块。\n\ngit status --short');
  assert.equal(context.contextOrigin, 'UIA 所在段落');
});

test('入口点击触发取消时保留已发布的上下文读取并返回缺失或完成阶段', () => {
  const worker = selectionWorker(); worker.select('已验证正文');
  const probe = worker.children[0];
  frame(probe, { valid: true, text: '已验证正文', contextPending: true });
  const selected = worker.messages.find(message => message.type === 'selection');
  worker.command({ type: 'cancel-pending', requestId: 71 });
  assert.notEqual(probe.killed, true, '入口点击只取消未发布选区，不应杀掉其上下文 reader');
  frame(probe, { contextComplete: true, context: '', contextOrigin: '', reason: '当前应用未提供可靠上下文。' });
  probe.emit('close');
  const context = worker.messages.find(message => message.type === 'selection-context');
  assert.equal(context.requestId, selected.requestId);
  assert.equal(context.context, '');
  assert.match(context.reason, /可靠上下文/);
});

test('新划词后旧 requestId 的迟到上下文仍归属原选区，不覆盖新文字', () => {
  const worker = selectionWorker();
  worker.select('旧的已发布文字'); const old = worker.children[0];
  frame(old, { valid: true, text: '旧的已发布文字', contextPending: true });
  const oldSelection = worker.messages.find(message => message.type === 'selection');
  worker.select('新的文字'); const current = worker.children[1];
  assert.notEqual(old.killed, true, '已发布旧选区继续完成自己的上下文读取');
  frame(current, { valid: true, text: '新的文字', contextPending: true });
  frame(old, { contextComplete: true, context: '旧段落', contextOrigin: 'UIA 所在段落', reason: '' });
  frame(current, { contextComplete: true, context: '新段落', contextOrigin: 'UIA 所在段落', reason: '' });
  old.emit('close'); current.emit('close');
  assert.deepEqual(worker.messages.filter(message => message.type === 'selection').map(message => message.text), ['旧的已发布文字', '新的文字']);
  assert.deepEqual(worker.messages.filter(message => message.type === 'selection-context').map(message => [message.requestId, message.context]), [
    [oldSelection.requestId, '旧段落'], [worker.messages.filter(message => message.type === 'selection')[1].requestId, '新段落'],
  ]);
});

test('分阶段文字已发布后 helper 超时也发送上下文缺失帧', () => {
  const worker = selectionWorker(); worker.select('等待上下文');
  const probe = worker.children[0];
  frame(probe, { valid: true, text: '等待上下文', contextPending: true });
  const selected = worker.messages.find(message => message.type === 'selection');
  worker.timers.at(-1).fn();
  const context = worker.messages.find(message => message.type === 'selection-context');
  assert.equal(context.requestId, selected.requestId);
  assert.equal(context.contextPending, undefined);
  assert.match(context.reason, /超时/);
  assert.equal(probe.killed, true);
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

  worker.down(); worker.select('retain');
  const current = worker.children.at(-1);
  current.stdout.emit('data', JSON.stringify({ valid: true, text: 'retain' }));
  current.emit('close');
  assert.deepEqual(worker.messages.filter(message => message.type === 'selection').map(message => message.text), ['retain']);
});

test('明确取消后才到达的原生选区事件不能重新创建旧入口，新按下后恢复', () => {
  for(const cancel of ['Escape','command']) {
    const worker=selectionWorker();
    if(cancel==='Escape')worker.cancel('Escape');else worker.command({type:'cancel-pending'});
    worker.select('迟到旧选区'); assert.equal(worker.children.length,0);
    worker.down({x:10,y:10,button:2}); worker.select('右键保留的旧选区'); assert.equal(worker.children.length,0);
    worker.down(); worker.select('新的选区');
    finish(worker.children.at(-1),{valid:true,text:'新的选区'});
    assert.deepEqual(worker.messages.filter(m=>m.type==='selection').map(m=>m.text),['新的选区']);
  }
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
