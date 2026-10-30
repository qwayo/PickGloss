'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const {
  extractChangelog,
  compareVersions,
  assertUnpublished,
  releaseContext,
  stageCandidate,
  parseSha256Sums,
  verifyStaged,
  createRelease,
  verifyPublished,
} = require('../../scripts/release.cjs');

const version = '1.2.3';
const commit = 'a'.repeat(40);

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pickgloss-release-'));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ version }), 'utf8');
  await fs.writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ version, packages: { '': { version } } }), 'utf8');
  await fs.writeFile(path.join(root, 'CHANGELOG.md'), '# 更新日志\n\n## [1.2.3] - 2026-10-30\n\n### 修复\n\n- 修复固定示例。\n', 'utf8');
  return root;
}

function hash(value) { return createHash('sha256').update(value).digest('hex'); }

async function addCandidate(root, name = '候选') {
  const directory = path.join(root, 'dist', name);
  await fs.mkdir(directory, { recursive: true });
  const candidateId = 'PickGloss-1.2.3-candidate-fixed';
  const archive = `${candidateId}.zip`;
  const content = '受控 ZIP 内容\n';
  const archiveSha256 = hash(content);
  const manifest = {
    candidateId, version, packageDirectory: 'PickGloss-win32-x64',
    buildPackageJsonSha256: hash(await fs.readFile(path.join(root, 'package.json'))),
    dependencyLockSha256: hash(await fs.readFile(path.join(root, 'package-lock.json'))),
  };
  await fs.writeFile(path.join(directory, archive), content, 'utf8');
  await fs.writeFile(path.join(directory, 'candidate-manifest.json'), JSON.stringify(manifest), 'utf8');
  await fs.writeFile(path.join(directory, 'release-checksum.json'), JSON.stringify({
    candidateId, archive, sha256: archiveSha256, algorithm: 'SHA-256',
  }), 'utf8');
  await fs.writeFile(path.join(directory, 'README.txt'), '隔离候选包\n', 'utf8');
  return { directory, archive, archiveSha256 };
}

test('发布元数据要求正式版本、锁文件一致及唯一非空更新日志', async () => {
  const root = await fixture();
  const context = await releaseContext(root, version);
  assert.equal(context.tag, 'v1.2.3');
  assert.match(context.notes, /修复固定示例/);
  assert.match(context.notes, /尚未进行正式代码签名/);
  await assert.rejects(releaseContext(root, '1.2.3-rc.1'), /正式语义化版本/);
  await assert.rejects(releaseContext(root, '1.2.4'), /不一致/);
  const lock = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'));
  lock.packages[''].version = '1.2.2';
  await fs.writeFile(path.join(root, 'package-lock.json'), JSON.stringify(lock), 'utf8');
  await assert.rejects(releaseContext(root, version), /锁文件|package-lock/);
});

test('更新日志章节按版本边界提取并校验真实日期', () => {
  const changelog = '# 更新日志\n\n## [1.2.3] - 2026-10-30\n\n第一版内容。\n\n## [1.2.4] - 2026-10-31\n\n后一版内容。\n';
  assert.equal(extractChangelog(changelog, version).body, '第一版内容。');
  assert.throws(() => extractChangelog('## [1.2.3] - 2026-02-30\n\n内容。', version), /日期无效/);
  assert.throws(() => extractChangelog('## [1.2.3]\n\n内容。', version), /章节标题/);
});

test('发布版本顺序只允许高于当前正式版', () => {
  assert.equal(compareVersions('1.2.4', '1.2.3'), 1);
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('2.0.0', '10.0.0'), -1);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
});

test('候选资产冻结后保留同一 ZIP、标准摘要和固定发布说明', async () => {
  const root = await fixture();
  const candidate = await addCandidate(root);
  const output = path.join(root, 'output', 'release');
  const staged = await stageCandidate(root, { version, commit, dist: 'dist', output });
  assert.deepEqual(staged, { version, tag: 'v1.2.3', commit, archive: candidate.archive, archiveSha256: candidate.archiveSha256 });
  const sums = await fs.readFile(path.join(output, 'SHA256SUMS.txt'), 'utf8');
  assert.equal(parseSha256Sums(sums, candidate.archive), candidate.archiveSha256);
  await verifyStaged(root, output, version, commit);
  assert.equal(await fs.readFile(path.join(output, candidate.archive), 'utf8'), '受控 ZIP 内容\n');
  await assert.rejects(stageCandidate(root, { version, commit, dist: 'dist', output }), /EEXIST|已存在/);
});

