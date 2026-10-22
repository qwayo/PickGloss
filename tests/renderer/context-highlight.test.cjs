'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const parts = async (source, selected) => (await import('../../src/renderer/context-highlight.mjs')).contextParts(source, selected);
test('上下文标出选中子串，数字和同一词的重复出现保持原样', async () => {
  const result = await parts('12345EXA67890 EXA', 'EXA');
  assert.equal(result.map(p=>p.text).join(''), '12345EXA67890 EXA');
  assert.deepEqual(result.filter(p=>p.selected).map(p=>p.text), ['EXA','EXA']);
});
test('空选区、无匹配、中文和跨行短语均保留上下文原文', async () => {
  for (const [source, selected, count] of [['原始文本','',0],['原始文本','缺失',0],['这是一段中文内容','中文',1],['small\nchanges compound','small changes',1]]) {
    const result = await parts(source, selected); assert.equal(result.map(p=>p.text).join(''),source); assert.equal(result.filter(p=>p.selected).length,count);
  }
});
test('正则符号、HTML 和表情按文字匹配，不变成表达式或标签', async () => {
  for (const selected of ['C++','[EXA].*','<img onerror=x>','😀']) {
    const source = `前文${selected}后文`; const result = await parts(source,selected);
    assert.equal(result.map(p=>p.text).join(''),source); assert.deepEqual(result.filter(p=>p.selected).map(p=>p.text),[selected]);
  }
});
