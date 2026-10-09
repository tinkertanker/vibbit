import assert from "node:assert/strict";
import test from "node:test";
import { runGenerationLoop } from "../../../shared/makecode-compat-core.mjs";
import {
  TkslopperHttpError,
  TkslopperProtocolError,
  TkslopperRefusalError,
  TkslopperUnavailableError,
  createAttemptBudget,
  createTkslopperClient,
  parseTkslopperConfig
} from "./tkslopper-client.mjs";

const CONTROL_PLANE_URL = "https://control.tkslopper.test";
const GATEWAY_URL = "https://gateway.tkslopper.test";
const SERVICE_CREDENTIAL = "tksvc_abcdef012345_SyntheticSecretValue0123456789";
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7E]{8,128}$/;
const OK_CODE = "basic.showIcon(IconNames.Heart)";

// Synthetic transcript and expected body from tkslopper tests/fixtures/vibbit-chat-repair.json.
const REPAIR_TRANSCRIPT = [
  { role: "system", content: "SYNTHETIC_SYSTEM: Return one JSON object with feedback and code." },
  { role: "user", content: "USER_REQUEST:\nShow a heart" },
  { role: "assistant", content: "{\"feedback\":[\"I need to correct that.\"],\"code\":\"\"}" },
  {
    role: "user",
    content: "Your previous reply had empty code. Return a complete synthetic MakeCode program as JSON only."
  }
];
const REPAIR_FIXTURE = {
  model: "text.chat.v1",
  max_tokens: 3072,
  messages: REPAIR_TRANSCRIPT,
  temperature: 0.1,
  stream: false
};

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers }
  });
}

function chatBody({ content = "hello", finishReason = "stop", refusal = null, index = 0, extraChoices = [] } = {}) {
  return {
    id: "chatcmpl_test",
    object: "chat.completion",
    created: 0,
    model: "text.chat.v1",
    choices: [
      { index, message: { role: "assistant", content, refusal }, finish_reason: finishReason },
      ...extraChoices
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
  };
}

function responsesBody({ status = "completed", output } = {}) {
  return {
    id: "resp_test",
    object: "response",
    model: "text.response.v1",
    status,
    output: output || [{
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "hello", annotations: [] }]
    }],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
  };
}

function modelJson(code = OK_CODE) {
  return JSON.stringify({ feedback: ["ok"], code });
}

function errorBody(code, requestId = "req_error") {
  return { error: { message: "synthetic", type: "error", code }, request_id: requestId };
}

/**
 * Fake control plane + gateway. `inference` is a function (callIndex, init) => Response,
 * or an array of such functions consumed in order (the last one repeats).
 */
function createFakeTkslopper({ inference, exchange, expiresIn = 900 } = {}) {
  const calls = { exchange: [], inference: [] };
  const fetchImpl = async (url, init = {}) => {
    if (url === `${CONTROL_PLANE_URL}/v1/token`) {
      calls.exchange.push({ url, init, body: JSON.parse(init.body) });
      const index = calls.exchange.length;
      if (typeof exchange === "function") return exchange(index, init);
      return jsonResponse(200, {
        grant_id: `grant_${index}`,
        access_token: `grant-token-${index}`,
        token_type: "Bearer",
        expires_in: expiresIn,
        capabilities: calls.exchange[index - 1].body.capabilities
      });
    }
    calls.inference.push({ url, init, body: JSON.parse(init.body), headers: init.headers });
    const index = calls.inference.length;
    const handler = Array.isArray(inference)
      ? inference[Math.min(index, inference.length) - 1]
      : inference;
    if (typeof handler !== "function") {
      return jsonResponse(200, chatBody({ content: modelJson() }), { "x-tkslopper-request-id": `req_${index}` });
    }
    return handler(index, init);
  };
  return { calls, fetchImpl };
}

function createClient(fake, overrides = {}) {
  const logs = [];
  const client = createTkslopperClient({
    controlPlaneUrl: CONTROL_PLANE_URL,
    gatewayUrl: GATEWAY_URL,
    serviceCredential: SERVICE_CREDENTIAL,
    endpoint: "chat",
    alias: "text.chat.v1",
    maxOutputTokens: 3072,
    grantTtlSeconds: 900,
    fetchImpl: fake.fetchImpl,
    logger: (record) => logs.push(record),
    ...overrides
  });
  return { client, logs };
}

