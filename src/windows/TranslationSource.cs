using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

// 仅跟踪窗口身份、边界、前台与 Z 序，不采集其他应用内容。
internal static class TranslationSource {
  [StructLayout(LayoutKind.Sequential)] private struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] private struct Point { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] private struct WindowPlacement {
    public int Length, Flags;
    public uint ShowCommand;
    public Point MinimumPosition, MaximumPosition;
    public Rect NormalPosition;
  }
  private delegate void WinEvent(IntPtr hook, uint kind, IntPtr window, int obj, int child, uint thread, uint time);
  private delegate bool EnumWindow(IntPtr window, IntPtr param);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindow callback, IntPtr param);
  [DllImport("user32.dll")] private static extern IntPtr GetWindowLongPtr(IntPtr window, int index);
  [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] private static extern IntPtr GetShellWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder name, int maximum);
  [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] private static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr wParam, IntPtr lParam, uint flags, uint timeout, out UIntPtr result);
  [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr window, uint flag);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr window);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] private static extern bool GetWindowPlacement(IntPtr window, ref WindowPlacement placement);
  [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] private static extern IntPtr SetWinEventHook(uint first, uint last, IntPtr module, WinEvent callback, uint pid, uint thread, uint flags);
  [DllImport("user32.dll")] private static extern bool UnhookWinEvent(IntPtr hook);
  [DllImport("user32.dll")] private static extern IntPtr GetTopWindow(IntPtr window);
  [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr window, uint command);
  [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
  [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr window, uint attribute, out int value, int size);
  private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
  private static readonly ConcurrentQueue<string> Commands = new ConcurrentQueue<string>();
  private static uint ownerPid, sourcePid;
  private static IntPtr source, overlay, controls, lastExternal;
  private static Rect initial;
  private static long binding;
  private static string lastState;
  private static bool invalid, refreshing;
  private static bool minimizeSeen, restorePending;
  private static long restoreStarted, restoreStableSince;
  private static Rect restoreCandidate;
  private static volatile bool stopped;
  private static readonly WinEvent Callback = OnWindowEvent;
  private static void Write(object value) { Console.Out.WriteLine(Json.Serialize(value)); Console.Out.Flush(); }
  private static IntPtr Root(IntPtr value) { return value == IntPtr.Zero ? value : GetAncestor(value, 2); }
  private static bool Owns(IntPtr window, uint expected) { uint actual; return IsWindow(window) && GetWindowThreadProcessId(window, out actual) != 0 && actual == expected; }
  private static bool ReadRect(IntPtr window, out Rect rect) { return GetWindowRect(window, out rect) && rect.Right > rect.Left && rect.Bottom > rect.Top; }
  private static bool SameRect(Rect a, Rect b) { return a.Left == b.Left && a.Top == b.Top && a.Right == b.Right && a.Bottom == b.Bottom; }
  private static bool IsDesktopHost(IntPtr window) {
    IntPtr shell = GetShellWindow(); uint shellPid, windowPid;
    if (shell == IntPtr.Zero || window == IntPtr.Zero || !IsWindow(window) ||
        GetWindowThreadProcessId(shell, out shellPid) == 0 || GetWindowThreadProcessId(window, out windowPid) == 0 || shellPid != windowPid) return false;
    var name = new StringBuilder(64);
    if (GetClassName(window, name, name.Capacity) == 0) return false;
    return name.ToString() == "Progman" || name.ToString() == "WorkerW";
  }
  private static bool SameSource(IntPtr window) {
    // 桌面图标层与背景层可由不同宿主承载；只合并真实 Shell 进程的桌面类，不合并资源管理器。
    return window == source || IsDesktopHost(source) && IsDesktopHost(window);
  }
  private static bool RequiresBrowserContext(IntPtr window, uint pid) {
    var name = new StringBuilder(64);
    if (GetClassName(window, name, name.Capacity) == 0 || name.ToString() != "Chrome_WidgetWin_1") return false;
    try { using (var process = Process.GetProcessById((int)pid)) return String.Equals(process.ProcessName, "msedge", StringComparison.OrdinalIgnoreCase); }
    catch { return true; }
  }
  private static long NowMilliseconds() { return Stopwatch.GetTimestamp() / (Stopwatch.Frequency / 1000); }
  private static object Snapshot(IntPtr window) {
    uint pid; Rect r;
    if (window == IntPtr.Zero || !IsWindowVisible(window) || IsIconic(window) || GetWindowThreadProcessId(window, out pid) == 0 || pid == ownerPid || !ReadRect(window, out r)) return null;
    int cloaked; if (DwmGetWindowAttribute(window, 14, out cloaked, 4) == 0 && cloaked != 0) return null;
    return new { handle = window.ToInt64().ToString(CultureInfo.InvariantCulture), pid = pid,
      bounds = new { x = r.Left, y = r.Top, width = r.Right - r.Left, height = r.Bottom - r.Top }, browserContextRequired = RequiresBrowserContext(window, pid) };
  }
  private static object WindowAtlas() {
    var result = new List<object>();
    EnumWindows(delegate(IntPtr window, IntPtr param) {
      if (result.Count >= 64) return false;
      if ((GetWindowLongPtr(window, -20).ToInt64() & 0x20) == 0) {
        object value = Snapshot(window); if (value != null) result.Add(value);
      }
      return true;
    }, IntPtr.Zero);
    return result;
  }
  private static void RememberForeground() {
    IntPtr active = Root(GetForegroundWindow()); uint pid;
    if (active != IntPtr.Zero && GetWindowThreadProcessId(active, out pid) != 0 && pid != ownerPid && pid != (uint)Process.GetCurrentProcess().Id && Snapshot(active) != null) lastExternal = active;
  }
  private static void State(string value) {
    if (binding == 0 || value == lastState) return;
    lastState = value; Write(new { type = "state", binding = binding, state = value });
  }
  private static bool SourceAboveOverlay() {
    IntPtr next = GetTopWindow(IntPtr.Zero);
    for (int i = 0; next != IntPtr.Zero && i < 4096; i++, next = GetWindow(next, 2)) {
      if (next == overlay) return false;
      if (next == source) return true;
    }
    return true;
  }
  private static void Refresh() {
    if (refreshing || stopped) return;
    refreshing = true;
    try {
      RememberForeground();
      if (binding == 0) return;
      if (!Owns(source, sourcePid)) { invalid = true; State("closed"); return; }
      int cloaked = 0; DwmGetWindowAttribute(source, 14, out cloaked, 4);
      // 最小化意图可先于 IsIconic 与动画矩形到达；此时只隐藏，不把临时位置永久判为移动。
      var placement = new WindowPlacement { Length = Marshal.SizeOf(typeof(WindowPlacement)) };
      bool minimizing = GetWindowPlacement(source, ref placement) &&
        (placement.ShowCommand == 2 || placement.ShowCommand == 6 || placement.ShowCommand == 7 || placement.ShowCommand == 11);
      if (IsIconic(source) || minimizing) { minimizeSeen = true; restorePending = false; State("inactive"); return; }
      if (!IsWindowVisible(source) || cloaked != 0) { State("inactive"); return; }
      Rect r;
      if (!ReadRect(source, out r)) { State("inactive"); return; }
      if (!invalid && !SameRect(r, initial)) {
        if (minimizeSeen) {
          long now = NowMilliseconds();
          if (!restorePending) { restorePending = true; restoreStarted = restoreStableSince = now; restoreCandidate = r; }
          else if (!SameRect(r, restoreCandidate)) { restoreCandidate = r; restoreStableSince = now; }
          // 还原动画期间立即隐藏旧覆盖；只在回到原矩形后恢复，不能把旧译文画到暂态位置。
          // 新矩形稳定250毫秒或等待总计1000毫秒后，仍不匹配就按真实位置变化终止旧覆盖。
          if (now - restoreStableSince < 250 && now - restoreStarted < 1000) { State("inactive"); return; }
        }
        invalid = true; minimizeSeen = restorePending = false; State("moved"); return;
      }
      if (SameRect(r, initial)) minimizeSeen = restorePending = false;
      IntPtr active = Root(GetForegroundWindow());
      bool controlsActive = active == controls || Owns(active, ownerPid) && GetAncestor(active, 3) == controls;
      bool allowed = SameSource(active) || controlsActive && SameSource(lastExternal);
      if (!allowed) { State("inactive"); return; }
      if (!Owns(overlay, ownerPid) || !Owns(controls, ownerPid)) { invalid = true; State("unavailable"); return; }
      // 来源重新激活后只在确有遮挡顺序时修正；不抢焦点，也不持续重排其他窗口。
      bool sourceTopmost = (GetWindowLongPtr(source, -20).ToInt64() & 8) != 0;
      bool overlayTopmost = (GetWindowLongPtr(overlay, -20).ToInt64() & 8) != 0;
      // 覆盖只跟随来源所在层级，不从菜单的独立置顶状态继承层级。
      if (IsWindowVisible(overlay) && (SourceAboveOverlay() || sourceTopmost != overlayTopmost)) {
        const uint flags = 0x0001 | 0x0002 | 0x0010 | 0x4000;
        SetWindowPos(overlay, new IntPtr(-1), 0, 0, 0, 0, flags);
        // 普通来源只借助同一队列的升降操作修正顺序，最终仍回到普通窗口层。
        if (!sourceTopmost) SetWindowPos(overlay, new IntPtr(-2), 0, 0, 0, 0, flags);
        SetWindowPos(controls, IntPtr.Zero, 0, 0, 0, 0, flags);
      }
      State("active");
    } finally { refreshing = false; }
  }
  private static void OnWindowEvent(IntPtr hook, uint kind, IntPtr changed, int obj, int child, uint thread, uint time) {
    if (kind == 3 || changed == source && obj == 0) Refresh();
  }
  private static long Number(string value) { return long.Parse(value, CultureInfo.InvariantCulture); }
  private static void Command(string line) {
    string[] p = line.Split(' ');
    if (p.Length == 1 && p[0] == "clear") { binding = 0; source = overlay = controls = IntPtr.Zero; lastState = null; minimizeSeen = restorePending = false; return; }
    if (p.Length == 2 && p[0] == "capture") {
      RememberForeground(); Write(new { type = "capture", id = Number(p[1]), source = Snapshot(lastExternal), windows = WindowAtlas() }); return;
    }
    if (p.Length == 9 && p[0] == "restore") {
      long id = Number(p[1]); IntPtr target = new IntPtr(Number(p[2])), capture = new IntPtr(Number(p[8]));
      uint targetPid = uint.Parse(p[3], CultureInfo.InvariantCulture); Rect r;
      bool restored = false, eligible = false, accepted = false;
      // 仅在本次截图层仍持有前台时交还用户框选的来源；切到别的窗口后绝不抢焦点。
      if (id > 0 && targetPid != ownerPid && Owns(target, targetPid) && Owns(capture, ownerPid) &&
          Root(GetForegroundWindow()) == capture && IsWindowVisible(target) && !IsIconic(target) && ReadRect(target, out r) &&
          r.Left == Number(p[4]) && r.Top == Number(p[5]) && r.Right - r.Left == Number(p[6]) && r.Bottom - r.Top == Number(p[7])) {
        int cloaked = 0; DwmGetWindowAttribute(target, 14, out cloaked, 4);
        if (cloaked == 0) {
          eligible = true; accepted = SetForegroundWindow(target);
          UIntPtr ignored;
          if (accepted) SendMessageTimeout(target, 0, UIntPtr.Zero, IntPtr.Zero, 0x0002, 100, out ignored);
          restored = accepted && Root(GetForegroundWindow()) == target;
        }
      }
      Write(new { type = "restore", id = id, restored = restored, eligible = eligible, accepted = accepted,
        foregroundIsTarget = Root(GetForegroundWindow()) == target, foregroundIsCapture = Root(GetForegroundWindow()) == capture }); return;
    }
    if (p.Length != 11 || p[0] != "bind") throw new InvalidOperationException("来源命令无效。");
    long next = Number(p[1]); IntPtr s = new IntPtr(Number(p[2])), a = new IntPtr(Number(p[9])), b = new IntPtr(Number(p[10]));
    uint pid = uint.Parse(p[3], CultureInfo.InvariantCulture);
    int x = int.Parse(p[4], CultureInfo.InvariantCulture), y = int.Parse(p[5], CultureInfo.InvariantCulture);
    int width = int.Parse(p[6], CultureInfo.InvariantCulture), height = int.Parse(p[7], CultureInfo.InvariantCulture);
    // p[8] 由协议保留为窗口计数，拒绝扩展到其他未授权窗口。
    if (p[8] != "2" || next <= 0 || width < 1 || height < 1 || width > 100000 || height > 100000 || Math.Abs((long)x) > 200000 || Math.Abs((long)y) > 200000 ||
        !Owns(s, pid) || pid == ownerPid || !Owns(a, ownerPid) || !Owns(b, ownerPid)) throw new InvalidOperationException("来源窗口身份无效。");
    source = s; sourcePid = pid; overlay = a; controls = b; binding = next; invalid = false; lastState = null; minimizeSeen = restorePending = false;
    initial = new Rect { Left = x, Top = y, Right = x + width, Bottom = y + height }; Refresh();
  }
  [STAThread] private static int Main(string[] args) {
    if ((args.Length != 1 && args.Length != 9) || !uint.TryParse(args[0], out ownerPid) || ownerPid == 0) return 2;
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch (EntryPointNotFoundException) { }
    // 提交由当前前台 Electron 启动短命助手；不借用后台监视器的前台权限，也不连接输入队列。
    if (args.Length == 9) {
      if (args[1] != "restore") return 2;
      try { Command("restore 1 " + String.Join(" ", args, 2, 7)); return 0; } catch { return 3; }
    }
    IntPtr foregroundHook = IntPtr.Zero, sourceHook = IntPtr.Zero;
    using (var timer = new System.Windows.Forms.Timer()) {
      try {
        foregroundHook = SetWinEventHook(3, 3, IntPtr.Zero, Callback, 0, 0, 0);
        sourceHook = SetWinEventHook(0x8000, 0x800b, IntPtr.Zero, Callback, 0, 0, 0);
        if (foregroundHook == IntPtr.Zero || sourceHook == IntPtr.Zero) return 3;
        RememberForeground(); Write(new { type = "ready" });
        var input = new Thread(delegate() {
          try { string line; while ((line = Console.ReadLine()) != null) { if (line.Length > 2048) break; Commands.Enqueue(line); } }
          finally { stopped = true; }
        }); input.IsBackground = true; input.Start();
        timer.Interval = 50; timer.Tick += delegate {
          if (stopped) { Application.ExitThread(); return; }
          try { string line; while (Commands.TryDequeue(out line)) Command(line); Refresh(); }
          catch { if (binding > 0) State("unavailable"); stopped = true; Application.ExitThread(); }
        }; timer.Start(); Application.Run(); return 0;
      } finally { stopped = true; if (foregroundHook != IntPtr.Zero) UnhookWinEvent(foregroundHook); if (sourceHook != IntPtr.Zero) UnhookWinEvent(sourceHook); }
    }
  }
}
