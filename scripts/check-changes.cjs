'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { selectChecks } = require('./change-check-plan.cjs');
const { runSteps, redact } = require('./checked-runner.cjs');
const root = path.resolve(__dirname, '..');

function changedFiles(base, cwd = root) {
  const git = args => execFileSync('git', args, { cwd, encoding: 'utf8' }).split('\0').filter(Boolean);
  const common = ['--name-only', '--no-renames', '-z'];
  // 无法解析基线时直接失败，不把未知差异伪装成没有改动。
  const ancestor = execFileSync('git', ['merge-base', base, 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  return [...new Set([
    ...git(['diff', ...common, ancestor, 'HEAD', '--']),
    ...git(['diff', ...common, '--cached', '--']),
    ...git(['diff', ...common, '--']),
    ...git(['ls-files', '--others', '--exclude-standard', '-z']),
  ])];
}
function buildSteps(selected, { interactive, ocr, output }) {
  const electron = require('electron');
  const step = (id, name, script, args = [], timeoutMs) => ({ id, name, command: electron, args: [path.join(__dirname, script), '--output-dir', path.join(output, id), ...args], timeoutMs });
  const steps = [], uncovered = [];
  const has = id => selected.some(check => check.id === id);
  if (has('ui') || has('settings')) steps.push({ id: 'native-build', name: '准备隐藏桌面专项所需的原生助手', command: process.execPath, args: [path.join(__dirname, 'build-native.cjs')] });
  if (has('ui')) steps.push({ id: 'ui', name: '基础隐藏界面', command: process.execPath, args: [path.join(__dirname, 'check-ui.cjs'), '--output-dir', path.join(output, 'ui')] });
  if (has('settings')) {
    steps.push(step('settings-save', '设置真实临时存储、失败草稿与恢复及正常动效阅读位置', 'check-ui-appearance.cjs', ['--normal-motion']));
    steps.push(step('settings-reading-reduced', '减少动态效果下的阅读位置与草稿', 'check-ui-appearance.cjs', ['--reduced-motion', '--anchor-only']));
    steps.push(step('settings-recovery', '设置恢复与关闭阻断解除', 'check-settings-recovery.cjs'));
    steps.push(step('settings-visual', '设置窄窗及保存状态布局', 'check-settings-visual-repair.cjs'));
    steps.push(step('slider-hidden', '滑块隐藏节点及保存回归', 'check-appearance-slider-save.cjs'));
    if (interactive) steps.push({ ...step('slider-focused', '滑块实际获焦鼠标交互', 'check-appearance-slider-save.cjs', ['--visible']), windowsHide: false });
    else uncovered.push({ 能力: '滑块实际获焦鼠标交互', 原因: '本次未声明交互桌面；隐藏结果不能替代焦点证据', 入口: 'npm run check:merge' });
  }
  if (has('history') || has('settings')) steps.push(step('history-settings', '历史批量操作及服务设置', 'check-history-settings-ui.cjs'));
  if (has('translation')) {
    steps.push(step('translation-ui', '截图翻译普通 UI 合同（无 Windows OCR）', 'check-screenshot-translation.cjs', ['--ui-only']));
    if (ocr) steps.push(step('translation-ocr', '截图翻译 Windows 中英文 OCR 与覆盖像素', 'check-screenshot-translation.cjs', ['--native-ocr'], 180000));
    else uncovered.push({ 能力: 'Windows OCR 与中英文识别语言', 原因: '普通隐藏 CI 仅运行固定 OCR 材料的 UI 合同', 入口: 'npm run check:changes -- --ocr；需要 Windows OCR、英文和简体中文识别语言' });
  }
  if (has('package')) steps.push({ id: 'package', name: '构建并验证冻结便携包、真实 EXE 失败阻断及本机服务贯通', command: process.execPath, args: [path.join(__dirname, 'package.cjs')], timeoutMs: 900000 });
  return { steps, uncovered };
}
async function main() {
  const args = process.argv.slice(2);
  const values = new Set(['--base', '--output-dir']);
  const flags = new Set(['--all', '--ui-all', '--package', '--interactive', '--ocr', '--plan-only']);
  for (let index = 0; index < args.length; index++) {
    if (values.has(args[index])) { index++; continue; }
    if (!flags.has(args[index])) throw Error(`未知检查参数：${args[index]}`);
  }
  const value = (flag, fallback) => {
    const index = args.indexOf(flag);
    if (index < 0) return fallback;
    if (!args[index + 1] || args[index + 1].startsWith('--')) throw Error(`${flag} 缺少参数`);
    return args[index + 1];
  };
  const base = value('--base', process.env.CHECK_BASE || 'origin/main');
  const output = path.resolve(value('--output-dir', path.join(root, 'output', 'verification', `changes-${Date.now()}`)));
  const files = changedFiles(base);
  const selected = selectChecks(files, { all: args.includes('--all'), uiAll: args.includes('--ui-all'), forcePackage: args.includes('--package') });
  const { steps, uncovered } = buildSteps(selected, { interactive: args.includes('--interactive'), ocr: args.includes('--ocr'), output });
  const report = { 基线: base, 改动: files, 选择: selected, 未覆盖: uncovered, 仅计划: args.includes('--plan-only'), 通过: false,
    检查: steps.map(({ id, name }) => ({ id, 名称: name, 状态: '未执行' })) };
  fs.mkdirSync(output, { recursive: true });
  const save = () => fs.writeFileSync(path.join(output, '改动检查报告.json'), redact(JSON.stringify(report, null, 2)), 'utf8');
  save();
  console.log(JSON.stringify({ 选择: selected, 未覆盖: uncovered, 报告: path.join(output, '改动检查报告.json') }, null, 2));
  if (report.仅计划) return;
  try {
    for (const [index, check] of steps.entries()) {
      report.检查[index].状态 = '执行中'; save();
      try { await runSteps([check], { cwd: root, logFile: path.join(output, `${check.id}-受检日志.txt`) }); }
      catch (error) { report.检查[index].状态 = '失败'; throw error; }
      report.检查[index].状态 = '通过'; save();
    }
    report.通过 = true;
  } finally { save(); }
}
if (require.main === module) main().catch(error => { console.error(redact(error.message)); process.exitCode = 1; });
module.exports = { changedFiles, buildSteps };
