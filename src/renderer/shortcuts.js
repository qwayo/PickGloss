// 快捷键编辑使用宿主校验与注册；录制期间只临时释放本应用的组合键。
export const shortcutDefinitions = [
  ['paste', '粘贴文字', '打开文字输入窗口', 'Alt+Shift+G', '常用入口'],
  ['capture', '截图框选', '开始框选屏幕上的内容', 'Alt+Shift+S', '常用入口'],
  ['history', '会话历史', '查看已保存的解释与追问', '', '常用入口'],
  ['appearance', '外观与主题', '切换配色与窗口材质', '', '常用入口'],
  ['toggle-pin', '置顶 / 取消置顶', '让解释窗口在其他软件上方保持可见', 'Alt+Shift+P', '窗口控制'],
  ['toggle-wide', '展开 / 收窄', '切换小窗与阅读视图', 'Alt+Shift+W', '窗口控制'],
  ['toggle-orb', '显示 / 隐藏悬浮球', '收起或找回桌面入口', '', '窗口控制'],
  ['close-panel', '收起解释窗口', '隐藏窗口，仍保留在托盘', '', '窗口控制'],
  ['toggle-selection', '暂停 / 开启划词', '切换选区附近的解释入口', '', '阅读控制'],
  ['stop', '停止回答', '停止当前正在生成的回答', '', '阅读控制'],
];

export function shortcutLabel(value) { return value ? value.replaceAll('Super', 'Win').replaceAll('+', ' + ') : '未设置'; }

