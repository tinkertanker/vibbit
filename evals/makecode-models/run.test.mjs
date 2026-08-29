import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  buildPrompt,
  criteriaResult,
  estimateCost,
  normalizeUsage,
  runHarnessEvaluation
} from "./run.mjs";

const execFileAsync = promisify(execFile);
const runner = new URL("./run.mjs", import.meta.url).pathname;

async function startServer(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

function endpointFor(server) {
  return `http://127.0.0.1:${server.address().port}/chat/completions`;
}

test("Harness policy captures retries and reports conditional repair", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "vibbit-model-eval-"));
  const corpusPath = path.join(temp, "corpus.json");
  const outDir = path.join(temp, "out");
  await writeFile(corpusPath, JSON.stringify({
    version: 1,
    cases: [{
      id: "repair-one",
      target: "microbit",
      category: "test",
      request: "show one",
      required: ["basic\\.showNumber\\(1\\)"],
      forbidden: ["=>"]
    }]
  }));

  const requestBodies = [];
  const server = await startServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      requestBodies.push(JSON.parse(body));
      const attempt = requestBodies.length;
      const output = attempt === 1
        ? { feedback: ["retry"], code: "const bad = () => 1" }
        : { feedback: ["fixed"], code: "basic.showNumber(1)" };
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        id: `response-${attempt}`,
        model: "test-model",
        choices: [{ finish_reason: "stop", message: { content: JSON.stringify(output) } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 }
      }));
    });
  });

  try {
    await execFileAsync(process.execPath, [
      runner,
      "--provider", "custom",
      "--endpoint", endpointFor(server),
      "--models", "test-model",
      "--samples", "1",
      "--policy", "harness",
      "--validation", "static-only",
      "--corpus", corpusPath,
      "--out", outDir
    ], { env: { ...process.env, MODEL_EVAL_API_KEY: "test-credential" } });
    const [runName] = await readdir(outDir);
    const runDir = path.join(outDir, runName);
    const [record] = (await readFile(path.join(runDir, "results.jsonl"), "utf8"))
      .trim().split("\n").map(JSON.parse);
    const summary = JSON.parse(await readFile(path.join(runDir, "summary.json"), "utf8"));

    assert.equal(requestBodies.length, 2);
    assert.deepEqual(requestBodies[0].messages.map((message) => message.role), ["system", "user"]);
    assert.deepEqual(requestBodies[1].messages.map((message) => message.role), ["system", "user", "assistant", "user"]);
    assert.match(requestBodies[1].messages[3].content, /FAILED_ATTEMPT/);
    assert.equal(record.outcome, "ok");
    assert.equal(record.upstreamAttempts, 2);
    assert.equal(record.trajectory[0].failureClass, "invalid");
    assert.equal(record.trajectory[1].failureClass, "ok");
    assert.equal(record.evaluation.repairEligible, true);
    assert.equal(record.evaluation.repaired, true);
    assert.equal(record.evaluation.staticPolicyPass, true);
    assert.equal(record.evaluation.strictAutomatedProxyPass, true);
    assert.equal(record.makeCodeValidation.ok, true);
    assert.equal(summary.metrics.overall.conditionalRepairSuccess.rate, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(temp, { recursive: true, force: true });
  }
});

test("pinned Harness validator outage is unverified and does not trigger repair", async () => {
  let providerCalls = 0;
  const { policyResult, pinned } = await runHarnessEvaluation({
    target: "microbit",
    systemPrompt: "system",
    userPrompt: "user",
    options: {
      validation: "pinned",
      maxEmptyRetries: 2,
      maxValidationRetries: 2,
      maxAttempts: 3
    },
    callModel: async () => {
      providerCalls += 1;
      return JSON.stringify({ feedback: ["ok"], code: "basic.showNumber(1)" });
    },
    compileImpl: async () => {
      throw new Error("compiler unavailable");
    }
  });
  assert.equal(providerCalls, 1);
  assert.equal(policyResult.upstreamAttempts, 1);
  assert.equal(policyResult.outcome, "ok-unverified");
  assert.equal(pinned.report, null);
  assert.equal(pinned.error.code, "pinned_validation_unavailable");
});

