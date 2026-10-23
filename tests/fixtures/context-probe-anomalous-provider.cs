using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Automation.Provider;
using System.Windows.Automation.Text;
using System.Windows.Forms;

// 只创建自有虚构窗口。UIA 通过 WM_GETOBJECT 跨进程读取本 provider；不操作其它应用、剪贴板或输入设备。
internal static class AnomalousContextFixture {
    const int WmGetObject = 0x003D;
    const int UiaRootObjectId = -25;
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static FixtureState state;
    static FixtureForm form;
    static ProviderRoot root;

    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();

    [STAThread]
    public static void Main(string[] args) {
        Console.OutputEncoding = new UTF8Encoding(false);
        Environment.ExitCode = 2;
        try {
            if (args.Length < 1 || args.Length > 3) throw new ArgumentException("需要传入当前/对照 ContextProbe.exe 路径和可选样例名。");
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            state = new FixtureState();
            foreach (var initial in Samples()) { state.Use(initial); break; }
            form = new FixtureForm();
            form.Text = "PickGloss 虚构 UIA 异常夹具";
            form.ClientSize = new System.Drawing.Size(460, 120);
            form.StartPosition = FormStartPosition.CenterScreen;
            form.Show();
            form.Activate();
            form.Focus();
            Application.DoEvents();
            root = new ProviderRoot(state, form);
            form.SetProvider(root);

            var foregroundWait = Stopwatch.StartNew();
            bool initialForeground = GetForegroundWindow() == form.Handle;
            while (!initialForeground && foregroundWait.ElapsedMilliseconds < 60000) {
                // 保持自有窗口可见，给桌面宿主一次激活机会；不反复请求或强制抢占焦点。
                Application.DoEvents();
                Thread.Sleep(100);
                initialForeground = GetForegroundWindow() == form.Handle;
            }
            var rows = new List<object>();
            var baselineRows = new List<object>();
            if (initialForeground) {
                foreach (var sample in Samples()) {
                    if (args.Length == 3 && sample.Name.IndexOf(args[2], StringComparison.OrdinalIgnoreCase) < 0) continue;
                    state.Use(sample);
                    Application.DoEvents();
                    var row = RunSample(args[0], sample);
                    rows.Add(row);
                    if (row.ContainsKey("foregroundAfterProbe") && !Convert.ToBoolean(row["foregroundAfterProbe"])) break;
                    if (args.Length >= 2) {
                        state.Use(sample);
                        row = RunSample(args[1], sample);
                        baselineRows.Add(row);
                        if (row.ContainsKey("foregroundAfterProbe") && !Convert.ToBoolean(row["foregroundAfterProbe"])) break;
                    }
                }
            }
            var output = new Dictionary<string, object>();
            output["fixture"] = "跨进程异常 UIA TextProvider";
            output["foregroundOwnedWindow"] = initialForeground;
            output["foregroundWaitMs"] = foregroundWait.ElapsedMilliseconds;
            output["providerWindowHandleCreated"] = form.IsHandleCreated;
            output["results"] = rows;
            output["baselineResults"] = baselineRows;
            Console.WriteLine(Json.Serialize(output));
            Application.DoEvents();
            Thread.Sleep(2000);
            Environment.ExitCode = initialForeground ? 0 : 2;
        } catch (Exception error) {
            Console.WriteLine(Json.Serialize(new { fixtureError = error.GetType().Name, message = error.Message }));
            Environment.ExitCode = 2;
        } finally {
            if (form != null && !form.IsDisposed) {
                try { form.Close(); form.Dispose(); } catch { }
            }
        }
    }

