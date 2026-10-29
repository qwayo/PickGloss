using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Automation;

// 同步 UIA 事件代际与状态输出；测试夹具也使用这一生产守卫确定性覆盖竞态。
public sealed class BrowserContextObservationGate {
    readonly object synchronizationRoot;
    long generation;
    bool invalid;
    public BrowserContextObservationGate(object root) { synchronizationRoot=root??new object(); }
    public long Begin() { lock(synchronizationRoot) return generation; }
    public bool IsInvalid { get { lock(synchronizationRoot) return invalid; } }
    public long Observe(Action<bool> commit, bool latchInvalid) {
        lock(synchronizationRoot) {
            generation++;
            bool wasInvalid=invalid;
            if(latchInvalid) invalid=true;
            if(commit!=null) commit(wasInvalid);
            return generation;
        }
    }
    public bool TryCommit(long observedGeneration, Action commit, bool latchInvalid) {
        lock(synchronizationRoot) {
            if(invalid || generation!=observedGeneration) return false;
            if(latchInvalid) invalid=true;
            if(commit!=null) commit();
            return true;
        }
    }
}

// 独立 MTA 进程只读取 Edge 的 UIA 身份和滚动状态，不读取页面内容。
public static class BrowserContext {
    const int MaxNodes = 768, MaxDepth = 24, MaxScrollNodes = 48, MaxScrollDepth = 6;
    const int PollMilliseconds = 300, HeartbeatMilliseconds = 500;
    const int MaxPendingCommands = 16, MaxCommandLength = 256;
    const uint SnapshotProcess = 0x00000002;
    static readonly object outputGate = new object();
    static readonly BrowserContextObservationGate observations = new BrowserContextObservationGate(outputGate);
    static readonly object queueGate = new object();
    static readonly Queue<string> commands = new Queue<string>();
    static readonly AutoResetEvent wake = new AutoResetEvent(false);
    static AutomationElement windowRoot, baselineDocument, baselineTabElement;
    static List<ScrollProbe> baselineScrollNodes;
    static string baselineTab, baselineDoc, baselineScroll;
    static StructureChangedEventHandler windowStructureHandler, documentStructureHandler;
    static AutomationPropertyChangedEventHandler selectionHandler, scrollHandler;
    static volatile bool readySent, readyValid, inputClosed, setupEventOccurred, outputFailed;
    static volatile string pendingInvalidReason;
    static string lastState, lastReason;
    static long lastConfirmedGeneration;
    static string pendingSnapshotFailure;
    static long pendingSnapshotGeneration, pendingSnapshotSince;
    static long nextHeartbeat;

