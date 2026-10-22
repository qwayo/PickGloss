'use strict';
// 本地合成一次清脆的玻璃敲击短音；不播放音频，也不调用外部服务。
const fs = require('node:fs');
const path = require('node:path');
const sampleRate = 48000, duration = .19, count = Math.round(sampleRate * duration);
const samples = new Float64Array(count);
let seed = 0x5049434b, lastNoise = 0;
for (let index = 0; index < count; index++) {
  const time = index / sampleRate;
  const attack = 1 - Math.exp(-time / .00065);
  const tail = Math.min(1, Math.max(0, (duration - time) / .02));
  const partials = [[1660, 1, .043], [2630, .48, .026], [3980, .25, .015], [5620, .1, .007]];
  let value = 0;
  for (const [frequency, gain, decay] of partials) value += gain * Math.sin(2 * Math.PI * frequency * time) * Math.exp(-time / decay);
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  const noise = seed / 0xffffffff * 2 - 1;
  const click = (noise - lastNoise) * .055 * Math.exp(-time / .0024);
  lastNoise = noise;
  samples[index] = (value + click) * attack * tail * tail;
}
let peak = 0;
for (const value of samples) peak = Math.max(peak, Math.abs(value));
const data = Buffer.alloc(count * 2); let sum = 0;
for (let index = 0; index < count; index++) {
  const value = samples[index] / peak * .89;
  data.writeInt16LE(Math.round(value * 32767), index * 2); sum += value * value;
}
const header = Buffer.alloc(44);
header.write('RIFF'); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8); header.write('fmt ', 12);
header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
header.write('data', 36); header.writeUInt32LE(data.length, 40);
const file = path.join(__dirname, '../src/renderer/assets/pin-on.wav');
const evidence = path.join(__dirname, '../output/verification/pin-polish-20261016/audio');
fs.mkdirSync(evidence, { recursive: true });
const baseline = path.join(evidence, '原置顶短音.wav');
if (!fs.existsSync(baseline)) fs.copyFileSync(file, baseline, fs.constants.COPYFILE_EXCL);
fs.writeFileSync(file, Buffer.concat([header, data]));
const report = { 描述: '确定性本地合成的单次玻璃敲击；只检查数字信号，不代替听感。', 时长毫秒: duration * 1000, 采样率: sampleRate, 声道: 1, 位深: 16, 峰值: .89, 均方根: Math.sqrt(sum / count), 播放音量: .85, 削波样本数: 0 };
fs.writeFileSync(path.join(evidence, '置顶短音参数.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
