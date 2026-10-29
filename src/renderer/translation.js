const FALLBACK_LANGUAGES = [{ id: 'zh-Hans', name: '简体中文' }, { id: 'en', name: '英语' }, { id: 'ja', name: '日语' }];
export function translationSearchPreferences(options = {}) {
  return { searchEnabled: options.searchEnabled ?? options.deepSearchEnabled ?? true, searchScope: options.searchScope ?? 'deep' };
}
export function translationUsesSearch(options = {}) {
  const { searchEnabled, searchScope } = translationSearchPreferences(options);
  return searchEnabled && (searchScope === 'both' || searchScope === (options.translationMode ?? 'standard'));
}
export function toggleTranslationSearch(options = {}) {
  const { searchEnabled, searchScope } = translationSearchPreferences(options), mode = options.translationMode ?? 'standard';
  const modes = new Set(searchEnabled ? searchScope === 'both' ? ['standard', 'deep'] : [searchScope] : []);
  if (modes.has(mode)) modes.delete(mode); else modes.add(mode);
  return { searchEnabled: modes.size > 0, searchScope: modes.size === 2 ? 'both' : [...modes][0] ?? mode };
}
const node = (tag, className, text) => {
  const value = document.createElement(tag);
  if (className) value.className = className;
  if (text !== undefined) value.textContent = text;
  return value;
};

export function languageSelect(languages, value, label, includeAuto = false) {
  const select = node('select');
  select.setAttribute('aria-label', label);
  select.title = label;
  for (const language of [...(includeAuto ? [{ id: 'auto', name: '自动' }] : []), ...(languages?.length ? languages : FALLBACK_LANGUAGES)]) {
    const option = node('option', '', language.name); option.value = language.id; select.append(option);
  }
  select.value = value;
  return select;
}

function positioned(element, rect) {
  for (const key of ['left', 'top', 'width', 'height']) element.style[key] = `${rect[key]}px`;
}

function wrappedLines(context, text, width) {
  const lines = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const letter of Array.from(paragraph)) {
      if (line && context.measureText(line + letter).width > width) { lines.push(line); line = letter; }
      else line += letter;
    }
    lines.push(line);
  }
  return lines;
}

function sampleBackground(context, block, width, height) {
  const samples = [];
  for (const [x, y] of [[block.x - 2, block.y - 2], [block.x + block.width + 2, block.y - 2], [block.x - 2, block.y + block.height + 2], [block.x + block.width + 2, block.y + block.height + 2]]) {
    samples.push([...context.getImageData(Math.max(0, Math.min(width - 1, Math.round(x))), Math.max(0, Math.min(height - 1, Math.round(y))), 1, 1).data]);
  }
  return [0, 1, 2].map(channel => samples.map(sample => sample[channel]).sort((a, b) => a - b)[1]);
}

function blockLayout(context, block, data) {
  // OCR 段落框覆盖多行，字号依据平均行高；整段高度只决定可容纳的排版面积。
  const sourceLines = data.method === 'windows-ocr' ? Math.max(1, (block.text || '').split(/\r?\n/).length) : 1;
  const lineHeight = block.height / sourceLines;
  const padding = data.method === 'vision' ? 8 : Math.min(2, block.height * .06);
  const x = Math.max(0, block.x - padding), y = Math.max(0, block.y - padding);
  const area = { x, y, width: Math.min(data.width, block.x + block.width + padding) - x, height: Math.min(data.height, block.y + block.height + padding) - y };
  let size = Math.min(data.method === 'vision' ? 32 : lineHeight * .86, 64), lines = [];
  const minSize = Math.max(9, Math.min(size, lineHeight * .48));
  for (; size >= minSize; size -= 1) {
    context.font = `${size}px "Segoe UI","Microsoft YaHei UI",sans-serif`;
    lines = wrappedLines(context, block.translation, Math.max(1, area.width - 4));
    if (lines.length * size * 1.18 <= area.height) break;
  }
  return { area, size, lines, fits: size >= minSize && lines.every(line => context.measureText(line).width <= area.width) };
}

