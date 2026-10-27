'use strict';

const { failure } = require('./validation.cjs');

const MIMO_MODELS = new Set(['mimo-v2.6-flash', 'mimo-v2.6-pro', 'mimo-v2.6-pro-ultraspeed']);
const DEEPSEEK_MODELS = new Set(['deepseek-flash', 'deepseek-v4-pro']);

function officialThinkingProvider(config) {
  const model = typeof config?.model === 'string' ? config.model.trim() : '';
  let hostname = '';
  try { hostname = new URL(config?.baseUrl).hostname.toLowerCase(); } catch { /* 上层负责配置校验。 */ }
  if (hostname === 'api.xiaomimimo.com' && MIMO_MODELS.has(model)) return 'mimo';
  if (hostname === 'api.deepseek.com' && DEEPSEEK_MODELS.has(model)) return 'deepseek';
  return '';
}

function resolveTranslationThinking(config, mode = 'standard') {
  if (!['standard', 'deep'].includes(mode)) throw failure('INVALID_INPUT', '截图翻译思考模式无效。');
  const model = typeof config?.model === 'string' ? config.model.trim() : '';
  const providerId = officialThinkingProvider(config);
  if (!providerId) {
    const metadata = { mode, status: mode === 'deep' ? 'unsupported' : 'unverified', providerId: config?.providerId || 'custom', model,
      controlSupported: false, effort: null };
    if (mode === 'deep') throw Object.assign(failure('UNSUPPORTED_THINKING', '当前模型未适配深度思考控制，请改用官方 MiMo 或 DeepSeek 型号，或切换到常规模式。'), { thinking: metadata });
    return { metadata, generationOptions: undefined };
  }

  if (mode === 'standard') {
    return { metadata: { mode, status: 'disabled', providerId, model, controlSupported: true, effort: 'none' },
      generationOptions: { thinkingType: 'disabled' } };
  }
  if (providerId === 'mimo') {
    return { metadata: { mode, status: 'enabled', providerId, model, controlSupported: true, effort: 'model-maximum' },
      generationOptions: { thinkingType: 'enabled' } };
  }
  return { metadata: { mode, status: 'enabled', providerId, model, controlSupported: true, effort: 'max' },
    generationOptions: { thinkingType: 'enabled', reasoningEffort: 'max' } };
}

module.exports = { resolveTranslationThinking };
