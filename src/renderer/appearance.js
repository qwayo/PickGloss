/* 外观设置即时预览，并通过宿主提供的安全保存方法串行自动持久化。 */
const DEFAULT_VALUES = Object.freeze({ mode: 'dark', material: 'solid', accent: '#000000', tint: '#bfc2c8', opacity: 82, blur: 26 });
const AUTOSAVE_DELAY_MS = 260;
const PIN_COLORS = { orange: ['暖橙', '#dc873d'], amber: ['琥珀', '#cf9f37'], blue: ['雾蓝', '#5095e8'], violet: ['淡紫', '#a47ee2'], mint: ['薄荷', '#4db393'], silver: ['银灰', '#a8b2c1'], none: ['无描边', 'transparent'] };
const copy = value => JSON.parse(JSON.stringify(value));
const validHex = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
const rgb = color => [1, 3, 5].map(index => parseInt(color.slice(index, index + 2), 16));
const hex = values => '#' + values.map(value => Math.round(value).toString(16).padStart(2, '0')).join('');
const mix = (a, b, amount) => hex(rgb(a).map((value, index) => value * (1 - amount) + rgb(b)[index] * amount));
const luminance = color => rgb(color).map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);
const rgba = (color, opacity) => `rgba(${rgb(color).join(', ')}, ${opacity})`;
const nameKey = name => name.trim().normalize('NFKC').toLowerCase();

function values(input = {}) {
  return {
    mode: ['dark', 'light', 'system'].includes(input.mode) ? input.mode : DEFAULT_VALUES.mode,
    material: input.material === 'glass' ? 'glass' : 'solid',
    accent: validHex(input.accent) ? input.accent.toLowerCase() : DEFAULT_VALUES.accent,
    tint: validHex(input.tint) ? input.tint.toLowerCase() : DEFAULT_VALUES.tint,
    opacity: Number.isFinite(input.opacity) ? Math.round(Math.max(72, Math.min(96, input.opacity))) : 82,
    blur: Number.isFinite(input.blur) ? Math.round(Math.max(8, Math.min(40, input.blur))) : 26
  };
}

function normalize(input = {}) {
  const presets = Array.isArray(input.presets) ? input.presets.filter(preset => preset && typeof preset.id === 'string' && typeof preset.name === 'string').slice(0, 50).map(preset => ({ id: preset.id, name: preset.name, values: values(preset.values) })) : [];
  return { current: values(input.current), active: input.active === 'default' || presets.some(preset => preset.id === input.active) ? input.active : 'default', presets, reducedMotion: input.reducedMotion === true, pinOutline: Object.hasOwn(PIN_COLORS, input.pinOutline) ? input.pinOutline : 'orange' };
}

function readable(color, backgrounds, dark) {
  let result = color;
  for (let index = 0; index < 36 && backgrounds.some(background => contrast(result, background) < 4.5); index += 1) result = mix(result, dark ? '#ffffff' : '#000000', .13);
  return result;
}

