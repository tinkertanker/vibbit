import assert from "node:assert/strict";
import test from "node:test";
import { createBackendRuntime } from "./runtime.mjs";

function createRuntime() {
  return createBackendRuntime({
    env: {
      VIBBIT_CLASSROOM_ENABLED: "false",
      SERVER_APP_TOKEN: ""
    }
  });
}

async function fetchRuntime(pathname) {
  const runtime = createRuntime();
  return runtime.fetch(new Request(`https://example.test${pathname}`));
}

test("Anthropic never inherits the generic provider key", async () => {
  const runtime = createBackendRuntime({ env: { VIBBIT_API_KEY: "generic-fixture", VIBBIT_ADMIN_TOKEN: "fixture-admin" } });
  const response = await runtime.fetch(new Request("https://example.test/admin/status", { headers: { "X-Vibbit-Admin-Token": "fixture-admin" } }));
  const status = await response.json();
  assert.equal(status.providerKeyConfigured.openai, true);
  assert.equal(status.providerKeyConfigured.anthropic, false);
});

test("serves favicon svg for root and /api-prefixed requests", async () => {
  for (const pathname of ["/favicon.svg", "/api/favicon.svg"]) {
    const response = await fetchRuntime(pathname);
    assert.equal(response.status, 200);
    assert.match(String(response.headers.get("content-type") || ""), /^image\/svg\+xml/);
    const body = await response.text();
    assert.match(body, /<svg[\s>]/i);
  }
});

test("redirects favicon ico requests to the matching svg path", async () => {
  const cases = [
    { pathname: "/favicon.ico", expectedLocation: "/favicon.svg" },
    { pathname: "/api/favicon.ico", expectedLocation: "/api/favicon.svg" }
  ];

  for (const { pathname, expectedLocation } of cases) {
    const response = await fetchRuntime(pathname);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), expectedLocation);
  }
});

test("renders relative favicon links on html pages for prefix-safe resolution", async () => {
  const pages = ["/", "/bookmarklet", "/admin", "/teacher", "/api/bookmarklet", "/api/admin", "/api/teacher"];

  for (const pathname of pages) {
    const response = await fetchRuntime(pathname);
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /href="favicon\.svg"/);
    assert.doesNotMatch(body, /href="\/favicon\.svg"/);
  }
});

test("legacy classroom connect returns public server config fields", async () => {
  const runtime = createBackendRuntime({
    env: {
      VIBBIT_DEPLOYMENT_MODE: "self-hosted",
      VIBBIT_CLASSROOM_ENABLED: "true",
      VIBBIT_CLASSROOM_CODE: "LEGACY",
      VIBBIT_CLASSROOM_CODE_AUTO: "false",
      VIBBIT_TEACHER_DEV_LOGIN: "true",
      VIBBIT_OPENAI_API_KEY: "server-fallback-key",
      VIBBIT_PROVIDER: "openai",
      VIBBIT_MODEL: "gpt-4o-mini"
    },
    teacherPortalState: {},
    persistTeacherPortalState: async () => {},
    dnsLookup: async () => [{ address: "203.0.113.10", family: 4 }]
  });

  const connect = await runtime.fetch(new Request("https://example.test/vibbit/connect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ classCode: "LEGACY" })
  }));
  assert.equal(connect.status, 200);
  const body = await connect.json();
  assert.equal(body.ok, true);
  assert.equal(body.authMode, "classroom");
  assert.equal(body.classCodeRequired, true);
  assert.equal(body.defaultProvider, "openai");
  assert.equal(body.defaultModel, "gpt-4o-mini");
  assert.equal(typeof body.sessionToken, "string");
  assert.ok(body.sessionToken.length > 0);
  assert.equal(typeof body.defaultModelFor, "undefined");
  assert.equal(typeof body.apiKeyFor, "undefined");
});

