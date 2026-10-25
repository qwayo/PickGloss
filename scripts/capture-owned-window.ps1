param([long]$PanelHandle, [long]$BackgroundHandle, [uint32]$OwnerPid, [string]$OutputPath)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
# 截图前后逐像素核对窗口归属；被遮挡则不保存，防止采入其他应用。
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public static class OwnedWindowCapture {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; public Point(int x, int y) { X=x; Y=y; } }
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr window, ref Point point);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("dwmapi.dll")] static extern int DwmFlush();
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr window, uint attribute, out Rect rect, int size);
  static void Check(Rect rect, IntPtr panel, IntPtr background) {
    if (!IsWindowVisible(panel) || !IsWindowVisible(background)) throw new Exception("测试窗口不可见，实屏检查未覆盖");
    Rect current;
    if(DwmGetWindowAttribute(panel,9,out current,Marshal.SizeOf(typeof(Rect)))!=0 || current.Left!=rect.Left || current.Top!=rect.Top || current.Right!=rect.Right || current.Bottom!=rect.Bottom) throw new Exception("测试窗口在捕获期间移动，未保存截图");
    if(GetAncestor(WindowFromPoint(new Point((rect.Left+rect.Right)/2,(rect.Top+rect.Bottom)/2)),2)!=panel) throw new Exception("测试窗口未位于背景之上，未保存截图");
    for (int y=rect.Top; y<rect.Bottom; y++) for (int x=rect.Left; x<rect.Right; x++) {
      IntPtr owner=GetAncestor(WindowFromPoint(new Point(x,y)),2);
      if(owner!=panel && owner!=background) throw new Exception("测试矩形被其他窗口遮挡，未保存截图");
    }
  }
  public static string Capture(long panelValue, long backgroundValue, uint ownerPid, string output) {
    SetProcessDpiAwarenessContext(new IntPtr(-4));
    IntPtr panel=new IntPtr(panelValue), background=new IntPtr(backgroundValue);
    uint panelPid, backgroundPid;
    GetWindowThreadProcessId(panel,out panelPid); GetWindowThreadProcessId(background,out backgroundPid);
    if(panelPid==0 || panelPid!=backgroundPid || panelPid!=ownerPid) throw new Exception("测试窗口归属不一致");
    Rect rect; if(DwmGetWindowAttribute(panel,9,out rect,Marshal.SizeOf(typeof(Rect)))!=0) throw new Exception("无法读取 DWM 可见边界，实屏未覆盖");
    int width=rect.Right-rect.Left, height=rect.Bottom-rect.Top;
    if(width<=0 || height<=0 || width>8192 || height>8192) throw new Exception("测试矩形无效");
    DwmFlush(); Check(rect,panel,background);
    using(Bitmap bitmap=new Bitmap(width,height)) {
      using(Graphics graphics=Graphics.FromImage(bitmap)) graphics.CopyFromScreen(rect.Left,rect.Top,0,0,new Size(width,height));
      Check(rect,panel,background);
      bitmap.Save(output,ImageFormat.Png);
    }
    Rect client; Point origin=new Point(0,0);
    if(!GetClientRect(panel,out client) || !ClientToScreen(panel,ref origin)) throw new Exception("无法读取客户区边界");
    return String.Format("{{\"x\":{0},\"y\":{1},\"width\":{2},\"height\":{3},\"client\":{{\"left\":{4},\"top\":{5},\"width\":{6},\"height\":{7}}}}}",rect.Left,rect.Top,width,height,origin.X-rect.Left,origin.Y-rect.Top,client.Right,client.Bottom);
  }
}
'@
[OwnedWindowCapture]::Capture($PanelHandle, $BackgroundHandle, $OwnerPid, $OutputPath)
