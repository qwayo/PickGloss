param([long]$WindowHandle, [uint32]$OwnerPid, [int]$X, [int]$Y)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OrbHitTest {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; public Point(int x, int y) { X=x; Y=y; } }
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  public static string Inspect(long handle, uint expectedPid, int x, int y) {
    SetProcessDpiAwarenessContext(new IntPtr(-4));
    IntPtr target = new IntPtr(handle);
    uint targetPid; GetWindowThreadProcessId(target, out targetPid);
    if (targetPid == 0 || targetPid != expectedPid) throw new InvalidOperationException("WINDOW_OWNER_MISMATCH: \u60ac\u6d6e\u7403\u7a97\u53e3\u5f52\u5c5e\u4e0e\u63a2\u9488\u8fdb\u7a0b\u4e0d\u4e00\u81f4\u3002");
    IntPtr hit = WindowFromPoint(new Point(x, y));
    IntPtr root = GetAncestor(hit, 2);
    uint hitPid; GetWindowThreadProcessId(root, out hitPid);
    bool passed = root == target;
    if (!passed) throw new InvalidOperationException("BAR_POINT_OCCLUDED_SCREENSHOT_ABORTED: \u60ac\u6d6e\u7403\u6761\u4e2d\u5fc3\u88ab\u5176\u4ed6\u7a97\u53e3\u906e\u6321\uff0c\u5df2\u5728\u622a\u56fe\u524d\u4e2d\u6b62\u3002");
    return "{\"ownerPid\":" + targetPid + ",\"hitPid\":" + hitPid + ",\"point\":{\"x\":" + x + ",\"y\":" + y + "},\"passed\":true}";
  }
}
'@
[OrbHitTest]::Inspect($WindowHandle, $OwnerPid, $X, $Y)
