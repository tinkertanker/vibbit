import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createBackendRuntime } from "./runtime.mjs";
import { normaliseApiBaseUrl } from "./classroom-store.mjs";
import { followTeacherForm } from "./teacher-test-helpers.mjs";

function createClassroomRuntime(teacherPortalState = {}) {
  let savedPortalState = teacherPortalState;
  return createBackendRuntime({
    env: {
      VIBBIT_CLASSROOM_ENABLED: "true",
      VIBBIT_CLASSROOM_CODE: "LEGACY",
      VIBBIT_CLASSROOM_CODE_AUTO: "false",
      VIBBIT_TEACHER_DEV_LOGIN: "true",
      VIBBIT_OPENAI_API_KEY: "server-fallback-key",
      VIBBIT_PROVIDER: "openai",
      VIBBIT_MODEL: "gpt-4o-mini"
    },
    teacherPortalState,
    persistTeacherPortalState: async (next) => {
      savedPortalState = next;
    },
    dnsLookup: async () => [{ address: "203.0.113.10", family: 4 }]
  });
}

test("normaliseApiBaseUrl adds /v1 for OpenAI-compatible and LiteLLM roots", () => {
  assert.equal(normaliseApiBaseUrl("https://api.openai.com"), "https://api.openai.com/v1");
  assert.equal(normaliseApiBaseUrl("http://localhost:4000"), "http://localhost:4000/v1");
  assert.equal(normaliseApiBaseUrl("https://openrouter.ai/api/v1"), "https://openrouter.ai/api/v1");
});

