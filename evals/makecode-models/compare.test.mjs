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
  assert.equal(result.strictAutomatedProxyPass.rightMinusLeft, 0.5);
  assert.equal(result.totalScore.rightMinusLeft, 7.5);
});
