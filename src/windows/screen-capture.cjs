'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const HEADER_BYTES = 32, MAX_BITMAP_BYTES = 128 * 1024 * 1024;

function validPhysicalRect(rect) {
  return rect && ['x', 'y', 'width', 'height'].every(key => Number.isInteger(rect[key])) &&
    ['x', 'y'].every(key => rect[key] >= -2147483648 && rect[key] <= 2147483647) &&
    rect.width > 0 && rect.height > 0 && rect.width <= 16384 && rect.height <= 16384 &&
    rect.width * rect.height * 4 <= MAX_BITMAP_BYTES && rect.x + rect.width <= 2147483647 && rect.y + rect.height <= 2147483647;
}

function createScreenCapture({ helperPath, spawnHelper = spawn, exists = fs.existsSync, platform = process.platform,
  startupTimeoutMs = 2000, captureTimeoutMs = 1500 } = {}) {
  const packaged = process.resourcesPath && path.join(process.resourcesPath, 'native', 'ScreenCapture.exe');
  const helper = helperPath || (packaged && exists(packaged) ? packaged : path.join(__dirname, '../../build/native/ScreenCapture.exe'));
  if (platform !== 'win32' || !exists(helper)) return null;
  if (![startupTimeoutMs, captureTimeoutMs].every(value => Number.isInteger(value) && value > 0 && value <= 30000)) throw new Error('截图助手超时参数无效。');
  let child, phase = 'new', ready, readyResolve, readyReject, startupTimer, pending, sequence = 0, busy = false, failure;
  let header = Buffer.alloc(HEADER_BYTES), headerOffset = 0, frame = null;

  function stop(error, disposed = false) {
    if (phase === 'failed' || phase === 'disposed') return;
    phase = disposed ? 'disposed' : 'failed'; failure = error;
    clearTimeout(startupTimer); headerOffset = 0; frame = null;
    readyReject?.(error); readyResolve = readyReject = null;
    if (pending) { clearTimeout(pending.timer); pending.reject(error); pending = null; }
    child?.stdin?.end(); child?.kill();
  }
  function completeFrame(current) {
    if (current.kind === 0) {
      phase = 'ready'; clearTimeout(startupTimer); readyResolve(); readyResolve = readyReject = null;
      return;
    }
    const request = pending; pending = null; clearTimeout(request.timer);
    if (current.kind === 2) request.reject(new Error(current.payload.toString('utf8') || 'Windows 屏幕读取失败。'));
    else request.resolve({ bitmap: current.payload, width: current.width, height: current.height, nativeMilliseconds: current.microseconds / 1000 });
  }
  function parseHeader() {
    if (header.toString('ascii', 0, 4) !== 'PGSC' || header.readUInt16LE(4) !== 1 || header.readUInt32LE(28) !== 0) throw new Error('截图助手协议不匹配。');
    const kind = header.readUInt16LE(6), id = header.readUInt32LE(8), width = header.readUInt32LE(12), height = header.readUInt32LE(16), length = header.readUInt32LE(20), microseconds = header.readUInt32LE(24);
    if (kind === 0) {
      if (phase !== 'starting' || id || width || height || length || microseconds) throw new Error('截图助手就绪应答无效。');
    } else {
      if (phase !== 'ready' || !pending || pending.id !== id) throw new Error('截图助手返回了不属于当前请求的数据。');
      if (kind === 1) {
        if (width !== pending.rect.width || height !== pending.rect.height || length !== width * height * 4 || length > MAX_BITMAP_BYTES) throw new Error('截图助手位图尺寸或长度无效。');
      } else if (kind === 2) {
        if (width || height || length === 0 || length > 1024) throw new Error('截图助手错误应答无效。');
      } else throw new Error('截图助手帧类型无效。');
    }
    return { kind, id, width, height, microseconds, payload: Buffer.allocUnsafe(length), offset: 0 };
  }
  function receive(chunk) {
    if (phase === 'disposed' || phase === 'failed') return;
    try {
      let offset = 0;
      while (offset < chunk.length) {
        if (!frame) {
          const count = Math.min(HEADER_BYTES - headerOffset, chunk.length - offset);
          chunk.copy(header, headerOffset, offset, offset + count); headerOffset += count; offset += count;
          if (headerOffset !== HEADER_BYTES) continue;
          headerOffset = 0; frame = parseHeader();
          if (!frame.payload.length) { const current = frame; frame = null; completeFrame(current); continue; }
        }
        const count = Math.min(frame.payload.length - frame.offset, chunk.length - offset);
        chunk.copy(frame.payload, frame.offset, offset, offset + count); frame.offset += count; offset += count;
        if (frame.offset === frame.payload.length) { const current = frame; frame = null; completeFrame(current); }
      }
    } catch (error) { stop(error); }
  }
  function prepare() {
    if (phase === 'failed' || phase === 'disposed') return Promise.reject(failure || new Error('截图助手已关闭。'));
    if (ready) return ready;
    phase = 'starting';
    ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    startupTimer = setTimeout(() => stop(new Error('截图助手预热超时。')), startupTimeoutMs); startupTimer.unref?.();
    try {
      child = spawnHelper(helper, [String(process.pid)], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      child.on('error', error => stop(error));
      child.on('exit', () => stop(new Error('截图助手已退出。')));
      child.stdout.on('data', receive);
      child.stdout.on('error', error => stop(error));
      child.stdout.on('end', () => stop(new Error('截图助手数据管道已关闭。')));
      child.stdout.on('close', () => stop(new Error('截图助手数据管道已关闭。')));
      child.stdin.on('error', error => stop(error));
      child.stdin.on('close', () => stop(new Error('截图助手指令管道已关闭。')));
      // 标准错误不保存、不打印，避免异常进程把大段数据积压在管道中。
      child.stderr?.on?.('error', error => stop(error));
      child.stderr?.resume();
    } catch (error) { stop(error); }
    return ready;
  }
  async function capture(physicalRect) {
    const rect = physicalRect && { x: physicalRect.x, y: physicalRect.y, width: physicalRect.width, height: physicalRect.height };
    if (!validPhysicalRect(rect)) throw new Error('截图物理矩形无效或超过内存限制。');
    if (busy) throw new Error('已有截图正在采集，请稍后重试。');
    busy = true;
    try {
      await prepare();
      if (phase !== 'ready') throw failure || new Error('截图助手尚未就绪。');
      return await new Promise((resolve, reject) => {
        const id = sequence = sequence >= 0xffffffff ? 1 : sequence + 1;
        const timer = setTimeout(() => stop(new Error('Windows 屏幕读取超时。')), captureTimeoutMs); timer.unref?.();
        pending = { id, rect, resolve, reject, timer };
        child.stdin.write(`C ${id} ${rect.x} ${rect.y} ${rect.width} ${rect.height}\n`, error => { if (error) stop(error); });
      });
    } finally { busy = false; }
  }
  return { prepare, capture, dispose() { stop(new Error('截图助手已关闭。'), true); } };
}

module.exports = { createScreenCapture, validPhysicalRect };
