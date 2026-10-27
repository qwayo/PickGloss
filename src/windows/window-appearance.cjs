'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const FRAME_CSS_KEYS = ['--native-client-width', '--native-client-height', '--native-pin-band', '--native-pin-radius',
  '--native-pin-left', '--native-pin-top', '--native-pin-right', '--native-pin-bottom', '--native-border-suppressed'];

// 按真实物理客户区定位光条；Electron 的整数 DIP 视口可能比客户区多出一两个物理像素。
function frameCssValues(metrics) {
  if (!metrics || !['width', 'height'].every(key => Number.isInteger(metrics[key]) && metrics[key] > 0 && metrics[key] <= 65536) ||
      !['left', 'top', 'right', 'bottom'].every(key => Number.isInteger(metrics[key]) && metrics[key] >= 0 && metrics[key] <= 128) ||
      !Number.isInteger(metrics.dpi) || metrics.dpi < 72 || metrics.dpi > 960) return null;
  const scale = metrics.dpi / 96, band = Math.round(3 * scale);
  const css = { '--native-client-width': metrics.width / scale, '--native-client-height': metrics.height / scale,
    '--native-pin-band': band / scale, '--native-pin-radius': Math.max(0, 8 - band / scale) };
  for (const edge of ['left', 'top', 'right', 'bottom']) css[`--native-pin-${edge}`] = Math.max(0, band - metrics[edge]) / scale;
  return { ...Object.fromEntries(Object.entries(css).map(([key, value]) => [key, `${Number(value.toFixed(6))}px`])),
    '--native-border-suppressed': metrics.suppressed === true ? '1' : '0' };
}

