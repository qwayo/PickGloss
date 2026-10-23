'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');

function nativeBuildOptions(argv, projectRoot = root) {
  let benchmark = false, outputDirectory;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--benchmark') { benchmark = true; continue; }
    if (argument === '--output-dir' || argument.startsWith('--output-dir=')) {
      if (outputDirectory !== undefined) throw new Error('输出目录参数只能指定一次。');
      const value = argument === '--output-dir' ? argv[++index] : argument.slice('--output-dir='.length);
      if (!value || value.startsWith('--')) throw new Error('--output-dir 必须指定输出目录。');
      outputDirectory = value;
      continue;
    }
    throw new Error(`未知的原生构建参数：${argument}`);
  }
  return { benchmark, target: outputDirectory === undefined
    ? path.join(projectRoot, 'build', benchmark ? 'native-benchmark' : 'native')
    : path.resolve(outputDirectory) };
}

function buildNative(argv = process.argv.slice(2)) {
  const framework = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
  const { benchmark, target } = nativeBuildOptions(argv);
  fs.mkdirSync(target, { recursive: true });
  const references = ['UIAutomationClient.dll', 'UIAutomationTypes.dll', 'WindowsBase.dll'].map(name => '/reference:' + path.join(framework, 'WPF', name));
  // 跟随实验保留在诊断目录；正式构建使用已回退的单次段落读取助手。
  const source = benchmark ? path.join(root, 'prototypes', 'windows-capture', 'desktop-follow-diagnostics', 'ContextProbe-follow.cs') : path.join(root, 'src', 'windows', 'ContextProbe.cs');
  const args = ['/nologo', '/target:exe', '/platform:x64', '/optimize+', '/out:' + path.join(target, 'ContextProbe.exe'), '/reference:' + path.join(framework, 'System.Web.Extensions.dll'), ...references, source];
  if (benchmark) args.push('/define:TRACKING_BENCHMARK');
  const result = spawnSync(path.join(framework, 'csc.exe'), args, { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stdout || result.stderr || result.error?.message || '未找到 Windows .NET Framework 编译器。');
  console.log(`UIA 段落验证助手已构建：${path.join(target, 'ContextProbe.exe')}`);
}

if (require.main === module) {
  try { buildNative(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { nativeBuildOptions };