    static Dictionary<string, object> RunSample(string helper, Sample sample) {
        var stats = state.Stats;
        var row = new Dictionary<string, object>();
        row["name"] = sample.Name;
        row["category"] = sample.Category;
        row["foregroundBeforeProbe"] = GetForegroundWindow() == form.Handle;
        row["expectedContextLength"] = sample.ExpectedContext.Length;
        row["expectedSelectionLength"] = sample.SelectionNormalized.Length;
        row["expectedSelectionSha256"] = Hash(sample.SelectionNormalized);
        row["scopeLength"] = sample.ScopeText.Length;
        row["forbiddenMarker"] = sample.ForbiddenMarker;
        row["rangeFromChildThrows"] = sample.RangeFromChildThrows;
        row["expectedEndpointAnomaly"] = !sample.RangeFromChildThrows;
        row["fixtureSetup"] = new Dictionary<string, object> {
            { "textPatternRootControlType", sample.RootIsEdit ? "Edit" : "Document" },
            { "selectedRangeEnclosingOwnerIdConfigured", sample.SelectionOwnerId },
            { "scopeRangeEnclosingOwnerIdConfigured", sample.ScopeOwnerId },
            { "documentRangeEnclosingOwnerIdConfigured", 1 }
        };
        if (!Convert.ToBoolean(row["foregroundBeforeProbe"])) {
            row["preconditionError"] = "自有 provider 窗口未保持前台。";
            row["helperExitCode"] = -1;
            row["providerCalls"] = stats.Snapshot();
            row["observations"] = state.Observations();
            return row;
        }

        string input = Json.Serialize(new {
            text = sample.SelectionNormalized,
            x = form.Left + form.Width / 2.0,
            y = form.Top + form.Height / 2.0,
            excludePids = ExcludedPids()
        }) + "\n";
        var info = new ProcessStartInfo(helper);
        info.UseShellExecute = false;
        info.CreateNoWindow = true;
        info.RedirectStandardInput = true;
        info.RedirectStandardOutput = true;
        info.RedirectStandardError = true;
        info.StandardOutputEncoding = new UTF8Encoding(false);
        info.StandardErrorEncoding = new UTF8Encoding(false);
        Process child = null;
        string stdout = "", stderr = "";
        int childExit = -1;
        string childError = null;
        try {
            child = Process.Start(info);
            var inputBytes = Encoding.UTF8.GetBytes(input);
            child.StandardInput.BaseStream.Write(inputBytes, 0, inputBytes.Length);
            child.StandardInput.BaseStream.Flush();
            child.StandardInput.Close();
            Task<string> outputTask = child.StandardOutput.ReadToEndAsync();
            Task<string> errorTask = child.StandardError.ReadToEndAsync();
            var clock = Stopwatch.StartNew();
            while (!child.HasExited && clock.ElapsedMilliseconds < 8000) {
                Application.DoEvents();
                Thread.Sleep(10);
            }
            if (!child.HasExited) {
                try { child.Kill(); } catch { }
                childError = "上下文助手超时，已仅终止本夹具启动的进程。";
            } else {
                childExit = child.ExitCode;
                stdout = outputTask.Result;
                stderr = errorTask.Result;
            }
        } catch (Exception error) {
            childError = error.GetType().Name;
            if (child != null && !child.HasExited) { try { child.Kill(); } catch { } }
        } finally {
            if (child != null) child.Dispose();
        }

        row["helperExitCode"] = childExit;
        row["helperError"] = childError;
        row["helperStderrLength"] = stderr.Length;
        row["foregroundAfterProbe"] = GetForegroundWindow() == form.Handle;
        row["providerCalls"] = stats.Snapshot();
        row["observations"] = state.Observations();
        try {
            var response = Json.Deserialize<Dictionary<string, object>>(stdout.Trim());
            row["valid"] = response.ContainsKey("valid") && Convert.ToBoolean(response["valid"]);
            string responseText = response.ContainsKey("text") ? Convert.ToString(response["text"]) : "";
            string context = response.ContainsKey("context") ? Convert.ToString(response["context"]) : "";
            string reason = response.ContainsKey("reason") ? Convert.ToString(response["reason"]) : "";
            row["responseTextLength"] = responseText.Length;
            row["selectionMatches"] = responseText == sample.SelectionNormalized;
            row["contextLength"] = context.Length;
            row["contextMatchesExpected"] = context == sample.ExpectedContext;
            row["contextMatchesScope"] = context == sample.ScopeText;
            row["borrowedMarkerPresent"] = sample.ForbiddenMarker.Length > 0 && context.IndexOf(sample.ForbiddenMarker, StringComparison.Ordinal) >= 0;
            row["reason"] = reason;
            row["contextAccepted"] = context.Length > 0;
        } catch (Exception error) {
            row["parseError"] = error.GetType().Name;
            row["stdoutLength"] = stdout.Length;
        }
        return row;
    }

    static string ExcludedPids() {
        var ids = new List<string>();
        foreach (var process in Process.GetProcesses()) {
            try { if (process.Id != CurrentProcessId) ids.Add(process.Id.ToString()); } catch { }
            finally { process.Dispose(); }
        }
        return String.Join(",", ids.ToArray());
    }

    static string Hash(string value) {
        using (var sha = SHA256.Create()) {
            var bytes = sha.ComputeHash(Encoding.UTF8.GetBytes(value ?? ""));
            var builder = new StringBuilder(bytes.Length * 2);
            foreach (var b in bytes) builder.Append(b.ToString("x2"));
            return builder.ToString();
        }
    }

