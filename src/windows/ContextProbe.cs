using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Automation.Text;

internal enum ContextRangeEndpoint { Start, End }

// 让段落范围规则可以由确定性提供方验证，不要求测试窗口抢占桌面前台。
internal interface IContextTextRange {
    IContextTextRange Clone();
    void ExpandToParagraph();
    int MoveEndpointByParagraph(ContextRangeEndpoint endpoint, int count);
    int MoveEndpointByCharacter(ContextRangeEndpoint endpoint, int count);
    int CompareEndpoint(ContextRangeEndpoint endpoint, IContextTextRange other, ContextRangeEndpoint otherEndpoint);
    void MoveEndpointByRange(ContextRangeEndpoint endpoint, IContextTextRange other, ContextRangeEndpoint otherEndpoint);
    bool Compare(IContextTextRange other);
    string GetText(int maxLength);
    object GetOwnerIdentity();
}

internal interface IContextTextPatternSource {
    IContextTextRange GetDocumentRange();
    IContextTextRange RangeFromChild(object child);
}

internal sealed class UiaContextTextRange : IContextTextRange {
    readonly TextPatternRange range;
    internal UiaContextTextRange(TextPatternRange value) { range = value; }
    public IContextTextRange Clone() { return new UiaContextTextRange(range.Clone()); }
    public void ExpandToParagraph() { range.ExpandToEnclosingUnit(TextUnit.Paragraph); }
    public int MoveEndpointByParagraph(ContextRangeEndpoint endpoint, int count) {
        return range.MoveEndpointByUnit(endpoint == ContextRangeEndpoint.Start ? TextPatternRangeEndpoint.Start : TextPatternRangeEndpoint.End, TextUnit.Paragraph, count);
    }
    public int MoveEndpointByCharacter(ContextRangeEndpoint endpoint, int count) {
        return range.MoveEndpointByUnit(endpoint == ContextRangeEndpoint.Start ? TextPatternRangeEndpoint.Start : TextPatternRangeEndpoint.End, TextUnit.Character, count);
    }
    public int CompareEndpoint(ContextRangeEndpoint endpoint, IContextTextRange other, ContextRangeEndpoint otherEndpoint) {
        var target = other as UiaContextTextRange;
        if (target == null) throw new InvalidOperationException("UIA 范围类型不匹配。");
        return range.CompareEndpoints(endpoint == ContextRangeEndpoint.Start ? TextPatternRangeEndpoint.Start : TextPatternRangeEndpoint.End,
            target.range, otherEndpoint == ContextRangeEndpoint.Start ? TextPatternRangeEndpoint.Start : TextPatternRangeEndpoint.End);
    }
    public void MoveEndpointByRange(ContextRangeEndpoint endpoint, IContextTextRange other, ContextRangeEndpoint otherEndpoint) {
        var target = other as UiaContextTextRange;
        if (target == null) throw new InvalidOperationException("UIA 范围类型不匹配。");
        range.MoveEndpointByRange(endpoint == ContextRangeEndpoint.Start ? TextPatternRangeEndpoint.Start : TextPatternRangeEndpoint.End,
            target.range, otherEndpoint == ContextRangeEndpoint.Start ? TextPatternRangeEndpoint.Start : TextPatternRangeEndpoint.End);
    }
    public bool Compare(IContextTextRange other) {
        var target = other as UiaContextTextRange;
        return target != null && range.Compare(target.range);
    }
    public string GetText(int maxLength) { return range.GetText(maxLength); }
    public object GetOwnerIdentity() { return range.GetEnclosingElement(); }
}

internal sealed class UiaContextTextPatternSource : IContextTextPatternSource {
    readonly TextPattern pattern;
    internal UiaContextTextPatternSource(TextPattern value) { pattern = value; }
    public IContextTextRange GetDocumentRange() { return new UiaContextTextRange(pattern.DocumentRange); }
    public IContextTextRange RangeFromChild(object child) {
        var element = child as AutomationElement;
        if (element == null) throw new InvalidOperationException("UIA 子控件类型不匹配。");
        return new UiaContextTextRange(pattern.RangeFromChild(element));
    }
}

