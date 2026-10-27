'use strict';

const { app } = require('electron');
const { execFileSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

const runKey = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const approvedKey = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';
const probes = [
  {
    name: `PickGloss-StartupProbe-${process.pid}-CustomName`,
    appUserModelId: 'local.pickgloss.desktop',
    explicitName: true,
    cases: [{ label: '当前应用名称与显式name不同', launchPath: process.execPath, args: ['--autostart'] }],
  },
  {
    name: `PickGloss-StartupProbe-${process.pid}-AppId`,
    appUserModelId: `PickGloss-StartupProbe-${process.pid}-AppId`,
    explicitName: false,
    cases: [
      { label: '打包模式参数', launchPath: process.execPath, args: ['--autostart'] },
      { label: '开发模式参数', launchPath: process.execPath, args: [`"${app.getAppPath()}"`, '--autostart'] },
      { label: '含空格路径', launchPath: path.join(os.tmpdir(), 'PickGloss Startup Probe', 'PickGloss.exe'), args: [] },
    ],
  },
];
const probeNames = probes.map(probe => probe.name);
const createdNames = new Set();
let exitCode = 0;

function queryRegistry(names) {
  const values = names.map(name => `'${name}'`).join(',');
  const command = `
    $names = @(${values})
    $runPath = '${runKey}'
    $approvedPath = '${approvedKey}'
    $run = Get-ItemProperty -LiteralPath $runPath -ErrorAction SilentlyContinue
    $approved = Get-ItemProperty -LiteralPath $approvedPath -ErrorAction SilentlyContinue
    $result = foreach ($name in $names) {
      $runValue = if ($run) { $run.PSObject.Properties[$name] } else { $null }
      $approvedValue = if ($approved) { $approved.PSObject.Properties[$name] } else { $null }
      [pscustomobject]@{
        name = $name
        runPresent = [bool]$runValue
        runCommand = if ($runValue) { [string]$runValue.Value } else { $null }
        startupApprovedPresent = [bool]$approvedValue
        startupApprovedHex = if ($approvedValue -and $approvedValue.Value -is [byte[]]) { [Convert]::ToHexString($approvedValue.Value) } else { $null }
      }
    }
    $result | ConvertTo-Json -Compress
  `;
  const output = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' }).trim();
  const parsed = JSON.parse(output || '[]');
  return Array.isArray(parsed) ? parsed : [parsed];
}

function removeProbeRegistryValues(names) {
  const values = names.map(name => `'${name}'`).join(',');
  const command = `
    $names = @(${values})
    foreach ($name in $names) {
      $run = Get-ItemProperty -LiteralPath '${runKey}' -ErrorAction SilentlyContinue
      if ($run -and $run.PSObject.Properties[$name]) { Remove-ItemProperty -LiteralPath '${runKey}' -Name $name -ErrorAction Stop }
      $approved = Get-ItemProperty -LiteralPath '${approvedKey}' -ErrorAction SilentlyContinue
      if ($approved -and $approved.PSObject.Properties[$name]) { Remove-ItemProperty -LiteralPath '${approvedKey}' -Name $name -ErrorAction Stop }
    }
  `;
  execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', stdio: 'pipe' });
}

function exactReadback(name, launchPath, args) {
  const matching = app.getLoginItemSettings({ path: launchPath, args });
  const all = app.getLoginItemSettings();
  const item = Array.isArray(all.launchItems) ? all.launchItems.find(entry => entry.name === name) : null;
  return {
    openAtLogin: matching.openAtLogin,
    executableWillLaunchAtLogin: matching.executableWillLaunchAtLogin,
    itemFoundByName: Boolean(item),
    item: item ? { path: item.path, args: item.args, enabled: item.enabled, scope: item.scope } : null,
  };
}

app.whenReady().then(() => {
  const report = { electron: process.versions.electron, executablePathHasWhitespace: /\s/.test(process.execPath), probes: [] };
  try {
    const before = queryRegistry(probeNames);
    if (before.some(entry => entry.runPresent || entry.startupApprovedPresent)) throw new Error('探针名在测试前已存在；为避免覆盖，已停止。');

    for (const probe of probes) {
      const { name } = probe;
      createdNames.add(name);
      app.setAppUserModelId(probe.appUserModelId);
      const entry = { name, appUserModelId: probe.appUserModelId, explicitName: probe.explicitName, cases: [] };
      report.probes.push(entry);
      for (const testCase of probe.cases) {
        const { launchPath, args: probeArgs } = testCase;
        const options = { path: launchPath, args: probeArgs, openAtLogin: true, enabled: true };
        if (probe.explicitName) options.name = name;
        app.setLoginItemSettings(options);
        const readback = exactReadback(name, launchPath, probeArgs);
        const mismatchedArgs = app.getLoginItemSettings({ path: launchPath, args: [...probeArgs, '--different-args'] });
        entry.cases.push({
          label: testCase.label,
          pathHasWhitespace: /\s/.test(launchPath),
          args: probeArgs,
          exactPathAndArgsReadback: readback,
          mismatchedArgsReadback: { openAtLogin: mismatchedArgs.openAtLogin, executableWillLaunchAtLogin: mismatchedArgs.executableWillLaunchAtLogin },
          registry: queryRegistry([name])[0],
        });
      }
    }
  } catch (error) {
    report.error = error?.message || '启动项 API 探针失败。';
    exitCode = 1;
  } finally {
    for (const name of createdNames) {
      const probe = probes.find(item => item.name === name);
      try {
        app.setAppUserModelId(probe.appUserModelId);
        const options = { path: process.execPath, args: ['--autostart'], openAtLogin: false, enabled: false };
        if (probe.explicitName) options.name = name;
        app.setLoginItemSettings(options);
      }
      catch { /* 再用精确探针名清理，绝不访问 PickGloss 正式项。 */ }
    }
    try { removeProbeRegistryValues([...createdNames]); }
    catch (error) { report.cleanupError = error?.message || '无法清理探针注册表值。'; exitCode = 1; }
    try {
      report.afterCleanup = queryRegistry([...createdNames]);
      if (report.afterCleanup.some(entry => entry.runPresent || entry.startupApprovedPresent)) exitCode = 1;
    } catch (error) { report.cleanupVerificationError = error?.message || '无法验证探针清理结果。'; exitCode = 1; }
    console.log(JSON.stringify(report, null, 2));
    app.exit(exitCode);
  }
});