test('候选数量不唯一或 ZIP 摘要不匹配时拒绝冻结', async () => {
  const root = await fixture();
  const candidate = await addCandidate(root);
  await fs.writeFile(path.join(candidate.directory, candidate.archive), '被替换的内容\n', 'utf8');
  await assert.rejects(stageCandidate(root, {
    version, commit, dist: 'dist', output: path.join(root, 'output', 'tampered'),
  }), /不一致/);
  await fs.rm(candidate.directory, { recursive: true });
  await addCandidate(root, '候选甲');
  await addCandidate(root, '候选乙');
  await assert.rejects(stageCandidate(root, {
    version, commit, dist: 'dist', output: path.join(root, 'output', 'multiple'),
  }), /实际为 2 个/);
});

test('公开资产必须逐字节匹配候选且 Release 元数据准确', async () => {
  const root = await fixture();
  await addCandidate(root);
  const directory = path.join(root, 'output', 'release');
  const published = path.join(root, 'output', 'published');
  const staged = await stageCandidate(root, { version, commit, dist: 'dist', output: directory });
  await fs.mkdir(published, { recursive: true });
  for (const name of [staged.archive, 'release-checksum.json', 'SHA256SUMS.txt']) {
    await fs.copyFile(path.join(directory, name), path.join(published, name));
  }
  const metadata = path.join(root, 'output', 'metadata.json');
  const release = {
    tagName: 'v1.2.3', name: 'PickGloss 1.2.3', isDraft: false, isPrerelease: false,
    assets: [staged.archive, 'release-checksum.json', 'SHA256SUMS.txt'].map(name => ({ name })),
  };
  await fs.writeFile(metadata, JSON.stringify(release), 'utf8');
  await verifyPublished(root, { directory, published, metadata, version, commit });
  await fs.appendFile(path.join(published, staged.archive), '公开文件已变化');
  await assert.rejects(verifyPublished(root, { directory, published, metadata, version, commit }), /公开资产与候选文件不同/);
});

