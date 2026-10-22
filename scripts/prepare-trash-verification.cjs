'use strict';
// 只在系统临时目录创建虚构会话；真实删除和系统回收站还原由用户在正式界面操作。
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { deflateSync } = require('node:zlib');
const { createStore } = require('../src/core/store.cjs');

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const quoted = value => `'${value.replaceAll("'", "''")}'`;
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function pngChunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const body = Buffer.concat([name, data]);
  let crc = 0xffffffff;
  for (const byte of body) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  body.copy(output, 4);
  output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, output.length - 4);
  return output;
}
function stripedImage() {
  const width = 160, height = 96;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6;
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = y * (1 + width * 4) + 1 + x * 4;
      const blue = x < width / 2;
      raw[offset] = blue ? 25 : 250;
      raw[offset + 1] = blue ? 88 : 198;
      raw[offset + 2] = blue ? 200 : 55;
      raw[offset + 3] = 255;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
async function sessionFiles(root, id, image) {
  const folder = path.join(root, 'data', 'sessions', id);
  const record = await fs.readFile(path.join(folder, 'session.json'));
  const result = { id, folder, recordSha256: digest(record), recordBytes: record.length };
  if (image) {
    const crop = await fs.readFile(path.join(folder, 'crop.png'));
    result.cropSha256 = digest(crop); result.cropBytes = crop.length;
  }
  return result;
}
async function verify(file) {
  const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
  const root = path.resolve(manifest.verificationDirectory);
  if (path.dirname(root).toLowerCase() !== path.resolve(os.tmpdir()).toLowerCase() ||
      !path.basename(root).startsWith('pickgloss-verification-') ||
      await fs.readFile(path.join(root, 'verification.marker'), 'utf8') !== 'PickGloss 隔离验证目录\n') {
    throw new Error('样本目录不是有效的独立临时目录。');
  }
  for (const expected of manifest.sessions) {
    const actual = await sessionFiles(root, expected.id, Boolean(expected.cropSha256));
    if (actual.folder !== expected.folder || actual.recordSha256 !== expected.recordSha256 ||
        actual.cropSha256 !== expected.cropSha256) throw new Error(`样本恢复后内容不同：${expected.id}`);
  }
  console.log(`固定样本文件核对通过：${manifest.sessions.length} 条会话，记录与截图摘要一致。此结果不代替用户的回收站操作反馈。`);
}
async function prepare(packageRoot) {
  if (process.platform !== 'win32') throw new Error('此人工样本只供 Windows 候选包使用。');
  const root = path.resolve(packageRoot);
  const packageManifest = JSON.parse(await fs.readFile(path.join(root, 'candidate-manifest.json'), 'utf8'));
  const executable = path.join(root, packageManifest.packageDirectory, 'PickGloss.exe');
  await fs.access(executable);
  const verificationDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'pickgloss-verification-ticket14-'));
  await fs.writeFile(path.join(verificationDirectory, 'verification.marker'), 'PickGloss 隔离验证目录\n', { flag: 'wx' });
  const store = createStore({ directory: path.join(verificationDirectory, 'data') });
  await store.init();
  const image = stripedImage();
  const screenshot = await store.createSession({
    kind: 'image', imageData: `data:image/png;base64,${image.toString('base64')}`,
    title: '回收站样本·蓝黄条纹截图', text: '截图讲解', note: '虚构截图说明：左侧蓝色，右侧黄色。', saved: true, activeMode: 'visual',
    source: { app: '固定虚构样本', title: '蓝黄条纹', method: '预制图片' },
    threads: {
      context: { messages: [], draft: '' }, independent: { messages: [], draft: '' },
      visual: { messages: [
        { id: '图片回答', role: 'assistant', content: '这是一张虚构的蓝黄条纹图片。', status: 'complete' },
        { id: '图片追问', role: 'user', content: '右边是什么颜色？', status: 'complete' },
        { id: '图片追答', role: 'assistant', content: '右边是黄色。', status: 'complete' },
      ], draft: '未发送：请比较左右两侧。', status: 'done' },
    },
  });
  const text = await store.createSession({
    title: '回收站样本·双模式文字', text: 'compound', context: 'Small discoveries compound over time.',
    contextOrigin: '虚构固定段落', saved: true, activeMode: 'context',
    source: { app: '固定虚构样本', title: '双模式文字', method: '预制文字' },
    threads: {
      context: { messages: [
        { id: '语境回答', role: 'assistant', content: '这里表示逐渐积累。', status: 'complete' },
        { id: '语境追问', role: 'user', content: '请举一个例子。', status: 'complete' },
        { id: '语境追答', role: 'assistant', content: '每天一点进步会累积。', status: 'complete' },
      ], draft: '未发送：解释句子语气。', status: 'done' },
      independent: { messages: [
        { id: '独立回答', role: 'assistant', content: 'compound 可以表示复合物，也可以表示使加重。', status: 'complete' },
      ], draft: '未发送：给出词性。', status: 'done' },
      visual: { messages: [], draft: '' },
    },
  });
  const reentry = await store.createSession({
    title: '回收站样本·重新进入历史', text: 'restore-entry', context: 'A saved session can be found again.',
    contextOrigin: '虚构固定段落', activeMode: 'context',
    source: { app: '固定虚构样本', title: '重新进入历史', method: '预制文字' },
    threads: {
      context: { messages: [{ id: '返回回答', role: 'assistant', content: '重新进入历史时应能找到本会话。', status: 'complete' }], draft: '未发送：再次确认。', status: 'done' },
      independent: { messages: [], draft: '' }, visual: { messages: [], draft: '' },
    },
  });
  const manifest = {
    purpose: '工单 #14 固定虚构人工样本；真实系统回收站删除与还原由用户操作。',
    candidateId: packageManifest.candidateId,
    sourceFingerprint: packageManifest.sourceFingerprint,
    packageFingerprint: packageManifest.packageFingerprint,
    verificationDirectory,
    executable,
    launchCommand: `& ${quoted(executable)} ${quoted(`--verification-data-dir=${verificationDirectory}`)}`,
    sessions: [await sessionFiles(verificationDirectory, screenshot.id, true), await sessionFiles(verificationDirectory, text.id, false),
      await sessionFiles(verificationDirectory, reentry.id, false)],
    expected: {
      screenshot: { id: screenshot.id, title: screenshot.title, note: screenshot.note, saved: screenshot.saved,
        answer: screenshot.threads.visual.messages.at(-1).content, draft: screenshot.threads.visual.draft },
      text: { id: text.id, title: text.title, source: text.text, context: text.context, saved: text.saved,
        contextAnswer: text.threads.context.messages.at(-1).content, independentAnswer: text.threads.independent.messages.at(-1).content,
        contextDraft: text.threads.context.draft, independentDraft: text.threads.independent.draft },
      reentry: { id: reentry.id, title: reentry.title, source: reentry.text, answer: reentry.threads.context.messages[0].content },
    },
  };
  const target = path.join(verificationDirectory, 'sample-manifest.json');
  await fs.writeFile(target, JSON.stringify(manifest, null, 2), { encoding: 'utf8', flag: 'wx' });
  console.log(`固定样本已准备：${target}`);
  console.log(`候选包：${manifest.candidateId}`);
  console.log(`启动命令：${manifest.launchCommand}`);
  console.log('请从正式界面操作删除和 Windows 回收站还原；准备脚本没有执行删除。');
}
const args = process.argv.slice(2);
if (args[0] === '--verify' && args.length === 2) verify(path.resolve(args[1])).catch(error => { console.error(error.message); process.exitCode = 1; });
else if (args.length === 1) prepare(args[0]).catch(error => { console.error(error.message); process.exitCode = 1; });
else { console.error('用法：node scripts/prepare-trash-verification.cjs <候选包目录> | --verify <样本清单>'); process.exitCode = 1; }