    static IEnumerable<Sample> Samples() {
        const string key = "目标词";
        yield return Sample.Positive("正例-虚构文案A-末尾普通文本", "邻近上段\r\n第一份完全虚构的句子写着目标词，最后留下普通尾声\r\n邻近下段", "第一份完全虚构的句子写着目标词，最后留下普通尾声", "普通尾声");
        yield return Sample.Positive("正例-虚构文案B-末尾基础表情", "前置虚构段落\n第二份虚构材料提到另一种解释，收尾是目标词🙂\n后置虚构段落", "第二份虚构材料提到另一种解释，收尾是目标词🙂", "目标词🙂");
        yield return Sample.Positive("正例-虚构文案C-末尾复合表情", "无关段落甲\u2028第三份虚构材料有自己的背景：目标词👩‍🚀\u2028无关段落乙", "第三份虚构材料有自己的背景：目标词👩‍🚀", "目标词👩‍🚀");
        yield return Sample.Positive("正例-虚构文案D-组合附加符", "旁边材料\u2029第四份虚构材料在结尾写目标词e\u0301\u2029另一个段落", "第四份虚构材料在结尾写目标词e\u0301", "目标词e\u0301");
        yield return Sample.Positive("正例-恰好6000字符", "邻段甲\r\n" + new string('甲', 5997) + key + "\r\n邻段乙", new string('甲', 5997) + key, key);
        yield return Sample.RangeFromChildThrowsPositive("正例-RangeFromChild异常但Edit归属一致", "单段虚构控件材料包含选定短语目标词，且选区和全文属于同一个Edit", "目标词");
        yield return Sample.Negative("负例-不同selected owner", "邻段甲\r\n目标词\r\n邻段乙", "目标词旁边的虚构上下文", "目标词", "selectedOwnerMismatch", "不可借用的上下文");
        yield return Sample.Negative("负例-不同scope owner", "邻段甲\r\n目标词\r\n邻段乙", "目标词之后的另一个虚构上下文", "目标词", "scopeOwnerMismatch", "不可借用的上下文");
        yield return Sample.Negative("负例-相邻控件重复选词", "当前段落测试词\r\n后续段落", "右侧相邻控件也写着测试词，以及不可借用的邻近上下文", "测试词", "adjacentDuplicate", "不可借用的邻近上下文");
        yield return Sample.Negative("负例-scope不含选区", "邻段甲\r\n这里包含目标词\r\n邻段乙", "这是一段没有被选中文字的其它内容", "目标词", "sameOwners", "没有被选中");
        yield return Sample.Negative("负例-单行不同selected owner", "当前目标词 相邻不可借用上下文", "当前目标词 相邻不可借用上下文", "目标词", "selectedOwnerMismatch", "相邻不可借用上下文");
        yield return Sample.Negative("负例-单行不同scope owner", "当前目标词 相邻不可借用上下文", "当前目标词 相邻不可借用上下文", "目标词", "scopeOwnerMismatch", "相邻不可借用上下文");
        yield return Sample.Negative("负例-单行scope不含选区", "当前目标词 相邻不可借用上下文", "邻近段落没有选中文字", "目标词", "sameOwners", "相邻不可借用上下文");
        yield return Sample.RangeFromChildThrowsNegative("负例-单行范围API异常且Document与Edit归属不同", "当前目标词 相邻不可借用上下文", "目标词", "相邻不可借用上下文");
        yield return Sample.Negative("负例-CR分段", "前文目标词\r后续内容", "前文目标词\r后续内容", "目标词", "sameOwners", "");
        yield return Sample.Negative("负例-LF分段", "前文目标词\n后续内容", "前文目标词\n后续内容", "目标词", "sameOwners", "");
        yield return Sample.Negative("负例-CRLF分段", "前文目标词\r\n后续内容", "前文目标词\r\n后续内容", "目标词", "sameOwners", "");
        yield return Sample.Negative("负例-NEL分段", "前文目标词\u0085后续内容", "前文目标词\u0085后续内容", "目标词", "sameOwners", "");
        yield return Sample.Negative("负例-LineSeparator分段", "前文目标词\u2028后续内容", "前文目标词\u2028后续内容", "目标词", "sameOwners", "");
        yield return Sample.Negative("负例-ParagraphSeparator分段", "前文目标词\u2029后续内容", "前文目标词\u2029后续内容", "目标词", "sameOwners", "");
        yield return Sample.Negative("负例-选区跨段", "开头目标词\r\n跨段结尾", "开头目标词\r\n跨段结尾", "目标词\r\n跨段结尾", "sameOwners", "");
        yield return Sample.Negative("负例-超出6000字符", "邻段甲\r\n" + new string('甲', 5998) + key + "\r\n邻段乙", new string('甲', 5998) + key, key, "sameOwners", "");
        yield return Sample.Negative("负例-读取上限空白后有正文", "邻段甲\r\n" + new string('甲', 5999) + "尾   后续正文\r\n邻段乙", new string('甲', 5999) + "尾   后续正文", "尾", "sameOwners", "");
    }

