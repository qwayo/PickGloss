'use strict';

const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/i;
const RELEASE_TAGS_JQ = '.[] | select(.draft == false and .prerelease == false) | .tag_name';

async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function readJson(file) {
  return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
}

function assertVersion(version) {
  if (!VERSION_PATTERN.test(version || '')) {
    throw new Error(`发布版本必须是正式语义化版本（不含 v 或预发布后缀）：${version || '未提供'}`);
  }
  return version;
}

function assertCommit(commit) {
  if (!COMMIT_PATTERN.test(commit || '')) throw new Error('发布提交必须是完整的 40 位 SHA。');
  return commit.toLowerCase();
}

function extractChangelog(markdown, version) {
  const lines = markdown.replace(/^\uFEFF/, '').split(/\r?\n/);
  const headings = lines.map((line, index) => ({ line, index }))
    .filter(item => /^## \[.*\]/.test(item.line));
  const matches = headings.filter(item => item.line.startsWith(`## [${version}]`));
  if (matches.length !== 1) throw new Error(`CHANGELOG.md 必须恰好包含一个 [${version}] 版本章节。`);
  const match = /^## \[[^\]]+\] - (\d{4}-\d{2}-\d{2})\s*$/.exec(matches[0].line);
  if (!match) throw new Error(`[${version}] 章节标题必须使用“## [版本] - YYYY-MM-DD”格式。`);
  const date = match[1];
  if (Number.isNaN(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
    throw new Error(`[${version}] 的发布日期无效：${date}`);
  }
  const end = headings.find(item => item.index > matches[0].index)?.index ?? lines.length;
  const body = lines.slice(matches[0].index + 1, end).join('\n').trim();
  if (!body) throw new Error(`[${version}] 的发布说明不能为空。`);
  return { date, body };
}

function composeReleaseNotes(body) {
  return `${body}\n\n---\n\n下载下方的 **Windows x64 ZIP**，解压后从 \`PickGloss-win32-x64\` 文件夹运行 \`PickGloss.exe\`。请保留完整目录，不能只复制 EXE；更新前可保留旧版本目录。\n\n当前发行版尚未进行正式代码签名，Windows 可能显示“未知发布者”或 SmartScreen 提示。请核对下载来源，并使用 \`SHA256SUMS.txt\` 或 \`release-checksum.json\` 核对压缩包。\n\n自动化检查、隔离便携包及本机模拟服务验证不能替代目标 Windows 环境的人工验收，也不保证所有 OCR、第三方模型服务或多显示器环境均已验证。\n`;
}

async function releaseContext(root, version) {
  assertVersion(version);
  const packageJson = await readJson(path.join(root, 'package.json'));
  const lock = await readJson(path.join(root, 'package-lock.json'));
  if (packageJson.version !== version) throw new Error(`package.json 版本 ${packageJson.version} 与发布版本 ${version} 不一致。`);
  if (lock.version !== version || lock.packages?.['']?.version !== version) {
    throw new Error(`package-lock.json 的根版本必须与发布版本 ${version} 一致。`);
  }
  const changelog = await fs.readFile(path.join(root, 'CHANGELOG.md'), 'utf8');
  const entry = extractChangelog(changelog, version);
  return { version, tag: `v${version}`, ...entry, notes: composeReleaseNotes(entry.body) };
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  return result;
}

function runTagLines(command, args, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let pending = '';
    let stderr = '';
    const consume = value => {
      const line = value.replace(/^\uFEFF/, '').trim();
      if (line) onLine(line);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || '';
      for (const line of lines) consume(line);
    });
    child.stderr.on('data', chunk => {
      if (stderr.length < 64 * 1024) stderr += chunk.slice(0, 64 * 1024 - stderr.length);
    });
    child.once('error', reject);
    child.once('close', status => {
      if (pending) consume(pending);
      resolve({ status, stderr });
    });
  });
}

function compareVersions(left, right) {
  const a = assertVersion(left).split('.');
  const b = assertVersion(right).split('.');
  for (let index = 0; index < 3; index += 1) {
    if (a[index].length !== b[index].length) return a[index].length > b[index].length ? 1 : -1;
    if (a[index] > b[index]) return 1;
    if (a[index] < b[index]) return -1;
  }
  return 0;
}

