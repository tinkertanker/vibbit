export const BYOK_MODEL_PRESETS = Object.freeze({
  openai: Object.freeze([
    Object.freeze({ id: "gpt-5-mini", label: "GPT-5 Mini" }),
    Object.freeze({ id: "gpt-5.2", label: "GPT-5.2" }),
    Object.freeze({ id: "gpt-5.6-luna", label: "GPT-5.6 Luna", default: true })
  ]),
  gemini: Object.freeze([
    Object.freeze({ id: "gemini-3-flash-preview", label: "Gemini 3 Flash", default: true }),
    Object.freeze({ id: "gemini-3-pro-preview", label: "Gemini 3 Pro" }),
    Object.freeze({ id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro (Preview)" })
  ]),
  openrouter: Object.freeze([
    Object.freeze({ id: "openai/gpt-5.6-luna", label: "GPT-5.6 Luna", default: true }),
    Object.freeze({ id: "deepseek/deepseek-v4-flash-0731", label: "DeepSeek V4 Flash 0731" }),
    Object.freeze({ id: "xiaomi/mimo-v2.5", label: "MiMo-V2.5" }),
    Object.freeze({ id: "qwen/qwen3.8-27b", label: "Qwen3.8 27B" }),
    Object.freeze({ id: "tencent/hy3", label: "Hy3" })
  ]),
  opencode: Object.freeze([
    Object.freeze({ id: "go/responses/gpt-5.6-luna", label: "Go · GPT-5.6 Luna", default: true }),
    Object.freeze({ id: "go/deepseek-v4-flash", label: "Go · DeepSeek V4 Flash" }),
    Object.freeze({ id: "go/mimo-v2.5", label: "Go · MiMo-V2.5" }),
    Object.freeze({ id: "go/kimi-k3", label: "Go · Kimi K3" }),
    Object.freeze({ id: "go/glm-5.3", label: "Go · GLM-5.3" }),
    Object.freeze({ id: "go/hy3", label: "Go · Hy3" }),
    Object.freeze({ id: "go/responses/muse-spark-1.2-contributor", label: "Go · Muse Spark 1.2 Contributor (trains on data)" }),
    Object.freeze({ id: "zen/hy3-free", label: "Zen · Hy3 Free" }),
    Object.freeze({ id: "zen/big-pickle", label: "Zen · Big Pickle" }),
    Object.freeze({ id: "zen/nemotron-3-ultra-free", label: "Zen · Nemotron 3 Ultra Free" }),
    Object.freeze({ id: "zen/nemotron-3.5-lightning-free", label: "Zen · Nemotron 3.5 Lightning Free" })
  ])
});

export function normaliseByokProvider(value) {
  const provider = String(value || "").trim().toLowerCase();
  return Object.hasOwn(BYOK_MODEL_PRESETS, provider) ? provider : "openai";
}

export function defaultByokModel(provider) {
  const presets = BYOK_MODEL_PRESETS[normaliseByokProvider(provider)];
  const selected = presets.find((item) => item.default) || presets[0];
  return selected.id;
}

export function normaliseByokModel(provider, value) {
  const safeProvider = normaliseByokProvider(provider);
  const requested = String(value || "").trim();
  return BYOK_MODEL_PRESETS[safeProvider].some((item) => item.id === requested)
    ? requested
    : defaultByokModel(safeProvider);
}

export function supportsByokThinkHarder(provider, model) {
  const safeProvider = normaliseByokProvider(provider);
  const safeModel = normaliseByokModel(safeProvider, model);
  if (safeProvider === "openai") return safeModel === "gpt-5.6-luna";
  if (safeProvider === "gemini") return false;
  if (safeProvider === "openrouter") {
    return new Set([
      "openai/gpt-5.6-luna",
      "deepseek/deepseek-v4-flash-0731",
      "qwen/qwen3.8-27b",
      "tencent/hy3"
    ]).has(safeModel);
  }
  return safeProvider === "opencode";
}