    internal static int CurrentProcessId { get { return Process.GetCurrentProcess().Id; } }
    internal static FixtureState State { get { return state; } }

    internal sealed class FixtureForm : Form {
        ProviderRoot provider;
        internal void SetProvider(ProviderRoot value) { provider = value; }
        protected override void WndProc(ref Message m) {
            if (m.Msg == WmGetObject && m.LParam.ToInt64() == UiaRootObjectId && provider != null) {
                state.Stats.WmGetObject();
                m.Result = AutomationInteropProvider.ReturnRawElementProvider(Handle, m.WParam, m.LParam, provider);
                state.Stats.ReturnedRawProvider();
                return;
            }
            base.WndProc(ref m);
        }
    }

    internal sealed class ProviderRoot : IRawElementProviderSimple, IRawElementProviderFragment, IRawElementProviderFragmentRoot, ITextProvider {
        readonly FixtureState owner;
        readonly FixtureForm window;
        readonly ProviderNode firstOwner;
        readonly ProviderNode secondOwner;

        internal ProviderRoot(FixtureState state, FixtureForm form) {
            owner = state; window = form;
            firstOwner = new ProviderNode(state, this, 2);
            secondOwner = new ProviderNode(state, this, 3);
        }

        internal ProviderNode OwnerNode(int id) { return id == 2 ? firstOwner : id == 3 ? secondOwner : null; }
        public ProviderOptions ProviderOptions { get { owner.Stats.Hit(); return ProviderOptions.ServerSideProvider; } }
        public object GetPatternProvider(int patternId) {
            owner.Stats.PatternProvider();
            return patternId == TextPattern.Pattern.Id ? this : null;
        }
        public object GetPropertyValue(int propertyId) {
            owner.Stats.Hit();
            if (propertyId == AutomationElement.ControlTypeProperty.Id) return (owner.Current.RootIsEdit ? ControlType.Edit : ControlType.Document).Id;
            if (propertyId == AutomationElement.ProcessIdProperty.Id) { owner.Stats.ProcessId(CurrentProcessId); return CurrentProcessId; }
            if (propertyId == AutomationElement.IsPasswordProperty.Id) return false;
            if (propertyId == AutomationElement.IsEnabledProperty.Id) return true;
            if (propertyId == AutomationElement.IsKeyboardFocusableProperty.Id) return true;
            if (propertyId == AutomationElement.HasKeyboardFocusProperty.Id) return true;
            if (propertyId == AutomationElement.IsControlElementProperty.Id) return true;
            if (propertyId == AutomationElement.IsContentElementProperty.Id) return true;
            if (propertyId == AutomationElement.NameProperty.Id) return "虚构异常 UIA 文本";
            if (propertyId == AutomationElement.NativeWindowHandleProperty.Id) return window.Handle.ToInt32();
            if (propertyId == AutomationElement.AutomationIdProperty.Id) return "AnomalousTextRoot";
            return AutomationElement.NotSupported;
        }
        public IRawElementProviderSimple HostRawElementProvider { get { owner.Stats.Hit(); return AutomationInteropProvider.HostProviderFromHandle(window.Handle); } }
        public IRawElementProviderFragmentRoot FragmentRoot { get { owner.Stats.Hit(); return this; } }
        public IRawElementProviderFragment Parent { get { owner.Stats.Hit(); return null; } }
        public Rect BoundingRectangle { get { owner.Stats.Hit(); return new Rect(window.Left, window.Top, window.Width, window.Height); } }
        public IRawElementProviderSimple[] GetEmbeddedFragmentRoots() { owner.Stats.Hit(); return null; }
        public void SetFocus() { owner.Stats.Hit(); window.Activate(); window.Focus(); }
        public IRawElementProviderFragment Navigate(NavigateDirection direction) {
            owner.Stats.Hit();
            if (direction == NavigateDirection.FirstChild) return firstOwner;
            if (direction == NavigateDirection.LastChild) return secondOwner;
            return null;
        }
        public int[] GetRuntimeId() { owner.Stats.Hit(); return new[] { AutomationInteropProvider.AppendRuntimeId, 1 }; }
        public IRawElementProviderFragmentRoot GetFragmentRoot() { owner.Stats.Hit(); return this; }
        public IRawElementProviderFragment[] GetChildren() { owner.Stats.Hit(); return new IRawElementProviderFragment[] { firstOwner, secondOwner }; }
        public IRawElementProviderFragment ElementProviderFromPoint(double x, double y) { owner.Stats.Hit(); return this; }
        public IRawElementProviderFragment GetFocus() { owner.Stats.Focus(); return this; }
        public ITextRangeProvider[] GetSelection() {
            owner.Stats.Selection();
            var sample = owner.Current;
            int start = sample.DocumentText.IndexOf(sample.SelectionRaw, StringComparison.Ordinal);
            return new ITextRangeProvider[] { new ProviderTextRange(owner, this, sample, RangeKind.Selected, start, start + sample.SelectionRaw.Length) };
        }
        public ITextRangeProvider[] GetVisibleRanges() {
            owner.Stats.VisibleRanges();
            var sample = owner.Current;
            return new ITextRangeProvider[] { new ProviderTextRange(owner, this, sample, RangeKind.Document, 0, sample.DocumentText.Length) };
        }
        public ITextRangeProvider RangeFromChild(IRawElementProviderSimple childElement) {
            owner.Stats.RangeFromChild(childElement);
            var sample = owner.Current;
            if (sample.RangeFromChildThrows) { owner.Stats.RangeFromChildFailure(); throw new InvalidOperationException("此虚构提供方不支持 RangeFromChild。"); }
            int scopeStart = sample.DocumentText.IndexOf(sample.ScopeText, StringComparison.Ordinal);
            int end = sample.DocumentText.IndexOf(sample.SelectionRaw, StringComparison.Ordinal) + sample.SelectionRaw.Length;
            // 故意注入异常：GetText 仍返回完整控件范围，End 却落在选区 End 之前。
            int anomalousEnd = Math.Max(0, end - 1);
            return new ProviderTextRange(owner, this, sample, RangeKind.Scope, scopeStart, anomalousEnd);
        }
        public ITextRangeProvider RangeFromPoint(System.Windows.Point point) {
            owner.Stats.Hit();
            var sample = owner.Current;
            int start = sample.DocumentText.IndexOf(sample.SelectionRaw, StringComparison.Ordinal);
            return new ProviderTextRange(owner, this, sample, RangeKind.Selected, start, start + sample.SelectionRaw.Length);
        }
        public ITextRangeProvider DocumentRange {
            get {
                owner.Stats.DocumentRange();
                var sample = owner.Current;
                return new ProviderTextRange(owner, this, sample, RangeKind.Document, 0, sample.DocumentText.Length);
            }
        }
        public SupportedTextSelection SupportedTextSelection { get { owner.Stats.Hit(); return SupportedTextSelection.Single; } }
    }

