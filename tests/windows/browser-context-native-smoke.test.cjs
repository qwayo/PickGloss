'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const framework = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
const compiler = path.join(framework, 'csc.exe');
const wpf = path.join(framework, 'WPF');
const references = ['UIAutomationClient.dll', 'UIAutomationTypes.dll', 'WindowsBase.dll'].map(name => path.join(wpf, name));
const missing = process.platform !== 'win32' ? '仅在 Windows 上运行原生助手启动冒烟。' :
  [compiler, ...references].some(file => !fs.existsSync(file)) ? '本机缺少 .NET Framework C# 编译器或 UI Automation 程序集。' : false;

function compile(mode, target) {
  fs.mkdirSync(target, { recursive: true });
  const executable = path.join(target, 'BrowserContext.exe');
  const args = ['/nologo', `/target:${mode}`, '/platform:x64', '/optimize+', `/out:${executable}`,
    ...references.map(file => `/reference:${file}`), path.join(root, 'src/windows/BrowserContext.cs')];
  const result = spawnSync(compiler, args, { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(result.error, undefined, `${mode} 子系统编译器启动失败。`);
  assert.equal(result.status, 0, `${mode} 子系统编译失败。`);
  return executable;
}

function runRedirected(executable, args = ['0', '1', String(process.pid)]) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '', settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true; child.kill(); reject(new Error('无效来源启动冒烟超时。'));
    }, 4000);
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timeout);
      if (error) reject(error); else resolve(result);
    };
    child.on('error', error => finish(error));
    child.stdout.setEncoding('ascii'); child.stderr.setEncoding('ascii');
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 2048) { child.kill(); finish(new Error('启动协议输出超过限制。')); } });
    child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 2048) { child.kill(); finish(new Error('启动错误输出超过限制。')); } });
    child.on('close', code => finish(null, { code, stdout, stderr }));
    child.stdin.end();
  });
}

test('exe 与 winexe 在重定向标准流下都能用固定 ASCII 协议拒绝无效 HWND', { skip: missing }, async () => {
  const output = path.join(root, 'output/verification/browser-context-startup-smoke-20261029');
  for (const mode of ['exe', 'winexe']) {
    const executable = compile(mode, path.join(output, mode));
    const result = await runRedirected(executable);
    assert.equal(result.code, 0, `${mode} 子系统无效来源应正常退出。`);
    assert.equal(result.stderr, '', `${mode} 子系统不应向 stderr 输出 CLR/I/O 异常。`);
    assert.equal(result.stdout.replace(/\r\n/g, '\n'), '{"type":"ready","valid":false,"state":"invalid","reason":"window"}\n');
  }
});