internal static class ContextScopeResolver {
    // DocumentRange 仅用作该 TextPattern 的可信范围边界；实际输出仍由段落读取器限界。
    internal static IContextTextRange GetRange(IContextTextPatternSource pattern, object patternOwner,
        object selectedOwner, bool documentOwner, out bool providerReturnedRange) {
        providerReturnedRange = false;
        if (pattern == null || patternOwner == null || selectedOwner == null) return null;
        try {
            // RangeFromChild 只接受 TextPattern 的后代；Document 自身必须以 DocumentRange 作为可信边界。
            var range = documentOwner && Object.Equals(patternOwner, selectedOwner)
                ? pattern.GetDocumentRange()
                : pattern.RangeFromChild(selectedOwner);
            providerReturnedRange = true;
            return range;
        } catch { return null; }
    }
}

internal sealed class ContextReadResult {
    internal string Context, Reason;
    internal ContextReadResult(string context, string reason) { Context = context; Reason = reason; }
}

internal static class ParagraphContextReader {
    const int MaximumContextLength = 6000;
    const int ReadLimit = MaximumContextLength + 3;
    static readonly char[] ParagraphBreaks = new[] { '\r', '\n', '\u0085', '\u2028', '\u2029' };
    static string Clean(string text) { return (text ?? "").Replace("\r\n", "\n").Replace("\uFFFC", "").Trim(); }
    static bool Contains(IContextTextRange outer, IContextTextRange inner) {
        return outer.CompareEndpoint(ContextRangeEndpoint.Start, inner, ContextRangeEndpoint.Start) <= 0 &&
            outer.CompareEndpoint(ContextRangeEndpoint.End, inner, ContextRangeEndpoint.End) >= 0;
    }
    static bool SameOwner(IContextTextRange first, IContextTextRange second) {
        return Object.Equals(first.GetOwnerIdentity(), second.GetOwnerIdentity());
    }
    static bool Within(IContextTextRange range, IContextTextRange selected, IContextTextRange scope) {
        if (!SameOwner(range, selected) || !Contains(range, selected)) return false;
        return scope == null || (SameOwner(range, scope) && Contains(scope, range));
    }
    static string ValidateParagraphRange(IContextTextRange range) {
        const string boundaryFailure = "当前应用未提供可靠的段落边界，请手动补充上下文。";
        string raw = range.GetText(ReadLimit);
        if (raw == null || raw.Length >= ReadLimit) return "选区首尾段落超过 6000 个字符，请手动精简上下文。";
        string text = Clean(raw);
        if (text.Length == 0) return boundaryFailure;
        if (text.Length > MaximumContextLength) return "选区首尾段落超过 6000 个字符，请手动精简上下文。";
        // Paragraph 单位应返回一个段落；多出内部段落分隔符说明提供方升级到了 Page/Document 等更大单位。
        if (text.IndexOfAny(ParagraphBreaks) >= 0) return boundaryFailure;
        return "";
    }
    static bool TryExtend(IContextTextRange current, IContextTextRange selected, IContextTextRange scope,
        ContextRangeEndpoint endpoint, int count, string currentText, out IContextTextRange extended, out string extendedText) {
        extended = null; extendedText = null;
        try {
            var candidate = current.Clone();
            if (candidate.MoveEndpointByParagraph(endpoint, count) != count || candidate.Compare(current)) return false;
            if (endpoint == ContextRangeEndpoint.Start) {
                if (candidate.CompareEndpoint(ContextRangeEndpoint.Start, current, ContextRangeEndpoint.Start) >= 0 ||
                    candidate.CompareEndpoint(ContextRangeEndpoint.End, current, ContextRangeEndpoint.End) != 0) return false;
            } else {
                if (candidate.CompareEndpoint(ContextRangeEndpoint.End, current, ContextRangeEndpoint.End) <= 0 ||
                    candidate.CompareEndpoint(ContextRangeEndpoint.Start, current, ContextRangeEndpoint.Start) != 0) return false;
            }
            if (!Within(candidate, selected, scope)) return false;
            var added = candidate.Clone();
            if (endpoint == ContextRangeEndpoint.Start) added.MoveEndpointByRange(ContextRangeEndpoint.End, current, ContextRangeEndpoint.Start);
            else added.MoveEndpointByRange(ContextRangeEndpoint.Start, current, ContextRangeEndpoint.End);
            string addedRaw = added.GetText(ReadLimit);
            if (addedRaw == null || addedRaw.Length >= ReadLimit) return false;
            string addedText = Clean(addedRaw);
            if (addedText.Length == 0 || addedText.IndexOfAny(ParagraphBreaks) >= 0) return false;
            string raw = candidate.GetText(ReadLimit);
            if (raw == null || raw.Length >= ReadLimit) return false;
            string cleaned = Clean(raw);
            if (endpoint == ContextRangeEndpoint.Start ? !cleaned.EndsWith(currentText, StringComparison.Ordinal) : !cleaned.StartsWith(currentText, StringComparison.Ordinal)) return false;
            if (cleaned.Length == 0 || cleaned.Length > MaximumContextLength) return false;
            extended = candidate; extendedText = cleaned; return true;
        } catch { return false; }
    }

