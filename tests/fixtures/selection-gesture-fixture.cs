using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Automation;
using System.Windows.Forms;

// 自有传统 Windows 控件、虚构材料和只读 UIA；程序内部初始化选区，不向外部软件注入输入。
public static class SelectionGestureFixture {
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr hwnd,int message,IntPtr start,IntPtr end);
    static JavaScriptSerializer json = new JavaScriptSerializer();
    static void Send(Process child, object value) {
        var bytes=Encoding.UTF8.GetBytes(json.Serialize(value)+"\n");
        child.StandardInput.BaseStream.Write(bytes,0,bytes.Length); child.StandardInput.BaseStream.Flush();
    }
    static async Task<string> Line(Process child) {
        var read=child.StandardOutput.ReadLineAsync();
        if(await Task.WhenAny(read,Task.Delay(4000)).ConfigureAwait(false)!=read) { child.Kill(); throw new Exception("助手响应超时"); }
        return await read.ConfigureAwait(false);
    }
    static bool Flag(Dictionary<string,object> row,string key) { return row.ContainsKey(key)&&Convert.ToBoolean(row[key]); }
    [STAThread] public static void Main(string[] args) {
        SetProcessDPIAware(); Application.EnableVisualStyles(); Console.OutputEncoding=new UTF8Encoding(false);
        var form=new Form{Text="PickGloss 只读选区手势回归（虚构材料）",Width=760,Height=360,StartPosition=FormStartPosition.CenterScreen};
        var box=new TextBox{Left=24,Top=45,Width=680,Height=180,Multiline=true,Text="虚构背景目标词🙂和后文"};
        var other=new TextBox{Left=24,Top=250,Width=680,Text="相邻控件的目标词不能借用"};
        var list=new ListView{Left=24,Top=45,Width=680,Height=180,View=View.LargeIcon,LabelEdit=true,Visible=false};
        form.Controls.Add(box);form.Controls.Add(other);form.Controls.Add(list);
        var results=new List<object>();
        form.Shown+=async(sender,e)=>{
            try {
                for(int wait=0;wait<1200 && GetForegroundWindow()!=form.Handle;wait++)await Task.Delay(100);
                foreach(var name in new[]{"传统单行表情选区","传统多行局部选区","同文字不同位置","旧选区未变化","松开后空选区","换到相邻控件","密码输入框","排除来源进程","超过12000字符","上下文超过6000字符","鼠标松开在控件外","列表项重命名含表情","只选中列表图标对象"}) {
                    list.Visible=false;box.Visible=true;
                    box.PasswordChar='\0';box.Multiline=name!="传统单行表情选区";box.Text="虚构背景目标词🙂和后文";
                    if(name=="传统多行局部选区")box.Text="邻段不应混入。\r\n当前段有目标词🙂和后文";
                    if(name=="同文字不同位置")box.Text="目标词与目标词。";
                    if(name=="超过12000字符")box.Text=new string('甲',12001);
                    if(name=="上下文超过6000字符")box.Text="目标词"+new string('甲',6000);
                    if(name=="密码输入框"){box.Multiline=false;box.PasswordChar='*';}
                    box.Focus();box.Select(name=="旧选区未变化"?box.Text.IndexOf("目标词",StringComparison.Ordinal):0,name=="旧选区未变化"||name=="同文字不同位置"?3:0);
                    bool rename=name=="列表项重命名含表情",objects=name=="只选中列表图标对象";
                    if(rename||objects){box.Visible=false;list.Visible=true;list.Items.Clear();list.Items.Add("虚构背景目标词🙂和后文").Selected=true;list.Focus();if(rename)list.Items[0].BeginEdit();}
                    await Task.Delay(180);
                    if(GetForegroundWindow()!=form.Handle)throw new Exception("自有夹具未在前台，请激活夹具后重跑");
                    var bounds=box.RectangleToScreen(box.ClientRectangle);int x=bounds.Left+8,y=bounds.Top+8;
                    if(rename){var r=AutomationElement.FocusedElement.Current.BoundingRectangle;bounds=new Rectangle((int)r.Left,(int)r.Top,(int)r.Width,(int)r.Height);x=bounds.Left+8;y=bounds.Top+8;}
                    bool standby=Array.IndexOf(args,"--standby")>=0,quick=Array.IndexOf(args,"--quick")>=0,fast=Array.IndexOf(args,"--fast")>=0;
                    var info=new ProcessStartInfo(args[0],standby?"--standby":""){UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true,StandardOutputEncoding=new UTF8Encoding(false)};
                    using(var child=Process.Start(info)) {
                        var errors=child.StandardError.ReadToEndAsync();
                        if(standby&&!Flag(json.Deserialize<Dictionary<string,object>>(await Line(child)),"standby"))throw new Exception("待用助手未完成预热");
                        var readyClock=Stopwatch.StartNew();
                        Send(child,new{mode="gesture",x=x,y=y,excludePids=name=="排除来源进程"?Process.GetCurrentProcess().Id.ToString():""});
                        var firstTask=Line(child);
                        Action changeSelection=()=> {
                            int start=box.Text.LastIndexOf("目标词",StringComparison.Ordinal);if(start<0)start=0;
                            box.Select(start,name=="旧选区未变化"?3:name=="松开后空选区"?0:name=="超过12000字符"?box.Text.Length:name=="传统单行表情选区"||name=="传统多行局部选区"?5:3);
                            if(rename){var handle=new IntPtr(AutomationElement.FocusedElement.Current.NativeWindowHandle);SendMessage(handle,0x00B1,new IntPtr(4),new IntPtr(9));}
                        };
                        long readyMs=0;var timed=firstTask.ContinueWith(task=>{readyMs=readyClock.ElapsedMilliseconds;return task.Result;});
                        bool baselineInTime=true;long changeAtMs=0;
                        if(fast){await Task.Delay(30);baselineInTime=firstTask.IsCompleted;changeAtMs=readyClock.ElapsedMilliseconds;changeSelection();}
                        if(quick)await Task.Delay(100);
                        bool readyInTime=!quick||firstTask.IsCompleted;
                        var first=json.Deserialize<Dictionary<string,object>>(await timed);
                        bool ready=Flag(first,"ready");Dictionary<string,object> response=first;
                        if(ready) {
                            if(!fast)changeSelection();
                            if(!fast)await Task.Delay(120);
                            if(name=="换到相邻控件"){other.Focus();other.Select(0,3);}
                            var focused=AutomationElement.FocusedElement;object raw;
                            if(focused.TryGetCurrentPattern(TextPattern.Pattern,out raw)) {
                                var selections=((TextPattern)raw).GetSelection();
                                if(selections.Length==1) foreach(var rect in selections[0].Clone().GetBoundingRectangles()) {
                                    double left=Math.Max(rect.Left,bounds.Left),right=Math.Min(rect.Right,bounds.Right),top=Math.Max(rect.Top,bounds.Top),bottom=Math.Min(rect.Bottom,bounds.Bottom);
                                    if(right>left&&bottom>top){x=(int)(right-1);y=(int)((top+bottom)/2);break;}
                                }
                            }
                            // 含表情时提供方的选区矩形可能延伸至整行；用自有控件的字符位置独立确定虚构松开点。
                            if(!rename&&box.SelectionLength<1000) { var end=box.PointToScreen(box.GetPositionFromCharIndex(box.SelectionStart+box.SelectionLength)); x=end.X-1; y=end.Y+4; }
                            if(name=="鼠标松开在控件外"){x=bounds.Right+30;y=bounds.Bottom+30;}
                            Send(child,new{mode="gesture-end",x=x,y=y});child.StandardInput.Close();
                            response=json.Deserialize<Dictionary<string,object>>(await Line(child));
                        } else child.StandardInput.Close();
                        if(!child.WaitForExit(1000))child.Kill();string diagnostic=await errors;
                        bool expected=name!="旧选区未变化"&&name!="松开后空选区"&&name!="换到相邻控件"&&name!="密码输入框"&&name!="排除来源进程"&&name!="鼠标松开在控件外"&&!objects;
                        bool valid=Flag(response,"valid"),pass=valid==expected&&(!expected||(readyInTime&&baselineInTime));
                        if(name=="超过12000字符")pass=pass&&Flag(response,"tooLong")&&!response.ContainsKey("text");
                        if(name=="上下文超过6000字符")pass=pass&&Convert.ToString(response["context"])==""&&Convert.ToString(response["reason"]).Contains("6000");
                        if(valid&&!Flag(response,"tooLong")&&name!="上下文超过6000字符")pass=pass&&Convert.ToString(response["text"])== (name=="传统单行表情选区"||name=="传统多行局部选区"||rename?"目标词🙂":"目标词");
                        results.Add(new{name=name,standby=standby,quick=quick,fast=fast,baselineInTime=baselineInTime,changeAtMs=changeAtMs,readyInTime=readyInTime,ready=ready,readyMs=readyMs,valid=valid,expected=expected,pass=pass,tooLong=Flag(response,"tooLong"),response=response,diagnostic=diagnostic});
                    }
                }
                Console.WriteLine(json.Serialize(new{description="真实传统控件的两阶段只读手势验证，不代表桌面人工验收",results=results}));
            }catch(Exception error){Console.WriteLine(json.Serialize(new{error=error.Message,results=results}));Environment.ExitCode=2;}
            form.Close();
        };
        Application.Run(form);
    }
}
