import assert from "node:assert/strict";
import test from "node:test";
import { createBackendRuntime } from "./runtime.mjs";

// Mocked tkslopper routing tests. No real gateway or provider traffic.
const CONTROL_PLANE_URL = "https://control.tkslopper.test";
const GATEWAY_URL = "https://gateway.tkslopper.test";
const SERVICE_CREDENTIAL = "tksvc_abcdef012345_SyntheticSecretValue0123456789";
const ADMIN_TOKEN = "admin-test-token";
const OK_CODE = "basic.showIcon(IconNames.Heart)";
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7E]{8,128}$/;

const TKSLOPPER_ENV = {
  VIBBIT_TKSLOPPER_ENABLED: "true",
  VIBBIT_TKSLOPPER_CLASSROOM_IDS: "cls_managed",
  VIBBIT_TKSLOPPER_CONTROL_PLANE_URL: CONTROL_PLANE_URL,
  VIBBIT_TKSLOPPER_GATEWAY_URL: GATEWAY_URL,
  VIBBIT_TKSLOPPER_SERVICE_CREDENTIAL: SERVICE_CREDENTIAL
};

const HOSTED_ENV = {
  VIBBIT_DEPLOYMENT_MODE: "hosted",
  VIBBIT_PUBLIC_ORIGIN: "https://vibbit.example",
  VIBBIT_GOOGLE_CLIENT_ID: "fake-google-client-id",
  VIBBIT_GOOGLE_CLIENT_SECRET: "fake-google-client-secret",
  VIBBIT_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64url"),
  VIBBIT_CLASSROOM_ENABLED: "true",
  VIBBIT_ALLOW_ORIGIN: "https://makecode.microbit.org"
};

function seededPortalState() {
  const teacherId = "local:teacher@school.edu";
  const managedTeacherId = "local:managed@school.edu";
  const base = {
    teacherId,
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
  return {
    teachers: {
      [teacherId]: {
        id: teacherId,
        email: "teacher@school.edu",
        name: "Ms Tan",
        provider: "local",
        createdAt: "2026-01-01T00:00:00.000Z"
      },
      [managedTeacherId]: {
        id: managedTeacherId,
        email: "managed@school.edu",
        name: "Mr Lim",
        provider: "local",
        createdAt: "2026-01-01T00:00:00.000Z"
      }
    },
    classrooms: {
      // Teacher has no credential profile: only usable through the managed gateway.
      cls_managed: { ...base, teacherId: managedTeacherId, id: "cls_managed", name: "Managed class", code: "MANAG" },
      // Legacy key migrates to a tested credential profile (direct path).
      cls_direct: {
        ...base,
        id: "cls_direct",
        name: "Direct class",
        code: "DIREC",
        apiBaseUrl: "https://api.openai.com/v1",
        apiKey: "sk-direct-classroom",
        model: "gpt-4o-mini"
      }
    }
  };
}

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers }
  });
}

function gatewayChat({ content = JSON.stringify({ feedback: ["ok"], code: OK_CODE }), finishReason = "stop", refusal = null } = {}) {
  return jsonResponse(200, {
    id: "chatcmpl_test",
    object: "chat.completion",
    model: "text.chat.v1",
    choices: [{ index: 0, message: { role: "assistant", content, refusal }, finish_reason: finishReason }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }
  }, { "x-tkslopper-request-id": "req_gateway_1" });
}

function createFakeTkslopper({ inference, exchange } = {}) {
  const calls = { exchange: [], inference: [] };
  const fetchImpl = async (url, init = {}) => {
    if (url === `${CONTROL_PLANE_URL}/v1/token`) {
      calls.exchange.push({ url, init });
      const index = calls.exchange.length;
      if (typeof exchange === "function") return exchange(index, init);
      return jsonResponse(200, {
        grant_id: `grant_${index}`,
        access_token: `grant-token-${index}`,
        token_type: "Bearer",
        expires_in: 900,
        capabilities: ["text.chat.v1"]
      });
    }
    calls.inference.push({ url, init, body: JSON.parse(init.body), headers: init.headers });
    const index = calls.inference.length;
    const handler = Array.isArray(inference)
      ? inference[Math.min(index, inference.length) - 1]
      : inference;
    return typeof handler === "function" ? handler(index, init) : gatewayChat();
  };
  return { calls, fetchImpl };
}

