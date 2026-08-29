import assert from "node:assert/strict";
import test from "node:test";

import { compareRuns } from "./compare.mjs";

function row(caseId, pass, totalScore) {
  return {
    provider: "test",
    model: "model",
    caseId,
    repetition: 0,
    totalScore,
    evaluation: { strictAutomatedProxyPass: pass }
  };
}

test("compareRuns pairs equivalent rows across policy or context runs", () => {
  const result = compareRuns(
    [row("one", false, 60), row("two", true, 90), row("left-only", true, 100)],
    [row("one", true, 80), row("two", true, 85), row("right-only", false, 0)]
  );
  assert.equal(result.pairedRows, 2);
  assert.equal(result.unmatchedLeftRows, 1);
  assert.equal(result.unmatchedRightRows, 1);
  assert.equal(result.strictAutomatedProxyPass.rightMinusLeft, 0.5);
  assert.equal(result.totalScore.rightMinusLeft, 7.5);
});

test("compareRuns rejects duplicate pairing keys", () => {
  assert.throws(
    () => compareRuns([row("one", true, 100), row("one", false, 0)], [row("one", true, 100)]),
    /left run contains duplicate/
  );
  assert.throws(
    () => compareRuns([row("one", true, 100)], [row("one", true, 100), row("one", false, 0)]),
    /right run contains duplicate/
  );
});

test("compareRuns rejects incomplete identities and excludes unmeasured pass pairs", () => {
  assert.throws(
    () => compareRuns([{ ...row("one", true, 100), provider: "" }], [row("one", true, 100)]),
    /require provider, model, caseId/
  );
  assert.throws(
    () => compareRuns([{ ...row("one", true, 100), repetition: 0.5 }], [row("one", true, 100)]),
    /non-negative integer repetition/
  );
  const unmeasured = row("one", false, null);
  unmeasured.evaluation.strictAutomatedProxyPass = null;
  const result = compareRuns([unmeasured], [row("one", true, 100)]);
  assert.equal(result.pairedRows, 1);
  assert.equal(result.strictAutomatedProxyPass.pairs, 0);
  assert.equal(result.totalScore.pairs, 0);
});
