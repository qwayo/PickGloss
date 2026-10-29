'use strict';

// 使用正式 renderer/controller 和自有可见 Electron 窗口，检查收边后的真实像素与鼠标入口。
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { promisify } = require('node:util');
const { quoteJavaScriptString } = require('./javascript-string.cjs');
const { createOrbController, COLLAPSE_DELAY_MS } = require('../src/windows/orb-controller.cjs');

const outputArg = process.argv.indexOf('--output-dir');
const output = path.resolve(outputArg < 0
  ? path.join(__dirname, '../output/verification', `orb-edge-visibility-${Date.now()}`)
  : process.argv[outputArg + 1]);
const minimumSizeProbe = process.argv.includes('--minimum-size-one');
const hidden = process.argv.includes('--hidden');
if (hidden) app.disableHardwareAcceleration();
app.setPath('userData', path.join(os.tmpdir(), `pickgloss-orb-edge-visibility-${process.pid}`));
let activeController = null;
ipcMain.handle('orb-visibility:hover', (_event, active) => activeController?.hover(active));
const run = promisify(execFile);

function visibleBarBounds(image) {
  const { width, height } = image.getSize();
  const bitmap = image.toBitmap();
  let left = width, top = height, right = -1, bottom = -1, count = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 4;
    const alpha = bitmap[offset + 3];
    if (alpha >= 180) {
      left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y); count++;
    }
  }
  return { count, bounds: count ? { x: left, y: top, width: right - left + 1, height: bottom - top + 1 } : null };
}

function expectedAxis(edge) { return ['left', 'right'].includes(edge) ? 'vertical' : 'horizontal'; }

function captureFrame(win) {
  if (!hidden) return win.webContents.capturePage();
  return new Promise((resolve, reject) => {
    const finish = (error, image) => {
      clearTimeout(timer); win.webContents.off('paint', onPaint);
      error ? reject(error) : resolve(image);
    };
    const onPaint = (_event, _dirty, image) => finish(image?.isEmpty() === false ? null : Error('离屏条形绘制返回空画面'), image);
    const timer = setTimeout(() => finish(Error('离屏条形绘制等待超时')), 5000);
    win.webContents.once('paint', onPaint);
    try { win.webContents.startPainting(); win.webContents.invalidate(); } catch (error) { finish(error); }
  });
}

async function inspectNativeHitTest(win, button, bounds) {
  if (typeof screen.dipToScreenPoint !== 'function') throw new Error('当前 Electron 缺少 DIP 到屏幕像素转换，原生可达性未覆盖');
  const dipPoint = { x: bounds.x + button.x + button.width / 2, y: bounds.y + button.y + button.height / 2 };
  const point = screen.dipToScreenPoint(dipPoint);
  const handleBytes = win.getNativeWindowHandle();
  const handle = String(handleBytes.length === 8 ? handleBytes.readBigUInt64LE() : handleBytes.readUInt32LE());
  try {
    const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'probe-orb-hit-test.ps1'),
      '-WindowHandle', handle, '-OwnerPid', String(process.pid), '-X', String(point.x), '-Y', String(point.y)],
    { encoding: 'utf8', windowsHide: true, timeout: 12000 });
    return JSON.parse(result.stdout.trim());
  } catch (error) { throw Error(`条形入口 native hit-test 失败：${error.stderr || error.message}`); }
}

