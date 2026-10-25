'use strict';
const SelectionHook = require('selection-hook');
const { spawn } = require('node:child_process');
const hook = new SelectionHook();
let stopped = false, latest = 0, probe = null, standby = null;
let gesture = null, blockedNative = false;
const contextReaders = new Map();
const post = data => process.parentPort.postMessage(data);
const binary = process.argv[2];
const excludePids = process.argv[3] || '';

const validPoint = point => point && Number.isFinite(point.x) && Number.isFinite(point.y) && point.x !== SelectionHook.INVALID_COORDINATE && point.y !== SelectionHook.INVALID_COORDINATE;

function publishMissingContext(reader, reason) {
  if (!reader?.published || reader.contextComplete) return;
  reader.contextComplete = true;
  contextReaders.delete(reader.seq);
  post({ type: 'selection-context', requestId: reader.seq, context: '', contextOrigin: '', reason });
}

function cancelPending() {
  latest++; gesture = null;
  if (probe) {
    const pending = probe; probe = null;
    // 已发布文字的上下文任务拥有自己的 requestId，不能被入口点击或新手势取消。
    if (pending.published && !pending.contextComplete) contextReaders.set(pending.seq, pending);
    else if (!pending.published) pending.child.kill();
  }
}

function publishFrame(reader, frame, metadata, canPublish) {
  if (frame?.valid === true && frame.contextPending === true) {
    if (reader.published || stopped || !canPublish()) return;
    reader.published = true;
    contextReaders.set(reader.seq, reader);
    post({
      type: 'selection', requestId: reader.seq, text: frame.text, context: '', contextPending: true,
      point: metadata.point, method: metadata.method, app: frame.app || '', title: frame.title || '',
    });
    return;
  }
  if (frame?.contextComplete === true) {
    if (!reader.published || reader.contextComplete) return;
    reader.contextComplete = true;
    contextReaders.delete(reader.seq);
    post({
      type: 'selection-context', requestId: reader.seq, context: frame.context || '',
      contextOrigin: frame.contextOrigin || '', reason: frame.reason || '',
    });
    return;
  }
  // 兼容尚未启用 progressive 的原生助手和旧测试夹具。
  if (frame?.valid === true && !reader.published && !stopped && canPublish()) {
    reader.published = true; reader.contextComplete = true;
    post({
      type: 'selection', requestId: reader.seq, ...frame, contextPending: false,
      point: metadata.point, method: metadata.method,
    });
  }
}

function readProbe(input, seq, onFrame, ready) {
  let outputSize = 0, pendingLine = '', prepared = false;
  const active = input !== null;
  const child = spawn(binary, active ? [] : ['--standby'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  let timeout;
  const reader = {
    child, seq, active, published: false, contextComplete: false,
    deadline(ms) { clearTimeout(timeout); timeout = setTimeout(() => {
      if (standby === reader) standby = null;
      if (reader.published) publishMissingContext(reader, '上下文读取超时，请手动补充上下文。');
      child.kill();
    }, ms); },
    begin(value, sequence, frameCallback, preparedCallback) {
      reader.active = true; reader.seq = sequence; onFrame = frameCallback; ready = preparedCallback; probe = reader;
      reader.deadline(ready ? 8000 : 2200);
      if (value.mode === 'gesture') child.stdin.write(JSON.stringify(value) + '\n');
      else child.stdin.end(JSON.stringify(value) + '\n');
    },
  };
  reader.deadline(active ? (ready ? 8000 : 2200) : 8000);
  if (active) probe = reader;

  function consumeLine(line) {
    if (!line.trim()) return;
    try {
      const frame = JSON.parse(line);
      if (frame.standby === true && !reader.active) clearTimeout(timeout);
      if (ready && !prepared && frame.ready === true && !stopped && reader.seq === latest) { prepared = true; ready(); }
      if (reader.active && onFrame) onFrame(frame, reader);
    } catch { }
  }

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    outputSize += chunk.length; pendingLine += chunk;
    if (outputSize > 60000) {
      if (reader.published) publishMissingContext(reader, '上下文结果超过安全上限，请手动补充上下文。');
      child.kill(); return;
    }
    let end;
    while ((end = pendingLine.indexOf('\n')) >= 0) {
      const line = pendingLine.slice(0, end); pendingLine = pendingLine.slice(end + 1);
      consumeLine(line);
    }
  });
  child.on('error', () => {
    if (reader.published) publishMissingContext(reader, '上下文助手不可用，请手动补充上下文。');
    else if (!stopped && reader.active && reader.seq === latest) post({ type: 'probe-unavailable' });
    if (standby === reader) standby = null;
  });
  child.on('close', () => {
    clearTimeout(timeout);
    if (pendingLine.trim()) consumeLine(pendingLine);
    if (probe === reader) probe = null;
    if (standby === reader) standby = null;
    if (reader.published && !reader.contextComplete) publishMissingContext(reader, '上下文读取未完成，请手动补充上下文。');
    if (reader.active && !stopped) prepareStandby();
  });
  child.stdin.on('error', () => {});
  if (active) {
    const firstFrame = JSON.stringify(input) + '\n';
    // gesture 模式必须等松开后才能封闭输入流，否则原生助手在等待 gesture-end 前就会收到 EOF。
    if (input.mode === 'gesture') child.stdin.write(firstFrame);
    else child.stdin.end(firstFrame);
  }
  return reader;
}

