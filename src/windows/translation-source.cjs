'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const STATES = new Set(['active', 'inactive', 'moved', 'closed', 'unavailable']);
function windowHandle(win) {
  const value = win?.getNativeWindowHandle?.();
  return Buffer.isBuffer(value) && value.length >= 4 ? String(value.length >= 8 ? value.readBigUInt64LE() : value.readUInt32LE()) : null;
}
function sourceSnapshot(value) {
  if (!value || typeof value.handle !== 'string' || !/^[1-9]\d{0,19}$/.test(value.handle) || BigInt(value.handle) > 0xffffffffffffffffn ||
      !Number.isInteger(value.pid) || value.pid < 1 || value.pid > 0xffffffff) return null;
  const b = value.bounds;
  if (!b || !['x', 'y', 'width', 'height'].every(key => Number.isInteger(b[key])) ||
      Math.abs(b.x) > 200000 || Math.abs(b.y) > 200000 || b.width < 1 || b.height < 1 || b.width > 100000 || b.height > 100000) return null;
  return { handle: value.handle, pid: value.pid, bounds: { x: b.x, y: b.y, width: b.width, height: b.height },
    ...(value.browserContextRequired === true ? { browserContextRequired: true,
      ...(Number.isSafeInteger(value.pageContext?.key) && value.pageContext.key > 0 ? { pageContext: { key: value.pageContext.key } } : {}) } : {}) };
}

// 按截图时的前后顺序归属选区，不能把其他可见窗口里的内容绑定给最后前台窗口。
function sourceForRegion(captured, region) {
  if (!region || !['x','y','width','height'].every(key => Number.isInteger(region[key])) || Math.abs(region.x) > 200000 || Math.abs(region.y) > 200000 ||
      region.width <= 0 || region.height <= 0 || region.width > 100000 || region.height > 100000) return null;
  const candidates = Array.isArray(captured?.candidates) ? captured.candidates : [captured];
  for (const item of candidates) {
    const source = sourceSnapshot(item);
    if (!source) continue;
    const b = source.bounds;
    const intersects = region.x < b.x + b.width && region.x + region.width > b.x && region.y < b.y + b.height && region.y + region.height > b.y;
    if (!intersects) continue;
    if (!(region.x >= b.x && region.y >= b.y && region.x + region.width <= b.x + b.width && region.y + region.height <= b.y + b.height)) return null;
    return source.browserContextRequired && source.handle === captured?.handle && source.pid === captured.pid
      ? sourceSnapshot({ ...source, pageContext: captured.pageContext }) : source;
  }
  return null;
}

