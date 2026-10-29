'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const STATES = new Set(['active', 'inactive', 'invalid']);
const REASONS = new Set(['tab', 'navigation', 'scroll', 'tree', 'unknown', 'ambiguous', 'window']);
const MAX_HANDLE = 0xffffffffffffffffn;
const MAX_LINE_LENGTH = 1024;

function onlyKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}
function validSource(source) {
  if (!source || typeof source.handle !== 'string' || !/^[1-9]\d{0,19}$/.test(source.handle) ||
      !Number.isInteger(source.pid) || source.pid < 1 || source.pid > 0xffffffff) return null;
  try { if (BigInt(source.handle) > MAX_HANDLE) return null; } catch { return null; }
  return { handle: source.handle, pid: source.pid };
}
function validReason(value) { return typeof value === 'string' && REASONS.has(value); }
function validState(value) { return typeof value === 'string' && STATES.has(value); }

function createBrowserContext({ helperPath, spawnHelper = spawn, exists = fs.existsSync, platform = process.platform,
  onChange = () => {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
  startupTimeoutMs = 2000, leaseTimeoutMs = 1500, checkpointTimeoutMs = 1000, terminateGraceMs = 150 } = {}) {
  const packaged = process.resourcesPath && path.join(process.resourcesPath, 'native', 'BrowserContext.exe');
  const helper = helperPath || (packaged && exists(packaged) ? packaged : path.join(__dirname, '../../build/native/BrowserContext.exe'));
  if (platform !== 'win32' || !exists(helper)) return null;
  if (!Number.isInteger(startupTimeoutMs) || startupTimeoutMs < 1 || startupTimeoutMs > 2000 ||
      !Number.isInteger(leaseTimeoutMs) || leaseTimeoutMs < 1 || leaseTimeoutMs > 1500 ||
      !Number.isInteger(checkpointTimeoutMs) || checkpointTimeoutMs < 1 || checkpointTimeoutMs > 1500 ||
      !Number.isInteger(terminateGraceMs) || terminateGraceMs < 1 || terminateGraceMs > 1000) {
    throw new Error('浏览器上下文助手超时参数无效。');
  }

  let nextKey = 0, nextNonce = 0, current = null, warm = null, disposed = false;

  function snapshot(record) {
    if (!record || record.state === 'invalid' || !record.ready) return { state: 'invalid', revision: record?.revision || 0 };
    return { state: record.state, revision: record.revision };
  }
  function notify(record) {
    if (current !== record || record.closed) return;
    try { onChange({ key: record.key, state: record.state, reason: record.reason, revision: record.revision }); } catch { }
  }
  function settleStartup(record) {
    if (record.startupSettled) return;
    record.startupSettled = true;
    clearTimer(record.startupTimer); record.startupTimer = null;
    const resolve = record.resolveStartup; record.resolveStartup = null;
    resolve?.({ key: record.key, state: record.state === 'active' && record.ready ? 'active' : 'invalid', revision: record.revision });
  }
  function resolveCheckpoints(record) {
    for (const [nonce, pending] of record.checkpoints) {
      clearTimer(pending.timer);
      pending.resolve({ state: 'invalid', revision: record.revision });
      record.checkpoints.delete(nonce);
    }
  }
  function stopHelper(record) {
    if (!record.child || record.stopping) return;
    record.stopping = true;
    clearTimer(record.leaseTimer); record.leaseTimer = null;
    try { record.child.stdin?.end?.(); } catch { }
    record.killTimer = setTimer(() => {
      record.killTimer = null;
      if (!record.exited) { try { record.child?.kill?.(); } catch { } }
    }, terminateGraceMs);
    record.killTimer?.unref?.();
  }
  function closeRecord(record, { notifyInvalid = false, reason = 'unknown' } = {}) {
    if (!record || record.closed) return;
    if (notifyInvalid && record.state !== 'invalid') {
      record.state = 'invalid'; record.reason = reason; record.revision++;
      notify(record);
    }
    record.closed = true;
    clearTimer(record.startupTimer); clearTimer(record.leaseTimer);
    record.startupTimer = record.leaseTimer = null;
    // 已开始停止的助手仍依赖这唯一的定时强杀；dispose/release 不得清掉它。
    if (!record.stopping) { clearTimer(record.killTimer); record.killTimer = null; }
    settleStartup(record);
    resolveCheckpoints(record);
    stopHelper(record);
  }
  function invalidate(record, reason = 'unknown') {
    if (!record || record.closed) return;
    if (record.state === 'invalid') { settleStartup(record); return; }
    record.state = 'invalid'; record.reason = validReason(reason) ? reason : 'unknown'; record.revision++;
    notify(record); settleStartup(record); resolveCheckpoints(record); stopHelper(record);
  }
  function updateState(record, state, reason) {
    if (record.closed || record.state === 'invalid') return;
    if (state === 'invalid') { invalidate(record, reason); return; }
    if (!validState(state) || !validReason(reason)) { invalidate(record, 'unknown'); return; }
    if (record.state !== state || record.reason !== reason) {
      record.state = state; record.reason = reason; record.revision++;
      notify(record);
    }
  }
  function armLease(record) {
    clearTimer(record.leaseTimer);
    record.lastHeartbeat = now();
    record.leaseTimer = setTimer(() => {
      record.leaseTimer = null;
      if (record.closed || record.state === 'invalid') return;
      const elapsed = now() - record.lastHeartbeat;
      if (elapsed < leaseTimeoutMs) { armLease(record); return; }
      invalidate(record, 'unknown');
    }, leaseTimeoutMs);
    record.leaseTimer?.unref?.();
  }
  function isCurrent(record) { return (current === record || warm === record) && !record.closed; }
  function failProtocol(record) { if (isCurrent(record)) invalidate(record, 'unknown'); }

  function completeCheckpoint(record, message) {
    if (!onlyKeys(message, ['type', 'nonce', 'valid', 'state', 'reason']) || message.type !== 'checkpoint' ||
        typeof message.nonce !== 'string' || typeof message.valid !== 'boolean' || !validState(message.state) || !validReason(message.reason) ||
        message.valid !== (message.state !== 'invalid')) { failProtocol(record); return; }
    const pending = record.checkpoints.get(message.nonce);
    if (!pending) { failProtocol(record); return; }
    record.checkpoints.delete(message.nonce); clearTimer(pending.timer);
    if (!message.valid) invalidate(record, message.reason);
    else updateState(record, message.state, message.reason);
    pending.resolve(snapshot(record));
  }
  function consume(record, line) {
    if (!line) return;
    let message;
    try { message = JSON.parse(line); } catch { failProtocol(record); return; }
    if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.type !== 'string') { failProtocol(record); return; }
    if (message.type === 'standby') {
      if (!record.standbyMode || record.prepared || !onlyKeys(message, ['type'])) { failProtocol(record); return; }
      record.prepared = true;
      if (warm === record) { clearTimer(record.startupTimer); record.startupTimer = null; }
      if (record.targetSource) startPrepared(record);
      return;
    }
    if (message.type === 'ready') {
      if (record.ready || !onlyKeys(message, ['type', 'valid', 'state', 'reason']) || typeof message.valid !== 'boolean' ||
          !validState(message.state) || !validReason(message.reason) || message.valid !== (message.state !== 'invalid')) {
        failProtocol(record); return;
      }
      if (!message.valid || message.state !== 'active') {
        record.ready = true; record.state = 'invalid'; record.reason = message.reason; record.revision = 1;
        settleStartup(record); stopHelper(record); return;
      }
      record.ready = true; record.state = 'active'; record.reason = message.reason; record.revision = 1;
      clearTimer(record.startupTimer); record.startupTimer = null;
      armLease(record); settleStartup(record); return;
    }
    if (!record.ready) { failProtocol(record); return; }
    if (message.type === 'heartbeat') {
      if (!onlyKeys(message, ['type'])) { failProtocol(record); return; }
      armLease(record); return;
    }
    if (message.type === 'state') {
      if (!onlyKeys(message, ['type', 'state', 'reason']) || !validState(message.state) || !validReason(message.reason)) { failProtocol(record); return; }
      updateState(record, message.state, message.reason); return;
    }
    if (message.type === 'checkpoint') { completeCheckpoint(record, message); return; }
    failProtocol(record);
  }
  function attach(record, child) {
    record.child = child;
    child.on('error', () => { if (isCurrent(record) && !record.stopping) invalidate(record, 'unknown'); });
    child.on('exit', () => {
      record.exited = true; clearTimer(record.killTimer); record.killTimer = null;
      if (isCurrent(record) && !record.stopping) invalidate(record, 'unknown');
    });
    child.on('close', () => {
      record.exited = true; clearTimer(record.killTimer); record.killTimer = null;
      if (isCurrent(record) && !record.stopping) invalidate(record, 'unknown');
    });
    child.stdin?.on?.('error', () => { if (isCurrent(record) && !record.stopping) invalidate(record, 'unknown'); });
    child.stdout?.on?.('error', () => { if (isCurrent(record) && !record.stopping) invalidate(record, 'unknown'); });
    child.stdout?.on?.('end', () => { if (isCurrent(record) && !record.stopping) invalidate(record, 'unknown'); });
    child.stdout?.on?.('close', () => { if (isCurrent(record) && !record.stopping) invalidate(record, 'unknown'); });
    child.stderr?.on?.('data', () => { });
    child.stderr?.resume?.();
    child.stdout?.setEncoding?.('utf8');
    child.stdout?.on?.('data', chunk => {
      if (!isCurrent(record)) return;
      record.output += String(chunk);
      if (record.output.length > MAX_LINE_LENGTH * 4) { failProtocol(record); return; }
      let end;
      while ((end = record.output.indexOf('\n')) >= 0) {
        let line = record.output.slice(0, end); record.output = record.output.slice(end + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line.length > MAX_LINE_LENGTH || line.includes('\r')) { failProtocol(record); return; }
        consume(record, line);
        if (!isCurrent(record)) return;
      }
      if (record.output.length > MAX_LINE_LENGTH) failProtocol(record);
    });
  }

  function makeRecord(key) {
    return { key, state: 'starting', reason: 'unknown', revision: 0, ready: false, closed: false, stopping: false,
      exited: false, startupSettled: false, output: '', child: null, checkpoints: new Map(), startupTimer: null, leaseTimer: null, killTimer: null };
  }
  function startPrepared(record) {
    const source = record.targetSource; record.targetSource = null;
    try {
      if (!record.child?.stdin?.writable) throw new Error();
      record.child.stdin.write(`start ${source.handle} ${source.pid}\n`, error => { if (error && isCurrent(record)) invalidate(record, 'unknown'); });
    } catch { invalidate(record, 'unknown'); }
  }
  function prepare() {
    if (disposed || warm) return;
    const record = makeRecord(0); record.standbyMode = true; warm = record;
    record.startupTimer = setTimer(() => invalidate(record, 'unknown'), startupTimeoutMs);
    record.startupTimer?.unref?.();
    try { attach(record, spawnHelper(helper, ['--standby', String(process.pid)], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })); }
    catch { invalidate(record, 'unknown'); }
  }
  function capture(source) {
    if (nextKey >= Number.MAX_SAFE_INTEGER) throw new Error('浏览器上下文采集序号已耗尽。');
    const key = ++nextKey;
    if (current) { const previous = current; current = null; closeRecord(previous); }
    let record = warm; warm = null;
    if (record && (record.closed || record.stopping || record.exited || record.state === 'invalid')) { closeRecord(record); record = null; }
    record ||= makeRecord(key); record.key = key; record.startupSettled = false;
    current = record;
    const normalized = validSource(source);
    if (disposed || !normalized) {
      record.revision = 1; record.reason = 'window'; settleStartup(record);
      stopHelper(record);
      return Promise.resolve({ key, state: 'invalid', revision: record.revision });
    }
    const startup = new Promise(resolve => { record.resolveStartup = resolve; });
    clearTimer(record.startupTimer);
    record.startupTimer = setTimer(() => invalidate(record, 'unknown'), startupTimeoutMs);
    record.startupTimer?.unref?.();
    if (record.standbyMode) {
      record.targetSource = normalized;
      if (record.prepared) startPrepared(record);
      return startup;
    }
    try {
      const child = spawnHelper(helper, [normalized.handle, String(normalized.pid), String(process.pid)],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      attach(record, child);
    } catch { invalidate(record, 'unknown'); }
    return startup;
  }
  function checkpoint(key) {
    const record = current;
    if (!record || record.key !== key || !record.ready || record.state === 'invalid' || record.closed || record.stopping) {
      return Promise.resolve(snapshot(record?.key === key ? record : null));
    }
    if (nextNonce >= Number.MAX_SAFE_INTEGER) { invalidate(record, 'unknown'); return Promise.resolve(snapshot(record)); }
    const nonce = String(++nextNonce);
    return new Promise(resolve => {
      const timer = setTimer(() => {
        record.checkpoints.delete(nonce);
        if (isCurrent(record)) invalidate(record, 'unknown');
        resolve(snapshot(record));
      }, checkpointTimeoutMs);
      timer?.unref?.();
      record.checkpoints.set(nonce, { resolve, timer });
      try {
        if (!record.child?.stdin?.writable) throw new Error();
        record.child.stdin.write(JSON.stringify({ type: 'check', nonce }) + '\n', error => { if (error && isCurrent(record)) invalidate(record, 'unknown'); });
      } catch { clearTimer(timer); record.checkpoints.delete(nonce); invalidate(record, 'unknown'); resolve(snapshot(record)); }
    });
  }
  function release(key) {
    if (!current || current.key !== key) return false;
    const record = current; current = null; closeRecord(record); return true;
  }
  function invalidateCurrent(key) {
    if (!current || current.key !== key || current.closed || current.state === 'invalid') return false;
    invalidate(current, 'unknown'); return true;
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    if (current) { const record = current; current = null; closeRecord(record); }
    if (warm) { const record = warm; warm = null; closeRecord(record); }
  }

  return {
    prepare,
    capture,
    checkpoint,
    verify(key) { return current?.key === key ? snapshot(current) : { state: 'invalid', revision: 0 }; },
    invalidate: invalidateCurrent,
    release,
    dispose,
  };
}

module.exports = { createBrowserContext, validSource };
