using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Automation;

// 仅观察固定样本的鼠标释放与拾译入口；不读取选中文字、剪贴板或窗口正文。
public static class SelectionEntryTimer {
    const int WhMouseLl = 14, WmLeftDown = 0x0201, WmLeftUp = 0x0202, WmQuit = 0x0012;
    const int TimeoutMs = 2000;
    delegate IntPtr MouseCallback(int code, IntPtr message, IntPtr data);
    delegate bool WindowCallback(IntPtr hwnd, IntPtr state);
    [StructLayout(LayoutKind.Sequential)] struct MousePoint { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct MouseEvent { public MousePoint Point; public uint Data, Flags, Time; public IntPtr Extra; }
    [StructLayout(LayoutKind.Sequential)] struct WindowRect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct NativeMessage { public IntPtr Hwnd; public uint Message; public IntPtr WParam, LParam; public uint Time; public MousePoint Point; }
    [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int id, MouseCallback callback, IntPtr module, uint thread);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);
    [DllImport("user32.dll")] static extern bool EnumWindows(WindowCallback callback, IntPtr state);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out WindowRect rect);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern int GetMessage(out NativeMessage message, IntPtr hwnd, uint min, uint max);
    [DllImport("user32.dll")] static extern bool PostThreadMessage(uint thread, uint message, IntPtr wparam, IntPtr lparam);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll")] static extern uint GetTickCount();

    static MouseCallback callback;
    static IntPtr hook;
    static readonly AutoResetEvent released = new AutoResetEvent(false);
    static readonly object sync = new object();
    static readonly JavaScriptSerializer json = new JavaScriptSerializer();
    static StreamWriter output;
    static string source, sample, candidate;
    static int appPid, count, index, downX, downY;
    static uint downTime, releaseTime, mainThread;
    static bool downFromSource, ready, stopped;

    static Dictionary<string, string> Arguments(string[] args) {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var arg in args) {
            if (!arg.StartsWith("--") || arg.IndexOf('=') < 3) throw new ArgumentException("参数须为 --名称=值。");
            int equals = arg.IndexOf('=');
            string name = arg.Substring(2, equals - 2);
            if (result.ContainsKey(name)) throw new ArgumentException("重复参数：" + name);
            result[name] = arg.Substring(equals + 1);
        }
        foreach (var required in new[] { "app-pid", "source", "sample", "candidate", "count", "out" })
            if (!result.ContainsKey(required) || String.IsNullOrWhiteSpace(result[required])) throw new ArgumentException("缺少参数：" + required);
        return result;
    }

    static bool IsSourceForeground() {
        uint pid;
        GetWindowThreadProcessId(GetForegroundWindow(), out pid);
        try { return String.Equals(Process.GetProcessById((int)pid).ProcessName, source, StringComparison.OrdinalIgnoreCase); }
        catch { return false; }
    }

    static IntPtr ObserveMouse(int code, IntPtr message, IntPtr data) {
        if (code >= 0) {
            int kind = message.ToInt32();
            if (kind == WmLeftDown || kind == WmLeftUp) {
                var point = (MouseEvent)Marshal.PtrToStructure(data, typeof(MouseEvent));
                lock (sync) {
                    if (kind == WmLeftDown) {
                        downFromSource = ready && IsSourceForeground();
                        downX = point.Point.X; downY = point.Point.Y; downTime = point.Time;
                    } else if (downFromSource) {
                        downFromSource = false;
                        int dx = point.Point.X - downX, dy = point.Point.Y - downY;
                        if (ready && dx * dx + dy * dy >= 144 && unchecked(point.Time - downTime) < 10000) {
                            ready = false; releaseTime = point.Time; released.Set();
                        }
                    }
                }
            }
        }
        return CallNextHookEx(hook, code, message, data);
    }

    static bool EntryClickable() {
        bool found = false;
        EnumWindows((hwnd, state) => {
            uint pid;
            GetWindowThreadProcessId(hwnd, out pid);
            if (pid != appPid || !IsWindowVisible(hwnd)) return true;
            WindowRect rect;
            if (!GetWindowRect(hwnd, out rect)) return true;
            int width = rect.Right - rect.Left, height = rect.Bottom - rect.Top;
            // 正式入口为 84 × 36 DIP；尺寸筛选排除主面板和悬浮球。
            if (width < 50 || width > 400 || height < 25 || height > 200) return true;
            try {
                var root = AutomationElement.FromHandle(hwnd);
                var condition = new AndCondition(
                    new PropertyCondition(AutomationElement.NameProperty, "解释"),
                    new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button));
                var button = root.FindFirst(TreeScope.Descendants, condition);
                if (button == null || !button.Current.IsEnabled || button.Current.IsOffscreen) return true;
                var bounds = button.Current.BoundingRectangle;
                if (bounds.IsEmpty || bounds.Width < 8 || bounds.Height < 8) return true;
                var center = new Point(bounds.Left + bounds.Width / 2, bounds.Top + bounds.Height / 2);
                var target = AutomationElement.FromPoint(center);
                for (int depth = 0; target != null && depth < 5; depth++) {
                    if (target.Equals(button)) { found = true; return false; }
                    target = TreeWalker.ControlViewWalker.GetParent(target);
                }
            } catch { }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    static void Write(object value) { output.WriteLine(json.Serialize(value)); output.Flush(); }

    static string HumanResult() {
        if (Console.IsInputRedirected) return "unverified";
        while (true) {
            Console.Write("请核对本次入口及拾译中的选定内容、段落和原软件选区：y=正确，n=有误，s=未核对：");
            var answer = Console.ReadLine();
            if (answer == null || String.Equals(answer.Trim(), "s", StringComparison.OrdinalIgnoreCase)) return "unverified";
            if (String.Equals(answer.Trim(), "y", StringComparison.OrdinalIgnoreCase)) return "correct";
            if (String.Equals(answer.Trim(), "n", StringComparison.OrdinalIgnoreCase)) return "incorrect";
        }
    }

    static void Measure() {
        while (!stopped && EntryClickable()) Thread.Sleep(20);
        lock (sync) ready = true;
        Console.WriteLine("入口已隐藏；请在固定样本中拖选目标。计时器不会读取选中文字。");
        while (!stopped && index < count) {
            released.WaitOne();
            if (stopped) break;
            uint start;
            lock (sync) start = releaseTime;
            int observed = -1;
            while (!stopped && unchecked(GetTickCount() - start) <= TimeoutMs) {
                if (EntryClickable()) { observed = (int)unchecked(GetTickCount() - start); break; }
                Thread.Sleep(10);
            }
            index++;
            Console.WriteLine(observed < 0 ? String.Format("第 {0} 次：超过 {1} 毫秒仍未观察到可点击入口。", index, TimeoutMs)
                : String.Format("第 {0} 次：观察耗时 {1} 毫秒；请在拾译中核对文字和段落。", index, observed));
            string humanResult = observed < 0 ? "timeout" : HumanResult();
            Write(new { type = "attempt", number = index, result = observed < 0 ? "timeout" : "entry-observed",
                observedMs = observed < 0 ? (int?)null : observed, within500 = observed >= 0 && observed <= 500,
                humanResult = humanResult, observedAt = DateTimeOffset.Now.ToString("o") });
            if (index == count) break;
            while (!stopped && EntryClickable()) Thread.Sleep(20);
            lock (sync) ready = true;
            Console.WriteLine("入口已隐藏；可进行下一次拖选。");
        }
        PostThreadMessage(mainThread, WmQuit, IntPtr.Zero, IntPtr.Zero);
    }

    public static int Main(string[] args) {
        try {
            var options = Arguments(args);
            if (!Int32.TryParse(options["app-pid"], out appPid) || appPid <= 0 ||
                !Int32.TryParse(options["count"], out count) || count < 1 || count > 100)
                throw new ArgumentException("app-pid 或 count 无效；count 须为 1–100。");
            Process.GetProcessById(appPid);
            source = Path.GetFileNameWithoutExtension(options["source"]);
            sample = options["sample"]; candidate = options["candidate"];
            output = new StreamWriter(new FileStream(Path.GetFullPath(options["out"]), FileMode.CreateNew, FileAccess.Write), new UTF8Encoding(false));
            Write(new { type = "run", candidateId = candidate, appPid = appPid, sourceProcess = source,
                sample = sample, requestedCount = count, targetMs = 500, timeoutMs = TimeoutMs,
                dragThresholdPixels = 12, startedAt = DateTimeOffset.Now.ToString("o"), osVersion = Environment.OSVersion.VersionString });
            mainThread = GetCurrentThreadId();
            callback = ObserveMouse;
            hook = SetWindowsHookEx(WhMouseLl, callback, IntPtr.Zero, 0);
            if (hook == IntPtr.Zero) throw new InvalidOperationException("无法安装鼠标释放计时钩子。");
            var worker = new Thread(Measure) { IsBackground = true };
            worker.Start();
            NativeMessage message;
            while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0) { }
            stopped = true; released.Set(); worker.Join(3000);
            Write(new { type = "end", completedCount = index, finishedAt = DateTimeOffset.Now.ToString("o") });
            return index == count ? 0 : 1;
        } catch (Exception error) {
            Console.Error.WriteLine("入口计时器无法运行：" + error.Message);
            return 1;
        } finally {
            stopped = true; released.Set();
            if (hook != IntPtr.Zero) UnhookWindowsHookEx(hook);
            if (output != null) output.Dispose();
        }
    }
}
