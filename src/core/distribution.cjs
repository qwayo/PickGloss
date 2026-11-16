'use strict';

const fs = require('node:fs');
const path = require('node:path');

const APP_ID = 'local.pickgloss.desktop';
const MARKER_NAME = 'pickgloss-distribution.txt';
const MARKER_CONTENT = 'PickGloss Windows x64\n';
const DISTRIBUTION_NAMES = Object.freeze({ setup: 'Setup', portable: 'Portable' });
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function isStableVersion(value) {
  return typeof value === 'string' && STABLE_VERSION.test(value);
}

function compareStableVersions(left, right) {
  const first = left.split('.');
  const second = right.split('.');
  for (let i = 0; i < 3; i++) {
    if (first[i].length !== second[i].length) return first[i].length > second[i].length ? 1 : -1;
    if (first[i] !== second[i]) return first[i] > second[i] ? 1 : -1;
  }
  return 0;
}

function distributionFileName(kind, version) {
  if (!Object.hasOwn(DISTRIBUTION_NAMES, kind) || !isStableVersion(version)) throw new Error('发行类型或版本无效。');
  return `PickGloss-${DISTRIBUTION_NAMES[kind]}-${version}.exe`;
}

function readDistribution({ isPackaged, resourcesPath, execPath, portablePath }) {
  if (!isPackaged || !resourcesPath) return null;
  try {
    if (fs.readFileSync(path.join(resourcesPath, MARKER_NAME), 'utf8') !== MARKER_CONTENT) return null;
  } catch { return null; }
  if (!portablePath) return { kind: 'setup', execPath };
  let outer = null;
  try {
    if (path.isAbsolute(portablePath) && path.extname(portablePath).toLowerCase() === '.exe' &&
        fs.statSync(portablePath).isFile()) outer = path.normalize(portablePath);
  } catch { /* 外层文件无法访问时，仍识别为便携版。 */ }
  return { kind: 'portable', execPath: outer };
}

module.exports = { APP_ID, MARKER_NAME, MARKER_CONTENT, DISTRIBUTION_NAMES,
  isStableVersion, compareStableVersions, distributionFileName, readDistribution };