function createRuntime({ env = {}, fake = createFakeTkslopper() } = {}) {
  const logs = [];
  const runtime = createBackendRuntime({
    env: {
      VIBBIT_DEPLOYMENT_MODE: "self-hosted",
      VIBBIT_CLASSROOM_ENABLED: "true",
      VIBBIT_CLASSROOM_CODE: "LEGACY",
      VIBBIT_CLASSROOM_CODE_AUTO: "false",
      VIBBIT_OPENAI_API_KEY: "server-fallback-key",
      VIBBIT_PROVIDER: "openai",
      VIBBIT_MODEL: "gpt-4o-mini",
      ...env
    },
    adminAuthToken: ADMIN_TOKEN,
    teacherPortalState: seededPortalState(),
    persistTeacherPortalState: async () => {},
    dnsLookup: async () => [{ address: "203.0.113.10", family: 4 }],
    tkslopperFetch: fake.fetchImpl,
    tkslopperLogger: (record) => logs.push(record)
  });
  return { runtime, fake, logs };
}

async function connect(runtime, classCode) {
  const response = await runtime.fetch(new Request("https://example.test/vibbit/connect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ classCode })
  }));
  return { response, body: await response.json() };
}

async function generate(runtime, sessionToken, payload = {}) {
  const response = await runtime.fetch(new Request("https://example.test/vibbit/generate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${sessionToken}`
    },
    body: JSON.stringify({ target: "microbit", request: "Show a heart", ...payload })
  }));
  return { response, text: await response.text() };
}

