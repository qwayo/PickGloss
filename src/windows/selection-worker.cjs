'use strict';
const SelectionHook = require('selection-hook');
const { spawn } = require('node:child_process');
const hook = new SelectionHook();
let stopped = false, latest = 0, probe = null;
const post = data => process.parentPort.postMessage(data);
const binary = process.argv[2];
const excludePids = process.argv[3] || '';

hook.on('text-selection', data => {
  if (stopped || data.method === SelectionHook.SelectionMethod.CLIPBOARD || !data.text?.trim()) return;
  const seq = ++latest;
  if (probe) probe.kill();
  // 固定本次松开坐标；段落读取期间鼠标移动或事件对象变化都不能改掉入口锚点。
  const point = data.mousePosEnd && { x: data.mousePosEnd.x, y: data.mousePosEnd.y };
  if (!point || point.x === SelectionHook.INVALID_COORDINATE || point.y === SelectionHook.INVALID_COORDINATE) return;
  if (data.text.length > 12000) {
    // 只保留提示入口，不把超限原文跨进程传送，也不截断后发送给模型。
    post({ type: 'selection-too-long', point });
    return;
  }
  let output = '';
  const child = spawn(binary, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  probe = child;
  const timeout = setTimeout(() => child.kill(), 2200);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => { output += chunk; if (output.length > 60000) child.kill(); });
  child.on('error', () => post({ type: 'probe-unavailable' }));
  child.on('close', () => {
    clearTimeout(timeout); if (probe === child) probe = null;
    if (stopped || seq !== latest) return;
    try {
      const result = JSON.parse(output.trim());
      if (result.valid) post({ type: 'selection', ...result, point, method: 'UIA 已验证选区' });
    } catch { }
  });
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify({ text: data.text, x: point.x, y: point.y, excludePids }) + '\n');
});
// 滚动不取消选区或段落复核；仅转发主动取消入口的事件，不记录用户键盘文字。
hook.on('mouse-down', point => { latest++; if (probe) probe.kill(); post({ type: 'pointer-down', point }); });
hook.on('key-down', event => { if (event.uniKey === 'Escape') { latest++; if (probe) probe.kill(); post({ type: 'dismiss' }); } });
hook.on('error', () => post({ type: 'error' }));
try {
  hook.disableClipboard();
  const running = hook.start({ enableClipboard: false, enableMouseMoveEvent: false, debug: false });
  post({ type: 'ready', running });
} catch { post({ type: 'error' }); }
const heartbeat = setInterval(() => post({ type: 'heartbeat' }), 5000);
process.parentPort.on('message', e => {
  if (e.data?.type === 'cancel-pending') {
    latest++;
    if (probe) probe.kill();
    post({ type: 'pending-cancelled', requestId: e.data.requestId });
    return;
  }
  if (e.data?.type !== 'stop') return;
  stopped = true; if (probe) probe.kill(); clearInterval(heartbeat); hook.cleanup(); process.exit(0);
});