async function assertUnpublished(version, repository, execute) {
  const tag = `v${assertVersion(version)}`;
  if (!/^[^/]+\/[^/]+$/.test(repository || '')) throw new Error('GitHub 仓库必须使用 owner/name 格式。');
  for (const [label, endpoint] of [
    ['标签', `repos/${repository}/git/ref/tags/${tag}`],
    ['Release', `repos/${repository}/releases/tags/${tag}`],
  ]) {
    const result = execute ? await execute('gh', ['api', endpoint]) : run('gh', ['api', endpoint]);
    if (result.status === 0) throw new Error(`${label} ${tag} 已存在，禁止覆盖发布。`);
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    if (!/404|Not Found/i.test(output)) throw new Error(`无法确认${label}是否已存在：${output.trim()}`);
  }
  const listArgs = ['api', '--paginate', '--jq', RELEASE_TAGS_JQ,
    `repos/${repository}/releases?per_page=100`];
  let latest;
  const remember = tagName => {
    const match = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(tagName);
    if (!match) return;
    if (!latest || compareVersions(match[1], latest) > 0) latest = match[1];
  };
  if (execute) {
    const result = await execute('gh', listArgs);
    if (result.status !== 0) throw new Error(`无法读取现有正式版本：${result.stderr || result.stdout}`);
    for (const line of (result.stdout || '').replace(/^\uFEFF/, '').split(/\r?\n/)) remember(line.trim());
  } else {
    const result = await runTagLines('gh', listArgs, remember);
    if (result.status !== 0) throw new Error(`无法读取现有正式版本：${result.stderr}`);
  }
  if (latest && compareVersions(version, latest) <= 0) {
    throw new Error(`发布版本 ${version} 必须高于当前最新正式版本 ${latest}。`);
  }
  console.log(`发布前置检查通过：${tag} 的标签和 Release 均不存在，版本顺序有效。`);
}

function verifyTag(version, commit, repository) {
  const tag = `v${assertVersion(version)}`;
  assertCommit(commit);
  if (!/^[^/]+\/[^/]+$/.test(repository || '')) throw new Error('GitHub 仓库必须使用 owner/name 格式。');
  const result = run('gh', ['api', `repos/${repository}/git/ref/tags/${tag}`]);
  if (result.status !== 0) throw new Error(`无法读取已发布标签：${result.stderr || result.stdout}`);
  const reference = JSON.parse(result.stdout);
  if (reference.object?.type !== 'commit' || reference.object?.sha?.toLowerCase() !== commit.toLowerCase()) {
    throw new Error(`标签 ${tag} 未指向选定提交 ${commit}。`);
  }
  console.log(`标签核验通过：${tag} 指向 ${commit}。`);
}

function tagCommit(execute, repository, tag) {
  const result = execute('gh', ['api', `repos/${repository}/git/ref/tags/${tag}`]);
  if (result.status !== 0) return null;
  const reference = JSON.parse(result.stdout.replace(/^\uFEFF/, ''));
  return reference.object?.type === 'commit' ? reference.object.sha.toLowerCase() : null;
}

function removeUnpublishedTag(execute, repository, tag, commit, failure) {
  const current = tagCommit(execute, repository, tag);
  if (current !== commit.toLowerCase()) throw new Error(`${failure}；标签状态已变化，不自动清理：${tag}`);
  const removed = execute('gh', ['api', '--method', 'DELETE', `repos/${repository}/git/ref/tags/${tag}`]);
  if (removed.status !== 0) throw new Error(`${failure}；本次标签也未能清理，请人工处理：${removed.stderr || removed.stdout}`);
  throw new Error(`${failure}；已清理本次创建且仍未公开的标签：${tag}`);
}

async function createRelease(root, options, execute = run) {
  const { directory, version, commit, repository } = options;
  const { release } = await verifyStaged(root, directory, version, commit);
  if (!/^[^/]+\/[^/]+$/.test(repository || '')) throw new Error('GitHub 仓库必须使用 owner/name 格式。');
  const reference = `repos/${repository}/git/refs`;
  const created = execute('gh', ['api', '--method', 'POST', reference,
    '-f', `ref=refs/tags/${release.tag}`, '-f', `sha=${commit}`]);
  if (created.status !== 0) {
    throw new Error(`原子创建标签失败，尚未创建 Release：${created.stderr || created.stdout}`);
  }
  if (tagCommit(execute, repository, release.tag) !== commit.toLowerCase()) {
    removeUnpublishedTag(execute, repository, release.tag, commit, '标签创建后的即时回读目标不一致');
  }
  const assetPaths = [release.archive, 'release-checksum.json', 'SHA256SUMS.txt'].map(name => path.join(directory, name));
  const published = execute('gh', ['release', 'create', release.tag, ...assetPaths, '--verify-tag',
    '--repo', repository, '--title', `PickGloss ${version}`,
    '--notes-file', path.join(directory, 'release-notes.md'), '--latest']);
  if (published.status === 0) {
    console.log((published.stdout || `${release.tag} 发布成功。`).trim());
    return;
  }
  const output = published.stderr || published.stdout;
  const existing = execute('gh', ['api', `repos/${repository}/releases/tags/${release.tag}`]);
  if (existing.status === 0) throw new Error(`发布命令失败，但 Release 已存在；保留公开内容并人工核验：${output}`);
  if (!/404|Not Found/i.test(`${existing.stdout || ''}\n${existing.stderr || ''}`)) {
    throw new Error(`发布命令失败，且无法确认 Release 状态；保留标签并人工核验：${output}`);
  }
  removeUnpublishedTag(execute, repository, release.tag, commit, `Release 创建失败：${output}`);
}

