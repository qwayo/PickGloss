'use strict';
// 只调用正式桌面宿主判定，不切换前台、不截屏、不读取标题或输出窗口身份。
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const argument = process.argv.find(value => value.startsWith('--output-dir='));
const output = path.resolve(argument?.slice(13) || 'output/verification/desktop-source-native');
fs.mkdirSync(output, { recursive: true });
let source = fs.readFileSync(path.join(__dirname, '../src/windows/TranslationSource.cs'), 'utf8');
if (!source.includes('private static bool IsDesktopHost(')) throw new Error('正式来源模块缺少桌面宿主判定。');
source = source.replace('private static int Main(string[] args)', 'private static int UnusedMain(string[] args)');
const driver = `
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern IntPtr FindWindowEx(IntPtr parent,IntPtr previous,string name,string title);
  [STAThread] private static int Main(string[] args) {
    Console.OutputEncoding=new System.Text.UTF8Encoding(false);
    IntPtr shell=GetShellWindow();
    if(shell==IntPtr.Zero) { Write(new { passed=false, reason="没有交互桌面Shell，未执行分类" });return 1; }
    bool shellValid=IsDesktopHost(shell), related=true;int workers=0,visible=0;
    IntPtr next=IntPtr.Zero;
    for(int i=0;i<64;i++) {
      next=FindWindowEx(IntPtr.Zero,next,"WorkerW",null);if(next==IntPtr.Zero)break;
      if(!IsDesktopHost(next))continue;
      workers++;if(IsWindowVisible(next))visible++;
      source=next;related=related&&SameSource(shell);
      source=shell;related=related&&SameSource(next);
    }
    bool foreignRejected;
    using(var ordinary=new Form()) {
      source=ordinary.Handle;foreignRejected=!IsDesktopHost(source)&&!SameSource(shell);
    }
    bool passed=shellValid&&related&&foreignRejected;
    Write(new { passed=passed, shellHostValidated=shellValid, relatedDesktopHosts=workers,
      visibleRelatedDesktopHosts=visible, desktopHostsRecognizedBidirectionally=related, ordinaryWindowRemainsSeparate=foreignRejected });
    return passed?0:1;
  }
`;
const end = source.lastIndexOf('}');
source = source.slice(0, end) + driver + source.slice(end);
const sourcePath = path.join(output, '桌面宿主分类夹具.cs');
fs.writeFileSync(sourcePath, source);
const framework = path.join(process.env.WINDIR || 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319');
const executable = path.join(output, '桌面宿主分类夹具.exe');
const compiled = spawnSync(path.join(framework, 'csc.exe'), ['/nologo', '/target:exe', `/out:${executable}`,
  `/reference:${path.join(framework, 'System.Windows.Forms.dll')}`, `/reference:${path.join(framework, 'System.Web.Extensions.dll')}`, sourcePath], { windowsHide: true, encoding: 'utf8' });
if (compiled.status !== 0) { process.stderr.write(compiled.stdout || '夹具编译失败。'); process.exit(1); }
const result = spawnSync(executable, [], { windowsHide: true, encoding: 'utf8' });
let native;
try { native = JSON.parse(result.stdout.trim()); } catch { native = { passed: false }; }
const report = { 通过: result.status === 0 && native.passed, 模式: '正式分类逻辑与真实Win32桌面宿主；不切换前台、不截图；非完整覆盖交互验收', 分类结果: native };
fs.writeFileSync(path.join(output, '桌面宿主分类.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.通过 ? 0 : 1;
