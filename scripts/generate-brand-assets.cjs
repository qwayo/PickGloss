'use strict';
// 从统一的选区与释义气泡标志生成矢量、应用和系统托盘位图，窗口保持隐藏。
const { quoteJavaScriptString } = require('./javascript-string.cjs');
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const glyphs = require('../src/renderer/assets/brand-glyphs.json');
app.setPath('userData', path.join(os.tmpdir(), `pickgloss-brand-export-${process.pid}`));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true } });
  try {
    const target = path.join(__dirname, '../src/renderer/assets');
    await fs.writeFile(path.join(target, 'brand-glyphs.js'), '// 选区与释义气泡共用矢量数据，避免在界面中放宽网络连接策略。\nexport default ' + JSON.stringify(glyphs, null, 2) + ';\n', 'utf8');
    await win.loadURL('data:text/html,<html lang="zh-CN"><title>图标导出</title></html>');
    const paths = (name, color) => glyphs[name].map((d, i) => `<path d="${d}" fill="${color}" fill-rule="${i === 2 ? 'evenodd' : 'nonzero'}"/>`).join('');
    // 保留现有资源路径，所有尺寸与反色版本都从同一来源重建。
    for (const [file, small, inverse] of [
      ['pickgloss-shi-app.svg', false, false], ['pickgloss-shi-app-inverse.svg', false, true],
      ['pickgloss-shi-app-small.svg', true, false], ['pickgloss-shi-app-small-inverse.svg', true, true],
    ]) {
      const foreground = inverse ? '#111111' : '#e5e7eb', background = inverse ? '#e5e7eb' : '#000000';
      const transform = small ? 'translate(6 6) scale(1.625)' : 'translate(8 8) scale(1.5)';
      await fs.writeFile(path.join(target, file), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><title>PickGloss：选区与释义气泡</title><rect width="64" height="64" rx="16" fill="${background}"/><g transform="${transform}">${paths(small ? 'small' : 'standard', foreground)}</g></svg>\n`);
    }
    for (const [file, color] of [['pickgloss-shi-tray.svg', '#111111'], ['pickgloss-shi-tray-inverse.svg', '#e5e7eb']]) await fs.writeFile(path.join(target, file), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><title>PickGloss：选区与释义气泡</title>${paths('small', color)}</svg>\n`);
    await fs.writeFile(path.join(target, 'pickgloss-shi-symbols.svg'), `<svg xmlns="http://www.w3.org/2000/svg"><defs>${['standard','small'].map(name => `<symbol id="${name}" viewBox="0 0 32 32">${paths(name, 'currentColor')}</symbol>`).join('')}</defs></svg>\n`);
    const raster = async (svg, size) => {
      const result = await win.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>{const canvas=document.createElement('canvas');canvas.width=${size};canvas.height=${size};canvas.getContext('2d').drawImage(image,0,0,${size},${size});resolve(canvas.toDataURL('image/png'));};image.onerror=()=>reject(Error('图标导出失败'));image.src=${quoteJavaScriptString(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`)};})`);
      return Buffer.from(result.split(',')[1], 'base64');
    };
    for (const [name, size, svg] of [
      ['pickgloss-app.png', 256, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#000"/><g transform="translate(8 8) scale(1.5)">${paths('standard', '#e5e7eb')}</g></svg>`],
      ['pickgloss-tray-light.png', 32, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${paths('small', '#111111')}</svg>`],
      ['pickgloss-tray-dark.png', 32, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${paths('small', '#e5e7eb')}</svg>`],
    ]) {
      await fs.writeFile(path.join(target, name), await raster(svg, size));
    }
    const entries = [];
    for (const size of [16, 24, 32, 48, 64, 128, 256]) {
      const transform = size === 16 ? 'translate(4 4) scale(1.75)' : size === 24 ? 'translate(6 6) scale(1.625)' : 'translate(8 8) scale(1.5)';
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#000"/><g transform="${transform}">${paths(size <= 24 ? 'small' : 'standard', '#e5e7eb')}</g></svg>`;
      entries.push({ size, bytes: await raster(svg, size) });
    }
    const header = Buffer.alloc(6 + entries.length * 16);
    header.writeUInt16LE(1, 2); header.writeUInt16LE(entries.length, 4);
    let offset = header.length;
    entries.forEach(({ size, bytes }, index) => {
      const start = 6 + index * 16;
      header[start] = size === 256 ? 0 : size; header[start + 1] = size === 256 ? 0 : size;
      header.writeUInt16LE(1, start + 4); header.writeUInt16LE(32, start + 6);
      header.writeUInt32LE(bytes.length, start + 8); header.writeUInt32LE(offset, start + 12); offset += bytes.length;
    });
    await fs.writeFile(path.join(target, 'pickgloss-app.ico'), Buffer.concat([header, ...entries.map(entry => entry.bytes)]));
    console.log('应用图标与浅／深任务栏托盘位图已生成。');
    win.destroy(); app.exit(0);
  } catch (error) { console.error(error); win.destroy(); app.exit(1); }
});
