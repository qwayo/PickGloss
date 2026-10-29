'use strict';
// 编译正式 Refresh，只替换 Win32 边界为固定快照。此反馈是时序模拟，不是原生动画复现。
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const targetArg = process.argv.find(value => value.startsWith('--output-dir='));
const output = path.resolve(targetArg?.slice(13) || 'output/verification/translation-source-transient');
fs.mkdirSync(output, { recursive: true });
const sourcePath = path.join(__dirname, '../src/windows/TranslationSource.cs');
let source = fs.readFileSync(sourcePath, 'utf8');
const bodies = {
  EnumWindows: 'return true;', GetWindowLongPtr: 'return IntPtr.Zero;', GetForegroundWindow: 'return fakeForeground==IntPtr.Zero?source:fakeForeground;',
  SetForegroundWindow: 'return true;', SendMessageTimeout: 'result=UIntPtr.Zero;return IntPtr.Zero;', GetAncestor: 'return window;',
  GetWindowThreadProcessId: 'pid=window==source||window==new IntPtr(4)||window==new IntPtr(5)?sourcePid:window==new IntPtr(6)?33:ownerPid;return 1;', IsWindow: 'return window!=IntPtr.Zero;',
  IsWindowVisible: 'return true;', IsIconic: 'return window==source&&fakeIconic;',
  GetWindowRect: 'rect=window==source?fakeRect:initial;return true;', SetProcessDpiAwarenessContext: 'return true;',
  SetWinEventHook: 'return new IntPtr(1);', UnhookWinEvent: 'return true;', GetTopWindow: 'return overlay;', GetWindow: 'return IntPtr.Zero;',
  SetWindowPos: 'return true;', DwmGetWindowAttribute: 'value=0;return 0;',
  GetWindowPlacement: 'placement.Length=Marshal.SizeOf(typeof(WindowPlacement));placement.ShowCommand=fakeShowCommand;placement.NormalPosition=initial;return true;',
  GetShellWindow: 'return new IntPtr(4);',
  GetClassName: 'string value=window==source?(fakeDesktopSource?"WorkerW":"普通应用"):window==new IntPtr(4)?"Progman":window==new IntPtr(5)?"CabinetWClass":"WorkerW";name.Append(value);return value.Length;',
};
const substituted = [];
source = source.replace(/\[DllImport\([^\n]+\)\]\s+private static extern ([^\n;]+)\s+(\w+)\(([^\n]*)\);/g, (line, type, name, args) => {
  if (!bodies[name]) throw new Error(`未定义替身的原生边界：${name}`);
  substituted.push(name); return `private static ${type} ${name}(${args}) { ${bodies[name]} }`;
});
if (!substituted.includes('IsIconic') || !substituted.includes('GetWindowRect')) throw new Error('正式来源检查边界未被正确替换。');
source = source.replace('private static int Main(string[] args)', 'private static int UnusedMain(string[] args)');
if (source.includes('private static long NowMilliseconds()')) {
  source = source.replace(/private static long NowMilliseconds\(\) \{[^\n]+\}/, 'private static long NowMilliseconds() { return fakeNow; }');
  substituted.push('单调时钟');
}
const driver = `
  private static Rect fakeRect;
  private static bool fakeIconic;
  private static uint fakeShowCommand=1;
  private static long fakeNow=1000;
  private static bool fakeDesktopSource;
  private static IntPtr fakeForeground;
  private static readonly List<string> observed=new List<string>();
  private static Rect TestRect(int x,int y,int w,int h) { return new Rect{Left=x,Top=y,Right=x+w,Bottom=y+h}; }
  private static void ResetTest() {
    ownerPid=11;sourcePid=22;source=new IntPtr(1);overlay=new IntPtr(2);controls=new IntPtr(3);binding=1;
    initial=TestRect(100,100,980,660);fakeRect=initial;fakeIconic=false;fakeShowCommand=1;invalid=false;
    lastState=null;stopped=false;refreshing=false;fakeNow=1000;fakeDesktopSource=false;fakeForeground=IntPtr.Zero;${source.includes('minimizeSeen') ? 'minimizeSeen=false;restorePending=false;' : ''}observed.Clear();Refresh();
  }
  private static void Tick(Rect rect,bool iconic,uint showCommand,int elapsed=50) { fakeNow+=elapsed;fakeRect=rect;fakeIconic=iconic;fakeShowCommand=showCommand;Refresh(); }
  private static bool Case(string name,bool pass) { Write(new {type="case",name=name,pass=pass,states=observed.ToArray(),invalid=invalid});return pass; }
  private static int Main(string[] args) {
    Console.OutputEncoding=new System.Text.UTF8Encoding(false);
    bool passed=true;
    ResetTest(); Tick(TestRect(-32000,-32000,160,28),false,2); Tick(TestRect(-32000,-32000,160,28),true,2); Tick(initial,false,1);
    passed=Case("最小化意图先到、IsIconic稍后到、还原到原矩形",!invalid&&lastState=="active"&&!observed.Contains("moved"))&&passed;
    ResetTest();Tick(TestRect(140,100,980,660),false,1);
    passed=Case("真正移动必须立即停止旧覆盖",invalid&&lastState=="moved")&&passed;
    ResetTest();Tick(TestRect(100,100,1020,660),false,1);
    passed=Case("真正缩放必须立即停止旧覆盖",invalid&&lastState=="moved")&&passed;
    ResetTest();Tick(TestRect(140,100,980,660),false,1);Tick(TestRect(-32000,-32000,160,28),true,2);Tick(TestRect(140,100,980,660),false,1);
    passed=Case("真正移动后再最小化不能恢复旧覆盖",invalid)&&passed;
    ResetTest();Tick(TestRect(-32000,-32000,160,28),true,2);Tick(TestRect(180,140,800,500),false,1);
    bool restoreHidden=!invalid&&lastState=="inactive";Tick(initial,false,1);
    passed=Case("还原意图已正常但矩形仍暂态时先隐藏，回原矩形恢复",restoreHidden&&!invalid&&lastState=="active"&&!observed.Contains("moved"))&&passed;
    ResetTest();Tick(TestRect(-32000,-32000,160,28),true,2);Tick(TestRect(140,100,980,660),false,1);
    bool relocationHidden=!invalid&&lastState=="inactive";Tick(TestRect(140,100,980,660),false,1,249);
    bool notEarly=!invalid;Tick(TestRect(140,100,980,660),false,1,1);
    passed=Case("最小化中实际改位置，稳定250毫秒后必须移动失效",relocationHidden&&notEarly&&invalid&&lastState=="moved")&&passed;
    ResetTest();Tick(TestRect(-32000,-32000,160,28),true,2);Tick(TestRect(140,100,980,660),false,1);
    for(int i=0;i<10;i++) Tick(TestRect(140+i,100,980,660),false,1,100);
    passed=Case("还原矩形持续抖动，最长1000毫秒后必须停止等待",invalid&&lastState=="moved")&&passed;
    ResetTest();fakeDesktopSource=true;fakeForeground=new IntPtr(6);Refresh();fakeForeground=new IntPtr(4);Refresh();
    passed=Case("桌面WorkerW来源：切应用后回到同Shell进程的Progman必须恢复",!invalid&&lastState=="active")&&passed;
    ResetTest();fakeDesktopSource=true;fakeForeground=new IntPtr(5);Refresh();
    passed=Case("资源管理器与桌面同进程但不同窗口类型，仍应隐藏",lastState=="inactive")&&passed;
    ResetTest();fakeDesktopSource=true;fakeForeground=new IntPtr(6);Refresh();
    passed=Case("其他进程即使使用WorkerW类名也不能冒充桌面",lastState=="inactive")&&passed;
    ResetTest();fakeForeground=new IntPtr(4);Refresh();
    passed=Case("普通应用来源不能因切到桌面而恢复",lastState=="inactive")&&passed;
    ResetTest();fakeDesktopSource=true;lastExternal=new IntPtr(4);fakeForeground=controls;Refresh();
    passed=Case("桌面另一宿主返回后点置顶菜单，覆盖仍允许显示",lastState=="active")&&passed;
    ResetTest();fakeDesktopSource=true;lastExternal=new IntPtr(5);fakeForeground=controls;Refresh();
    passed=Case("资源管理器上操作置顶菜单不能带出桌面覆盖",lastState=="inactive")&&passed;
    return passed?0:1;
  }
`;
// 保留正式状态去重及 Refresh 代码，仅在输出处附带测试状态收集器。
source = source.replace('lastState = value; Write(', 'lastState = value; observed.Add(value); Write(');
const end = source.lastIndexOf('}'); source = source.slice(0, end) + driver + source.slice(end);
fs.writeFileSync(path.join(output, '模拟来源助手.cs'), source);
fs.writeFileSync(path.join(output, '边界替换记录.json'), JSON.stringify({ 模式: '仅替换PInvoke，Refresh逻辑保持正式源码', 替换方法: substituted }, null, 2));
const framework = path.join(process.env.SystemRoot || 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319');
const executable = path.join(output, '模拟来源助手.exe');
const compile = spawnSync(path.join(framework, 'csc.exe'), ['/nologo', '/target:exe', `/out:${executable}`,
  `/reference:${path.join(framework, 'System.Windows.Forms.dll')}`, `/reference:${path.join(framework, 'System.Web.Extensions.dll')}`,
  path.join(output, '模拟来源助手.cs')], { windowsHide: true, encoding: 'utf8' });
if (compile.status !== 0) { process.stderr.write('模拟夹具编译失败。\n' + compile.stdout); process.exit(2); }
const run = spawnSync(executable, [], { windowsHide: true, encoding: 'utf8' });
const cases = run.stdout.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)).filter(value => value.type === 'case');
const report = { 通过: run.status === 0, 模式: '正式Refresh与替身Win32快照的时序模拟，非真实动画复现', 场景: cases };
fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
process.stdout.write(JSON.stringify(report, null, 2) + '\n'); process.exitCode = run.status;
