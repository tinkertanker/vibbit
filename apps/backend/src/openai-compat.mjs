/**
 * OpenAI-compatible chat completions helper.
 * Works with OpenAI, OpenRouter, LiteLLM, Anthropic OpenAI-compat proxies, and similar gateways.
 */

function joinChatCompletionsUrl(baseUrl) {
  const raw = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!raw) return "https://api.openai.com/v1/chat/completions";
  if (/\/chat\/completions$/i.test(raw)) return raw;
  return `${raw}/chat/completions`;
}

function transcriptOrPair(messages, system, user) {
  if (Array.isArray(messages) && messages.length) {
    return messages.map((item) => ({
      role: item && item.role ? String(item.role) : "user",
      content: item && item.content != null ? String(item.content) : ""
    }));
  }
  return [
    { role: "system", content: String(system || "") },
    { role: "user", content: String(user || "") }
  ];
}

export async function callOpenAICompatible({
  apiKey,
  baseUrl,
  model,
  system,
  user,
  messages,
  signal,
  temperature = 0.1,
  maxTokens = 3072,
  reasoning,
  fetchImpl = fetch
} = {}) {
  const key = String(apiKey || "").trim();
  if (!key) throw new Error("Missing API key for OpenAI-compatible endpoint");

  const url = joinChatCompletionsUrl(baseUrl);
  const body = {
    model: String(model || "").trim() || "gpt-4o-mini",
    max_tokens: maxTokens,
    messages: transcriptOrPair(messages, system, user)
  };
  if (!/(?:^|\/)gpt-5\.6-luna$/i.test(body.model)) body.temperature = temperature;
  if (reasoning && typeof reasoning === "object") body.reasoning = reasoning;

  const response = await fetchImpl(url, {
    method: "POST",
    signal,
    redirect: "manual",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + key
    },
    body: JSON.stringify(body)
  });

  if (response.status >= 300 && response.status < 400) {
    throw new Error("OpenAI-compatible endpoint returned a redirect, which is not allowed");
  }

  if (!response.ok) {
    let detail = "";
    try {
      const errBody = await response.text();
      detail = String(errBody || "").replace(/\s+/g, " ").trim().slice(0, 220);
    } catch {
      // ignore body parse failures
    }
    const suffix = detail ? `: ${detail}` : "";
    throw new Error(`OpenAI-compatible error (${response.status})${suffix}`);
  }

  const data = await response.json();
  return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
}

export async function callOpenAIResponsesCompatible({
  apiKey,
  baseUrl,
  model,
  system,
  user,
  messages,
  signal,
  temperature = 0.1,
  maxTokens = 3072,
  fetchImpl = fetch
} = {}) {
  const key = String(apiKey || "").trim();
  if (!key) throw new Error("Missing API key for OpenAI-compatible endpoint");

  const url = `${String(baseUrl || "").trim().replace(/\/+$/, "")}/responses`;
  const body = {
    model: String(model || "").trim(),
    max_output_tokens: maxTokens,
    input: transcriptOrPair(messages, system, user)
  };
  if (!/^gpt-/i.test(body.model)) body.temperature = temperature;
  if (/^gpt-6[.-]/.test(body.model)) body.reasoning = { effort: "low" };

  const response = await fetchImpl(url, {
    method: "POST",
    signal,
    redirect: "manual",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + key
    },
    body: JSON.stringify(body)
  });

  if (response.status >= 300 && response.status < 400) {
    throw new Error("OpenAI-compatible endpoint returned a redirect, which is not allowed");
  }
  if (!response.ok) {
    throw new Error(`OpenAI-compatible Responses error (${response.status})`);
  }

  const data = await response.json();
  if (typeof data.output_text === "string") return data.output_text;
  const output = Array.isArray(data.output) ? data.output : [];
  return output.flatMap((item) => Array.isArray(item && item.content) ? item.content : [])
    .map((item) => item && typeof item.text === "string" ? item.text : "")
    .join("");
}

export function providerConfigFromClassroom(classroom) {
  const model = String((classroom && classroom.model) || "gpt-6-luna").trim() || "gpt-6-luna";
  const apiKey = String((classroom && classroom.apiKey) || "").trim();
  const baseUrl = String((classroom && classroom.apiBaseUrl) || "https://api.openai.com/v1").trim();

  return {
    enabledProviders: ["openai"],
    defaultProvider: "openai",
    allowedModels: {},
    defaultModelFor: () => model,
    apiKeyFor: () => apiKey,
    baseUrlFor: () => baseUrl,
    classroomId: classroom && classroom.id ? classroom.id : "",
    source: "classroom"
  };
}
