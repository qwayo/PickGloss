using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Automation.Text;

// 每次读取放在可终止的独立 MTA 进程；永不调用 Select、模拟按键或剪贴板。
public static class ContextProbe {
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    static string Normal(string text) { return (text ?? "").Replace("\r\n", "\n").Trim(); }

    [MTAThread]
    public static void Main() {
        Console.InputEncoding = new UTF8Encoding(false); Console.OutputEncoding = new UTF8Encoding(false);
        var json = new JavaScriptSerializer();
        try {
            var input = json.Deserialize<Dictionary<string, object>>(Console.ReadLine() ?? "{}");
            var expected = Normal(Convert.ToString(input["text"]));
            var hwnd = GetForegroundWindow(); uint pid; GetWindowThreadProcessId(hwnd, out pid);
            var excluded = Convert.ToString(input["excludePids"]).Split(',');
            if (Array.IndexOf(excluded, pid.ToString()) >= 0) { Console.WriteLine("{\"valid\":false}"); return; }
            var starts = new List<AutomationElement>();
            try { starts.Add(AutomationElement.FocusedElement); } catch { }
            try { starts.Add(AutomationElement.FromPoint(new Point(Convert.ToDouble(input["x"]), Convert.ToDouble(input["y"])))); } catch { }
            foreach (var start in starts) {
                var element = start;
                for (int depth = 0; depth < 9 && element != null; depth++) {
                    try {
                        if (element.Current.ProcessId != pid || element.Current.IsPassword) break;
                        object raw;
                        if (element.TryGetCurrentPattern(TextPattern.Pattern, out raw)) {
                            var pattern = (TextPattern)raw;
                            var selections = pattern.GetSelection();
                            if (selections != null && selections.Length == 1) {
                                var selected = selections[0]; var text = Normal(selected.GetText(12001));
                                if (text.Length > 0 && text.Length <= 12000 && text == expected) {
                                    string context = "", reason = "当前应用未提供可靠的所在段落。";
                                    try {
                                        var range = selected.Clone(); range.ExpandToEnclosingUnit(TextUnit.Paragraph);
                                        var paragraph = Normal(range.GetText(6001));
                                        bool contains = range.CompareEndpoints(TextPatternRangeEndpoint.Start, selected, TextPatternRangeEndpoint.Start) <= 0 && range.CompareEndpoints(TextPatternRangeEndpoint.End, selected, TextPatternRangeEndpoint.End) >= 0;
                                        bool wholeDocument = range.Compare(pattern.DocumentRange);
                                        if (contains && !wholeDocument && paragraph.Length <= 6000 && paragraph.Length > 0 && paragraph.Split('\n').Length <= 3) { context = paragraph; reason = ""; }
                                        else if (paragraph.Length > 6000) reason = "所在段落超过 6000 个字符，请手动精简上下文。";
                                        else if (!contains) reason = "选区跨越段落，请手动补充上下文。";
                                    } catch { }
                                    var title = new StringBuilder(512); GetWindowText(hwnd, title, title.Capacity);
                                    string app = ""; try { app = Process.GetProcessById((int)pid).ProcessName; } catch { }
                                    Console.WriteLine(json.Serialize(new { valid=true, text=text, context=context, contextOrigin=context.Length>0?"UIA 所在段落":"", reason=reason, app=app, title=title.ToString() })); return;
                                }
                            }
                        }
                        element = TreeWalker.ControlViewWalker.GetParent(element);
                    } catch { break; }
                }
            }
            Console.WriteLine("{\"valid\":false}");
        } catch { Console.WriteLine("{\"valid\":false}"); }
    }
}
