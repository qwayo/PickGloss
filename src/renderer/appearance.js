/* 外观设置只通过宿主提供的安全保存方法持久化，草稿仅用于当前页面预览。 */
const DEFAULT_VALUES = Object.freeze({ mode: 'dark', material: 'solid', accent: '#000000', tint: '#bfc2c8', opacity: 82, blur: 26 });
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
  let data = normalize(), status = {}, draft = {}, editorName = '', nameDirty = false;
  let root = null, refs = {}, busy = false, notice = '', failed = false, editorOpen = true, disposed = false, receiveVersion = 0;
  const invalidColors = new Map();
  const preview = () => ({ ...data.current, ...draft });
  const activePreset = () => data.presets.find(preset => preset.id === data.active);
  const hasDraft = () => Object.keys(draft).length > 0 || invalidColors.size > 0;

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
      system: 'M3 4h18v13H3ZM8 21h8m-4-4v4', check: 'm5 12 4 4L19 6', chevron: 'm6 9 6 6 6-6'
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
    refs.state.textContent = hasDraft() ? '未保存的配色' : activePreset()?.name || '默认配色';
    refs.notice.textContent = notice;
    refs.notice.classList.toggle('is-error', failed);
    refs.notice.setAttribute('role', failed ? 'alert' : 'status');
    root.setAttribute('aria-busy', String(busy));
    refs.mode.forEach(node => { node.setAttribute('aria-pressed', String(node.dataset.mode === current.mode)); node.disabled = busy; });
    refs.material.forEach(node => { node.setAttribute('aria-pressed', String(node.dataset.material === current.material)); node.disabled = busy; });
    refs.presets.querySelectorAll('button').forEach(node => { node.setAttribute('aria-pressed', String(!hasDraft() && node.dataset.preset === data.active)); node.disabled = busy; });
    refs.opacityOut.value = `${current.opacity}%`;
    refs.blurOut.value = `${current.blur} 像素`;
    refs.glass.hidden = current.material !== 'glass';
    refs.fallback.hidden = current.material !== 'glass' || status.appearanceMaterial === 'glass';
    refs.update.hidden = !activePreset();
    refs.save.disabled = busy; refs.update.disabled = busy; refs.reset.disabled = busy || !hasDraft();
    refs.save.textContent = busy ? '正在保存…' : '保存为新预设';
    refs.pin.forEach(node => { node.setAttribute('aria-pressed', String(node.dataset.pinOutline === data.pinOutline)); node.disabled = busy; });
    ['accent', 'tint'].forEach(syncPicker);
    refs.motion.checked = data.reducedMotion; refs.motion.disabled = busy;
    refs.systemMotion.hidden = !motionMedia.matches;
    refs.editor.open = editorOpen;
  }

  function renderPresets() {
    if (!root) return;
    const nodes = [{ id: 'default', name: '默认配色', values: DEFAULT_VALUES }, ...data.presets].map(preset => {
      const node = button('', 'appearance-preset', () => selectPreset(preset.id));
      node.dataset.preset = preset.id;
      const dot = element('span', 'appearance-preset-dot'); dot.style.setProperty('--preset-color', values(preset.values).accent); dot.setAttribute('aria-hidden', 'true');
      node.append(dot, element('span', 'appearance-preset-name', preset.name), icon('check'));
      return node;
    });
    refs.presets.replaceChildren(...nodes);
  }

  function receive(appearance, nextStatus = {}) {
    if (disposed) return;
    data = normalize(appearance); status = nextStatus || {}; receiveVersion += 1;
    if (!nameDirty) editorName = activePreset()?.name || '';
    apply(); renderPresets(); syncFields(); sync();
  }

  async function persist(next, message, onSuccess) {
    if (busy || disposed) return false;
    busy = true; failed = false; notice = '正在保存…'; sync();
    const version = receiveVersion;
    try {
      const result = await save(copy(next));
      if (disposed) return false;
      if (!result?.ok) throw new Error(typeof result?.error === 'string' ? result.error : result?.error?.message || '暂时无法保存，请重试。');
      const returned = result.value?.prefs?.appearance || result.value?.appearance || (result.value?.current ? result.value : null);
      if (returned) data = normalize(returned);
      else if (receiveVersion === version) data = normalize(next);
      onSuccess?.();
      notice = message; failed = false; apply(); renderPresets(); syncFields();
      return true;
    } catch (error) {
      notice = `${error?.message || '暂时无法保存，请重试。'} 当前配色与名称已保留。`; failed = true;
      return false;
    } finally {
      busy = false;
      if (!disposed) { sync(); refresh(); }
    }
  }

  function saveImmediate(key, value) {
    const next = copy(data);
    if (key === 'reducedMotion' || key === 'pinOutline') next[key] = value;
    else next.current[key] = value;
    void persist(next, '外观设置已保存。');
  }

  function selectPreset(id) {
    const preset = data.presets.find(item => item.id === id);
    if (id !== 'default' && !preset) return;
    const next = copy(data);
    next.current = preset ? copy(preset.values) : { ...DEFAULT_VALUES }; next.active = id;
    const submittedDraft = copy(draft), submittedInvalid = new Map(invalidColors), submittedName = editorName;
    void persist(next, id === 'default' ? '已切换到默认配色。' : `已切换到「${preset.name}」。`, () => {
      Object.keys(submittedDraft).forEach(key => { if (draft[key] === submittedDraft[key]) delete draft[key]; });
      submittedInvalid.forEach((value, key) => { if (invalidColors.get(key) === value) invalidColors.delete(key); });
      if (editorName === submittedName) { editorName = preset?.name || ''; nameDirty = false; }
    });
  }

  function edit(key, value) {
    draft[key] = value; notice = ''; failed = false;
    apply(); sync();
  }

  function savePreset(update) {
    const name = editorName.trim();
    let error = '';
    if (invalidColors.size) error = '请输入以 # 开头的六位颜色值。';
    else if (!name || [...name].length > 24 || /[\u0000-\u001f\u007f]/.test(name)) error = '预设名称需为 1 至 24 个字符。';
    else if (data.presets.some(preset => nameKey(preset.name) === nameKey(name) && (!update || preset.id !== data.active))) error = '已有同名预设，请换个名字，或选中它后更新。';
    else if (!update && data.presets.length >= 50) error = '最多保存 50 套预设，请选择已有预设后更新。';
    if (error) {
      notice = error; failed = true; sync();
      if (invalidColors.size) refs[`${invalidColors.keys().next().value}Text`].focus(); else refs.name.focus();
      return;
    }
    const next = copy(data), submittedDraft = copy(draft), submittedName = editorName;
    const current = values(preview());
    if (update) {
      const preset = next.presets.find(item => item.id === next.active);
      if (!preset) return;
      preset.name = name; preset.values = copy(current);
    } else {
      const id = window.crypto.randomUUID();
      next.presets.push({ id, name, values: copy(current) }); next.active = id;
    }
    next.current = current;
    void persist(next, update ? `已更新「${name}」。` : `已保存「${name}」。`, () => {
      Object.keys(submittedDraft).forEach(key => { if (draft[key] === submittedDraft[key]) delete draft[key]; });
      if (editorName === submittedName) { editorName = name; nameDirty = false; }
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
    hue.addEventListener('input', () => pickColor(key, { h: Number(hue.value) })); picker.append(plane, hue); return picker;
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
    base.append(modeHeading, modeGroup, element('h3', '', '窗口材质'), materialGroup, refs.fallback, element('h3', '', '已保存的配色'), refs.presets);
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
    const nameLabel = element('label', 'appearance-name-label', '预设名称');
    refs.name = element('input', 'appearance-name'); refs.name.type = 'text'; refs.name.autocomplete = 'off'; refs.name.placeholder = '例如：雨夜银灰'; refs.name.dataset.field = 'appearance-name'; refs.name.setAttribute('aria-label', '预设名称，1 至 24 个字符');
    refs.name.addEventListener('input', () => { editorName = refs.name.value; nameDirty = true; notice = ''; failed = false; sync(); });
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
        else { invalidColors.set(key, value); notice = '颜色需使用 # 加六位十六进制数字。'; failed = true; sync(); }
      });
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
      row.append(heading, refs[key]); refs.glass.append(row);
    });
    refs.glass.append(element('p', 'appearance-helper', '背景柔化用于页面背景层，窗口磨砂由系统控制。'));
    const help = element('p', 'appearance-helper', '修改颜色时即时预览，保存后可以随时切换。'); help.id = 'appearance-color-help';
    const actions = element('div', 'appearance-save-actions');
    refs.save = button('保存为新预设', 'appearance-primary', () => savePreset(false));
    refs.update = button('更新当前预设', 'appearance-secondary', () => savePreset(true));
    refs.reset = button('撤销配色修改', 'appearance-reset', () => { draft = {}; invalidColors.clear(); notice = ''; failed = false; apply(); syncFields(); sync(); });
    actions.append(refs.save, refs.update, refs.reset);
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
  schemeMedia.addEventListener('change', mediaChanged); motionMedia.addEventListener('change', mediaChanged);
  function dispose() { disposed = true; schemeMedia.removeEventListener('change', mediaChanged); motionMedia.removeEventListener('change', mediaChanged); root?.remove(); root = null; refs = {}; }
  return { receive, mount, apply, dispose };
}
