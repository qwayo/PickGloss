'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { includePackagePath } = require('../../scripts/package-files.cjs');

test('便携包白名单只放行运行文件', () => {
  for (const relative of [
    '/',
    '//',
    '/src',
    '/LICENSE',
    '/LICENSE-PickGloss.txt',
    '/package.json',
    '/src/main.cjs',
    '/src/renderer/index.html',
    '/node_modules/markdown-it/dist/browser/markdown-it.umd.min.js',
    '/node_modules/markdown-it/dist/browser/markdown-it.umd.min.js.map',
    '/node_modules/markdown-it/LICENSE',
    '/node_modules/selection-hook/index.js',
    '/node_modules/selection-hook/package.json',
    '/node_modules/selection-hook/prebuilds/win32-x64/selection-hook.node',
    '/node_modules/selection-hook/LICENSE',
    '/node_modules/node-gyp-build/index.js',
    '/node_modules/node-gyp-build/node-gyp-build.js',
    '/node_modules/node-gyp-build/package.json',
    '/node_modules/node-gyp-build/LICENSE',
    '/node_modules/punycode.js/LICENSE-MIT.txt',
    '/node_modules/uc.micro/LICENSE.txt',
  ]) assert.equal(includePackagePath(relative), true, relative);
});

test('便携包白名单拒绝开发文件和敏感路径', () => {
  for (const relative of [
    '',
    '/AGENTS.md',
    '/README.md',
    '/DESIGN.md',
    '/LICENSE-Electron.txt',
    '/NOTICE',
    '/.gitignore',
    '/.env',
    '/settings.json',
    '/sessions/a/session.json',
    '/src/../settings.json',
    '/src/./main.cjs',
    '/src\\..\\settings.json',
    '/src/windows/ContextProbe.cs',
    '/node_modules/selection-hook/README.md',
    '/node_modules/selection-hook/src/windows/selection_hook.cc',
    '/node_modules/selection-hook/prebuilds/linux-x64/selection-hook.node',
    '/node_modules/markdown-it/README.md',
    'src/main.cjs',
    '/src/main.cjs\0.txt',
  ]) assert.equal(includePackagePath(relative), false, JSON.stringify(relative));
});