test('发布工作流保留人工门禁、最小权限、并发限制和固定 Actions', async () => {
  const workflow = await fs.readFile(path.join(__dirname, '../../.github/workflows/release.yml'), 'utf8');
  const actions = [...workflow.matchAll(/uses:\s*([^\s#]+)/g)].map(match => match[1]);
  assert.ok(actions.length >= 4);
  for (const action of actions) assert.match(action, /@[a-f0-9]{40}$/);
  const [candidateJob, publishJob] = workflow.split(/\n {2}publish:/);
  assert.match(workflow, /environment:\s*release/);
  assert.match(workflow, /retention-days:\s*14/);
  assert.match(workflow, /group:\s*release/);
  assert.match(workflow, /cancel-in-progress:\s*false/);
  assert.match(workflow, /^permissions:\r?\n {2}contents: read\r?$/m);
  assert.equal((workflow.match(/contents:\s*write/g) || []).length, 1);
  assert.ok(!candidateJob.includes('contents: write'));
  assert.match(publishJob, /permissions:\s*\r?\n\s+contents:\s*write/);
  assert.match(candidateJob, /拒绝已有标签或 Release[\s\S]*?GH_TOKEN/);
  assert.match(candidateJob, /npm run check:changes -- --ui-all/);
  assert.match(publishJob, /复核当前 main 仍包含候选提交[\s\S]*?git fetch --no-tags origin main[\s\S]*?git merge-base --is-ancestor \$env:RELEASE_COMMIT FETCH_HEAD[\s\S]*?创建标签与正式 Release/);
  assert.ok(publishJob.includes('environment: release') && publishJob.includes('create-release'));
  assert.match(workflow, /actions\/download-artifact@/);
  assert.match(workflow, /verify-published/);
});

test('版本门禁分页读取正式版并忽略草稿与预发布', async () => {
  const pages = [[
    { tag_name: 'v1.2.3', draft: false, prerelease: false },
    { tag_name: 'v9.0.0', draft: true, prerelease: false },
  ], [
    { tag_name: 'v1.2.4', draft: false, prerelease: false },
    { tag_name: 'v10.0.0', draft: true, prerelease: false },
    { tag_name: 'v8.0.0', draft: false, prerelease: true },
  ]];
  assert.ok(pages.length >= 2);
  assert.equal(pages[1].filter(release => !release.draft && !release.prerelease)[0].tag_name, 'v1.2.4');
  const calls = [];
  function fake(_command, args) {
    calls.push(args);
    const endpoint = args.at(-1);
    if (endpoint.includes('/releases?per_page=100')) {
      assert.ok(args.includes('--paginate'));
      assert.ok(!args.includes('--slurp'));
      const jqIndex = args.indexOf('--jq');
      assert.ok(jqIndex >= 0);
      assert.match(args[jqIndex + 1], /\.draft == false/);
      assert.match(args[jqIndex + 1], /\.prerelease == false/);
      const stdout = pages.map(page => page
        .filter(release => !release.draft && !release.prerelease)
        .map(release => release.tag_name).join('\n')).join('\n');
      return { status: 0, stdout, stderr: '' };
    }
    if (/\/releases\/tags\/v(?:1\.2\.[45]|1\.0\.0)$/.test(endpoint) ||
        /\/git\/ref\/tags\/v(?:1\.2\.[45]|1\.0\.0)$/.test(endpoint)) {
      return { status: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' };
    }
    if (endpoint.includes('/releases/tags/v1.2.3') || endpoint.includes('/git/ref/tags/v1.2.3')) {
      return { status: 0, stdout: '{"tag_name":"v1.2.3"}', stderr: '' };
    }
    throw new Error(`意外端点：${endpoint}`);
  }
  await assertUnpublished('1.2.5', 'owner/repo', fake);
  await assert.rejects(assertUnpublished('1.2.4', 'owner/repo', fake), /必须高于当前最新正式版本 1\.2\.4/);
  await assert.rejects(assertUnpublished('1.2.3', 'owner/repo', fake), /已存在/);
  await assert.rejects(assertUnpublished('1.0.0', 'owner/repo', fake), /必须高于当前最新正式版本 1\.2\.4/);
  const listCall = calls.find(args => args.at(-1).includes('/releases?per_page=100'));
  assert.ok(listCall.includes('--paginate') && listCall.includes('--jq'));
});

test('标签与 Release 使用原子创建，失败后只清理本次未公开标签', async () => {
  const root = await fixture();
  await addCandidate(root);
  const directory = path.join(root, 'output', 'release');
  await stageCandidate(root, { version, commit, dist: 'dist', output: directory });
  const options = { directory, version, commit, repository: 'owner/repo' };
  const successfulCalls = [];
  await createRelease(root, options, (command, args) => {
    successfulCalls.push(args);
    if (args.includes('--method')) return { status: 0, stdout: '{}', stderr: '' };
    if (args[1]?.includes('/git/ref/tags/')) return { status: 0, stdout: JSON.stringify({ object: { type: 'commit', sha: commit } }), stderr: '' };
    return { status: 0, stdout: 'https://github.com/owner/repo/releases/tag/v1.2.3', stderr: '' };
  });
  assert.ok(successfulCalls.some(args => args[0] === 'api' && args.includes('POST')));
  const publishCall = successfulCalls.find(args => args[0] === 'release');
  assert.ok(publishCall.includes('--verify-tag') && !publishCall.includes('--target'));
  assert.ok(publishCall.filter(value => String(value).endsWith('.zip') || String(value).endsWith('.md') || String(value).endsWith('.json')).every(path.isAbsolute));

  await assert.rejects(createRelease(root, options, (command, args) => {
    if (args.includes('POST')) return { status: 0, stdout: '{}', stderr: '' };
    if (args[1]?.includes('/git/ref/tags/')) return { status: 0, stdout: JSON.stringify({ object: { type: 'commit', sha: 'b'.repeat(40) } }), stderr: '' };
    if (args.includes('DELETE')) return { status: 0, stdout: '', stderr: '' };
    throw new Error(`意外命令：${args.join(' ')}`);
  }), /即时回读.*不自动清理/);

  const cleanupCalls = [];
  await assert.rejects(createRelease(root, options, (command, args) => {
    cleanupCalls.push(args);
    if (args[0] === 'api' && args.includes('POST')) return { status: 0, stdout: '{}', stderr: '' };
    if (args[1]?.includes('/git/ref/tags/')) return { status: 0, stdout: JSON.stringify({ object: { type: 'commit', sha: commit } }), stderr: '' };
    if (args[0] === 'release') return { status: 1, stdout: '', stderr: '上传失败' };
    if (args[1]?.includes('/releases/tags/')) return { status: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' };
    if (args.includes('DELETE')) return { status: 0, stdout: '', stderr: '' };
    throw new Error(`意外命令：${args.join(' ')}`);
  }), /已清理/);
  assert.ok(cleanupCalls.some(args => args.includes('DELETE')));

  const preservedCalls = [];
  await assert.rejects(createRelease(root, options, (command, args) => {
    preservedCalls.push(args);
    if (args[0] === 'api' && args.includes('POST')) return { status: 0, stdout: '{}', stderr: '' };
    if (args[1]?.includes('/git/ref/tags/')) return { status: 0, stdout: JSON.stringify({ object: { type: 'commit', sha: commit } }), stderr: '' };
    if (args[0] === 'release') return { status: 1, stdout: '', stderr: '命令超时' };
    if (args[1]?.includes('/releases/tags/')) return { status: 0, stdout: '{"tag_name":"v1.2.3"}', stderr: '' };
    throw new Error(`意外命令：${args.join(' ')}`);
  }), /Release 已存在/);
  assert.ok(!preservedCalls.some(args => args.includes('DELETE')));
});
