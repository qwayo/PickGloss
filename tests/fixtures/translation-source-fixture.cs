using System;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

// 来源跟随的自有窗口夹具；只报告窗口元数据，不采集屏幕。
internal static class TranslationSourceFixture {
  [StructLayout(LayoutKind.Sequential)] private struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] private struct NativePoint { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] private struct MouseInput {
    public int X, Y;
    public uint MouseData, Flags, Time;
    public UIntPtr ExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)] private struct Input { public uint Type; public MouseInput Mouse; }
  [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] private static extern bool GetCursorPos(out NativePoint point);
  [DllImport("user32.dll")] private static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] private static extern IntPtr WindowFromPoint(NativePoint point);
  [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr window, uint flags);
  [DllImport("user32.dll", SetLastError = true)] private static extern uint SendInput(uint count, Input[] inputs, int size);
  [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")] private static extern IntPtr GetTopWindow(IntPtr window);
  [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr window, uint command);
  [DllImport("user32.dll")] private static extern IntPtr GetWindowLongPtr(IntPtr window, int index);
  [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int w, int h, uint flags);
  private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
  private static Form source, other;
  private static IntPtr externalOther;
  private static IntPtr OtherHandle { get { return externalOther != IntPtr.Zero ? externalOther : other.Handle; } }
  private static bool Above(IntPtr a, IntPtr b) {
    IntPtr next = GetTopWindow(IntPtr.Zero);
    for (int i = 0; next != IntPtr.Zero && i < 4096; i++, next = GetWindow(next, 2)) { if (next == a) return true; if (next == b) return false; }
    return false;
  }
  private static void Write(object value) { Console.Out.WriteLine(Json.Serialize(value)); Console.Out.Flush(); }
  private static object Bounds(Form window) { Rect r; GetWindowRect(window.Handle, out r); return new { x = r.Left, y = r.Top, width = r.Right - r.Left, height = r.Bottom - r.Top }; }
  private static object OtherBounds() { Rect r; GetWindowRect(OtherHandle, out r); return new { x = r.Left, y = r.Top, width = r.Right - r.Left, height = r.Bottom - r.Top }; }
  private static void Run(string command) {
    string[] p = command.Split(' '); string action = p[0];
    if (action == "focus") {
      source.WindowState = FormWindowState.Normal; source.Show(); source.Activate();
      bool accepted = SetForegroundWindow(source.Handle);
      bool inputClick = false, clickTargetIsSource = false, cursorRestored = true;
      string clickTarget = null; uint clickTargetPid = 0, foregroundPid = 0; bool raisedForInput = false;
      if (GetForegroundWindow() != source.Handle) {
        NativePoint previous;
        if (GetCursorPos(out previous)) {
          bool wasTopMost = source.TopMost;
          if (!wasTopMost) { source.TopMost = true; raisedForInput = true; }
          NativePoint target = new NativePoint();
          System.Drawing.Point client = source.PointToScreen(new System.Drawing.Point(24, 40));
          target.X = client.X; target.Y = client.Y;
          if (SetCursorPos(target.X, target.Y)) {
            Thread.Sleep(25);
            IntPtr under = WindowFromPoint(target), root = GetAncestor(under, 2);
            GetWindowThreadProcessId(root, out clickTargetPid);
            clickTarget = root.ToInt64().ToString();
            clickTargetIsSource = root == source.Handle && clickTargetPid == (uint)Process.GetCurrentProcess().Id;
            if (clickTargetIsSource) {
              Input[] inputs = new Input[2];
              inputs[0].Mouse.Flags = 0x0002; // 左键按下
              inputs[1].Mouse.Flags = 0x0004; // 左键抬起
              inputClick = SendInput(2, inputs, Marshal.SizeOf(typeof(Input))) == 2;
              if (inputClick) Thread.Sleep(40);
            }
          }
          cursorRestored = SetCursorPos(previous.X, previous.Y);
          if (raisedForInput) source.TopMost = false;
        }
      }
      GetWindowThreadProcessId(GetForegroundWindow(), out foregroundPid);
      Write(new { type = "focus-attempt", accepted = accepted, sourceForeground = GetForegroundWindow() == source.Handle, foregroundPid = foregroundPid,
        sourceVisible = IsWindowVisible(source.Handle), inputClick = inputClick, clickTarget = clickTarget,
        clickTargetPid = clickTargetPid, clickTargetIsSource = clickTargetIsSource, cursorRestored = cursorRestored,
        raisedForInput = raisedForInput });
    }
    else if (action == "external-other" && p.Length == 3) {
      IntPtr candidate = new IntPtr(long.Parse(p[1])); uint expected = uint.Parse(p[2]), actual;
      if (expected == 0 || expected == (uint)Process.GetCurrentProcess().Id || GetWindowThreadProcessId(candidate, out actual) == 0 || actual != expected)
        throw new InvalidOperationException("独立另一窗口夹具身份无效。");
      externalOther = candidate;
    }
    else if (action == "other") { if (externalOther == IntPtr.Zero) { other.Show(); other.Activate(); } SetForegroundWindow(OtherHandle); }
    else if (action == "quick-return" && p.Length == 4) {
      IntPtr menu = new IntPtr(long.Parse(p[1])); uint expectedPid = uint.Parse(p[2]), actualPid, foregroundPid;
      int pause = int.Parse(p[3]); GetWindowThreadProcessId(menu, out actualPid);
      GetWindowThreadProcessId(GetForegroundWindow(), out foregroundPid);
      if (actualPid != expectedPid || expectedPid == 0 || pause < 0 || pause > 150 ||
          foregroundPid != expectedPid && foregroundPid != (uint)Process.GetCurrentProcess().Id)
        throw new InvalidOperationException("快速来源往返仅允许本次自有窗口。");
      source.Activate(); bool sourceAccepted = SetForegroundWindow(source.Handle);
      bool sourceForeground = GetForegroundWindow() == source.Handle;
      if (pause > 0) Thread.Sleep(pause);
      bool menuAccepted = SetForegroundWindow(menu);
      Write(new { type = "quick-return", sourceAccepted = sourceAccepted, sourceForeground = sourceForeground,
        menuAccepted = menuAccepted, menuForeground = GetForegroundWindow() == menu, pause = pause });
    }
    else if (action == "separate") {
      Rectangle work = Screen.FromControl(source).WorkingArea;
      int gap = 20, x = source.Right + gap, width = Math.Min(440, work.Right - x), height = Math.Min(380, work.Bottom - source.Top);
      if (width < 160 || height < 180) { Write(new { type = "error", action = "separate", reason = "来源右侧没有足够的自有窗口验证空间。" }); return; }
      other.Size = new Size(width, height); other.Location = new Point(x, source.Top); other.Show(); other.BringToFront();
      source.Activate(); SetForegroundWindow(source.Handle);
      Rect a, b; GetWindowRect(source.Handle, out a); GetWindowRect(other.Handle, out b);
      if (b.Left < a.Right || a.Bottom <= b.Top || b.Bottom <= a.Top) {
        Write(new { type = "error", action = "separate", reason = "来源窗口与另一窗口未能形成不重叠的并排布局。" }); return;
      }
    }
    else if (action == "raise") { source.TopMost = true; SetWindowPos(source.Handle, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002); source.Activate(); SetForegroundWindow(source.Handle); }
    else if (action == "minimize") source.WindowState = FormWindowState.Minimized;
    else if (action == "restore") { source.WindowState = FormWindowState.Normal; source.Activate(); SetForegroundWindow(source.Handle); }
    else if (action == "move") source.Left += 50;
    else if (action == "close-source") source.Hide();
    else if (action == "destroy-source") source.Dispose();
    else if (action == "quit") { other.Dispose(); source.Dispose(); Application.ExitThread(); return; }
    else if (action == "capture-drag" && p.Length == 9) {
      IntPtr capture = new IntPtr(long.Parse(p[2])); uint expectedPid = uint.Parse(p[3]), actualPid;
      NativePoint first = new NativePoint { X = int.Parse(p[4]), Y = int.Parse(p[5]) };
      NativePoint last = new NativePoint { X = int.Parse(p[6]), Y = int.Parse(p[7]) }, previous;
      GetWindowThreadProcessId(capture, out actualPid);
      bool owns = actualPid == expectedPid && expectedPid != 0 &&
        GetAncestor(WindowFromPoint(first), 2) == capture && GetAncestor(WindowFromPoint(last), 2) == capture;
      bool sent = false, restored = true;
      if (p[8] == "owned" && owns && GetCursorPos(out previous)) {
        try {
          if (SetCursorPos(first.X, first.Y)) {
            Input[] down = new Input[1]; down[0].Mouse.Flags = 0x0002;
            sent = SendInput(1, down, Marshal.SizeOf(typeof(Input))) == 1;
            Thread.Sleep(60);
            if (sent) { SetCursorPos(last.X, last.Y); Thread.Sleep(60); }
            Input[] up = new Input[1]; up[0].Mouse.Flags = 0x0004;
            sent = SendInput(1, up, Marshal.SizeOf(typeof(Input))) == 1 && sent;
          }
        } finally { restored = SetCursorPos(previous.X, previous.Y); }
      }
      Write(new { type = "capture-drag", id = long.Parse(p[1]), owned = owns, sent = sent, cursorRestored = restored });
    }
    else if (action == "fixture-probe" && p.Length == 2) {
      uint expected = (uint)Process.GetCurrentProcess().Id, sourcePid, otherPid, foregroundPid;
      GetWindowThreadProcessId(source.Handle, out sourcePid); GetWindowThreadProcessId(other.Handle, out otherPid);
      if (sourcePid != expected || otherPid != expected) throw new InvalidOperationException("来源夹具窗口进程身份无效。");
      GetWindowThreadProcessId(GetForegroundWindow(), out foregroundPid);
      Write(new { type = "fixture-probe", id = long.Parse(p[1]), foreground = GetForegroundWindow().ToInt64().ToString(), foregroundPid = foregroundPid,
        sourceVisible = IsWindowVisible(source.Handle), otherVisible = IsWindowVisible(other.Handle), bounds = Bounds(source), otherBounds = Bounds(other) });
    }
    else if (action == "probe" && p.Length == 5) {
      uint expected = uint.Parse(p[4]), aPid, bPid;
      IntPtr a = new IntPtr(long.Parse(p[2])), b = new IntPtr(long.Parse(p[3]));
      GetWindowThreadProcessId(a, out aPid); GetWindowThreadProcessId(b, out bPid);
      if (aPid != expected || bPid != expected || expected == 0) throw new InvalidOperationException("探针窗口不属于本次进程。");
      Write(new { type = "probe", id = long.Parse(p[1]), foreground = GetForegroundWindow().ToInt64().ToString(),
        overlayVisible = IsWindowVisible(a), controlsVisible = IsWindowVisible(b), overlayAboveSource = Above(a, source.Handle),
        overlayTopmost = (GetWindowLongPtr(a, -20).ToInt64() & 8) != 0,
        sourceTopmost = (GetWindowLongPtr(source.Handle, -20).ToInt64() & 8) != 0,
        otherVisible = IsWindowVisible(OtherHandle), bounds = Bounds(source), otherBounds = OtherBounds() });
    }
  }
  [STAThread] private static void Main() {
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch (EntryPointNotFoundException) { }
    source = new Form { Text = "PickGloss 来源验证", StartPosition = FormStartPosition.Manual, Location = new Point(100, 100), Size = new Size(980, 660), BackColor = Color.FromArgb(21, 73, 114) };
    source.Controls.Add(new Label { Text = "Desktop — 桌面\n这里只显示固定验证材料。", AutoSize = true, Location = new Point(60, 80), ForeColor = Color.White, Font = new Font("Microsoft YaHei UI", 18) });
    other = new Form { Text = "PickGloss 另一窗口验证", StartPosition = FormStartPosition.Manual, Location = new Point(160, 140), Size = new Size(800, 520), BackColor = Color.FromArgb(96, 58, 72) };
    other.Controls.Add(new Label { Text = "窗口 B\n这里是固定验证材料。", AutoSize = true, Location = new Point(40, 60), ForeColor = Color.White, Font = new Font("Microsoft YaHei UI", 18) });
    source.Shown += delegate {
      Write(new { type = "ready", handle = source.Handle.ToInt64().ToString(), other = other.Handle.ToInt64().ToString(), pid = Process.GetCurrentProcess().Id, bounds = Bounds(source) });
      var input = new Thread(delegate() {
        try {
          string line;
          while ((line = Console.ReadLine()) != null) { if (line.Length > 2048) break; string next = line; source.BeginInvoke((Action)(() => Run(next))); }
        } finally { try { source.BeginInvoke((Action)(() => { other.Dispose(); source.Dispose(); Application.ExitThread(); })); } catch { } }
      }); input.IsBackground = true; input.Start();
    };
    Application.Run(source);
  }
}