test("current-code and diagnostic ablations change one explicit prompt input", () => {
  const testCase = {
    target: "microbit",
    request: "fix it",
    currentCode: `HEAD-${"m".repeat(200)}-TAIL`,
    pageErrors: ["compile marker"],
    conversionDialog: { title: "Convert title", description: "Convert detail" },
    recentChat: []
  };
  const base = {
    promptMode: "managed",
    maxCurrentCodeChars: 100,
    currentCodeWindow: "production"
  };
  const production = buildPrompt(testCase, { ...base, context: "full" }).user;
  const head = buildPrompt(testCase, { ...base, context: "full", currentCodeWindow: "head" }).user;
  const tail = buildPrompt(testCase, { ...base, context: "full", currentCodeWindow: "tail" }).user;
  assert.match(production, /HEAD-/);
  assert.match(production, /-TAIL/);
  assert.match(head, /HEAD-/);
  assert.doesNotMatch(head, /-TAIL/);
  assert.doesNotMatch(tail, /HEAD-/);
  assert.match(tail, /-TAIL/);

  const noErrors = buildPrompt(testCase, { ...base, context: "no-page-errors" }).user;
  assert.doesNotMatch(noErrors, /compile marker/);
  assert.match(noErrors, /Convert title/);
  const noDialog = buildPrompt(testCase, { ...base, context: "no-conversion-dialog" }).user;
  assert.match(noDialog, /compile marker/);
  assert.doesNotMatch(noDialog, /Convert title/);
});

test("Responses usage is normalized and null cost stays unknown", () => {
  const usage = {
    input_tokens: 100,
    output_tokens: 25,
    output_tokens_details: { reasoning_tokens: 5 },
    cost: null
  };
  assert.deepEqual(normalizeUsage(usage), {
    inputTokens: 100,
    outputTokens: 25,
    totalTokens: null,
    reasoningTokens: 5,
    cachedInputTokens: null
  });
  assert(Math.abs(estimateCost(usage, { prompt: "0.001", completion: "0.002" }) - 0.15) < 1e-9);
  assert.equal(estimateCost(usage, null), null);
});

test("regex criteria remain an explicit proxy rather than semantic certification", () => {
  const proxy = criteriaResult(
    "let count = 0\ncount += 1\nbasic.showNumber(count)\ninput.onButtonPressed(Button.A, function () {})",
    {
      required: [
        "let\\s+count\\s*=\\s*0",
        "Button\\.A",
        "count\\s*\\+=\\s*1",
        "basic\\.showNumber\\(count\\)"
      ],
      forbidden: ["radio\\.", "LEAK"]
    }
  );
  assert.equal(proxy.ok, true);
});

test("terminal provider failure preserves prior attempts without persisting echoed credentials", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "vibbit-model-eval-error-"));
  const corpusPath = path.join(temp, "corpus.json");
  const outDir = path.join(temp, "out");
  const canary = "funded-credential-canary-do-not-write";
  await writeFile(corpusPath, JSON.stringify({
    version: 1,
    cases: [{
      id: "provider-fails-on-repair",
      target: "microbit",
      category: "test",
      request: "show one",
      required: ["basic\\.showNumber\\(1\\)"],
      forbidden: ["=>"]
    }]
  }));
  let calls = 0;
  const server = await startServer((request, response) => {
    request.resume();
    request.on("end", () => {
      calls += 1;
      if (calls === 1) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          choices: [{ message: { content: JSON.stringify({
            feedback: ["retry"],
            code: "const bad = () => 1"
          }) } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 }
        }));
        return;
      }
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: `echo ${canary}` } }));
    });
  });
  try {
    await execFileAsync(process.execPath, [
      runner,
      "--provider", "custom",
      "--endpoint", endpointFor(server),
      "--models", "test-model",
      "--samples", "1",
      "--policy", "harness",
      "--validation", "static-only",
      "--corpus", corpusPath,
      "--out", outDir
    ], { env: { ...process.env, MODEL_EVAL_API_KEY: canary } });
    const [runName] = await readdir(outDir);
    const runDir = path.join(outDir, runName);
    const outputFiles = await Promise.all([
      "results.jsonl",
      "makecode-validation.jsonl",
      "models-snapshot.json",
      "summary.json"
    ].map((name) => readFile(path.join(runDir, name), "utf8")));
    assert.equal(outputFiles.some((text) => text.includes(canary)), false);
    const [record] = outputFiles[0].trim().split("\n").map(JSON.parse);
    assert.equal(record.status, "error");
    assert.equal(record.error.code, "provider_http_error");
    assert.equal(record.error.status, 401);
    assert.equal(record.trajectory.length, 2);
    assert.match(record.trajectory[0].rawCandidate, /const bad/);
    assert.equal(record.trajectory[1].error.code, "provider_http_error");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(temp, { recursive: true, force: true });
  }
});
