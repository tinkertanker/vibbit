import assert from "node:assert/strict";
import test from "node:test";

import { callByokProvider, ProviderRequestError } from "./provider-transport.mjs";

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
  assert.equal(calls[0].body.model, "gpt-5.6-luna");
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
