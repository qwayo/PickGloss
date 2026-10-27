'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { candidateScore, selectOcrCandidate } = require('../../src/windows/ocr-quality.cjs');

const block = text => [{ text, x: 0, y: 0, width: 1, height: 1 }];

test('自动识别不再给中文字符数量额外加分', () => {
  const chinese = { language: 'zh-Hans', blocks: block('夸克') };
  const english = { language: 'en-US', blocks: block('Quark') };
  assert.equal(candidateScore(chinese), 2);
  assert.equal(candidateScore(english), 5);
  assert.equal(selectOcrCandidate([chinese, english]).language, 'en-US');
});

test('保留合法的短词、纯中文、混合语句和代码', () => {
  for (const text of ['A', 'OK', '夸克', '用户设置', '打开 Settings 页面', 'x = y + z']) {
    const selected = selectOcrCandidate([{ language: 'auto', blocks: block(text) }]);
    assert.equal(selected.quality.reliable, true, `不应误拒“${text}”`);
  }
});

test('符号碎片夹杂不同字形的自动候选标为质量不足', () => {
  const selected = selectOcrCandidate([
    { language: 'zh-Hans', blocks: block('0 」 3 《 僅 hin') },
    { language: 'en-US', blocks: [] },
  ]);
  assert.equal(selected.language, 'zh-Hans');
  assert.deepEqual(selected.quality, { reliable: false, reason: 'quality' });
});
