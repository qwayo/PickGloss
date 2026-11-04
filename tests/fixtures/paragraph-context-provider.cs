using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

// 无前台依赖的确定性范围提供方；只模拟 UIA 段落单位，不触碰桌面窗口或用户内容。
internal static class ContextParagraphTests {
    sealed class Paragraph {
        public int Start, End;
        public Paragraph(int start, int end) { Start = start; End = end; }
    }

    sealed class FakeProvider {
        readonly string text;
        readonly List<Paragraph> paragraphs;
        readonly object owner;
        readonly bool throwOnExpand, throwOnText, throwOnMove, expandToDocument;
        readonly int widerRangeStart, widerRangeEnd, widerMoveStart, widerMoveEnd;

        public FakeProvider(string value, int[] paragraphEnds, object ownerIdentity = null,
            bool failExpand = false, bool failText = false, bool failMove = false, bool wholeDocumentOnExpand = false,
            int expandedRangeStart = -1, int expandedRangeEnd = -1,
            int movedRangeStart = -1, int movedRangeEnd = -1) {
            text = value;
            owner = ownerIdentity ?? new object();
            throwOnExpand = failExpand; throwOnText = failText; throwOnMove = failMove;
            expandToDocument = wholeDocumentOnExpand;
            widerRangeStart = expandedRangeStart; widerRangeEnd = expandedRangeEnd;
            widerMoveStart = movedRangeStart; widerMoveEnd = movedRangeEnd;
            paragraphs = new List<Paragraph>();
            int start = 0;
            foreach (int end in paragraphEnds) { paragraphs.Add(new Paragraph(start, end)); start = end; }
            if (start < text.Length) paragraphs.Add(new Paragraph(start, text.Length));
            if (paragraphs.Count == 0) paragraphs.Add(new Paragraph(0, text.Length));
        }

        public FakeRange Range(int start, int end) { return new FakeRange(this, start, end); }

        internal string Text { get { return text; } }
        internal object Owner { get { return owner; } }
        internal bool ThrowOnExpand { get { return throwOnExpand; } }
        internal bool ThrowOnText { get { return throwOnText; } }
        internal bool ThrowOnMove { get { return throwOnMove; } }
        internal bool ExpandToDocument { get { return expandToDocument; } }
        internal int ExpandedRangeStart { get { return widerRangeStart; } }
        internal int ExpandedRangeEnd { get { return widerRangeEnd; } }
        internal int MovedRangeStart { get { return widerMoveStart; } }
        internal int MovedRangeEnd { get { return widerMoveEnd; } }
        internal int ParagraphIndexAt(int point, bool forEnd) {
            for (int i = 0; i < paragraphs.Count; i++) {
                var p = paragraphs[i];
                if (forEnd ? point <= p.End : point < p.End) return i;
            }
            return paragraphs.Count - 1;
        }
        internal Paragraph ParagraphAt(int index) { return paragraphs[index]; }
        internal int ParagraphCount { get { return paragraphs.Count; } }
    }

    sealed class FakeTextPatternSource : IContextTextPatternSource {
        readonly FakeProvider provider;
        readonly object child;
        readonly int childStart, childEnd;
        public int DocumentRangeCalls, RangeFromChildCalls;
        public FakeTextPatternSource(FakeProvider value, object childIdentity = null, int start = -1, int end = -1) {
            provider = value; child = childIdentity; childStart = start; childEnd = end;
        }
        public IContextTextRange GetDocumentRange() {
            DocumentRangeCalls++;
            return provider.Range(0, provider.Text.Length);
        }
        public IContextTextRange RangeFromChild(object selectedChild) {
            RangeFromChildCalls++;
            // UIA RangeFromChild 只接受后代；自身或其他控件必须拒绝。
            if (Object.Equals(selectedChild, provider.Owner)) throw new ArgumentException("RangeFromChild 不接受 TextPattern 自身。");
            if (child == null || !Object.Equals(child, selectedChild)) throw new ArgumentException("目标不是此 TextPattern 的后代。");
            return provider.Range(childStart, childEnd);
        }
    }