test("chat request has the exact strict shape, headers and endpoint", async () => {
  const fake = createFakeTkslopper();
  const { client } = createClient(fake);
  const text = await client.complete({ messages: REPAIR_TRANSCRIPT });
  assert.equal(text, modelJson());

  assert.equal(fake.calls.exchange.length, 1);
  const exchange = fake.calls.exchange[0];
  assert.equal(exchange.init.method, "POST");
  assert.equal(exchange.init.redirect, "error");
  assert.equal(exchange.init.headers.Authorization, `Bearer ${SERVICE_CREDENTIAL}`);
  assert.equal(exchange.init.headers["Content-Type"], "application/json");
  assert.deepEqual(exchange.body, { capabilities: ["text.chat.v1"], ttl_seconds: 900 });

  assert.equal(fake.calls.inference.length, 1);
  const call = fake.calls.inference[0];
  assert.equal(call.url, `${GATEWAY_URL}/v1/chat/completions`);
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.redirect, "error");
  assert.deepEqual(Object.keys(call.body).sort(), ["max_tokens", "messages", "model", "stream"]);
  assert.equal(call.body.model, "text.chat.v1");
  assert.equal(call.body.max_tokens, 3072);
  assert.equal(call.body.stream, false);
  assert.deepEqual(call.body.messages, REPAIR_TRANSCRIPT);
  assert.deepEqual(call.body.messages.map((item) => item.role), ["system", "user", "assistant", "user"]);
  for (const forbidden of ["temperature", "reasoning", "reasoning_effort", "max_completion_tokens", "tools", "n", "user", "metadata"]) {
    assert.equal(forbidden in call.body, false, `${forbidden} must not be sent`);
  }

  assert.deepEqual(Object.keys(call.headers).sort(), ["Authorization", "Content-Type", "Idempotency-Key"]);
  assert.equal(call.headers.Authorization, "Bearer grant-token-1");
  assert.equal(call.headers["Content-Type"], "application/json");
  assert.match(call.headers["Idempotency-Key"], IDEMPOTENCY_KEY_PATTERN);
});

test("chat request includes temperature only when configured", async () => {
  const fake = createFakeTkslopper();
  const { client } = createClient(fake, { temperature: 0.1 });
  await client.complete({ messages: REPAIR_TRANSCRIPT });
  assert.equal(fake.calls.inference[0].body.temperature, 0.1);
  assert.deepEqual(Object.keys(fake.calls.inference[0].body).sort(), ["max_tokens", "messages", "model", "stream", "temperature"]);
});

test("fixture parity with tkslopper vibbit-chat-repair.json", async () => {
  const withTemperature = createFakeTkslopper();
  await createClient(withTemperature, { temperature: 0.1 }).client.complete({ messages: REPAIR_TRANSCRIPT });
  assert.deepEqual(withTemperature.calls.inference[0].body, REPAIR_FIXTURE);

  const withoutTemperature = createFakeTkslopper();
  await createClient(withoutTemperature).client.complete({ messages: REPAIR_TRANSCRIPT });
  const { temperature, ...expected } = REPAIR_FIXTURE;
  assert.equal(temperature, 0.1);
  assert.deepEqual(withoutTemperature.calls.inference[0].body, expected);
});

test("responses request has the equivalent strict shape", async () => {
  const fake = createFakeTkslopper({
    inference: () => jsonResponse(200, responsesBody())
  });
  const { client } = createClient(fake, { endpoint: "responses", alias: "" });
  assert.equal(client.alias, "text.response.v1");
  const text = await client.complete({ messages: REPAIR_TRANSCRIPT.slice(0, 2) });
  assert.equal(text, "hello");

  assert.deepEqual(fake.calls.exchange[0].body.capabilities, ["text.response.v1"]);
  const call = fake.calls.inference[0];
  assert.equal(call.url, `${GATEWAY_URL}/v1/responses`);
  assert.deepEqual(call.body, {
    model: "text.response.v1",
    input: REPAIR_TRANSCRIPT.slice(0, 2),
    max_output_tokens: 3072,
    stream: false
  });
  assert.match(call.headers["Idempotency-Key"], IDEMPOTENCY_KEY_PATTERN);
});

test("chat outcomes: stop returns text, truncated or incomplete return empty", async () => {
  const cases = [
    { body: chatBody({ content: "complete answer" }), expected: "complete answer" },
    { body: chatBody({ content: "" }), expected: "" },
    { body: chatBody({ content: null }), expected: "" },
    { body: chatBody({ content: "partial answer that must be dropped", finishReason: "length" }), expected: "" },
    { body: chatBody({ content: "partial", finishReason: null }), expected: "" }
  ];
  for (const { body, expected } of cases) {
    const fake = createFakeTkslopper({ inference: () => jsonResponse(200, body) });
    const { client } = createClient(fake);
    assert.equal(await client.complete({ messages: REPAIR_TRANSCRIPT }), expected);
  }
});

test("chat outcomes: content_filter or refusal throw a refusal error", async () => {
  for (const body of [
    chatBody({ content: null, finishReason: "content_filter" }),
    chatBody({ content: null, refusal: "I cannot help with that." })
  ]) {
    const fake = createFakeTkslopper({ inference: () => jsonResponse(200, body) });
    const { client } = createClient(fake);
    await assert.rejects(client.complete({ messages: REPAIR_TRANSCRIPT }), TkslopperRefusalError);
    assert.equal(fake.calls.inference.length, 1);
  }
});

test("chat outcomes: malformed bodies throw a protocol error", async () => {
  const noIndexZero = chatBody();
  noIndexZero.choices[0].index = 1;
  const missingRefusal = chatBody();
  delete missingRefusal.choices[0].message.refusal;
  const cases = [
    () => jsonResponse(200, noIndexZero),
    () => jsonResponse(200, chatBody({
      extraChoices: [{ index: 0, message: { role: "assistant", content: "x", refusal: null }, finish_reason: "stop" }]
    })),
    () => jsonResponse(200, chatBody({ finishReason: "tool_calls" })),
    () => jsonResponse(200, missingRefusal),
    () => jsonResponse(200, { choices: "nope" }),
    () => new Response("not json", { status: 200 })
  ];
  for (const inference of cases) {
    const fake = createFakeTkslopper({ inference });
    const { client } = createClient(fake);
    await assert.rejects(client.complete({ messages: REPAIR_TRANSCRIPT }), TkslopperProtocolError);
    assert.equal(fake.calls.inference.length, 1);
  }
});

