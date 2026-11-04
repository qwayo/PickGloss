using System;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

// 自有网页替身与 Shell 身份探针；只报告句柄、进程号、类名和边界，不采集屏幕内容。
internal static class ShellOverlayReturnFixture {
  [StructLayout(LayoutKind.Sequential)] private struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] private static extern IntPtr GetShellWindow();
  [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder name, int maximum);
  [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
  [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr window, uint attribute, out int value, int size);
  [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr context);
  private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
  private static Form page;
  private static IntPtr shell;

  private static object Window(IntPtr handle) {
    uint pid; Rect bounds; var name = new StringBuilder(64);
    if (handle == IntPtr.Zero || GetWindowThreadProcessId(handle, out pid) == 0 || !GetWindowRect(handle, out bounds)) return null;
    GetClassName(handle, name, name.Capacity);
    int cloaked = 0; bool cloakKnown = DwmGetWindowAttribute(handle, 14, out cloaked, 4) == 0;
    return new { handle = handle.ToInt64().ToString(), pid = pid, className = name.ToString(),
      bounds = new { x = bounds.Left, y = bounds.Top, width = bounds.Right - bounds.Left, height = bounds.Bottom - bounds.Top },
      visible = IsWindowVisible(handle), iconic = IsIconic(handle), dwmCloaked = cloakKnown ? (bool?)(cloaked != 0) : null };
  }
  private static void Write(object value) { Console.Out.WriteLine(Json.Serialize(value)); Console.Out.Flush(); }
  private static void Focus(string target, IntPtr handle) {
    bool accepted = SetForegroundWindow(handle);
    IntPtr foreground = GetForegroundWindow();
    Write(new { type = "focus", target = target, accepted = accepted, targetForeground = foreground == handle,
      foreground = Window(foreground), shell = Window(shell), page = Window(page.Handle) });
  }
  private static void Inspect(string value) {
    long handle;
    if (!Int64.TryParse(value, out handle)) { Write(new { type = "inspect", window = (object)null }); return; }
    Write(new { type = "inspect", window = Window(new IntPtr(handle)) });
  }
  private static void Run(string command) {
    if (command == "focus-shell") Focus("shell", shell);
    else if (command == "focus-page") { page.Show(); page.Activate(); Focus("page", page.Handle); }
    else if (command == "probe") Write(new { type = "probe", foreground = Window(GetForegroundWindow()), shell = Window(shell), page = Window(page.Handle) });
    else if (command.StartsWith("inspect ", StringComparison.Ordinal)) Inspect(command.Substring(8));
    else if (command == "quit") { page.Dispose(); Application.ExitThread(); }
  }
  [STAThread] private static int Main() {
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch (EntryPointNotFoundException) { }
    shell = GetShellWindow();
    if (shell == IntPtr.Zero) return 2;
    page = new Form { Text = "虚构网页前台往返验证", StartPosition = FormStartPosition.CenterScreen,
      Size = new Size(480, 220), BackColor = Color.FromArgb(238, 242, 247), ShowInTaskbar = true };
    page.Controls.Add(new Label { Text = "固定验证页面\n仅用于覆盖译文返回测试", AutoSize = true,
      Location = new Point(32, 34), ForeColor = Color.FromArgb(35, 50, 70), Font = new Font("Microsoft YaHei UI", 17) });
    page.Shown += delegate {
      Write(new { type = "ready", pid = Process.GetCurrentProcess().Id, shell = Window(shell), page = Window(page.Handle), foreground = Window(GetForegroundWindow()) });
      var input = new Thread(delegate() {
        try { string line; while ((line = Console.ReadLine()) != null) { string next = line; page.BeginInvoke((Action)(() => Run(next))); } }
        finally { try { page.BeginInvoke((Action)(() => Run("quit"))); } catch { } }
      });
      input.IsBackground = true; input.Start();
    };
    Application.Run(page); return 0;
  }
}