    sealed class FakeRange : IContextTextRange {
        readonly FakeProvider provider;
        int start, end;
        public FakeRange(FakeProvider value, int first, int last) { provider = value; start = first; end = last; }
        public IContextTextRange Clone() { return new FakeRange(provider, start, end); }
        public void ExpandToParagraph() {
            if (provider.ThrowOnExpand) throw new InvalidOperationException("虚构提供方拒绝段落扩展。");
            if (provider.ExpandToDocument) { start = 0; end = provider.Text.Length; return; }
            if (provider.ExpandedRangeStart >= 0) { start = provider.ExpandedRangeStart; end = provider.ExpandedRangeEnd; return; }
            // 按 UIA 规范将长范围归一化为起点所在的单个段落，而不是模拟业务期望的首尾段合并。
            int first = provider.ParagraphIndexAt(start, false);
            start = provider.ParagraphAt(first).Start; end = provider.ParagraphAt(first).End;
        }
        public int MoveEndpointByParagraph(ContextRangeEndpoint endpoint, int count) {
            if (provider.ThrowOnMove) throw new InvalidOperationException("虚构提供方拒绝移动段落端点。");
            if (endpoint == ContextRangeEndpoint.Start && count < 0 && provider.MovedRangeStart >= 0) { start = provider.MovedRangeStart; return count; }
            if (endpoint == ContextRangeEndpoint.End && count > 0 && provider.MovedRangeEnd >= 0) { end = provider.MovedRangeEnd; return count; }
            int current = endpoint == ContextRangeEndpoint.Start
                ? provider.ParagraphIndexAt(start, false)
                : provider.ParagraphIndexAt(end, true);
            int next = Math.Max(0, Math.Min(provider.ParagraphCount - 1, current + count));
            if (next == current) return 0;
            if (endpoint == ContextRangeEndpoint.Start) start = provider.ParagraphAt(next).Start;
            else end = provider.ParagraphAt(next).End;
            return next - current;
        }
        public int MoveEndpointByCharacter(ContextRangeEndpoint endpoint, int count) {
            int previous = endpoint == ContextRangeEndpoint.Start ? start : end;
            // UIA Character 是语言学单位；用 .NET 文本元素近似代理对和组合序列，不把 UTF-16 偏移差当返回值。
            var characterStarts = StringInfo.ParseCombiningCharacters(provider.Text);
            int next = previous, moved = 0;
            while (moved > count) {
                int priorStart = -1;
                foreach (int characterStart in characterStarts) {
                    if (characterStart >= next) break;
                    priorStart = characterStart;
                }
                if (priorStart < 0) break;
                next = priorStart; moved--;
            }
            while (moved < count) {
                int nextStart = provider.Text.Length;
                foreach (int characterStart in characterStarts) {
                    if (characterStart > next) { nextStart = characterStart; break; }
                }
                if (nextStart <= next || next >= provider.Text.Length) break;
                next = nextStart; moved++;
            }
            next = Math.Max(0, Math.Min(provider.Text.Length, next));
            if (endpoint == ContextRangeEndpoint.Start) start = Math.Min(next, end); else end = Math.Max(start, next);
            // UIA 返回移动的 TextUnit 数量，不是 UTF-16 偏移差。
            return moved;
        }
        public int CompareEndpoint(ContextRangeEndpoint endpoint, IContextTextRange otherRange, ContextRangeEndpoint otherEndpoint) {
            var other = otherRange as FakeRange;
            if (other == null || !Object.ReferenceEquals(provider, other.provider)) throw new InvalidOperationException("范围不属于同一提供方。");
            int left = endpoint == ContextRangeEndpoint.Start ? start : end;
            int right = otherEndpoint == ContextRangeEndpoint.Start ? other.start : other.end;
            return left.CompareTo(right);
        }
        public void MoveEndpointByRange(ContextRangeEndpoint endpoint, IContextTextRange otherRange, ContextRangeEndpoint otherEndpoint) {
            var other = otherRange as FakeRange;
            if (other == null || !Object.ReferenceEquals(provider, other.provider)) throw new InvalidOperationException("范围不属于同一提供方。");
            int value = otherEndpoint == ContextRangeEndpoint.Start ? other.start : other.end;
            if (endpoint == ContextRangeEndpoint.Start) start = Math.Min(value, end); else end = Math.Max(start, value);
        }
        public bool Compare(IContextTextRange otherRange) {
            var other = otherRange as FakeRange;
            return other != null && Object.ReferenceEquals(provider, other.provider) && start == other.start && end == other.end;
        }
        public string GetText(int maxLength) {
            if (provider.ThrowOnText) throw new InvalidOperationException("虚构提供方拒绝读取范围。");
            string value = provider.Text.Substring(start, Math.Max(0, end - start));
            return maxLength >= 0 && value.Length > maxLength ? value.Substring(0, maxLength) : value;
        }
        public object GetOwnerIdentity() { return provider.Owner; }
    }

