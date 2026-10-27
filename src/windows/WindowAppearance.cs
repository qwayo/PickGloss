using System;
using System.Collections.Concurrent;
using System.Globalization;
using System.Numerics;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
using Windows.UI.Composition;
using Windows.UI.Composition.Desktop;

// 只调整启动者拥有的窗口；翻译工具条可单独请求带圆角裁切的实时背景视觉。
internal static class WindowAppearance {
  [StructLayout(LayoutKind.Sequential)] private struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] private struct Point { public int X, Y; }
  [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")] private static extern bool GetClientRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] private static extern bool ClientToScreen(IntPtr window, ref Point point);
  [DllImport("user32.dll")] private static extern uint GetDpiForWindow(IntPtr window);
  [DllImport("dwmapi.dll")] private static extern int DwmSetWindowAttribute(IntPtr window, uint attribute, ref uint value, int size);
  [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr window, uint attribute, out Rect rect, int size);

  private sealed class Command { public long Sequence; public uint Color; public bool Backdrop; }

  private static bool OwnsWindow(IntPtr window, uint owner) {
    uint pid; GetWindowThreadProcessId(window, out pid);
    return pid != 0 && pid == owner;
  }

  private static bool ParseCommand(string line, bool clipped, out Command command) {
    command = null;
    string[] parts = line.Split(' '); long sequence; uint color;
    if (parts.Length != (clipped ? 3 : 2) || !long.TryParse(parts[0], out sequence) || sequence < 1) return false;
    if (parts[1] == "none") color = 0xfffffffe;
    else {
      uint rgb;
      if (parts[1].Length != 6 || !uint.TryParse(parts[1], NumberStyles.HexNumber, CultureInfo.InvariantCulture, out rgb)) return false;
      color = ((rgb >> 16) & 255) | (rgb & 0x00ff00) | ((rgb & 255) << 16);
    }
    if (clipped && parts[2] != "0" && parts[2] != "1") return false;
    command = new Command { Sequence = sequence, Color = color, Backdrop = clipped && parts[2] == "1" };
    return true;
  }

  private static string Metrics(IntPtr window, Command command, string backdrop) {
    Rect frame, client; Point origin = new Point();
    if (DwmGetWindowAttribute(window, 9, out frame, Marshal.SizeOf(typeof(Rect))) != 0 || !GetClientRect(window, out client) || !ClientToScreen(window, ref origin)) throw new InvalidOperationException("无法读取窗口几何。");
    uint dpi = GetDpiForWindow(window);
    if (dpi == 0 || client.Right <= 0 || client.Bottom <= 0) throw new InvalidOperationException("窗口几何无效。");
    return "{\"sequence\":" + command.Sequence + ",\"width\":" + client.Right + ",\"height\":" + client.Bottom +
      ",\"left\":" + (origin.X - frame.Left) + ",\"top\":" + (origin.Y - frame.Top) +
      ",\"right\":" + (frame.Right - origin.X - client.Right) + ",\"bottom\":" + (frame.Bottom - origin.Y - client.Bottom) + ",\"dpi\":" + dpi +
      ",\"suppressed\":" + (command.Color == 0xfffffffe).ToString().ToLowerInvariant() + backdrop + "}";
  }

  [STAThread] private static int Main(string[] args) {
    try {
      long handle; uint owner;
      if ((args.Length != 2 && args.Length != 3) || !long.TryParse(args[0], out handle) || !uint.TryParse(args[1], out owner)) return 2;
      SetProcessDpiAwarenessContext(new IntPtr(-4));
      IntPtr window = new IntPtr(handle);
      if (!OwnsWindow(window, owner)) return 3;
      if (args.Length == 3) {
        double radius;
        if (!double.TryParse(args[2], NumberStyles.Float, CultureInfo.InvariantCulture, out radius) || double.IsNaN(radius) || double.IsInfinity(radius) || radius <= 0 || radius > 64) return 2;
        return RunClipped(window, owner, radius);
      }
      string line;
      while ((line = Console.ReadLine()) != null) {
        if (!OwnsWindow(window, owner)) return 3;
        Command command;
        if (!ParseCommand(line, false, out command)) return 2;
        if (DwmSetWindowAttribute(window, 34, ref command.Color, 4) != 0) return 4;
        Console.WriteLine(Metrics(window, command, ""));
        Console.Out.Flush();
      }
      return 0;
    } catch { return 6; }
  }

  private static int RunClipped(IntPtr window, uint owner, double radius) {
    using (BackdropWindow backdrop = new BackdropWindow(window, owner, radius)) {
      backdrop.Initialize();
      Thread input = new Thread(delegate() {
        try {
          string line;
          while ((line = Console.ReadLine()) != null) {
            Command command;
            if (!ParseCommand(line, true, out command)) { backdrop.Stop(2); return; }
            backdrop.Enqueue(command);
          }
          backdrop.Stop(0);
        } catch { backdrop.Stop(6); }
      });
      input.IsBackground = true; input.Start();
      Application.Run();
      return backdrop.ExitCode;
    }
  }

  // 系统亚克力会绕过 HRGN 绘制四角。独立的实时背景视觉能把模糊本身裁进圆角。
  // 此路径只用于透明翻译工具条；主解释窗口继续使用既有 DWM 边框，不创建背景窗。
  private sealed class BackdropWindow : NativeWindow, IDisposable {
    private const uint DrainMessage = 0x8001, StopMessage = 0x8002;
    [StructLayout(LayoutKind.Sequential)] private struct QueueOptions { public int Size, ThreadType, ApartmentType; }
    private delegate void WinEventCallback(IntPtr hook, uint id, IntPtr window, int objectId, int childId, uint thread, uint time);
    [DllImport("CoreMessaging.dll")] private static extern int CreateDispatcherQueueController(QueueOptions options, out IntPtr controller);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr window, uint command);
    [DllImport("user32.dll")] private static extern IntPtr GetWindowLongPtr(IntPtr window, int index);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] private static extern IntPtr SetWinEventHook(uint first, uint last, IntPtr module, WinEventCallback callback, uint process, uint thread, uint flags);
    [DllImport("user32.dll")] private static extern bool UnhookWinEvent(IntPtr hook);
    [ComImport, Guid("29E691FA-4567-4DCA-B319-D0F207EB6807"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] private interface ICompositorDesktopInterop {
      void CreateDesktopWindowTarget(IntPtr window, bool topmost, out IntPtr target);
    }

    private readonly IntPtr ownerWindow;
    private readonly uint ownerPid;
    private readonly double radiusDip;
    private readonly ConcurrentQueue<Command> commands = new ConcurrentQueue<Command>();
    private readonly WinEventCallback windowEvent;
    private readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
    private Compositor compositor;
    private DesktopWindowTarget target;
    private SpriteVisual visual;
    private CompositionBackdropBrush brush;
    private CompositionRoundedRectangleGeometry geometry;
    private CompositionGeometricClip clip;
    private IntPtr dispatcher, eventHook;
    private bool enabled, shown, disposed;
    private int left, top, width, height;
    private uint dpi;
    public int ExitCode;

    public BackdropWindow(IntPtr window, uint owner, double radius) {
      ownerWindow = window; ownerPid = owner; radiusDip = radius;
      windowEvent = delegate(IntPtr hook, uint id, IntPtr changed, int objectId, int childId, uint thread, uint time) {
        if (changed == ownerWindow && objectId == 0) RefreshSafely();
      };
      timer.Interval = 250;
      timer.Tick += delegate { RefreshSafely(); };
    }

    public void Initialize() {
      // 不设为 owned popup：Win32 会强制 owned popup 位于控件窗上方，遮住前景内容。
      // 此窗无激活、无任务栏入口、鼠标穿透，始终紧邻本次控件窗之后。
      CreateHandle(new CreateParams { Caption = "PickGloss 翻译工具条材质", Style = unchecked((int)0x80000000),
        ExStyle = 0x00200000 | 0x08000000 | 0x00000080 | 0x00000020 | 0x00000008, Width = 1, Height = 1 });
      uint useBackdrop = 1;
      Marshal.ThrowExceptionForHR(DwmSetWindowAttribute(Handle, 17, ref useBackdrop, 4));
      Marshal.ThrowExceptionForHR(CreateDispatcherQueueController(new QueueOptions { Size = Marshal.SizeOf(typeof(QueueOptions)), ThreadType = 2, ApartmentType = 2 }, out dispatcher));
      compositor = new Compositor();
      IntPtr raw;
      ((ICompositorDesktopInterop)(object)compositor).CreateDesktopWindowTarget(Handle, false, out raw);
      try { target = (DesktopWindowTarget)Marshal.GetObjectForIUnknown(raw); } finally { Marshal.Release(raw); }
      brush = compositor.CreateHostBackdropBrush();
      visual = compositor.CreateSpriteVisual(); visual.Brush = brush;
      geometry = compositor.CreateRoundedRectangleGeometry();
      clip = compositor.CreateGeometricClip(geometry); visual.Clip = clip; target.Root = visual;
      eventHook = SetWinEventHook(0x8001, 0x800b, IntPtr.Zero, windowEvent, ownerPid, 0, 0);
      timer.Start();
    }

    public void Enqueue(Command command) {
      commands.Enqueue(command);
      PostMessage(Handle, DrainMessage, IntPtr.Zero, IntPtr.Zero);
    }

    public void Stop(int code) { PostMessage(Handle, StopMessage, new IntPtr(code), IntPtr.Zero); }

    private void RefreshSafely() {
      if (disposed) return;
      try { Refresh(); } catch { ExitCode = 6; Application.ExitThread(); }
    }

    private void Refresh() {
      if (!OwnsWindow(ownerWindow, ownerPid)) { ExitCode = 3; Application.ExitThread(); return; }
      bool visible = enabled && IsWindowVisible(ownerWindow) && !IsIconic(ownerWindow);
      timer.Interval = visible ? 16 : 250;
      if (!visible) {
        if (shown) { ShowWindow(Handle, 0); shown = false; }
        return;
      }
      Rect client; Point origin = new Point();
      if (!GetClientRect(ownerWindow, out client) || !ClientToScreen(ownerWindow, ref origin)) throw new InvalidOperationException("无法读取翻译工具条几何。");
      int nextWidth = client.Right - client.Left, nextHeight = client.Bottom - client.Top;
      uint nextDpi = GetDpiForWindow(ownerWindow);
      if (nextWidth <= 0 || nextHeight <= 0 || nextWidth > 65536 || nextHeight > 65536 || nextDpi < 72 || nextDpi > 960) throw new InvalidOperationException("翻译工具条几何无效。");
      bool changed = nextWidth != width || nextHeight != height || nextDpi != dpi;
      if (changed) {
        visual.Size = new Vector2(nextWidth, nextHeight);
        geometry.Size = visual.Size;
        float radius = (float)Math.Min(radiusDip * nextDpi / 96, Math.Min(nextWidth, nextHeight) / 2.0);
        geometry.CornerRadius = new Vector2(radius, radius);
      }
      bool topmost = (GetWindowLongPtr(ownerWindow, -20).ToInt64() & 8) != 0;
      bool backdropTopmost = (GetWindowLongPtr(Handle, -20).ToInt64() & 8) != 0;
      if (topmost != backdropTopmost) SetWindowPos(Handle, new IntPtr(topmost ? -1 : -2), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010);
      if (!shown || changed || origin.X != left || origin.Y != top || GetWindow(ownerWindow, 2) != Handle) {
        if (!SetWindowPos(Handle, ownerWindow, origin.X, origin.Y, nextWidth, nextHeight, 0x0010 | 0x0040)) throw new InvalidOperationException("无法同步翻译工具条材质。");
      }
      left = origin.X; top = origin.Y; width = nextWidth; height = nextHeight; dpi = nextDpi; shown = true;
    }

    private string BackdropMetrics() {
      return ",\"backdrop\":{\"handle\":\"" + Handle.ToInt64() + "\",\"pid\":" + System.Diagnostics.Process.GetCurrentProcess().Id +
        ",\"enabled\":" + enabled.ToString().ToLowerInvariant() + ",\"visible\":" + shown.ToString().ToLowerInvariant() +
        ",\"radius\":" + radiusDip.ToString("R", CultureInfo.InvariantCulture) + "}";
    }

    protected override void WndProc(ref Message message) {
      if (message.Msg == DrainMessage) {
        try {
          Command command;
          while (commands.TryDequeue(out command)) {
            enabled = command.Backdrop; Refresh();
            if (!OwnsWindow(ownerWindow, ownerPid)) break;
            if (DwmSetWindowAttribute(ownerWindow, 34, ref command.Color, 4) != 0) { ExitCode = 4; Application.ExitThread(); break; }
            Console.WriteLine(Metrics(ownerWindow, command, BackdropMetrics())); Console.Out.Flush();
          }
        } catch { ExitCode = 6; Application.ExitThread(); }
        return;
      }
      if (message.Msg == StopMessage) { ExitCode = message.WParam.ToInt32(); Application.ExitThread(); return; }
      if (message.Msg == 0x0084) { message.Result = new IntPtr(-1); return; }
      if (message.Msg == 0x0021) { message.Result = new IntPtr(3); return; }
      if (message.Msg == 0x0014) { message.Result = new IntPtr(1); return; }
      base.WndProc(ref message);
    }

    public void Dispose() {
      if (disposed) return;
      disposed = true; timer.Stop(); timer.Dispose();
      if (eventHook != IntPtr.Zero) UnhookWinEvent(eventHook);
      if (Handle != IntPtr.Zero) ShowWindow(Handle, 0);
      if (target != null) { target.Root = null; target.Dispose(); }
      if (visual != null) visual.Dispose();
      if (clip != null) clip.Dispose();
      if (geometry != null) geometry.Dispose();
      if (brush != null) brush.Dispose();
      if (compositor != null) compositor.Dispose();
      if (dispatcher != IntPtr.Zero) Marshal.Release(dispatcher);
      if (Handle != IntPtr.Zero) DestroyHandle();
    }
  }
}