async function withDirectProviderMock(fn) {
  const directCalls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    directCalls.push({ url: String(url), body: String(init.body || "") });
    return jsonResponse(200, {
      choices: [{ message: { content: JSON.stringify({ feedback: ["direct"], code: OK_CODE }) } }]
    });
  };
  try {
    await fn(directCalls);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("routing: flag off makes zero tkslopper fetches and keeps the direct path", async () => {
  const { runtime, fake } = createRuntime();
  await withDirectProviderMock(async (directCalls) => {
    const direct = await connect(runtime, "DIREC");
    assert.equal(direct.response.status, 200);
    assert.equal(direct.body.defaultProvider, "openai");
    const result = await generate(runtime, direct.body.sessionToken);
    assert.equal(result.response.status, 200, result.text);
    assert.ok(directCalls.some((call) => call.url.startsWith("https://api.openai.com/v1/chat/completions")));

    // Without the flag, a classroom lacking a tested profile is still refused.
    const managed = await connect(runtime, "MANAG");
    assert.equal(managed.response.status, 503);
  });
  assert.equal(fake.calls.exchange.length, 0);
  assert.equal(fake.calls.inference.length, 0);
});

test("routing: allowlisted classroom uses tkslopper without a tested teacher profile", async () => {
  const { runtime, fake } = createRuntime({ env: TKSLOPPER_ENV });
  await withDirectProviderMock(async (directCalls) => {
    const managed = await connect(runtime, "MANAG");
    assert.equal(managed.response.status, 200, JSON.stringify(managed.body));
    assert.equal(managed.body.defaultProvider, "managed");
    assert.equal(managed.body.defaultModel, "text.chat.v1");
    assert.deepEqual(managed.body.enabledProviders, ["managed"]);
    assert.equal(managed.body.classroomName, "Managed class");

    const result = await generate(runtime, managed.body.sessionToken);
    assert.equal(result.response.status, 200, result.text);
    assert.equal(JSON.parse(result.text).code, OK_CODE);
    assert.equal(directCalls.length, 0);
  });
  assert.equal(fake.calls.exchange.length, 1);
  assert.equal(fake.calls.inference.length, 1);
  const call = fake.calls.inference[0];
  assert.deepEqual(Object.keys(call.body).sort(), ["max_tokens", "messages", "model", "stream"]);
  assert.deepEqual(call.body.messages.map((item) => item.role), ["system", "user"]);
  assert.match(call.body.messages[1].content, /Show a heart/);
  assert.match(call.headers["Idempotency-Key"], IDEMPOTENCY_KEY_PATTERN);
  assert.equal(runtime.usageStore.getToday("cls_managed").upstreamAttempts, 1);
});

test("routing: \"*\" enables every classroom", async () => {
  const { runtime, fake } = createRuntime({ env: { ...TKSLOPPER_ENV, VIBBIT_TKSLOPPER_CLASSROOM_IDS: "*" } });
  await withDirectProviderMock(async (directCalls) => {
    const direct = await connect(runtime, "DIREC");
    assert.equal(direct.body.defaultProvider, "managed");
    const result = await generate(runtime, direct.body.sessionToken);
    assert.equal(result.response.status, 200, result.text);
    assert.equal(directCalls.length, 0);
  });
  assert.equal(fake.calls.inference.length, 1);
});

test("routing: non-allowlisted classroom and legacy sessions keep the direct path", async () => {
  const { runtime, fake } = createRuntime({ env: TKSLOPPER_ENV });
  await withDirectProviderMock(async (directCalls) => {
    const direct = await connect(runtime, "DIREC");
    assert.equal(direct.body.defaultProvider, "openai");
    const directResult = await generate(runtime, direct.body.sessionToken);
    assert.equal(directResult.response.status, 200, directResult.text);

    const legacy = await connect(runtime, "LEGACY");
    assert.equal(legacy.response.status, 200);
    const legacyResult = await generate(runtime, legacy.body.sessionToken);
    assert.equal(legacyResult.response.status, 200, legacyResult.text);
    assert.equal(directCalls.length, 2);
  });
  assert.equal(fake.calls.exchange.length, 0);
  assert.equal(fake.calls.inference.length, 0);
});

test("routing: managed classroom sessions still cannot override provider or model", async () => {
  const { runtime, fake } = createRuntime({ env: TKSLOPPER_ENV });
  const managed = await connect(runtime, "MANAG");
  for (const override of [{ provider: "openai" }, { model: "gpt-4o" }, { model: "text.chat.v1" }]) {
    const result = await generate(runtime, managed.body.sessionToken, override);
    assert.equal(result.response.status, 400);
    assert.match(result.text, /cannot override provider or model/);
  }
  assert.equal(fake.calls.inference.length, 0);
});

test("repair: an empty or truncated reply is repaired with a new idempotency key", async () => {
  const fake = createFakeTkslopper({
    inference: [
      () => gatewayChat({ content: "{\"feedback\":[\"partial", finishReason: "length" }),
      () => gatewayChat()
    ]
  });
  const { runtime } = createRuntime({ env: TKSLOPPER_ENV, fake });
  const managed = await connect(runtime, "MANAG");
  const result = await generate(runtime, managed.body.sessionToken);
  assert.equal(result.response.status, 200, result.text);
  assert.equal(JSON.parse(result.text).upstreamAttempts, 2);
  assert.equal(fake.calls.inference.length, 2);
  assert.notEqual(
    fake.calls.inference[0].headers["Idempotency-Key"],
    fake.calls.inference[1].headers["Idempotency-Key"]
  );
  assert.deepEqual(fake.calls.inference[1].body.messages.map((item) => item.role), ["system", "user", "assistant", "user"]);
  // The truncated partial is never replayed as the assistant turn.
  assert.equal(fake.calls.inference[1].body.messages[2].content, "(empty)");
  assert.equal(runtime.usageStore.getToday("cls_managed").upstreamAttempts, 2);
});

test("errors: 402 and 429 map to Vibbit's 429 shape without retry", async () => {
  for (const [status, code] of [[402, "budget_exceeded"], [429, "rate_limit_exceeded"]]) {
    const fake = createFakeTkslopper({
      inference: () => jsonResponse(status, { error: { message: "limit", type: "error", code }, request_id: "req_limit" })
    });
    const { runtime } = createRuntime({ env: TKSLOPPER_ENV, fake });
    const managed = await connect(runtime, "MANAG");
    const result = await generate(runtime, managed.body.sessionToken);
    assert.equal(result.response.status, 429);
    assert.equal(result.response.headers.get("retry-after"), "30");
    assert.deepEqual(JSON.parse(result.text), {
      error: "Too many requests. Please wait and try again.",
      reason: "managed_ai_limited"
    });
    assert.equal(fake.calls.inference.length, 1);
  }
});

test("errors: refusal gives a student-safe message and is not repaired", async () => {
  const fake = createFakeTkslopper({
    inference: () => gatewayChat({ content: null, refusal: "Provider refusal text" })
  });
  const { runtime } = createRuntime({ env: TKSLOPPER_ENV, fake });
  const managed = await connect(runtime, "MANAG");
  const result = await generate(runtime, managed.body.sessionToken);
  assert.equal(result.response.status, 422);
  assert.deepEqual(JSON.parse(result.text), { error: "The AI service declined this request. Try rephrasing it." });
  assert.equal(fake.calls.inference.length, 1);
});

test("errors: kill-switch 403 on exchange shows managed AI unavailable", async () => {
  const fake = createFakeTkslopper({
    exchange: () => jsonResponse(403, { error: { message: "killed", type: "error", code: "authorization_failed" } })
  });
  const { runtime } = createRuntime({ env: TKSLOPPER_ENV, fake });
  const managed = await connect(runtime, "MANAG");
  const result = await generate(runtime, managed.body.sessionToken);
  assert.equal(result.response.status, 503);
  assert.match(JSON.parse(result.text).error, /Managed AI is unavailable/);
  assert.equal(fake.calls.inference.length, 0);
});

test("errors: ambiguous gateway failures are not retried and use a generic message", async () => {
  for (const status of [400, 409, 500, 502, 503, 504]) {
    const fake = createFakeTkslopper({
      inference: () => jsonResponse(status, { error: { message: "detail", type: "error", code: "internal_error" } })
    });
    const { runtime } = createRuntime({ env: TKSLOPPER_ENV, fake });
    const managed = await connect(runtime, "MANAG");
    const result = await generate(runtime, managed.body.sessionToken);
    assert.equal(result.response.status, 500);
    assert.deepEqual(JSON.parse(result.text), { error: `Managed AI request failed (HTTP ${status})` });
    assert.equal(fake.calls.inference.length, 1, `HTTP ${status} must not be retried`);
    assert.equal(runtime.usageStore.getToday("cls_managed").upstreamAttempts, 1);
  }
});

test("budget: no new attempt starts once the remaining budget is below the minimum", async () => {
  const fake = createFakeTkslopper({
    inference: () => new Promise((resolve) => {
      setTimeout(() => resolve(gatewayChat({ content: "partial", finishReason: "length" })), 150);
    })
  });
  const { runtime } = createRuntime({
    env: {
      ...TKSLOPPER_ENV,
      VIBBIT_TKSLOPPER_ATTEMPT_TIMEOUT_MS: "1000",
      VIBBIT_TKSLOPPER_TOTAL_BUDGET_MS: "1000",
      VIBBIT_TKSLOPPER_MIN_ATTEMPT_MS: "900"
    },
    fake
  });
  const managed = await connect(runtime, "MANAG");
  const result = await generate(runtime, managed.body.sessionToken);
  assert.equal(result.response.status, 504);
  assert.match(JSON.parse(result.text).error, /timed out/);
  assert.equal(fake.calls.inference.length, 1);
});

test("budget: each attempt is aborted at min(attempt timeout, remaining budget)", async () => {
  const fake = createFakeTkslopper({
    inference: (_index, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    })
  });
  const { runtime } = createRuntime({
    env: {
      ...TKSLOPPER_ENV,
      VIBBIT_TKSLOPPER_ATTEMPT_TIMEOUT_MS: "5000",
      VIBBIT_TKSLOPPER_TOTAL_BUDGET_MS: "1000",
      VIBBIT_TKSLOPPER_MIN_ATTEMPT_MS: "100"
    },
    fake
  });
  const managed = await connect(runtime, "MANAG");
  const startedAt = Date.now();
  const result = await generate(runtime, managed.body.sessionToken);
  const elapsed = Date.now() - startedAt;
  assert.equal(result.response.status, 504);
  assert.equal(fake.calls.inference.length, 1);
  assert.ok(elapsed < 4000, `attempt should stop near the 1000 ms budget, took ${elapsed} ms`);
});

