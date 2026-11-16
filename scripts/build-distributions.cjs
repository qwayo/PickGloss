'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { runSteps } = require('./checked-runner.cjs');
const { APP_ID, MARKER_NAME, MARKER_CONTENT, distributionFileName } = require('../src/core/distribution.cjs');

async function buildDistributions({ root, packageDirectory, output, version, hashFile }) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'pickgloss-distributions-'));
  const prepackaged = path.join(temporary, 'payload');
  const artifacts = path.join(temporary, 'artifacts');
  await fs.cp(packageDirectory, prepackaged, { recursive: true, force: false, errorOnExist: true });
  await fs.writeFile(path.join(prepackaged, 'resources', MARKER_NAME), MARKER_CONTENT, { flag: 'wx' });
  const builderPackage = require.resolve('electron-builder/package.json');
  const builderDirectory = path.dirname(builderPackage);
  await fs.copyFile(path.join(builderDirectory, 'LICENSE'), path.join(prepackaged, 'LICENSE-electron-builder.txt'));

  const setup = distributionFileName('setup', version);
  const portable = distributionFileName('portable', version);
  const config = path.join(temporary, 'electron-builder.json');
  await fs.writeFile(config, JSON.stringify({
    appId: APP_ID,
    directories: { output: artifacts },
    publish: null,
    win: { icon: path.join(root, 'src', 'renderer', 'assets', 'pickgloss-app.ico') },
    nsis: { artifactName: setup, oneClick: true, perMachine: false, deleteAppDataOnUninstall: false, differentialPackage: false },
    portable: { artifactName: portable, unpackDirName: false },
  }));
  const builder = path.join(builderDirectory, require(builderPackage).bin['electron-builder']);
  // electron-builder 的临时文件退出钩子仅作用于子进程，冒烟检查的失败仍由打包入口返回。
  await runSteps([{ name: '封装安装版与便携版', command: process.execPath,
    args: [builder, '--win', 'nsis', 'portable', '--x64', '--prepackaged', prepackaged, '--config', config, '--publish', 'never'],
    env: { NO_UPDATE_NOTIFIER: '1' }, timeoutMs: 720_000 }], { cwd: root });
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
