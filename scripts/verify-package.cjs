'use strict';
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function archiveDigest(archive, entry) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const child = spawn('tar', ['-xOf', archive, entry], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stderr = '';
    child.stdout.on('data', chunk => hash.update(chunk));
    child.stderr.on('data', chunk => { if (stderr.length < 2000) stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(hash.digest('hex')) : reject(new Error(`压缩包内容无法读取：${entry}；${stderr.trim()}`)));
  });
}
function fingerprint(entries) {
  const hash = createHash('sha256');
  for (const item of entries) hash.update(`${item.path}\0${item.sha256}\n`);
  return hash.digest('hex');
}
async function scan(root, relative = '') {
  const result = [];
  for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = path.posix.join(relative.replaceAll('\\', '/'), entry.name);
    if (entry.isSymbolicLink()) throw new Error(`包内出现链接：${name}`);
    if (entry.isDirectory()) result.push(...await scan(root, name));
    else if (entry.isFile()) result.push(name);
  }
  return result.sort();
}

(async () => {
  const args = process.argv.slice(2);
  const positional = args.filter(value => !value.startsWith('--'));
  const expectedArguments = args.filter(value => value.startsWith('--expected-zip-sha256='));
  if (positional.length !== 1 || expectedArguments.length > 1 ||
      args.some(value => value.startsWith('--') && !value.startsWith('--expected-zip-sha256='))) {
    throw new Error('用法：node scripts/verify-package.cjs <候选目录> [--expected-zip-sha256=<64位SHA-256>]');
  }
  const expectedZipSha256 = expectedArguments[0]?.slice('--expected-zip-sha256='.length) || '';
  if (expectedZipSha256 && !/^[a-f0-9]{64}$/i.test(expectedZipSha256)) throw new Error('外部 ZIP SHA-256 格式无效。');
  const output = path.resolve(positional[0]);
  const manifest = JSON.parse(await fs.readFile(path.join(output, 'candidate-manifest.json'), 'utf8'));
  const packageDirectory = path.join(output, manifest.packageDirectory);
  const requiredLicensePaths = [
    'LICENSE',
    'LICENSE-PickGloss.txt',
    'LICENSES.chromium.html',
    'resources/app/THIRD_PARTY_LICENSES.md',
    'resources/app/node_modules/markdown-it/LICENSE',
    'resources/app/node_modules/selection-hook/LICENSE',
    'resources/app/node_modules/node-gyp-build/LICENSE',
    'resources/app/node_modules/punycode.js/LICENSE-MIT.txt',
    'resources/app/node_modules/uc.micro/LICENSE.txt',
  ];
  const actualPaths = await scan(packageDirectory);
  if (actualPaths.length !== manifest.packageFileCount ||
      actualPaths.some((value, index) => value !== manifest.files[index]?.path)) throw new Error('包内文件清单与记录不同。');
  for (const relative of requiredLicensePaths) {
    if (!actualPaths.includes(relative)) throw new Error(`包内缺少项目或第三方许可证：${relative}`);
  }
  for (const item of manifest.files) {
    if (await digest(path.join(packageDirectory, item.path)) !== item.sha256) throw new Error(`包内文件摘要不匹配：${item.path}`);
  }
  if (fingerprint(manifest.files) !== manifest.packageFingerprint) throw new Error('包内容指纹不匹配。');
  const source = [];
  for (const item of manifest.source) source.push({ path: item.path, sha256: await digest(path.join(packageDirectory, 'resources', 'app', item.path)) });
  if (fingerprint(source) !== manifest.sourceFingerprint || source.some((item, index) => item.sha256 !== manifest.source[index].sha256)) throw new Error('包内源码指纹不匹配。');
  const nativeFiles = manifest.nativeFiles || [{ path: 'resources/native/ContextProbe.exe', sha256: manifest.nativeSha256 }];
  for (const [bridge, binary] of [['window-appearance.cjs', 'WindowAppearance.exe'], ['screen-capture.cjs', 'ScreenCapture.exe']]) {
    if (manifest.source.some(item => item.path === `src/windows/${bridge}`) &&
        !nativeFiles.some(item => item.path === `resources/native/${binary}`)) throw new Error(`原生助手清单缺少 ${binary}。`);
  }
  for (const item of nativeFiles) {
    if (await digest(path.join(packageDirectory, item.path)) !== item.sha256) throw new Error(`原生助手摘要不匹配：${item.path}`);
  }
  const archive = path.join(output, `${manifest.candidateId}.zip`);
  const listed = spawnSync('tar', ['-tf', archive], { encoding: 'utf8', windowsHide: true });
  if (listed.status !== 0) throw new Error('压缩包无法读取。');
  const expectedFiles = new Set([...manifest.files.map(item => `${manifest.packageDirectory}/${item.path}`), 'candidate-manifest.json', 'README.txt']);
  const seenFiles = new Set(), seenDirectories = new Set();
  for (const raw of listed.stdout.split(/\r?\n/).filter(Boolean)) {
    const entry = raw.replaceAll('\\', '/').replace(/^(?:\.\/)+/, '');
    if (!entry || entry.startsWith('/') || entry.split('/').includes('..')) throw new Error(`压缩包路径无效：${raw}`);
    if (entry.endsWith('/')) {
      const directory = entry.slice(0, -1);
      if (seenDirectories.has(directory)) throw new Error(`压缩包路径重复：${directory}`);
      if (directory !== manifest.packageDirectory && !directory.startsWith(`${manifest.packageDirectory}/`)) throw new Error(`压缩包出现清单外目录：${directory}`);
      seenDirectories.add(directory);
    } else {
      if (seenFiles.has(entry)) throw new Error(`压缩包文件重复：${entry}`);
      if (!expectedFiles.has(entry)) throw new Error(`压缩包出现清单外文件：${entry}`);
      seenFiles.add(entry);
    }
  }
  for (const required of expectedFiles) {
    if (!seenFiles.has(required)) throw new Error(`压缩包缺少文件：${required}`);
  }
  const expanded = spawnSync('tar', ['-xOf', archive], { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', windowsHide: true });
  if (expanded.status !== 0) throw new Error(`压缩包内容无法完整解压：${expanded.stderr || ''}`);
  for (const item of manifest.files) {
    const entry = `${manifest.packageDirectory}/${item.path}`;
    if (await archiveDigest(archive, entry) !== item.sha256) throw new Error(`压缩包与内容清单不匹配：${item.path}`);
  }
  for (const sidecar of ['candidate-manifest.json', 'README.txt']) {
    if (await archiveDigest(archive, sidecar) !== await digest(path.join(output, sidecar))) throw new Error(`压缩包与旁边的${sidecar}不匹配。`);
  }
  const zipSha256 = await digest(archive);
  if (expectedZipSha256 && zipSha256 !== expectedZipSha256.toLowerCase()) throw new Error('ZIP SHA-256 与外部提供的摘要不匹配。');
  console.log(`包核对通过：${manifest.candidateId}；${actualPaths.length} 个文件；源码指纹 ${manifest.sourceFingerprint}；包内容指纹 ${manifest.packageFingerprint}；ZIP SHA-256 ${zipSha256}${expectedZipSha256 ? '（已匹配外部摘要）' : ''}`);
})().catch(error => { console.error(error.message); process.exitCode = 1; });