test("config: hosted mode rejects a missing or non-https tkslopper setting at startup", () => {
  const base = { ...HOSTED_ENV, ...TKSLOPPER_ENV };
  const cases = [
    { VIBBIT_TKSLOPPER_SERVICE_CREDENTIAL: "" },
    { VIBBIT_TKSLOPPER_GATEWAY_URL: "" },
    { VIBBIT_TKSLOPPER_CONTROL_PLANE_URL: "" },
    { VIBBIT_TKSLOPPER_GATEWAY_URL: "http://gateway.tkslopper.test" },
    { VIBBIT_TKSLOPPER_CONTROL_PLANE_URL: "http://control.tkslopper.test" }
  ];
  for (const override of cases) {
    assert.throws(
      () => createBackendRuntime({ env: { ...base, ...override }, teacherPortalState: {} }),
      /VIBBIT_TKSLOPPER_/,
      JSON.stringify(override)
    );
  }
  assert.doesNotThrow(() => createBackendRuntime({ env: base, teacherPortalState: {} }));
  // Flag off ignores broken managed-gateway settings, so rollback is never blocked.
  assert.doesNotThrow(() => createBackendRuntime({
    env: { ...base, VIBBIT_TKSLOPPER_ENABLED: "false", VIBBIT_TKSLOPPER_GATEWAY_URL: "http://x" },
    teacherPortalState: {}
  }));
});

