'use strict';
// 只通过公开包核验命令检查受控小包；不使用真实便携包或用户数据。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');

const candidateId = 'PickGloss-test-candidate';
const packageDirectory = 'PickGloss-win32-x64';
const fixtureRoot = path.join(__dirname, '../../build/verify-package-fixtures');
const verifier = path.join(__dirname, '../../scripts/verify-package.cjs');
const files = new Map([
  ['PickGloss.exe', '固定程序内容\n'],
  ['LICENSE', '固定 Electron 许可证\n'],
  ['LICENSE-PickGloss.txt', '固定项目许可证\n'],
  ['LICENSES.chromium.html', '固定 Chromium 许可证\n'],
  ['resources/app/THIRD_PARTY_LICENSES.md', '固定第三方许可汇总\n'],
  ['resources/app/src/main.cjs', 'module.exports = "固定主入口";\n'],
  ['resources/app/src/preload.cjs', 'module.exports = "固定预加载";\n'],
  ['resources/app/src/windows/window-appearance.cjs', 'module.exports = "固定窗口外观桥接";\n'],
  ['resources/app/src/windows/screen-capture.cjs', 'module.exports = "固定屏幕采集桥接";\n'],
  ['resources/app/src/windows/translation-source.cjs', 'module.exports = "固定截图来源窗口桥接";\n'],
  ['resources/app/src/windows/browser-context.cjs', 'module.exports = "固定浏览器页面归属桥接";\n'],
  ['resources/app/node_modules/markdown-it/LICENSE', '固定 markdown-it 许可证\n'],
  ['resources/app/node_modules/selection-hook/LICENSE', '固定 selection-hook 许可证\n'],
  ['resources/app/node_modules/node-gyp-build/LICENSE', '固定 node-gyp-build 许可证\n'],
  ['resources/app/node_modules/punycode.js/LICENSE-MIT.txt', '固定 punycode.js 许可证\n'],
  ['resources/app/node_modules/uc.micro/LICENSE.txt', '固定 uc.micro 许可证\n'],
  ['resources/app/node_modules/selection-hook/package.json', '{"name":"固定依赖"}\n'],
  ['resources/app/extra.txt', '固定非抽样产品文件\n'],
  ['resources/native/ContextProbe.exe', '固定原生助手内容\n'],
  ['resources/native/WindowAppearance.exe', '固定窗口外观助手内容\n'],
  ['resources/native/ScreenCapture.exe', '固定屏幕采集助手内容\n'],
  ['resources/native/TranslationSource.exe', '固定截图来源窗口助手内容\n'],
  ['resources/native/BrowserContext.exe', '固定浏览器页面归属助手内容\n'],
]);
const readme = '拾译隔离测试包\n请核对完整清单。\n';
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function fingerprint(entries) { return hash(entries.map(item => `${item.path}\0${item.sha256}\n`).join('')); }
async function put(root, relative, content) {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
}
async function makeCase(name, options = {}) {
  const root = path.join(fixtureRoot, name);
  const output = path.join(root, 'output');
  const stage = path.join(root, 'stage');
  const product = path.join(output, packageDirectory);
  const stagedProduct = path.join(stage, packageDirectory);
  const entries = [...files].map(([file, content]) => ({ path: file, sha256: hash(content) }))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const source = entries.filter(item => item.path.startsWith('resources/app/src/')).map(item => ({ path: item.path.slice('resources/app/'.length), sha256: item.sha256 }));
  const manifest = {
    candidateId, packageDirectory, packageFileCount: entries.length, files: entries,
    source, sourceFingerprint: fingerprint(source), packageFingerprint: fingerprint(entries),
    nativeSha256: entries.find(item => item.path === 'resources/native/ContextProbe.exe').sha256,
    nativeFiles: entries.filter(item => item.path.startsWith('resources/native/') &&
      !(options.missingAppearanceEntry && item.path.endsWith('/WindowAppearance.exe')) &&
      !(options.missingCaptureEntry && item.path.endsWith('/ScreenCapture.exe')) &&
      !(options.missingTranslationSourceEntry && item.path.endsWith('/TranslationSource.exe')) &&
      !(options.missingBrowserContextEntry && item.path.endsWith('/BrowserContext.exe'))),
  };
  for (const [file, content] of files) {
    await put(product, file, content);
    if (!options.omit?.includes(file)) await put(stagedProduct, file, options.change?.[file] || content);
  }
  if (options.unlisted) await put(stagedProduct, options.unlisted, '清单外的文件\n');
  const manifestText = JSON.stringify(manifest, null, 2);
  await put(output, 'candidate-manifest.json', manifestText);
  await put(output, 'README.txt', readme);
  await put(stage, 'candidate-manifest.json', options.manifestText || manifestText);
  await put(stage, 'README.txt', options.readme || readme);
  const archive = path.join(output, `${candidateId}.zip`);
  const archiveItems = [packageDirectory, 'candidate-manifest.json', 'README.txt', ...(options.duplicate ? [`${packageDirectory}/${options.duplicate}`] : [])];
  const zipped = spawnSync('tar', ['-a', '-c', '-f', archive, '-C', stage, ...archiveItems], { encoding: 'utf8', windowsHide: true });
  assert.equal(zipped.status, 0, zipped.stderr || zipped.stdout);
  return output;
}
function verify(output, args = []) {
  return spawnSync(process.execPath, [verifier, output, ...args], { encoding: 'utf8', windowsHide: true });
}

