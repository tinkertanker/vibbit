import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const runner = new URL("./run.mjs", import.meta.url).pathname;

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
  const server = createServer((request, response) => {
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
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    await execFileAsync(process.execPath, [
      runner,
      "--provider", "custom",
      "--endpoint", `http://127.0.0.1:${address.port}/chat/completions`,
      "--models", "test-model",
      "--samples", "1",
      "--policy", "harness",
      "--validation", "static-only",
      "--corpus", corpusPath,
      "--out", outDir
    ], {
      env: { ...process.env, MODEL_EVAL_API_KEY: "test-key" }
    });
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
    assert.equal(record.evaluation.hardPass, true);
    assert.equal(summary.metrics.overall.conditionalRepairSuccess.rate, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(temp, { recursive: true, force: true });
  }
});
