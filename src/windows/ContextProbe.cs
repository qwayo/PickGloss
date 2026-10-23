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
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(NativePoint point);
    [StructLayout(LayoutKind.Sequential)] struct NativePoint { public int X,Y; public NativePoint(double x,double y) { X=(int)Math.Round(x);Y=(int)Math.Round(y); } }
    static string Normal(string text) { return (text ?? "").Replace("\r\n", "\n").Trim(); }

    static bool SameOwner(IntPtr hwnd, AutomationElement owner) {
        return GetForegroundWindow() == hwnd && !owner.Current.IsPassword && AutomationElement.FocusedElement.Equals(owner);
    }
    static bool AtOwner(AutomationElement owner, double x, double y) {
        if(!owner.Current.BoundingRectangle.Contains(new Point(x,y))) return false;
        // 同一传统控件的焦点代理与命中测试代理可能属于不同 UIA 树；有 HWND 时以物理窗口归属核对，不能仅凭矩形放行。
        var handle=new IntPtr(owner.Current.NativeWindowHandle);
        if(handle!=IntPtr.Zero) {
            uint pid;GetWindowThreadProcessId(handle,out pid);
            return pid==owner.Current.ProcessId && WindowFromPoint(new NativePoint(x,y))==handle;
        }
        return AutomationElement.FromPoint(new Point(x,y)).Equals(owner);
    }
    static bool SameSelection(AutomationElement owner, TextPatternRange selected) {
        object raw;
        if (!owner.TryGetCurrentPattern(TextPattern.Pattern,out raw)) return false;
        var ranges=((TextPattern)raw).GetSelection();
        return ranges!=null && ranges.Length==1 && ranges[0].Compare(selected);
    }
    // 手势前后保留同一个 UIA 范围，仅用明确改变的真实选区补齐首轮采集，不读取 Value 或全文猜测选区。
    static Dictionary<string,object> ReadGesture(Dictionary<string,object> input, JavaScriptSerializer json, out AutomationElement owner, out TextPatternRange selected) {
        var hwnd=GetForegroundWindow(); uint pid; GetWindowThreadProcessId(hwnd,out pid);
        if(Array.IndexOf(Convert.ToString(input["excludePids"]).Split(','),pid.ToString())>=0) throw new InvalidOperationException();
        // 将同一焦点控件的元数据合并获取，尽早取得基线；后续仍用实时焦点与物理窗口复核。
        var cache=new CacheRequest();
        foreach(var property in new[]{AutomationElement.ProcessIdProperty,AutomationElement.ControlTypeProperty,AutomationElement.IsPasswordProperty})cache.Add(property);
        cache.Add(TextPattern.Pattern);
        using(cache.Activate())owner=AutomationElement.FocusedElement;
        double x=Convert.ToDouble(input["x"]),y=Convert.ToDouble(input["y"]);
        var type=owner.Cached.ControlType;
        if(owner.Cached.ProcessId!=pid || owner.Cached.IsPassword || (type!=ControlType.Edit && type!=ControlType.Document)) throw new InvalidOperationException();
        object raw;
        if(!owner.TryGetCachedPattern(TextPattern.Pattern,out raw)) throw new InvalidOperationException();
        var pattern=(TextPattern)raw; var before=pattern.GetSelection();
        if(before==null || before.Length!=1) throw new InvalidOperationException();
        var baseline=before[0].Clone(); var clock=Stopwatch.StartNew();
        // 该帧只表示基线已取得；最终归属验证失败仍会拒绝，不把验证耗时当作必须按住的时间。
        Console.WriteLine("{\"ready\":true}"); Console.Out.Flush();
        if(!SameOwner(hwnd,owner) || !AtOwner(owner,x,y)) throw new InvalidOperationException();
        var end=json.Deserialize<Dictionary<string,object>>(Console.ReadLine()??"{}");
        if(!end.ContainsKey("mode") || Convert.ToString(end["mode"])!="gesture-end" || clock.ElapsedMilliseconds>8000 || !SameOwner(hwnd,owner)) throw new InvalidOperationException();
        double endX=Convert.ToDouble(end["x"]),endY=Convert.ToDouble(end["y"]);
        if(Math.Sqrt((endX-x)*(endX-x)+(endY-y)*(endY-y))<8 || !AtOwner(owner,x,y) || !AtOwner(owner,endX,endY)) throw new InvalidOperationException();
        var after=pattern.GetSelection();
        if(after==null || after.Length!=1 || after[0].Compare(baseline)) throw new InvalidOperationException();
        selected=after[0].Clone(); var text=selected.GetText(12003);
        if(Normal(text).Length==0) throw new InvalidOperationException();
        bool near=false;
        foreach(var rect in selected.GetBoundingRectangles()) { if(rect.Width<=0 || rect.Height<=0) continue; var margin=rect; margin.Inflate(16,16); if(margin.Contains(new Point(endX,endY))) near=true; }
        if(!near || !SameOwner(hwnd,owner) || !SameSelection(owner,selected)) throw new InvalidOperationException();
        input["x"]=endX; input["y"]=endY; input["text"]=text;
        input["captureTooLong"]=text.Length>=12003 || Normal(text).Length>12000;
        return input;
    }

    [MTAThread]
    public static void Main(string[] args) {
        Console.InputEncoding = new UTF8Encoding(false); Console.OutputEncoding = new UTF8Encoding(false);
        // 鼠标 hook 使用物理像素；只调整本助手线程，避免高缩放屏幕上的原生命中测试被坐标虚拟化。
        try { SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch(EntryPointNotFoundException) { }
        var json = new JavaScriptSerializer();
        try {
            if(Array.IndexOf(args,"--standby")>=0) {
                // 预热运行时及范围接口，不读取正文或控件值，也不跨手势保留选区。
                json.Deserialize<Dictionary<string,object>>("{\"mode\":\"gesture\",\"x\":0,\"y\":0,\"excludePids\":\"\"}");
                var root=AutomationElement.RootElement; var rootType=root.Current.ControlType;
                try {
                    var warmOwner=AutomationElement.FocusedElement;object warmRaw;
                    if(!warmOwner.Current.IsPassword && warmOwner.TryGetCurrentPattern(TextPattern.Pattern,out warmRaw)) {
                        var warmRanges=((TextPattern)warmRaw).GetSelection();
                        if(warmRanges!=null && warmRanges.Length==1)warmRanges[0].Clone();
                    }
                } catch { }
                Console.WriteLine("{\"standby\":true}"); Console.Out.Flush();
            }
            var input = json.Deserialize<Dictionary<string, object>>(Console.ReadLine() ?? "{}");
            AutomationElement gestureOwner=null; TextPatternRange gestureSelection=null;
            if(input.ContainsKey("mode") && Convert.ToString(input["mode"])=="gesture") input=ReadGesture(input,json,out gestureOwner,out gestureSelection);
            var expected = Normal(Convert.ToString(input["text"]));
            var hwnd = GetForegroundWindow(); uint pid; GetWindowThreadProcessId(hwnd, out pid);
            var excluded = Convert.ToString(input["excludePids"]).Split(',');
            if (Array.IndexOf(excluded, pid.ToString()) >= 0) { Console.WriteLine("{\"valid\":false}"); return; }
            if(gestureOwner!=null && Convert.ToBoolean(input["captureTooLong"])) {
                if(!SameOwner(hwnd,gestureOwner) || !SameSelection(gestureOwner,gestureSelection)) throw new InvalidOperationException();
                Console.WriteLine("{\"valid\":true,\"tooLong\":true}"); return;
            }
            var starts = new List<AutomationElement>();
            if(gestureOwner!=null) starts.Add(gestureOwner);
            else {
                try { starts.Add(AutomationElement.FocusedElement); } catch { }
                try { starts.Add(AutomationElement.FromPoint(new Point(Convert.ToDouble(input["x"]), Convert.ToDouble(input["y"])))); } catch { }
            }
            foreach (var start in starts) {
                var element = start;
                for (int depth = 0; depth < (gestureOwner==null?9:1) && element != null; depth++) {
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
                                        bool wholeEdit = false, verifiedEditSelection = false, unverifiedEditScope = false, editScopeUnavailable = false;
                                        AutomationElement editOwner = null;
                                        try {
                                            // Chromium 的段落范围可能越出输入控件；用 UIA 的控件范围收紧边界，不能到整页按选中文字搜索。
                                            var owner = element.Current.ControlType == ControlType.Edit ? element : selected.GetEnclosingElement();
                                            if (owner.Current.ControlType == ControlType.Edit && !owner.Current.IsPassword && owner.Current.ProcessId == pid) {
                                                editOwner = owner; unverifiedEditScope = true; editScopeUnavailable = true;
                                                var scope = pattern.RangeFromChild(owner);
                                                editScopeUnavailable = false;
                                                bool scopeContains = scope.CompareEndpoints(TextPatternRangeEndpoint.Start, selected, TextPatternRangeEndpoint.Start) <= 0 && scope.CompareEndpoints(TextPatternRangeEndpoint.End, selected, TextPatternRangeEndpoint.End) >= 0;
                                                if (scopeContains) {
                                                    var bounded = range.Clone();
                                                    if (bounded.CompareEndpoints(TextPatternRangeEndpoint.Start, scope, TextPatternRangeEndpoint.Start) < 0) bounded.MoveEndpointByRange(TextPatternRangeEndpoint.Start, scope, TextPatternRangeEndpoint.Start);
                                                    if (bounded.CompareEndpoints(TextPatternRangeEndpoint.End, scope, TextPatternRangeEndpoint.End) > 0) bounded.MoveEndpointByRange(TextPatternRangeEndpoint.End, scope, TextPatternRangeEndpoint.End);
                                                    wholeEdit = bounded.Compare(scope); range = bounded; unverifiedEditScope = false;
                                                } else if (selected.GetEnclosingElement().Equals(owner) && scope.GetEnclosingElement().Equals(owner)) {
                                                    // 有些提供方在选中末尾表情时会给出不一致的端点；两个范围仍明确归属于同一个编辑控件。
                                                    // 仅接纳完整、有界的单段控件内容，并核对其包含本次选区；不向控件外扩展端点。
                                                    var scopeRaw = scope.GetText(6003); var scopeText = Normal(scopeRaw);
                                                    if (scopeRaw.Length < 6003 && scopeText.Length > 0 && scopeText.Length <= 6000 && scopeText.IndexOfAny(new[] { '\r', '\n', '\u0085', '\u2028', '\u2029' }) < 0 && scopeText.IndexOf(text, StringComparison.Ordinal) >= 0) {
                                                        range = scope; wholeEdit = true; verifiedEditSelection = true; unverifiedEditScope = false;
                                                    }
                                                }
                                            }
                                        } catch { }
                                        // 为段落末尾的 CRLF 留出两个字符；触及读取上限时仍不能视作完整段落。
                                        var paragraphText = range.GetText(6003);
                                        var paragraph = Normal(paragraphText);
                                        bool contains = verifiedEditSelection || (range.CompareEndpoints(TextPatternRangeEndpoint.Start, selected, TextPatternRangeEndpoint.Start) <= 0 && range.CompareEndpoints(TextPatternRangeEndpoint.End, selected, TextPatternRangeEndpoint.End) >= 0);
                                        var document = pattern.DocumentRange;
                                        bool wholeDocument = range.Compare(document);
                                        // 已否定的控件范围不能回退放行原范围；接口不支持时，仍可凭同一 Edit 的段落归属证明读取边界。
                                        bool trustedEditRange = !unverifiedEditScope || (editScopeUnavailable && editOwner != null && selected.GetEnclosingElement().Equals(editOwner) && (wholeDocument ? document : range).GetEnclosingElement().Equals(editOwner));
                                        // 单段文档的所在段落本来就等于全文；只有无内部段落分隔符时才接纳这一范围。
                                        // 多段控件若不支持 Paragraph 而退回全文，仍不能把整篇材料当作上下文。
                                        bool hasParagraphBreak = paragraph.IndexOfAny(new[] { '\r', '\n', '\u0085', '\u2028', '\u2029' }) >= 0;
                                        bool crossesParagraphs = text.IndexOfAny(new[] { '\r', '\n', '\u0085', '\u2028', '\u2029' }) >= 0;
                                        // 任何范围达到读取上限都拒绝，避免截断后的尾部空白被 Trim 掩盖。
                                        bool withinLimit = paragraph.Length <= 6000 && paragraphText.Length < 6003;
                                        if (trustedEditRange && contains && !crossesParagraphs && (!(wholeDocument || wholeEdit) || !hasParagraphBreak) && withinLimit && paragraph.Length > 0 && paragraph.Split('\n').Length <= 3) { context = paragraph; reason = ""; }
                                        else if (!withinLimit) reason = "所在段落超过 6000 个字符，请手动精简上下文。";
                                        else if (!trustedEditRange) reason = "当前应用未提供可靠的控件边界，请手动补充上下文。";
                                        else if (!contains || crossesParagraphs) reason = "选区跨越段落，请手动补充上下文。";
                                        else if ((wholeDocument || wholeEdit) && hasParagraphBreak) reason = "当前应用未提供可靠的段落边界，请手动补充上下文。";
                                    } catch { }
                                    var title = new StringBuilder(512); GetWindowText(hwnd, title, title.Capacity);
                                    string app = ""; try { app = Process.GetProcessById((int)pid).ProcessName; } catch { }
                                    if(gestureOwner!=null && (!SameOwner(hwnd,gestureOwner) || !SameSelection(gestureOwner,gestureSelection))) throw new InvalidOperationException();
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
