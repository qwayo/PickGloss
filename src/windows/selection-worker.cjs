'use strict';
const SelectionHook = require('selection-hook');
const { spawn } = require('node:child_process');
const hook = new SelectionHook();
let stopped = false, latest = 0, probe = null, standby = null;
let gesture = null, blockedNative = false;
const post = data => process.parentPort.postMessage(data);
const binary = process.argv[2];
const excludePids = process.argv[3] || '';

const validPoint = point => point && Number.isFinite(point.x) && Number.isFinite(point.y) && point.x !== SelectionHook.INVALID_COORDINATE && point.y !== SelectionHook.INVALID_COORDINATE;
function cancelPending() {
  latest++; gesture = null;
  if (probe) probe.kill();
}
function readProbe(input, seq, done, ready) {
  let output = '', lines = '', prepared = false, active = input !== null;
  const child = spawn(binary, active ? [] : ['--standby'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  if (active) probe = child;
  let timeout;
  const deadline = ms => { clearTimeout(timeout); timeout = setTimeout(() => { if (standby === reader) standby = null; child.kill(); }, ms); };
  deadline(!active || ready ? 8000 : 2200);
  const reader = { child, deadline, begin(value, sequence, complete, preparedCallback) {
    active = true; seq = sequence; done = complete; ready = preparedCallback; probe = child;
    deadline(8000); child.stdin.write(JSON.stringify(value) + '\n');
  } };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    output += chunk; lines += chunk;
    if (output.length > 60000) { child.kill(); return; }
    while (lines.includes('\n')) {
      const end = lines.indexOf('\n'), line = lines.slice(0, end); lines = lines.slice(end + 1);
      try {
        const frame = JSON.parse(line);
        if (frame.standby === true && !active) clearTimeout(timeout);
        if (ready && !prepared && frame.ready === true && !stopped && seq === latest) { prepared = true; ready(); }
      } catch { }
    }
  });
  child.on('error', () => {
    if (!stopped && (active ? seq === latest : standby === reader)) post({ type: 'probe-unavailable' });
    if (standby === reader) standby = null;
  });
  child.on('close', () => {
    clearTimeout(timeout); if (probe === child) probe = null;
    if (standby === reader) standby = null;
    if (!active || stopped || seq !== latest || output.length > 60000) return;
    try { done(JSON.parse(output.trim().split('\n').at(-1))); } catch { }
  });
  child.stdin.on('error', () => {});
  if (active) {
    if (ready) child.stdin.write(JSON.stringify(input) + '\n');
    else child.stdin.end(JSON.stringify(input) + '\n');
  }
  return reader;
}

function prepareStandby() {
  if (!stopped && !standby) standby = readProbe(null);
}

hook.on('text-selection', data => {
  if (stopped || blockedNative || data.method === SelectionHook.SelectionMethod.CLIPBOARD || !data.text?.trim()) return;
  if (gesture?.committed && data.mousePosEnd?.x === gesture.end.x && data.mousePosEnd?.y === gesture.end.y) return;
  cancelPending(); const seq = latest;
  // 固定本次松开坐标；段落读取期间鼠标移动或事件对象变化都不能改掉入口锚点。
  const point = data.mousePosEnd && { x: data.mousePosEnd.x, y: data.mousePosEnd.y };
  if (!validPoint(point)) return;
  if (data.text.length > 12000) {
    // 只保留提示入口，不把超限原文跨进程传送，也不截断后发送给模型。
    post({ type: 'selection-too-long', point });
    return;
  }
  readProbe({ text: data.text, x: point.x, y: point.y, excludePids }, seq, result => {
    if (result.valid) post({ type: 'selection', ...result, point, method: 'UIA 已验证选区' });
  });
  prepareStandby();
});
// 临时保留同一 UIA 范围的手势前快照；无变化的旧高亮不能成为后备采集。
hook.on('mouse-down', point => {
  blockedNative = point.button !== 0 || !validPoint(point);
  cancelPending(); post({ type: 'pointer-down', point });
  if (stopped || point.button !== 0 || !validPoint(point)) { prepareStandby(); return; }
  const current = gesture = { start: { x: point.x, y: point.y }, at: Date.now(), ready: false, released: false, committed: false };
  const seq = latest;
  const input = { mode: 'gesture', x: point.x, y: point.y, excludePids };
  const complete = result => {
    if (gesture !== current || !current.released || !result.valid) return;
    current.committed = true;
    if (result.tooLong) post({ type: 'selection-too-long', point: current.end });
    else post({ type: 'selection', ...result, point: current.end, method: 'UIA 已验证选区' });
  };
  const ready = () => { if (gesture === current && !current.released) current.ready = true; };
  // 待用助手不保留用户选区或读取正文；真实基线仍在本次按下后取得。
  current.reader = standby; standby = null;
  if (current.reader) current.reader.begin(input, seq, complete, ready);
  else current.reader = readProbe(input, seq, complete, ready);
});
hook.on('mouse-up', point => {
  const current = gesture;
  if (point.button !== 0) return;
  if (!current || current.released) { prepareStandby(); return; }
  if (!validPoint(point) || !current.ready || Date.now() - current.at > 8000 || Math.hypot(point.x - current.start.x, point.y - current.start.y) < 8) { cancelPending(); prepareStandby(); return; }
  current.released = true; current.end = { x: point.x, y: point.y };
  current.reader.deadline(2200);
  current.reader.child.stdin.end(JSON.stringify({ mode: 'gesture-end', x: point.x, y: point.y }) + '\n');
  // 松开后再补充备用进程，避免按下时的进程创建争用基线读取的时间窗口。
  prepareStandby();
});
// 滚动不取消选区或段落复核；仅转发主动取消入口的事件，不记录用户键盘文字。
hook.on('key-down', event => {
  if (event.uniKey === 'Escape') { blockedNative = true; cancelPending(); prepareStandby(); post({ type: 'dismiss' }); }
  else if (gesture && !['Shift', 'Control', 'Alt', 'Meta'].includes(event.uniKey)) { blockedNative = true; cancelPending(); prepareStandby(); }
});
hook.on('error', () => post({ type: 'error' }));
try {
  hook.disableClipboard();
  const running = hook.start({ enableClipboard: false, enableMouseMoveEvent: false, debug: false });
  post({ type: 'ready', running });
  if (running) prepareStandby();
} catch { post({ type: 'error' }); }
const heartbeat = setInterval(() => post({ type: 'heartbeat' }), 5000);
process.parentPort.on('message', e => {
  if (e.data?.type === 'cancel-pending') {
    blockedNative = true;
    cancelPending();
    prepareStandby();
    post({ type: 'pending-cancelled', requestId: e.data.requestId });
    return;
  }
  if (e.data?.type !== 'stop') return;
  stopped = true; cancelPending(); standby?.child.kill(); standby = null; clearInterval(heartbeat); hook.cleanup(); process.exit(0);
});
