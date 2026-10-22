'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const sensitivePath = /(^|\/)(?:\.env(?:\..*)?|settings\.json|sessions|data|user-data|verification-data|\.secrets|secrets)(?:\/|$)|\.(?:pem|key|pfx|p12|jks|keystore|sqlite|sqlite3|db|db-shm|db-wal)$/i;
const secretPatterns = [
  /[A-Z]:\\(?:Users|Documents and Settings)\\[^\\\r\n]+/i,
  /(?:\/Users\/|\/home\/)[^/\r\n]+/i,
  /BEGIN (?:RSA|OPENSSH|EC|DSA|PGP) PRIVATE KEY/i,
  /AKIA[0-9A-Z]{16}/,
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /sk-[A-Za-z0-9_-]{20,}/,
];

function git(args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
}

function publicationFiles() {
  const tracked = git(['ls-files', '-z']).split('\0').filter(Boolean);
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  return [...new Set([...tracked, ...untracked])].sort();
}

function scanTree(files) {
  const problems = [];
  for (const relative of files) {
    if (sensitivePath.test(relative)) problems.push(`敏感路径：${relative}`);
    const full = path.join(root, relative);
    let buffer;
    try { buffer = fs.readFileSync(full); } catch { problems.push(`无法读取：${relative}`); continue; }
    if (buffer.includes(0)) continue;
    const text = buffer.toString('utf8');
    for (const pattern of secretPatterns) {
      const match = text.match(pattern);
      if (!match) continue;
      problems.push(`疑似秘密或私密信息：${relative} (${match[0].slice(0, 80)})`);
    }
  }
  return problems;
}

function main() {
  const files = publicationFiles();
  const problems = [...scanTree(files)];
  if (!fs.existsSync(path.join(root, 'LICENSE'))) problems.push('缺少根目录 LICENSE。');
  const large = files.filter(relative => {
    const size = fs.statSync(path.join(root, relative)).size;
    return size > 5 * 1024 * 1024;
  });
  if (large.length) problems.push(`存在超过 5 MiB 的跟踪文件：${large.join('、')}`);
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exitCode = 1;
    return;
  }
  console.log(`公开前工作树检查通过：${files.length} 个待发布文件；未发现敏感路径、已知私密模式或缺失许可证。`);
}

main();