function createWindowAppearance(win, { helperPath, clipRadius, onReady = () => {}, onError = () => {}, spawnHelper = spawn, exists = fs.existsSync } = {}) {
  const clipped = clipRadius !== undefined;
  if (clipped && (!Number.isFinite(clipRadius) || clipRadius <= 0 || clipRadius > 64)) {
    onError(new Error('原生背景圆角半径必须大于 0 且不超过 64。')); return null;
  }
  const packaged = process.resourcesPath && path.join(process.resourcesPath, 'native', 'WindowAppearance.exe');
  const helper = helperPath || (packaged && exists(packaged) ? packaged : path.join(__dirname, '../../build/native/WindowAppearance.exe'));
  if (typeof win.getNativeWindowHandle !== 'function' || !exists(helper)) return null;
  const bytes = win.getNativeWindowHandle(), handle = String(bytes.length === 8 ? bytes.readBigUInt64LE() : bytes.readUInt32LE());
  const contents = win.webContents;
  let child, disposed = false, timer = null, sequence = 0, border = 'none', output = '', previousCss = '';
  let backdropEnabled = false, backdrop = null, ready = false, responseTimer = null;
  const events = clipped ? ['focus', 'blur', 'show', 'hide', 'resize', 'move', 'minimize', 'restore'] : ['focus', 'blur', 'show', 'resize'];
  const hooks = [0x02e0, 0x031a, 0x031e, 0x0320];
  const refresh = () => {
    if (disposed || timer) return;
    timer = setTimeout(() => { timer = null; send(); }, 0);
    timer.unref?.();
  };
  const loaded = () => { previousCss = ''; refresh(); };
  function dispose() {
    if (disposed) return;
    disposed = true; clearTimeout(timer); clearTimeout(responseTimer);
    ready = false; backdrop = null;
    for (const event of events) win.removeListener(event, refresh);
    win.removeListener('closed', dispose);
    contents.removeListener('did-finish-load', loaded);
    if (!win.isDestroyed()) {
      for (const message of hooks) win.unhookWindowMessage?.(message);
      // 助手停止后不能保留旧尺寸；让备用的百分比轮廓继续跟随窗口调整。
      void contents.executeJavaScript(`for(const key of ${JSON.stringify(FRAME_CSS_KEYS)}) document.documentElement.style.removeProperty(key)`).catch(() => {});
    }
    child?.stdin?.end(); child?.kill();
  }
  function fail(error) { if (disposed) return; dispose(); onError(error); }
  function send() {
    if (disposed || win.isDestroyed()) return;
    if (clipped && !responseTimer) {
      responseTimer = setTimeout(() => fail(new Error('窗口外观助手未及时应答。')), 5000);
      responseTimer.unref?.();
    }
    child.stdin.write(`${++sequence} ${border}${clipped ? ` ${backdropEnabled ? 1 : 0}` : ''}\n`, error => { if (error) fail(error); });
  }
  try {
    child = spawnHelper(helper, [handle, String(process.pid), ...(clipped ? [String(clipRadius)] : [])], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  } catch (error) { fail(error); return null; }
  child.on('error', fail);
  child.on('exit', code => { if (!disposed) fail(new Error(`窗口外观助手已退出：${code}`)); });
  child.stdin.on('error', fail);
  child.stdout.on('data', chunk => {
    if (disposed) return;
    output += chunk.toString('utf8');
    let end;
    while ((end = output.indexOf('\n')) >= 0) {
      const line = output.slice(0, end); output = output.slice(end + 1);
      let metrics;
      try { metrics = JSON.parse(line); } catch { fail(new Error('窗口外观助手返回了无效几何。')); return; }
      if (metrics.sequence !== sequence) continue;
      const values = frameCssValues(metrics), serialized = JSON.stringify(values);
      if (!values) { fail(new Error('窗口外观助手返回了无效几何。')); return; }
      if (clipped) {
        const value = metrics.backdrop;
        if (!value || typeof value.handle !== 'string' || !/^[1-9]\d{0,19}$/.test(value.handle) || BigInt(value.handle) > 0xffffffffffffffffn ||
            !Number.isInteger(value.pid) || value.pid < 1 || value.pid > 0xffffffff || (child.pid !== undefined && value.pid !== child.pid) ||
            typeof value.enabled !== 'boolean' || typeof value.visible !== 'boolean' || value.radius !== clipRadius) {
          fail(new Error('窗口外观助手返回了无效背景窗口。')); return;
        }
        backdrop = { handle: value.handle, pid: value.pid, enabled: value.enabled, visible: value.visible, radius: value.radius };
      }
      clearTimeout(responseTimer); responseTimer = null;
      const becameReady = !ready; ready = true;
      if (becameReady) {
        try { onReady(); } catch (error) { fail(error); return; }
        if (disposed || metrics.sequence !== sequence) continue;
      }
      if (serialized === previousCss || win.isDestroyed()) continue;
      previousCss = serialized;
      // 仅写入经过数值校验的固定 CSS 属性，不把窗口内容或任意脚本交给原生助手。
      void contents.executeJavaScript(`for(const [key,value] of Object.entries(${serialized})) document.documentElement.style.setProperty(key,value)`).catch(() => { previousCss = ''; });
    }
    if (output.length > 8192) fail(new Error('窗口外观助手返回的数据过长。'));
  });
  for (const event of events) win.on(event, refresh);
  win.on('closed', dispose);
  contents.on('did-finish-load', loaded);
  for (const message of hooks) win.hookWindowMessage?.(message, refresh);
  return {
    apply(value) { if (disposed || (value !== 'none' && !/^#[a-f\d]{6}$/i.test(value))) return false; border = value.replace('#', ''); send(); return true; },
    // 背景窗只提供实时模糊；既有 CSS 决定深浅色。减少透明、高对比与故障回退由调用者关闭背景并显示实色。
    setBackdrop(value) { if (!clipped || disposed || typeof value !== 'boolean') return false; backdropEnabled = value; send(); return true; },
    get isReady() { return ready && !disposed; },
    getBackdropInfo() { return backdrop && !disposed ? { ...backdrop } : null; },
    dispose,
  };
}

module.exports = { createWindowAppearance, frameCssValues };
