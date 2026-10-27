'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const allowed = new Set(['bootstrap','new-text','set-context','set-note','set-mode','set-draft','start-explanation','send-question','stop','copy-answer','open-link','favorite','open-history','open-session','delete-session','open-settings','save-settings','test-provider','start-capture','capture-done','capture-cancel','close','pin','wide','show-orb','selection-open','menu','quit','navigate']);
allowed.add('reset-window-size');
allowed.add('open-latest-session');
allowed.add('orb-activate');
allowed.add('delete-sessions');
allowed.add('fetch-models');
for (const action of ['close-translation','retry-translation','set-translation-options','set-translation-preferences','copy-translation','preview-translation-original','translation-content-height']) allowed.add(action);
for (const action of ['set-web-search','retry-search','retry-without-search','test-search-provider','get-source-icon']) allowed.add(action);
for (const action of ['rename-session', 'search-history', 'refresh-history', 'orb-drag', 'open-appearance', 'toggle-selection', 'open-shortcuts', 'shortcut-command', 'shortcut-recording', 'menu-close', 'menu-ready', 'capture-ready']) allowed.add(action);
contextBridge.exposeInMainWorld('pickgloss', Object.freeze({
  onLayout(callback) {
    const listener = (_event, message) => callback(message, () => ipcRenderer.send('pickgloss:layout-ready', message.id));
    ipcRenderer.on('pickgloss:layout', listener);
    return () => ipcRenderer.removeListener('pickgloss:layout', listener);
  },
  invoke(action, payload = {}) {
    if (!allowed.has(action)) return Promise.resolve({ ok: false, error: '不支持此操作。' });
    return ipcRenderer.invoke('pickgloss:action', action, payload);
  },
  onBeforeQuit(callback) {
    const listener = async (_event, token) => {
      try { ipcRenderer.send('pickgloss:flushed', token, await callback() === true); }
      catch { ipcRenderer.send('pickgloss:flushed', token, false); }
    };
    ipcRenderer.on('pickgloss:flush', listener);
    return () => ipcRenderer.removeListener('pickgloss:flush', listener);
  },
  onState(callback) {
    if (typeof callback !== 'function') throw new TypeError('状态订阅必须提供回调。');
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('pickgloss:state', listener);
    return () => ipcRenderer.removeListener('pickgloss:state', listener);
  }
}));