async function findCandidate(dist, version) {
  const candidates = [];
  for (const entry of await fs.readdir(dist, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(dist, entry.name);
    const manifestPath = path.join(directory, 'candidate-manifest.json');
    try {
      const manifest = await readJson(manifestPath);
      if (manifest.version === version) candidates.push({ directory, manifest });
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`无法读取候选清单 ${manifestPath}：${error.message}`);
    }
  }
  if (candidates.length !== 1) throw new Error(`dist 中必须恰好有一个版本 ${version} 的候选包，实际为 ${candidates.length} 个。`);
  return candidates[0];
}

async function stageCandidate(root, options) {
  const { version, commit, dist, output } = options;
  const context = await releaseContext(root, version);
  assertCommit(commit);
  const { directory, manifest } = await findCandidate(path.resolve(root, dist), version);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(manifest.candidateId || '')) throw new Error('候选标识包含不安全字符。');
  if (manifest.packageDirectory !== 'PickGloss-win32-x64') throw new Error('候选包目录必须为 PickGloss-win32-x64。');
  if (manifest.buildPackageJsonSha256 !== await hashFile(path.join(root, 'package.json')) ||
      manifest.dependencyLockSha256 !== await hashFile(path.join(root, 'package-lock.json'))) {
    throw new Error('候选包并非由选定提交的 package.json 和锁文件构建。');
  }
  const archive = `${manifest.candidateId}.zip`;
  const checksum = await readJson(path.join(directory, 'release-checksum.json'));
  const archiveSha256 = await hashFile(path.join(directory, archive));
  if (checksum.candidateId !== manifest.candidateId || checksum.archive !== archive ||
      checksum.algorithm !== 'SHA-256' || checksum.sha256 !== archiveSha256) {
    throw new Error('候选 ZIP 与 release-checksum.json 不一致。');
  }
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.mkdir(output);
  for (const name of [archive, 'release-checksum.json', 'candidate-manifest.json', 'README.txt']) {
    await fs.copyFile(path.join(directory, name), path.join(output, name));
  }
  await fs.writeFile(path.join(output, 'SHA256SUMS.txt'), `${archiveSha256}  ${archive}\n`, 'utf8');
  await fs.writeFile(path.join(output, 'release-notes.md'), context.notes, 'utf8');
  const release = { version, tag: context.tag, commit: commit.toLowerCase(), archive, archiveSha256 };
  await fs.writeFile(path.join(output, 'release.json'), JSON.stringify(release, null, 2), 'utf8');
  console.log(`候选发布资产已冻结：${archive}；ZIP SHA-256 ${archiveSha256}`);
  return release;
}

function parseSha256Sums(text, archive) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1) throw new Error('SHA256SUMS.txt 必须且只能包含一个 ZIP 摘要。');
  const match = /^([a-f0-9]{64}) [ *](.+)$/.exec(lines[0]);
  if (!match || match[2] !== archive) throw new Error('SHA256SUMS.txt 的格式或 ZIP 文件名不匹配。');
  return match[1];
}

async function verifyStaged(root, directory, version, commit) {
  const context = await releaseContext(root, version);
  const release = await readJson(path.join(directory, 'release.json'));
  if (release.version !== version || release.tag !== context.tag || release.commit !== assertCommit(commit)) {
    throw new Error('冻结发布信息与选定版本或提交不一致。');
  }
  const manifest = await readJson(path.join(directory, 'candidate-manifest.json'));
  const checksum = await readJson(path.join(directory, 'release-checksum.json'));
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(manifest.candidateId || '') ||
      manifest.version !== version || manifest.packageDirectory !== 'PickGloss-win32-x64' ||
      release.archive !== `${manifest.candidateId}.zip` ||
      checksum.archive !== release.archive || checksum.candidateId !== manifest.candidateId) {
    throw new Error('冻结清单、外部摘要与 ZIP 文件名不一致。');
  }
  if (manifest.buildPackageJsonSha256 !== await hashFile(path.join(root, 'package.json')) ||
      manifest.dependencyLockSha256 !== await hashFile(path.join(root, 'package-lock.json'))) {
    throw new Error('候选包与选定提交的 package.json 或锁文件不一致。');
  }
  const actual = await hashFile(path.join(directory, release.archive));
  if (actual !== release.archiveSha256 || checksum.sha256 !== actual || checksum.algorithm !== 'SHA-256') {
    throw new Error('冻结 ZIP 的实际摘要与发布信息不一致。');
  }
  const sums = await fs.readFile(path.join(directory, 'SHA256SUMS.txt'), 'utf8');
  if (parseSha256Sums(sums, release.archive) !== actual) throw new Error('SHA256SUMS.txt 与冻结 ZIP 不一致。');
  if (await fs.readFile(path.join(directory, 'release-notes.md'), 'utf8') !== context.notes) {
    throw new Error('冻结发布说明与 CHANGELOG.md 不一致。');
  }
  return { context, release, manifest, checksum };
}

