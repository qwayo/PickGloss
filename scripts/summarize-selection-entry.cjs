'use strict';
const fs = require('node:fs');

function percentile(sorted, ratio) {
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] ?? null;
}

function summarize(file) {
  const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean);
  const records = lines.map((line, index) => {
    try { return JSON.parse(line); }
    catch { throw new Error(`第 ${index + 1} 行不是有效 JSON。`); }
  });
  const run = records.find(item => item.type === 'run');
  if (!run || records.filter(item => item.type === 'run').length !== 1) throw new Error('计时记录必须有且仅有一个运行头。');
  const attempts = records.filter(item => item.type === 'attempt');
  for (let index = 0; index < attempts.length; index++) {
    const item = attempts[index];
    if (item.number !== index + 1 || !['entry-observed', 'timeout'].includes(item.result) ||
      (item.result === 'entry-observed' && (!Number.isInteger(item.observedMs) || item.observedMs < 0)) ||
      (item.result === 'timeout' && item.observedMs !== null) ||
      (item.result === 'timeout' && item.humanResult !== 'timeout') ||
      (item.result === 'entry-observed' && !['correct', 'incorrect', 'unverified'].includes(item.humanResult))) {
      throw new Error(`第 ${index + 1} 次采样记录无效。`);
    }
  }
  const observedMs = attempts.map(item => item.observedMs);
  const correctObservedMs = attempts.filter(item => item.humanResult === 'correct').map(item => item.observedMs);
  const measured = [...correctObservedMs].sort((a, b) => a - b);
  const end = records.find(item => item.type === 'end');
  return {
    candidateId: run.candidateId, sourceProcess: run.sourceProcess, sample: run.sample,
    targetMs: run.targetMs, requestedCount: run.requestedCount, attempts: attempts.length,
    completed: Boolean(end && end.completedCount === attempts.length && attempts.length === run.requestedCount),
    observedMs, correctObservedMs,
    correct: attempts.filter(item => item.humanResult === 'correct').length,
    incorrect: attempts.filter(item => item.humanResult === 'incorrect').length,
    unverified: attempts.filter(item => item.humanResult === 'unverified').length,
    timeouts: attempts.filter(item => item.result === 'timeout').length,
    over500: measured.filter(value => value > 500).length,
    p50Ms: percentile(measured, 0.5), p95Ms: percentile(measured, 0.95),
    maxMs: measured.at(-1) ?? null,
    finalAcceptancePending: true,
  };
}

try {
  if (process.argv.length !== 3) throw new Error('用法：node scripts/summarize-selection-entry.cjs <计时记录.jsonl>');
  console.log(JSON.stringify(summarize(process.argv[2]), null, 2));
} catch (error) {
  console.error(`入口报告无法生成：${error.message}`);
  process.exitCode = 1;
}
