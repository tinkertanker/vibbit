import { serializeTranscript } from "../../../shared/makecode-compat-core.mjs";
import { callOpenAICompatible, callOpenAIResponsesCompatible } from "./openai-compat.mjs";

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_OPENCODE_BASE_URL = "https://opencode.ai/zen/go/v1";
const GEMINI_API_ROOT = "https://generativelanguage.googleapis.com/v1";
const OPENCODE_RESPONSES_MODELS = new Set(["gpt-5.6-luna", "grok-4.5", "muse-spark-1.2-contributor"]);

export const CREDENTIAL_PROFILE_PROVIDERS = ["openai", "anthropic", "gemini", "openrouter", "opencode", "custom"];

export function normaliseCredentialProvider(value) {
  const provider = String(value || "").trim().toLowerCase();
  return CREDENTIAL_PROFILE_PROVIDERS.includes(provider) ? provider : "openai";
}

export function providerDisplayName(provider) {
  const normalised = normaliseCredentialProvider(provider);
  if (normalised === "openai") return "OpenAI";
  if (normalised === "anthropic") return "Anthropic (Claude)";
  if (normalised === "gemini") return "Gemini";
  if (normalised === "openrouter") return "OpenRouter";
  if (normalised === "opencode") return "OpenCode";
  if (normalised === "custom") return "Custom";
  return normalised;
}

export function defaultModelForCredentialProvider(provider) {
  const normalised = normaliseCredentialProvider(provider);
  if (normalised === "openai") return "gpt-6-luna";
  if (normalised === "anthropic") return "claude-haiku-5-5";
  if (normalised === "gemini") return "gemini-2.5-flash";
  if (normalised === "openrouter") return "openai/gpt-5.6-luna";
  if (normalised === "opencode") return "gpt-5.6-luna";
  return "gpt-4o-mini";
}

function resolveOpenCodeTarget(model) {
  const parts = String(model || "").trim().split("/").filter(Boolean);
  const access = parts[0] === "zen" || parts[0] === "go" ? parts.shift() : "go";
  const explicitResponses = parts[0] === "responses";
  if (explicitResponses) parts.shift();
  const upstreamModel = parts.join("/") || String(model || "").trim();
  return {
    baseUrl: access === "zen" ? "https://opencode.ai/zen/v1" : DEFAULT_OPENCODE_BASE_URL,
    model: upstreamModel,
    responses: explicitResponses || OPENCODE_RESPONSES_MODELS.has(upstreamModel)
  };
}

export function normaliseOpenAiCompatibleBaseUrl(value) {
  let url = String(value || "").trim();
  if (!url) return DEFAULT_OPENAI_BASE_URL;
  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return DEFAULT_OPENAI_BASE_URL;
    }
    let path = parsed.pathname.replace(/\/+$/, "");
    if (!path || path === "/") {
      path = "/v1";
    } else if (!/\/v\d+$/i.test(path) && !/\/chat\/completions$/i.test(path)) {
      path = `${path}/v1`.replace(/\/{2,}/g, "/");
    }
    parsed.pathname = path;
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return DEFAULT_OPENAI_BASE_URL;
  }
}

export function inferCredentialProfileFromLegacyEndpoint(value) {
  const baseUrl = normaliseOpenAiCompatibleBaseUrl(value);
  try {
    const parsed = new URL(baseUrl);
    const hostname = String(parsed.hostname || "").toLowerCase();
    const pathname = String(parsed.pathname || "").toLowerCase();
    if (hostname === "api.openai.com") {
      return { provider: "openai", customBaseUrl: "" };
    }
    if (hostname === "openrouter.ai" && pathname.startsWith("/api/")) {
      return { provider: "openrouter", customBaseUrl: "" };
    }
    if (hostname === "opencode.ai" && pathname.startsWith("/zen/")) {
      return { provider: "opencode", customBaseUrl: "" };
    }
    if (hostname === "generativelanguage.googleapis.com") {
      return { provider: "gemini", customBaseUrl: "" };
    }
  } catch {
  }
  return { provider: "custom", customBaseUrl: baseUrl };
}

export function resolveManagedBaseUrlForProvider(provider, customBaseUrl = "") {
  const normalised = normaliseCredentialProvider(provider);
  if (normalised === "openai") return DEFAULT_OPENAI_BASE_URL;
  if (normalised === "openrouter") return DEFAULT_OPENROUTER_BASE_URL;
  if (normalised === "opencode") return DEFAULT_OPENCODE_BASE_URL;
  if (normalised === "custom") return normaliseOpenAiCompatibleBaseUrl(customBaseUrl);
  return "";
}

