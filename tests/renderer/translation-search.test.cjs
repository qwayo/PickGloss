'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { translationOptions, translationUsesSearch } = require('../../src/core/translation.cjs');
const { groupOcrLines } = require('../../src/windows/ocr-paragraphs.cjs');
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../src/renderer/translation.js'), 'utf8').replace(/^export /gm, '')
  + '\nglobalThis.searchUi={translationUsesSearch,toggleTranslationSearch,blockLayout};', context);
const ui = context.searchUi;
test('菜单地球按钮仅切换当前模式，前后端判定一致，再次点击还原语义', () => {
  for (const searchEnabled of [false, true]) for (const searchScope of ['standard', 'deep', 'both']) for (const translationMode of ['standard', 'deep']) {
    const options = translationOptions({ searchEnabled, searchScope, translationMode, targetLanguage: 'ja' });
    const before = JSON.stringify(options), other = translationMode === 'standard' ? 'deep' : 'standard';
    assert.equal(ui.translationUsesSearch(options), translationUsesSearch(options));
    const toggled = { ...options, ...ui.toggleTranslationSearch(options) };
    assert.notEqual(ui.translationUsesSearch(toggled), translationUsesSearch(options));
    assert.equal(translationUsesSearch({ ...toggled, translationMode: other }), translationUsesSearch({ ...options, translationMode: other }));
    const restored = { ...toggled, ...ui.toggleTranslationSearch(toggled) };
    for (const mode of ['standard', 'deep']) assert.equal(translationUsesSearch({ ...restored, translationMode: mode }), translationUsesSearch({ ...options, translationMode: mode }));
    assert.equal(toggled.targetLanguage, 'ja'); assert.equal(JSON.stringify(options), before);
  }
});
test('六行 OCR 合并后按原文行数排版，不能把整段高度当作字号而只画箭头', () => {
  const bounds = { width: 220, height: 180 };
  const blocks = groupOcrLines(Array.from({ length: 6 }, (_, index) => ({ text: `Line ${index + 1}`, x: 10, y: 10 + index * 25, width: 170, height: 20 })), bounds);
  const block = { ...blocks[0], translation: ['第一行译文', '第二行译文', '第三行译文', '第四行译文', '第五行译文', '第六行译文'].join('\n') };
  const canvas = { font: '', measureText(text) { return { width: parseFloat(this.font) * Array.from(text).length }; } };
  const result = ui.blockLayout(canvas, block, { ...bounds, method: 'windows-ocr' });
  assert.equal(result.fits, true); assert.equal(result.lines.length, 6);
  assert.ok(result.size >= 9 && result.size < 32);
  assert.equal(block.height, 145, '排版不改变原始合并框');
});