    internal sealed class ProviderNode : IRawElementProviderSimple, IRawElementProviderFragment {
        readonly FixtureState state;
        readonly ProviderRoot root;
        readonly int id;
        internal ProviderNode(FixtureState state, ProviderRoot root, int id) { this.state = state; this.root = root; this.id = id; }
        internal int Id { get { return id; } }
        public ProviderOptions ProviderOptions { get { state.Stats.Hit(); return ProviderOptions.ServerSideProvider; } }
        public object GetPatternProvider(int patternId) { state.Stats.Hit(); return null; }
        public object GetPropertyValue(int propertyId) {
            state.Stats.Hit();
            if (propertyId == AutomationElement.ControlTypeProperty.Id) return ControlType.Edit.Id;
            if (propertyId == AutomationElement.ProcessIdProperty.Id) return CurrentProcessId;
            if (propertyId == AutomationElement.IsPasswordProperty.Id) return false;
            if (propertyId == AutomationElement.IsEnabledProperty.Id) return true;
            if (propertyId == AutomationElement.IsKeyboardFocusableProperty.Id) return true;
            if (propertyId == AutomationElement.IsControlElementProperty.Id) return true;
            if (propertyId == AutomationElement.IsContentElementProperty.Id) return true;
            if (propertyId == AutomationElement.NameProperty.Id) return id == 2 ? "虚构编辑控件甲" : "虚构相邻编辑控件乙";
            if (propertyId == AutomationElement.AutomationIdProperty.Id) return id == 2 ? "FakeEditA" : "FakeEditB";
            return AutomationElement.NotSupported;
        }
        public IRawElementProviderSimple HostRawElementProvider { get { state.Stats.Hit(); return null; } }
        public IRawElementProviderFragmentRoot FragmentRoot { get { state.Stats.Hit(); return root; } }
        public IRawElementProviderFragment Parent { get { state.Stats.Hit(); return root; } }
        public Rect BoundingRectangle { get { state.Stats.Hit(); return new Rect(form.Left + 10, form.Top + 10, 200, 40); } }
        public IRawElementProviderSimple[] GetEmbeddedFragmentRoots() { state.Stats.Hit(); return null; }
        public void SetFocus() { state.Stats.Hit(); }
        public IRawElementProviderFragment Navigate(NavigateDirection direction) {
            state.Stats.Hit();
            if (direction == NavigateDirection.Parent) return root;
            if (direction == NavigateDirection.PreviousSibling && id == 3) return root.OwnerNode(2);
            if (direction == NavigateDirection.NextSibling && id == 2) return root.OwnerNode(3);
            return null;
        }
        public int[] GetRuntimeId() { state.Stats.Hit(); return new[] { AutomationInteropProvider.AppendRuntimeId, id }; }
        public IRawElementProviderFragmentRoot GetFragmentRoot() { state.Stats.Hit(); return root; }
        public IRawElementProviderFragment[] GetChildren() { state.Stats.Hit(); return null; }
    }

