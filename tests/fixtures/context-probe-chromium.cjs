'use strict';
// 真实 Chromium/UIA 兼容性夹具：只使用虚构材料；不代表重现 QQ 自有提供方的段落越界。
const { app, BrowserWindow, screen } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'pickgloss-context-chromium-')));
app.commandLine.appendSwitch('force-renderer-accessibility');
app.on('window-all-closed', () => {});
const binary = process.argv[2];
const samples = [
  { name: '单行签名只选后两字并保留表情', document: '虚构签名🙂', selection: '签名', context: '虚构签名🙂', rule: '取得上下文' },
  { name: '单行末尾文字和表情一起选中', document: '虚构签名🙂', selection: '签名🙂', context: '虚构签名🙂', rule: '取得上下文' },
  { name: '单行只选择末尾表情', document: '虚构签名🙂', selection: '🙂', context: '虚构签名🙂', rule: '取得上下文' },
  { name: '单行完整签名和表情全选', document: '虚构签名🙂', selection: '虚构签名🙂', context: '虚构签名🙂', rule: '取得上下文' },
  { name: '相邻控件存在相同选区也只读取当前签名', document: '另一签名🚲', selection: '签名', context: '另一签名🚲', rule: '取得上下文' },
  { name: '单行控件6000字符且周围存在其它控件', document: '测试词' + '甲'.repeat(5997), selection: '测试词', rule: '取得上下文' },
  { name: '单行控件6001字符不能借边界截断接纳', document: '测试词' + '甲'.repeat(5998), selection: '测试词', context: '', rule: '超限' },
  { name: '6000字符控件选到末尾表情', document: '甲'.repeat(5998) + '🙂', selection: '甲🙂', rule: '取得上下文' },
  { name: '6001字符控件选到表情仍拒绝超限', document: '甲'.repeat(5999) + '🙂', selection: '甲🙂', context: '', rule: '超限' },
  { name: '多行控件不混入邻段', document: '前一段不得作为当前上下文。\n后一段含有测试词。', selection: '测试词', context: '后一段含有测试词。', multiline: true, rule: '不得混入邻段' },
  { name: '多行控件选择末尾表情不放行完整多段', document: '前一段不能混入上下文。\n后一段有测试词🙂', selection: '测试词🙂', context: '后一段有测试词🙂', multiline: true, rule: '不得混入邻段' },
  { name: '多行控件跨段选区仍拒绝', document: '前一段正文。\n后一段含有测试词。', selection: '正文。\n后一段', context: '', multiline: true, rule: '跨段' },
  { name: '多行控件只有单段且带表情', document: '虚构签名🙂', selection: '签名', context: '虚构签名🙂', multiline: true, rule: '取得上下文' },
];
async function probe(request) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '';
    const timeout = setTimeout(() => { child.kill(); reject(new Error('原生助手超时。')); }, 2500);
    child.stdout.setEncoding('utf8'); child.stdout.on('data', value => { output += value; });
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('close', code => { clearTimeout(timeout); try { resolve({ helperExitCode: code, response: JSON.parse(output.trim()) }); } catch { reject(new Error('原生助手没有返回有效 JSON。')); } });
    child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(request) + '\n');
  });
}
app.whenReady().then(async () => {
  const results = [];
  const win = new BrowserWindow({ title: 'PickGloss Chromium 上下文回归（虚构材料）', width: 760, height: 560, x: 80, y: 90, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  win.setAlwaysOnTop(true, 'pop-up-menu');
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<html lang="zh"><meta charset="utf-8"><title>PickGloss Chromium 上下文回归（虚构材料）</title><style>body{font:20px sans-serif;margin:20px}input,textarea{font:24px sans-serif;width:640px}textarea{height:100px}</style><button id="start" onclick="window.fixtureStart=true">开始原生检查</button><div role="group"><span>虚构相邻文本一</span><br><input value="相邻签名🚲"><span id="target"></span>' + Array.from({ length: 10 }, (_, i) => '<span>虚构相邻文本' + (i + 2) + '</span><br>').join('') + '</div></html>'));
    win.show(); win.focus();
    fs.writeFileSync(path.join(path.dirname(binary), 'fixture-state.json'), JSON.stringify({ pid: process.pid, hwnd: win.getNativeWindowHandle().readBigUInt64LE().toString(), title: win.getTitle(), visible: win.isVisible(), focused: win.isFocused() }));
    for (let retry = 0; retry < 300 && !win.isFocused(); retry++) await new Promise(resolve => setTimeout(resolve, 100));
    // Windows 可拒绝后台进程自行获取前台；等待操作者激活当前窗口并点击开始。
    let started = process.argv.includes('--auto-start');
    for (let retry = 0; retry < 450 && !started; retry++) {
      started = await win.webContents.executeJavaScript('window.fixtureStart === true');
      if (!started) await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!started) throw new Error('夹具未被激活并启动。');
    for (const sample of samples) {
      try {
        win.webContents.focus();
        const data = await win.webContents.executeJavaScript(`(() => {
          const sample=${JSON.stringify(sample)};
          const host=document.getElementById('target'); host.replaceChildren();
          const field=document.createElement(sample.multiline?'textarea':'input');
          field.value=sample.document; host.append(field);
          field.focus(); const start=field.value.indexOf(sample.selection);
          field.setSelectionRange(start,start+sample.selection.length);
          const r=field.getBoundingClientRect();
          return {start,selected:field.value.slice(field.selectionStart,field.selectionEnd),x:r.left+10,y:r.top+10};
        })()`);
        await new Promise(resolve => setTimeout(resolve, 150));
        if (data.start < 0 || data.selected !== sample.selection || !win.isFocused()) throw new Error('夹具前台或选区准备不足。');
        const bounds = win.getContentBounds();
        const point = screen.dipToScreenPoint({ x: Math.round(bounds.x + data.x), y: Math.round(bounds.y + data.y) });
        results.push({ name: sample.name, rule: sample.rule, foreground: win.isFocused(), expectedSelection: sample.selection, expectedContext: sample.context ?? sample.document, ...await probe({ text: sample.selection, x: point.x, y: point.y, excludePids: '' }) });
      } catch (error) { results.push({ name: sample.name, error: error.message }); }
    }
    process.stdout.write(JSON.stringify({ description: '真实 Chromium 编辑控件的 UIA 范围；所有正文为虚构材料。', results }) + '\n');
  } finally { win.destroy(); app.exit(0); }
}).catch(error => { console.error(error.message); app.exit(2); });
