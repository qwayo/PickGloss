using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
using System.Text;

// 仅在两个端点都命中目标自建窗口时，向虚构材料发送一次真实鼠标拖选。
public static class MixedSelectionInput {
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct NativePoint { public int X, Y; public NativePoint(int x,int y) { X=x;Y=y; } }
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(NativePoint point);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] static extern bool IsChild(IntPtr parent, IntPtr child);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr hwnd);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint command);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder name, int max);
    const uint LeftDown = 0x0002, LeftUp = 0x0004;

    static void Move(int x, int y) {
        if (!SetCursorPos(x, y)) throw new InvalidOperationException("无法移动测试指针。");
    }
    static bool BelongsTo(IntPtr target, int x, int y) {
        var hit=WindowFromPoint(new NativePoint(x,y));
        uint targetPid,hitPid; GetWindowThreadProcessId(target,out targetPid); GetWindowThreadProcessId(hit,out hitPid);
        if (hit==target || IsChild(target,hit) || GetAncestor(hit,2)==target || (targetPid!=0 && hitPid==targetPid)) return true;
        Rect targetRect, hitRect; if(!GetWindowRect(target,out targetRect) || !GetWindowRect(hit,out hitRect)) return false;
        var name=new StringBuilder(128); GetClassName(hit,name,name.Capacity);
        string process=""; try { process=Process.GetProcessById((int)hitPid).ProcessName; } catch { }
        bool inside=hitRect.Left>=targetRect.Left && hitRect.Top>=targetRect.Top && hitRect.Right<=targetRect.Right && hitRect.Bottom<=targetRect.Bottom;
        return inside && name.ToString().StartsWith("Chrome_WidgetWin",StringComparison.Ordinal) && process.Equals("electron",StringComparison.OrdinalIgnoreCase);
    }

    public static int Main(string[] args) {
        try { SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch (EntryPointNotFoundException) { }
        if (args.Length == 6 && args[0] == "--validate") {
            var target = new IntPtr(Convert.ToInt64(args[1], 16)); Rect rect;
            if (!GetWindowRect(target, out rect)) return 4;
            int sx=Int32.Parse(args[2]), sy=Int32.Parse(args[3]), ex=Int32.Parse(args[4]), ey=Int32.Parse(args[5]);
            var startHit=WindowFromPoint(new NativePoint(sx,sy)); var endHit=WindowFromPoint(new NativePoint(ex,ey));
            uint targetPid,startPid,endPid; GetWindowThreadProcessId(target,out targetPid); GetWindowThreadProcessId(startHit,out startPid); GetWindowThreadProcessId(endHit,out endPid);
            Rect startRect,endRect; GetWindowRect(startHit,out startRect); GetWindowRect(endHit,out endRect);
            var startClass=new StringBuilder(128); GetClassName(startHit,startClass,startClass.Capacity); var endClass=new StringBuilder(128); GetClassName(endHit,endClass,endClass.Capacity);
            string startProcess="",endProcess=""; try { startProcess=Process.GetProcessById((int)startPid).ProcessName; } catch { } try { endProcess=Process.GetProcessById((int)endPid).ProcessName; } catch { }
            Console.WriteLine("window="+rect.Left+","+rect.Top+","+rect.Right+","+rect.Bottom+" start="+sx+","+sy+" end="+ex+","+ey+" target="+target.ToInt64().ToString("X")+" startHit="+startHit.ToInt64().ToString("X")+"/root="+GetAncestor(startHit,2).ToInt64().ToString("X")+"/ownerRoot="+GetAncestor(startHit,3).ToInt64().ToString("X")+"/parent="+GetParent(startHit).ToInt64().ToString("X")+"/owner="+GetWindow(startHit,4).ToInt64().ToString("X")+"/pid"+startPid+"/"+startProcess+"/class="+startClass+"/rect="+startRect.Left+","+startRect.Top+","+startRect.Right+","+startRect.Bottom+" endHit="+endHit.ToInt64().ToString("X")+"/root="+GetAncestor(endHit,2).ToInt64().ToString("X")+"/ownerRoot="+GetAncestor(endHit,3).ToInt64().ToString("X")+"/parent="+GetParent(endHit).ToInt64().ToString("X")+"/owner="+GetWindow(endHit,4).ToInt64().ToString("X")+"/pid"+endPid+"/"+endProcess+"/class="+endClass+"/rect="+endRect.Left+","+endRect.Top+","+endRect.Right+","+endRect.Bottom+" targetPid="+targetPid);
            bool inside = sx>=rect.Left && sx<rect.Right && sy>=rect.Top && sy<rect.Bottom && ex>=rect.Left && ex<rect.Right && ey>=rect.Top && ey<rect.Bottom;
            bool owned = BelongsTo(target,sx,sy) && BelongsTo(target,ex,ey);
            return inside && owned ? 0 : 5;
        }
        if (args.Length < 5 || args.Length > 7) return 2;
        var expectedWindow = new IntPtr(Convert.ToInt64(args[0], 16));
        int startX = Int32.Parse(args[1]), startY = Int32.Parse(args[2]);
        int endX = Int32.Parse(args[3]), endY = Int32.Parse(args[4]);
        int holdAfterDown = args.Length >= 6 ? Int32.Parse(args[5]) : 0;
        int dragStepDelay = args.Length >= 7 ? Int32.Parse(args[6]) : 18;
        if(holdAfterDown<0 || holdAfterDown>5000 || dragStepDelay<0 || dragStepDelay>100) return 2;
        Rect targetRect;
        if (!GetWindowRect(expectedWindow, out targetRect) || startX<targetRect.Left || startX>=targetRect.Right || startY<targetRect.Top || startY>=targetRect.Bottom || endX<targetRect.Left || endX>=targetRect.Right || endY<targetRect.Top || endY>=targetRect.Bottom || !BelongsTo(expectedWindow,startX,startY) || !BelongsTo(expectedWindow,endX,endY)) {
            Console.Error.WriteLine("Target fixture window does not own both drag endpoints; refusing input.");
            return 3;
        }
        bool pressed = false;
        try {
            Move(startX, startY); Thread.Sleep(120);
            if (!BelongsTo(expectedWindow,startX,startY)) throw new InvalidOperationException("测试窗口不再拥有起点，拒绝拖选。");
            mouse_event(LeftDown, 0, 0, 0, UIntPtr.Zero); pressed = true;
            var holdClock=Stopwatch.StartNew();
            if(holdAfterDown>0) Thread.Sleep(holdAfterDown);
            Console.WriteLine("{\"inputHoldRequestedMs\":"+holdAfterDown+",\"inputHoldElapsedMs\":"+holdClock.ElapsedMilliseconds+"}");
            const int steps = 24;
            for (int i = 1; i <= steps; i++) {
                Move(startX + (endX - startX) * i / steps, startY + (endY - startY) * i / steps);
                if(dragStepDelay>0) Thread.Sleep(dragStepDelay);
            }
            Thread.Sleep(120);
            if (!BelongsTo(expectedWindow,endX,endY)) throw new InvalidOperationException("测试窗口不再拥有终点，拒绝拖选。");
            return 0;
        } finally {
            if (pressed) { mouse_event(LeftUp, 0, 0, 0, UIntPtr.Zero); Thread.Sleep(120); }
        }
    }
}