app.whenReady().then(async () => {
  let win, controller, orb;
  let phase = '准备输出目录';
  const report = { 通过: false, 可见窗口: !hidden, 覆盖: '正式 styles.css/orb.js/orb.css/controller、原生 resize、条像素到 workArea 的映射；未连接服务或用户数据', minimumSizeProbe, 场景: [] };
  const watchdog = setTimeout(() => { console.error('悬浮球边缘可见性检查超时'); app.exit(1); }, 45_000);
  try {
    await fs.mkdir(output, { recursive: true });
    const preload = path.join(output, 'orb-visibility-preload.cjs');
    const fixture = path.join(output, 'orb-visibility-probe.html');
    await fs.writeFile(preload, "'use strict';\nconst { contextBridge, ipcRenderer } = require('electron');\ncontextBridge.exposeInMainWorld('__orbBridge', { hover: active => ipcRenderer.invoke('orb-visibility:hover', active) });\n", 'utf8');
    await fs.writeFile(fixture, '<!doctype html><html><head><style>*{box-sizing:border-box}html,body,#app{width:100%;height:100%;margin:0}body{background:transparent;overflow:hidden}</style></head><body><main id="app"></main></body></html>', 'utf8');
    phase = '读取工作区';
    const area = screen.getPrimaryDisplay().workArea;
    report.workArea = area;
    phase = '创建可见 Electron 窗口';
    win = new BrowserWindow({ x: area.x + Math.floor((area.width - 48) / 2), y: area.y + Math.floor((area.height - 48) / 2),
      width: 48, height: 48, frame: false, transparent: true, backgroundColor: '#00000000', resizable: false,
      focusable: false, hasShadow: false, skipTaskbar: true, alwaysOnTop: true, webPreferences: { preload, offscreen: hidden, backgroundThrottling: false } });
    win.setAlwaysOnTop(true, 'pop-up-menu');
    if (minimumSizeProbe) win.setMinimumSize(1, 1);
    phase = '加载隔离页面';
    await win.loadFile(fixture);
    phase = '加载正式 renderer 资源';
    const rendererScript = await fs.readFile(path.join(__dirname, '../src/renderer/orb.js'), 'utf8');
    const rendererCss = await fs.readFile(path.join(__dirname, '../src/renderer/orb.css'), 'utf8');
    const sharedCss = await fs.readFile(path.join(__dirname, '../src/renderer/styles.css'), 'utf8');
    await win.webContents.insertCSS(sharedCss);
    await win.webContents.insertCSS(rendererCss);
    phase = '注入 renderer 模块';
    await win.webContents.executeJavaScript(`${rendererScript.replace(/^export /gm, '')}\nwindow.__mountOrb=mountOrb;true;`);
    phase = '挂载悬浮球 renderer';
    await win.webContents.executeJavaScript(`window.__orb=window.__mountOrb({root:document.querySelector('#app'),createBrand:()=>document.createElementNS('http://www.w3.org/2000/svg','svg'),onHover:active=>window.__orbBridge.hover(active)});true;`);
    orb = { update: value => win.webContents.executeJavaScript(`window.__orb.update(JSON.parse(${quoteJavaScriptString(JSON.stringify(value))}))`) };
    if (!hidden) win.showInactive();
    phase = '初始化原生 controller';
    await delay(180);
    if (!hidden) assert.equal(win.isVisible(), true, '取证窗口必须真实显示');
    controller = createOrbController({ win, screen, onState: state => { void orb.update(state); } });
    activeController = controller;
    controller.configure({ quietFadeEnabled: false });

    let expandedPosition = { x: win.getBounds().x, y: win.getBounds().y };
    for (const edge of ['left', 'right', 'top', 'bottom']) {
      phase = `拖至 ${edge} 边`;
      const startBounds = win.getBounds();
      const beforeDrag = await win.webContents.executeJavaScript(`(()=>{const r=document.querySelector('.orb').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      const from = { x: startBounds.x + beforeDrag.x, y: startBounds.y + beforeDrag.y };
      const target = { x: edge === 'left' ? area.x : edge === 'right' ? area.x + area.width - 48 : area.x + 100,
        y: edge === 'top' ? area.y : edge === 'bottom' ? area.y + area.height - 48 : area.y + 100 };
      const x = from.x + target.x - expandedPosition.x, y = from.y + target.y - expandedPosition.y;
      controller.drag({ phase: 'start', ...from });
      controller.drag({ phase: 'move', x, y });
      controller.drag({ phase: 'end', x, y });
      await delay(COLLAPSE_DELAY_MS + 120);
      const bounds = win.getBounds();
      const renderer = await win.webContents.executeJavaScript(`(()=>{const node=document.querySelector('.orb'),r=node.getBoundingClientRect(),s=getComputedStyle(node,'::before');return {viewport:{width:innerWidth,height:innerHeight},button:{x:r.x,y:r.y,width:r.width,height:r.height},before:{content:s.content,width:parseFloat(s.width),height:parseFloat(s.height),backgroundColor:s.backgroundColor},collapsed:node.classList.contains('is-collapsed'),edge:node.classList.contains('edge-${edge}')}})()`);
      const nativeHitTest = hidden ? null : await inspectNativeHitTest(win, renderer.button, bounds);
      const image = await captureFrame(win);
      assert.equal(image.isEmpty(), false, `${edge} 边收起必须有有效 Electron 渲染帧`);
      const imageSize = image.getSize();
      const pixels = visibleBarBounds(image);
      const vertical = expectedAxis(edge) === 'vertical';
      assert.equal(renderer.before.width, vertical ? 8 : 32, `${edge} 短签条宽度`);
      assert.equal(renderer.before.height, vertical ? 32 : 8, `${edge} 短签条高度`);
      const ratio = imageSize.width / Math.max(1, bounds.width);
      const pixelBounds = pixels.bounds;
      const geometry = pixelBounds && (vertical
        ? pixelBounds.height >= 28 * ratio && pixelBounds.width <= 14 * ratio
        : pixelBounds.width >= 28 * ratio && pixelBounds.height <= 14 * ratio);
      const targetWidth = vertical ? 12 : 48, targetHeight = vertical ? 48 : 12;
      const pixelRect = pixelBounds && { x: pixelBounds.x / ratio, y: pixelBounds.y / ratio,
        width: pixelBounds.width / ratio, height: pixelBounds.height / ratio };
      const screenRect = pixelRect && { ...pixelRect, x: bounds.x + pixelRect.x, y: bounds.y + pixelRect.y };
      const areaRight = area.x + area.width, areaBottom = area.y + area.height;
      const edgeInset = screenRect && (edge === 'left' ? screenRect.x - area.x : edge === 'right' ? areaRight - (screenRect.x + screenRect.width)
        : edge === 'top' ? screenRect.y - area.y : areaBottom - (screenRect.y + screenRect.height));
      const insideWorkArea = !!screenRect && screenRect.x >= area.x && screenRect.y >= area.y && screenRect.x + screenRect.width <= areaRight && screenRect.y + screenRect.height <= areaBottom;
      const item = { edge, nativeBounds: bounds, requestedNativeBounds: { width: targetWidth, height: targetHeight }, nativeBoundsMatch: bounds.width === targetWidth && bounds.height === targetHeight,
        renderer, nativeHitTest, imageSize, ratio, barPixels: pixels, screenRect, edgeInset, insideWorkArea, elongatedBarVisible: !!geometry };
      report.场景.push(item);
      await fs.writeFile(path.join(output, `收边-${edge}.png`), image.toPNG());
      assert.ok(bounds.width >= targetWidth && bounds.height >= targetHeight, `${edge} 原生收缩不得小于条形区域`);
      assert.equal(renderer.collapsed, true, `${edge} renderer 必须进入收起态`);
      assert.equal(renderer.edge, true, `${edge} renderer 必须使用对应边方向`);
      assert.ok(geometry, `${edge} 原生收缩后没有可见条形像素：${JSON.stringify(item)}`);
      assert.equal(insideWorkArea, true, `${edge} 条像素必须落在真实 workArea 内：${JSON.stringify(item)}`);
      assert.ok(Math.abs(edgeInset) <= 6, `${edge} 条像素必须贴近真实 workArea 边：${JSON.stringify(item)}`);

      await win.webContents.executeJavaScript("window.__orb.element.dispatchEvent(new Event('pointerenter'));true;");
      await delay(120);
      assert.deepEqual(win.getBounds(), { ...bounds,
        x: edge === 'right' ? area.x + area.width - 48 : bounds.x,
        y: edge === 'bottom' ? area.y + area.height - 48 : bounds.y,
        width: 48, height: 48 }, `${edge} 悬停必须恢复完整窗口区域`);
      const expanded = await win.webContents.executeJavaScript(`(()=>{const node=document.querySelector('.orb');return {collapsed:node.classList.contains('is-collapsed'),brandVisible:getComputedStyle(node.querySelector('.orb-brand')||node).display!=='none'}})()`);
      assert.equal(expanded.collapsed, false, `${edge} 悬停必须展开 renderer`);
      await win.webContents.executeJavaScript("window.__orb.element.dispatchEvent(new Event('pointerleave'));true;");
      await delay(COLLAPSE_DELAY_MS + 120);
      assert.ok(win.getBounds().width >= targetWidth && win.getBounds().height >= targetHeight, `${edge} 移出后应在 1 秒收回`);
      expandedPosition = target;
    }

    report.通过 = true;
    await fs.writeFile(path.join(output, '悬浮球贴边可见性.json'), JSON.stringify(report, null, 2));
    console.log(`四边真实 Electron 条形像素和悬停展开完成：${JSON.stringify(report.场景.map(({ edge, nativeBounds, nativeBoundsMatch, imageSize, barPixels, edgeInset, insideWorkArea }) => ({ edge, nativeBounds, nativeBoundsMatch, imageSize, barPixels, edgeInset, insideWorkArea })))}`);
    clearTimeout(watchdog); activeController = null; controller.dispose(); win.destroy(); app.exit(0);
  } catch (error) {
    report.错误 = error.message;
    await fs.writeFile(path.join(output, '悬浮球贴边可见性.json'), JSON.stringify(report, null, 2)).catch(() => {});
    console.error(`真实 Electron 悬浮球可见性失败（${phase}）：${error.stack || error.message}`);
    clearTimeout(watchdog); activeController = null; controller?.dispose(); if (win && !win.isDestroyed()) win.destroy(); app.exit(1);
  }
});
