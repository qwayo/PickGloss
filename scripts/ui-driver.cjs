'use strict';
const { quoteJavaScriptString } = require('./javascript-string.cjs');
const { setTimeout: delay } = require('node:timers/promises');

// 只返回结构化状态；禁止收集输入值、正文、任意错误原文或网络响应。
function inspectUi(options) {
  const shown = node => Boolean(node && node.getClientRects().length && node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && !node.closest('[hidden],[inert]'));
  const usable = node => shown(node) && !node.matches(':disabled') && node.getAttribute('aria-disabled') !== 'true' && getComputedStyle(node).pointerEvents !== 'none';
  const roots = options.scope ? [...document.querySelectorAll(options.scope)].filter(shown) : [document];
  const candidates = roots.flatMap(root => [...root.querySelectorAll(options.selector || 'button')]);
  const matched = [...new Set(candidates)].filter(node => options.label === undefined || [node.textContent.trim(), node.getAttribute('aria-label'), node.getAttribute('title')].includes(options.label));
  const visible = matched.filter(shown), active = visible.filter(usable);
  const sections = ['general', 'service', 'appearance', 'shortcuts'].filter(name => shown(document.querySelector('[data-settings-section="' + name + '"]')));
  const pages = [['设置', '.settings-navigation'], ['文字识别', '[data-field="paste-text"]'], ['解释', '.selected-word'], ['历史', '[data-field="history-search"]'], ['截图预览', '.recognition-preview']].filter(([, selector]) => shown(document.querySelector(selector))).map(([name]) => name);
  const alerts = [...document.querySelectorAll('.inline-error,.global-error,.appearance-notice.is-error,[role="alert"]')].filter(node => shown(node) && node.textContent.trim());
  const errors = [...new Set(alerts.map(node => /隔离.*本机|本机.*地址/.test(node.textContent) ? '隔离模式拒绝服务地址' : /写盘|写入|保存失败/.test(node.textContent) ? '设置写入失败' : '界面报告错误（原文已隐藏）'))];
  const report = { pages, sections, errors, scopes: roots.length, matched: matched.length, visible: visible.length, actionable: active.length,
    motionReduced: matchMedia('(prefers-reduced-motion: reduce)').matches, reducedMotion: document.documentElement.classList.contains('reduced-motion') };
  if (options.click && roots.length === 1 && active.length === 1) {
    active[0].scrollIntoView({ block: 'center', inline: 'nearest' });
    active[0].click(); report.clicked = true;
  }
  return report;
}
function createUiDriver(evaluate, { timeoutMs = 12000, intervalMs = 40 } = {}) {
  let phase = '加载界面', target = {};
  const inspect = options => evaluate(`(${inspectUi.toString()})(JSON.parse(${quoteJavaScriptString(JSON.stringify(options || {}))}))`);
  const failure = (expected, report, reason) => new Error(`界面检查失败：阶段=${phase}；期望=${expected}；原因=${reason}；状态=${JSON.stringify(report)}`);
  return {
    phase(name) { phase = name; },
    snapshot: () => inspect(target),
    async click(label, { scope, selector = 'button', stage = '点击目标控件' } = {}) {
      phase = stage;
      target = { label, scope, selector };
      const report = await inspect({ ...target, click: true });
      if (!report.clicked) throw failure('唯一可操作控件', report, report.scopes !== 1 ? '分区匹配不唯一' : report.actionable > 1 ? '同名控件匹配不唯一' : '未找到可操作控件');
    },
    async waitFor(expression, expected, { stage, allowErrors = false } = {}) {
      if (stage) phase = stage;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await evaluate(expression)) return;
        const report = await inspect(target);
        if (!allowErrors && report.errors.length) throw failure(expected, report, '界面拒绝了操作');
        await delay(intervalMs);
      }
      throw failure(expected, await inspect(target), '等待超时');
    },
    async diagnose(expected, reason = '等待超时') { return failure(expected, await inspect(target), reason); },
  };
}
module.exports = { createUiDriver };