// 只接收来源 HWND、进程、边界与可见状态，不读取其他应用的文字、标题或截图。
function createTranslationSource({ helperPath, onChange = () => {}, spawnHelper = spawn, exists = fs.existsSync } = {}) {
  const packaged = process.resourcesPath && path.join(process.resourcesPath, 'native', 'TranslationSource.exe');
  const helper = helperPath || (packaged && exists(packaged) ? packaged : path.join(__dirname, '../../build/native/TranslationSource.exe'));
  if (process.platform !== 'win32' || !exists(helper)) return null;
  let child, disposed = false, sequence = 0, binding = 0, output = '';
  const requests = new Map();
  const restorations = new Set();
  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const request of requests.values()) { clearTimeout(request.timer); request.resolve(null); }
    requests.clear(); child?.stdin?.end(); child?.kill();
    for (const finish of restorations) finish(false);
    restorations.clear();
  }
  function fail() {
    if (disposed) return;
    const current = binding; dispose();
    if (current) onChange({ binding: current, state: 'unavailable' });
  }
  function send(line) {
    if (disposed || !child?.stdin?.writable) return false;
    child.stdin.write(line + '\n', error => { if (error) fail(); }); return true;
  }
  try { child = spawnHelper(helper, [String(process.pid)], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); }
  catch { return null; }
  child.on('error', fail); child.on('exit', fail); child.stdin.on('error', fail);
  child.stdout.on('error', fail); child.stdout.on('end', fail); child.stdout.on('close', fail);
  child.stderr?.on('error', fail); child.stderr?.on('data', () => {});
  child.stdout.on('data', chunk => {
    if (disposed) return;
    output += chunk.toString('utf8');
    if (output.length > 16384) { fail(); return; }
    let end;
    while ((end = output.indexOf('\n')) >= 0) {
      const line = output.slice(0, end); output = output.slice(end + 1);
      let value; try { value = JSON.parse(line); } catch { fail(); return; }
      if (value.type === 'ready') continue;

      if (value.type === 'capture' && Number.isSafeInteger(value.id)) {
        const request = requests.get(value.id);
        if (!request) continue;
        if ('windows' in value && !Array.isArray(value.windows)) { fail(); return; }
        requests.delete(value.id); clearTimeout(request.timer);
        const source = sourceSnapshot(value.source);
        const candidates = Array.isArray(value.windows) ? value.windows.slice(0, 64).map(sourceSnapshot).filter(Boolean) : null;
        request.resolve(candidates ? { ...(source || {}), candidates } : source);
      } else if (value.type === 'state' && value.binding === binding && STATES.has(value.state)) {
        onChange({ binding, state: value.state });
      } else if (value.type !== 'state') { fail(); return; }
    }
  });
  // 本次绑定有单调递增编号，旧截图的迟到事件不能恢复新覆盖。
  return {
    capture() {
      if (disposed) return Promise.resolve(null);
      const id = ++sequence;
      return new Promise(resolve => {
        const timer = setTimeout(() => { requests.delete(id); resolve(null); }, 1000); timer.unref?.();
        requests.set(id, { resolve, timer });
        if (!send(`capture ${id}`)) { clearTimeout(timer); requests.delete(id); resolve(null); }
      });
    },
    bind(value, { overlay, controls }) {
      const source = sourceSnapshot(value), a = windowHandle(overlay), b = windowHandle(controls);
      if (!source || !a || !b || disposed) return null;
      binding = ++sequence;
      const r = source.bounds;
      return send(`bind ${binding} ${source.handle} ${source.pid} ${r.x} ${r.y} ${r.width} ${r.height} 2 ${a} ${b}`) ? binding : null;
    },
    restore(value, { capture, signal } = {}) {
      const source = sourceSnapshot(value), captureHandle = windowHandle(capture);
      if (!source || !captureHandle || disposed || signal?.aborted) return Promise.resolve(false);
      const r = source.bounds;
      return new Promise(resolve => {
        let helperChild, timer, done = false, output = '';
        const finish = value => {
          if (done) return; done = true; clearTimeout(timer); restorations.delete(finish);
          signal?.removeEventListener('abort', aborted);
          helperChild?.kill(); resolve(value === true);
        };
        const aborted = () => finish(false);
        restorations.add(finish);
        signal?.addEventListener('abort', aborted, { once: true });
        timer = setTimeout(() => finish(false), 500); timer.unref?.();
        try {
          helperChild = spawnHelper(helper, [String(process.pid), 'restore', source.handle, String(source.pid),
            String(r.x), String(r.y), String(r.width), String(r.height), captureHandle], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
          helperChild.on('error', () => finish(false)); helperChild.on('exit', () => finish(false));
          helperChild.stdout.on('error', () => finish(false)); helperChild.stderr?.on('error', () => finish(false));
          helperChild.stdout.on('data', chunk => {
            output += chunk.toString('utf8');
            if (output.length > 2048) { finish(false); return; }
            const end = output.indexOf('\n'); if (end < 0) return;
            try { const response = JSON.parse(output.slice(0, end)); finish(response.type === 'restore' && response.id === 1 && response.restored === true); }
            catch { finish(false); }
          });
          helperChild.stderr?.on('data', () => {});
        } catch { finish(false); }
      });
    },
    clear() { binding = 0; send('clear'); },
    dispose,
  };
}
module.exports = { createTranslationSource, sourceSnapshot, sourceForRegion, windowHandle };