test("responses outcomes: completed, incomplete, refusal and reasoning items", async () => {
  const run = async (body) => {
    const fake = createFakeTkslopper({ inference: () => jsonResponse(200, body) });
    const { client } = createClient(fake, { endpoint: "responses", alias: "text.response.v1" });
    return client.complete({ messages: REPAIR_TRANSCRIPT });
  };

  assert.equal(await run(responsesBody()), "hello");
  assert.equal(await run(responsesBody({
    output: [
      { id: "rs_1", type: "reasoning", summary: [{ type: "summary_text", text: "private reasoning" }] },
      {
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [
          { type: "output_text", text: "part one, ", annotations: [] },
          { type: "output_text", text: "part two", annotations: [] }
        ]
      }
    ]
  })), "part one, part two");
  assert.equal(await run(responsesBody({ status: "incomplete" })), "");
  assert.equal(await run(responsesBody({ status: "failed" })), "");
  assert.equal(await run(responsesBody({
    output: [{ id: "msg_1", type: "message", role: "assistant", content: [{ type: "output_text", text: "", annotations: [] }] }]
  })), "");
  await assert.rejects(run(responsesBody({
    output: [{ id: "msg_1", type: "message", role: "assistant", content: [{ type: "refusal", refusal: "No." }] }]
  })), TkslopperRefusalError);
  await assert.rejects(run({ output_text: "top-level only" }), TkslopperProtocolError);
  await assert.rejects(run(responsesBody({
    output: [{ id: "fc_1", type: "function_call" }]
  })), TkslopperProtocolError);
});

test("idempotency: every physical request in a 3-attempt repair loop has a distinct key", async () => {
  const fake = createFakeTkslopper({
    inference: [
      () => jsonResponse(200, chatBody({ content: "partial", finishReason: "length" })),
      () => jsonResponse(200, chatBody({ content: null, finishReason: null })),
      () => jsonResponse(200, chatBody({ content: modelJson() }))
    ]
  });
  const { client } = createClient(fake);
  const result = await runGenerationLoop({
    target: "microbit",
    systemPrompt: "SYNTHETIC_SYSTEM",
    initialUserPrompt: "USER_REQUEST:\nShow a heart",
    emptyRetries: 2,
    validationRetries: 0,
    maxAttempts: 3,
    callModel: (messages) => client.complete({ messages })
  });
  assert.equal(result.code, OK_CODE);
  assert.equal(fake.calls.inference.length, 3);
  assert.equal(fake.calls.exchange.length, 1);
  const keys = fake.calls.inference.map((call) => call.headers["Idempotency-Key"]);
  assert.equal(new Set(keys).size, 3);
  for (const key of keys) assert.match(key, IDEMPOTENCY_KEY_PATTERN);
  assert.deepEqual(
    fake.calls.inference.map((call) => call.body.messages.map((item) => item.role).join(",")),
    [
      "system,user",
      "system,user,assistant,user",
      "system,user,assistant,user,assistant,user"
    ]
  );
});

test("grants: one exchange serves many calls", async () => {
  const fake = createFakeTkslopper();
  const { client } = createClient(fake);
  for (let i = 0; i < 4; i += 1) {
    await client.complete({ messages: REPAIR_TRANSCRIPT });
  }
  assert.equal(fake.calls.exchange.length, 1);
  assert.equal(fake.calls.inference.length, 4);
  assert.ok(fake.calls.inference.every((call) => call.headers.Authorization === "Bearer grant-token-1"));
});

test("grants: refresh happens once fewer than 60 seconds remain", async () => {
  let clock = 1_000_000;
  const fake = createFakeTkslopper({ expiresIn: 300 });
  const { client } = createClient(fake, { now: () => clock });
  await client.complete({ messages: REPAIR_TRANSCRIPT });
  clock += 239_000; // 61 s left
  await client.complete({ messages: REPAIR_TRANSCRIPT });
  assert.equal(fake.calls.exchange.length, 1);
  clock += 2_000; // 59 s left
  await client.complete({ messages: REPAIR_TRANSCRIPT });
  assert.equal(fake.calls.exchange.length, 2);
  assert.equal(fake.calls.inference[2].headers.Authorization, "Bearer grant-token-2");
});

