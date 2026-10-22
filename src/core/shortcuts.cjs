'use strict';

const { failure } = require('./validation.cjs');

const DEFAULT_SHORTCUTS = Object.freeze({ paste: 'Alt+Shift+G', capture: 'Alt+Shift+S', 'toggle-pin': 'Alt+Shift+P', 'toggle-wide': 'Alt+Shift+W', history: '', appearance: '', 'toggle-orb': '', 'toggle-selection': '', stop: '', 'close-panel': '' });
const COMMANDS = Object.freeze(Object.keys(DEFAULT_SHORTCUTS));
const MODIFIERS = { ctrl: 'Ctrl', control: 'Ctrl', cmdorctrl: 'Ctrl', commandorcontrol: 'Ctrl', alt: 'Alt', option: 'Alt', shift: 'Shift', super: 'Super', win: 'Super', windows: 'Super', meta: 'Super', command: 'Super', cmd: 'Super' };
const KEYS = Object.fromEntries(['Space', 'Tab', 'Enter', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown', 'Up', 'Down', 'Left', 'Right', 'Plus'].map(key => [key.toLowerCase(), key]));
Object.assign(KEYS, { return: 'Enter', del: 'Delete', esc: 'Escape', escape: 'Escape', arrowup: 'Up', arrowdown: 'Down', arrowleft: 'Left', arrowright: 'Right', spacebar: 'Space' });

function normalizeAccelerator(value) {
  if (typeof value !== 'string' || value.length > 100) throw failure('INVALID_INPUT', '快捷键格式无效。');
  if (!value.trim()) return '';
  const parts = value.trim().split('+').map(part => part.trim().toLowerCase());
  const modifiers = new Set(); let key;
  for (const part of parts) {
    const modifier = Object.hasOwn(MODIFIERS, part) ? MODIFIERS[part] : null;
    if (modifier) {
      if (modifiers.has(modifier)) throw failure('INVALID_INPUT', '快捷键修饰键不能重复。');
      modifiers.add(modifier); continue;
    }
    const normalized = /^[a-z0-9]$/.test(part) || /^f(?:[1-9]|1[0-9]|2[0-4])$/.test(part) ? part.toUpperCase() : Object.hasOwn(KEYS, part) ? KEYS[part] : (/^[,./;\[\]\\'`=-]$/.test(part) ? part : null);
    if (!normalized || key) throw failure('INVALID_INPUT', '快捷键需要一个有效按键。');
    key = normalized;
  }
  if (!key || !['Ctrl', 'Alt', 'Super'].some(modifier => modifiers.has(modifier))) throw failure('INVALID_INPUT', '全局快捷键至少包含 Ctrl、Alt 或 Win 修饰键。');
  if (key === 'Escape') throw failure('INVALID_INPUT', 'Esc 保留给窗口操作，不能注册为全局快捷键。');
  return [...['Ctrl', 'Alt', 'Shift', 'Super'].filter(modifier => modifiers.has(modifier)), key].join('+');
}

function shortcutsShape(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(command => !COMMANDS.includes(command)) || COMMANDS.some(command => !Object.hasOwn(input, command))) throw failure('INVALID_INPUT', '快捷键命令字段无效。');
  const result = {}, used = new Set();
  for (const command of COMMANDS) {
    const accelerator = normalizeAccelerator(input[command]);
    if (accelerator && used.has(accelerator)) throw failure('INVALID_INPUT', '不同功能不能使用相同快捷键。');
    if (accelerator) used.add(accelerator);
    result[command] = accelerator;
  }
  return result;
}

function createShortcutController({ globalShortcut, onCommand, onStatus = () => {}, isolated = false, initial = DEFAULT_SHORTCUTS, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let bindings = {}, committed = shortcutsShape(initial), requested = { ...committed }, owned = new Set(), error = '', failedCommand = '', queue = Promise.resolve();
  let recording = false, recordingTimer = null, disposed = false;
  function snapshot() {
    return { enabled: !isolated, recording, reason: isolated ? '隔离验证模式：全局快捷键未注册。' : recording ? '正在录制：本应用的全局快捷键已暂停。' : '', error,
      bindings: Object.fromEntries(COMMANDS.map(command => [command, { accelerator: requested[command], registered: !!requested[command] && owned.has(requested[command]) && bindings[requested[command]] === command,
        activeAccelerator: Object.keys(bindings).find(accelerator => bindings[accelerator] === command && owned.has(accelerator)) || '',
        error: failedCommand === command ? error : requested[command] && !isolated && !recording && bindings[requested[command]] !== command ? '快捷键未注册。' : '' }])) };
  }
  function report() { onStatus(snapshot()); }
  function enqueue(action) {
    if (disposed) return Promise.reject(failure('SHORTCUT_CLOSED', '正在退出，无法修改快捷键。'));
    const task = queue.then(action); queue = task.catch(() => {}); return task;
  }
  async function perform(input, persist = async () => undefined) {
      const next = shortcutsShape(typeof input === 'function' ? input() : input), additions = [];
      requested = next; error = ''; failedCommand = '';
      try {
        if (!isolated && !recording) for (const command of COMMANDS) {
          const accelerator = next[command];
          if (!accelerator || owned.has(accelerator)) continue;
          let registered = false;
          try { registered = globalShortcut.register(accelerator, () => { const active = bindings[accelerator]; if (active) onCommand(active); }); } catch {}
          if (!registered) { failedCommand = command; throw failure('SHORTCUT_UNAVAILABLE', `${accelerator} 无法注册，可能已被其他程序占用；设置未保存。`); }
          additions.push(accelerator);
        }
        const saved = await persist(next);
        const desired = new Set(Object.values(next).filter(Boolean));
        for (const accelerator of owned) if (!desired.has(accelerator)) globalShortcut.unregister(accelerator);
        owned = isolated || recording ? new Set() : desired;
        bindings = Object.fromEntries(COMMANDS.filter(command => next[command] && !isolated && !recording).map(command => [next[command], command]));
        committed = next;
        report(); return saved;
      } catch (cause) {
        for (const accelerator of additions) globalShortcut.unregister(accelerator);
        error = cause.message || '快捷键保存失败，已保留原有注册。';
        report(); throw cause;
      }
  }
  function apply(input, persist) {
    return enqueue(async () => {
      // 保存与结束录制在同一队列任务内完成，不能绕过系统注册预检。
      if (recording) {
        clearTimer(recordingTimer); recordingTimer = null; recording = false;
        await perform(committed);
      }
      return perform(input, persist);
    });
  }
  function save(persist) { return enqueue(persist); }
  function setRecording(active) {
    if (typeof active !== 'boolean') return Promise.reject(failure('INVALID_INPUT', '快捷键录制状态无效。'));
    return enqueue(async () => {
      clearTimer(recordingTimer); recordingTimer = null;
      if (active) {
        for (const accelerator of owned) globalShortcut.unregister(accelerator);
        owned.clear(); bindings = {}; recording = true;
        recordingTimer = setTimer(() => { recordingTimer = null; void setRecording(false).catch(() => {}); }, 25000);
        recordingTimer?.unref?.();
        report(); return snapshot();
      }
      if (!recording) return snapshot();
      recording = false;
      await perform(committed); return snapshot();
    });
  }
  async function dispose() {
    disposed = true; clearTimer(recordingTimer); recordingTimer = null;
    await queue;
    clearTimer(recordingTimer); recordingTimer = null;
    for (const accelerator of owned) globalShortcut.unregister(accelerator);
    owned.clear(); bindings = {}; recording = false;
  }
  return { apply, save, setRecording, dispose, snapshot };
}

module.exports = { DEFAULT_SHORTCUTS, COMMANDS, normalizeAccelerator, shortcutsShape, createShortcutController };