function controlIcon(kind) {
  const paths = {
    close: 'm5 5 14 14M19 5 5 19', retry: 'M20 7v5h-5M4 17v-5h5M6.1 7a7 7 0 0 1 11.6-1L20 9M4 15l2.3 3A7 7 0 0 0 18 17',
    pin: 'M9 3h6l-1 6 4 4v2H6v-2l4-4-1-6ZM12 15v6',
    copy: 'M9 8h11v13H9ZM4 16H2V3h11v2', capture: 'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M7 7h10v10H7Z',
    vision: 'M3 5h18v14H3Zm2 12 5-5 3 3 3-4 5 6M8 8h.01', check: 'm5 12 4 4L19 6',
    eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Zm10-3a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z',
    globe: 'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0ZM2 12h20M12 2c5 5 5 15 0 20-5-5-5-15 0-20Z',
  };
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', paths[kind]); svg.append(path);
  return svg;
}

function translationStatus(data, changedOptions, localError) {
  if (localError) return '操作未完成';
  if (['preparing-search', 'searching'].includes(data.status)) return data.status === 'searching' ? '联网查询中…' : '准备联网…';
  if (data.status === 'failed') return ['preparing', 'searching'].includes(data.search?.status) ? '联网失败' : data.method === 'vision' ? '识图失败' : '翻译失败';
  if (data.status === 'stopped') return '已停止';
  if (data.status === 'recognizing') return data.method === 'vision' ? '识图中…' : '本地 OCR · 识别中';
  if (data.status === 'complete' && changedOptions) return changedOptions;
  if (data.method === 'vision') {
    const mode = data.fallbackReason === 'manual' ? '识图模式' : data.fallbackReason === 'language' ? 'OCR 缺少语言 · 识图' : data.fallbackReason === 'quality' ? 'OCR 不清晰 · 识图' : data.fallbackReason === 'empty' ? 'OCR 无文字 · 识图' : data.fallbackReason === 'unavailable' ? 'OCR 失败 · 识图' : '识图模式';
    return data.status === 'translating' ? `${mode}中…` : mode;
  }
  return data.status === 'translating' ? '本地 OCR · 翻译中' : '本地 OCR · 完成';
}