    [DllImport("user32.dll", SetLastError=true)] static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll", SetLastError=true)] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll", SetLastError=true)] static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll", SetLastError=true)] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool Process32FirstW(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool Process32NextW(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);

    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    struct ProcessEntry {
        public uint size, usage, processId;
        public IntPtr defaultHeapId;
        public uint moduleId, threadCount, parentProcessId;
        public int basePriority;
        public uint flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string executable;
    }
    sealed class NodeAtDepth {
        public AutomationElement element;
        public int depth;
        public NodeAtDepth(AutomationElement value, int level) { element=value; depth=level; }
    }
    sealed class Snapshot {
        public string tab, document, scroll;
        public AutomationElement documentElement;
        public AutomationElement tabElement;
        public List<ScrollProbe> scrollNodes;
        public bool minimized;
        public string invalid;
    }
    sealed class ScrollProbe {
        public AutomationElement element;
        public ScrollPattern pattern;
        public string runtime;
    }

    static string EscapeNonce(string value) { return value; }
    static bool WriteProtocolLocked(string line) {
        if(outputFailed) return false;
        try { Console.WriteLine(line); Console.Out.Flush(); return true; }
        catch { outputFailed=true; return false; }
    }
    static void WriteLine(string line) {
        lock(outputGate) { WriteProtocolLocked(line); }
    }
    static void WriteReady(bool valid, string state, string reason) {
        lock(outputGate) {
            WriteProtocolLocked("{\"type\":\"ready\",\"valid\":"+(valid?"true":"false")+",\"state\":\""+state+"\",\"reason\":\""+reason+"\"}");
            lastState=state; lastReason=reason; readyValid=valid && state=="active"; readySent=true;
        }
    }
    static bool WriteReadyActive(long generation) {
        bool written=false;
        bool current=observations.TryCommit(generation,delegate {
            if(setupEventOccurred) return;
            lastConfirmedGeneration=generation;
            WriteReady(true,"active","tab"); written=true;
        },false);
        return current && written;
    }
    static void WriteStateLocked(string state, string reason, bool always) {
        if(!readySent || (observations.IsInvalid && state!="invalid")) return;
        if(!always && lastState==state && lastReason==reason) return;
        WriteProtocolLocked("{\"type\":\"state\",\"state\":\""+state+"\",\"reason\":\""+reason+"\"}");
        lastState=state; lastReason=reason;
    }
    static void WriteEventStateLocked(string reason) {
        if(!readySent) return;
        WriteProtocolLocked("{\"type\":\"state\",\"state\":\"inactive\",\"reason\":\""+reason+"\"}");
        lastState="inactive"; lastReason=reason;
    }
    static void WriteHeartbeat() { WriteLine("{\"type\":\"heartbeat\"}"); }
    static void WriteCheckpointCurrent(string nonce) {
        lock(outputGate) {
            bool invalid=observations.IsInvalid;
            bool confirmed=lastConfirmedGeneration==observations.Begin();
            string state=invalid?"invalid":(confirmed?(lastState??"inactive"):"inactive");
            string reason=invalid?(pendingInvalidReason??"unknown"):(confirmed?(lastReason??"unknown"):"unknown");
            bool valid=!invalid && state!="invalid";
            WriteProtocolLocked("{\"type\":\"checkpoint\",\"nonce\":\""+EscapeNonce(nonce)+"\",\"valid\":"+(valid?"true":"false")+",\"state\":\""+state+"\",\"reason\":\""+reason+"\"}");
        }
    }
    static void EnsureInvalidOutput() {
        lock(outputGate) {
            if(readyValid && observations.IsInvalid && lastState!="invalid")
                WriteStateLocked("invalid",pendingInvalidReason??"unknown",true);
        }
    }
    static void FailFromCallback(string reason) {
        observations.Observe(delegate(bool wasInvalid) {
            if(wasInvalid) return;
            pendingInvalidReason=reason;
            if(readySent && readyValid) WriteEventStateLocked(reason);
        },true);
        wake.Set();
    }
    static void QueueCheck(string reason) {
        // 根节点结构通知还包括工具栏等无关变化，不能据此翻转已确认页面的显隐。
        if(reason=="tree") { observations.Observe(null,false); wake.Set(); return; }
        observations.Observe(delegate(bool wasInvalid) {
            if(wasInvalid) return;
            if(!readySent) setupEventOccurred=true;
            else if(readyValid) WriteStateLocked("inactive",reason,true);
        },false);
        wake.Set();
    }
    static void OnWindowStructureChanged(object sender, StructureChangedEventArgs args) { QueueCheck("tree"); }
    static void OnSelectionChanged(object sender, AutomationPropertyChangedEventArgs args) { QueueCheck("tab"); }
    static void OnDocumentStructureChanged(object sender, StructureChangedEventArgs args) { FailFromCallback("tree"); }
    static void OnScrollChanged(object sender, AutomationPropertyChangedEventArgs args) { FailFromCallback("scroll"); }

    static string RuntimeKey(AutomationElement element) {
        int[] id=element.GetRuntimeId();
        if(id==null || id.Length==0) throw new InvalidOperationException();
        StringBuilder value=new StringBuilder();
        for(int i=0;i<id.Length;i++) { if(i>0)value.Append(','); value.Append(id[i].ToString(CultureInfo.InvariantCulture)); }
        return value.ToString();
    }
    static void PushChildren(Stack<NodeAtDepth> pending, AutomationElement parent, int depth, TreeWalker walker) {
        AutomationElement child=walker.GetFirstChild(parent);
        int siblings=0;
        while(child!=null) {
            if(++siblings>MaxNodes) throw new InvalidOperationException();
            pending.Push(new NodeAtDepth(child, depth));
            child=walker.GetNextSibling(child);
        }
    }
    static TreeWalker ChromeIdentityWalker(AutomationElement root) {
        // 在提供者侧投影到身份节点；Document/Edit 截断正文，避免逐控件跨进程遍历。
        return new TreeWalker(new AndCondition(Automation.ControlViewCondition,new OrCondition(
            new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.TabItem),
            new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.Document),
            new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.Edit),
            new PropertyCondition(AutomationElement.ControlTypeProperty,root.Current.ControlType))));
    }
    static void FindSelectedTabs(AutomationElement root, List<string> selected, List<AutomationElement> elements=null) {
        TreeWalker walker=ChromeIdentityWalker(root);
        Stack<NodeAtDepth> pending=new Stack<NodeAtDepth>(); PushChildren(pending,root,1,walker); int visited=0;
        while(pending.Count>0) {
            NodeAtDepth item=pending.Pop(); AutomationElement element=item.element;
            if(++visited>MaxNodes || item.depth>MaxDepth) throw new InvalidOperationException();
            ControlType type=element.Current.ControlType;
            if(type==ControlType.Document || type==ControlType.Edit) continue;
            if(type==ControlType.TabItem) {
                object raw;
                if(element.TryGetCurrentPattern(SelectionItemPattern.Pattern,out raw) && ((SelectionItemPattern)raw).Current.IsSelected) {
                    selected.Add(RuntimeKey(element));
                    if(elements!=null) elements.Add(element);
                }
                continue;
            }
            PushChildren(pending,element,item.depth+1,walker);
        }
    }
    static void FindVisibleDocuments(AutomationElement root, List<AutomationElement> documents) {
        TreeWalker walker=ChromeIdentityWalker(root);
        Stack<NodeAtDepth> pending=new Stack<NodeAtDepth>(); PushChildren(pending,root,1,walker); int visited=0;
        while(pending.Count>0) {
            NodeAtDepth item=pending.Pop(); AutomationElement element=item.element;
            if(++visited>MaxNodes || item.depth>MaxDepth) throw new InvalidOperationException();
            ControlType type=element.Current.ControlType;
            if(type==ControlType.Document) { if(!element.Current.IsOffscreen) documents.Add(element); continue; }
            if(type==ControlType.Edit || type==ControlType.TabItem) continue;
            PushChildren(pending,element,item.depth+1,walker);
        }
    }
    static List<ScrollProbe> FindScrollNodes(AutomationElement document) {
        Queue<NodeAtDepth> pending=new Queue<NodeAtDepth>(); pending.Enqueue(new NodeAtDepth(document,0));
        List<ScrollProbe> found=new List<ScrollProbe>(); int visited=0;
        while(pending.Count>0 && visited<MaxScrollNodes) {
            NodeAtDepth item=pending.Dequeue(); AutomationElement element=item.element;
            if(item.depth>MaxScrollDepth) continue;
            visited++;
            object raw;
            if(element.TryGetCurrentPattern(ScrollPattern.Pattern,out raw))
                found.Add(new ScrollProbe { element=element, pattern=(ScrollPattern)raw, runtime=RuntimeKey(element) });
            if(item.depth==MaxScrollDepth || visited>=MaxScrollNodes) continue;
            AutomationElement child=TreeWalker.ControlViewWalker.GetFirstChild(element);
            int available=MaxScrollNodes-visited;
            while(child!=null && available-->0) {
                pending.Enqueue(new NodeAtDepth(child,item.depth+1));
                child=TreeWalker.ControlViewWalker.GetNextSibling(child);
            }
        }
        if(found.Count==0) throw new InvalidOperationException();
        return found;
    }
    static string GetScrollSnapshot(List<ScrollProbe> nodes) {
        if(nodes==null || nodes.Count==0) throw new InvalidOperationException();
        StringBuilder state=new StringBuilder();
        foreach(ScrollProbe node in nodes) {
            ScrollPattern.ScrollPatternInformation info=node.pattern.Current;
            state.Append(node.runtime).Append(':')
                .Append(info.HorizontalScrollPercent.ToString("R",CultureInfo.InvariantCulture)).Append(':')
                .Append(info.VerticalScrollPercent.ToString("R",CultureInfo.InvariantCulture)).Append(':')
                .Append(info.HorizontalViewSize.ToString("R",CultureInfo.InvariantCulture)).Append(':')
                .Append(info.VerticalViewSize.ToString("R",CultureInfo.InvariantCulture)).Append(':')
                .Append(info.HorizontallyScrollable?"1":"0").Append(':').Append(info.VerticallyScrollable?"1":"0").Append('|');
        }
        return state.ToString();
    }
    static Snapshot ReadSnapshot(IntPtr hwnd, uint sourcePid, string expectedTab, string expectedDocument) {
        Snapshot result=new Snapshot();
        if(!IsWindow(hwnd)) { result.invalid="window"; return result; }
        uint ownerPid; GetWindowThreadProcessId(hwnd,out ownerPid);
        if(ownerPid!=sourcePid) { result.invalid="window"; return result; }
        if(IsIconic(hwnd) || !IsWindowVisible(hwnd)) { result.minimized=true; return result; }
        AutomationElement root=AutomationElement.FromHandle(hwnd);
        if(root==null || root.Current.ProcessId!=sourcePid) { result.invalid="window"; return result; }
        List<string> selected=new List<string>(); List<AutomationElement> tabElements=new List<AutomationElement>();
        FindSelectedTabs(root,selected,tabElements);
        if(selected.Count>1) { result.invalid="ambiguous"; return result; }
        if(selected.Count==0) return result;
        result.tab=selected[0];
        result.tabElement=tabElements[0];
        // 切换到其他标签时无需探测其他网页；仅记录其 UIA 身份，原文档订阅仍持续生效。
        if(expectedTab!=null && result.tab!=expectedTab) return result;
        try {
            List<AutomationElement> documents=new List<AutomationElement>(); FindVisibleDocuments(root,documents);
            if(documents.Count!=1) result.invalid=documents.Count>1?"ambiguous":"unknown";
            else {
                AutomationElement document=documents[0];
                if(document.Current.ProcessId!=sourcePid) result.invalid="unknown";
                else {
                    result.document=RuntimeKey(document); result.documentElement=document;
                    if(expectedDocument==null || result.document==expectedDocument) {
                        result.scrollNodes=expectedDocument==null?FindScrollNodes(document):baselineScrollNodes;
                        result.scroll=GetScrollSnapshot(result.scrollNodes);
                    }
                }
            }
        } catch { result.invalid="unknown"; }
        // 包括文档缺失和异常路径，均不能把读到一半的其他标签文档当作原页导航。
        if(expectedTab!=null) {
            List<string> confirmedTabs=new List<string>(); FindSelectedTabs(root,confirmedTabs);
            if(confirmedTabs.Count!=1 || confirmedTabs[0]!=result.tab) { result.tab=null; result.invalid=null; }
        }
        return result;
    }
    static string ValidateSnapshot(Snapshot snapshot, bool initial) {
        if(snapshot.invalid!=null) return snapshot.invalid;
        if(snapshot.minimized) return initial?"window":null;
        if(String.IsNullOrEmpty(snapshot.tab)) return initial?"unknown":null;
        if(initial && (String.IsNullOrEmpty(snapshot.document) || String.IsNullOrEmpty(snapshot.scroll))) return "unknown";
        return null;
    }
    static bool CommitObservedState(long generation, string state, string reason) {
        return observations.TryCommit(generation,delegate {
            pendingSnapshotFailure=null;
            lastConfirmedGeneration=generation;
            WriteStateLocked(state,reason,false);
        },false);
    }
    static string InvalidateObserved(string reason, long generation) {
        bool committed=observations.TryCommit(generation,delegate {
            pendingInvalidReason=reason;
            WriteStateLocked("invalid",reason,true);
        },true);
        if(committed) return reason;
        return observations.IsInvalid?(pendingInvalidReason??reason):null;
    }
    static string RejectSnapshot(string reason, long generation) {
        if(reason!="unknown" && reason!="ambiguous") return InvalidateObserved(reason,generation);
        // 仅无法查询的中间状态允许有界复核；已确认同标签文档替换、滚动等仍立即失效。
        lock(outputGate) {
            if(observations.IsInvalid) return pendingInvalidReason??reason;
            if(observations.Begin()!=generation) return null;
            long now=Stopwatch.GetTimestamp();
            if(pendingSnapshotFailure==reason && pendingSnapshotGeneration==generation &&
                (now-pendingSnapshotSince)*1000/Stopwatch.Frequency>=200) return InvalidateObserved(reason,generation);
            if(pendingSnapshotFailure!=reason || pendingSnapshotGeneration!=generation) {
                pendingSnapshotFailure=reason; pendingSnapshotGeneration=generation; pendingSnapshotSince=now;
            }
            WriteStateLocked("inactive",reason,false); return null;
        }
    }
    static string EvaluateCurrent(IntPtr hwnd, uint sourcePid) {
        long sampleGeneration=observations.Begin();
        if(observations.IsInvalid) return pendingInvalidReason??"unknown";
        Snapshot snapshot;
        try { snapshot=ReadSnapshot(hwnd,sourcePid,baselineTab,baselineDoc); }
        catch { return RejectSnapshot("unknown",sampleGeneration); }
        if(snapshot.invalid!=null) return RejectSnapshot(snapshot.invalid,sampleGeneration);
        if(snapshot.minimized) { CommitObservedState(sampleGeneration,"inactive","window"); return null; }
        if(String.IsNullOrEmpty(snapshot.tab)) return RejectSnapshot("unknown",sampleGeneration);
        if(snapshot.tab!=baselineTab) { CommitObservedState(sampleGeneration,"inactive","tab"); return null; }
        if(String.IsNullOrEmpty(snapshot.document) || snapshot.document!=baselineDoc) return RejectSnapshot("navigation",sampleGeneration);
        if(snapshot.scroll!=baselineScroll) return InvalidateObserved("scroll",sampleGeneration);
        if(String.IsNullOrEmpty(snapshot.scroll)) return RejectSnapshot("unknown",sampleGeneration);
        CommitObservedState(sampleGeneration,"active","tab"); return null;
    }
    static string Invalidate(string reason) {
        observations.Observe(delegate(bool wasInvalid) {
            if(wasInvalid) return;
            pendingInvalidReason=reason;
            WriteStateLocked("invalid",reason,true);
        },true);
        return pendingInvalidReason??reason;
    }
    static void Subscribe(AutomationElement root, AutomationElement document) {
        windowStructureHandler=OnWindowStructureChanged;
        selectionHandler=OnSelectionChanged;
        documentStructureHandler=OnDocumentStructureChanged;
        scrollHandler=OnScrollChanged;
        Automation.AddStructureChangedEventHandler(root,TreeScope.Subtree,windowStructureHandler);
        Automation.AddAutomationPropertyChangedEventHandler(baselineTabElement,TreeScope.Element,selectionHandler,SelectionItemPattern.IsSelectedProperty);
        Automation.AddStructureChangedEventHandler(document,TreeScope.Subtree,documentStructureHandler);
        Automation.AddAutomationPropertyChangedEventHandler(document,TreeScope.Subtree,scrollHandler,
            ScrollPattern.HorizontalScrollPercentProperty,ScrollPattern.VerticalScrollPercentProperty);
    }
    static void Unsubscribe() {
        // UIA 订阅、取消订阅和所有查询只由 MTA 主循环调用。
        try { if(windowRoot!=null && windowStructureHandler!=null) Automation.RemoveStructureChangedEventHandler(windowRoot,windowStructureHandler); } catch { }
        try { if(baselineTabElement!=null && selectionHandler!=null) Automation.RemoveAutomationPropertyChangedEventHandler(baselineTabElement,selectionHandler); } catch { }
        try { if(baselineDocument!=null && documentStructureHandler!=null) Automation.RemoveStructureChangedEventHandler(baselineDocument,documentStructureHandler); } catch { }
        try { if(baselineDocument!=null && scrollHandler!=null) Automation.RemoveAutomationPropertyChangedEventHandler(baselineDocument,scrollHandler); } catch { }
        windowRoot=null; baselineDocument=null; baselineScrollNodes=null;
    }
    static bool ParentIs(uint child, uint expectedParent) {
        IntPtr snapshot=CreateToolhelp32Snapshot(SnapshotProcess,0);
        if(snapshot==new IntPtr(-1)) return false;
        try {
            ProcessEntry entry=new ProcessEntry(); entry.size=(uint)Marshal.SizeOf(typeof(ProcessEntry));
            if(!Process32FirstW(snapshot,ref entry)) return false;
            do { if(entry.processId==child) return entry.parentProcessId==expectedParent; }
            while(Process32NextW(snapshot,ref entry));
        } finally { CloseHandle(snapshot); }
        return false;
    }
    static bool IsEdgeProcess(uint pid) {
        try { using(Process process=Process.GetProcessById((int)pid)) return String.Equals(process.ProcessName,"msedge",StringComparison.OrdinalIgnoreCase); }
        catch { return false; }
    }
    static string ReadBoundedLine(out bool tooLong) {
        StringBuilder line=new StringBuilder(MaxCommandLength); bool received=false; tooLong=false;
        while(true) {
            int value=Console.In.Read();
            if(value<0) return received || tooLong?line.ToString():null;
            if(value=='\n') return line.ToString();
            received=true;
            if(line.Length<MaxCommandLength) line.Append((char)value); else tooLong=true;
        }
    }
    static bool EnqueueCheck(string nonce) {
        bool overflow=false;
        lock(queueGate) {
            if(inputClosed) return false;
            if(commands.Count>=MaxPendingCommands) overflow=true;
            else commands.Enqueue(nonce);
        }
        if(overflow) { Invalidate("unknown"); return false; }
        wake.Set(); return true;
    }
    static void ReadInput() {
        try {
            while(true) {
                bool tooLong; string line=ReadBoundedLine(out tooLong);
                if(line==null) break;
                if(tooLong) { Invalidate("unknown"); break; }
                if(line.EndsWith("\r")) line=line.Substring(0,line.Length-1);
                if(line.IndexOf('\r')>=0) { Invalidate("unknown"); break; }
                Match match=Regex.Match(line,"^\\s*\\{\\s*\"type\"\\s*:\\s*\"check\"\\s*,\\s*\"nonce\"\\s*:\\s*\"([1-9][0-9]{0,19})\"\\s*\\}\\s*$",RegexOptions.CultureInvariant);
                if(!match.Success || !EnqueueCheck(match.Groups[1].Value)) break;
            }
        } catch { }
        lock(queueGate) inputClosed=true;
        wake.Set();
    }
    static bool TakeCommand(out string nonce) {
        lock(queueGate) {
            if(commands.Count>0) { nonce=commands.Dequeue(); return true; }
        }
        nonce=null; return false;
    }
    static bool IsInputClosed() { lock(queueGate) return inputClosed; }
    static bool IsInvalid() { return observations.IsInvalid; }

    [MTAThread]
    public static void Main(string[] args) {
        IntPtr hwnd=IntPtr.Zero; uint sourcePid=0, ownerPid=0;
        string failure="window";
        try {
            if(args!=null && args.Length==2 && args[0]=="--standby") {
                uint standbyOwner;
                if(!UInt32.TryParse(args[1],NumberStyles.None,CultureInfo.InvariantCulture,out standbyOwner) ||
                    !ParentIs((uint)Process.GetCurrentProcess().Id,standbyOwner)) throw new InvalidOperationException();
                // 只预热 CLR/COM/UIA，不绑定或遍历任何来源页面。
                if(AutomationElement.RootElement==null) throw new InvalidOperationException();
                WriteLine("{\"type\":\"standby\"}");
                bool tooLong; string start=ReadBoundedLine(out tooLong);
                if(start==null) return;
                if(tooLong) throw new InvalidOperationException();
                if(start.EndsWith("\r")) start=start.Substring(0,start.Length-1);
                Match begin=Regex.Match(start,"^start ([1-9][0-9]{0,19}) ([1-9][0-9]{0,9})$",RegexOptions.CultureInvariant);
                if(!begin.Success) throw new InvalidOperationException();
                args=new string[] { begin.Groups[1].Value,begin.Groups[2].Value,standbyOwner.ToString(CultureInfo.InvariantCulture) };
            }
            if(args==null || args.Length!=3) throw new InvalidOperationException();
            ulong rawHandle; uint rawSource, rawOwner;
            if(!UInt64.TryParse(args[0],NumberStyles.None,CultureInfo.InvariantCulture,out rawHandle) || rawHandle==0 ||
                !UInt32.TryParse(args[1],NumberStyles.None,CultureInfo.InvariantCulture,out rawSource) || rawSource==0 ||
                !UInt32.TryParse(args[2],NumberStyles.None,CultureInfo.InvariantCulture,out rawOwner) || rawOwner==0 || rawOwner==rawSource) throw new InvalidOperationException();
            hwnd=new IntPtr(unchecked((long)rawHandle)); sourcePid=rawSource; ownerPid=rawOwner;
            uint windowPid; GetWindowThreadProcessId(hwnd,out windowPid);
            if(windowPid!=sourcePid || !IsEdgeProcess(sourcePid) || !ParentIs((uint)Process.GetCurrentProcess().Id,ownerPid)) throw new InvalidOperationException();
            windowRoot=AutomationElement.FromHandle(hwnd);
            if(windowRoot==null || windowRoot.Current.ProcessId!=sourcePid) throw new InvalidOperationException();
            Snapshot first=ReadSnapshot(hwnd,sourcePid,null,null);
            string initialError=ValidateSnapshot(first,true);
            if(initialError!=null) { failure=initialError; throw new InvalidOperationException(); }
            failure="unknown";
            baselineTab=first.tab; baselineDoc=first.document; baselineScroll=first.scroll; baselineScrollNodes=first.scrollNodes;
            baselineDocument=first.documentElement; baselineTabElement=first.tabElement;
            if(baselineDocument==null || baselineTabElement==null || RuntimeKey(baselineDocument)!=baselineDoc) throw new InvalidOperationException();
            Subscribe(windowRoot,baselineDocument);
            long baselineGeneration=observations.Begin();
            Snapshot second=ReadSnapshot(hwnd,sourcePid,baselineTab,baselineDoc);
            if(second.invalid!=null || second.minimized || second.tab!=baselineTab || second.document!=baselineDoc ||
                second.scroll!=baselineScroll || IsInvalid() || setupEventOccurred || observations.Begin()!=baselineGeneration) {
                failure=second.invalid??(second.minimized?"window":(IsInvalid()?pendingInvalidReason:"tree")); throw new InvalidOperationException();
            }
            if(!WriteReadyActive(baselineGeneration)) { failure=pendingInvalidReason??"tree"; throw new InvalidOperationException(); }
            Thread reader=new Thread(ReadInput); reader.IsBackground=true; reader.Name="PickGloss BrowserContext input"; reader.Start();
            nextHeartbeat=Environment.TickCount+HeartbeatMilliseconds;
            long nextPoll=Environment.TickCount+PollMilliseconds;
            while(!IsInputClosed() && !IsInvalid()) {
                long now=Environment.TickCount;
                long due=Math.Min(unchecked(nextHeartbeat-now),unchecked(nextPoll-now));
                if(due<0) due=0;
                wake.WaitOne((int)Math.Min(due,250L));
                if(IsInputClosed() || IsInvalid()) break;
                string nonce;
                while(TakeCommand(out nonce)) {
                    if(String.IsNullOrEmpty(nonce)) { Invalidate("unknown"); break; }
                    string invalid=EvaluateCurrent(hwnd,sourcePid);
                    // 核对期间若只收到结构脏标记，有限重读；不能把上轮 active 当成本轮确认。
                    if(invalid==null && lastConfirmedGeneration!=observations.Begin()) invalid=EvaluateCurrent(hwnd,sourcePid);
                    WriteCheckpointCurrent(nonce);
                    if(invalid!=null) break;
                }
                if(IsInputClosed() || IsInvalid()) break;
                now=Environment.TickCount;
                if(unchecked(now-nextPoll)>=0) {
                    string invalid=EvaluateCurrent(hwnd,sourcePid);
                    if(invalid!=null) break;
                    nextPoll=Environment.TickCount+PollMilliseconds;
                }
                if(unchecked(now-nextHeartbeat)>=0) { WriteHeartbeat(); nextHeartbeat=now+HeartbeatMilliseconds; }
            }
        } catch {
            if(!readySent) WriteReady(false,"invalid",failure);
            else if(!IsInvalid()) Invalidate(failure);
        } finally {
            if(readyValid && !IsInputClosed() && !IsInvalid()) Invalidate("unknown");
            EnsureInvalidOutput();
            Unsubscribe();
        }
    }
}
