using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;

// 仅使用虚构材料和自有窗口；读取助手时保持 WPF 消息循环运行，结束后自动关闭。
public static class ContextProbeFixture {
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    sealed class Sample {
        public string Name, Document, Selection, ExpectedContext, Rule;
        public Sample(string name, string document, string selection, string expectedContext, string rule) {
            Name=name; Document=document; Selection=selection; ExpectedContext=expectedContext; Rule=rule;
        }
    }
    static string Normal(string value) { return (value ?? "").Replace("\r\n", "\n").Trim(); }
    static string LongText(int length) { return "测试词" + new string('甲', length-3); }
    [STAThread]
    public static void Main(string[] args) {
        Console.OutputEncoding = new UTF8Encoding(false);
        if(args.Length != 1) { Console.Error.WriteLine("需要传入原生上下文助手路径。"); Environment.ExitCode=2; return; }
        string paragraph="这是虚构的段落诊断材料。测试词位于段落中间，前后文字都应该作为可信上下文。";
        string first="前一段只作为边界对照。", middle="目标段落含有测试词，应当只使用这一段。", last="后一段不能混入上下文。";
        string multiple=first+"\r\n"+middle+"\r\n"+last;
        var samples=new[] {
            new Sample("单段部分选区",paragraph,"测试词",paragraph,"取得上下文"),
            new Sample("单段末尾换行",paragraph+"\r\n","测试词",paragraph,"取得上下文"),
            new Sample("单段末尾文字与表情一起选中","虚构签名🙂","签名🙂","虚构签名🙂","取得上下文"),
            new Sample("单段只选末尾表情","虚构签名🙂","🙂","虚构签名🙂","取得上下文"),
            new Sample("单段签名和表情全选","虚构签名🙂","虚构签名🙂","虚构签名🙂","取得上下文"),
            new Sample("多段中选择词语",multiple,"测试词",middle,"不得混入邻段"),
            new Sample("选区跨越段落",multiple,first+"\r\n"+middle,"","跨段"),
            new Sample("单段5999字符",LongText(5999),"测试词",LongText(5999),"取得上下文"),
            new Sample("单段6000字符",LongText(6000),"测试词",LongText(6000),"取得上下文"),
            new Sample("6000字符段落末尾换行",LongText(6000)+"\r\n","测试词",LongText(6000),"取得上下文"),
            new Sample("单段6001字符",LongText(6001),"测试词","","超限"),
            new Sample("截断处为空白且后有正文",LongText(6000)+" 尾部正文","测试词","","超限")
        };
        var json=new JavaScriptSerializer(); var results=new List<object>();
        var box=new TextBox { AcceptsReturn=true, TextWrapping=TextWrapping.Wrap, FontSize=18, Margin=new Thickness(12) };
        var window=new Window { Title="PickGloss 原生上下文回归（虚构材料）", Width=760,Height=360,Left=80,Top=90,Topmost=true,Content=box };
        window.Loaded+=async(sender,e)=>{
            try {
                foreach(var sample in samples) {
                    try {
                        box.Text=sample.Document; window.Activate(); box.Focus();
                        int start=box.Text.IndexOf(sample.Selection,StringComparison.Ordinal);
                        if(start<0) throw new Exception("虚构选区未出现在夹具正文中。");
                        box.Select(start,sample.Selection.Length);
                        await Task.Delay(250);
                        bool foreground=GetForegroundWindow()==new WindowInteropHelper(window).Handle;
                        // 首次启动可能受 Windows 前台窗口规则限制，给测试执行者留出激活窗口的时间。
                        if(results.Count==0) for(int retry=0;retry<300 && !foreground;retry++) {
                            await Task.Delay(100);
                            foreground=GetForegroundWindow()==new WindowInteropHelper(window).Handle;
                        }
                        if(!foreground) { results.Add(new { name=sample.Name, foreground=false, error="夹具未成为前台窗口。" }); continue; }
                        box.Focus(); box.Select(start,sample.Selection.Length);
                        await Task.Delay(100);
                        var point=box.PointToScreen(box.GetRectFromCharacterIndex(start).TopLeft);
                        string request=json.Serialize(new { text=Normal(sample.Selection), x=point.X,y=point.Y,excludePids="" });
                        var info=new ProcessStartInfo(args[0]) { UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true,StandardOutputEncoding=new UTF8Encoding(false) };
                        using(var process=Process.Start(info)) {
                            var bytes=Encoding.UTF8.GetBytes(request+"\n");
                            process.StandardInput.BaseStream.Write(bytes,0,bytes.Length); process.StandardInput.BaseStream.Flush(); process.StandardInput.Close();
                            var read=process.StandardOutput.ReadToEndAsync();
                            var error=process.StandardError.ReadToEndAsync();
                            if(await Task.WhenAny(read,Task.Delay(2500))!=read) { process.Kill(); throw new Exception("原生助手超时，未形成有效验证。"); }
                            string output=await read; await error;
                            if(!process.WaitForExit(500)) { process.Kill(); throw new Exception("原生助手未退出。"); }
                            results.Add(new { name=sample.Name, rule=sample.Rule,foreground=foreground,expectedSelection=Normal(sample.Selection),expectedContext=sample.ExpectedContext,helperExitCode=process.ExitCode,response=json.DeserializeObject(output) });
                        }
                    } catch(Exception error) { results.Add(new { name=sample.Name,error=error.Message }); }
                }
                Console.WriteLine(json.Serialize(new { description="真实 UIA 读取虚构 WPF 文本；不读取或操作用户窗口。",results=results }));
            } finally { window.Close(); }
        };
        new Application().Run(window);
    }
}