    internal static ContextReadResult Read(IContextTextRange selected, IContextTextRange scope, bool editOwner) {
        const string boundaryFailure = "当前应用未提供可靠的控件或段落边界，请手动补充上下文。";
        if (selected == null || (scope == null && !editOwner)) return new ContextReadResult("", boundaryFailure);
        try {
            object owner = selected.GetOwnerIdentity();
            if (owner == null || (scope != null && !Object.Equals(owner, scope.GetOwnerIdentity()))) return new ContextReadResult("", boundaryFailure);
            if (scope != null && !Contains(scope, selected)) return new ContextReadResult("", boundaryFailure);

            // ExpandToEnclosingUnit 会把跨单位范围缩短到起点所在单位；因此分别定位选区起点段和末尾选中字符所在段。
            var first = selected.Clone();
            first.MoveEndpointByRange(ContextRangeEndpoint.End, selected, ContextRangeEndpoint.Start);
            first.ExpandToParagraph();

            var last = selected.Clone();
            if (last.MoveEndpointByCharacter(ContextRangeEndpoint.End, -1) != -1) return new ContextReadResult("", boundaryFailure);
            last.MoveEndpointByRange(ContextRangeEndpoint.Start, last, ContextRangeEndpoint.End);
            last.ExpandToParagraph();

            if (!SameOwner(first, selected) || !SameOwner(last, selected) ||
                (scope != null && (!Contains(scope, first) || !Contains(scope, last))) ||
                first.CompareEndpoint(ContextRangeEndpoint.Start, last, ContextRangeEndpoint.Start) > 0)
                return new ContextReadResult("", boundaryFailure);

            // Paragraph 不受支持时 UIA 会升级到更大的 TextUnit；内部仍含多个段落的范围不能作为端点段落。
            string firstFailure = ValidateParagraphRange(first);
            if (firstFailure.Length > 0) return new ContextReadResult("", firstFailure);
            if (!first.Compare(last)) {
                string lastFailure = ValidateParagraphRange(last);
                if (lastFailure.Length > 0) return new ContextReadResult("", lastFailure);
            }

            var core = first.Clone();
            core.MoveEndpointByRange(ContextRangeEndpoint.End, last, ContextRangeEndpoint.End);
            if (!SameOwner(core, selected) || !Contains(core, selected) || (scope != null && !Contains(scope, core))) return new ContextReadResult("", boundaryFailure);

            string raw = core.GetText(ReadLimit);
            if (raw == null || raw.Length >= ReadLimit) return new ContextReadResult("", "选区首尾段落超过 6000 个字符，请手动精简上下文。");
            string context = Clean(raw);
            if (context.Length == 0) return new ContextReadResult("", boundaryFailure);
            if (context.Length > MaximumContextLength) return new ContextReadResult("", "选区首尾段落超过 6000 个字符，请手动精简上下文。");

            var current = core;
            string currentText = context;
            IContextTextRange extended; string extendedText;
            if (TryExtend(current, selected, scope, ContextRangeEndpoint.Start, -1, currentText, out extended, out extendedText)) {
                current = extended; currentText = extendedText;
            }
            if (TryExtend(current, selected, scope, ContextRangeEndpoint.End, 1, currentText, out extended, out extendedText)) {
                current = extended; currentText = extendedText;
            }
            return new ContextReadResult(currentText, "");
        } catch { return new ContextReadResult("", boundaryFailure); }
    }
}

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
                                    string context = "", reason = "当前应用未提供可靠的控件或段落边界，请手动补充上下文。";
                                    try {
                                        // 多段选区先按 TextUnit.Paragraph 补齐首尾段，再仅在同一可信控件范围内扩展一段。
                                        var owner = element.Current.ControlType == ControlType.Edit ? element : selected.GetEnclosingElement();
                                        bool editOwner = owner.Current.ControlType == ControlType.Edit && !owner.Current.IsPassword && owner.Current.ProcessId == pid;
                                        var selectedRange = new UiaContextTextRange(selected);
                                        IContextTextRange scopeRange = null;
                                        bool scopeWasReturned = false;
                                        try {
                                            if ((owner.Current.ControlType == ControlType.Edit || owner.Current.ControlType == ControlType.Document) && !owner.Current.IsPassword && owner.Current.ProcessId == pid) {
                                                var candidateScope = ContextScopeResolver.GetRange(new UiaContextTextPatternSource(pattern), element, owner,
                                                    element.Current.ControlType == ControlType.Document, out scopeWasReturned);
                                                if (candidateScope == null) throw new InvalidOperationException("UIA 未提供可信范围。");
                                                bool scopeContains = candidateScope.CompareEndpoint(ContextRangeEndpoint.Start, selectedRange, ContextRangeEndpoint.Start) <= 0 &&
                                                    candidateScope.CompareEndpoint(ContextRangeEndpoint.End, selectedRange, ContextRangeEndpoint.End) >= 0;
                                                if (scopeContains && Object.Equals(candidateScope.GetOwnerIdentity(), owner)) scopeRange = candidateScope;
                                                else if (editOwner && selected.GetEnclosingElement().Equals(owner) && candidateScope.GetOwnerIdentity().Equals(owner)) {
                                                    // 保留少数 UIA 提供方在末尾表情处端点不一致的单段兼容；仅接受同一 Edit 内完整单段范围。
                                                    var scopeRaw = candidateScope.GetText(6003); var scopeText = CleanText(scopeRaw);
                                                    if (scopeRaw.Length < 6003 && scopeText.Length > 0 && scopeText.Length <= 6000 && scopeText.IndexOfAny(new[] { '\r', '\n', '\u0085', '\u2028', '\u2029' }) < 0 && scopeText.IndexOf(text, StringComparison.Ordinal) >= 0) {
                                                        context = scopeText; reason = "";
                                                    }
                                                }
                                            }
                                        } catch { scopeWasReturned = false; scopeRange = null; }

                                        // 同一 Edit 的 TextUnit 段落归属可在 RangeFromChild 不可用时作为边界证明；Document 不允许这样回退。
                                        bool editOwnerMatches = editOwner && selected.GetEnclosingElement().Equals(owner);
                                        if (context.Length == 0 && (scopeRange != null || (!scopeWasReturned && editOwnerMatches))) {
                                            var result = ParagraphContextReader.Read(selectedRange, scopeRange, editOwner);
                                            context = result.Context; reason = result.Reason;
                                        } else if (context.Length == 0 && reason.Length == 0) {
                                            reason = "当前应用未提供可靠的控件边界，请手动补充上下文。";
                                        }
                                    } catch { context = ""; reason = "当前应用未提供可靠的段落范围，请手动补充上下文。"; }
                                    if(gestureOwner!=null && !progressive && (!SameOwner(hwnd,gestureOwner) || !SameSelection(gestureOwner,gestureSelection))) throw new InvalidOperationException();
                                    if(progressive) {
                                        try {
                                            if(CleanText(selected.GetText(12001))!=text) { context=""; reason="选定内容在上下文读取期间已改变，请手动补充上下文。"; }
                                        } catch { context=""; reason="选定内容已无法复核，请手动补充上下文。"; }
                                        Console.WriteLine(json.Serialize(new { contextComplete=true, context=context, contextOrigin=context.Length>0?"UIA 所在段落及相邻段落":"", reason=reason })); Console.Out.Flush();
                                    } else Console.WriteLine(json.Serialize(new { valid=true, text=text, context=context, contextOrigin=context.Length>0?"UIA 所在段落及相邻段落":"", reason=reason, app=app, title=title.ToString() }));
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
