'use strict';
const path = require('node:path');
const { spawn } = require('node:child_process');
const { png, failure } = require('../core/validation.cjs');
const { selectOcrCandidate } = require('./ocr-quality.cjs');
const { groupOcrCandidate } = require('./ocr-paragraphs.cjs');

function recognizeWindows({ imageData, sourceLanguage = 'auto', signal, timeoutMs = 15000, spawnImpl = spawn }) {
  const image = png(imageData);
  const bounds = { width: image.readUInt32BE(16), height: image.readUInt32BE(20) };
  if (signal?.aborted) return Promise.reject(failure('ABORTED', '已取消文字识别。'));
  return new Promise((resolve, reject) => {
    const child = spawnImpl(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'ocr.ps1')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) { child.kill(); reject(error); } else resolve(value);
    };
    const abort = () => finish(failure('ABORTED', '已取消文字识别。'));
    const timer = setTimeout(() => finish(failure('OCR_TIMEOUT', '本地文字识别超时。')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      if (Buffer.byteLength(output, 'utf8') > 2 * 1024 * 1024) finish(failure('INPUT_TOO_LONG', '本地识别结果过多，请缩小框选区域。'));
    });
    // 原生错误不包含图片、路径或请求内容，界面仅显示固定的可操作状态。
    child.stderr.resume();
    child.on('error', () => finish(failure('OCR_UNAVAILABLE', 'Windows 本地文字识别不可用。')));
    child.stdin.on('error', () => finish(failure('OCR_UNAVAILABLE', '无法向本地识别服务传入截图。')));
    child.on('close', code => {
      if (settled) return;
      let result;
      try { result = JSON.parse(output.replace(/^\uFEFF/, '').trim()); }
      catch { finish(failure('OCR_UNAVAILABLE', 'Windows 本地文字识别不可用。')); return; }
      if (code !== 0 || !result.ok) { finish(failure(result.code === 'OCR_LANGUAGE_UNAVAILABLE' ? result.code : 'OCR_UNAVAILABLE', '本地未取得可用的识别结果。')); return; }
      const candidates = Array.isArray(result.candidates) ? result.candidates : result.blocks ? [result] : [];
      const selected = selectOcrCandidate(candidates, { automatic: sourceLanguage === 'auto' });
      // 先对 WinRT 的原始 OCR 行判定质量，再合并相邻段落；TextAngle 保持原值供 core 校正坐标。
      finish(null, groupOcrCandidate(selected, bounds));
    });
    child.stdin.end(JSON.stringify({ image: imageData.slice('data:image/png;base64,'.length), sourceLanguage }));
  });
}

module.exports = { recognizeWindows };