test("new AI accounts resolve provider defaults while explicit saved models stay unchanged", async () => {
  const runtime = createClassroomRuntime();
  const login = await followTeacherForm(runtime, "/teacher/dev-login", { email: "models@example.test", name: "Fixture teacher" });
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(init.body) });
    return Response.json(String(url).endsWith("/messages")
      ? { stop_reason: "end_turn", content: [{ type: "text", text: "OK" }] }
      : { output_text: "OK" });
  };
  try {
    for (const [provider, model, expected] of [
      ["openai", "", "gpt-6-luna"],
      ["anthropic", "", "claude-haiku-5-5"],
      ["openai", "gpt-5.6-luna", "gpt-5.6-luna"]
    ]) {
      const result = await followTeacherForm(runtime, "/teacher/profiles", {
        name: expected, provider, defaultModel: model, apiKey: "fixture-only"
      }, login.cookieHeader);
      assert.match(result.response.headers.get("Location"), /AI%20account%20tested/);
      assert.equal(requests.at(-1).body.model, expected);
      const profile = runtime.teacherPortal.store.listCredentialProfilesForTeacher("local:models@example.test")
        .find((item) => item.name === expected);
      assert.equal(profile.provider, provider);
      assert.equal(profile.defaultModel, expected);
      assert.equal(profile.lastTestOk, true);
    }
    assert.equal(requests[1].url, "https://api.anthropic.com/v1/messages");
    assert.equal(requests[1].body.max_tokens, 1024);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("teacher and operator model suggestions use the public catalogue without replacing configured models", async () => {
  const fixture = JSON.parse(await readFile(new URL("../../../scripts/audit/fixtures/model-catalogue.json", import.meta.url), "utf8"));
  let catalogueCalls = 0;
  const runtime = createBackendRuntime({
    env: { VIBBIT_TEACHER_DEV_LOGIN: "true", VIBBIT_TKSLOPPER_GATEWAY_URL: "https://gateway.example.test",
      VIBBIT_ADMIN_TOKEN: "fixture-admin", VIBBIT_OPENAI_MODEL: "saved-private-model" },
    catalogueFetch: async (url, init) => {
      catalogueCalls++;
      assert.equal(url, "https://gateway.example.test/v1/model-catalogue");
      assert.deepEqual(init.headers, { Accept: "application/json" });
      assert.equal(init.credentials, "omit");
      return Response.json(fixture);
    },
    dnsLookup: async () => [{ address: "203.0.113.10", family: 4 }]
  });
  const login = await followTeacherForm(runtime, "/teacher/dev-login", { email: "catalogue@example.test", name: "Fixture" });
  const dashboard = await runtime.fetch(new Request("https://example.test/teacher", { headers: { Cookie: login.cookieHeader } }));
  const html = await dashboard.text();
  assert.match(html, /value="claude-opus-5-5"/);
  assert.match(html, /value="go\/responses\/muse-spark-1.2-contributor"/);
  assert.match(html, /trains on data/);
  const admin = await runtime.fetch(new Request("https://example.test/admin", { headers: { "X-Vibbit-Admin-Token": "fixture-admin" } }));
  const adminHtml = await admin.text();
  assert.match(adminHtml, /value="saved-private-model"/);
  assert.match(adminHtml, /value="claude-sonnet-5-5"/);
  assert.equal(catalogueCalls, 1);
  const originalFetch = globalThis.fetch;
  const models = [];
  globalThis.fetch = async (_, init) => {
    models.push(JSON.parse(init.body).model);
    return Response.json({ choices: [{ message: { content: "OK" } }] });
  };
  try {
    for (const model of ["", "openai/gpt-5.6-luna"]) {
      const result = await followTeacherForm(runtime, "/teacher/profiles", {
        name: model || "Catalogue default", provider: "openrouter", defaultModel: model, apiKey: "fixture-only"
      }, login.cookieHeader);
      assert.match(result.response.headers.get("Location"), /AI%20account%20tested/);
    }
    assert.deepEqual(models, ["deepseek/deepseek-v4-flash", "openai/gpt-5.6-luna"]);
  } finally { globalThis.fetch = originalFetch; }
});

test("teacher can sign in locally, test-and-save an AI account, create a classroom, and students can connect", async () => {
  const runtime = createClassroomRuntime();

  const login = await followTeacherForm(runtime, "/teacher/dev-login", {
    email: "teacher@school.edu",
    name: "Ms Tan"
  });
  assert.equal(login.response.status, 303);
  assert.match(login.cookieHeader, /vibbit_teacher_session=/);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes("api.openai.com")) {
      return new Response(JSON.stringify({
        choices: [{ message: { content: "OK" } }]
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    return originalFetch(url);
  };

  let createProfile;
  try {
    createProfile = await followTeacherForm(runtime, "/teacher/profiles", {
      name: "School OpenAI",
      provider: "openai",
      apiKey: "sk-teacher-key",
      defaultModel: "gpt-4o-mini",
      makeDefault: "1"
    }, login.cookieHeader);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(createProfile.response.status, 303);
  assert.match(String(createProfile.response.headers.get("Location") || ""), /AI%20account%20tested/);

  const profile = runtime.teacherPortal.store.listCredentialProfilesForTeacher("local:teacher@school.edu")[0];
  assert.ok(profile);
  assert.equal(profile.name, "School OpenAI");
  assert.equal(profile.lastTestOk, true);

  const mint = await followTeacherForm(runtime, "/teacher/classrooms", {
    name: "Period 3",
    credentialProfileId: profile.id,
    modelOverride: ""
  }, login.cookieHeader);
  assert.equal(mint.response.status, 303);

  const dashboard = await runtime.fetch(new Request("https://example.test/teacher", {
    headers: { Cookie: login.cookieHeader }
  }));
  assert.equal(dashboard.status, 200);
  const html = await dashboard.text();
  assert.match(html, /AI accounts/);
  assert.match(html, /School OpenAI/);
  assert.match(html, /Period 3/);
  assert.match(html, /of 500 used today \(hidden retries included\)/);
  assert.match(html, /Ready/);
  const codeMatch = html.match(/class="code code-lg">([A-Z]{5}-[A-Z]{5})</);
  assert.ok(codeMatch, "expected classroom code in dashboard");
  const classCode = codeMatch[1].replace(/-/g, "");

  const connect = await runtime.fetch(new Request("https://example.test/vibbit/connect", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Vibbit-Class-Code": classCode
    },
    body: JSON.stringify({ classCode })
  }));
  assert.equal(connect.status, 200);
  const connected = await connect.json();
  assert.equal(connected.ok, true);
  assert.equal(typeof connected.sessionToken, "string");
  assert.ok(connected.sessionToken.length > 0);
  assert.equal(connected.classroomName, "Period 3");
  assert.equal(connected.defaultModel, "gpt-4o-mini");
});

test("failed AI account test does not save a new profile", async () => {
  const runtime = createClassroomRuntime();
  const login = await followTeacherForm(runtime, "/teacher/dev-login", {
    email: "teacher-fail@school.edu",
    name: "Ms Fail"
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("api.openai.com")) {
      return new Response(JSON.stringify({ error: { message: "invalid key" } }), {
        status: 401,
        headers: { "Content-Type": "application/json" }
      });
    }
    return originalFetch(url);
  };

  let createProfile;
  try {
    createProfile = await followTeacherForm(runtime, "/teacher/profiles", {
      name: "Broken key",
      provider: "openai",
      apiKey: "sk-bad",
      defaultModel: "gpt-4o-mini",
      makeDefault: "1"
    }, login.cookieHeader);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(createProfile.response.status, 303);
  assert.match(String(createProfile.response.headers.get("Location") || ""), /error=/);
  const profiles = runtime.teacherPortal.store.listCredentialProfilesForTeacher("local:teacher-fail@school.edu");
  assert.equal(profiles.length, 0);
});

test("failed Test and save keeps a classroom-used ready AI account unchanged", async () => {
  const runtime = createClassroomRuntime({
    teachers: {
      "local:teacher@school.edu": {
        id: "local:teacher@school.edu",
        email: "teacher@school.edu",
        name: "Ms Tan",
        provider: "local",
        defaultCredentialProfileId: "cp_ready",
        createdAt: "2026-01-01T00:00:00.000Z"
      }
    },
    credentialProfiles: {
      cp_ready: {
        id: "cp_ready",
        teacherId: "local:teacher@school.edu",
        name: "Working account",
        provider: "openai",
        apiKey: "sk-good",
        defaultModel: "gpt-4o-mini",
        lastTestOk: true,
        lastTestedAt: "2026-01-01T00:00:00.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      }
    },
    classrooms: {
      cls_live: {
        id: "cls_live",
        teacherId: "local:teacher@school.edu",
        name: "Live class",
        code: "LIVECLASS1",
        credentialProfileId: "cp_ready",
        enabled: true,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      }
    }
  });

  const login = await followTeacherForm(runtime, "/teacher/dev-login", {
    email: "teacher@school.edu",
    name: "Ms Tan"
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("api.openai.com")) {
      return new Response(JSON.stringify({ error: { message: "invalid key" } }), {
        status: 401,
        headers: { "Content-Type": "application/json" }
      });
    }
    return originalFetch(url);
  };

  let failedTest;
  try {
    failedTest = await followTeacherForm(runtime, "/teacher/profiles/cp_ready/test", {
      name: "Working account",
      provider: "openai",
      apiKey: "sk-bad-replacement",
      defaultModel: "gpt-4o-mini"
    }, login.cookieHeader);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(failedTest.response.status, 303);
  assert.match(String(failedTest.response.headers.get("Location") || ""), /error=/);

  const profile = runtime.teacherPortal.store.getCredentialProfile("cp_ready");
  assert.equal(profile.apiKey, "sk-good");
  assert.equal(profile.lastTestOk, true);
  assert.equal(profile.defaultModel, "gpt-4o-mini");

  const connect = await runtime.fetch(new Request("https://example.test/vibbit/connect", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Vibbit-Class-Code": "LIVECLASS1"
    },
    body: JSON.stringify({ classCode: "LIVECLASS1" })
  }));
  assert.equal(connect.status, 200);
});

test("connect rejects classrooms with an untested model override", async () => {
  const runtime = createClassroomRuntime({
    teachers: {
      "local:teacher@school.edu": {
        id: "local:teacher@school.edu",
        email: "teacher@school.edu",
        name: "Ms Tan",
        provider: "local",
        createdAt: "2026-01-01T00:00:00.000Z"
      }
    },
    credentialProfiles: {
      cp_ready: {
        id: "cp_ready",
        teacherId: "local:teacher@school.edu",
        name: "Ready",
        provider: "openai",
        apiKey: "sk-ready",
        defaultModel: "gpt-4o-mini",
        lastTestOk: true,
        lastTestedAt: "2026-01-01T00:00:00.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      }
    },
    classrooms: {
      cls_override: {
        id: "cls_override",
        teacherId: "local:teacher@school.edu",
        name: "Override",
        code: "OVERRIDE01",
        credentialProfileId: "cp_ready",
        modelOverride: "gpt-4.1-mini",
        enabled: true,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      }
    }
  });

  const connect = await runtime.fetch(new Request("https://example.test/vibbit/connect", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Vibbit-Class-Code": "OVERRIDE01"
    },
    body: JSON.stringify({ classCode: "OVERRIDE01" })
  }));
  assert.equal(connect.status, 503);
  const body = await connect.json();
  assert.match(String(body.error || ""), /tested AI account model/i);
});

test("connect rejects classrooms whose AI account is untested", async () => {
  const runtime = createClassroomRuntime({
    teachers: {
      "local:teacher@school.edu": {
        id: "local:teacher@school.edu",
        email: "teacher@school.edu",
        name: "Ms Tan",
        provider: "local",
        createdAt: "2026-01-01T00:00:00.000Z"
      }
    },
    credentialProfiles: {
      cp_untested: {
        id: "cp_untested",
        teacherId: "local:teacher@school.edu",
        name: "Untested",
        provider: "openai",
        apiKey: "sk-untested",
        defaultModel: "gpt-4o-mini",
        lastTestOk: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      }
    },
    classrooms: {
      cls_unready: {
        id: "cls_unready",
        teacherId: "local:teacher@school.edu",
        name: "Unready",
        code: "UNREADYCLS",
        credentialProfileId: "cp_untested",
        enabled: true,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      }
    }
  });

  const connect = await runtime.fetch(new Request("https://example.test/vibbit/connect", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Vibbit-Class-Code": "UNREADYCLS"
    },
    body: JSON.stringify({ classCode: "UNREADYCLS" })
  }));
  assert.equal(connect.status, 503);
  const body = await connect.json();
  assert.match(String(body.error || ""), /test and save/i);
});

