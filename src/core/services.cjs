'use strict';

// 预设只提供官方地址和获取密钥入口；用户仍可编辑服务地址与模型名称。
const MODEL_PROVIDERS = Object.freeze([
  Object.freeze({ id: 'custom', name: '自定义', baseUrl: '', keyUrl: '' }),
  Object.freeze({ id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', keyUrl: 'https://platform.deepseek.com/api_keys' }),
  Object.freeze({ id: 'mimo', name: '小米 MiMo', baseUrl: 'https://api.xiaomimimo.com/v1', model: 'mimo-v2.6-pro', keyUrl: 'https://platform.xiaomimimo.com/#/console/api-keys' }),
]);

const SEARCH_PROVIDERS = Object.freeze([
  Object.freeze({ id: 'custom', name: '自定义', protocol: 'exa', baseUrl: '', keyUrl: '' }),
  Object.freeze({ id: 'exa', name: 'Exa', protocol: 'exa', baseUrl: 'https://api.exa.ai/search', keyUrl: 'https://dashboard.exa.ai/api-keys' }),
  Object.freeze({ id: 'brave', name: 'Brave', protocol: 'brave', baseUrl: 'https://api.search.brave.com/res/v1/llm/context', keyUrl: 'https://api-dashboard.search.brave.com/app/keys' }),
  Object.freeze({ id: 'deepseek', name: 'DeepSeek', protocol: 'deepseek', baseUrl: 'https://api.deepseek.com/v1/tools/search', keyUrl: 'https://platform.deepseek.com/api_keys' }),
]);

module.exports = { MODEL_PROVIDERS, SEARCH_PROVIDERS };