async function verifyPublished(root, options) {
  const { directory, published, metadata, version, commit } = options;
  const staged = await verifyStaged(root, directory, version, commit);
  const release = await readJson(metadata);
  if (release.tagName !== staged.context.tag || release.name !== `PickGloss ${version}` ||
      release.isDraft !== false || release.isPrerelease !== false) {
    throw new Error('公开 Release 的标签、标题或正式版状态不匹配。');
  }
  const publicNames = [staged.release.archive, 'release-checksum.json', 'SHA256SUMS.txt'].sort();
  const actualNames = (release.assets || []).map(asset => asset.name).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(publicNames)) {
    throw new Error(`公开资产集合不匹配：${actualNames.join('、') || '无'}`);
  }
  for (const name of publicNames) {
    const expected = await hashFile(path.join(directory, name));
    const actual = await hashFile(path.join(published, name));
    if (actual !== expected) throw new Error(`重新下载的公开资产与候选文件不同：${name}`);
  }
  console.log(`公开资产核验通过：${staged.context.tag} 的 ${publicNames.length} 个文件均与候选包一致。`);
}

function parseArgs(values) {
  const result = {};
  for (const value of values) {
    const match = /^--([a-z-]+)=(.*)$/.exec(value);
    if (!match) throw new Error(`无法识别参数：${value}`);
    if (Object.hasOwn(result, match[1])) throw new Error(`参数重复：--${match[1]}`);
    result[match[1]] = match[2];
  }
  return result;
}

function onlyArgs(args, allowed) {
  const unknown = Object.keys(args).filter(key => !allowed.includes(key));
  if (unknown.length) throw new Error(`未知参数：${unknown.map(key => `--${key}`).join('、')}`);
}

async function main(argv = process.argv.slice(2), environment = process.env, dependencies = {}) {
  const [command, ...values] = argv;
  const args = parseArgs(values);
  const root = dependencies.root || path.resolve(__dirname, '..');
  const createReleaseImpl = dependencies.createReleaseImpl || createRelease;
  const repository = args.repository || environment.GITHUB_REPOSITORY;
  if (command === 'validate') {
    onlyArgs(args, ['version']);
    const context = await releaseContext(root, args.version);
    console.log(`发布元数据有效：${context.tag}，发布日期 ${context.date}。`);
  } else if (command === 'stage') {
    onlyArgs(args, ['version', 'commit', 'dist', 'output']);
    await stageCandidate(root, { ...args, dist: args.dist || 'dist' });
  } else if (command === 'verify-staged') {
    onlyArgs(args, ['version', 'commit', 'directory']);
    await verifyStaged(root, path.resolve(args.directory), args.version, args.commit);
    console.log('冻结发布资产复核通过。');
  } else if (command === 'assert-unpublished') {
    onlyArgs(args, ['version', 'repository']);
    await assertUnpublished(args.version, repository);
  } else if (command === 'verify-tag') {
    onlyArgs(args, ['version', 'commit', 'repository']);
    verifyTag(args.version, args.commit, repository);
  } else if (command === 'create-release') {
    onlyArgs(args, ['version', 'commit', 'directory', 'repository']);
    await createReleaseImpl(root, { ...args, directory: path.resolve(args.directory), repository });
  } else if (command === 'verify-published') {
    onlyArgs(args, ['version', 'commit', 'directory', 'published', 'metadata']);
    await verifyPublished(root, {
      ...args,
      directory: path.resolve(args.directory),
      published: path.resolve(args.published),
      metadata: path.resolve(args.metadata),
    });
  } else {
    throw new Error('用法：release.cjs <validate|stage|verify-staged|assert-unpublished|create-release|verify-tag|verify-published> --参数=值');
  }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });

module.exports = {
  main,
  assertVersion,
  extractChangelog,
  composeReleaseNotes,
  compareVersions,
  assertUnpublished,
  releaseContext,
  stageCandidate,
  parseSha256Sums,
  verifyStaged,
  createRelease,
  verifyPublished,
};
