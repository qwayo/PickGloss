'use strict';
// 独立异常 UIA 提供方回归：真实跨进程调用，仅使用自建窗口和虚构材料。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.scratch/anomalous-context-probe', new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex'));
const framework = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319');
const fixtureSource = path.join(root, 'tests/fixtures/context-probe-anomalous-provider.cs');
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const report = {
  description: '自定义 Windows UIA 提供方注入端点异常，调用实际上下文助手；模拟提供方契约，不等于其他真实应用或便携包验收。',
  results: [], exitCode: 2,
};

function compile(name, source, references) {
  const target = path.join(output, name + '.exe');
  const args = ['/nologo', '/codepage:65001', '/target:exe', '/platform:x64', '/optimize+', '/out:' + target,
    ...references.map(value => '/reference:' + path.join(framework, value)), source];
  const result = spawnSync(path.join(framework, 'csc.exe'), args, { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  if (result.error || result.status !== 0) throw new Error(name + ' 编译失败：' + (result.error?.message || result.stdout || result.stderr));
  return target;
}

function runFixture(file, helpers) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, helpers, { windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timeoutError;
    report.fixturePid = child.pid;
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
    const timer = setTimeout(() => {
      timeoutError = new Error('自建夹具超时；已请求终止本次启动的进程及其子进程。');
      // PID 来自本次 spawn；仅清理这个自建进程树，不按名称操作用户程序。
      const cleanup = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
      report.timeoutCleanupExitCode = cleanup.status;
    }, 360000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      fs.writeFileSync(path.join(output, '原生夹具输出.json'), stdout, 'utf8');
      report.fixtureExitCode = code; report.fixtureSignal = signal;
      if (timeoutError) reject(timeoutError);
      else if (code !== 0) reject(new Error('原生夹具未完成，退出码 ' + code + (stderr ? '：' + stderr : '')));
      else {
        try { resolve(JSON.parse(stdout.trim())); }
        catch { reject(new Error('原生夹具输出不是完整 JSON。')); }
      }
    });
  });
}

function verify(row) {
  const calls = row.providerCalls || {}, observed = row.observations || {};
  if (row.preconditionError || row.helperError || row.parseError || row.foregroundBeforeProbe !== true || row.foregroundAfterProbe !== true || row.helperExitCode !== 0 || row.valid !== true || row.selectionMatches !== true) {
    return { verdict: '前置条件不足', failure: row.preconditionError || row.helperError || row.parseError || '未取得自有前台窗口的有效预期选区。' };
  }
  if (!(calls.getSelection > 0 && calls.getTextSelected > 0 && calls.rangeFromChild > 0 && (row.expectedEndpointAnomaly === false ? calls.rangeFromChildFailures > 0 : calls.compareEndpoints > 0 && observed.scopeEndVsSelectionEndObserved === true && observed.scopeEndVsSelectionEnd < 0))) {
    return { verdict: '前置条件不足', failure: '真实提供方回调未观察到指定端点异常。' };
  }
  if (row.category === 'positive') {
    if (row.contextMatchesExpected !== true || row.contextLength <= 0 || row.reason) return { verdict: '失败', failure: '端点异常下未取得准确完整的单段上下文。' };
    if (row.expectedEndpointAnomaly !== false && (observed.selectedOwnerEqualsCurrentEdit !== true || observed.scopeOwnerEqualsCurrentEdit !== true || observed.selectedAndScopeOwnersEqual !== true || !(calls.getTextScope > 0))) return { verdict: '前置条件不足', failure: '未观察到实际读取同一编辑控件的完整范围。' };
  } else if (row.category === 'negative') {
    if (row.contextLength !== 0 || row.contextMatchesExpected !== true || !row.reason || row.borrowedMarkerPresent) return { verdict: '失败', failure: '不可信范围未被明确拒绝，或借用了相邻内容。' };
  } else return { verdict: '前置条件不足', failure: '样例类别无效。' };
  return { verdict: '通过' };
}

