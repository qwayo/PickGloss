'use strict';

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
  if (typeof previous.executableWillLaunchAtLogin === 'boolean' && current.executableWillLaunchAtLogin !== previous.executableWillLaunchAtLogin) {
    throw new Error('回滚后启动授权状态与原设置不一致');
  }
}

function applyLoginSetting({ app, execPath, isolated = false }, enabled) {
  if (typeof enabled !== 'boolean') throw new Error('开机自启动状态无效。');
  if (isolated) return;
  const options = loginOptions({ app, execPath }, enabled);
  let previous = null, writeAttempted = false;
  try {
    previous = app.getLoginItemSettings?.({ path: options.path, args: options.args });
    if (!previous || typeof previous.openAtLogin !== 'boolean') throw new Error('系统未返回可确认的原有登录项状态，未修改设置。');
    writeAttempted = true;
    app.setLoginItemSettings(options);
    const current = app.getLoginItemSettings?.({ path: options.path, args: options.args });
    if (!current || current.openAtLogin !== enabled || (enabled && current.executableWillLaunchAtLogin === false)) throw new Error('系统读回的登录项状态与请求不一致。');
  } catch (cause) {
    let rollbackError = null;
    if (writeAttempted && previous) {
      try { restoreLoginSetting(app, options, previous); }
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

module.exports = { loginOptions, applyLoginSetting };
