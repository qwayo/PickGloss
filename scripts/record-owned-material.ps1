param([long]$PanelHandle, [uint32]$OwnerPid, [string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
# 仅捕获自有解释窗内部 48×4 物理像素；每帧前后逐像素验证归属，拒绝其他窗口画面。
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
public static class OwnedMaterialRecorder {
  [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] struct Point { public int X, Y; public Point(int x,int y){X=x;Y=y;} }
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr window,out Rect rect);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr window,ref Point point);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window,uint flag);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
  [DllImport("dwmapi.dll")] static extern int DwmFlush();
  static void Check(IntPtr panel,uint owner,int x,int y) {
    uint pid;GetWindowThreadProcessId(panel,out pid);
    if(pid!=owner||pid==0)throw new Exception("自有解释窗归属不符，终止记录");
    for(int row=0;row<4;row++)for(int col=0;col<48;col++)
      if(GetAncestor(WindowFromPoint(new Point(x+col,y+row)),2)!=panel)throw new Exception("采样区被其他应用遮挡，终止记录");
  }
  public static void Record(long handle,uint owner,string directory) {
    SetProcessDpiAwarenessContext(new IntPtr(-4));IntPtr panel=new IntPtr(handle);
    Rect rect;Point origin=new Point(0,0);
    if(!GetClientRect(panel,out rect)||!ClientToScreen(panel,ref origin))throw new Exception("无法读取自有客户区");
    int x=origin.X+rect.Right-90,y=origin.Y+rect.Bottom-260;
    Directory.CreateDirectory(directory);Stopwatch timer=Stopwatch.StartNew();System.Collections.Generic.List<Bitmap> frames=new System.Collections.Generic.List<Bitmap>();
    for(int frame=0;frame<110;frame++) {
      DwmFlush();Check(panel,owner,x,y);
      { Bitmap bitmap=new Bitmap(48,4);frames.Add(bitmap);
        using(Graphics graphics=Graphics.FromImage(bitmap))graphics.CopyFromScreen(x,y,0,0,new Size(48,4));
        Check(panel,owner,x,y);double sum=0,min=255,max=0;
        for(int col=0;col<48;col++){double value=0;for(int row=0;row<4;row++){Color pixel=bitmap.GetPixel(col,row);value+=(pixel.R+pixel.G+pixel.B)/3.0;}value/=4;sum+=value;min=Math.Min(min,value);max=Math.Max(max,value);}

        Console.WriteLine("{\"frame\":"+frame+",\"time\":"+DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()+",\"ms\":"+timer.Elapsed.TotalMilliseconds.ToString("F3",System.Globalization.CultureInfo.InvariantCulture)+",\"mean\":"+(sum/48).ToString("F3",System.Globalization.CultureInfo.InvariantCulture)+",\"columnRange\":"+(max-min).ToString("F3",System.Globalization.CultureInfo.InvariantCulture)+"}");Console.Out.Flush();
      }
    }
    for(int frame=0;frame<frames.Count;frame++){frames[frame].Save(Path.Combine(directory,frame.ToString("D3")+".png"),ImageFormat.Png);frames[frame].Dispose();}
  }
}
'@
[OwnedMaterialRecorder]::Record($PanelHandle, $OwnerPid, $OutputDirectory)
