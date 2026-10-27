'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveTranslationThinking } = require('../../src/core/translation-thinking.cjs');

test('官方 MiMo 2.6 型号只切换思考开关，深度开启为模型最高可用档', () => {
  for (const model of ['mimo-v2.6-flash', 'mimo-v2.6-pro', 'mimo-v2.6-pro-ultraspeed']) {
    const config = { providerId: 'custom', baseUrl: 'https://api.xiaomimimo.com/v1', model };
    const standard = resolveTranslationThinking(config, 'standard');
    assert.deepEqual(standard.generationOptions, { thinkingType: 'disabled' });
    assert.equal(standard.metadata.status, 'disabled');
    assert.equal(standard.metadata.providerId, 'mimo');
    const deep = resolveTranslationThinking(config, 'deep');
    assert.deepEqual(deep.generationOptions, { thinkingType: 'enabled' });
    assert.equal(deep.metadata.effort, 'model-maximum');
  }
});

test('官方 DeepSeek 当前型号的深度请求使用 max', () => {
  for (const model of ['deepseek-flash', 'deepseek-v4-pro']) {
    const result = resolveTranslationThinking({ providerId: 'custom', baseUrl: 'https://api.deepseek.com/v1', model }, 'deep');
    assert.deepEqual(result.generationOptions, { thinkingType: 'enabled', reasoningEffort: 'max' });
    assert.equal(result.metadata.providerId, 'deepseek');
    assert.equal(result.metadata.effort, 'max');
  }
});

test('未识别型号的常规模式不追加参数，深度模式明确拒绝', () => {
  const config = { providerId: 'custom', baseUrl: 'https://models.example.test/v1', model: 'private-model' };
  const standard = resolveTranslationThinking(config, 'standard');
  assert.equal(standard.generationOptions, undefined);
  assert.deepEqual(standard.metadata, { mode: 'standard', status: 'unverified', providerId: 'custom', model: 'private-model', controlSupported: false, effort: null });
  assert.throws(() => resolveTranslationThinking(config, 'deep'), error => {
    assert.equal(error.code, 'UNSUPPORTED_THINKING');
    assert.equal(error.thinking.status, 'unsupported');
    assert.equal(error.thinking.controlSupported, false);
    return true;
  });
});

test('只有官方主机与已核对型号的组合才报告思考控制能力', () => {
  const mismatchedHost = resolveTranslationThinking({ providerId: 'mimo', baseUrl: 'https://proxy.example.test/v1', model: 'mimo-v2.6-pro' }, 'standard');
  const mismatchedModel = resolveTranslationThinking({ providerId: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash' }, 'standard');
  assert.equal(mismatchedHost.metadata.controlSupported, false);
  assert.equal(mismatchedModel.metadata.controlSupported, false);
});
