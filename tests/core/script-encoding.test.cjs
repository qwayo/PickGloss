'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { analyzeSource } = require('../../scripts/check-script-encoding.cjs');

test('代码执行入口及当前包装函数拒绝直接 JSON 编码，报告文件与行列', () => {
  for (const name of ['win.webContents.executeJavaScript', 'evaluate', 'ui', 'run', 'visible', 'waitFor']) {
    const source = '\n' + name + '(`input.value = ${JSON.stringify(value)}`)';
    const [problem] = analyzeSource(source, '错误代码.cjs');
    assert.equal(problem.code, 'ENC001');
    assert.equal(problem.file, '错误代码.cjs');
    assert.equal(problem.line, 2);
    assert.ok(problem.column > 1);
  }
  assert.equal(analyzeSource('const expression = `setValue(${JSON.stringify(value)})`;')[0].code, 'ENC001');
  assert.equal(analyzeSource('send("Runtime.evaluate", {expression: `setValue(${JSON.stringify(value)})`});')[0].code, 'ENC001');
  assert.equal(analyzeSource('function makeCode(value) { return `setValue(${JSON.stringify(value)})`; } evaluate(makeCode(value));')[0].code, 'ENC001');
  assert.equal(analyzeSource('const makeCode = value => `setValue(${JSON.stringify(value)})`; ui(makeCode(value));')[0].code, 'ENC001');
  assert.equal(analyzeSource('const code = `setValue(${JSON.stringify(value)})`; win.webContents.executeJavaScript(code);')[0].code, 'ENC001');
  assert.equal(analyzeSource('let code; code = "setValue(" + JSON.stringify(value) + ")"; evaluate(code);')[0].code, 'ENC001');
});

test('已转义的字符串、结构化对象传入与正常协议序列化允许通过', () => {
  for (const source of [
    'evaluate(`setValue(${quoteJavaScriptString(value)})`);',
    'evaluate(`setValue(JSON.parse(${quoteJavaScriptString(JSON.stringify(payload))}))`);',
    'evaluate(`setValue(${quoteJavaScriptString(`前缀：${JSON.stringify(payload)}`)})`);',
    'response.write(`data: ${JSON.stringify({choices: []})}\\n\\n`);',
    'response.end("data: " + JSON.stringify(payload) + "\\n\\n");',
    'socket.send(JSON.stringify({id, method: "Runtime.evaluate", params: {expression}}));',
    'const report = `统计：${JSON.stringify(result)}`;',
    '// evaluate(`${JSON.stringify(value)}`)\nconst text = "JSON.stringify(value)";',
  ]) assert.deepEqual(analyzeSource(source), [], source);
});

test('SSE 拼接和模板中的字符串参数误编码均被拦截', () => {
  for (const source of [
    'response.end("data: " + quoteJavaScriptString(payload) + "\\n\\n");',
    'response.write(`data: ${quoteJavaScriptString(payload)}\\n\\n`);',
  ]) assert.equal(analyzeSource(source)[0].code, 'ENC002');
});

test('本次三处实际 SSE 输出的误替换都会被检查器拦截', () => {
  for (const name of ['check-ai-portable.cjs', 'check-history-portable.cjs', 'check-portable.cjs']) {
    const source = fs.readFileSync(path.join(__dirname, '../../scripts', name), 'utf8');
    assert.deepEqual(analyzeSource(source, name), []);
    const broken = source.replace('data: ${JSON.stringify(', 'data: ${quoteJavaScriptString(');
    assert.notEqual(broken, source, '实际 SSE 输出位置必须存在');
    const problems = analyzeSource(broken, name);
    assert.ok(problems.some(item => item.code === 'ENC002'), name);
    assert.ok(problems.some(item => item.code === 'ENC003'), name);
  }
});

test('字符串编码拒绝明确的非字符串参数，语法错误也使检查失败', () => {
  for (const value of ['{}', '[]', 'null', '42', 'true', '() => {}']) {
    assert.equal(analyzeSource(`quoteJavaScriptString(${value})`)[0].code, 'ENC003');
  }
  assert.equal(analyzeSource('const =')[0].code, 'ENC000');
});
