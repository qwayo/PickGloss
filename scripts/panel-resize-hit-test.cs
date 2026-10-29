using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

// 查询指定自有窗口的命中结果，并可对该自有测试窗口发送受控缩放输入。
public static class PanelResizeHitTest {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] struct Point { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] struct MouseInput { public int X, Y; public uint Data, Flags, Time; public UIntPtr ExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] struct InputUnion { [FieldOffset(0)] public MouseInput Mouse; }
  [StructLayout(LayoutKind.Sequential)] struct Input { public uint Type; public InputUnion Union; }
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out Point point);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, Input[] inputs, int size);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr window, uint attribute, out Rect rect, int size);
  [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW", SetLastError=true)] static extern IntPtr GetWindowLongPtr(IntPtr window, int index);
  [DllImport("user32.dll")] static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);

  static IntPtr PackPoint(int x, int y) { return new IntPtr(((y & 0xffff) << 16) | (x & 0xffff)); }

  static void SendMouse(uint flags, int dx = 0, int dy = 0) {
    var input = new Input { Type = 0, Union = new InputUnion { Mouse = new MouseInput { X = dx, Y = dy, Flags = flags } } };
    if (SendInput(1, new[] { input }, Marshal.SizeOf(typeof(Input))) != 1)
      throw new InvalidOperationException("SendInput 未能发送自有窗口拖边输入，Win32 错误码 " + Marshal.GetLastWin32Error() + "。");
  }

  static int Hit(IntPtr window, int x, int y) {
    IntPtr result;
    if (SendMessageTimeout(window, 0x0084, IntPtr.Zero, PackPoint(x, y), 0x0002, 1000, out result) == IntPtr.Zero)
      throw new InvalidOperationException("窗口未在时限内返回 WM_NCHITTEST。");
    return result.ToInt32();
  }

  public static string Inspect(long handle, uint expectedPid) {
    SetProcessDpiAwarenessContext(new IntPtr(-4));
    IntPtr window = new IntPtr(handle); uint owner;
    GetWindowThreadProcessId(window, out owner);
    if (owner == 0 || owner != expectedPid) throw new InvalidOperationException("窗口归属与调用进程不一致。");
    Rect frame, visible;
    if (!GetWindowRect(window, out frame) || DwmGetWindowAttribute(window, 9, out visible, Marshal.SizeOf(typeof(Rect))) != 0)
      throw new InvalidOperationException("无法读取自有窗口边界。");
    long style = GetWindowLongPtr(window, -16).ToInt64() & 0xffffffffL;
    int midX = (visible.Left + visible.Right) / 2, midY = (visible.Top + visible.Bottom) / 2;
    var hits = new Dictionary<string, int> {
      {"左", Hit(window, visible.Left + 1, midY)}, {"右", Hit(window, visible.Right - 2, midY)},
      {"上", Hit(window, midX, visible.Top + 1)}, {"下", Hit(window, midX, visible.Bottom - 2)},
      {"左上", Hit(window, visible.Left + 1, visible.Top + 1)}, {"右上", Hit(window, visible.Right - 2, visible.Top + 1)},
      {"左下", Hit(window, visible.Left + 1, visible.Bottom - 2)}, {"右下", Hit(window, visible.Right - 2, visible.Bottom - 2)}
    };
    var expected = new Dictionary<string, int> {
      {"左",1},{"右",1},{"上",1},{"下",1},{"左上",1},{"右上",1},{"左下",1},{"右下",1}
    };
    bool passed = true;
    foreach (var pair in expected) passed = passed && hits[pair.Key] == pair.Value;
    string json = "{\"ownerPid\":" + owner + ",\"hasThickFrame\":" + ((style & 0x00040000L) != 0 ? "true" : "false") +
      ",\"style\":" + style + ",\"frame\":{\"left\":" + frame.Left + ",\"top\":" + frame.Top + ",\"right\":" + frame.Right + ",\"bottom\":" + frame.Bottom +
      "},\"visible\":{\"left\":" + visible.Left + ",\"top\":" + visible.Top + ",\"right\":" + visible.Right + ",\"bottom\":" + visible.Bottom + "},\"hits\":{";
    bool first = true;
    foreach (var pair in hits) { if (!first) json += ","; first = false; json += "\"" + pair.Key + "\":" + pair.Value; }
    return json + "},\"passed\":" + (passed ? "true" : "false") + "}";
  }

  public static string DragRightEdge(long handle, uint expectedPid) {
    SetProcessDpiAwarenessContext(new IntPtr(-4));
    IntPtr window = new IntPtr(handle); uint owner;
    GetWindowThreadProcessId(window, out owner);
    if (owner == 0 || owner != expectedPid) throw new InvalidOperationException("窗口归属与调用进程不一致。");
    Rect before, after;
    if (!GetWindowRect(window, out before)) throw new InvalidOperationException("无法读取拖动前的自有窗口边界。");
    int x = before.Right - 2, y = (before.Top + before.Bottom) / 2;
    if (GetAncestor(WindowFromPoint(new Point { X = x, Y = y }), 2) != window || Hit(window, x, y) != 11)
      throw new InvalidOperationException("拖动点未命中自有窗口的 HT_RIGHT 边缘。");
    Point cursor;
    if (!GetCursorPos(out cursor)) throw new InvalidOperationException("无法保存当前指针位置。");
    bool down = false;
    try {
      if (!SetCursorPos(x, y)) throw new InvalidOperationException("无法把测试指针放到自有窗口右边缘。");
      System.Threading.Thread.Sleep(100);
      SendMouse(0x0002); down = true;
      System.Threading.Thread.Sleep(80);
      SendMouse(0x0001, 40, 0);
      System.Threading.Thread.Sleep(250);
      SendMouse(0x0004); down = false;
      System.Threading.Thread.Sleep(250);
      if (!GetWindowRect(window, out after)) throw new InvalidOperationException("无法读取拖动后的自有窗口边界。");
    } finally {
      if (down) SendMouse(0x0004);
      SetCursorPos(cursor.X, cursor.Y);
    }
    int delta = (after.Right - after.Left) - (before.Right - before.Left);
    bool passed = delta >= 20 && Math.Abs((after.Bottom - after.Top) - (before.Bottom - before.Top)) <= 5;
    return "{\"ownerPid\":" + owner + ",\"before\":{\"left\":" + before.Left + ",\"top\":" + before.Top + ",\"right\":" + before.Right + ",\"bottom\":" + before.Bottom +
      "},\"after\":{\"left\":" + after.Left + ",\"top\":" + after.Top + ",\"right\":" + after.Right + ",\"bottom\":" + after.Bottom +
      "},\"dragPixels\":40,\"widthDelta\":" + delta + ",\"passed\":" + (passed ? "true" : "false") + "}";
  }

  public static string DragCustomRightEdge(long handle, uint expectedPid, double xDip, double yDip, double scale) {
    SetProcessDpiAwarenessContext(new IntPtr(-4));
    IntPtr window = new IntPtr(handle); uint owner;
    GetWindowThreadProcessId(window, out owner);
    if (owner == 0 || owner != expectedPid) throw new InvalidOperationException("窗口归属与调用进程不一致。");
    if (double.IsNaN(xDip) || double.IsInfinity(xDip) || double.IsNaN(yDip) || double.IsInfinity(yDip) ||
        double.IsNaN(scale) || double.IsInfinity(scale) || scale < .5 || scale > 8)
      throw new InvalidOperationException("缩放手柄坐标无效。");
    Rect before, after;
    if (!GetWindowRect(window, out before) || DwmGetWindowAttribute(window, 9, out after, Marshal.SizeOf(typeof(Rect))) != 0)
      throw new InvalidOperationException("无法读取拖动前的自有窗口边界。");
    int x = after.Left + (int)Math.Round(xDip * scale), y = after.Top + (int)Math.Round(yDip * scale);
    int hit = Hit(window, x, y);
    if (GetAncestor(WindowFromPoint(new Point { X = x, Y = y }), 2) != window)
      throw new InvalidOperationException("自定义缩放手柄位置没有命中自有窗口。");
    Point cursor, dragStart, dragEnd;
    if (!GetCursorPos(out cursor)) throw new InvalidOperationException("无法保存当前指针位置。");
    bool down = false;
    try {
      if (!SetCursorPos(x, y)) throw new InvalidOperationException("无法把测试指针放到自定义缩放手柄。");
      System.Threading.Thread.Sleep(100);
      if (!GetCursorPos(out dragStart)) throw new InvalidOperationException("无法读取自定义拖边起点。");
      SendMouse(0x0002); down = true;
      System.Threading.Thread.Sleep(80);
      SendMouse(0x0001, 40, 0);
      System.Threading.Thread.Sleep(300);
      if (!GetCursorPos(out dragEnd)) throw new InvalidOperationException("无法读取自定义拖边终点。");
      SendMouse(0x0004); down = false;
      System.Threading.Thread.Sleep(250);
      if (!GetWindowRect(window, out after)) throw new InvalidOperationException("无法读取拖动后的自有窗口边界。");
    } finally {
      if (down) SendMouse(0x0004);
      SetCursorPos(cursor.X, cursor.Y);
    }
    int delta = (after.Right - after.Left) - (before.Right - before.Left);
    int pointerDeltaX = dragEnd.X - dragStart.X;
    bool passed = hit == 1 && pointerDeltaX >= 20 && Math.Abs(delta - pointerDeltaX) <= 3 && Math.Abs((after.Bottom - after.Top) - (before.Bottom - before.Top)) <= 5;
    return "{\"ownerPid\":" + owner + ",\"inputMethod\":\"SendInput\",\"hitTest\":" + hit + ",\"point\":{\"x\":" + x + ",\"y\":" + y + "},\"before\":{\"left\":" + before.Left + ",\"top\":" + before.Top + ",\"right\":" + before.Right + ",\"bottom\":" + before.Bottom +
      "},\"after\":{\"left\":" + after.Left + ",\"top\":" + after.Top + ",\"right\":" + after.Right + ",\"bottom\":" + after.Bottom +
      "},\"sendInputMoveDeltaX\":40,\"pointerDeltaX\":" + pointerDeltaX + ",\"widthDelta\":" + delta + ",\"widthPointerDeltaError\":" + Math.Abs(delta - pointerDeltaX) + ",\"passed\":" + (passed ? "true" : "false") + "}";
  }
}