test('原生待命只准备运行时，收到 start 才核验来源，stdin 关闭后退出', { skip: missing }, async () => {
  const executable = compile('winexe', path.join(root, 'output/verification/browser-context-standby-20261029'));
  for (const start of [false, true]) {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(executable, ['--standby', String(process.pid)], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      let stdout = '', stderr = '', answered = false;
      const timer = setTimeout(() => { child.kill(); reject(new Error('待命助手超时。')); }, 4000);
      child.on('error', reject);
      child.stdout.on('data', chunk => {
        stdout += chunk.toString('ascii');
        if (!answered && stdout.includes('\n')) { answered = true; child.stdin.end(start ? 'start 123456789 1\n' : ''); }
      });
      child.stderr.on('data', chunk => { stderr += chunk.toString('ascii'); });
      child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
    assert.equal(result.code, 0); assert.equal(result.stderr, '');
    assert.equal(result.stdout.replace(/\r\n/g, '\n'), '{"type":"standby"}\n' +
      (start ? '{"type":"ready","valid":false,"state":"invalid","reason":"window"}\n' : ''));
  }
});

test('事件代际拒绝快照之后的旧 active 提交，禁用守卫的对照确实 unsafe', { skip: missing }, async () => {
  const output = path.join(root, 'output/verification/browser-context-generation-20261029');
  fs.mkdirSync(output, { recursive: true });
  const executable = path.join(output, 'BrowserContextGeneration.exe');
  const args = ['/nologo', '/target:exe', '/platform:x64', '/optimize+', '/main:BrowserContextGenerationFixture', `/out:${executable}`,
    ...references.map(file => `/reference:${file}`), path.join(root, 'src/windows/BrowserContext.cs'),
    path.join(root, 'tests/fixtures/browser-context-generation-fixture.cs')];
  const compiled = spawnSync(compiler, args, { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(compiled.error, undefined, '代际交错夹具编译器启动失败。');
  assert.equal(compiled.status, 0, '代际交错夹具编译失败。');
  const result = await runRedirected(executable, []);
  assert.equal(result.code, 0, '生产代际守卫必须拒绝旧 active，对照必须暴露无守卫竞态。');
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.replace(/\r\n/g, '\n'), 'guarded=reject;unguarded=unsafe\n');
});

test('浏览器外壳的无关结构通知不能让稳定覆盖反复隐藏再显示', { skip: missing }, async () => {
  const output = path.join(root, 'output/verification/browser-context-shell-noise-20261029');
  fs.mkdirSync(output, { recursive: true });
  let production = fs.readFileSync(path.join(root, 'src/windows/BrowserContext.cs'), 'utf8')
    .replace('public static void Main(string[] args)', 'public static void UnusedMain(string[] args)');
  const driver = `
    public static int Main() {
      readySent=true;readyValid=true;lastState="active";lastReason="tab";
      for(int i=0;i<5;i++) {
        long before=observations.Begin();
        QueueCheck("tree");
        if(lastState!="active" || observations.IsInvalid) return 2;
        if(CommitObservedState(before,"active","tab")) return 4;
        if(!CommitObservedState(observations.Begin(),"active","tab")) return 3;
      }
      QueueCheck("tree"); WriteCheckpointCurrent("1");
      return 0;
    }
  `;
  production = production.slice(0, production.lastIndexOf('}')) + driver + '}';
  const source = path.join(output, 'shell-noise.cs'), executable = path.join(output, 'shell-noise.exe');
  fs.writeFileSync(source, production);
  const compiled = spawnSync(compiler, ['/nologo', '/target:exe', '/platform:x64', `/out:${executable}`,
    ...references.map(file => `/reference:${file}`), source], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(compiled.status, 0, '正式事件处理夹具必须编译。');
  const result = await runRedirected(executable, []);
  assert.equal(result.code, 0, '外壳结构噪声不代表来源标签已离开，不能主动隐藏稳定覆盖。');
  assert.equal(result.stdout.replace(/\r\n/g, '\n'), '{"type":"checkpoint","nonce":"1","valid":true,"state":"inactive","reason":"unknown"}\n',
    '不广播 inactive/active 显隐对，但未确认的截图核对必须返回 inactive。');
  assert.equal(result.stderr, '');
});

test('正式查询在更新的切标签事件后抛错时不能永久失效；无新事件的故障仍失效', { skip: missing }, async () => {
  const output = path.join(root, 'output/verification/browser-context-query-race-20261029');
  fs.mkdirSync(output, { recursive: true });
  const production = fs.readFileSync(path.join(root, 'src/windows/BrowserContext.cs'), 'utf8');
  const signature = 'static Snapshot ReadSnapshot(';
  const start = production.indexOf(signature), open = production.indexOf('{', start);
  assert.ok(start > 0 && open > start, '必须替换正式 UIA 查询边界。');
  let depth = 1, end = open + 1;
  while (depth && end < production.length) { if (production[end] === '{') depth++; if (production[end] === '}') depth--; end++; }
  const queryStub = `{
    if(fixtureMode==1) { QueueCheck("tab"); throw new ElementNotAvailableException(); }
    if(fixtureMode==3) throw new ElementNotAvailableException();
    if(fixtureMode==4) return new Snapshot { tab=baselineTab, document="new-document", scroll=baselineScroll };
    if(fixtureMode==5) return new Snapshot();
    return new Snapshot { tab=baselineTab, document=baselineDoc, scroll=baselineScroll };
  }`;
  let fixture = production.slice(0, open) + queryStub + production.slice(end);
  fixture = fixture.replace('public static void Main(string[] args)', 'public static void UnusedMain(string[] args)');
  const driver = `
    static int fixtureMode;
    public static int Main(string[] args) {
      readySent=true;readyValid=true;lastState="active";baselineTab="tab";baselineDoc="document";baselineScroll="scroll";
      fixtureMode=1;
      try { if(EvaluateCurrent(IntPtr.Zero,1)!=null || observations.IsInvalid || lastState!="inactive") return 2; }
      catch { return 3; }
      fixtureMode=2;
      if(EvaluateCurrent(IntPtr.Zero,1)!=null || lastState!="active") return 4;
      if(args.Length>0 && args[0]=="navigation") {
        fixtureMode=4;
        if(EvaluateCurrent(IntPtr.Zero,1)!="navigation" || !observations.IsInvalid) return 7;
        fixtureMode=2;
        if(EvaluateCurrent(IntPtr.Zero,1)!="navigation" || lastState!="invalid") return 8;
        return 0;
      }
      if(args.Length>0 && args[0]=="missing-tab") {
        fixtureMode=5;
        if(EvaluateCurrent(IntPtr.Zero,1)!=null || lastState!="inactive" || lastReason!="unknown") return 9;
        Thread.Sleep(210);
        if(EvaluateCurrent(IntPtr.Zero,1)!="unknown" || !observations.IsInvalid) return 10;
        return 0;
      }
      fixtureMode=3;
      if(EvaluateCurrent(IntPtr.Zero,1)!=null || observations.IsInvalid || lastState!="inactive") return 5;
      Thread.Sleep(210);
      if(EvaluateCurrent(IntPtr.Zero,1)!="unknown" || !observations.IsInvalid || lastState!="invalid") return 6;
      return 0;
    }
  `;
  fixture = fixture.slice(0, fixture.lastIndexOf('}')) + driver + '}';
  const guardedQuery = 'try { snapshot=ReadSnapshot(hwnd,sourcePid,baselineTab,baselineDoc); }\n        catch { return RejectSnapshot("unknown",sampleGeneration); }';
  assert.ok(fixture.includes(guardedQuery), '正式查询的异常必须受代际保护。');
  for (const guarded of [false, true]) {
    const source = path.join(output, guarded ? 'guarded.cs' : 'unguarded.cs');
    const executable = source.replace(/\.cs$/, '.exe');
    fs.writeFileSync(source, guarded ? fixture : fixture.replace(guardedQuery, 'snapshot=ReadSnapshot(hwnd,sourcePid,baselineTab,baselineDoc);'));
    const compiled = spawnSync(compiler, ['/nologo', '/target:exe', '/platform:x64', `/out:${executable}`,
      ...references.map(file => `/reference:${file}`), source], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    assert.equal(compiled.status, 0, '正式查询边界夹具必须编译。');
    const result = await runRedirected(executable, []);
    assert.equal(result.code, guarded ? 0 : 3, guarded ? '正式查询必须保留恢复能力，同时拒绝无归属故障。' : '去掉异常守卫必须暴露旧查询异常。');
    assert.equal(result.stderr, '');
    if (guarded) {
      const navigated = await runRedirected(executable, ['navigation']);
      assert.equal(navigated.code, 0, '同标签文档替换必须立即锁存，快速后退不能恢复旧覆盖。');
      assert.equal(navigated.stderr, '');
      const missingTab=await runRedirected(executable,['missing-tab']);
      assert.equal(missingTab.code,0,'无法找到选中标签不能无限期冒充已切到其他标签，必须给出可见降级。');
      assert.equal(missingTab.stderr,'');
    }
  }
});
