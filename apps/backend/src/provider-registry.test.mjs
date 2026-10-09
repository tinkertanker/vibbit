import assert from "node:assert/strict";
import test from "node:test";
import { callManagedProvider, defaultModelForCredentialProvider } from "./provider-registry.mjs";

test("direct providers use current cheap defaults without inventing reseller model IDs", () => {
  assert.equal(defaultModelForCredentialProvider("openai"), "gpt-6-luna");
  assert.equal(defaultModelForCredentialProvider("anthropic"), "claude-haiku-5-5");
  assert.equal(defaultModelForCredentialProvider("openrouter"), "openai/gpt-5.6-luna");
  assert.equal(defaultModelForCredentialProvider("opencode"), "gpt-5.6-luna");
  assert.equal(defaultModelForCredentialProvider("custom"), "gpt-4o-mini");
});

test("callManagedProvider sends Gemini API key in x-goog-api-key header", async () => {
  let capturedUrl = "";
  let capturedMethod = "";
  let capturedHeaders = {};

  await callManagedProvider({
    provider: "gemini",
    apiKey: "gem-key",
    model: "gemini-2.5-flash",
    system: "system prompt",
    user: "user prompt",
    fetchImpl: async (url, init) => {
      capturedUrl = String(url);
      capturedMethod = String((init && init.method) || "GET").toUpperCase();
      capturedHeaders = (init && init.headers) || {};
      return new Response(JSON.stringify({
        candidates: [{
          content: { parts: [{ text: "generated text" }] }
        }]
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  });

  const parsed = new URL(capturedUrl);
  assert.equal(capturedMethod, "POST");
  assert.equal(parsed.hostname, "generativelanguage.googleapis.com");
  assert.match(parsed.pathname, /\/models\/gemini-2\.5-flash:generateContent$/);
  assert.equal(parsed.searchParams.has("key"), false);
  assert.ok(!capturedUrl.includes("key="));
  assert.equal(capturedHeaders["x-goog-api-key"], "gem-key");
});

test("callManagedProvider sends OpenCode chat models to the Go gateway", async () => {
  let capturedUrl = "";
  let capturedBody = null;

  const text = await callManagedProvider({
    provider: "opencode",
    apiKey: "open-code-key",
    model: "hy3",
    system: "system prompt",
    user: "user prompt",
    fetchImpl: async (url, init) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({
        choices: [{ message: { content: "generated text" } }]
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  });

  assert.equal(capturedUrl, "https://opencode.ai/zen/go/v1/chat/completions");
  assert.equal(capturedBody.model, "hy3");
  assert.deepEqual(capturedBody.reasoning, { effort: "none" });
  assert.equal(text, "generated text");
});

test("callManagedProvider uses the required temperature for OpenCode Kimi models", async () => {
  let capturedBody = null;
  await callManagedProvider({
    provider: "opencode",
    apiKey: "open-code-key",
    model: "go/kimi-k3",
    temperature: 0.1,
    fetchImpl: async (_url, init) => {
      capturedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  });
  assert.equal(capturedBody.temperature, 1);
  assert.equal(capturedBody.model, "kimi-k3");
});

test("callManagedProvider routes prefixed OpenCode Zen models to Zen", async () => {
  let capturedUrl = "";
  let capturedBody = null;

  await callManagedProvider({
    provider: "opencode",
    apiKey: "open-code-key",
    model: "zen/hy3-free",
    fetchImpl: async (url, init) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  });

  assert.equal(capturedUrl, "https://opencode.ai/zen/v1/chat/completions");
  assert.equal(capturedBody.model, "hy3-free");
  assert.deepEqual(capturedBody.reasoning, { effort: "none" });
});

test("callManagedProvider uses OpenCode Responses API for Muse Contributor", async () => {
  let capturedUrl = "";
  let capturedBody = null;

  const text = await callManagedProvider({
    provider: "opencode",
    apiKey: "open-code-key",
    model: "muse-spark-1.2-contributor",
    system: "system prompt",
    user: "user prompt",
    fetchImpl: async (url, init) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({
        output: [{ content: [{ type: "output_text", text: "generated text" }] }]
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  });

  assert.equal(capturedUrl, "https://opencode.ai/zen/go/v1/responses");
  assert.equal(capturedBody.model, "muse-spark-1.2-contributor");
  assert.equal(capturedBody.max_output_tokens, 3072);
  assert.equal(text, "generated text");
});

test("callManagedProvider uses OpenAI Responses API without temperature for GPT-5.6 Luna", async () => {
  let capturedUrl = "";
  let capturedBody = null;

  const text = await callManagedProvider({
    provider: "openai",
    apiKey: "open-ai-key",
    model: "gpt-5.6-luna",
    system: "system prompt",
    user: "user prompt",
    fetchImpl: async (url, init) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ output_text: "generated text" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  });

  assert.equal(capturedUrl, "https://api.openai.com/v1/responses");
  assert.equal(capturedBody.model, "gpt-5.6-luna");
  assert.equal(capturedBody.temperature, undefined);
  assert.equal(capturedBody.max_output_tokens, 3072);
  assert.equal(text, "generated text");
});

test("callManagedProvider uses OpenRouter GPT-5.6 Luna without temperature", async () => {
  let capturedUrl = "";
  let capturedBody = null;

  await callManagedProvider({
    provider: "openrouter",
    apiKey: "open-router-key",
    model: "openai/gpt-5.6-luna",
    fetchImpl: async (url, init) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: "generated text" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  });

  assert.equal(capturedUrl, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(capturedBody.model, "openai/gpt-5.6-luna");
  assert.equal(capturedBody.temperature, undefined);
});

test("callManagedProvider flattens a transcript for Gemini", async () => {
  let capturedBody = null;
  await callManagedProvider({
    provider: "gemini",
    apiKey: "gem-key",
    model: "gemini-2.5-flash",
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "first" },
      { role: "assistant", content: "() => {}" },
      { role: "user", content: "<<<FAILED_ATTEMPT>>>\n() => {}" }
    ],
    fetchImpl: async (_url, init) => {
      capturedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: "ok" }] } }]
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  });
  const text = capturedBody.contents[0].parts[0].text;
  assert.match(text, /<<<USER>>>/);
  assert.match(text, /<<<ASSISTANT>>>/);
  assert.match(text, /FAILED_ATTEMPT/);
});

function assertNoNativeTools(body) {
  assert.ok(body && typeof body === "object");
  assert.equal("tools" in body, false);
  assert.equal("tool_choice" in body, false);
  assert.equal("functions" in body, false);
  assert.equal("function_call" in body, false);
}

test("callManagedProvider does not send native tool-calling fields", async () => {
  const okChat = new Response(JSON.stringify({
    choices: [{ message: { content: "OK" } }]
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
  const okGemini = new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: "ok" }] } }]
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
  const okResponses = new Response(JSON.stringify({ output_text: "ok" }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });

  const captured = [];
  await callManagedProvider({
    provider: "openai",
    apiKey: "sk-test",
    model: "gpt-4o-mini",
    system: "sys",
    user: "hello",
    fetchImpl: async (_url, init) => {
      captured.push(JSON.parse(init.body));
      return okChat;
    }
  });
  await callManagedProvider({
    provider: "gemini",
    apiKey: "gem-key",
    model: "gemini-2.5-flash",
    system: "sys",
    user: "hello",
    fetchImpl: async (_url, init) => {
      captured.push(JSON.parse(init.body));
      return okGemini;
    }
  });
  await callManagedProvider({
    provider: "openai",
    apiKey: "sk-test",
    model: "gpt-5.6-luna",
    system: "sys",
    user: "hello",
    fetchImpl: async (_url, init) => {
      captured.push(JSON.parse(init.body));
      return okResponses;
    }
  });

  assert.equal(captured.length, 3);
  for (const body of captured) assertNoNativeTools(body);
});

test("Anthropic server credentials use native Messages and exclude thinking from generated text", async () => {
  const messages = [
    { role: "system", content: "sys" }, { role: "user", content: "first" },
    { role: "assistant", content: "bad code" }, { role: "user", content: "fix" }
  ];
  const text = await callManagedProvider({
    provider: "anthropic", apiKey: "server-fixture", model: "claude-sonnet-5-5", messages,
    fetchImpl: async (url, init) => {
      assert.equal(url, "https://api.anthropic.com/v1/messages");
      assert.equal(init.redirect, "error");
      assert.equal(init.headers["x-api-key"], "server-fixture");
      assert.equal(init.headers["anthropic-version"], "2023-06-01");
      const body = JSON.parse(init.body);
      assert.deepEqual(body, {
        model: "claude-sonnet-5-5", max_tokens: 3072, system: "sys", messages: messages.slice(1),
        thinking: { type: "adaptive" }, output_config: { effort: "low" }
      });
      return Response.json({ stop_reason: "end_turn", content: [
        { type: "thinking", thinking: "hidden" }, { type: "text", text: "answer" }
      ] });
    }
  });
  assert.equal(text, "answer");
  for (const model of ["claude-3-haiku-20240307", "claude-sonnet-4-5", "custom-claude-id"]) {
    assert.equal(await callManagedProvider({
      provider: "anthropic", model, apiKey: "fixture", system: "sys", user: "hello",
      fetchImpl: async (_, init) => {
        const body = JSON.parse(init.body);
        assert.equal(body.model, model);
        assert.equal(body.thinking, undefined);
        assert.equal(body.output_config, undefined);
        return Response.json({ stop_reason: "end_turn", content: [{ type: "text", text: "legacy answer" }] });
      }
    }), "legacy answer");
  }
  for (const stop_reason of ["refusal", "max_tokens", "model_context_window_exceeded"]) {
    await assert.rejects(callManagedProvider({
      provider: "anthropic", apiKey: "fixture", system: "sys", user: "hello",
      fetchImpl: async () => Response.json({ stop_reason, content: [{ type: "text", text: "partial" }] })
    }), new RegExp(`anthropic_${stop_reason}`));
  }
});

test("current direct OpenAI models use Responses without sampling", async () => {
  for (const model of ["gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra"]) {
    const text = await callManagedProvider({
      provider: "openai", apiKey: "fixture", model, system: "sys", user: "hello",
      fetchImpl: async (url, init) => {
        assert.equal(url, "https://api.openai.com/v1/responses");
        const body = JSON.parse(init.body);
        assert.equal(body.model, model);
        assert.equal(body.temperature, undefined);
        assert.deepEqual(body.reasoning, { effort: "low" });
        return Response.json({ output_text: "answer" });
      }
    });
    assert.equal(text, "answer");
  }
});

test("catalogue Gemini preview selections use the documented beta endpoint", async () => {
  const text = await callManagedProvider({ provider: "gemini", model: "gemini-3-flash-preview", apiKey: "fixture", user: "hello",
    fetchImpl: async (url) => {
      assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent");
      return Response.json({ candidates: [{ content: { parts: [{ text: "answer" }] } }] });
    }
  });
  assert.equal(text, "answer");
});