test("legacy class code still connects when teacher classrooms exist", async () => {
  const runtime = createClassroomRuntime();
  const connect = await runtime.fetch(new Request("https://example.test/vibbit/connect", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Vibbit-Class-Code": "LEGACY"
    },
    body: JSON.stringify({ classCode: "LEGACY" })
  }));
  assert.equal(connect.status, 200);
  const body = await connect.json();
  assert.equal(body.ok, true);
  assert.ok(body.sessionToken);
});

test("legacy classroom generate uses the migrated credential profile base URL and API key", async () => {
  const runtime = createClassroomRuntime({
    teachers: {
      "local:teacher@school.edu": {
        id: "local:teacher@school.edu",
        email: "teacher@school.edu",
        name: "Ms Tan",
        provider: "local",
        createdAt: "2026-01-01T00:00:00.000Z"
      }
    },
    classrooms: {
      cls_demo: {
        id: "cls_demo",
        teacherId: "local:teacher@school.edu",
        name: "Demo",
        code: "ZZZZZ",
        apiBaseUrl: "https://litellm.example/v1",
        apiKey: "sk-classroom",
        model: "claude-sonnet",
        enabled: true,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      }
    }
  });

  const connect = await runtime.fetch(new Request("https://example.test/vibbit/connect", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Vibbit-Class-Code": "ZZZZZ"
    },
    body: JSON.stringify({ classCode: "ZZZZZ" })
  }));
  const connected = await connect.json();
  assert.equal(connect.status, 200);
  const classroom = runtime.teacherPortal.store.getClassroom("cls_demo");
  const profile = runtime.teacherPortal.store.getEffectiveCredentialProfileForClassroom(classroom);
  assert.ok(profile);
  assert.equal(classroom.apiKey, "");
  assert.equal(profile.customBaseUrl, "https://litellm.example/v1");
  assert.equal(profile.apiKey, "sk-classroom");

  const originalFetch = globalThis.fetch;
  let seenUrl = "";
  let seenAuth = "";
  let seenModel = "";
  globalThis.fetch = async (url, init = {}) => {
    seenUrl = String(url);
    seenAuth = String((init.headers && init.headers.Authorization) || "");
    try {
      const parsed = JSON.parse(String(init.body || "{}"));
      seenModel = parsed.model || "";
    } catch {
      seenModel = "";
    }
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            feedback: ["ok"],
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
        Authorization: `Bearer ${connected.sessionToken}`
      },
      body: JSON.stringify({
        target: "microbit",
        request: "Show a heart"
      })
    }));
    assert.equal(generate.status, 200);
    const result = await generate.json();
    assert.match(String(result.code || ""), /showIcon/);
    assert.equal(seenUrl, "https://litellm.example/v1/chat/completions");
    assert.equal(seenAuth, "Bearer sk-classroom");
    assert.equal(seenModel, "claude-sonnet");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("teacher portal page uses relative favicon link", async () => {
  const runtime = createClassroomRuntime();
  const response = await runtime.fetch(new Request("https://example.test/teacher"));
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /href="favicon\.svg"/);
  assert.doesNotMatch(body, /href="\/favicon\.svg"/);
});
