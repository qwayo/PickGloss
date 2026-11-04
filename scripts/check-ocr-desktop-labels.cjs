'use strict';

const { spawn } = require('node:child_process');
const { app, BrowserWindow } = require('electron');
const { recognizeWindows } = require('../src/windows/ocr.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

// 仅使用隔离配置和自建画布，不读取用户屏幕或当前应用数据。
app.setPath('userData', path.join(os.tmpdir(), `pickgloss-ocr-labels-${process.pid}`));
app.on('window-all-closed', () => {});
const outputIndex = process.argv.indexOf('--output-dir');
const output = outputIndex >= 0 ? path.resolve(process.argv[outputIndex + 1]) : path.resolve(__dirname, '../output/verification/ocr-desktop-labels');

const html = `<!doctype html><meta charset="utf-8"><canvas id="fixture" width="800" height="320"></canvas><script>
const canvas = document.querySelector('#fixture');
const context = canvas.getContext('2d');
context.fillStyle = '#26364b';
context.fillRect(0, 0, canvas.width, canvas.height);
const labels = [
  { text: 'Obsidian', x: 90, y: 20, color: '#7356d8' },
  { text: 'Microsoft', x: 350, y: 20, color: '#17a2d5' },
  { text: '桌面笔记', x: 640, y: 20, color: '#70a86b' },
  { text: 'WorkBuddy', x: 90, y: 170, color: '#cf704e' },
  { text: 'QQMusic', x: 350, y: 170, color: '#4ab77a' },
  { text: '会议记录', x: 640, y: 170, color: '#c39b4b' },
];
for (const item of labels) {
  context.fillStyle = item.color;
  context.fillRect(item.x - 28, item.y, 56, 56);
  context.fillStyle = '#fff';
  context.font = '22px "Segoe UI", "Microsoft YaHei UI", sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'alphabetic';
  context.fillText(item.text, item.x, item.y + 87);
}
</script>`;

let rawOutput = '';
let fixtureWindow = null;

async function main() {
  await app.whenReady();
  await fs.mkdir(output, { recursive: true });
  fixtureWindow = new BrowserWindow({
    show: false,
    focusable: false,
    backgroundColor: '#26364b',
    webPreferences: { sandbox: true, contextIsolation: true },
  });
  await fixtureWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  const imageData = await fixtureWindow.webContents.executeJavaScript("document.querySelector('#fixture').toDataURL('image/png')");
  await fs.writeFile(path.join(output, '合成桌面标签.png'), Buffer.from(imageData.split(',')[1], 'base64'));
  const result = await recognizeWindows({
    imageData,
    sourceLanguage: 'auto',
    spawnImpl: (...args) => {
      const child = spawn(...args);
      child.stdout.on('data', chunk => { rawOutput += chunk.toString('utf8'); });
      return child;
    },
  });
  const raw = JSON.parse(rawOutput.trim());
  const labels = ['Obsidian', 'Microsoft', '桌面笔记', 'WorkBuddy', 'QQMusic', '会议记录'];
  const text = result.blocks.map(block => block.text).join('\n').replace(/\s/g, '');
  const report = {
    fixture: '隐藏画布生成的合成桌面标签图；未读取或截取用户屏幕。',
    labels,
    originalOcrLines: (raw.candidates || []).map(candidate => ({
      language: candidate.language,
      blocks: (candidate.blocks || []).map(({ text, x, y, width, height, words }) => ({ text, x, y, width, height, words })),
    })),
    selectedLanguage: result.language,
    processedBlocks: result.blocks.map(({ text, x, y, width, height }) => ({ text, x, y, width, height })),
    标注识别结果: labels.map(label => ({ 原文: label, 完整识别: text.includes(label) })),
    边界: '合成图片的本机真实 Windows OCR 诊断，不能证明用户原始截图或真实模型翻译质量。',
  };
  await fs.writeFile(path.join(output, '桌面标签识别报告.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify({ 报告: output, 选用语言: report.selectedLanguage, 标注识别结果: report.标注识别结果 }, null, 2));
}

async function run() {
  let exitCode = 0;
  try {
    await main();
  } catch (error) {
    console.error(error && error.stack ? error.stack : String(error));
    exitCode = 1;
  }
  if (fixtureWindow && !fixtureWindow.isDestroyed()) fixtureWindow.destroy();
  app.exit(exitCode);
}

run();