    internal enum RangeKind { Selected, Scope, Document }

    internal sealed class ProviderTextRange : ITextRangeProvider {
        readonly FixtureState state;
        readonly ProviderRoot root;
        readonly Sample sample;
        readonly RangeKind kind;
        int start;
        int end;
        internal ProviderTextRange(FixtureState state, ProviderRoot root, Sample sample, RangeKind kind, int start, int end) {
            this.state = state; this.root = root; this.sample = sample; this.kind = kind; this.start = Math.Max(0, start); this.end = Math.Max(this.start, Math.Min(end, sample.DocumentText.Length));
        }
        internal RangeKind Kind { get { return kind; } }
        internal int Start { get { return start; } }
        internal int End { get { return end; } }
        ProviderTextRange Other(ITextRangeProvider range) { return range as ProviderTextRange; }
        public ITextRangeProvider Clone() { state.Stats.Clone(); return new ProviderTextRange(state, root, sample, kind, start, end); }
        public bool Compare(ITextRangeProvider range) { state.Stats.Hit(); var other = Other(range); return other != null && start == other.start && end == other.end; }
        public int CompareEndpoints(TextPatternRangeEndpoint endpoint, ITextRangeProvider targetRange, TextPatternRangeEndpoint targetEndpoint) {
            state.Stats.CompareEndpoint();
            var other = Other(targetRange);
            if (other == null) return 0;
            int left = endpoint == TextPatternRangeEndpoint.Start ? start : end;
            int right = targetEndpoint == TextPatternRangeEndpoint.Start ? other.start : other.end;
            int result = left.CompareTo(right);
            state.Stats.ObserveEndpoint(kind, endpoint, other.kind, targetEndpoint, result);
            return result;
        }
        public void ExpandToEnclosingUnit(TextUnit unit) {
            state.Stats.Expand();
            if (unit == TextUnit.Paragraph || unit == TextUnit.Document || unit == TextUnit.Line) { start = 0; end = sample.DocumentText.Length; }
        }
        public ITextRangeProvider FindAttribute(int attributeId, object value, bool backward) { state.Stats.Hit(); return null; }
        public ITextRangeProvider FindText(string text, bool backward, bool ignoreCase) { state.Stats.Hit(); return null; }
        public object GetAttributeValue(int attributeId) { state.Stats.Hit(); return AutomationElement.NotSupported; }
        public double[] GetBoundingRectangles() { state.Stats.Hit(); return new double[0]; }
        public IRawElementProviderSimple GetEnclosingElement() {
            int id = kind == RangeKind.Scope ? sample.ScopeOwnerId : kind == RangeKind.Selected ? sample.SelectionOwnerId : 1;
            state.Stats.Enclosing(kind, id);
            if (id == 1) return root;
            return root.OwnerNode(id);
        }
        public string GetText(int maxLength) {
            string value = kind == RangeKind.Scope ? sample.ScopeText : sample.DocumentText.Substring(start, Math.Max(0, end - start));
            state.Stats.GetText(kind, value);
            if (maxLength >= 0 && value.Length > maxLength) value = value.Substring(0, maxLength);
            return value;
        }
        public int Move(TextUnit unit, int count) { state.Stats.Hit(); return 0; }
        public int MoveEndpointByUnit(TextPatternRangeEndpoint endpoint, TextUnit unit, int count) {
            state.Stats.Hit();
            if (unit != TextUnit.Character) return 0;
            if (endpoint == TextPatternRangeEndpoint.Start) start = Math.Max(0, Math.Min(sample.DocumentText.Length, start + count));
            else end = Math.Max(start, Math.Min(sample.DocumentText.Length, end + count));
            return count;
        }
        public void MoveEndpointByRange(TextPatternRangeEndpoint endpoint, ITextRangeProvider targetRange, TextPatternRangeEndpoint targetEndpoint) {
            state.Stats.Hit();
            var other = Other(targetRange); if (other == null) return;
            int value = targetEndpoint == TextPatternRangeEndpoint.Start ? other.start : other.end;
            if (endpoint == TextPatternRangeEndpoint.Start) start = Math.Min(value, end); else end = Math.Max(start, value);
        }
        public void Select() { state.Stats.Hit(); }
        public void AddToSelection() { state.Stats.Hit(); }
        public void RemoveFromSelection() { state.Stats.Hit(); }
        public void ScrollIntoView(bool alignToTop) { state.Stats.Hit(); }
        public IRawElementProviderSimple[] GetChildren() { state.Stats.Hit(); return null; }
    }