    static int failures;
    static void Check(string name, bool condition, string detail = "") {
        if (condition) Console.WriteLine("通过：" + name);
        else { failures++; Console.WriteLine("失败：" + name + (detail.Length == 0 ? "" : "；" + detail)); }
    }
    static int[] Ends(string text, params string[] paragraphs) {
        var result = new List<int>(); int cursor = 0;
        foreach (var paragraph in paragraphs) { cursor += paragraph.Length; result.Add(cursor); }
        if (cursor != text.Length) throw new InvalidOperationException("段落边界与虚构正文不一致。");
        return result.ToArray();
    }
    static ContextReadResult Read(FakeProvider provider, int start, int end, bool edit = true) {
        return ParagraphContextReader.Read(provider.Range(start, end), provider.Range(0, provider.Text.Length), edit);
    }
    static ContextReadResult ReadWithoutScope(FakeProvider provider, int start, int end, bool edit) {
        return ParagraphContextReader.Read(provider.Range(start, end), null, edit);
    }

    public static void Main() {
        Console.OutputEncoding = new UTF8Encoding(false);
        var line = "第一行视觉换行后继续阅读，仍属于同一段落。";
        var sameParagraph = new FakeProvider(line, Ends(line, line));
        var lineRead = Read(sameParagraph, line.IndexOf("继续阅读", StringComparison.Ordinal), line.Length - 1);
        Check("同段视觉换行保留完整段落", lineRead.Context == line && lineRead.Reason.Length == 0);

        string p0 = "前一段。\n", p1 = "首段开头与跨段选区甲\n", p2 = "跨段选区乙与尾部。\n", p3 = "后一段。";
        string multi = p0 + p1 + p2 + p3;
        var multiProvider = new FakeProvider(multi, Ends(multi, p0, p1, p2, p3));
        int selectionStart = multi.IndexOf("跨段选区甲", StringComparison.Ordinal);
        int selectionEnd = multi.IndexOf("跨段选区乙", StringComparison.Ordinal) + "跨段选区乙".Length;
        var multiRead = Read(multiProvider, selectionStart, selectionEnd);
        Check("多段选区补齐首尾段和相邻段", multiRead.Context == multi && multiRead.Reason.Length == 0);

        string endBoundaryText = "前邻段。\n选区完整段落。\n后邻段。";
        var endBoundaryProvider = new FakeProvider(endBoundaryText, Ends(endBoundaryText, "前邻段。\n", "选区完整段落。\n", "后邻段。"));
        int beforeNextStart = endBoundaryText.IndexOf("选区完整段落。", StringComparison.Ordinal);
        int nextParagraphStart = beforeNextStart + "选区完整段落。\n".Length;
        var endBoundary = Read(endBoundaryProvider, beforeNextStart, nextParagraphStart);
        Check("排他结束端点在下一段起点时仍定位末段", endBoundary.Context == endBoundaryText);

        string wholeText = "前置段。\n目标段落完整选中。\n后置段。";
        string before = "前置段。\n", whole = "目标段落完整选中。\n", after = "后置段。";
        var wholeProvider = new FakeProvider(wholeText, Ends(wholeText, before, whole, after));
        int wholeStart = wholeText.IndexOf(whole, StringComparison.Ordinal);
        var wholeRead = Read(wholeProvider, wholeStart, wholeStart + whole.Length);
        Check("整段选择仍补充周边内容", wholeRead.Context == wholeText);

        string edgeText = "第一段。\n中间段。\n最后一段。";
        var edgeProvider = new FakeProvider(edgeText, Ends(edgeText, "第一段。\n", "中间段。\n", "最后一段。"));
        var firstRead = Read(edgeProvider, 0, "第一段。".Length);
        var lastStart = edgeText.LastIndexOf("最后一段。", StringComparison.Ordinal);
        var lastRead = Read(edgeProvider, lastStart, edgeText.Length);
        Check("首段不越界并加入下一段", firstRead.Context == "第一段。\n中间段。");
        Check("末段不越界并加入上一段", lastRead.Context == "中间段。\n最后一段。");

        string duplicate = "重复段。\n目标词。\n重复段。";
        var duplicateProvider = new FakeProvider(duplicate, Ends(duplicate, "重复段。\n", "目标词。\n", "重复段。"));
        int duplicateStart = duplicate.LastIndexOf("重复段。", StringComparison.Ordinal);
        var duplicateRead = Read(duplicateProvider, duplicateStart, duplicateStart + "重复段。".Length);
        Check("重复文本按原生选区范围定位", duplicateRead.Context == "目标词。\n重复段。");

        string noScopeText = "前一段。\n可信段落。\n后一段。";
        var noScopeProvider = new FakeProvider(noScopeText, Ends(noScopeText, "前一段。\n", "可信段落。\n", "后一段。"));
        int trustedStart = noScopeText.IndexOf("可信", StringComparison.Ordinal);
        var noScope = ReadWithoutScope(noScopeProvider, trustedStart, trustedStart + 2, true);
        Check("同一编辑控件在范围接口不可用时仍可读", noScope.Context == noScopeText && noScope.Reason.Length == 0);

        var documentFallbackProvider = new FakeProvider(noScopeText, Ends(noScopeText, "前一段。\n", "可信段落。\n", "后一段。"), wholeDocumentOnExpand: true);
        var documentFallback = ParagraphContextReader.Read(documentFallbackProvider.Range(trustedStart, trustedStart + 2),
            documentFallbackProvider.Range(0, noScopeText.Length), false);
        Check("文档范围退回全文时明确拒绝", documentFallback.Context.Length == 0 && documentFallback.Reason.Length > 0);

        string farText = "远处不应读取。\n前邻段。\n选定内容所在段。\n后邻段。\n远处私密段。";
        var farProvider = new FakeProvider(farText, Ends(farText, "远处不应读取。\n", "前邻段。\n", "选定内容所在段。\n", "后邻段。\n", "远处私密段。"), wholeDocumentOnExpand: true);
        int farStart = farText.IndexOf("选定内容", StringComparison.Ordinal);
        var unsupportedEdit = ParagraphContextReader.Read(farProvider.Range(farStart, farStart + 4), farProvider.Range(0, farText.Length), true);
        Check("编辑框段落单位退回全文时明确拒绝", unsupportedEdit.Context.Length == 0 && unsupportedEdit.Reason.Length > 0);

        string pageText = "远处段。\n本页前段。\n选中段。\n本页后段。\n远处尾段。";
        int pageStart = pageText.IndexOf("本页前段。", StringComparison.Ordinal);
        int pageEnd = pageText.IndexOf("远处尾段。", StringComparison.Ordinal);
        var pageProvider = new FakeProvider(pageText, Ends(pageText, "远处段。\n", "本页前段。\n", "选中段。\n", "本页后段。\n", "远处尾段。"),
            expandedRangeStart: pageStart, expandedRangeEnd: pageEnd);
        int pageSelection = pageText.IndexOf("选中段。", StringComparison.Ordinal);
        var pageFallback = ParagraphContextReader.Read(pageProvider.Range(pageSelection, pageSelection + "选中段。".Length), pageProvider.Range(0, pageText.Length), true);
        Check("Edit 范围内的 Page 级升级也明确拒绝", pageFallback.Context.Length == 0 && pageFallback.Reason.Length > 0);

        string movePageText = "远前段。\n近前段。\n选中段。\n近后段。\n远后段。";
        int moveCenterStart = movePageText.IndexOf("选中段。", StringComparison.Ordinal);
        int moveFarStart = movePageText.IndexOf("远前段。", StringComparison.Ordinal);
        int moveFarEnd = movePageText.Length;
        var movePageProvider = new FakeProvider(movePageText, Ends(movePageText, "远前段。\n", "近前段。\n", "选中段。\n", "近后段。\n", "远后段。"),
            movedRangeStart: moveFarStart, movedRangeEnd: moveFarEnd);
        var movePage = ParagraphContextReader.Read(movePageProvider.Range(moveCenterStart, moveCenterStart + "选中段。".Length), movePageProvider.Range(0, movePageText.Length), true);
        Check("段落移动升级到多段范围时不借入远处段落", movePage.Context == "选中段。");

        string emoji = "前🙂段。\n目标词🙂。\n后段。";
        var emojiProvider = new FakeProvider(emoji, Ends(emoji, "前🙂段。\n", "目标词🙂。\n", "后段。"));
        int emojiStart = emoji.IndexOf("词🙂", StringComparison.Ordinal);
        var emojiSelection = emojiProvider.Range(emojiStart, emojiStart + "词🙂".Length);
        var emojiRead = ParagraphContextReader.Read(emojiSelection, emojiProvider.Range(0, emoji.Length), true);
        Check("表情文本元素边界及选区范围完整保留", emojiRead.Context == emoji && emojiRead.Context.Contains("🙂") && emojiSelection.GetText(100) == "词🙂");

        string oversizedCore = new string('甲', 6001);
        var oversizedProvider = new FakeProvider(oversizedCore, Ends(oversizedCore, oversizedCore));
        var oversized = Read(oversizedProvider, 3000, 3001);
        Check("超过上限不截断段落", oversized.Context.Length == 0 && oversized.Reason.Contains("6000"));

        string boundedBefore = "甲";
        string boundedCenter = new string('乙', 5999);
        string boundedAfter = "丙";
        string boundedText = boundedBefore + boundedCenter + boundedAfter;
        var boundedProvider = new FakeProvider(boundedText, Ends(boundedText, boundedBefore, boundedCenter, boundedAfter));
        var bounded = Read(boundedProvider, boundedBefore.Length + 10, boundedBefore.Length + 11);
        Check("邻段超限时只取完整中心段", bounded.Context == boundedBefore + boundedCenter && bounded.Context.Length <= 6000);

        var selectionOwner = new object(); var otherOwner = new object();
        string split = "旁栏相同词。正文段落。";
        var crossProvider = new FakeProvider(split, Ends(split, "旁栏相同词。", "正文段落。"), selectionOwner);
        var wrongScope = new FakeProvider(split, Ends(split, "旁栏相同词。", "正文段落。"), otherOwner);
        var crossControl = ParagraphContextReader.Read(crossProvider.Range(split.IndexOf("相同词", StringComparison.Ordinal), split.IndexOf("相同词", StringComparison.Ordinal) + "相同词".Length), wrongScope.Range(0, split.Length), true);
        Check("跨控件范围明确拒绝", crossControl.Context.Length == 0 && crossControl.Reason.Length > 0);

        var expandFailureProvider = new FakeProvider("无法读取的正文。", new[] { "无法读取的正文。".Length }, failExpand: true);
        var expandFailure = Read(expandFailureProvider, 0, 2);
        Check("段落提供方异常明确拒绝", expandFailure.Context.Length == 0 && expandFailure.Reason.Length > 0);

        var textFailureProvider = new FakeProvider("无法读取的正文。", new[] { "无法读取的正文。".Length }, failText: true);
        var textFailure = Read(textFailureProvider, 0, 2);
        Check("文本读取异常明确拒绝", textFailure.Context.Length == 0 && textFailure.Reason.Length > 0);

        var moveFailureProvider = new FakeProvider("前段。中心段。后段。", Ends("前段。中心段。后段。", "前段。", "中心段。", "后段。"), failMove: true);
        var moveFailure = Read(moveFailureProvider, "前段。".Length + 1, "前段。".Length + 2);
        Check("相邻范围异常保留可靠中心段", moveFailure.Context == "中心段。" && moveFailure.Context.Length <= 6000);

        string documentText = "远处头段。\n前邻段。\n文档自身选中段。\n后邻段。\n远处尾段。";
        var documentOwner = new object();
        var documentProvider = new FakeProvider(documentText,
            Ends(documentText, "远处头段。\n", "前邻段。\n", "文档自身选中段。\n", "后邻段。\n", "远处尾段。"), documentOwner);
        var documentPattern = new FakeTextPatternSource(documentProvider);
        int documentSelectionStart = documentText.IndexOf("文档自身选中段。", StringComparison.Ordinal);
        var documentSelection = documentProvider.Range(documentSelectionStart, documentSelectionStart + "文档自身选中段。".Length);
        bool documentScopeReturned;
        var documentScope = ContextScopeResolver.GetRange(documentPattern, documentOwner, documentOwner, true, out documentScopeReturned);
        var documentRead = documentScope == null ? new ContextReadResult("", "无可靠边界") : ParagraphContextReader.Read(documentSelection, documentScope, false);
        Check("Document 自身选区用 DocumentRange 且只输出邻近段", documentScopeReturned && documentPattern.DocumentRangeCalls == 1 &&
            documentPattern.RangeFromChildCalls == 0 && documentRead.Context == "前邻段。\n文档自身选中段。\n后邻段。" &&
            !documentRead.Context.Contains("远处头段") && !documentRead.Context.Contains("远处尾段"));

        object foreignControl = new object();
        var foreignProvider = new FakeProvider(documentText,
            Ends(documentText, "远处头段。\n", "前邻段。\n", "文档自身选中段。\n", "后邻段。\n", "远处尾段。"), foreignControl);
        var documentPatternForForeign = new FakeTextPatternSource(documentProvider);
        int foreignSelectionStart = documentText.IndexOf("文档自身选中段。", StringComparison.Ordinal);
        var foreignSelection = foreignProvider.Range(foreignSelectionStart, foreignSelectionStart + "文档自身选中段。".Length);
        bool foreignScopeReturned;
        var foreignScope = ContextScopeResolver.GetRange(documentPatternForForeign, documentOwner, foreignControl, true, out foreignScopeReturned);
        var foreignEntryRead = ParagraphContextReader.Read(foreignSelection, foreignScope, false);
        Check("Document 后代解析失败时不回退读取全文或跨控件", !foreignScopeReturned && foreignScope == null &&
            documentPatternForForeign.DocumentRangeCalls == 0 && documentPatternForForeign.RangeFromChildCalls == 1 &&
            foreignEntryRead.Context.Length == 0 && foreignEntryRead.Reason.Length > 0);

        string supplementaryText = "甲🙂";
        var supplementaryProvider = new FakeProvider(supplementaryText, Ends(supplementaryText, supplementaryText));
        var supplementaryRange = supplementaryProvider.Range(0, supplementaryText.Length);
        int supplementaryMoved = supplementaryRange.MoveEndpointByCharacter(ContextRangeEndpoint.End, -1);
        string combiningText = "甲e\u0301";
        var combiningProvider = new FakeProvider(combiningText, Ends(combiningText, combiningText));
        var combiningRange = combiningProvider.Range(0, combiningText.Length);
        int combiningMoved = combiningRange.MoveEndpointByCharacter(ContextRangeEndpoint.End, -1);
        Check("Character 回退按文本元素计数且不切开代理对或组合字符", supplementaryMoved == -1 && supplementaryRange.GetText(20) == "甲" &&
            combiningMoved == -1 && combiningRange.GetText(20) == "甲");

        Console.WriteLine("原生范围提供方场景：22；失败：" + failures);
        Environment.ExitCode = failures == 0 ? 0 : 1;
    }
}
