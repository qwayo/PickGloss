'use strict';

// 便携包只保留运行时必需文件，避免工作文档、个人配置或临时文件被带入发布物。
const ALLOWED_PACKAGE_FILES = new Set([
  '/LICENSE',
  '/LICENSE-PickGloss.txt',
  '/package.json',
  '/THIRD_PARTY_LICENSES.md',
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
]);
const REQUIRED_DIRECTORIES = new Set(['/', '/src']);

function normalizePackagePath(relative) {
  if (typeof relative !== 'string' || !relative.startsWith('/')) return null;
  const parts = relative.replaceAll('\\', '/').split('/');
  if (parts.some(part => part === '.' || part === '..' || part.includes('\0'))) return null;
  const normalized = parts.filter(part => part !== '').join('/');
  return normalized ? `/${normalized}` : '/';
}

function includePackagePath(relative) {
  const value = normalizePackagePath(relative);
  if (!value) return false;
  if (value.endsWith('.cs')) return false;
  return REQUIRED_DIRECTORIES.has(value) || value.startsWith('/src/') || ALLOWED_PACKAGE_FILES.has(value);
}

module.exports = { ALLOWED_PACKAGE_FILES, includePackagePath, normalizePackagePath };