function startProbe(input, seq, onFrame, ready) {
  let reader = standby;
  standby = null;
  if (reader) reader.begin(input, seq, onFrame, ready);
  else reader = readProbe(input, seq, onFrame, ready);
  return reader;
}

function prepareStandby() {
  if (!stopped && !standby) standby = readProbe(null);
}

function textSelection(data) {
  if (stopped || blockedNative || data.method === SelectionHook.SelectionMethod.CLIPBOARD || !data.text?.trim()) return;
  if (gesture?.committed && data.mousePosEnd?.x === gesture.end.x && data.mousePosEnd?.y === gesture.end.y) return;
  cancelPending(); const seq = latest;
  const point = data.mousePosEnd && { x: data.mousePosEnd.x, y: data.mousePosEnd.y };
  if (!validPoint(point)) return;
  if (data.text.length > 12000) {
    post({ type: 'selection-too-long', requestId: seq, point });
    return;
  }
  const metadata = { point, method: 'UIA 已验证选区' };
  const onFrame = (frame, reader) => publishFrame(reader, frame, metadata, () => seq === latest);
  startProbe({ text: data.text, x: point.x, y: point.y, excludePids, progressive: true }, seq, onFrame, null);
}

hook.on('text-selection', textSelection);
hook.on('mouse-down', point => {
  blockedNative = point.button !== 0 || !validPoint(point);
  cancelPending(); post({ type: 'pointer-down', point });
  if (stopped || point.button !== 0 || !validPoint(point)) { prepareStandby(); return; }
  const current = gesture = { start: { x: point.x, y: point.y }, at: Date.now(), ready: false, released: false, committed: false };
  const seq = latest;
  const input = { mode: 'gesture', x: point.x, y: point.y, excludePids, progressive: true };
  const metadata = { method: 'UIA 已验证选区' };
  const onFrame = (frame, reader) => {
    if (frame?.valid === true && frame.tooLong === true) {
      if (seq !== latest || !current.released || gesture !== current) return;
      reader.contextComplete = true;
      current.committed = true; metadata.point = current.end;
      post({ type: 'selection-too-long', requestId: seq, point: metadata.point });
      return;
    }
    if (frame?.valid === true && frame.contextPending === true && (!current.released || gesture !== current)) return;
    if (frame?.valid === true && current.released) {
      current.committed = true; metadata.point = current.end;
    }
    if (frame?.valid === true && frame.contextPending !== true && frame.contextComplete !== true && (!current.released || gesture !== current)) return;
    publishFrame(reader, frame, metadata, () => seq === latest && gesture === current && current.released);
  };
  const ready = () => { if (gesture === current && !current.released) current.ready = true; };
  current.reader = startProbe(input, seq, onFrame, ready);
});

hook.on('mouse-up', point => {
  const current = gesture;
  if (point.button !== 0) return;
  if (!current || current.released) { prepareStandby(); return; }
  if (!validPoint(point) || !current.ready || Date.now() - current.at > 8000 || Math.hypot(point.x - current.start.x, point.y - current.start.y) < 8) { cancelPending(); prepareStandby(); return; }
  current.released = true; current.end = { x: point.x, y: point.y };
  current.reader.deadline(2200);
  current.reader.child.stdin.end(JSON.stringify({ mode: 'gesture-end', x: point.x, y: point.y }) + '\n');
  prepareStandby();
});

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
  stopped = true; cancelPending();
  for (const reader of contextReaders.values()) {
    publishMissingContext(reader, '应用已关闭，上下文未能取得。');
    reader.child.kill();
  }
  contextReaders.clear();
  standby?.child.kill(); standby = null;
  clearInterval(heartbeat); hook.cleanup(); process.exit(0);
});
