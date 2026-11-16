'use strict';

const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { APP_ID } = require('../core/distribution.cjs');

const execute = promisify(execFile);
const readRunValue = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\Run')
$value = if ($key) { $key.GetValue('${APP_ID}', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
[Console]::Write((ConvertTo-Json -InputObject $value -Compress))
`;

async function readLoginCommand() {
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const { stdout } = await execute(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', readRunValue],
    { encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 16_384 });
  return stdout.trim() ? JSON.parse(stdout) : null;
}

function userLoginItem(settings) {
  return settings?.launchItems?.find(item => item.scope === 'user' && item.name.toLowerCase() === APP_ID);
}

function matchingEntry(app, executable) {
  const item = userLoginItem(app.getLoginItemSettings({ path: executable }));
  if (!item || item.args.includes('--autostart')) return item;
  // Electron 的 launchItems 只返回位置参数。用完整命令读回确认 PickGloss 写在末尾的启动开关。
  const args = [...item.args, '--autostart'];
  return app.getLoginItemSettings({ path: item.path, args }).openAtLogin ? { ...item, args } : item;
}

async function readLoginItem({ app, execPath, readCommand = readLoginCommand }) {
  const current = execPath && matchingEntry(app, execPath);
  if (current) return current;
  // Electron 只返回与查询路径相同的登录项。先读取这个固定名称，再让 Electron 解析参数和启用状态。
  const command = await readCommand();
  if (command == null) return null;
  const match = typeof command === 'string' && /^(?:"([^"]+)"|([^ \t"]+))(?:[ \t]|$)/.exec(command);
  const executable = match && (match[1] || match[2]);
  if (!executable || !path.win32.isAbsolute(executable)) throw new Error('现有 Windows 登录项的路径无法确认。');
  const item = matchingEntry(app, executable);
  if (!item) throw new Error('现有 Windows 登录项已变化，请重试。');
  return item;
}

function sameLoginPath(left, right) {
  return !!left && !!right && path.win32.normalize(left).toLowerCase() === path.win32.normalize(right).toLowerCase();
}

function loginOptions({ app, execPath = process.execPath }, enabled) {
  // 不显式指定 name：Electron 写入和 getLoginItemSettings 读回都按 AppUserModelId 定位。
  return { path: execPath,
    args: [...(app.isPackaged ? [] : [`"${app.getAppPath()}"`]), '--autostart'],
    openAtLogin: enabled, enabled };
}

function describeError(error) {
  return typeof error?.message === 'string' && error.message.trim() ? error.message.trim() : '未知系统错误';
}

function restoreLoginSetting(app, options, previous) {
  const restore = { ...options, openAtLogin: previous.openAtLogin };
  if (typeof previous.executableWillLaunchAtLogin === 'boolean') restore.enabled = previous.executableWillLaunchAtLogin;
  else delete restore.enabled;
  app.setLoginItemSettings(restore);
  const current = app.getLoginItemSettings({ path: options.path, args: options.args });
  if (!current || current.openAtLogin !== previous.openAtLogin) throw new Error('回滚后登录项状态与原设置不一致');
  const enabled = userLoginItem(current)?.enabled ?? current.executableWillLaunchAtLogin;
  if (typeof previous.executableWillLaunchAtLogin === 'boolean' && enabled !== previous.executableWillLaunchAtLogin) {
    throw new Error('回滚后启动授权状态与原设置不一致');
  }
}

function applyLoginSetting({ app, execPath, isolated = false, previousItem }, enabled) {
  if (typeof enabled !== 'boolean') throw new Error('开机自启动状态无效。');
  if (isolated) return;
  const options = loginOptions({ app, execPath }, enabled);
  const original = previousItem ? { ...options, path: previousItem.path, args: previousItem.args } : options;
  let previous = null, writeAttempted = false;
  try {
    previous = app.getLoginItemSettings?.({ path: original.path, args: original.args });
    if (!previous || typeof previous.openAtLogin !== 'boolean' || (previousItem && !previous.openAtLogin)) {
      throw new Error('系统未返回可确认的原有登录项状态，未修改设置。');
    }
    if (previousItem) previous = { ...previous, executableWillLaunchAtLogin: previousItem.enabled };
    writeAttempted = true;
    app.setLoginItemSettings(options);
    const expected = enabled ? options : original;
    const current = app.getLoginItemSettings?.({ path: expected.path, args: expected.args });
    const item = userLoginItem(current);
    if (!current || current.openAtLogin !== enabled || (enabled ? (item?.enabled ?? current.executableWillLaunchAtLogin) === false : item)) {
      throw new Error('系统读回的登录项状态与请求不一致。');
    }
  } catch (cause) {
    let rollbackError = null;
    if (writeAttempted && previous) {
      try { restoreLoginSetting(app, original, previous); }
      catch (error) { rollbackError = error; }
    }
    const detail = writeAttempted
      ? rollbackError ? `；无法确认已恢复原设置：${describeError(rollbackError)}` : '；已恢复原有设置。'
      : '；登录项未修改。';
    const error = new Error(`无法更新 Windows 开机自启动设置：${describeError(cause)}${detail}`, { cause });
    if (rollbackError) error.rollbackError = rollbackError;
    throw error;
  }
}

module.exports = { loginOptions, readLoginItem, sameLoginPath, applyLoginSetting };
