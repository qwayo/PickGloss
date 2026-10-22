'use strict';

const { failure } = require('./validation.cjs');

function exactObject(value, keys, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(value, key))) {
    throw failure('INVALID_INPUT', `${name}字段无效。`);
  }
  return value;
}

function integer(value, min, max, name) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw failure('INVALID_INPUT', `${name}必须在 ${min} 至 ${max} 之间。`);
  return value;
}

function boolean(value, name) {
  if (typeof value !== 'boolean') throw failure('INVALID_INPUT', `${name}必须是布尔值。`);
  return value;
}

function defaultAppearance() {
  return { current: { mode: 'dark', material: 'solid', accent: '#000000', tint: '#bfc2c8', opacity: 82, blur: 26 }, active: 'default', presets: [], reducedMotion: false, pinOutline: 'orange' };
}

function appearanceValues(input) {
  exactObject(input, ['mode', 'material', 'accent', 'tint', 'opacity', 'blur'], '外观');
  if (!['dark', 'light', 'system'].includes(input.mode)) throw failure('INVALID_INPUT', '外观模式无效。');
  if (!['solid', 'glass'].includes(input.material)) throw failure('INVALID_INPUT', '外观材质无效。');
  for (const key of ['accent', 'tint']) if (typeof input[key] !== 'string' || !/^#[0-9a-f]{6}$/i.test(input[key])) throw failure('INVALID_INPUT', '外观颜色必须是六位十六进制色值。');
  return { mode: input.mode, material: input.material, accent: input.accent.toLowerCase(), tint: input.tint.toLowerCase(),
    opacity: integer(input.opacity, 72, 96, '外观不透明度'), blur: integer(input.blur, 8, 40, '外观模糊程度') };
}

function presetId(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)) throw failure('INVALID_INPUT', '外观预设标识无效。');
  return value;
}

function appearanceShape(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw failure('INVALID_INPUT', '外观设置字段无效。');
  input = exactObject({ ...input, pinOutline: input.pinOutline === undefined ? 'orange' : input.pinOutline }, ['current', 'active', 'presets', 'reducedMotion', 'pinOutline'], '外观设置');
  if (!['orange', 'amber', 'blue', 'violet', 'mint', 'silver', 'none'].includes(input.pinOutline)) throw failure('INVALID_INPUT', '置顶描边颜色无效。');
  if (!Array.isArray(input.presets) || input.presets.length > 50) throw failure('INVALID_INPUT', '最多保存 50 套外观预设。');
  const ids = new Set(), names = new Set();
  const presets = input.presets.map(preset => {
    exactObject(preset, ['id', 'name', 'values'], '外观预设');
    const id = presetId(preset.id);
    if (id === 'default' || ids.has(id)) throw failure('INVALID_INPUT', '外观预设标识不能重复或使用默认标识。');
    if (typeof preset.name !== 'string') throw failure('INVALID_INPUT', '外观预设名称无效。');
    const name = preset.name.trim();
    if (!name || [...name].length > 24 || /[\u0000-\u001f\u007f]/.test(name)) throw failure('INVALID_INPUT', '外观预设名称需为 1 至 24 个字符。');
    const normalizedName = name.normalize('NFKC').toLowerCase();
    if (names.has(normalizedName)) throw failure('INVALID_INPUT', '外观预设名称不能重复。');
    ids.add(id); names.add(normalizedName);
    return { id, name, values: appearanceValues(preset.values) };
  });
  const active = presetId(input.active);
  if (active !== 'default' && !ids.has(active)) throw failure('INVALID_INPUT', '当前外观预设不存在。');
  return { current: appearanceValues(input.current), active, presets, reducedMotion: boolean(input.reducedMotion, '减少动效状态'), pinOutline: input.pinOutline };
}

function defaultWindowGeometry() {
  return { orb: null, panel: null, sizes: { compact: { width: 300, height: 483 }, reading: { width: 860, height: 690 } }, wide: false };
}

function windowGeometryShape(input) {
  exactObject(input, ['orb', 'panel', 'sizes', 'wide'], '窗口状态');
  const point = (value) => {
    if (value === null) return null;
    exactObject(value, ['x', 'y'], '窗口坐标');
    return { x: integer(value.x, -100000, 100000, '窗口横坐标'), y: integer(value.y, -100000, 100000, '窗口纵坐标') };
  };
  const size = (value) => {
    exactObject(value, ['width', 'height'], '窗口尺寸');
    return { width: integer(value.width, 215, 8192, '窗口宽度'), height: integer(value.height, 180, 8192, '窗口高度') };
  };
  exactObject(input.sizes, ['compact', 'reading'], '布局尺寸');
  return { orb: point(input.orb), panel: point(input.panel), sizes: { compact: size(input.sizes.compact), reading: size(input.sizes.reading) }, wide: boolean(input.wide, '阅读视图状态') };
}

module.exports = { defaultAppearance, appearanceShape, defaultWindowGeometry, windowGeometryShape };
