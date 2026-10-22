'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('入口报告保留逐次值、超时、分位数与未核实的正确性', () => {
  const script = path.join(__dirname, '../../scripts/summarize-selection-entry.cjs');
  const fixture = path.join(__dirname, '../fixtures/selection-entry-run.jsonl');
  const result = spawnSync(process.execPath, [script, fixture], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.observedMs, [100, 200, 600, null]);
  assert.equal(report.attempts, 4);
  assert.equal(report.timeouts, 1);
  assert.equal(report.over500, 1);
  assert.equal(report.incorrect, 1);
  assert.equal(report.correct, 2);
  assert.equal(report.unverified, 0);
  assert.deepEqual(report.correctObservedMs, [100, 600]);
  assert.equal(report.p50Ms, 100);
  assert.equal(report.p95Ms, 600);
  assert.equal(report.maxMs, 600);
  assert.equal(report.finalAcceptancePending, true);
});