    internal sealed class FixtureState {
        internal Sample Current { get; private set; }
        internal ProviderStats Stats { get; private set; }
        internal FixtureState() { Stats = new ProviderStats(); }
        internal void Use(Sample sample) { Current = sample; Stats = new ProviderStats(); }
        internal Dictionary<string, object> Observations() { return Stats.Observations(Current); }
    }

    internal sealed class ProviderStats {
        long calls;
        int wmGetObject, returnRawProvider, patternProvider, selection, rangeFromChild, compareEndpoint;
        int getEnclosingSelection, getEnclosingScope, getEnclosingDocument, scopeEndVsSelectionEndCalls, rangeFromChildFailures;
        int getTextSelected, getTextScope, getTextDocument, lastSelectedTextLength = -1;
        int processIdCalls, lastProcessId;
        string lastSelectedTextSha256;
        int? scopeEndVsSelectionEnd;
        int? selectedOwnerId, scopeOwnerId, rangeFromChildOwnerId;
        internal void Hit() { Interlocked.Increment(ref calls); }
        internal void WmGetObject() { Interlocked.Increment(ref wmGetObject); Hit(); }
        internal void ReturnedRawProvider() { Interlocked.Increment(ref returnRawProvider); Hit(); }
        internal void PatternProvider() { Interlocked.Increment(ref patternProvider); Hit(); }
        internal void Selection() { Interlocked.Increment(ref selection); Hit(); }
        internal void VisibleRanges() { Hit(); }
        internal void DocumentRange() { Hit(); }
        internal void RangeFromChild(IRawElementProviderSimple child) {
            Interlocked.Increment(ref rangeFromChild); Hit();
            var node = child as ProviderNode;
            rangeFromChildOwnerId = node == null ? (int?)1 : node.Id;
        }
        internal void CompareEndpoint() { Interlocked.Increment(ref compareEndpoint); Hit(); }
        internal void RangeFromChildFailure() { Interlocked.Increment(ref rangeFromChildFailures); Hit(); }
        internal void Clone() { Hit(); }
        internal void Expand() { Hit(); }
        internal void ProcessId(int processId) { Interlocked.Increment(ref processIdCalls); lastProcessId = processId; Hit(); }
        internal void GetText(RangeKind kind, string value) {
            Hit();
            if (kind == RangeKind.Selected) { Interlocked.Increment(ref getTextSelected); lastSelectedTextLength = value.Length; lastSelectedTextSha256 = Hash(value); }
            else if (kind == RangeKind.Scope) Interlocked.Increment(ref getTextScope);
            else Interlocked.Increment(ref getTextDocument);
        }
        internal void Focus() { Hit(); }
        internal void Enclosing(RangeKind kind, int ownerId) {
            Hit();
            if (kind == RangeKind.Selected) { Interlocked.Increment(ref getEnclosingSelection); selectedOwnerId = ownerId; }
            else if (kind == RangeKind.Scope) { Interlocked.Increment(ref getEnclosingScope); scopeOwnerId = ownerId; }
            else Interlocked.Increment(ref getEnclosingDocument);
        }
        internal void ObserveEndpoint(RangeKind thisKind, TextPatternRangeEndpoint endpoint, RangeKind otherKind, TextPatternRangeEndpoint otherEndpoint, int result) {
            if (thisKind == RangeKind.Scope && endpoint == TextPatternRangeEndpoint.End && otherKind == RangeKind.Selected && otherEndpoint == TextPatternRangeEndpoint.End) {
                Interlocked.Increment(ref scopeEndVsSelectionEndCalls);
                scopeEndVsSelectionEnd = result;
            }
        }
        internal Dictionary<string, object> Snapshot() {
            return new Dictionary<string, object> {
                { "totalProviderCalls", Interlocked.Read(ref calls) },
                { "wmGetObject", wmGetObject }, { "returnedRawProvider", returnRawProvider },
                { "getPatternProvider", patternProvider }, { "getSelection", selection },
                { "rangeFromChild", rangeFromChild }, { "rangeFromChildFailures", rangeFromChildFailures }, { "compareEndpoints", compareEndpoint },
                { "getTextSelected", getTextSelected }, { "getTextScope", getTextScope },
                { "getTextDocument", getTextDocument }, { "lastSelectedTextLength", lastSelectedTextLength },
                { "lastSelectedTextSha256", lastSelectedTextSha256 }, { "getProcessId", processIdCalls }, { "lastProcessId", lastProcessId },
                { "getEnclosingSelection", getEnclosingSelection }, { "getEnclosingScope", getEnclosingScope }
            };
        }
        internal Dictionary<string, object> Observations(Sample sample) {
            int currentEditId = sample.RootIsEdit ? 1 : sample.SelectionOwnerId;
            bool? selectionMatches = selectedOwnerId.HasValue ? selectedOwnerId.Value == currentEditId : (bool?)null;
            bool? scopeMatches = scopeOwnerId.HasValue ? scopeOwnerId.Value == currentEditId : (bool?)null;
            bool? ownersEqual = selectedOwnerId.HasValue && scopeOwnerId.HasValue ? selectedOwnerId.Value == scopeOwnerId.Value : (bool?)null;
            return new Dictionary<string, object> {
                { "scopeEndVsSelectionEndObserved", scopeEndVsSelectionEndCalls > 0 },
                { "scopeEndVsSelectionEnd", scopeEndVsSelectionEnd },
                { "selectedEnclosingOwnerId", selectedOwnerId }, { "scopeEnclosingOwnerId", scopeOwnerId },
                { "selectedOwnerEqualsCurrentEdit", selectionMatches }, { "scopeOwnerEqualsCurrentEdit", scopeMatches },
                { "selectedAndScopeOwnersEqual", ownersEqual },
                { "rangeFromChildOwnerId", rangeFromChildOwnerId }
            };
        }
    }

