import { serializeTranscript } from "../shared/makecode-compat-core.mjs";
import {
  normaliseByokModel,
  normaliseByokProvider,
  supportsByokThinkHarder
} from "./byok-config.mjs";

export class ProviderRequestError extends Error {
  constructor(code, status = 0) {
    super(code);
    this.name = "ProviderRequestError";
    this.code = code;
    this.status = Number(status) || 0;
  }
}

function responseTextFromOpenAI(data) {
  return String(data?.choices?.[0]?.message?.content || "").trim();
}

function responseTextFromResponses(data) {
  if (typeof data?.output_text === "string") return data.output_text.trim();
  return (Array.isArray(data?.output) ? data.output : [])
    .flatMap((item) => Array.isArray(item?.content) ? item.content : [])
    .map((item) => typeof item?.text === "string" ? item.text : "")
    .join("")
    .trim();
}

function responseTextFromGemini(data) {
  return (Array.isArray(data?.candidates?.[0]?.content?.parts)
    ? data.candidates[0].content.parts
    : [])
    .map((part) => typeof part?.text === "string" ? part.text : "")
    .join("")
    .trim();
}

async function fetchJson(fetchImpl, url, init, provider) {
  let response;
  try {
    response = await fetchImpl(url, { ...init, redirect: "error" });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw new ProviderRequestError(`${provider}_network_error`);
  }
  if (!response.ok) {
    throw new ProviderRequestError(`${provider}_http_error`, response.status);
  }
  try {
    return await response.json();
  } catch {
    throw new ProviderRequestError(`${provider}_invalid_response`, response.status);
  }
}

export async function callByokProvider({
  provider,
  model,
  apiKey,
  messages,
  thinkHarder = false,
  signal,
  pageOrigin = "",
  fetchImpl = fetch
} = {}) {
  const safeProvider = normaliseByokProvider(provider);
  const safeModel = normaliseByokModel(safeProvider, model);
  const key = String(apiKey || "").trim();
  if (!key) throw new ProviderRequestError("missing_key");
  const harder = Boolean(thinkHarder) && supportsByokThinkHarder(safeProvider, safeModel);
  const maxTokens = harder ? 16384 : 3072;
  const transcript = Array.isArray(messages) ? messages.map((turn) => ({
    role: turn?.role === "assistant" || turn?.role === "system" ? turn.role : "user",
    content: String(turn?.content || "")
  })) : [];

  if (safeProvider === "gemini") {
    const flattened = serializeTranscript(transcript);
    const data = await fetchJson(fetchImpl,
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(safeModel)}:generateContent`,
      {
        method: "POST",
        signal,
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: `${flattened.system}\n\n${flattened.user}` }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: maxTokens }
        })
      },
      safeProvider
    );
    return responseTextFromGemini(data);
  }

  if (safeProvider === "openai") {
    const responses = safeModel === "gpt-5.6-luna";
    const body = responses
      ? { model: safeModel, max_output_tokens: maxTokens, input: transcript }
      : { model: safeModel, messages: transcript };
    if (responses && harder) body.reasoning = { effort: "max" };
    if (!responses && /^gpt-5/i.test(safeModel)) body.max_completion_tokens = maxTokens;
    if (!responses && !/^gpt-5/i.test(safeModel)) {
      body.temperature = 0.1;
      body.max_tokens = maxTokens;
    }
    const data = await fetchJson(fetchImpl,
      responses ? "https://api.openai.com/v1/responses" : "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify(body)
      },
      safeProvider
    );
    return responses ? responseTextFromResponses(data) : responseTextFromOpenAI(data);
  }

  if (safeProvider === "openrouter") {
    const body = { model: safeModel, max_tokens: maxTokens, messages: transcript };
    if (safeModel !== "openai/gpt-5.6-luna") body.temperature = 0.1;
    if (harder) body.reasoning = { effort: "max" };
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${key}` };
    if (/^https:\/\/(?:makecode\.microbit\.org|arcade\.makecode\.com|maker\.makecode\.com)$/i.test(pageOrigin)) {
      headers["HTTP-Referer"] = pageOrigin;
    }
    headers["X-Title"] = "Vibbit";
    const data = await fetchJson(fetchImpl, "https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal,
      headers,
      body: JSON.stringify(body)
    }, safeProvider);
    return responseTextFromOpenAI(data);
  }

  const selected = safeModel;
  const parts = selected.split("/").filter(Boolean);
  const access = parts[0] === "go" || parts[0] === "zen" ? parts.shift() : "go";
  const protocol = parts[0] === "responses" ? parts.shift() : "chat";
  const modelId = parts.join("/") || selected;
  const baseUrl = access === "zen" ? "https://opencode.ai/zen/v1" : "https://opencode.ai/zen/go/v1";
  const temperature = /^kimi-/i.test(modelId) ? 1 : 0.1;
  const body = protocol === "responses"
    ? { model: modelId, max_output_tokens: maxTokens, input: transcript }
    : { model: modelId, temperature, max_tokens: maxTokens, messages: transcript };
  if (protocol === "responses" && !/^gpt-/i.test(modelId)) body.temperature = temperature;
  if (harder) body.reasoning = { effort: "xhigh" };
  else if (/^hy3(?:-|$)/i.test(modelId)) body.reasoning = { effort: "none" };
  const data = await fetchJson(fetchImpl, `${baseUrl}/${protocol === "responses" ? "responses" : "chat/completions"}`, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body)
  }, safeProvider);
  return protocol === "responses" ? responseTextFromResponses(data) : responseTextFromOpenAI(data);
}