test("secrets: credential, grant and gateway URLs stay out of responses, status and logs", async () => {
  const { runtime, fake, logs } = createRuntime({ env: TKSLOPPER_ENV });
  const managed = await connect(runtime, "MANAG");
  const result = await generate(runtime, managed.body.sessionToken);
  assert.equal(result.response.status, 200, result.text);

  const configText = await (await runtime.fetch(new Request("https://example.test/vibbit/config"))).text();
  const healthText = await (await runtime.fetch(new Request("https://example.test/healthz"))).text();
  const statusResponse = await runtime.fetch(new Request("https://example.test/admin/status", {
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}` }
  }));
  assert.equal(statusResponse.status, 200);
  const statusText = await statusResponse.text();
  assert.deepEqual(JSON.parse(statusText).managedGateway, { enabled: true });
  const adminHtml = await (await runtime.fetch(new Request("https://example.test/admin", {
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}` }
  }))).text();
  const startupText = runtime.getStartupInfo({ listenUrl: "http://localhost:8787" }).join("\n");
  assert.match(startupText, /Managed gateway enabled for 1 classroom\(s\): endpoint=chat alias=text\.chat\.v1/);

  const surfaces = {
    connect: JSON.stringify(managed.body),
    generate: result.text,
    config: configText,
    health: healthText,
    status: statusText,
    admin: adminHtml,
    startup: startupText,
    logs: JSON.stringify(logs),
    runtimeConfig: JSON.stringify(runtime.config)
  };
  for (const [name, text] of Object.entries(surfaces)) {
    for (const secret of [SERVICE_CREDENTIAL, "grant-token-1", CONTROL_PLANE_URL, GATEWAY_URL]) {
      if (name === "runtimeConfig" && secret !== SERVICE_CREDENTIAL && !secret.startsWith("grant")) continue;
      assert.equal(text.includes(secret), false, `${name} leaked ${secret.slice(0, 12)}...`);
    }
  }

  const attemptLog = logs.find((record) => record.event === "tkslopper.inference");
  assert.ok(attemptLog);
  assert.equal(attemptLog.classroomId, "cls_managed");
  assert.equal(attemptLog.attempt, 1);
  assert.equal(attemptLog.status, 200);
  assert.equal(attemptLog.outcome, "stop");
  assert.equal(attemptLog.requestId, "req_gateway_1");
  assert.deepEqual(attemptLog.usage, { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 });
  assert.equal(fake.calls.exchange.length, 1);
});
