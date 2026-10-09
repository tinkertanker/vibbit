import assert from "node:assert/strict";
import test from "node:test";

import { callByokProvider, ProviderRequestError } from "./provider-transport.mjs";
import { defaultByokModel, normaliseByokModel } from "./byok-config.mjs";

const MESSAGES = [
  { role: "system", content: "system" },
  { role: "user", content: "user" }
];

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

test("Gemini keeps the API key out of the URL and sends it only from the broker", async () => {
  const calls = [];
  const output = await callByokProvider({
    provider: "gemini",
    model: "gemini-3-flash-preview",
    apiKey: "gemini-secret-canary",
    messages: MESSAGES,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({ candidates: [{ content: { parts: [{ text: "ok" }] } }] });
    }
  });
  assert.equal(output, "ok");
  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0].url, /gemini-secret-canary/);
  assert.equal(calls[0].init.headers["x-goog-api-key"], "gemini-secret-canary");
});

test("provider and model are allowlisted instead of becoming an arbitrary fetch proxy", async () => {
  const calls = [];
  await callByokProvider({
    provider: "https://attacker.invalid",
    model: "attacker/model",
    apiKey: "secret",
    messages: MESSAGES,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      return jsonResponse({ output_text: "ok" });
    }
  });
  assert.equal(calls[0].url, "https://api.openai.com/v1/responses");
  assert.equal(calls[0].body.model, "gpt-6-luna");
});

test("provider failures expose a normalized code without response content", async () => {
  await assert.rejects(
    callByokProvider({
      provider: "openrouter",
      model: "openai/gpt-5.6-luna",
      apiKey: "secret",
      messages: MESSAGES,
      fetchImpl: async () => new Response("sensitive upstream body", { status: 401 })
    }),
    (error) => {
      assert.ok(error instanceof ProviderRequestError);
      assert.equal(error.code, "openrouter_http_error");
      assert.equal(error.status, 401);
      assert.doesNotMatch(error.message, /sensitive|secret/);
      return true;
    }
  );
});

test("OpenRouter identifies Vibbit without disclosing the MakeCode project title", async () => {
  let requestHeaders;
  await callByokProvider({
    provider: "openrouter",
    model: "openai/gpt-5.6-luna",
    apiKey: "secret",
    messages: MESSAGES,
    pageOrigin: "https://makecode.microbit.org",
    pageTitle: "Student full name - private project",
    fetchImpl: async (_url, init) => {
      requestHeaders = init.headers;
      return jsonResponse({ choices: [{ message: { content: "ok" } }] });
    }
  });
  assert.equal(requestHeaders["HTTP-Referer"], "https://makecode.microbit.org");
  assert.equal(requestHeaders["X-Title"], "Vibbit");
  assert.doesNotMatch(JSON.stringify(requestHeaders), /Student full name|private project/);
});

test("OpenRouter models without reasoning support keep the bounded default request", async () => {
  let requestBody;
  await callByokProvider({
    provider: "openrouter",
    model: "xiaomi/mimo-v2.5",
    apiKey: "secret",
    messages: MESSAGES,
    thinkHarder: true,
    fetchImpl: async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return jsonResponse({ choices: [{ message: { content: "ok" } }] });
    }
  });
  assert.equal(requestBody.max_tokens, 3072);
  assert.equal(Object.hasOwn(requestBody, "reasoning"), false);
});

test("OpenAI Responses uses the bounded reasoning contract", async () => {
  let requestBody;
  await callByokProvider({
    provider: "openai",
    model: "gpt-5.6-luna",
    apiKey: "secret",
    messages: MESSAGES,
    thinkHarder: true,
    fetchImpl: async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return jsonResponse({ output_text: "ok" });
    }
  });
  assert.equal(requestBody.max_output_tokens, 16384);
  assert.deepEqual(requestBody.reasoning, { effort: "max" });
  assert.deepEqual(requestBody.input, MESSAGES);
});

test("current OpenAI defaults use Responses without resetting valid stored choices", async () => {
  assert.equal(defaultByokModel("openai"), "gpt-6-luna");
  for (const model of ["gpt-5-mini", "gpt-5.2", "gpt-5.6-luna", "gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra"]) {
    assert.equal(normaliseByokModel("openai", model), model);
  }
  for (const model of ["gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra"]) {
    await callByokProvider({
      provider: "openai", model, apiKey: "fixture", messages: MESSAGES,
      fetchImpl: async (url, init) => {
        assert.equal(url, "https://api.openai.com/v1/responses");
        const body = JSON.parse(init.body);
        assert.equal(body.model, model);
        assert.equal(body.temperature, undefined);
        assert.deepEqual(body.reasoning, { effort: "low" });
        return jsonResponse({ output_text: "ok" });
      }
    });
  }
});

test("Anthropic separates system text, preserves correction turns, and returns only answer blocks", async () => {
  const messages = [...MESSAGES, { role: "assistant", content: "bad code" }, { role: "user", content: "fix it" }];
  for (const thinkHarder of [false, true]) {
    const controller = new AbortController();
    const output = await callByokProvider({
      provider: "anthropic", apiKey: "anthropic-fixture", messages, thinkHarder, signal: controller.signal,
      fetchImpl: async (url, init) => {
        assert.equal(url, "https://api.anthropic.com/v1/messages");
        assert.equal(init.headers["x-api-key"], "anthropic-fixture");
        assert.equal(init.headers["anthropic-version"], "2023-06-01");
        assert.equal(init.redirect, "error");
        assert.equal(init.signal, controller.signal);
        const body = JSON.parse(init.body);
        assert.equal(body.model, "claude-haiku-5-5");
        assert.equal(body.system, "system");
        assert.deepEqual(body.messages, messages.slice(1));
        assert.deepEqual(body.thinking, { type: "adaptive" });
        assert.deepEqual(body.output_config, { effort: thinkHarder ? "high" : "low" });
        assert.equal(body.max_tokens, thinkHarder ? 16384 : 3072);
        for (const field of ["temperature", "top_p", "top_k", "seed", "tools"]) assert.equal(body[field], undefined);
        return jsonResponse({ stop_reason: "end_turn", content: [
          { type: "thinking", thinking: "private", signature: "hidden" },
          { type: "text", text: "answer " }, { type: "text", text: "only" }
        ] });
      }
    });
    assert.equal(output, "answer only");
  }
});

test("Anthropic refuses to apply refused or truncated output", async () => {
  for (const stop_reason of ["refusal", "max_tokens", "model_context_window_exceeded"]) {
    await assert.rejects(callByokProvider({
      provider: "anthropic", apiKey: "fixture", messages: MESSAGES,
      fetchImpl: async () => jsonResponse({ stop_reason, content: [{ type: "text", text: "partial code" }] })
    }), (error) => error instanceof ProviderRequestError && error.code === `anthropic_${stop_reason}`);
  }
});