test("grants: concurrent calls share a single in-flight exchange", async () => {
  let releaseExchange;
  const gate = new Promise((resolve) => { releaseExchange = resolve; });
  const fake = createFakeTkslopper({
    exchange: async (index) => {
      await gate;
      return jsonResponse(200, {
        grant_id: `grant_${index}`,
        access_token: `grant-token-${index}`,
        token_type: "Bearer",
        expires_in: 900,
        capabilities: ["text.chat.v1"]
      });
    }
  });
  const { client } = createClient(fake);
  const pending = Array.from({ length: 5 }, () => client.complete({ messages: REPAIR_TRANSCRIPT }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  releaseExchange();
  await Promise.all(pending);
  assert.equal(fake.calls.exchange.length, 1);
  assert.equal(fake.calls.inference.length, 5);
  assert.equal(new Set(fake.calls.inference.map((call) => call.headers["Idempotency-Key"])).size, 5);
});

test("grants: gateway 401 or 403 re-exchanges once and resends once with a new key", async () => {
  for (const status of [401, 403]) {
    const fake = createFakeTkslopper({
      inference: [
        () => jsonResponse(status, errorBody(status === 401 ? "authentication_failed" : "authorization_failed")),
        () => jsonResponse(200, chatBody({ content: "after refresh" }))
      ]
    });
    const { client } = createClient(fake);
    assert.equal(await client.complete({ messages: REPAIR_TRANSCRIPT }), "after refresh");
    assert.equal(fake.calls.exchange.length, 2);
    assert.equal(fake.calls.inference.length, 2);
    assert.equal(fake.calls.inference[0].headers.Authorization, "Bearer grant-token-1");
    assert.equal(fake.calls.inference[1].headers.Authorization, "Bearer grant-token-2");
    assert.notEqual(
      fake.calls.inference[0].headers["Idempotency-Key"],
      fake.calls.inference[1].headers["Idempotency-Key"]
    );
  }
});

test("grants: repeated gateway rejection stops as unavailable", async () => {
  const fake = createFakeTkslopper({
    inference: () => jsonResponse(403, errorBody("authorization_failed"))
  });
  const { client } = createClient(fake);
  await assert.rejects(client.complete({ messages: REPAIR_TRANSCRIPT }), TkslopperUnavailableError);
  assert.equal(fake.calls.exchange.length, 2);
  assert.equal(fake.calls.inference.length, 2);
});

test("grants: re-exchange failure after a gateway 401 stops as unavailable", async () => {
  const fake = createFakeTkslopper({
    inference: () => jsonResponse(401, errorBody("authentication_failed")),
    exchange: (index) => (index === 1
      ? jsonResponse(200, { grant_id: "g1", access_token: "grant-token-1", token_type: "Bearer", expires_in: 900, capabilities: ["text.chat.v1"] })
      : jsonResponse(403, errorBody("authorization_failed")))
  });
  const { client } = createClient(fake);
  await assert.rejects(client.complete({ messages: REPAIR_TRANSCRIPT }), TkslopperUnavailableError);
  assert.equal(fake.calls.exchange.length, 2);
  assert.equal(fake.calls.inference.length, 1);
});

test("grants: exchange 401 or 403 surfaces as unavailable without inference", async () => {
  for (const status of [401, 403]) {
    const fake = createFakeTkslopper({
      exchange: () => jsonResponse(status, errorBody(status === 401 ? "authentication_failed" : "authorization_failed"))
    });
    const { client } = createClient(fake);
    await assert.rejects(client.complete({ messages: REPAIR_TRANSCRIPT }), (error) => {
      assert.ok(error instanceof TkslopperUnavailableError);
      assert.equal(error.status, status);
      assert.equal(error.phase, "exchange");
      return true;
    });
    assert.equal(fake.calls.exchange.length, 1);
    assert.equal(fake.calls.inference.length, 0);
  }
});

test("no retry: gateway failures and network errors make exactly one request", async () => {
  const codes = {
    400: "invalid_request",
    402: "budget_exceeded",
    409: "conflict",
    413: "invalid_request",
    415: "invalid_request",
    429: "rate_limit_exceeded",
    500: "internal_error",
    502: "provider_unavailable",
    503: "provider_unavailable",
    504: "provider_unavailable"
  };
  for (const [statusText, code] of Object.entries(codes)) {
    const status = Number(statusText);
    const fake = createFakeTkslopper({
      inference: () => jsonResponse(status, errorBody(code, `req_${status}`), { "x-tkslopper-request-id": `req_${status}` })
    });
    const { client, logs } = createClient(fake);
    await assert.rejects(client.complete({ messages: REPAIR_TRANSCRIPT }), (error) => {
      assert.ok(error instanceof TkslopperHttpError);
      assert.equal(error instanceof TkslopperUnavailableError, false);
      assert.equal(error.status, status);
      assert.equal(error.code, code);
      assert.equal(error.requestId, `req_${status}`);
      assert.equal(error.retryable, false);
      if (status === 402 || status === 429) assert.equal(error.retryAfterSeconds, 30);
      return true;
    });
    assert.equal(fake.calls.inference.length, 1, `HTTP ${status} must not be retried`);
    assert.equal(fake.calls.exchange.length, 1);
    assert.ok(logs.some((record) => record.status === status && record.requestId === `req_${status}`));
  }

  const networkFake = createFakeTkslopper({
    inference: () => { throw new TypeError("fetch failed"); }
  });
  const { client } = createClient(networkFake);
  await assert.rejects(client.complete({ messages: REPAIR_TRANSCRIPT }), (error) => {
    assert.ok(error instanceof TkslopperHttpError);
    assert.equal(error.status, 0);
    return true;
  });
  assert.equal(networkFake.calls.inference.length, 1);
});

test("no retry: a Retry-After header is honoured on 429", async () => {
  const fake = createFakeTkslopper({
    inference: () => jsonResponse(429, errorBody("rate_limit_exceeded"), { "Retry-After": "12" })
  });
  const { client } = createClient(fake);
  await assert.rejects(client.complete({ messages: REPAIR_TRANSCRIPT }), (error) => {
    assert.equal(error.retryAfterSeconds, 12);
    return true;
  });
});

test("no retry: a Vibbit-side abort propagates as AbortError after one request", async () => {
  const controller = new AbortController();
  const fake = createFakeTkslopper({
    inference: (_index, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
      setTimeout(() => controller.abort(), 5);
    })
  });
  const { client } = createClient(fake);
  await assert.rejects(client.complete({ messages: REPAIR_TRANSCRIPT, signal: controller.signal }), { name: "AbortError" });
  assert.equal(fake.calls.inference.length, 1);
});

test("budget: attempts get min(attempt timeout, remaining budget) and stop below the minimum", () => {
  let clock = 0;
  const budget = createAttemptBudget({
    attemptTimeoutMs: 45000,
    totalBudgetMs: 55000,
    minAttemptMs: 10000,
    now: () => clock
  });
  assert.equal(budget.nextAttemptTimeoutMs(), 45000);
  clock = 30000;
  assert.equal(budget.nextAttemptTimeoutMs(), 25000);
  clock = 45000;
  assert.equal(budget.nextAttemptTimeoutMs(), 10000);
  clock = 45001;
  assert.throws(() => budget.nextAttemptTimeoutMs(), { name: "AbortError" });
});

test("secrets: credential and grant never appear in logs or thrown messages", async () => {
  const scenarios = [
    { inference: () => jsonResponse(200, chatBody({ content: "ok" }), { "x-tkslopper-request-id": "req_visible" }) },
    { inference: () => jsonResponse(500, errorBody("internal_error")) },
    { inference: () => jsonResponse(401, errorBody("authentication_failed")) },
    { exchange: () => jsonResponse(401, errorBody("authentication_failed")) },
    { inference: () => jsonResponse(200, chatBody({ refusal: "no" })) }
  ];
  const allLogs = [];
  const messages = [];
  for (const scenario of scenarios) {
    const fake = createFakeTkslopper(scenario);
    const { client, logs } = createClient(fake);
    try {
      await client.complete({ messages: REPAIR_TRANSCRIPT, context: { classroomId: "cls_1", attempt: 1 } });
    } catch (error) {
      messages.push(String(error && error.message), JSON.stringify(error), String(error && error.stack));
    }
    allLogs.push(...logs);
  }
  const serialisedLogs = JSON.stringify(allLogs);
  for (const secret of [SERVICE_CREDENTIAL, "grant-token-1", "grant-token-2"]) {
    assert.equal(serialisedLogs.includes(secret), false);
    assert.ok(messages.every((message) => !message.includes(secret)));
  }
  // Prompts and responses are never logged either.
  assert.equal(serialisedLogs.includes("SYNTHETIC_SYSTEM"), false);
  assert.equal(serialisedLogs.includes("Show a heart"), false);
  const success = allLogs.find((record) => record.requestId === "req_visible");
  assert.ok(success);
  assert.equal(success.classroomId, "cls_1");
  assert.equal(success.attempt, 1);
  assert.equal(success.status, 200);
  assert.equal(success.outcome, "stop");
  assert.deepEqual(success.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
});

test("config: disabled by default and ignores other settings", () => {
  assert.deepEqual(parseTkslopperConfig({}), { enabled: false });
  assert.deepEqual(parseTkslopperConfig({
    VIBBIT_TKSLOPPER_ENABLED: "false",
    VIBBIT_TKSLOPPER_GATEWAY_URL: "not a url"
  }), { enabled: false });
});

test("config: validates URLs, credential, endpoint, alias and numbers without echoing values", () => {
  const valid = {
    VIBBIT_TKSLOPPER_ENABLED: "true",
    VIBBIT_TKSLOPPER_CONTROL_PLANE_URL: CONTROL_PLANE_URL,
    VIBBIT_TKSLOPPER_GATEWAY_URL: `${GATEWAY_URL}/`,
    VIBBIT_TKSLOPPER_SERVICE_CREDENTIAL: SERVICE_CREDENTIAL,
    VIBBIT_TKSLOPPER_CLASSROOM_IDS: "cls_a, cls_b"
  };
  const config = parseTkslopperConfig(valid, { isHosted: true });
  assert.equal(config.enabled, true);
  assert.equal(config.gatewayUrl, GATEWAY_URL);
  assert.equal(config.endpoint, "chat");
  assert.equal(config.alias, "text.chat.v1");
  assert.equal(config.maxOutputTokens, 3072);
  assert.equal(config.temperature, null);
  assert.equal(config.grantTtlSeconds, 900);
  assert.equal(config.totalBudgetMs, 55000);
  assert.equal(config.minAttemptMs, 10000);
  assert.deepEqual(config.classroomIds, ["cls_a", "cls_b"]);
  assert.equal(config.serviceCredential, SERVICE_CREDENTIAL);
  assert.equal(JSON.stringify(config).includes(SERVICE_CREDENTIAL), false);

  assert.equal(parseTkslopperConfig({ ...valid, VIBBIT_TKSLOPPER_ENDPOINT: "responses" }).alias, "text.response.v1");
  assert.equal(parseTkslopperConfig({ ...valid, VIBBIT_TKSLOPPER_CLASSROOM_IDS: "*" }).allClassrooms, true);
  assert.equal(parseTkslopperConfig({ ...valid, VIBBIT_TKSLOPPER_TEMPERATURE: "0.1" }).temperature, 0.1);
  assert.equal(
    parseTkslopperConfig({ ...valid, VIBBIT_TKSLOPPER_CONTROL_PLANE_URL: "http://localhost:8788" }).controlPlaneUrl,
    "http://localhost:8788"
  );

  const invalid = [
    { VIBBIT_TKSLOPPER_GATEWAY_URL: "" },
    { VIBBIT_TKSLOPPER_CONTROL_PLANE_URL: "" },
    { VIBBIT_TKSLOPPER_SERVICE_CREDENTIAL: "" },
    { VIBBIT_TKSLOPPER_SERVICE_CREDENTIAL: "tkgk_group_key_is_not_a_service_credential" },
    { VIBBIT_TKSLOPPER_GATEWAY_URL: "https://user:pass@gateway.tkslopper.test" },
    { VIBBIT_TKSLOPPER_GATEWAY_URL: "https://gateway.tkslopper.test/?key=secret" },
    { VIBBIT_TKSLOPPER_GATEWAY_URL: "ftp://gateway.tkslopper.test" },
    { VIBBIT_TKSLOPPER_ENDPOINT: "embeddings" },
    { VIBBIT_TKSLOPPER_ALIAS: "gpt-4o-mini" },
    { VIBBIT_TKSLOPPER_ALIAS: "text.chat" },
    { VIBBIT_TKSLOPPER_MAX_OUTPUT_TOKENS: "lots" },
    { VIBBIT_TKSLOPPER_TEMPERATURE: "3" },
    { VIBBIT_TKSLOPPER_GRANT_TTL_SECONDS: "30" },
    { VIBBIT_TKSLOPPER_MIN_ATTEMPT_MS: "60000" }
  ];
  for (const override of invalid) {
    const env = { ...valid, ...override };
    assert.throws(() => parseTkslopperConfig(env), (error) => {
      assert.equal(error.message.includes(SERVICE_CREDENTIAL), false);
      assert.equal(error.message.includes("key=secret"), false);
      assert.equal(error.message.includes("pass@"), false);
      return true;
    }, JSON.stringify(Object.keys(override)));
  }

  assert.throws(
    () => parseTkslopperConfig({ ...valid, VIBBIT_TKSLOPPER_GATEWAY_URL: "http://gateway.tkslopper.test" }, { isHosted: true }),
    /VIBBIT_TKSLOPPER_GATEWAY_URL must use https in hosted mode/
  );
});

function abortError() {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

// A 200/401 whose body never finishes until the request signal aborts.
function stalledBodyResponse(status, signal) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(),
    text: () => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(abortError()), { once: true });
    })
  };
}

