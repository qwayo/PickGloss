'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parse } = require('acorn');

// 检查当前脚本中接受 JavaScript 源码的入口与包装函数。
// 新增包装函数时同步补充这里及回归样本；跨文件和任意别名的数据流仍由 CodeQL 检查。
const CODE_CALLS = new Set(['executeJavaScript', 'evaluate', 'ui', 'run', 'visible', 'waitFor']);
function children(node) {
  return Object.values(node).flatMap(value => Array.isArray(value)
    ? value.filter(item => item && typeof item.type === 'string')
    : value && typeof value.type === 'string' ? [value] : []);
}
function walk(node, visit, ancestors = []) {
  visit(node, ancestors);
  for (const child of children(node)) walk(child, visit, [...ancestors, node]);
}
function callName(node) {
  const callee = node?.type === 'CallExpression' ? node.callee : null;
  if (callee?.type === 'Identifier') return callee.name;
  if (callee?.type === 'MemberExpression') return callee.computed ? callee.property.value : callee.property.name;
  return null;
}
function isQuote(node) { return callName(node) === 'quoteJavaScriptString'; }
function isStringify(node) {
  return node.type === 'CallExpression' && node.callee.type === 'MemberExpression'
    && node.callee.object.type === 'Identifier' && node.callee.object.name === 'JSON'
    && callName(node) === 'stringify';
}
function collectCalls(node, predicate, stopAtQuote = false) {
  if (stopAtQuote && isQuote(node)) return [];
  return [...(predicate(node) ? [node] : []), ...children(node).flatMap(child => collectCalls(child, predicate, stopAtQuote))];
}
function staticPrefix(node) {
  if (node?.type === 'TemplateLiteral') return node.quasis[0].value.cooked || '';
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node?.type === 'BinaryExpression' && node.operator === '+') return staticPrefix(node.left);
  return '';
}

function analyzeSource(source, filename = '脚本') {
  let ast;
  try { ast = parse(source, { ecmaVersion: 'latest', sourceType: 'commonjs', locations: true }); }
  catch (error) { return [{ file: filename, line: error.loc?.line || 1, column: (error.loc?.column || 0) + 1, code: 'ENC000', message: '无法解析脚本：' + error.message }]; }
  const diagnostics = new Map();
  const codeFactories = new Set();
  const codeVariables = new Set(['expression']);
  walk(ast, node => {
    if (node.type === 'CallExpression' && CODE_CALLS.has(callName(node))) {
      if (node.arguments[0]?.type === 'CallExpression') codeFactories.add(callName(node.arguments[0]));
      if (node.arguments[0]?.type === 'Identifier') codeVariables.add(node.arguments[0].name);
    }
    if (node.type === 'Property' && (node.key.name || node.key.value) === 'expression' && node.value.type === 'Identifier') {
      codeVariables.add(node.value.name);
    }
  });
  const report = (node, code, message) => {
    diagnostics.set(`${node.start}:${code}`, { file: filename, line: node.loc.start.line, column: node.loc.start.column + 1, code, message });
  };
  walk(ast, (node, ancestors) => {
    if (isQuote(node)) {
      const argument = node.arguments[0];
      if (!argument || ['ObjectExpression', 'ArrayExpression', 'FunctionExpression', 'ArrowFunctionExpression'].includes(argument.type)
        || (argument.type === 'Literal' && typeof argument.value !== 'string')) {
        report(node, 'ENC003', 'quoteJavaScriptString 需要字符串，不能用于编码对象、数组或其他非字符串字面量。');
      }
    }
    // SSE 的 data 行属于协议数据，模板和字符串拼接均检查。
    if (node.type === 'CallExpression' && ['write', 'end', 'send'].includes(callName(node))
      && staticPrefix(node.arguments[0]).trimStart().startsWith('data:')) {
      for (const call of collectCalls(node.arguments[0], isQuote)) {
        report(call, 'ENC002', 'SSE data 行应使用 JSON.stringify，不能使用 JavaScript 字符串编码。');
      }
    }
    if (node.type !== 'TemplateLiteral' && !(node.type === 'BinaryExpression' && node.operator === '+')) return;
    const isCode = ancestors.some(parent => (parent.type === 'CallExpression'
      && CODE_CALLS.has(callName(parent)) && parent.arguments[0]?.start <= node.start && parent.arguments[0]?.end >= node.end)
      || (parent.type === 'VariableDeclarator' && parent.id.type === 'Identifier' && (codeVariables.has(parent.id.name) || codeFactories.has(parent.id.name)))
      || (parent.type === 'AssignmentExpression' && parent.left.type === 'Identifier' && codeVariables.has(parent.left.name))
      || (parent.type === 'Property' && (parent.key.name || parent.key.value) === 'expression')
      || (parent.type === 'FunctionDeclaration' && codeFactories.has(parent.id?.name)));
    if (isCode && !ancestors.some(isQuote)) {
      for (const expression of node.type === 'TemplateLiteral' ? node.expressions : [node]) {
        for (const call of collectCalls(expression, isStringify, true)) {
          report(call, 'ENC001', 'JavaScript 代码参数应经过 quoteJavaScriptString；对象参数可使用 JSON.parse 加已转义的 JSON 字符串。');
        }
      }
    }
  });
  return [...diagnostics.values()].sort((a, b) => a.line - b.line || a.column - b.column || a.code.localeCompare(b.code));
}

function scriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? scriptFiles(file) : entry.isFile() && /\.cjs$/.test(entry.name) ? [file] : [];
  }).sort();
}
function main() {
  const root = path.resolve(__dirname, '..');
  const files = scriptFiles(path.join(root, 'scripts'));
  const diagnostics = files.flatMap(file => analyzeSource(fs.readFileSync(file, 'utf8'), path.relative(root, file)));
  for (const item of diagnostics) console.error(`${item.file}:${item.line}:${item.column} ${item.code} ${item.message}`);
  if (diagnostics.length) process.exitCode = 1;
  else console.log(`脚本编码检查通过：${files.length} 个脚本。`);
}
if (require.main === module) main();
module.exports = { analyzeSource };
