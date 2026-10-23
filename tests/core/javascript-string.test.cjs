'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { quoteJavaScriptString } = require('../../scripts/javascript-string.cjs');

test('嵌入代码的字符串保留特殊字符且不产生 HTML 边界', () => {
  const values = [
    '', '中文与表情 🦤🚲', '引号 " 单引号 \' 反斜杠 \\ 末尾\\',
    '换行\n回车\r制表\t退格\b换页\f空字符\0',
    '</script><script>globalThis.injected = true</script><!-- & >',
    'Unicode 分隔符\u2028\u2029与孤立代理项\ud800\udfff',
    '";globalThis.injected=true;//', '` ${globalThis.injected = true}',
    'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
  ];
  for (const value of values) {
    const literal = quoteJavaScriptString(value);
    assert.doesNotMatch(literal, /[<>&\u2028\u2029]/);
    assert.equal(JSON.parse(literal), value);
    const context = { injected: false };
    assert.equal(vm.runInNewContext(`(() => { const value = ${literal}; return value; })()`, context, { timeout: 1000 }), value);
    assert.equal(context.injected, false);
  }
});

test('选择器、重复标签和字段值在生成的操作代码中保持原值', () => {
  const selector = '[data-field="question"]';
  const label = '解释 </script> & "标签" 🦤';
  const value = '虚构字段值\\\n\u2028\u2029';
  const input = { value: '' };
  const result = vm.runInNewContext(`(() => {
    const input = document.querySelector(${quoteJavaScriptString(selector)});
    input.value = ${quoteJavaScriptString(value)};
    return ${quoteJavaScriptString(label)} === ${quoteJavaScriptString(label)};
  })()`, { document: { querySelector(actual) { assert.equal(actual, selector); return input; } } }, { timeout: 1000 });
  assert.equal(result, true);
  assert.equal(input.value, value);
});

test('非字符串参数明确失败，避免静默丢弃或转换字段值', () => {
  for (const value of [undefined, null, 0, true, {}, [], () => {}]) {
    assert.throws(() => quoteJavaScriptString(value), TypeError);
  }
});