export function createTranslationUI({ root, invoke, role = 'controls' }) {
  let current = null, languages = [], preferences = null, lastId = null, chosen = null, generation = 0, languageSaves = 0;
  let languageDraft = false, languageRevision = 0, languageError = '';
  let localError = '', copied = false, busy = false, actionSequence = 0, completedActionSequence = 0;
  let originalHold = null, previewDraining = false;
  let comparisonView = { id: null, scrollTop: 0, sourcesOpen: false };
  let measuredHeight = { id: null, value: null }, measurementFrame = 0;
  let activeControls = null;
  const previewPending = new Map();
  const scheduleContentMeasurement = (controls, id) => {
    if (role !== 'controls' || current?.id !== id || current.options.displayMode !== 'compare') return;
    if (measurementFrame) cancelAnimationFrame(measurementFrame);
    measurementFrame = requestAnimationFrame(() => {
      measurementFrame = 0;
      if (current?.id !== id || activeControls !== controls || root.querySelector('.translation-controls') !== controls || current.options.displayMode !== 'compare') return;
      const clone = controls.cloneNode(true);
      clone.removeAttribute('id');
      clone.querySelectorAll('[id]').forEach(element => element.removeAttribute('id'));
      clone.inert = true; clone.setAttribute('aria-hidden', 'true');
      const surface = node('main', 'translation-surface');
      surface.inert = true; surface.setAttribute('aria-hidden', 'true');
      Object.assign(surface.style, { position: 'fixed', left: '-10000px', top: '0', width: `${controls.getBoundingClientRect().width}px`, height: 'auto', visibility: 'hidden', pointerEvents: 'none', zIndex: '-1' });
      Object.assign(clone.style, { position: 'relative', left: 'auto', top: 'auto', width: '100%', height: 'auto', maxHeight: 'none', overflow: 'visible' });
      const comparison = clone.querySelector('.translation-comparison');
      if (comparison) Object.assign(comparison.style, { flex: 'none', height: 'auto', minHeight: '45px', maxHeight: 'none', overflow: 'visible' });
      surface.append(clone); document.body.append(surface);
      let contentHeight;
      try { contentHeight = Math.ceil(clone.getBoundingClientRect().height); }
      finally { surface.remove(); }
      if (!Number.isFinite(contentHeight) || contentHeight < 80 || measuredHeight.id === id && measuredHeight.value === contentHeight) return;
      measuredHeight = { id, value: contentHeight };
      void Promise.resolve(invoke('translation-content-height', { id, contentHeight }, { scope: 'translation', render: false, lock: false })).catch(() => {});
    });
  };
  const rememberComparisonView = () => {
    if (current?.id !== comparisonView.id) return;
    const comparison = root.querySelector('.translation-comparison');
    const sources = root.querySelector('.translation-sources');
    if (comparison) comparisonView.scrollTop = comparison.scrollTop;
    if (sources) comparisonView.sourcesOpen = sources.open;
  };
  window.addEventListener('resize', () => {
    if (activeControls && current?.options.displayMode === 'compare') scheduleContentMeasurement(activeControls, current.id);
  });
  const drainPreviews = () => {
    if (previewDraining) return;
    previewDraining = true;
    void (async () => {
      while (previewPending.size) {
        const [id, visible] = previewPending.entries().next().value;
        previewPending.delete(id);
        try {
          await invoke('preview-translation-original', { id, visible }, { scope: 'translation', render: false, lock: false });
        } catch { /* 预览失败不应阻止稍后的松开动作 */ }
      }
    })().finally(() => {
      previewDraining = false;
      if (previewPending.size) drainPreviews();
    });
  };
  const queuePreview = (id, visible) => { previewPending.set(id, visible); drainPreviews(); };
  const previewButton = target => target?.closest?.('.translation-original-preview');
  const endOriginalHold = ({ releaseCapture = false } = {}) => {
    const held = originalHold;
    if (!held) return;
    originalHold = null;
    queuePreview(held.id, false);
    root.querySelector('.translation-original-preview')?.setAttribute('aria-pressed', 'false');
    if (releaseCapture && held.pointerId !== undefined) {
      try { if (root.hasPointerCapture?.(held.pointerId)) root.releasePointerCapture(held.pointerId); } catch { /* 指针可能已结束 */ }
    }
  };
  const startOriginalHold = (kind, event, button) => {
    if (!button || button.disabled || current?.status !== 'complete' || current.options.displayMode !== 'overlay') return;
    if (originalHold) {
      if (originalHold.kind === kind && originalHold.pointerId === event.pointerId && originalHold.key === event.key) return;
      endOriginalHold();
    }
    originalHold = { id: current.id, kind, pointerId: kind === 'pointer' ? event.pointerId : undefined, key: kind === 'keyboard' ? event.key : undefined };
    button.setAttribute('aria-pressed', 'true');
    queuePreview(current.id, true);
  };
  root.addEventListener('pointerdown', event => {
    const button = previewButton(event.target);
    if (!button || event.button !== 0 || event.isPrimary === false) return;
    startOriginalHold('pointer', event, button);
    if (originalHold?.kind === 'pointer' && originalHold.pointerId === event.pointerId) {
      try { root.setPointerCapture(event.pointerId); } catch { /* 窗口失焦和全局松开仍会复位 */ }
    }
  });
  root.addEventListener('keydown', event => {
    if (![' ', 'Enter'].includes(event.key) || event.repeat) return;
    const button = previewButton(event.target);
    if (!button || button.disabled) return;
    event.preventDefault();
    startOriginalHold('keyboard', event, button);
  });
  const releasePointer = event => {
    if (originalHold?.kind === 'pointer' && originalHold.pointerId === event.pointerId) endOriginalHold();
  };
  window.addEventListener('pointerup', releasePointer, true);
  window.addEventListener('pointercancel', releasePointer, true);
  root.addEventListener('lostpointercapture', releasePointer);
  window.addEventListener('keyup', event => {
    if (originalHold?.kind === 'keyboard' && originalHold.key === event.key) endOriginalHold();
  }, true);
  window.addEventListener('blur', () => endOriginalHold({ releaseCapture: true }));
  const action = async (name, payload = {}) => {
    if (busy) {
      localError = '操作正在进行，请稍候。'; render(current, languages);
      return { ok: false, error: localError, busy: true };
    }
    const sequence = ++actionSequence;
    busy = true; localError = '';
    render(current, languages);
    let result;
    try {
      result = await invoke(name, { id: current?.id, ...payload }, { scope: 'translation', render: false });
    } catch (error) {
      result = { ok: false, error: error?.message || '操作未完成，请重试。' };
    } finally {
      busy = false;
      completedActionSequence = sequence;
    }
    if (!result?.ok) localError = result?.error || '操作未完成，请重试。';
    render(current, languages);
    return result || { ok: false, error: '操作未完成，请重试。' };
  };
  const button = (label, handler, className = '') => {
    const value = node('button', className, label); value.type = 'button'; value.disabled = busy && !className.includes('translation-original-preview');
    value.addEventListener('click', handler); return value;
  };
  const iconButton = (label, kind, handler) => {
    const value = button('', handler, 'translation-icon-button');
    value.title = label; value.setAttribute('aria-label', label); value.append(controlIcon(kind)); return value;
  };
  const changeDisplay = async options => {
    endOriginalHold();
    const result = await action('set-translation-options', { options: { ...options, showOriginal: false } });
    if (!result.ok) render(current, languages);
  };
  const saveLanguages = async () => {
    const id = current.id, revision = ++languageRevision, options = { sourceLanguage: chosen.sourceLanguage, targetLanguage: chosen.targetLanguage };
    languageDraft = true; languageError = '';
    languageSaves++;
    try {
      let result;
      try { result = await invoke('set-translation-preferences', { options }, { scope: 'translation', render: false, lock: false }); }
      catch (error) { result = { ok: false, error: error?.message }; }
      if (current?.id === id && languageRevision === revision) {
        languageDraft = !result?.ok;
        languageError = result?.ok ? '' : result?.error || '语言选择未保存，本次仍使用所选语言。';
        if (result?.ok) preferences = { ...preferences, ...options };
      }
    } finally {
      languageSaves--;
      render(current, languages);
    }
  };
  const selectedOptions = () => ({ ...current.options, sourceLanguage: chosen.sourceLanguage, targetLanguage: chosen.targetLanguage,
    translationMode: chosen.translationMode ?? 'standard', ...translationSearchPreferences(chosen) });

  function render(data, availableLanguages, availablePreferences) {
    rememberComparisonView();
    if (originalHold && (!data || data.id !== originalHold.id || data.status !== 'complete' || data.options.displayMode !== 'overlay')) endOriginalHold();
    // 切换期间的旧测量可能被主进程忽略；回到对照时必须重新提交，不能被相同高度去重。
    if (data?.options.displayMode === 'compare' && current?.options.displayMode !== 'compare') measuredHeight = { id: data.id, value: null };
    current = data; languages = availableLanguages || languages;
    if (availablePreferences !== undefined) preferences = availablePreferences;
    const token = ++generation;
    root.dataset.translationBusy = String(busy);
    root.dataset.translationAction = String(actionSequence);
    root.dataset.translationActionComplete = String(completedActionSequence);
    root.setAttribute('aria-busy', String(busy));
    document.documentElement.classList.add('translation-window');
    if (!data) {
      if (measurementFrame) cancelAnimationFrame(measurementFrame);
      measurementFrame = 0; activeControls = null; root.replaceChildren(); return;
    }
    if (lastId !== data.id) {
      // 同图重译会换编号；请求中的语言与草稿一致时，偏好写入失败也不能回退。
      const keepLanguageDraft = languageDraft && chosen?.sourceLanguage === data.options.sourceLanguage && chosen?.targetLanguage === data.options.targetLanguage;
      lastId = data.id; chosen = { ...data.options }; localError = ''; copied = false;
      languageDraft = keepLanguageDraft;
      if (!keepLanguageDraft) languageError = '';
      comparisonView = { id: data.id, scrollTop: 0, sourcesOpen: false };
      measuredHeight = { id: data.id, value: null };
    }
    if (!languageSaves && languageDraft && preferences?.sourceLanguage === chosen.sourceLanguage && preferences?.targetLanguage === chosen.targetLanguage) {
      languageDraft = false; languageError = '';
    }
    if (!languageSaves && !localError && preferences) {
      // 语言草稿独立于普通操作错误；切换显示方式不能撤销保存失败时的选择。
      if (!languageDraft) {
        chosen.sourceLanguage = preferences.sourceLanguage ?? chosen.sourceLanguage;
        chosen.targetLanguage = preferences.targetLanguage ?? chosen.targetLanguage;
      }
      chosen.translationMode = preferences.translationMode ?? chosen.translationMode ?? 'standard';
      Object.assign(chosen, translationSearchPreferences({ ...chosen, ...preferences }));
    }
    const layer = node('main', 'translation-surface');
    const canPaint = data.status === 'complete' && data.options.displayMode === 'overlay' && !data.options.showOriginal && data.overlayAvailable !== false;
    if (role === 'overlay') {
      const figure = node('figure', 'translation-image');
      positioned(figure, data.layout.image);
      figure.setAttribute('aria-label', data.options.showOriginal ? '本次截图原图' : '本次截图及覆盖译文');
      const image = node('img'); image.alt = '本次框选截图'; image.draggable = false; figure.append(image);
      if (/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(data.imageData || '')) image.src = data.imageData;
      layer.append(figure); root.replaceChildren(layer);
      if (canPaint) {
        const paint = () => {
          if (token !== generation || current?.id !== data.id || !image.naturalWidth) return;
          const canvas = node('canvas', 'translation-overlay'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
          const context = canvas.getContext('2d', { willReadFrequently: true }); context.drawImage(image, 0, 0);
          const prepared = (data.blocks || []).map(block => ({ block, background: sampleBackground(context, block, canvas.width, canvas.height), ...blockLayout(context, block, data) }));
          // 先采样整张原图再擦字，邻近行不能采到刚画的译文。
          for (const { block, background, area, size, lines, fits } of prepared) {
            context.fillStyle = `rgb(${background.join(',')})`; context.fillRect(area.x, area.y, area.width, area.height);
            context.fillStyle = background[0] * .2126 + background[1] * .7152 + background[2] * .0722 > 145 ? '#141414' : '#f8f8f8';
            context.textBaseline = 'top'; context.textAlign = 'left'; context.direction = 'inherit';
            if (fits) {
              context.font = `${size}px "Segoe UI","Microsoft YaHei UI",sans-serif`;
              if (/^[\u0590-\u08ff]/.test(block.translation.trim())) { context.direction = 'rtl'; context.textAlign = 'right'; }
              lines.forEach((line, index) => context.fillText(line, context.textAlign === 'right' ? area.x + area.width - 2 : area.x + 2, area.y + index * size * 1.18));
            } else {
              context.font = `${Math.min(area.height, 18)}px "Segoe UI",sans-serif`; context.fillText('↗', area.x + 1, area.y);
            }
          }
          figure.append(canvas);
        };
        if (image.complete) paint(); else image.addEventListener('load', paint, { once: true });
      }
      return;
    }
    const controls = node('section', 'translation-controls');
    controls.setAttribute('aria-label', '截图翻译'); positioned(controls, data.layout.controls);
    controls.style.width = '100%'; controls.style.height = '100%';
    controls.setAttribute('aria-busy', String(busy));
    const heading = node('div', 'translation-heading');
    const changedLanguage = chosen.sourceLanguage !== data.options.sourceLanguage || chosen.targetLanguage !== data.options.targetLanguage;
    const changedMode = (chosen.translationMode ?? 'standard') !== (data.options.translationMode ?? 'standard') ||
      translationUsesSearch(chosen) !== translationUsesSearch(data.options);
    const operationError = localError || languageError;
    const status = node('p', `translation-status${data.status === 'failed' || operationError ? ' danger' : ''}`,
      translationStatus(data, changedMode ? '设置已更改 · 需重译' : changedLanguage ? '语言已更改 · 需重译' : '', operationError));
    status.setAttribute('role', 'status');
    status.title = [data.options.translationMode === 'deep' ? '本次为深度翻译' : '本次为快速翻译',
      data.thinking?.status === 'unverified' ? '当前接口未适配思考开关' : '',
      data.search?.status === 'complete' ? '已参考联网资料' : '', data.warning, data.rotationAdjusted ? '文字框已校正' : ''].filter(Boolean).join(' · ');
    status.dataset.busy = String(['recognizing', 'translating', 'preparing-search', 'searching'].includes(data.status));
    const pin = iconButton(data.controlsPinned ? '取消翻译菜单置顶' : '置顶翻译菜单', 'pin', () => action('pin-translation-controls', { pinned: !current.controlsPinned }));
    pin.classList.add('translation-pin'); pin.setAttribute('aria-pressed', String(data.controlsPinned === true));
    heading.append(node('strong', '', '截图翻译'), status, pin, iconButton('关闭', 'close', () => { endOriginalHold(); return action('close-translation'); }));
    const fields = node('div', 'translation-languages');
    const source = languageSelect(languages, chosen.sourceLanguage, '源语言', true);
    const target = languageSelect(languages, chosen.targetLanguage, '目标语言');
    source.disabled = busy; target.disabled = busy;
    source.addEventListener('change', () => { chosen.sourceLanguage = source.value; void saveLanguages(); });
    target.addEventListener('change', () => { chosen.targetLanguage = target.value; void saveLanguages(); });
    const sourceLabel = node('label'); sourceLabel.append(node('span', 'visually-hidden', '源语言'), source);
    const targetLabel = node('label'); targetLabel.append(node('span', 'visually-hidden', '目标语言'), target);
    const mode = button(chosen.translationMode === 'deep' ? '深度' : '快速', async () => {
      const result = await action('retry-translation', { options: { ...selectedOptions(), translationMode: chosen.translationMode === 'deep' ? 'standard' : 'deep' } });
      if (!result.ok) render(current, languages);
    }, 'translation-mode-switch');
    mode.setAttribute('aria-label', chosen.translationMode === 'deep' ? '深度翻译' : '快速翻译');
    mode.setAttribute('aria-pressed', String(chosen.translationMode === 'deep'));
    const thinkingLabel = chosen.translationMode === 'deep' ? '开启思考' : data.thinking?.status === 'unverified' ? '思考开关未适配' : '关闭思考';
    mode.title = `${chosen.translationMode === 'deep' ? '深度' : '快速'} · ${thinkingLabel} · ${translationUsesSearch(chosen) ? '联网' : '不联网'}；点击切换${chosen.translationMode === 'deep' ? '快速' : '深度'}并重译`;
    fields.append(sourceLabel, node('span', 'translation-arrow', '→'), targetLabel, mode);
    const toolbar = node('div', 'translation-actions');
    const overlay = button('覆盖', () => changeDisplay({ displayMode: 'overlay' })); overlay.setAttribute('aria-pressed', String(data.options.displayMode === 'overlay')); overlay.disabled = busy || data.overlayAvailable === false;
    const compare = button('对照', () => changeDisplay({ displayMode: 'compare' })); compare.setAttribute('aria-pressed', String(data.options.displayMode === 'compare'));
    const originalPreview = data.options.displayMode === 'overlay' ? button('', () => {}, 'translation-icon-button translation-original-preview') : null;
    if (originalPreview) {
      originalPreview.title = '按住查看原图，松开恢复译文'; originalPreview.setAttribute('aria-label', '按住查看原图');
      originalPreview.setAttribute('aria-pressed', String(originalHold?.id === data.id)); originalPreview.setAttribute('aria-keyshortcuts', 'Space Enter');
      originalPreview.disabled = data.status !== 'complete'; originalPreview.append(controlIcon('eye'));
    }
    const retryTranslation = async (recognitionMode = 'auto') => {
      endOriginalHold();
      const result = await action('retry-translation', { recognitionMode, options: selectedOptions() });
      if (!result.ok) render(current, languages);
    };
    const retry = iconButton(data.status === 'failed' ? '重试翻译' : '重新翻译', 'retry', () => retryTranslation());
    const copy = iconButton(copied ? '已复制' : '复制译文', copied ? 'check' : 'copy', async () => {
      const result = await action('copy-translation');
      if (result.ok) { copied = true; render(current, languages); }
      else render(current, languages);
    }); copy.disabled = busy || data.status !== 'complete';
    const display = node('div', 'translation-display'); display.setAttribute('aria-label', '译文显示方式'); display.append(overlay, compare);
    const tools = node('div', 'translation-tools');
    const vision = iconButton('识图重试', 'vision', () => retryTranslation('vision')); vision.title = '文字漏识别？改用识图重试';
    const networkEnabled = translationUsesSearch(chosen), modeName = chosen.translationMode === 'deep' ? '深度' : '快速';
    const network = iconButton('联网翻译', 'globe', async () => {
      endOriginalHold();
      const options = selectedOptions();
      const result = await action('retry-translation', { recognitionMode: current.fallbackReason === 'manual' ? 'vision' : 'auto', options: { ...options, ...toggleTranslationSearch(options) } });
      if (!result.ok) render(current, languages);
    });
    network.classList.add('translation-network-switch'); network.setAttribute('aria-pressed', String(networkEnabled));
    network.title = `${modeName}联网已${networkEnabled ? '开启' : '关闭'}；点击${networkEnabled ? '关闭' : '开启'}并重译`;
    tools.append(retry, vision, network, copy,
      iconButton('重新框选', 'capture', () => { endOriginalHold(); return action('start-capture', { mode: 'translate', options: { ...selectedOptions(), showOriginal: false } }); }));
    toolbar.append(display, ...(originalPreview ? [originalPreview] : []), tools);
    const notices = [data.sourceWarning, ...(data.status === 'complete' ? [data.method === 'vision' ? '整区覆盖' : '', data.unchangedCount ? `${data.unchangedCount} 处保留原文` : ''] : [])].filter(Boolean);
    const warning = node('p', 'translation-warning', notices.join(' · ')); warning.hidden = !notices.length;
    warning.title = data.warning || '';
    controls.append(heading, fields, toolbar, warning);
    if (operationError || data.error) {
      const error = node('p', 'translation-error', operationError || data.error); error.setAttribute('role', 'alert'); controls.append(error);
    }
    if (data.status === 'failed') controls.append(button('配置 AI 服务', () => action('open-settings'), 'translation-configure'));
    if (data.options.displayMode === 'compare' && data.blocks?.length) {
      const comparison = node('div', 'translation-comparison');
      comparison.setAttribute('aria-label', '原文与译文对照'); comparison.tabIndex = 0;
      for (const block of data.blocks) {
        const entry = node('article', 'translation-pair');
        const sourceText = node('p', 'translation-source-text', block.text); sourceText.setAttribute('dir', 'auto'); sourceText.setAttribute('aria-label', '原文');
        const targetText = node('p', 'translation-target-text', block.translation); targetText.setAttribute('dir', 'auto'); targetText.setAttribute('aria-label', '译文');
        entry.append(sourceText, targetText); comparison.append(entry);
      }
      if (data.search?.status === 'complete' && data.search.sources?.length) {
        const sources = node('details', 'translation-sources');
        sources.open = comparisonView.sourcesOpen;
        sources.addEventListener('toggle', () => {
          if (current?.id !== data.id || activeControls !== controls || root.querySelector('.translation-sources') !== sources) return;
          comparisonView.sourcesOpen = sources.open;
          scheduleContentMeasurement(controls, data.id);
        });
        sources.append(node('summary', '', `联网来源（${data.search.sources.length}）`));
        const list = node('ol');
        for (const source of data.search.sources) {
          let url;
          try { url = new URL(source.url); } catch { continue; }
          if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) continue;
          const item = node('li'), link = node('a', '', source.title || url.hostname);
          link.href = url.href; link.title = url.hostname; link.setAttribute('aria-disabled', String(busy));
          if (busy) link.tabIndex = -1;
          link.addEventListener('click', event => { event.preventDefault(); if (!busy) void action('open-link', { url: url.href }); });
          item.append(link); list.append(item);
        }
        sources.append(list); comparison.append(sources);
      }
      comparison.addEventListener('scroll', () => {
        if (current?.id === data.id && activeControls === controls && root.querySelector('.translation-comparison') === comparison) comparisonView.scrollTop = comparison.scrollTop;
      }, { passive: true });
      controls.append(comparison);
    }
    layer.append(controls); root.replaceChildren(layer); activeControls = controls;
    const comparison = controls.querySelector('.translation-comparison');
    if (comparison && comparisonView.id === data.id) comparison.scrollTop = comparisonView.scrollTop;
    if (data.options.displayMode === 'compare') scheduleContentMeasurement(controls, data.id);
    if (canPaint) {
      const context = document.createElement('canvas').getContext('2d');
      const overflow = (data.blocks || []).filter(block => !blockLayout(context, block, data).fits).length;
      if (overflow) {
        warning.hidden = false;
        warning.textContent = `${overflow} 处译文较长 · `;
        warning.title = data.warning || '';
        const full = button('查看对照', () => changeDisplay({ displayMode: 'compare' })); full.setAttribute('aria-label', '查看完整对照'); warning.append(full);
      }
    }
  }
  return { render };
}