    internal sealed class Sample {
        internal string Name, Category, DocumentText, ScopeText, SelectionRaw, SelectionNormalized, ExpectedContext, ForbiddenMarker;
        internal int SelectionOwnerId, ScopeOwnerId;
        internal bool RootIsEdit, RangeFromChildThrows;
        internal Sample(string name, string category, string document, string scope, string selection, string mode, string forbidden, bool rangeFromChildThrows) {
            Name = name; Category = category; DocumentText = document; ScopeText = scope; SelectionRaw = selection;
            SelectionNormalized = Normal(selection); ExpectedContext = category == "positive" ? Normal(scope) : ""; ForbiddenMarker = forbidden;
            RootIsEdit = mode == "selectedOwnerMismatch" || mode == "editSelf";
            SelectionOwnerId = mode == "editSelf" ? 1 : 2;
            ScopeOwnerId = mode == "selectedOwnerMismatch" ? 1 : mode == "scopeOwnerMismatch" || mode == "adjacentDuplicate" ? 3 : mode == "editSelf" ? 1 : 2;
            RangeFromChildThrows = rangeFromChildThrows;
        }
        internal static Sample Positive(string name, string document, string scope, string selection) { return new Sample(name, "positive", document, scope, selection, "sameOwners", "", false); }
        internal static Sample RangeFromChildThrowsPositive(string name, string document, string selection) { return new Sample(name, "positive", document, document, selection, "editSelf", "", true); }
        internal static Sample RangeFromChildThrowsNegative(string name, string document, string selection, string forbidden) { return new Sample(name, "negative", document, document, selection, "scopeOwnerMismatch", forbidden, true); }
        internal static Sample Negative(string name, string document, string scope, string selection, string mode, string forbidden) { return new Sample(name, "negative", document, scope, selection, mode, forbidden, false); }
        static string Normal(string value) { return (value ?? "").Replace("\r\n", "\n").Trim(); }
    }
}