test('完整的合成便携包通过公开核验命令', async () => {
  const result = verify(await makeCase('complete'));
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, new RegExp(`${files.size} 个文件`));
});

test('含窗口外观桥接的便携包不能省略外观助手清单或产物', async () => {
  const missingEntry = verify(await makeCase('missing-appearance-entry', { missingAppearanceEntry: true }));
  assert.notEqual(missingEntry.status, 0); assert.match(missingEntry.stderr, /WindowAppearance\.exe/);
  const missingBinary = verify(await makeCase('missing-appearance-binary', { omit: ['resources/native/WindowAppearance.exe'] }));
  assert.notEqual(missingBinary.status, 0); assert.match(missingBinary.stderr, /WindowAppearance\.exe/);
});

test('含屏幕采集桥接的便携包不能省略截图助手清单或产物', async () => {
  const missingEntry = verify(await makeCase('missing-capture-entry', { missingCaptureEntry: true }));
  assert.notEqual(missingEntry.status, 0); assert.match(missingEntry.stderr, /ScreenCapture\.exe/);
  const missingBinary = verify(await makeCase('missing-capture-binary', { omit: ['resources/native/ScreenCapture.exe'] }));
  assert.notEqual(missingBinary.status, 0); assert.match(missingBinary.stderr, /ScreenCapture\.exe/);
});

test('含截图来源窗口桥接的便携包不能省略来源助手清单或产物', async () => {
  const missingEntry = verify(await makeCase('missing-translation-source-entry', { missingTranslationSourceEntry: true }));
  assert.notEqual(missingEntry.status, 0); assert.match(missingEntry.stderr, /TranslationSource\.exe/);
  const missingBinary = verify(await makeCase('missing-translation-source-binary', { omit: ['resources/native/TranslationSource.exe'] }));
  assert.notEqual(missingBinary.status, 0); assert.match(missingBinary.stderr, /TranslationSource\.exe/);
});

test('含浏览器页面归属桥接的候选清单不能省略上下文助手', async () => {
  const missingEntry = verify(await makeCase('missing-browser-context-entry', { missingBrowserContextEntry: true }));
  assert.notEqual(missingEntry.status, 0); assert.match(missingEntry.stderr, /BrowserContext\.exe/);
  const missingBinary = verify(await makeCase('missing-browser-context-binary', { omit: ['resources/native/BrowserContext.exe'] }));
  assert.notEqual(missingBinary.status, 0); assert.match(missingBinary.stderr, /BrowserContext\.exe/);
});

test('便携包缺少运行时第三方许可证时失败', async () => {
  const output = await makeCase('missing-third-party-license', { omit: ['resources/app/node_modules/markdown-it/LICENSE'] });
  const result = verify(output);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /markdown-it\/LICENSE/);
});

test('ZIP 中非抽样产品文件被替换时失败', async () => {
  const output = await makeCase('changed-extra-file', { change: { 'resources/app/extra.txt': '被替换的内容\n' } });
  const result = verify(output);
  assert.notEqual(result.status, 0, 'ZIP 内任一产品文件都应与清单摘要相同');
  assert.match(result.stderr, /extra\.txt/);
});

test('ZIP 中清单文件遗漏时失败', async () => {
  const result = verify(await makeCase('omitted-file', { omit: ['resources/app/extra.txt'] }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /extra\.txt/);
});

test('ZIP 中同一路径重复时失败', async () => {
  const result = verify(await makeCase('duplicate-entry', { duplicate: 'resources/app/extra.txt' }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /重复|extra\.txt/);
});

test('ZIP 中存在清单外的产品文件时失败', async () => {
  const result = verify(await makeCase('unlisted-file', { unlisted: 'resources/app/unlisted.txt' }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unlisted\.txt/);
});

test('ZIP 中清单或说明文件与旁边的文件不同时失败', async () => {
  const manifestOutput = await makeCase('manifest-tamper', { manifestText: JSON.stringify({ candidateId: '另一包' }) });
  const manifestResult = verify(manifestOutput);
  assert.notEqual(manifestResult.status, 0);
  assert.match(manifestResult.stderr, /candidate-manifest\.json/);
  const readmeResult = verify(await makeCase('readme-tamper', { readme: `${readme}额外说明\n` }));
  assert.notEqual(readmeResult.status, 0);
  assert.match(readmeResult.stderr, /README\.txt/);
});

test('外部 ZIP SHA-256 匹配时通过，不匹配时失败', async () => {
  const output = await makeCase('external-digest');
  const archive = path.join(output, `${candidateId}.zip`);
  const actual = hash(await fs.readFile(archive));
  const mismatched = actual === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);

  const matched = verify(output, [`--expected-zip-sha256=${actual}`]);
  assert.equal(matched.status, 0, matched.stderr || matched.stdout);
  assert.match(matched.stdout, /已匹配外部摘要/);

  const rejected = verify(output, [`--expected-zip-sha256=${mismatched}`]);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /外部提供的摘要/);
});

test('外部 ZIP 摘要格式无效时失败', async () => {
  const result = verify(await makeCase('invalid-digest'), ['--expected-zip-sha256=not-a-digest']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /格式无效/);
});
