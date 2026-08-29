import assert from "node:assert/strict";
import test from "node:test";

import { BYOK_SESSION_STORAGE_KEY, createByokBroker, publicBrokerError } from "./byok-broker.mjs";

function createMemoryStorage() {
  const state = {};
  return {
    state,
    async get(key) { return { [key]: structuredClone(state[key]) }; },
    async set(input) { Object.assign(state, structuredClone(input)); }
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

test("broker keeps keys private and returns only bounded trajectory metadata", async () => {
  const storage = createMemoryStorage();
  const seen = [];
  const broker = createByokBroker({
    storageArea: storage,
    fetchImpl: async (url, init) => {
      seen.push({ url: String(url), auth: init.headers.Authorization, body: JSON.parse(init.body) });
      return jsonResponse({ output_text: JSON.stringify({
        feedback: ["done"],
        code: "basic.showIcon(IconNames.Heart)"
      }) });
    }
  });
  const publicConfig = await broker.saveConfig({
    provider: "openai",
    model: "gpt-5.6-luna",
    apiKey: "secret-canary",
    thinkHarder: false
  });
  assert.deepEqual(publicConfig, {
    provider: "openai",
    model: "gpt-5.6-luna",
    thinkHarder: false,
    hasKey: true
  });
  assert.equal(storage.state[BYOK_SESSION_STORAGE_KEY].keys.openai, "secret-canary");

  const result = await broker.generate({
    target: "microbit",
    request: "show a heart",
    currentCode: "",
    pageErrors: [],
    recentChat: []
  });
  assert.equal(result.outcome, "ok");
  assert.equal(result.validationOk, true);
  assert.deepEqual(result.trace, {
    attempts: 1,
    firstFailure: null,
    finalOutcome: "ok",
    validationMode: "static"
  });
  assert.equal(Object.hasOwn(result, "attempts"), false);
  assert.equal(JSON.stringify(result).includes("secret-canary"), false);
  assert.equal(seen[0].auth, "Bearer secret-canary");
});

test("broker runs the production correction loop with a three-call ceiling", async () => {
  const storage = createMemoryStorage();
  let calls = 0;
  const broker = createByokBroker({
    storageArea: storage,
    fetchImpl: async () => {
      calls += 1;
      const output = calls < 3
        ? { feedback: ["retry"], code: "const nope = () => 1" }
        : { feedback: ["fixed"], code: "basic.showNumber(1)" };
      return jsonResponse({ output_text: JSON.stringify(output) });
    }
  });
  await broker.saveConfig({ apiKey: "secret" });
  const result = await broker.generate({ target: "microbit", request: "show one" });
  assert.equal(calls, 3);
  assert.equal(result.outcome, "ok");
  assert.equal(result.trace.attempts, 3);
  assert.equal(result.trace.firstFailure, "invalid");
});

test("broker rejects oversized semantic requests before network access", async () => {
  const storage = createMemoryStorage();
  let calls = 0;
  const broker = createByokBroker({
    storageArea: storage,
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ output_text: "" });
    }
  });
  await broker.saveConfig({ apiKey: "secret" });
  await assert.rejects(
    broker.generate({ request: "x".repeat(4001) }),
    /request_too_large/
  );
  assert.equal(calls, 0);
});

test("broker rejects arbitrary fetch-like request fields", async () => {
  const storage = createMemoryStorage();
  let calls = 0;
  const broker = createByokBroker({
    storageArea: storage,
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ output_text: "" });
    }
  });
  await broker.saveConfig({ apiKey: "secret" });
  await assert.rejects(
    broker.generate({ request: "hello", url: "https://attacker.invalid", headers: { Authorization: "x" } }),
    /unsupported_request_field/
  );
  assert.equal(calls, 0);
});

test("broker cancellation aborts the provider fetch", async () => {
  const storage = createMemoryStorage();
  let observedSignal;
  const broker = createByokBroker({
    storageArea: storage,
    fetchImpl: async (_url, init) => {
      observedSignal = init.signal;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    }
  });
  await broker.saveConfig({ apiKey: "secret" });
  const controller = new AbortController();
  const pending = broker.generate(
    { target: "microbit", request: "show a heart" },
    { signal: controller.signal }
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort();
  await assert.rejects(pending, (error) => error?.name === "AbortError");
  assert.equal(observedSignal, controller.signal);
  assert.equal(observedSignal.aborted, true);
});

test("public broker errors never return arbitrary exception text", () => {
  assert.deepEqual(publicBrokerError(new Error("secret response body")), {
    code: "generation_failed",
    status: 0
  });
});

test("public broker errors distinguish an internal timeout from user cancellation", () => {
  const aborted = new DOMException("Aborted", "AbortError");
  assert.deepEqual(publicBrokerError(aborted), { code: "cancelled", status: 0 });
  assert.deepEqual(publicBrokerError(aborted, { timedOut: true }), {
    code: "request_timed_out",
    status: 0
  });
});