export function createProviderConfigFromCredentialProfile(profile, { modelOverride = "" } = {}) {
  const provider = normaliseCredentialProvider(profile && profile.provider);
  const apiKey = String((profile && profile.apiKey) || "").trim();
  const model = String(modelOverride || (profile && profile.defaultModel) || "").trim()
    || defaultModelForCredentialProvider(provider);
  const baseUrl = resolveManagedBaseUrlForProvider(provider, profile && profile.customBaseUrl);
  return {
    enabledProviders: [provider],
    defaultProvider: provider,
    allowedModels: {},
    defaultModelFor: () => model,
    apiKeyFor: () => apiKey,
    baseUrlFor: () => baseUrl,
    profileId: profile && profile.id ? profile.id : "",
    source: "credentialProfile"
  };
}

export async function callManagedProvider({
  provider,
  apiKey,
  model,
  system,
  user,
  messages,
  signal,
  customBaseUrl = "",
  temperature = 0.1,
  maxTokens = 3072,
  fetchImpl = fetch
} = {}) {
  const selectedProvider = normaliseCredentialProvider(provider);
  const key = String(apiKey || "").trim();
  const selectedModel = String(model || "").trim() || defaultModelForCredentialProvider(selectedProvider);
  const openCodeTarget = selectedProvider === "opencode" ? resolveOpenCodeTarget(selectedModel) : null;
  const selectedTemperature = openCodeTarget && /^kimi-/i.test(openCodeTarget.model)
    ? 1
    : temperature;
  if (!key) throw new Error("Missing API key");

  if (selectedProvider === "anthropic") {
    const transcript = Array.isArray(messages) && messages.length ? messages : [
      { role: "system", content: String(system || "") },
      { role: "user", content: String(user || "") }
    ];
    const response = await fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal,
      redirect: "error",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: selectedModel,
        max_tokens: maxTokens,
        system: transcript.filter((turn) => turn.role === "system").map((turn) => turn.content).join("\n\n"),
        messages: transcript.filter((turn) => turn.role !== "system"),
        ...(/^claude-(?:haiku|sonnet|opus)-5-5(?:-|$)/.test(selectedModel) ? {
          thinking: { type: "adaptive" },
          output_config: { effort: "low" }
        } : {})
      })
    });
    if (!response.ok) throw new Error(`Anthropic error (${response.status})`);
    const data = await response.json();
    if (["refusal", "max_tokens", "model_context_window_exceeded"].includes(data?.stop_reason)) {
      throw new Error(`anthropic_${data.stop_reason}`);
    }
    if (!["end_turn", "stop_sequence"].includes(data?.stop_reason)) throw new Error("anthropic_invalid_response");
    return (Array.isArray(data?.content) ? data.content : [])
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text).join("").trim();
  }

  if (selectedProvider === "gemini") {
    const apiRoot = selectedModel.includes("-preview") ? `${GEMINI_API_ROOT}beta` : GEMINI_API_ROOT;
    const url = `${apiRoot}/models/${encodeURIComponent(selectedModel)}:generateContent`;
    const flattened = Array.isArray(messages) && messages.length
      ? serializeTranscript(messages)
      : { system, user };
    const body = {
      contents: [{ role: "user", parts: [{ text: `${String(flattened.system || "")}\n\n${String(flattened.user || "")}` }] }],
      generationConfig: {
        temperature,
        maxOutputTokens: maxTokens
      }
    };
    const response = await fetchImpl(url, {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": key
      },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      throw new Error(`Gemini error (${response.status})`);
    }
    const data = await response.json();
    const text = data
      && data.candidates
      && data.candidates[0]
      && data.candidates[0].content
      && Array.isArray(data.candidates[0].content.parts)
      ? data.candidates[0].content.parts.map((part) => part && part.text ? part.text : "").join("")
      : "";
    return text;
  }

  if ((selectedProvider === "openai" && (selectedModel === "gpt-5.6-luna" || /^gpt-6[.-]/.test(selectedModel)))
    || (openCodeTarget && openCodeTarget.responses)) {
    return callOpenAIResponsesCompatible({
      apiKey: key,
      baseUrl: openCodeTarget ? openCodeTarget.baseUrl : DEFAULT_OPENAI_BASE_URL,
      model: openCodeTarget ? openCodeTarget.model : selectedModel,
      system,
      user,
      messages,
      signal,
      temperature: selectedTemperature,
      maxTokens,
      fetchImpl
    });
  }

  return callOpenAICompatible({
    apiKey: key,
    baseUrl: openCodeTarget ? openCodeTarget.baseUrl : resolveManagedBaseUrlForProvider(selectedProvider, customBaseUrl),
    model: openCodeTarget ? openCodeTarget.model : selectedModel,
    system,
    user,
    messages,
    signal,
    temperature: selectedTemperature,
    maxTokens,
    reasoning: openCodeTarget && /^hy3(?:-|$)/i.test(openCodeTarget.model)
      ? { effort: "none" }
      : undefined,
    fetchImpl
  });
}
