import { createModelCatalogue } from "../shared/model-catalogue.mjs";

const catalogue = createModelCatalogue();
export const BYOK_MODEL_PRESETS = catalogue.fallback;

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
  // A trusted extension settings save selects the model, not public catalogue membership.
  return Object.hasOwn(BYOK_MODEL_PRESETS, provider) && catalogue.validId(requested)
    ? requested
    : defaultByokModel(safeProvider);
}

export function supportsByokThinkHarder(provider, model) {
  const safeProvider = normaliseByokProvider(provider);
  const safeModel = normaliseByokModel(safeProvider, model);
  if (safeProvider === "openai") return safeModel === "gpt-5.6-luna" || /^gpt-6[.-]/.test(safeModel);
  if (safeProvider === "anthropic") return /^claude-(?:haiku|sonnet|opus)-5-5(?:-|$)/.test(safeModel);
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
