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
    // 用于发布的可靠文字只移除对象标记，保留其两侧可读取的内部换行。
    static string CleanText(string text) {
        return (text??"").Replace("\r\n","\n").Replace("\uFFFC","").Trim();
    }
    // 仅用于与 selection-hook 的文本比较，按 Hook 的约定移除对象占位符及其相邻换行。
    static string MatchText(string text) {
        var source=(text??"").Replace("\r\n","\n"); var cleaned=new StringBuilder(source.Length);
        for(int i=0;i<source.Length;i++) {
            if(source[i]!='\uFFFC') { cleaned.Append(source[i]); continue; }
            if(cleaned.Length>0 && cleaned[cleaned.Length-1]=='\n') cleaned.Length--;
            if(i+1<source.Length && source[i+1]=='\n') i++;
        }
        return cleaned.ToString().Trim();
    }

    static bool SameOwner(IntPtr hwnd, AutomationElement owner) {
        return GetForegroundWindow() == hwnd && !owner.Current.IsPassword && AutomationElement.FocusedElement.Equals(owner);
    }
    static bool AtOwner(AutomationElement owner, double x, double y) {
        if(!owner.Current.BoundingRectangle.Contains(new Point(x,y))) return false;
        // 有 HWND 时以物理命中窗口归属核对；无 HWND 时要求命中节点的有界祖先链精确包含同一 owner，不能仅凭矩形放行。
        var handle=new IntPtr(owner.Current.NativeWindowHandle);
        if(handle!=IntPtr.Zero) {
            uint pid;GetWindowThreadProcessId(handle,out pid);
            return pid==owner.Current.ProcessId && WindowFromPoint(new NativePoint(x,y))==handle;
        }
        var hit=AutomationElement.FromPoint(new Point(x,y));
        return hit.Current.ProcessId==owner.Current.ProcessId && IsSelfOrDescendant(hit,owner);
    }
    static bool IsSelfOrDescendant(AutomationElement element,AutomationElement ancestor) {
        var current=element;
        for(int depth=0;depth<16 && current!=null;depth++) {
            var info=current.Current;
            if(info.ProcessId!=ancestor.Current.ProcessId || info.IsPassword) return false;
            if(current.Equals(ancestor)) return true;
            current=TreeWalker.ControlViewWalker.GetParent(current);
        }
        return false;
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
        if(Array.IndexOf(Convert.ToString(input["excludePids"]).Split(','),pid.ToString())>=0) throw new InvalidOperationException("手势目标进程被排除。");
        // 将同一焦点控件的元数据合并获取，尽早取得基线；后续仍用实时焦点与物理窗口复核。
        var cache=new CacheRequest();
        foreach(var property in new[]{AutomationElement.ProcessIdProperty,AutomationElement.ControlTypeProperty,AutomationElement.IsPasswordProperty})cache.Add(property);
        cache.Add(TextPattern.Pattern);
        using(cache.Activate())owner=AutomationElement.FocusedElement;
        double x=Convert.ToDouble(input["x"]),y=Convert.ToDouble(input["y"]);
        var type=owner.Cached.ControlType;
        if(owner.Cached.ProcessId!=pid || owner.Cached.IsPassword || (type!=ControlType.Edit && type!=ControlType.Document)) throw new InvalidOperationException("手势焦点控件不属于当前进程、是密码控件或不是可读文档/编辑框。");
        object raw;
        if(!owner.TryGetCachedPattern(TextPattern.Pattern,out raw)) throw new InvalidOperationException("手势焦点控件未提供 TextPattern。");
        var pattern=(TextPattern)raw; var before=pattern.GetSelection();
        if(before==null || before.Length!=1) throw new InvalidOperationException("手势前 UIA 选区数量为 "+(before==null?"null":before.Length.ToString())+"。");
        var baseline=before[0].Clone(); var clock=Stopwatch.StartNew();
        // 该帧只表示基线已取得；最终归属验证失败仍会拒绝，不把验证耗时当作必须按住的时间。
        Console.WriteLine("{\"ready\":true}"); Console.Out.Flush();
        bool sameOwnerAtPress=SameOwner(hwnd,owner), startBelongsToOwner=AtOwner(owner,x,y);
        if(!sameOwnerAtPress || !startBelongsToOwner) throw new InvalidOperationException("手势按下时前台窗口或起点归属不一致。");
        var end=json.Deserialize<Dictionary<string,object>>(Console.ReadLine()??"{}");
        if(!end.ContainsKey("mode") || Convert.ToString(end["mode"])!="gesture-end" || clock.ElapsedMilliseconds>8000 || !SameOwner(hwnd,owner)) throw new InvalidOperationException("手势松开帧缺失、超时或前台窗口已变化。");
        double endX=Convert.ToDouble(end["x"]),endY=Convert.ToDouble(end["y"]);
        if(Math.Sqrt((endX-x)*(endX-x)+(endY-y)*(endY-y))<8 || !AtOwner(owner,x,y) || !AtOwner(owner,endX,endY)) throw new InvalidOperationException("手势距离不足或按下/松开位置不属于同一 UIA 控件。");
        var after=pattern.GetSelection();
        if(after==null || after.Length!=1 || after[0].Compare(baseline)) throw new InvalidOperationException("手势后选区缺失、数量异常或与按下前基线相同。");
        selected=after[0].Clone(); var text=selected.GetText(12003);
        if(CleanText(text).Length==0) throw new InvalidOperationException("手势后 UIA 选区没有文字。");
        bool near=false; var selectionRects=selected.GetBoundingRectangles();
        foreach(var rect in selectionRects) { if(rect.Width<=0 || rect.Height<=0) continue; var margin=rect; margin.Inflate(16,16); if(margin.Contains(new Point(endX,endY))) near=true; }
        bool sameOwnerAtEnd=SameOwner(hwnd,owner), startStillBelongs=AtOwner(owner,x,y), endBelongs=AtOwner(owner,endX,endY), sameSelection=SameSelection(owner,selected);
        if(!near || !sameOwnerAtEnd || !startStillBelongs || !endBelongs || !sameSelection) throw new InvalidOperationException("手势选区矩形与松开点不相邻，或控件/选区归属复核失败。");
        input["x"]=endX; input["y"]=endY; input["text"]=text;
        input["captureTooLong"]=text.Length>=12003 || CleanText(text).Length>12000;
        return input;
    }

    [MTAThread]
    public static void Main(string[] args) {
        Console.InputEncoding = new UTF8Encoding(false); Console.OutputEncoding = new UTF8Encoding(false);
        // 鼠标 hook 使用物理像素；只调整本助手线程，避免高缩放屏幕上的原生命中测试被坐标虚拟化。
        try { SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch(EntryPointNotFoundException) { }
        var json = new JavaScriptSerializer();
        bool contextWasPublished = false;
        Dictionary<string,object> input = null;
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
            input = json.Deserialize<Dictionary<string, object>>(Console.ReadLine() ?? "{}");
            AutomationElement gestureOwner=null; TextPatternRange gestureSelection=null;
            if(input.ContainsKey("mode") && Convert.ToString(input["mode"])=="gesture") input=ReadGesture(input,json,out gestureOwner,out gestureSelection);
            var expected = MatchText(Convert.ToString(input["text"]));
            bool progressive = input.ContainsKey("progressive") && Convert.ToBoolean(input["progressive"]);
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
                                var selected = selections[0]; var rawText=selected.GetText(12001); var matchText=MatchText(rawText); var text=CleanText(rawText);
                                if (text.Length > 0 && text.Length <= 12000 && matchText == expected) {
                                    var title = new StringBuilder(512); GetWindowText(hwnd, title, title.Capacity);
                                    string app = ""; try { app = Process.GetProcessById((int)pid).ProcessName; } catch { }
                                    if(progressive) {
                                        contextWasPublished = true;
                                        Console.WriteLine(json.Serialize(new { valid=true, text=text, contextPending=true, app=app, title=title.ToString() })); Console.Out.Flush();
                                    }
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
                                                    var scopeRaw = scope.GetText(6003); var scopeText = CleanText(scopeRaw);
                                                    if (scopeRaw.Length < 6003 && scopeText.Length > 0 && scopeText.Length <= 6000 && scopeText.IndexOfAny(new[] { '\r', '\n', '\u0085', '\u2028', '\u2029' }) < 0 && scopeText.IndexOf(text, StringComparison.Ordinal) >= 0) {
                                                        range = scope; wholeEdit = true; verifiedEditSelection = true; unverifiedEditScope = false;
                                                    }
                                                }
                                            }
                                        } catch { }
                                        // 为段落末尾的 CRLF 留出两个字符；触及读取上限时仍不能视作完整段落。
                                        var paragraphText = range.GetText(6003);
                                        var paragraph = CleanText(paragraphText);
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
                                    if(gestureOwner!=null && !progressive && (!SameOwner(hwnd,gestureOwner) || !SameSelection(gestureOwner,gestureSelection))) throw new InvalidOperationException();
                                    if(progressive) {
                                        try {
                                            if(CleanText(selected.GetText(12001))!=text) { context=""; reason="选定内容在上下文读取期间已改变，请手动补充上下文。"; }
                                        } catch { context=""; reason="选定内容已无法复核，请手动补充上下文。"; }
                                        Console.WriteLine(json.Serialize(new { contextComplete=true, context=context, contextOrigin=context.Length>0?"UIA 所在段落":"", reason=reason })); Console.Out.Flush();
                                    } else Console.WriteLine(json.Serialize(new { valid=true, text=text, context=context, contextOrigin=context.Length>0?"UIA 所在段落":"", reason=reason, app=app, title=title.ToString() }));
                                    return;
                                }
                            }
                        }
                        element = TreeWalker.ControlViewWalker.GetParent(element);
                    } catch { break; }
                }
            }
            Console.WriteLine("{\"valid\":false}");
        } catch {
            if(contextWasPublished) {
                Console.WriteLine(json.Serialize(new { contextComplete=true, context="", contextOrigin="", reason="上下文读取失败，请手动补充上下文。" }));
            } else Console.WriteLine("{\"valid\":false}");
        }
    }
}
