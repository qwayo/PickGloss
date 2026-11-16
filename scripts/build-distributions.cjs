'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { APP_ID, MARKER_NAME, MARKER_CONTENT, distributionFileName } = require('../src/core/distribution.cjs');

async function buildDistributions({ root, packageDirectory, output, version, hashFile }) {
  const { build, Platform, Arch } = require('electron-builder');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'pickgloss-distributions-'));
  const prepackaged = path.join(temporary, 'payload');
  const artifacts = path.join(temporary, 'artifacts');
  await fs.cp(packageDirectory, prepackaged, { recursive: true, force: false, errorOnExist: true });
  await fs.writeFile(path.join(prepackaged, 'resources', MARKER_NAME), MARKER_CONTENT, { flag: 'wx' });
  const builderDirectory = path.dirname(require.resolve('electron-builder/package.json'));
  await fs.copyFile(path.join(builderDirectory, 'LICENSE'), path.join(prepackaged, 'LICENSE-electron-builder.txt'));

  const setup = distributionFileName('setup', version);
  const portable = distributionFileName('portable', version);
  await build({
    projectDir: root, prepackaged, publish: 'never',
    targets: Platform.WINDOWS.createTarget(['nsis', 'portable'], Arch.x64),
    config: {
      appId: APP_ID,
      directories: { output: artifacts },
      publish: null,
      win: { icon: path.join(root, 'src', 'renderer', 'assets', 'pickgloss-app.ico') },
      nsis: { artifactName: setup, oneClick: true, perMachine: false, deleteAppDataOnUninstall: false, differentialPackage: false },
      portable: { artifactName: portable, unpackDirName: false },
    },
  });
  const results = {};
  for (const name of [setup, portable]) {
    const candidate = path.join(artifacts, name);
    const file = await fs.open(candidate, 'r');
    try {
      const header = Buffer.alloc(2);
      await file.read(header);
      if (header.toString('ascii') !== 'MZ') throw new Error(`发行文件不是 Windows EXE：${name}`);
    } finally { await file.close(); }
    const frozen = path.join(output, name);
    await fs.copyFile(candidate, frozen, fs.constants.COPYFILE_EXCL);
    results[name] = await hashFile(frozen);
    console.log(`冻结发行文件：${frozen}`);
  }
  return results;
}

module.exports = { buildDistributions };
