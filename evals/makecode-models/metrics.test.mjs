import assert from "node:assert/strict";
import test from "node:test";

import { pairedBootstrap, quantile, summarizeRecords, wilsonInterval } from "./metrics.mjs";

function record(model, caseId, hardPass, overrides = {}) {
  return {
    model,
    provider: "test-provider",
    target: "microbit",
    category: "sensors",
    caseId,
    repetition: 0,
    evaluation: {
      hardPass,
      harnessPass: hardPass,
      firstAttemptPass: hardPass,
      passWithinBudget: hardPass,
      repairEligible: false,
      repaired: false,
      fallback: false,
      falseSuccess: false,
      failureClass: hardPass ? null : "decompile",
      latencyMs: hardPass ? 10 : 20,
      costUsd: hardPass ? 0.01 : 0.02,
      ...overrides
    }
  };
}

test("quantile interpolates sorted finite values", () => {
  assert.equal(quantile([30, 10, null, 20], 0.5), 20);
  assert.equal(quantile([], 0.95), null);
});

test("Wilson interval stays within probability bounds", () => {
  assert.equal(wilsonInterval(0, 0), null);
  const interval = wilsonInterval(3, 4);
  assert(interval.low > 0 && interval.low < 0.75);
  assert(interval.high > 0.75 && interval.high <= 1);
});

test("summarizeRecords reports policy, repair, outcome, latency, and failure metrics", () => {
  const records = [
    record("a", "one", true),
    record("a", "two", false, {
      firstAttemptPass: false,
      passWithinBudget: true,
      repairEligible: true,
      repaired: true,
      fallback: true,
      falseSuccess: true
    })
  ];
  const summary = summarizeRecords(records);
  assert.equal(summary.overall.hardPass.rate, 0.5);
  assert.equal(summary.overall.passWithinBudget.rate, 1);
  assert.equal(summary.overall.conditionalRepairSuccess.rate, 1);
  assert.equal(summary.overall.fallback.rate, 0.5);
  assert.equal(summary.overall.falseSuccess.rate, 0.5);
  assert.equal(summary.overall.latencyMs.median, 15);
  assert.equal(summary.overall.failureClasses.decompile, 1);
  assert.equal(summary.byTarget.microbit.count, 2);
});

test("pairedBootstrap compares matched cases rather than unpaired totals", () => {
  const records = [
    record("a", "one", true),
    record("b", "one", false),
    record("a", "two", false),
    record("b", "two", false),
    record("a", "unmatched", true)
  ];
  const [comparison] = pairedBootstrap(records, 100);
  assert.equal(comparison.pairedCases, 2);
  assert.equal(comparison.hardPassRateDelta, 0.5);
  assert(comparison.bootstrap95.low >= 0);
  assert(comparison.bootstrap95.high <= 1);
});