test("generate accepts empty request when pageErrors are present", async () => {
  const runtime = createBackendRuntime({
    env: {
      VIBBIT_DEPLOYMENT_MODE: "self-hosted",
      VIBBIT_CLASSROOM_ENABLED: "true",
      VIBBIT_CLASSROOM_CODE: "LEGACY",
      VIBBIT_CLASSROOM_CODE_AUTO: "false",
      VIBBIT_TEACHER_DEV_LOGIN: "true",
      VIBBIT_OPENAI_API_KEY: "server-fallback-key",
      VIBBIT_PROVIDER: "openai",
      VIBBIT_MODEL: "gpt-4o-mini"
    },
    teacherPortalState: {},
    persistTeacherPortalState: async () => {},
    dnsLookup: async () => [{ address: "203.0.113.10", family: 4 }]
  });

  const connect = await runtime.fetch(new Request("https://example.test/vibbit/connect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ classCode: "LEGACY" })
  }));
  assert.equal(connect.status, 200);
  const { sessionToken } = await connect.json();

  const originalFetch = globalThis.fetch;
  let capturedProviderBody = "";
  globalThis.fetch = async (_url, init = {}) => {
    capturedProviderBody = String(init.body || "");
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            feedback: ["fixed"],
            code: "basic.showIcon(IconNames.Heart)"
          })
        }
      }]
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  try {
    const generate = await runtime.fetch(new Request("https://example.test/vibbit/generate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sessionToken}`
      },
      body: JSON.stringify({
        target: "microbit",
        request: "",
        pageErrors: ["Type 'foo' is not defined"]
      })
    }));
    assert.equal(generate.status, 200);
    assert.match(capturedProviderBody, /Type 'foo' is not defined/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function mockChatCompletion(code, feedback = ["ok"]) {
  return new Response(JSON.stringify({
    choices: [{
      message: {
        content: JSON.stringify({ feedback, code })
      }
    }]
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

test("generate retries invalid output through a transcript that includes FAILED_ATTEMPT", async () => {
  const runtime = createBackendRuntime({
    env: {
      VIBBIT_CLASSROOM_ENABLED: "false",
      SERVER_APP_TOKEN: "",
      VIBBIT_OPENAI_API_KEY: "test-key",
      VIBBIT_PROVIDER: "openai",
      VIBBIT_MODEL: "gpt-4o-mini"
    },
    dnsLookup: async () => [{ address: "203.0.113.10", family: 4 }]
  });

  const failedCode = "input.onButtonPressed(Button.A, () => { basic.showIcon(IconNames.Heart) })";
  const okCode = "basic.showIcon(IconNames.Heart)";
  const requestBodies = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init = {}) => {
    requestBodies.push(String(init.body || ""));
    if (requestBodies.length === 1) {
      return mockChatCompletion(failedCode, ["arrow"]);
    }
    return mockChatCompletion(okCode, ["fixed"]);
  };

  try {
    const generate = await runtime.fetch(new Request("https://example.test/vibbit/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target: "microbit",
        request: "Show a heart"
      })
    }));
    const body = await generate.json();
    assert.equal(generate.status, 200, body && body.error ? body.error : "generate failed");
    assert.equal(body.outcome, "ok");
    assert.equal(body.upstreamAttempts, 2);
    assert.equal(body.validationOk, true);
    assert.match(String(body.code || ""), /showIcon/);
    assert.equal(requestBodies.length, 2);
    assert.match(requestBodies[1], /FAILED_ATTEMPT/);
    assert.ok(requestBodies[1].includes(failedCode));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("generate forwards recentChat into the first user prompt", async () => {
  const runtime = createBackendRuntime({
    env: {
      VIBBIT_CLASSROOM_ENABLED: "false",
      SERVER_APP_TOKEN: "",
      VIBBIT_OPENAI_API_KEY: "test-key",
      VIBBIT_PROVIDER: "openai",
      VIBBIT_MODEL: "gpt-4o-mini"
    },
    dnsLookup: async () => [{ address: "203.0.113.10", family: 4 }]
  });

  let capturedProviderBody = "";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init = {}) => {
    capturedProviderBody = String(init.body || "");
    return mockChatCompletion("basic.showIcon(IconNames.Heart)", ["ok"]);
  };

  try {
    const generate = await runtime.fetch(new Request("https://example.test/vibbit/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target: "microbit",
        request: "Show a heart",
        recentChat: [
          { role: "user", content: "make it blink twice" },
          { role: "assistant", notes: "toggled the LED each second" }
        ]
      })
    }));
    const body = await generate.json();
    assert.equal(generate.status, 200, body && body.error ? body.error : "generate failed");
    assert.match(capturedProviderBody, /RECENT_CHAT/);
    assert.match(capturedProviderBody, /make it blink twice/);
    assert.match(capturedProviderBody, /toggled the LED each second/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("oracle-miss records a classroom miss and never requires code", async () => {
  const runtime = createBackendRuntime({
    env: {
      VIBBIT_DEPLOYMENT_MODE: "self-hosted",
      VIBBIT_CLASSROOM_ENABLED: "true",
      VIBBIT_CLASSROOM_CODE: "LEGACY",
      VIBBIT_CLASSROOM_CODE_AUTO: "false",
      VIBBIT_TEACHER_DEV_LOGIN: "true",
      VIBBIT_OPENAI_API_KEY: "server-fallback-key",
      VIBBIT_PROVIDER: "openai",
      VIBBIT_MODEL: "gpt-4o-mini"
    },
    teacherPortalState: {},
    persistTeacherPortalState: async () => {},
    dnsLookup: async () => [{ address: "203.0.113.10", family: 4 }]
  });

  const denied = await runtime.fetch(new Request("https://example.test/vibbit/oracle-miss", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason: "grey blocks", greyBlocks: 2 })
  }));
  assert.equal(denied.status, 401);

  const connect = await runtime.fetch(new Request("https://example.test/vibbit/connect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ classCode: "LEGACY" })
  }));
  assert.equal(connect.status, 200);
  const { sessionToken } = await connect.json();

  const miss = await runtime.fetch(new Request("https://example.test/vibbit/oracle-miss", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${sessionToken}`
    },
    body: JSON.stringify({
      reason: "Detected 2 grey JavaScript block(s)",
      greyBlocks: 2,
      code: "this must not be required or stored"
    })
  }));
  assert.equal(miss.status, 200);
  const body = await miss.json();
  assert.equal(body.ok, true);
  const usage = runtime.usageStore.publicView("legacy");
  assert.equal(usage.oracleMisses, 1);
});