export function createShortcutsUI({ invoke, save }) {
  const defaults = Object.fromEntries(shortcutDefinitions.map(([id, , , value]) => [id, value]));
  let saved = { ...defaults }, draft = { ...defaults };
  let status = {}, dirty = false, busy = false, recording = null, notice = '', failed = false, root, refs = {};
  let disposed = false, releasePending = false, starting = false, startingId = null, recordingEpoch = 0, recordingTasks = 0, recordingWork = Promise.resolve();
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const button = (text, className, handler) => {
    const node = element('button', className, text); node.type = 'button'; node.addEventListener('click', handler); return node;
  };
  function sync() {
    if (!root || disposed) return;
    for (const [id, label] of shortcutDefinitions) {
      const row = refs[id], binding = status.bindings?.[id];
      row.key.textContent = startingId === id ? '正在准备…' : recording === id ? '按下组合键…' : shortcutLabel(draft[id]);
      row.key.setAttribute('aria-label', `${label}：${recording === id ? '正在录制' : shortcutLabel(draft[id])}，点击修改`);
      row.key.setAttribute('aria-pressed', String(recording === id));
      row.key.disabled = busy || starting || recordingTasks > 0;
      row.clear.disabled = busy || recordingTasks > 0 || !draft[id];
      let text = draft[id] !== saved[id] ? '待保存' : !draft[id] ? '' : binding?.error || (binding?.registered ? '已启用' : status.enabled === false ? '' : '');
      if (binding?.error && binding.activeAccelerator) text += `；仍使用 ${shortcutLabel(binding.activeAccelerator)}`;
      row.status.textContent = text; row.status.classList.toggle('is-error', Boolean(binding?.error));
    }
    refs.save.disabled = busy || !dirty || Boolean(recording) || releasePending || starting || recordingTasks > 0;
    refs.save.textContent = busy ? '正在保存…' : '保存快捷键';
    refs.reset.disabled = busy || Boolean(recording) || releasePending || starting || recordingTasks > 0; refs.revert.disabled = busy || !dirty || starting || recordingTasks > 0;
    refs.notice.textContent = notice || status.error || (status.enabled === false ? status.reason : '');
    refs.notice.classList.toggle('is-error', failed || Boolean(status.error));
    refs.notice.setAttribute('role', failed || status.error ? 'alert' : 'status');
    refs.recording.textContent = recording ? '按下 Ctrl、Alt 或 Win 搭配的组合键，Esc 取消。' : recordingTasks > 0 && !starting ? '正在恢复快捷键…' : '';
  }
  function receive(prefs = {}, next = {}) {
    saved = { ...defaults, ...(prefs.shortcuts || {}) }; status = next.shortcuts || {};
    if (!dirty) { draft = { ...saved }; }
    if ((recording || releasePending) && status.recording === false) { recording = null; releasePending = false; notice = '录制已结束，原快捷键已恢复。'; }
    sync();
  }
  async function endRecording() {
    const needed = recording || releasePending || starting;
    recordingEpoch++; recording = null; releasePending = false; starting = false; startingId = null;
    if (!needed) { sync(); return recordingWork; }
    return enqueueRecording(async () => {
      const result = await invoke('shortcut-recording', { active: false });
      if (!result.ok) { failed = true; notice = result.error || '快捷键尚未恢复，请稍后重试。'; sync(); }
    });
  }
  function enqueueRecording(action) {
    recordingTasks++; sync();
    const work = recordingWork.then(action).finally(() => { recordingTasks--; sync(); });
    recordingWork = work.catch(() => {}); return work;
  }
  function beginRecording(id) {
    if (busy || disposed) return;
    const previous = recording || releasePending || starting;
    const epoch = ++recordingEpoch;
    recording = null; releasePending = false; starting = true; startingId = id; sync();
    return enqueueRecording(async () => {
      if (previous) await invoke('shortcut-recording', { active: false });
      if (epoch !== recordingEpoch || disposed) return;
      const result = await invoke('shortcut-recording', { active: true });
      if (epoch !== recordingEpoch || disposed) {
        if (result.ok) await invoke('shortcut-recording', { active: false });
        return;
      }
      starting = false; startingId = null;
      if (!result.ok) { failed = true; notice = result.error || '暂时无法录制，请重试。'; sync(); return; }
      recording = id; notice = ''; failed = false; sync(); refs[id]?.key.focus();
    });
  }
  function recordedKey(event) {
    if (/^(Key[A-Z]|Digit[0-9])$/.test(event.code)) return event.code.replace(/^(Key|Digit)/, '');
    if (/^F([1-9]|1\d|2[0-4])$/.test(event.key)) return event.key;
    return ({ ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Space: 'Space', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown' })[event.code];
  }
  const onKey = event => {
    if (!recording && !releasePending) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (releasePending) return;
    if (event.key === 'Escape') { notice = '已取消录制'; void endRecording(); return; }
    if (event.repeat || /^(Control|Alt|Shift|Meta)$/.test(event.key)) return;
    const key = recordedKey(event);
    if (!key || !(event.ctrlKey || event.altKey || event.metaKey)) { notice = '请使用 Ctrl、Alt 或 Win 搭配字母、数字或功能键。'; failed = true; sync(); return; }
    const value = [event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Super', key].filter(Boolean).join('+');
    const duplicate = Object.keys(draft).find(id => id !== recording && draft[id] === value);
    if (duplicate) { notice = `这个组合键已用于“${shortcutDefinitions.find(([id]) => id === duplicate)[1]}”。`; failed = true; sync(); return; }
    draft[recording] = value; dirty = true; notice = '组合键已录入，保存后生效。'; failed = false;
    recording = null; releasePending = true; sync();
  };
  const onKeyUp = event => {
    if (!releasePending || /^(Control|Alt|Shift|Meta)$/.test(event.key)) return;
    event.preventDefault(); event.stopImmediatePropagation(); void endRecording();
  };
  const onBlur = () => { void endRecording(); };
  document.addEventListener('keydown', onKey, true); document.addEventListener('keyup', onKeyUp, true); window.addEventListener('blur', onBlur);
  async function persist() {
    if (busy || disposed) return;
    busy = true; notice = ''; failed = false; sync();
    try {
      await endRecording(); await recordingWork;
      const result = await save({ shortcuts: { ...draft } });
      if (!result?.ok) throw Error(result?.error || '保存失败，请重试。');
      const prefs = result.value?.prefs || result.value?.settings?.prefs;
      if (prefs) { saved = { ...defaults, ...prefs.shortcuts }; }
      else { saved = { ...draft }; }
      draft = { ...saved }; dirty = false; notice = '快捷键已保存';
    } catch (error) { failed = true; notice = error.message; }
    finally { busy = false; sync(); }
  }
  function mount(container) {
    root = element('section', 'shortcuts-page'); refs = {};
    root.setAttribute('aria-label', '快捷键设置');
    root.append(element('h2', '', '快捷键'), element('p', 'hint', '在其他软件中也能使用。点击组合键修改，留空的功能可以按需设置。'));
    let group;
    for (const [id, label, description, , category] of shortcutDefinitions) {
      if (group?.dataset.category !== category) {
        group = element('section', 'shortcut-group'); group.dataset.category = category;
        group.append(element('h3', '', category)); root.append(group);
      }
      const row = element('div', 'shortcut-row'), copy = element('div', 'shortcut-copy');
      copy.title = description;
      copy.append(element('span', 'shortcut-name', label), element('span', 'shortcut-description', description));
      const key = button('', 'shortcut-key', () => beginRecording(id)); key.dataset.field = `shortcut-${id}`; key.title = description;
      const clear = button('×', 'shortcut-clear', async () => { await endRecording(); draft[id] = ''; dirty = true; notice = ''; failed = false; sync(); });
      clear.title = `清除${label}快捷键`; clear.setAttribute('aria-label', clear.title);
      const message = element('span', 'shortcut-status'); message.setAttribute('aria-live', 'polite');
      row.append(copy, key, clear, message); group.append(row); refs[id] = { key, clear, status: message };
    }
    refs.recording = element('p', 'shortcut-recording'); refs.recording.setAttribute('role', 'status');
    refs.notice = element('p', 'shortcut-notice'); refs.notice.setAttribute('aria-live', 'polite');
    const actions = element('div', 'shortcut-actions');
    refs.reset = button('恢复默认', 'secondary', () => { draft = { ...defaults }; dirty = true; notice = '默认组合键已填入，保存后生效。'; failed = false; sync(); });
    refs.revert = button('撤销修改', 'text-button', async () => { await endRecording(); draft = { ...saved }; dirty = false; failed = false; notice = ''; sync(); });
    refs.save = button('保存快捷键', 'primary', persist);
    actions.append(refs.reset, refs.revert, refs.save); root.append(refs.recording, refs.notice, actions); container.append(root); sync();
  }
  function dispose() { void endRecording(); disposed = true; document.removeEventListener('keydown', onKey, true); document.removeEventListener('keyup', onKeyUp, true); window.removeEventListener('blur', onBlur); }
  return { receive, mount, dispose, endRecording };
}
