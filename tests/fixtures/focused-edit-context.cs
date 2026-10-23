using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Automation;
using System.Windows.Automation.Text;

// 只读检查前台单段编辑控件。签名、选区与助手输出只在内存中比较，不输出正文或窗口标题。
public static class FocusedEditContext {
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    static string Normal(string text) { return (text ?? "").Replace("\r\n", "\n").Trim(); }
    static bool HasBreak(string text) { return text.IndexOfAny(new[]{'\r','\n','\u0085','\u2028','\u2029'})>=0; }
    [MTAThread] public static void Main(string[] args) {
        Console.OutputEncoding=new UTF8Encoding(false);
        var json=new JavaScriptSerializer(); string stage="核对前台编辑控件";
        Environment.ExitCode=2;
        try {
            if(args.Length!=1) throw new ArgumentException();
            var hwnd=GetForegroundWindow(); uint pid; GetWindowThreadProcessId(hwnd,out pid);
            var element=AutomationElement.FocusedElement;
            if(element.Current.ProcessId!=pid || element.Current.IsPassword || element.Current.ControlType!=ControlType.Edit) throw new InvalidOperationException();
            object rawText,rawValue;
            if(!element.TryGetCurrentPattern(TextPattern.Pattern,out rawText) || !element.TryGetCurrentPattern(ValuePattern.Pattern,out rawValue)) throw new InvalidOperationException();
            var pattern=(TextPattern)rawText; var ranges=pattern.GetSelection();
            if(ranges==null || ranges.Length!=1) throw new InvalidOperationException();
            var selected=ranges[0]; string expected=Normal(selected.GetText(12001));
            // ValuePattern 作为独立期望值；控件范围还必须完整覆盖这个值及当前选区。
            stage="核对单段控件范围与选区";
            string value=Normal(((ValuePattern)rawValue).Current.Value);
            var scope=pattern.RangeFromChild(element); var scopeRaw=scope.GetText(6003);
            bool contains=scope.CompareEndpoints(TextPatternRangeEndpoint.Start,selected,TextPatternRangeEndpoint.Start)<=0 && scope.CompareEndpoints(TextPatternRangeEndpoint.End,selected,TextPatternRangeEndpoint.End)>=0;
            bool selectionOwnerMatches=selected.GetEnclosingElement().Equals(element),scopeOwnerMatches=scope.GetEnclosingElement().Equals(element);
            bool sameOwnerSelection=selectionOwnerMatches && scopeOwnerMatches && value.IndexOf(expected,StringComparison.Ordinal)>=0;
            if(expected.Length==0 || expected.Length>12000 || value.Length==0 || value.Length>6000 || HasBreak(value) || scopeRaw.Length>=6003 || Normal(scopeRaw)!=value || !(contains || sameOwnerSelection)) throw new InvalidOperationException();
            var bounds=element.Current.BoundingRectangle;
            stage="运行真实上下文助手";
            var info=new ProcessStartInfo(args[0]) {UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true,StandardOutputEncoding=new UTF8Encoding(false)};
            using(var process=Process.Start(info)) {
                var bytes=Encoding.UTF8.GetBytes(json.Serialize(new {text=expected,x=bounds.X+bounds.Width/2,y=bounds.Y+bounds.Height/2,excludePids=""})+"\n");
                var watch=Stopwatch.StartNew(); process.StandardInput.BaseStream.Write(bytes,0,bytes.Length); process.StandardInput.Close();
                var read=process.StandardOutput.ReadToEndAsync(); var error=process.StandardError.ReadToEndAsync();
                if(!process.WaitForExit(2500)) {process.Kill();throw new TimeoutException();}
                var result=json.Deserialize<Dictionary<string,object>>(read.Result);
                bool valid=result.ContainsKey("valid") && Convert.ToBoolean(result["valid"]);
                string text=result.ContainsKey("text")?Convert.ToString(result["text"]):"",context=result.ContainsKey("context")?Convert.ToString(result["context"]):"";
                string reason=result.ContainsKey("reason")?Convert.ToString(result["reason"]):"";
                bool sameWindow=GetForegroundWindow()==hwnd,selectionMatches=text==expected,contextMatches=context==value;
                Environment.ExitCode=!sameWindow || !valid || !selectionMatches?2:process.ExitCode==0 && contextMatches && reason.Length==0?0:1;
                Console.WriteLine(json.Serialize(new {description="前台单段编辑控件的局部选区应取得完整控件上下文；不输出正文",verdict=Environment.ExitCode==0?"通过":Environment.ExitCode==1?"失败":"前置条件不足",foregroundUnchanged=sameWindow,valid=valid,selectionLength=expected.Length,selectionEndsWithSupplementary=expected.Length>=2&&char.IsSurrogatePair(expected,expected.Length-2),nativeRangeContains=contains,selectionOwnerMatches=selectionOwnerMatches,scopeOwnerMatches=scopeOwnerMatches,expectedContextLength=value.Length,contextLength=context.Length,selectionMatches=selectionMatches,contextMatchesControlValue=contextMatches,reason=reason,elapsedMs=watch.ElapsedMilliseconds}));
            }
        } catch(Exception error) {Console.WriteLine(json.Serialize(new {verdict="前置条件不足",stage=stage,error=error.GetType().Name}));}
    }
}
