'use strict';
// 参数始终作为参数数组传递；不通过 shell 拼接命令。
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

function redact(value, secrets = []) {
  let text = String(value);
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(secret).join('<已脱敏>');
  return text.replace(/\b(?:sk-[\w-]{12,}|gh[pousr]_[\w]{15,})/g, '<已脱敏>')
    .replace(/(authorization\s*[:=]\s*(?:Bearer\s+)?)[^\r\n]+/gi, '$1<已脱敏>')
    .replace(/((?:api[_-]?key|token|password)\s*["']?\s*[:=]\s*)[^\r\n,}]+/gi, '$1<已脱敏>');
}
function compareText(actual, expected, normalizeEol = false) {
  const normalize = value => normalizeEol ? value.replace(/\r\n/g, '\n') : value;
  assert.equal(normalize(actual), normalize(expected), '文本校验不一致');
}
async function runSteps(steps, { cwd = process.cwd(), logFile, secrets = [], write = value => process.stdout.write(value) } = {}) {
  if (logFile) { fs.mkdirSync(path.dirname(logFile), { recursive: true }); fs.writeFileSync(logFile, '', 'utf8'); }
  const log = value => { const safe = redact(value, secrets); if (logFile) fs.appendFileSync(logFile, safe, 'utf8'); write(safe); };
  for (const [index, step] of steps.entries()) {
    const name = step.name || `步骤 ${index + 1}`;
    log(`开始：${name}\n`);
    try {
      if (step.run) await step.run();
      else if (step.assertText) compareText(step.assertText.actual, step.assertText.expected, step.assertText.normalizeEol);
      else {
        if (typeof step.command !== 'string' || !Array.isArray(step.args)) throw Error('命令需要程序名称及参数数组');
        const child = spawnSync(step.command, step.args, {
          cwd: step.cwd || cwd, shell: false, windowsHide: true, encoding: 'utf8',
          timeout: step.timeoutMs || 180000, maxBuffer: 16 * 1024 * 1024,
          env: { ...process.env, ...step.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
        });
        if (child.stdout) log(child.stdout);
        if (child.stderr) log(child.stderr);
        if (child.error) throw Error(`程序启动或执行失败（${child.error.code || '未知原因'}）`);
        if (child.status !== 0 || child.signal) throw Error(`程序退出失败（退出码 ${child.status}，信号 ${child.signal || '无'}）`);
      }
      log(`通过：${name}\n`);
    } catch (error) {
      // 断言对象可能包含真实文本；只保留阶段，不输出 actual / expected。
      const reason = error.code === 'ERR_ASSERTION' ? '校验断言失败' : error.message;
      log(`失败：${name}；${reason}\n`);
      throw new Error(`受检执行停止：${name}；${redact(reason, secrets)}`);
    }
  }
}
if (require.main === module) {
  (async () => {
    const file = path.resolve(process.argv[2]);
    const plan = JSON.parse(fs.readFileSync(file, 'utf8'));
    await runSteps(plan.steps, { cwd: path.dirname(file), logFile: plan.logFile && path.resolve(path.dirname(file), plan.logFile), secrets: plan.secrets });
  })().catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { runSteps, compareText, redact };
