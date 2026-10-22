'use strict';
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { includePackagePath } = require('./package-files.cjs');

async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function filesBelow(root, relative = '') {
  const result = [];
  for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = path.posix.join(relative.replaceAll('\\', '/'), entry.name);
    if (entry.isSymbolicLink()) throw new Error(`包内不应包含链接：${name}`);
    if (entry.isDirectory()) result.push(...await filesBelow(root, name));
    else if (entry.isFile()) result.push(name);
  }
  return result.sort();
}
function fingerprint(entries) {
  const hash = createHash('sha256');
  for (const item of entries) hash.update(`${item.path}\0${item.sha256}\n`);
  return hash.digest('hex');
}

(async () => {
  const root = path.resolve(__dirname, '..');
  const built = spawnSync(process.execPath, [path.join(__dirname, 'build-native.cjs')], { stdio: 'inherit', windowsHide: true });
  if (built.status !== 0) throw new Error('原生助手构建失败。');
  const { packager } = await import('@electron/packager');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const result = await packager({ dir: root, name: 'PickGloss', platform: 'win32', arch: 'x64',
    electronVersion: require('../package.json').devDependencies.electron,
    icon: path.join(root, 'src', 'renderer', 'assets', 'pickgloss-app.ico'),
    out: path.join(root, 'dist', stamp), overwrite: false, asar: false, prune: true,
    extraResource: [path.join(root, 'build', 'native')],
    ignore: [/^\/(?:\.git|\.scratch|\.codex|\.agents|dist|build|prototypes|docs|tests|scripts|output|tmp)(?:\/|$)/,
      /^\/(?:AGENTS\.md|README\.md|DESIGN\.md|GLOSSARY\.md|package-lock\.json|拾译PickGloss\.txt)$/,
      /^\/(?:\.env|settings\.json)(?:\.|$)/, /^\/(?:sessions|data|user-data|verification-data)(?:\/|$)/],
    win32metadata: { CompanyName: 'PickGloss', FileDescription: 'PickGloss Windows 划词与截图解释', ProductName: 'PickGloss', InternalName: 'PickGloss' },
  });
  if (result.length !== 1) throw new Error('预期只生成一个 Windows x64 包。');
  const packageDirectory = result[0], output = path.dirname(packageDirectory), packageName = path.basename(packageDirectory);
  const appDirectory = path.join(packageDirectory, 'resources', 'app');
  for (const relative of await filesBelow(appDirectory)) {
    if (includePackagePath(`/${relative}`)) continue;
    const target = path.join(appDirectory, relative);
    await fs.rm(target, { recursive: true, force: false });
    const parent = path.dirname(target);
    try { await fs.rmdir(parent); } catch { /* 非空目录仍包含允许文件 */ }
  }
  const unexpected = (await filesBelow(appDirectory)).filter(relative => !includePackagePath(`/${relative}`));
  if (unexpected.length) throw new Error(`包内出现白名单外文件：${unexpected.join('、')}`);
  await fs.copyFile(path.join(root, 'LICENSE'), path.join(packageDirectory, 'LICENSE-PickGloss.txt'));
  await fs.copyFile(path.join(root, 'THIRD_PARTY_LICENSES.md'), path.join(appDirectory, 'THIRD_PARTY_LICENSES.md'));
  const sourcePaths = ['LICENSE', 'package.json', ...await filesBelow(path.join(root, 'src'))
    .then(items => items.map(item => `src/${item}`).filter(item => includePackagePath(`/${item}`)))].sort();
  const source = [];
  for (const relative of sourcePaths) {
    const original = await hashFile(path.join(root, relative));
    const packaged = await hashFile(path.join(appDirectory, relative));
    if (original !== packaged && relative !== 'package.json') throw new Error(`源码与包内文件不同：${relative}`);
    source.push({ path: relative, sha256: packaged });
  }
  const nativePath = 'resources/native/ContextProbe.exe';
  const nativeHash = await hashFile(path.join(packageDirectory, nativePath));
  if (nativeHash !== await hashFile(path.join(root, 'build', 'native', 'ContextProbe.exe'))) throw new Error('原生助手与本轮构建结果不同。');
  const required = ['PickGloss.exe', 'LICENSE', 'LICENSE-PickGloss.txt', 'LICENSES.chromium.html',
    'resources/app/THIRD_PARTY_LICENSES.md',
    'resources/app/node_modules/markdown-it/LICENSE',
    'resources/app/node_modules/selection-hook/LICENSE',
    'resources/app/node_modules/node-gyp-build/LICENSE',
    'resources/app/node_modules/punycode.js/LICENSE-MIT.txt',
    'resources/app/node_modules/uc.micro/LICENSE.txt',
    'resources/app/src/main.cjs', 'resources/app/src/preload.cjs',
    'resources/app/src/renderer/app.js', 'resources/app/node_modules/markdown-it/dist/browser/markdown-it.umd.min.js',
    'resources/app/node_modules/selection-hook/package.json', nativePath];
  for (const relative of required) await fs.access(path.join(packageDirectory, relative));
  const packageFiles = [];
  for (const relative of await filesBelow(packageDirectory)) packageFiles.push({ path: relative, sha256: await hashFile(path.join(packageDirectory, relative)) });
  const version = require('../package.json').version;
  const candidateId = `PickGloss-${version}-candidate-${fingerprint(source).slice(0, 12)}-${stamp}`;
  const manifest = { candidateId, version, platform: 'win32', arch: 'x64', createdAt: new Date().toISOString(),
    sourceFingerprint: fingerprint(source), source, buildPackageJsonSha256: await hashFile(path.join(root, 'package.json')),
    dependencyLockSha256: await hashFile(path.join(root, 'package-lock.json')), nativeSha256: nativeHash,
    packageFingerprint: fingerprint(packageFiles), packageFileCount: packageFiles.length, packageDirectory: packageName,
    files: packageFiles };
  await fs.writeFile(path.join(output, 'candidate-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  const readme = `PickGloss 隔离便携验证包\r\n包标识：${candidateId}\r\n源码指纹：${manifest.sourceFingerprint}\r\n包内容指纹：${manifest.packageFingerprint}\r\n\r\n请保留本压缩包和旧版本完整目录。解压后，从 ${packageName} 目录运行 PickGloss.exe。普通启动会使用既有用户数据；验证时请使用独立临时目录，并只连接自己控制的本机测试服务。\r\n\r\n隔离启动示例（PowerShell）：\r\n$验证目录 = Join-Path $env:TEMP ('pickgloss-verification-' + [guid]::NewGuid().ToString('N'))\r\n& '.\\${packageName}\\PickGloss.exe' "--verification-data-dir=$验证目录"\r\n\r\n隔离模式不会启动系统划词监听、悬浮球或全局快捷键，也不会读写系统剪贴板；服务地址只允许本机。先在正式界面粘贴虚构文字，再设置本机服务并主动解释。\r\n完整文件摘要见 candidate-manifest.json；可在源码目录运行 node scripts/verify-package.cjs <解压目录> 核对。自动化、本机模拟服务和最终人工验收须分别记录。\r\n`;
  await fs.writeFile(path.join(output, 'README.txt'), readme, 'utf8');
  const archive = path.join(output, `${candidateId}.zip`);
  const zipped = spawnSync('tar', ['-a', '-c', '-f', archive, '-C', output, packageName, 'candidate-manifest.json', 'README.txt'], { encoding: 'utf8', windowsHide: true });
  if (zipped.status !== 0) throw new Error(`压缩包生成失败：${zipped.stderr || zipped.stdout}`);
  const archiveSha256 = await hashFile(archive);
  const checksum = { candidateId, archive: path.basename(archive), sha256: archiveSha256, algorithm: 'SHA-256' };
  await fs.writeFile(path.join(output, 'release-checksum.json'), JSON.stringify(checksum, null, 2), 'utf8');
  const verified = spawnSync(process.execPath, [path.join(__dirname, 'verify-package.cjs'), output, `--expected-zip-sha256=${archiveSha256}`], { encoding: 'utf8', windowsHide: true });
  if (verified.status !== 0) throw new Error(`包核对失败：${verified.stderr || verified.stdout}`);
  console.log(verified.stdout.trim());
  console.log(`便携目录：${packageDirectory}\n压缩产物：${archive}\n外部摘要：${path.join(output, 'release-checksum.json')}`);
})().catch(error => { console.error(error.message); process.exitCode = 1; });