/** save 必须经 IPC 写入并读回；返回值可为外观对象、prefs.appearance 或状态快照。 */
export function createAppearanceUI({ save, refresh = () => {}, onReducedMotion = () => {} }) {
  const schemeMedia = window.matchMedia('(prefers-color-scheme: dark)');
  const motionMedia = window.matchMedia('(prefers-reduced-motion: reduce)');
  let data = normalize(), status = {}, editorName = '';
  let root = null, refs = {}, busy = false, notice = '', failed = false, noticeError = false, editorOpen = true, disposed = false;
  let revision = 0, savedRevision = 0, saveTimer = null, drainPromise = null;
  const afterSave = [];
  const invalidColors = new Map();
  const selectedPresets = new Set();
  let selectingPresets = false, confirmPresetDelete = false, pendingDelete = null;
  const preview = () => data.current;
  const activePreset = () => data.presets.find(preset => preset.id === data.active);
  const hasPendingSave = () => revision > savedRevision;
  const isDefaultValues = candidate => JSON.stringify(values(candidate)) === JSON.stringify(DEFAULT_VALUES);

  function appearanceFrom(result) {
    return result?.value?.prefs?.appearance || result?.value?.appearance || (result?.value?.current ? result.value : null);
  }

  function syncCurrentPreset() {
    const preset = activePreset();
    if (preset) preset.values = values(data.current);
  }

  function snapshotForSave() {
    const snapshot = copy(data);
    if (pendingDelete) {
      const ids = pendingDelete.ids;
      snapshot.presets = snapshot.presets.filter(preset => !ids.has(preset.id));
      if (ids.has(snapshot.active)) snapshot.active = 'default';
    }
    return snapshot;
  }

  function apply() {
    if (disposed) return;
    const current = preview();
    const dark = current.mode === 'dark' || current.mode === 'system' && (typeof status.appearanceDark === 'boolean' ? status.appearanceDark : schemeMedia.matches);
    const mono = current.accent === DEFAULT_VALUES.accent && current.tint === DEFAULT_VALUES.tint;
    const material = current.material === 'glass' && status.appearanceMaterial === 'glass' ? 'glass' : 'solid';
    const paper = mono ? (dark ? '#252525' : '#ffffff') : mix(current.tint, dark ? '#252525' : '#ffffff', .94);
    const ink = dark ? '#e5e7eb' : '#151412';
    const soft = mono ? (dark ? '#303030' : '#f0f0f0') : mix(paper, current.tint, dark ? .09 : .14);
    const field = mono ? (dark ? '#2c2c2c' : '#fafafa') : mix(paper, '#ffffff', dark ? .055 : .3);
    const selected = mono ? (dark ? '#3b3b3b' : '#eaeaea') : mix(paper, current.accent, dark ? .15 : .12);
    // 磨砂表面的可读性按背后为最不利的纯白／纯黑计算。
    const worstSurface = material === 'glass' ? mix(dark ? '#ffffff' : '#000000', paper, current.opacity / 100) : paper;
    const backgrounds = [paper, worstSurface, field, soft, selected];
    const accent = mono ? (dark ? '#e1e3e7' : '#000000') : current.accent;
    const tokens = {
      '--pin-stroke': data.pinOutline === 'none' ? 'var(--line)' : PIN_COLORS[data.pinOutline][1],
      '--pin-glow': data.pinOutline === 'none' ? '0 0 0' : rgb(PIN_COLORS[data.pinOutline][1]).join(' '),
      '--context-surface': mix(paper, dark ? '#ffffff' : '#000000', dark ? .045 : .025),
      '--paper': paper, '--ink': readable(ink, backgrounds, dark), '--muted': readable(dark ? '#bfc2c8' : '#5e5b55', backgrounds, dark),
      '--line': mono ? (dark ? '#303136' : '#d4d0c9') : mix(paper, dark ? '#ffffff' : '#000000', dark ? .2 : .18),
      '--soft': soft, '--accent': accent, '--accent-ink': readable(mono ? ink : current.accent, backgrounds, dark),
      '--on-accent': contrast(accent, '#ffffff') >= 4.5 ? '#ffffff' : '#050505',
      '--surface': material === 'glass' ? rgba(paper, current.opacity / 100) : paper,
      '--surface-secondary': material === 'glass' ? rgba(soft, .9) : (mono ? (dark ? '#292929' : '#f5f5f5') : soft),
      '--field': field, '--selected': selected, '--selected-text': readable(ink, [selected], dark),
      '--blur': `${current.blur}px`, '--glass-tint': rgba(current.tint, dark ? .06 : .1),
      '--shadow': dark ? '0 4px 12px #0005, 0 20px 55px #0005' : '0 3px 8px #25231f12, 0 20px 48px #25231f1d',
      '--danger': readable(dark ? '#ffb4a9' : '#8c3028', backgrounds, dark), '--danger-bg': dark ? '#351a18' : '#f8e9e5', '--warning-bg': dark ? '#302719' : '#f3ead9'
    };
    const html = document.documentElement;
    Object.entries(tokens).forEach(([key, value]) => html.style.setProperty(key, value));
    html.dataset.appearance = dark ? 'dark' : 'light';
    html.dataset.material = material;
    html.dataset.themeMode = current.mode;
    html.dataset.palette = mono ? 'mono' : 'custom';
    html.dataset.pinOutline = data.pinOutline;
    const reduce = data.reducedMotion || motionMedia.matches || status.reducedMotion === true;
    html.classList.toggle('reduced-motion', reduce);
    if (reduce) onReducedMotion();
    html.style.colorScheme = dark ? 'dark' : 'light';
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(text, className, handler) {
    const node = element('button', className, text);
    node.type = 'button';
    node.addEventListener('click', handler);
    return node;
  }

  function icon(kind) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    node.setAttribute('viewBox', '0 0 24 24'); node.setAttribute('class', 'appearance-icon'); node.setAttribute('aria-hidden', 'true');
    const paths = {
      light: 'M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
      dark: 'M20 14a8.5 8.5 0 0 1-10-10 8.5 8.5 0 1 0 10 10Z',
      system: 'M3 4h18v13H3ZM8 21h8m-4-4v4', check: 'm5 12 4 4L19 6', chevron: 'm6 9 6 6 6-6',
      select: 'M4 5h4v4H4ZM4 15h4v4H4ZM12 7h8M12 17h8', close: 'M5 5l14 14M19 5L5 19',
      trash: 'M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7'
    };
    const path = document.createElementNS(node.namespaceURI, 'path'); path.setAttribute('d', paths[kind]); node.append(path);
    return node;
  }

  function syncFields() {
    if (!root) return;
    const current = preview();
    ['accent', 'tint'].forEach(key => {
      refs[key].value = current[key];
      refs[`${key}Text`].value = invalidColors.has(key) ? invalidColors.get(key) : current[key];
      refs[`${key}Text`].setAttribute('aria-invalid', String(invalidColors.has(key)));
    });
    ['opacity', 'blur'].forEach(key => { refs[key].value = current[key]; });
    refs.name.value = editorName;
  }

  function sync() {
    if (!root) return;
    const current = preview();
    refs.state.textContent = invalidColors.size ? '颜色待修正' : busy ? '正在自动保存…' : failed ? '自动保存失败' : hasPendingSave() ? '等待自动保存' : data.active === 'default' ? (isDefaultValues(current) ? '默认配色' : '自定义配色') : activePreset()?.name || '自定义配色';
    refs.notice.textContent = notice;
    refs.notice.classList.toggle('is-error', failed || noticeError || invalidColors.size > 0);
    refs.notice.setAttribute('role', failed || noticeError || invalidColors.size ? 'alert' : 'status');
    root.setAttribute('aria-busy', String(busy));
    refs.mode.forEach(node => { node.setAttribute('aria-pressed', String(node.dataset.mode === current.mode)); });
    refs.material.forEach(node => { node.setAttribute('aria-pressed', String(node.dataset.material === current.material)); });
    refs.presets.querySelectorAll('button').forEach(node => {
      node.setAttribute('aria-pressed', String(selectingPresets ? selectedPresets.has(node.dataset.preset) : node.dataset.preset === data.active && (node.dataset.preset !== 'default' || isDefaultValues(current))));
      node.disabled = selectingPresets && (busy || node.dataset.preset === 'default');
    });
    refs.manage.disabled = busy || !data.presets.length;
    refs.manage.setAttribute('aria-pressed', String(selectingPresets));
    const manageLabel = selectingPresets ? '退出配色多选' : '多选删除配色';
    refs.manage.title = manageLabel; refs.manage.setAttribute('aria-label', manageLabel);
    refs.manage.replaceChildren(icon(selectingPresets ? 'close' : 'select'));
    renderPresetSelection();
    refs.opacityOut.value = `${current.opacity}%`;
    refs.blurOut.value = `${current.blur} 像素`;
    refs.glass.hidden = current.material !== 'glass';
    refs.fallback.hidden = current.material !== 'glass' || status.appearanceMaterial === 'glass';
    refs.add.disabled = false;
    refs.retry.hidden = !failed;
    refs.retry.disabled = busy;
    refs.pin.forEach(node => { node.setAttribute('aria-pressed', String(node.dataset.pinOutline === data.pinOutline)); });
    ['accent', 'tint'].forEach(syncPicker);
    refs.motion.checked = data.reducedMotion;
    refs.systemMotion.hidden = !motionMedia.matches;
    refs.editor.open = editorOpen;
  }

  function renderPresets() {
    if (!root) return;
    const nodes = [{ id: 'default', name: '默认配色', values: DEFAULT_VALUES }, ...data.presets].map(preset => {
      const node = button('', 'appearance-preset', () => {
        if (!selectingPresets) { selectPreset(preset.id); return; }
        if (busy || preset.id === 'default') return;
        if (selectedPresets.has(preset.id)) selectedPresets.delete(preset.id); else selectedPresets.add(preset.id);
        confirmPresetDelete = false; sync();
      });
      node.dataset.preset = preset.id;
      if (selectingPresets) node.setAttribute('aria-label', preset.id === 'default' ? '默认配色不能删除' : `选择配色：${preset.name}`);
      const dot = element('span', 'appearance-preset-dot'); dot.style.setProperty('--preset-color', values(preset.values).accent); dot.setAttribute('aria-hidden', 'true');
      node.append(dot, element('span', 'appearance-preset-name', preset.name), icon('check'));
      return node;
    });
    refs.presets.replaceChildren(...nodes);
  }

  function receive(appearance, nextStatus = {}) {
    if (disposed) return;
    status = nextStatus || {};
    // 保存中的旧状态推送不能覆盖本地尚未落盘的输入；成功后 refresh 再读回主进程快照。
    if (busy || hasPendingSave()) { apply(); sync(); return; }
    data = normalize(appearance);
    for (const id of selectedPresets) if (!data.presets.some(preset => preset.id === id)) selectedPresets.delete(id);
    if (!data.presets.length) { selectingPresets = false; confirmPresetDelete = false; }
    apply(); renderPresets(); syncFields(); sync();
  }

  function markChanged({ immediate = false, message = '更改将在片刻后自动保存。' } = {}) {
    if (disposed) return savedRevision;
    revision += 1; failed = false; noticeError = false; notice = message;
    if (saveTimer !== null) { clearTimeout(saveTimer); saveTimer = null; }
    apply(); renderPresets(); syncFields(); sync();
    if (immediate) void flush();
    else if (!invalidColors.size) saveTimer = setTimeout(() => { saveTimer = null; void flush(); }, AUTOSAVE_DELAY_MS);
    return revision;
  }

  function afterCommit(version, callback) {
    afterSave.push({ version, callback });
  }

  /** 立即提交尚未落盘的最新快照；多次调用共享同一串行队列。 */
  function flush() {
    if (saveTimer !== null) { clearTimeout(saveTimer); saveTimer = null; }
    if (invalidColors.size) {
      notice = '颜色需使用 # 加六位十六进制数字，修正后会自动保存。'; failed = false; noticeError = true; sync();
      return Promise.resolve({ ok: false, error: notice });
    }
    if (drainPromise) return drainPromise;
    // 移除有焦点的控件会触发 blur；空提交不能再通知宿主重绘，否则会循环失焦。
    if (!hasPendingSave()) return Promise.resolve({ ok: true });
    drainPromise = (async () => {
      let last = { ok: true };
      while (savedRevision < revision) {
        if (invalidColors.size) {
          notice = '颜色需使用 # 加六位十六进制数字，修正后会自动保存。'; failed = false; noticeError = true;
          last = { ok: false, error: notice }; break;
        }
        const version = revision, snapshot = snapshotForSave();
        busy = true; failed = false; notice = '正在自动保存…'; sync();
        let returned = null, error = null;
        try {
          const result = await save(snapshot);
          if (!result?.ok) throw new Error(typeof result?.error === 'string' ? result.error : result?.error?.message || '暂时无法保存，请重试。');
          returned = appearanceFrom(result);
        } catch (caught) { error = caught; }
        busy = false;
        if (error) {
          notice = `${error?.message || '暂时无法保存，请重试。'} 输入已保留，可重试保存。`; failed = true; noticeError = false;
          last = { ok: false, error: notice };
          if (revision === version) { sync(); break; }
          sync(); continue;
        }
        savedRevision = Math.max(savedRevision, version);
        if (revision === version) data = normalize(returned || snapshot);
        afterSave.splice(0, afterSave.length, ...afterSave.filter(item => {
          if (item.version > version) return true;
          item.callback(); return false;
        }));
        failed = false; noticeError = false;
        notice = revision === version ? '外观设置已自动保存。' : '正在保存最新更改…';
        last = { ok: true, value: copy(returned || snapshot) };
        apply(); renderPresets(); syncFields(); sync();
        if (revision > version && saveTimer !== null) { clearTimeout(saveTimer); saveTimer = null; }
      }
      return last;
    })().finally(() => {
      busy = false; drainPromise = null;
      if (!disposed) { sync(); refresh(); }
    });
    return drainPromise;
  }

  function renderPresetSelection() {
    refs.batch.hidden = !selectingPresets;
    refs.batch.replaceChildren();
    if (!selectingPresets) return;
    const tools = element('div', 'appearance-preset-toolbar');
    const all = button('全选', '', () => { if (busy) return; data.presets.forEach(preset => selectedPresets.add(preset.id)); confirmPresetDelete = false; sync(); });
    const clear = button('清空', '', () => { if (busy) return; selectedPresets.clear(); confirmPresetDelete = false; sync(); });
    const remove = button('', 'appearance-compact-icon is-danger', () => { if (busy || !selectedPresets.size) return; confirmPresetDelete = true; sync(); });
    remove.append(icon('trash')); remove.title = '删除所选配色'; remove.setAttribute('aria-label', '删除所选配色');
    all.disabled = busy; clear.disabled = remove.disabled = busy || !selectedPresets.size;
    tools.append(element('span', 'appearance-preset-count', `已选 ${selectedPresets.size}`), all, clear, remove); refs.batch.append(tools);
    if (confirmPresetDelete) {
      const confirm = element('div', 'appearance-preset-confirm');
      confirm.setAttribute('role', 'group'); confirm.setAttribute('aria-label', '确认删除配色');
      confirm.append(element('p', '', `删除所选 ${selectedPresets.size} 套预设？当前窗口配色会保留。`));
      const cancel = button('取消', '', () => {
        if (busy) return;
        pendingDelete = null; confirmPresetDelete = false; sync();
      });
      const submit = button('确认删除', 'is-danger', () => {
        if (busy || !selectedPresets.size) return;
        const ids = new Set(selectedPresets), deletedCount = data.presets.filter(preset => ids.has(preset.id)).length;
        const operation = pendingDelete = { ids };
        const version = markChanged({ immediate: true, message: `正在删除 ${deletedCount} 套预设…` });
        afterCommit(version, () => {
          if (pendingDelete !== operation) return;
          data.presets = data.presets.filter(preset => !ids.has(preset.id));
          if (ids.has(data.active)) data.active = 'default';
          pendingDelete = null;
          selectedPresets.clear(); selectingPresets = false; confirmPresetDelete = false;
          notice = `已删除 ${deletedCount} 套预设，当前配色已保留。`;
          if (!disposed) { renderPresets(); sync(); }
        });
      });
      cancel.disabled = busy; submit.disabled = busy || !selectedPresets.size; confirm.append(cancel, submit); refs.batch.append(confirm);
    }
  }

  function setSetting(key, value, immediate = false) {
    if (key === 'reducedMotion' || key === 'pinOutline') data[key] = value;
    else data.current[key] = value;
    syncCurrentPreset();
    return markChanged({ immediate });
  }

  function saveImmediate(key, value) {
    setSetting(key, value, true);
  }

  function selectPreset(id) {
    if (invalidColors.size) {
      notice = '请先修正颜色值，再切换配色。'; failed = false; noticeError = true; sync(); return;
    }
    const preset = data.presets.find(item => item.id === id);
    if (id !== 'default' && !preset) return;
    data.current = values(preset ? preset.values : DEFAULT_VALUES); data.active = id;
    markChanged({ immediate: true, message: id === 'default' ? '正在恢复默认配色…' : `正在切换到「${preset.name}」…` });
  }

  function edit(key, value) {
    setSetting(key, value, false);
  }

  function addPreset() {
    const name = editorName.trim();
    let error = '';
    if (invalidColors.size) error = '请输入以 # 开头的六位颜色值。';
    else if (!name || [...name].length > 24 || /[\u0000-\u001f\u007f]/.test(name)) error = '预设名称需为 1 至 24 个字符。';
    else if (data.presets.some(preset => nameKey(preset.name) === nameKey(name))) error = '已有同名预设，请换个名字。';
    else if (data.presets.length >= 50) error = '最多添加 50 套预设，请先删除不需要的预设。';
    if (error) {
      notice = error; failed = false; noticeError = true; sync();
      if (invalidColors.size) refs[`${invalidColors.keys().next().value}Text`].focus(); else refs.name.focus();
      return;
    }
    const id = window.crypto.randomUUID(), submittedName = editorName;
    data.presets.push({ id, name, values: values(data.current) }); data.active = id;
    const version = markChanged({ immediate: true, message: `正在添加「${name}」…` });
    afterCommit(version, () => {
      if (editorName === submittedName) { editorName = ''; syncFields(); }
      notice = `已添加「${name}」。`;
      if (!disposed) sync();
    });
  }

  const pickerHSV = {};
  function syncPicker(key) {
    const color = preview()[key];
    refs[key].style.backgroundColor = color;
    const [r, g, b] = rgb(color).map(v => v / 255), max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    const hue = !d ? (pickerHSV[key]?.h || 0) : ((max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60);
    pickerHSV[key] = { h: hue, s: max ? d / max : 0, v: max };
    const hsv = pickerHSV[key];
    refs[`${key}Plane`].style.setProperty('--hue', `${hsv.h}`);
    refs[`${key}Thumb`].style.left = `${hsv.s * 100}%`; refs[`${key}Thumb`].style.top = `${(1 - hsv.v) * 100}%`;
    refs[`${key}Plane`].setAttribute('aria-description', `饱和度 ${Math.round(hsv.s * 100)}%，亮度 ${Math.round(hsv.v * 100)}%`);
    refs[`${key}Hue`].value = hsv.h;
  }
  function pickColor(key, patch) {
    const hsv = { ...pickerHSV[key], ...patch }; pickerHSV[key] = hsv;
    const c = hsv.v * hsv.s, x = c * (1 - Math.abs((hsv.h / 60) % 2 - 1)), m = hsv.v - c;
    const parts = [[c,x,0],[x,c,0],[0,c,x],[0,x,c],[x,0,c],[c,0,x]][Math.floor(hsv.h / 60) % 6];
    const color = hex(parts.map(v => (v + m) * 255));
    invalidColors.delete(key); refs[`${key}Text`].value = color; refs[`${key}Text`].setAttribute('aria-invalid', 'false'); edit(key, color);
  }
  function createPicker(key, label) {
    const picker = element('div', 'appearance-color-picker'); picker.hidden = true; refs[`${key}Picker`] = picker;
    const plane = element('div', 'color-plane'); refs[`${key}Plane`] = plane; plane.dataset.colorPlane = key;
    plane.tabIndex = 0; plane.setAttribute('role', 'group'); plane.setAttribute('aria-label', `${label}饱和度与亮度，方向键调整`);
    const thumb = element('i', 'color-thumb'); thumb.setAttribute('aria-hidden', 'true'); refs[`${key}Thumb`] = thumb; plane.append(thumb);
    const move = event => { const r = plane.getBoundingClientRect(); pickColor(key, { s: Math.max(0, Math.min(1, (event.clientX - r.left) / r.width)), v: 1 - Math.max(0, Math.min(1, (event.clientY - r.top) / r.height)) }); };
    plane.addEventListener('pointerdown', event => { if (event.button !== 0) return; event.preventDefault(); plane.focus(); plane.setPointerCapture(event.pointerId); move(event); });
    plane.addEventListener('pointermove', event => { if (plane.hasPointerCapture(event.pointerId)) move(event); });
    plane.addEventListener('pointerup', event => { if (plane.hasPointerCapture(event.pointerId)) plane.releasePointerCapture(event.pointerId); });
    plane.addEventListener('keydown', event => { const steps = { ArrowLeft: [-.01,0], ArrowRight: [.01,0], ArrowUp: [0,.01], ArrowDown: [0,-.01] }; if (!steps[event.key]) return; event.preventDefault(); const [s,v] = steps[event.key], hsv = pickerHSV[key]; pickColor(key, { s: Math.max(0,Math.min(1,hsv.s+s)), v: Math.max(0,Math.min(1,hsv.v+v)) }); });
    const hue = element('input', 'color-hue'); hue.type = 'range'; hue.min = 0; hue.max = 359; hue.step = 1; hue.setAttribute('aria-label', `${label}色相`); refs[`${key}Hue`] = hue;
    hue.addEventListener('input', () => pickColor(key, { h: Number(hue.value) }));
    hue.addEventListener('change', () => { void flush(); }); hue.addEventListener('blur', () => { void flush(); });
    picker.append(plane, hue); return picker;
  }

  function mount(container) {
    if (disposed) return;
    if (root?.parentNode) root.remove();
    root = element('section', 'appearance-page'); refs = {};
    root.setAttribute('aria-label', '外观与主题');
    const heading = element('div', 'appearance-title'); refs.state = element('span');
    heading.append(element('h2', '', '外观与主题'));
    const modeHeading = element('div', 'appearance-mode-heading');
    modeHeading.append(element('h3', '', '明暗模式'), refs.state);
    const layout = element('div', 'appearance-layout'), base = element('section', 'appearance-base'), custom = element('section', 'appearance-custom');
    const modeGroup = element('div', 'appearance-modes'); modeGroup.setAttribute('role', 'group'); modeGroup.setAttribute('aria-label', '明暗模式');
    refs.mode = [['light', '浅色'], ['dark', '深色'], ['system', '跟随系统']].map(([key, label]) => {
      const node = button('', '', () => saveImmediate('mode', key)); node.dataset.mode = key;
      node.append(icon(key), element('span', '', label)); return node;
    }); modeGroup.append(...refs.mode);
    const materialGroup = element('div', 'appearance-materials'); materialGroup.setAttribute('role', 'group'); materialGroup.setAttribute('aria-label', '窗口材质');
    refs.material = [['solid', '实色'], ['glass', '磨砂半透明']].map(([key, label]) => {
      const node = button('', '', () => saveImmediate('material', key)); node.dataset.material = key;
      const art = element('span', `appearance-material-art is-${key}`); art.setAttribute('aria-hidden', 'true'); art.append(element('i'));
      node.append(art, element('span', '', label)); return node;
    }); materialGroup.append(...refs.material);
    refs.fallback = element('p', 'appearance-helper appearance-fallback', '此设备暂不支持磨砂，已使用实色。'); refs.fallback.setAttribute('role', 'status');
    refs.presets = element('div', 'appearance-presets'); refs.presets.setAttribute('role', 'group'); refs.presets.setAttribute('aria-label', '已保存的配色');
    const presetsHeading = element('div', 'appearance-preset-heading');
    refs.manage = button('', 'appearance-compact-icon', () => {
      if (busy) return;
      selectingPresets = !selectingPresets; selectedPresets.clear(); confirmPresetDelete = false;
      renderPresets(); sync();
    });
    presetsHeading.append(element('h3', '', '已保存的配色'), refs.manage);
    refs.batch = element('div', 'appearance-preset-selection'); refs.batch.setAttribute('aria-label', '批量管理配色');
    base.append(modeHeading, modeGroup, element('h3', '', '窗口材质'), materialGroup, refs.fallback, presetsHeading, refs.batch, refs.presets);
    const pinGroup = element('div', 'appearance-pin-colors'); pinGroup.setAttribute('role', 'group'); pinGroup.setAttribute('aria-label', '置顶边缘描边');
    refs.pin = Object.entries(PIN_COLORS).map(([key, [label, color]]) => {
      const node = button(label, 'appearance-pin-color', () => saveImmediate('pinOutline', key)); node.dataset.pinOutline = key;
      node.style.setProperty('--swatch', color); node.prepend(element('i')); node.title = key === 'none' ? '保持置顶，隐藏描边和外光' : label;
      return node;
    }); pinGroup.append(...refs.pin);
    base.append(element('h3', '', '置顶边缘描边'), pinGroup);
    refs.editor = element('details', 'appearance-editor'); refs.editor.open = editorOpen;
    const summary = element('summary', '', '自定义主题'); summary.append(icon('chevron'));
    refs.editor.addEventListener('toggle', () => { if (root?.contains(refs.editor)) editorOpen = refs.editor.open; });
    const fields = element('div', 'appearance-editor-fields');
    const nameLabel = element('label', 'appearance-name-label', '新预设名称（仅“添加预设”时使用）');
    refs.name = element('input', 'appearance-name'); refs.name.type = 'text'; refs.name.autocomplete = 'off'; refs.name.placeholder = '例如：雨夜银灰'; refs.name.dataset.field = 'appearance-name'; refs.name.setAttribute('aria-label', '预设名称，1 至 24 个字符');
    refs.name.addEventListener('input', () => { editorName = refs.name.value; if (!failed) { notice = ''; noticeError = false; } sync(); });
    nameLabel.append(refs.name);
    const colors = element('div', 'appearance-colors');
    [['accent', '强调色'], ['tint', '底色倾向']].forEach(([key, label]) => {
      const group = element('div', 'appearance-color-field'), title = element('span', '', label);
      refs[key] = button('', 'appearance-color-toggle', () => { const open = refs[`${key}Picker`].hidden; ['accent', 'tint'].forEach(k => { refs[`${k}Picker`].hidden = true; refs[k].setAttribute('aria-expanded', 'false'); }); refs[`${key}Picker`].hidden = !open; refs[key].setAttribute('aria-expanded', String(open)); }); refs[key].setAttribute('aria-label', `${label}取色`); refs[key].setAttribute('aria-expanded', 'false'); refs[key].dataset.colorToggle = key;
      refs[key].dataset.field = `appearance-${key}-picker`;
      refs[`${key}Text`] = element('input', 'appearance-hex'); refs[`${key}Text`].type = 'text'; refs[`${key}Text`].maxLength = 7; refs[`${key}Text`].spellcheck = false; refs[`${key}Text`].setAttribute('aria-label', `${label}十六进制色值`); refs[`${key}Text`].setAttribute('aria-describedby', 'appearance-color-help');
      refs[`${key}Text`].dataset.field = `appearance-${key}-hex`;
      refs[`${key}Text`].addEventListener('input', () => {
        const value = refs[`${key}Text`].value;
        refs[`${key}Text`].setAttribute('aria-invalid', String(!validHex(value)));
        if (validHex(value)) { invalidColors.delete(key); refs[key].value = value; edit(key, value.toLowerCase()); }
        else {
          invalidColors.set(key, value);
          if (saveTimer !== null) { clearTimeout(saveTimer); saveTimer = null; }
          notice = '颜色需使用 # 加六位十六进制数字；修正后会自动保存。'; failed = false; noticeError = true; sync();
        }
      });
      refs[`${key}Text`].addEventListener('change', () => { void flush(); });
      refs[`${key}Text`].addEventListener('blur', () => { void flush(); });
      const picker = createPicker(key, label);
      group.append(title, refs[key], refs[`${key}Text`], picker); colors.append(group);
    });
    refs.glass = element('div', 'appearance-glass-controls');
    [['opacity', '表面不透明度', 72, 96], ['blur', '背景柔化', 8, 40]].forEach(([key, label, min, max]) => {
      const row = element('label', 'appearance-range');
      const heading = element('span', 'appearance-range-heading', label); refs[`${key}Out`] = element('output'); heading.append(refs[`${key}Out`]);
      refs[key] = element('input'); refs[key].type = 'range'; refs[key].min = min; refs[key].max = max; refs[key].step = 1; refs[key].setAttribute('aria-label', label);
      refs[key].dataset.field = `appearance-${key}`;
      refs[key].addEventListener('input', () => edit(key, Number(refs[key].value)));
      refs[key].addEventListener('change', () => { void flush(); });
      refs[key].addEventListener('blur', () => { void flush(); });
      row.append(heading, refs[key]); refs.glass.append(row);
    });
    refs.glass.append(element('p', 'appearance-helper', '背景柔化用于页面背景层，窗口磨砂由系统控制。'));
    const help = element('p', 'appearance-helper', '外观调整会即时预览并自动保存；新预设仅在点击“添加预设”后创建。'); help.id = 'appearance-color-help';
    const actions = element('div', 'appearance-save-actions');
    refs.add = button('添加预设', 'appearance-primary', addPreset);
    refs.retry = button('重试自动保存', 'appearance-retry', () => { void flush(); });
    refs.retry.hidden = true;
    actions.append(refs.add, refs.retry);
    fields.append(nameLabel, colors, refs.glass, help, actions); refs.editor.append(summary, fields);
    const motion = element('label', 'appearance-motion'); refs.motion = element('input'); refs.motion.type = 'checkbox';
    refs.motion.dataset.field = 'appearance-reduced-motion';
    refs.motion.addEventListener('change', () => saveImmediate('reducedMotion', refs.motion.checked)); motion.append(refs.motion, element('span', '', '减少动态效果'));
    refs.systemMotion = element('p', 'appearance-helper', '系统已开启减少动态效果。');
    refs.notice = element('p', 'appearance-notice'); refs.notice.setAttribute('aria-live', 'polite'); refs.notice.setAttribute('aria-atomic', 'true');
    custom.append(refs.editor, motion, refs.systemMotion, refs.notice); layout.append(base, custom); root.append(heading, layout); container.append(root);
    renderPresets(); syncFields(); sync(); apply();
  }

  const mediaChanged = () => { apply(); sync(); };
  const visibilityChanged = () => { if (document.hidden) void flush(); };
  const pageHidden = () => { void flush(); };
  schemeMedia.addEventListener('change', mediaChanged); motionMedia.addEventListener('change', mediaChanged);
  document.addEventListener('visibilitychange', visibilityChanged);
  window.addEventListener('pagehide', pageHidden); window.addEventListener('beforeunload', pageHidden);
  function dispose() {
    if (disposed) return;
    void flush();
    if (saveTimer !== null) { clearTimeout(saveTimer); saveTimer = null; }
    disposed = true;
    schemeMedia.removeEventListener('change', mediaChanged); motionMedia.removeEventListener('change', mediaChanged);
    document.removeEventListener('visibilitychange', visibilityChanged); window.removeEventListener('pagehide', pageHidden); window.removeEventListener('beforeunload', pageHidden);
    root?.remove(); root = null; refs = {};
  }
  return { receive, mount, apply, flush, dispose };
}
