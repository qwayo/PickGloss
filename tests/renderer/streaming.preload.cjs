'use strict';
// 只为隔离的界面交互检查提供测试桥；不访问实际会话、配置或网络。
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('pickgloss', {
  invoke: (action, payload) => ipcRenderer.invoke('test:invoke', action, payload),
  onState: callback => {
    const listener = (_, state) => { callback(state); ipcRenderer.send('test:state-seen'); };
    ipcRenderer.on('test:state', listener);
    return () => ipcRenderer.removeListener('test:state', listener);
  },
  onBeforeQuit: () => () => {},
});
window.addEventListener('DOMContentLoaded', () => {
  for (const name of ['mousedown', 'mouseup', 'click']) {
    document.addEventListener(name, () => ipcRenderer.send('test:input', name), true);
  }
});