(async () => {
  fs.mkdirSync(output, { recursive: true });
  try {
    if (process.platform !== 'win32') throw new Error('异常 UIA 原生回归需要 Windows。');
    const args = process.argv.slice(2);
    let source = path.join(root, 'src/windows/ContextProbe.cs'), baselineSource;
    const seen = new Set();
    for (let index = 0; index < args.length; index += 2) {
      const flag = args[index], value = args[index + 1];
      if (!['--source', '--baseline-source'].includes(flag) || seen.has(flag) || !value || value.startsWith('--')) throw new Error('用法：node scripts/check-anomalous-context-probe.cjs [--source 源码路径] [--baseline-source 修复前源码路径]');
      seen.add(flag);
      if (flag === '--source') source = path.resolve(value);
      else baselineSource = path.resolve(value);
    }
    report.source = source; report.sourceSha256 = sha256(source);
    report.fixtureSource = fixtureSource; report.fixtureSha256 = sha256(fixtureSource);
    const shared = ['System.Web.Extensions.dll', 'WPF/UIAutomationClient.dll', 'WPF/UIAutomationTypes.dll', 'WPF/WindowsBase.dll'];
    const helper = compile('ContextProbe', source, shared);
    const fixture = compile('AnomalousContextFixture', fixtureSource, [...shared, 'WPF/UIAutomationProvider.dll', 'System.Windows.Forms.dll', 'System.Drawing.dll']);
    report.helperSha256 = sha256(helper);
    const helpers = [helper];
    if (baselineSource) {
      report.baselineSource = baselineSource; report.baselineSourceSha256 = sha256(baselineSource);
      helpers.push(compile('ContextProbeBefore', baselineSource, shared));
    }
    console.log('自建异常 UIA 窗口已启动；若系统未授予前台，可在 60 秒内激活该测试窗口。');
    const data = await runFixture(fixture, helpers);
    report.foregroundOwnedWindow = data.foregroundOwnedWindow;
    report.foregroundWaitMs = data.foregroundWaitMs;
    if (data.foregroundOwnedWindow !== true || !Array.isArray(data.results)) throw new Error('自有夹具未取得前台或未返回样例。');
    report.results = data.results.map(row => ({ ...row, ...verify(row) }));
    if (report.results.length !== 23 || new Set(report.results.map(row => row.name)).size !== 23 || report.results.filter(row => row.category === 'positive').length !== 6) throw new Error('夹具未完整执行预期的 6 个正例和 17 个负例。');
    report.exitCode = report.results.some(row => row.verdict === '前置条件不足') ? 2 : report.results.some(row => row.verdict === '失败') ? 1 : 0;
    if (baselineSource) {
      if (!Array.isArray(data.baselineResults) || data.baselineResults.length !== 23) throw new Error('修复前对照未完成全部 23 项。');
      report.baselineResults = data.baselineResults.map(row => ({ ...row, ...verify(row) }));
      const insufficient = report.baselineResults.some(row => row.verdict === '前置条件不足');
      report.baselineReproduced = !insufficient && report.baselineResults.every((row, index) => row.name === report.results[index].name) && report.baselineResults.some(row => row.verdict === '失败');
      if (insufficient) report.exitCode = 2;
      else if (!report.baselineReproduced && report.exitCode === 0) report.exitCode = 1;
    }
  } catch (error) { report.error = error.message; report.exitCode = 2; }
  fs.writeFileSync(path.join(output, 'evidence.json'), JSON.stringify(report, null, 2), 'utf8');
  for (const row of report.results) console.log(`${row.verdict}：${row.name}${row.failure ? '；' + row.failure : ''}`);
  if (report.baselineResults) console.log('修复前对照：' + (report.baselineReproduced ? `${report.baselineResults.filter(row => row.verdict === '失败').length} 项复现缺陷；其余结果见证据。` : '未满足预期失败对照，请检查证据。'));
  if (report.error) console.error(report.error);
  console.log('独立异常 UIA 证据：' + path.join(output, 'evidence.json'));
  process.exitCode = report.exitCode;
})();