test("abort: an already-aborted signal starts no exchange and no request", async () => {
  const fake = createFakeTkslopper();
  const { client } = createClient(fake);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(client.complete({ messages: REPAIR_TRANSCRIPT, signal: controller.signal }), { name: "AbortError" });
  assert.equal(fake.calls.exchange.length, 0);
  assert.equal(fake.calls.inference.length, 0);
});

test("abort: timeout during a 401 body read never leaves an unhandled rejection", async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const controller = new AbortController();
    const fake = createFakeTkslopper({
      inference: (_index, init) => {
        setTimeout(() => controller.abort(), 5);
        return stalledBodyResponse(401, init.signal);
      },
      exchange: (index) => (index === 1
        ? jsonResponse(200, { grant_id: "g1", access_token: "grant-token-1", token_type: "Bearer", expires_in: 900, capabilities: ["text.chat.v1"] })
        : jsonResponse(403, errorBody("authorization_failed")))
    });
    const { client } = createClient(fake);
    await assert.rejects(client.complete({ messages: REPAIR_TRANSCRIPT, signal: controller.signal }), { name: "AbortError" });
    // A later caller may still trigger the failing exchange; it must reject to that caller only.
    await assert.rejects(client.complete({ messages: REPAIR_TRANSCRIPT }), TkslopperUnavailableError);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(unhandled, []);
    assert.equal(fake.calls.inference.length, 1);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("abort: a caller that stops waiting leaves no unhandled rejection when the exchange fails", async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const controller = new AbortController();
    const fake = createFakeTkslopper({
      exchange: () => new Promise((resolve) => {
        setTimeout(() => resolve(jsonResponse(403, errorBody("authorization_failed"))), 20);
      })
    });
    const { client } = createClient(fake);
    setTimeout(() => controller.abort(), 5);
    await assert.rejects(client.complete({ messages: REPAIR_TRANSCRIPT, signal: controller.signal }), { name: "AbortError" });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepEqual(unhandled, []);
    assert.equal(fake.calls.inference.length, 0);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("abort: a timeout while the answer downloads is an AbortError, not a protocol error", async () => {
  const controller = new AbortController();
  const fake = createFakeTkslopper({
    inference: (_index, init) => {
      setTimeout(() => controller.abort(), 5);
      return stalledBodyResponse(200, init.signal);
    }
  });
  const { client, logs } = createClient(fake);
  await assert.rejects(client.complete({
    messages: REPAIR_TRANSCRIPT,
    signal: controller.signal,
    context: { classroomId: "cls_1", attempt: 2 }
  }), { name: "AbortError" });
  assert.equal(fake.calls.inference.length, 1);
  const timeoutLog = logs.find((record) => record.event === "tkslopper.inference");
  assert.deepEqual(
    { status: timeoutLog.status, outcome: timeoutLog.outcome, classroomId: timeoutLog.classroomId, attempt: timeoutLog.attempt },
    { status: 200, outcome: "timeout", classroomId: "cls_1", attempt: 2 }
  );
});

test("grants: a stalled exchange body times out instead of pinning the shared exchange", async () => {
  const fake = createFakeTkslopper({
    exchange: (index, init) => (index === 1
      ? stalledBodyResponse(200, init.signal)
      : jsonResponse(200, { grant_id: "g2", access_token: "grant-token-2", token_type: "Bearer", expires_in: 900, capabilities: ["text.chat.v1"] }))
  });
  const { client } = createClient(fake, { exchangeTimeoutMs: 30 });
  await assert.rejects(client.complete({ messages: REPAIR_TRANSCRIPT }), (error) => {
    assert.ok(error instanceof TkslopperUnavailableError);
    assert.equal(error.status, 0);
    assert.equal(error.code, "exchange_timeout");
    return true;
  });
  assert.equal(await client.complete({ messages: REPAIR_TRANSCRIPT }), modelJson());
  assert.equal(fake.calls.exchange.length, 2);
});

test("grants: invalid grant bodies surface as unavailable without inference", async () => {
  const bodies = [
    { access_token: "", expires_in: 900 },
    { access_token: "grant-token-x", expires_in: 0 },
    { access_token: "grant-token-x" },
    { expires_in: 900 }
  ];
  for (const body of bodies) {
    const fake = createFakeTkslopper({ exchange: () => jsonResponse(200, body) });
    const { client } = createClient(fake);
    await assert.rejects(client.complete({ messages: REPAIR_TRANSCRIPT }), TkslopperUnavailableError);
    assert.equal(fake.calls.inference.length, 0);
  }
  const nonJson = createFakeTkslopper({ exchange: () => new Response("<html>", { status: 200 }) });
  await assert.rejects(createClient(nonJson).client.complete({ messages: REPAIR_TRANSCRIPT }), TkslopperUnavailableError);
});

test("grants: a short-lived grant is still reused for half its lifetime", async () => {
  let clock = 5_000_000;
  const fake = createFakeTkslopper({ expiresIn: 60 });
  const { client } = createClient(fake, { now: () => clock });
  await client.complete({ messages: REPAIR_TRANSCRIPT });
  clock += 20_000;
  await client.complete({ messages: REPAIR_TRANSCRIPT });
  assert.equal(fake.calls.exchange.length, 1);
  clock += 11_000;
  await client.complete({ messages: REPAIR_TRANSCRIPT });
  assert.equal(fake.calls.exchange.length, 2);
});

test("grants: a grant rejected on the resend is not reused by the next request", async () => {
  const fake = createFakeTkslopper({
    inference: [
      () => jsonResponse(401, errorBody("authentication_failed")),
      () => jsonResponse(401, errorBody("authentication_failed")),
      () => gatewayOk()
    ]
  });
  const { client } = createClient(fake);
  await assert.rejects(client.complete({ messages: REPAIR_TRANSCRIPT }), TkslopperUnavailableError);
  await client.complete({ messages: REPAIR_TRANSCRIPT });
  assert.equal(fake.calls.exchange.length, 3);
  assert.equal(fake.calls.inference[2].headers.Authorization, "Bearer grant-token-3");
});

function gatewayOk() {
  return jsonResponse(200, chatBody({ content: modelJson() }));
}

test("responses: temperature is never sent and is rejected in config", async () => {
  const fake = createFakeTkslopper({ inference: () => jsonResponse(200, responsesBody()) });
  const { client } = createClient(fake, { endpoint: "responses", alias: "text.response.v1", temperature: 0.5 });
  await client.complete({ messages: REPAIR_TRANSCRIPT });
  assert.equal("temperature" in fake.calls.inference[0].body, false);
  assert.throws(() => parseTkslopperConfig({
    VIBBIT_TKSLOPPER_ENABLED: "true",
    VIBBIT_TKSLOPPER_CONTROL_PLANE_URL: CONTROL_PLANE_URL,
    VIBBIT_TKSLOPPER_GATEWAY_URL: GATEWAY_URL,
    VIBBIT_TKSLOPPER_SERVICE_CREDENTIAL: SERVICE_CREDENTIAL,
    VIBBIT_TKSLOPPER_ENDPOINT: "responses",
    VIBBIT_TKSLOPPER_TEMPERATURE: "0.5"
  }), /chat endpoint only/);
});

test("config: base URLs that already end in /v1 are rejected", () => {
  for (const key of ["VIBBIT_TKSLOPPER_CONTROL_PLANE_URL", "VIBBIT_TKSLOPPER_GATEWAY_URL"]) {
    assert.throws(() => parseTkslopperConfig({
      VIBBIT_TKSLOPPER_ENABLED: "true",
      VIBBIT_TKSLOPPER_CONTROL_PLANE_URL: CONTROL_PLANE_URL,
      VIBBIT_TKSLOPPER_GATEWAY_URL: GATEWAY_URL,
      VIBBIT_TKSLOPPER_SERVICE_CREDENTIAL: SERVICE_CREDENTIAL,
      [key]: "https://host.tkslopper.test/v1/"
    }), /without \/v1/);
  }
});

test("no retry: an HTTP-date Retry-After uses the injected clock", async () => {
  const clock = Date.parse("2026-09-30T00:00:00Z");
  const fake = createFakeTkslopper({
    inference: () => jsonResponse(429, errorBody("rate_limit_exceeded"), { "Retry-After": "Wed, 30 Sep 2026 00:00:45 GMT" })
  });
  const { client } = createClient(fake, { now: () => clock });
  await assert.rejects(client.complete({ messages: REPAIR_TRANSCRIPT }), (error) => {
    assert.equal(error.retryAfterSeconds, 45);
    return true;
  });
});

test("abort: an error status keeps its mapping when its body read is cut off", async () => {
  const controller = new AbortController();
  const fake = createFakeTkslopper({
    inference: (_index, init) => {
      setTimeout(() => controller.abort(), 5);
      return stalledBodyResponse(429, init.signal);
    }
  });
  const { client } = createClient(fake);
  await assert.rejects(client.complete({ messages: REPAIR_TRANSCRIPT, signal: controller.signal }), (error) => {
    assert.ok(error instanceof TkslopperHttpError);
    assert.equal(error.status, 429);
    assert.equal(error.retryAfterSeconds, 30);
    return true;
  });
});

test("abort: a fully downloaded answer is kept even if the timer fires just after", async () => {
  const controller = new AbortController();
  const fake = createFakeTkslopper({
    inference: () => ({
      status: 200,
      ok: true,
      headers: new Headers(),
      text: async () => {
        controller.abort();
        return JSON.stringify(chatBody({ content: "paid answer" }));
      }
    })
  });
  const { client } = createClient(fake);
  assert.equal(await client.complete({ messages: REPAIR_TRANSCRIPT, signal: controller.signal }), "paid answer");
});

test("managed model metadata is credential-scoped, projected, uncached and never changes the inference alias", async () => {
  let metadata = { display_name: "Classroom Claude", provider: "anthropic", tier: "economy", endpoint: "https://evil.test" };
  const makeClient = (credential) => createTkslopperClient({
    controlPlaneUrl: CONTROL_PLANE_URL, gatewayUrl: GATEWAY_URL, serviceCredential: credential, alias: "text.chat.v1",
    fetchImpl: async (url, init) => {
      if (url.endsWith("/token")) {
        assert.equal(init.headers.Authorization, `Bearer ${credential}`);
        return Response.json({ access_token: `grant-${credential}`, expires_in: 900 });
      }
      assert.equal(init.headers.Authorization, `Bearer grant-${credential}`);
      if (url.endsWith("/models")) {
        assert.equal(init.cache, "no-store");
        assert.equal(init.credentials, "omit");
        return Response.json({ object: "list", data: [
          { id: "other.alias.v1", display_name: "Wrong model" }, { id: "text.chat.v1", ...metadata }
        ] });
      }
      const body = JSON.parse(init.body);
      assert.equal(body.model, "text.chat.v1");
      assert.equal(body.temperature, undefined);
      return Response.json(chatBody());
    }
  });
  const a = makeClient("credential-a");
  assert.deepEqual(await a.getModelMetadata(), { id: "text.chat.v1", display_name: "Classroom Claude", provider: "anthropic", tier: "economy" });
  metadata = {}; // Old server, or metadata removed from an existing route.
  assert.deepEqual(await a.getModelMetadata(), { id: "text.chat.v1" });
  const b = makeClient("credential-b");
  assert.deepEqual(await b.getModelMetadata(), { id: "text.chat.v1" });
  assert.equal(await a.complete({ messages: REPAIR_TRANSCRIPT }), "hello");
});

test("managed metadata failures, invalid fields and oversized responses fall back to configured alias", async () => {
  for (const response of [
    () => Response.json({ object: "list", data: [{ id: "text.chat.v1", display_name: "bad\nlabel", provider: "unknown", tier: "unknown" }] }),
    () => Response.json({ object: "list", data: [{ id: "another.v1", display_name: "Not ours" }] }),
    () => new Response("x".repeat(131073)),
    () => new Response("", { status: 404 }),
    () => { throw new Error("offline"); }
  ]) {
    const client = createTkslopperClient({ controlPlaneUrl: CONTROL_PLANE_URL, gatewayUrl: GATEWAY_URL, alias: "text.chat.v1",
      fetchImpl: async (url) => url.endsWith("/token") ? Response.json({ access_token: "fixture-grant", expires_in: 900 }) : response()
    });
    assert.deepEqual(await client.getModelMetadata(), { id: "text.chat.v1" });
  }
});
