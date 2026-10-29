'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');

function appearanceReferences(framework) {
  const windows = process.env.WINDIR || 'C:\\Windows';
  const assemblies = path.join(windows, 'Microsoft.NET', 'assembly', 'GAC_MSIL');
  const gac = name => {
    const directory = path.join(assemblies, name);
    const versions = fs.existsSync(directory) ? fs.readdirSync(directory).sort().reverse() : [];
    const found = versions.map(version => path.join(directory, version, name + '.dll')).find(file => fs.existsSync(file));
    if (!found) throw new Error(`构建原生窗口助手缺少 .NET 程序集：${name}`);
    return found;
  };
  const metadata = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Windows Kits', '10', 'UnionMetadata');
  const versions = fs.existsSync(metadata) ? fs.readdirSync(metadata).filter(name => /^\d+(?:\.\d+){3}$/.test(name) && Number(name.split('.')[2]) >= 18362).sort((left, right) => {
    const a = left.split('.').map(Number), b = right.split('.').map(Number);
    for (let index = 0; index < 4; index++) if (a[index] !== b[index]) return b[index] - a[index];
    return 0;
  }) : [];
  const winmd = versions.map(version => path.join(metadata, version, 'Windows.winmd')).find(file => fs.existsSync(file));
  if (!winmd) throw new Error('构建原生窗口助手需要已安装的 Windows SDK 10.0.18362 或更新版本的 WinRT 元数据。');
  return ['System.Windows.Forms.dll', 'System.Numerics.dll', path.join(framework, 'System.Runtime.WindowsRuntime.dll'),
    path.join(framework, 'System.Numerics.Vectors.dll'), gac('System.Runtime'), gac('System.Runtime.InteropServices'), winmd].map(file => '/reference:' + file);
}

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

function translationSourceBuildArgs(framework, target, projectRoot = root) {
  return ['/nologo', '/target:winexe', '/platform:x64', '/optimize+',
    '/out:' + path.join(target, 'TranslationSource.exe'),
    '/reference:' + path.join(framework, 'System.Windows.Forms.dll'),
    '/reference:' + path.join(framework, 'System.Web.Extensions.dll'),
    path.join(projectRoot, 'src/windows/TranslationSource.cs')];
}

function browserContextBuildArgs(framework, target, projectRoot = root) {
  return ['/nologo', '/target:winexe', '/platform:x64', '/optimize+',
    '/out:' + path.join(target, 'BrowserContext.exe'),
    ...['UIAutomationClient.dll', 'UIAutomationTypes.dll', 'WindowsBase.dll'].map(name => '/reference:' + path.join(framework, 'WPF', name)),
    path.join(projectRoot, 'src/windows/BrowserContext.cs')];
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
  if (!benchmark) {
    const appearance = spawnSync(path.join(framework, 'csc.exe'), ['/nologo', '/target:winexe', '/platform:x64', '/optimize+',
      '/out:' + path.join(target, 'WindowAppearance.exe'), ...appearanceReferences(framework), path.join(root, 'src/windows/WindowAppearance.cs')], { encoding: 'utf8', windowsHide: true });
    if (appearance.status !== 0) throw new Error(appearance.stdout || appearance.stderr || appearance.error?.message || '窗口外观助手构建失败。');
    console.log(`窗口外观助手已构建：${path.join(target, 'WindowAppearance.exe')}`);
    const capture = spawnSync(path.join(framework, 'csc.exe'), ['/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/unsafe',
      '/out:' + path.join(target, 'ScreenCapture.exe'), path.join(root, 'src/windows/ScreenCapture.cs')], { encoding: 'utf8', windowsHide: true });
    if (capture.status !== 0) throw new Error(capture.stdout || capture.stderr || capture.error?.message || '屏幕捕获助手构建失败。');
    console.log(`屏幕捕获助手已构建：${path.join(target, 'ScreenCapture.exe')}`);
    const translationSource = spawnSync(path.join(framework, 'csc.exe'), translationSourceBuildArgs(framework, target), { encoding: 'utf8', windowsHide: true });
    if (translationSource.status !== 0) throw new Error(translationSource.stdout || translationSource.stderr || translationSource.error?.message || '截图来源窗口助手构建失败。');
    console.log(`截图来源窗口助手已构建：${path.join(target, 'TranslationSource.exe')}`);
    const browserContext = spawnSync(path.join(framework, 'csc.exe'), browserContextBuildArgs(framework, target), { encoding: 'utf8', windowsHide: true });
    if (browserContext.status !== 0) throw new Error(browserContext.stdout || browserContext.stderr || browserContext.error?.message || '浏览器页面归属助手构建失败。');
    console.log(`浏览器页面归属助手已构建：${path.join(target, 'BrowserContext.exe')}`);
  }
}

if (require.main === module) {
  try { buildNative(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { nativeBuildOptions, translationSourceBuildArgs, browserContextBuildArgs };
