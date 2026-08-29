import {
  DEFAULT_MAX_CURRENT_CODE_PROMPT_CHARS,
  buildSystemPrompt,
  buildUserPrompt,
  runGenerationLoop
} from "../shared/makecode-compat-core.mjs";
import {
  defaultByokModel,
  normaliseByokModel,
  normaliseByokProvider
} from "./byok-config.mjs";
import { callByokProvider, ProviderRequestError } from "./provider-transport.mjs";

export const BYOK_SESSION_STORAGE_KEY = "vibbitByokSessionV1";
const MAX_REQUEST_CHARS = 4000;
const MAX_CURRENT_CODE_CHARS = 50000;
const MAX_RECENT_CHAT_TURNS = 4;
const MAX_RECENT_CHAT_CHARS = 400;

function boundedText(value, max) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function sanitiseGeneratePayload(input) {
  const source = input && typeof input === "object" ? input : {};
  const allowedFields = new Set([
    "target",
    "request",
    "currentCode",
    "pageErrors",
    "conversionDialog",
    "recentChat"
  ]);
  if (Object.keys(source).some((key) => !allowedFields.has(key))) {
    throw new Error("unsupported_request_field");
  }
  const request = String(source.request || "").trim();
  const currentCode = String(source.currentCode || "");
  const pageErrors = (Array.isArray(source.pageErrors) ? source.pageErrors : [])
    .map((item) => boundedText(item, 500))
    .filter(Boolean)
    .slice(0, 8);
  const dialogSource = source.conversionDialog && typeof source.conversionDialog === "object"
    ? source.conversionDialog
    : null;
  const conversionDialog = dialogSource ? {
    title: boundedText(dialogSource.title, 220),
    description: boundedText(dialogSource.description, 1000)
  } : null;
  const recentChat = (Array.isArray(source.recentChat) ? source.recentChat : [])
    .slice(0, MAX_RECENT_CHAT_TURNS)
    .map((turn) => turn?.role === "assistant"
      ? { role: "assistant", notes: boundedText(turn.notes || turn.content, MAX_RECENT_CHAT_CHARS) }
      : { role: "user", content: boundedText(turn?.content, MAX_RECENT_CHAT_CHARS) })
    .filter((turn) => Boolean(turn.content || turn.notes));
  if (request.length > MAX_REQUEST_CHARS) throw new Error("request_too_large");
  if (currentCode.length > MAX_CURRENT_CODE_CHARS) throw new Error("current_code_too_large");
  if (!request && !pageErrors.length && !conversionDialog?.title && !conversionDialog?.description) {
    throw new Error("request_required");
  }
  return {
    target: ["microbit", "arcade", "maker"].includes(source.target) ? source.target : "microbit",
    request,
    currentCode,
    pageErrors,
    conversionDialog,
    recentChat
  };
}

function defaultState() {
  return {
    provider: "openai",
    model: defaultByokModel("openai"),
    thinkHarder: false,
    keys: {}
  };
}

export function createByokBroker({ storageArea, fetchImpl = fetch } = {}) {
  if (!storageArea?.get || !storageArea?.set) throw new Error("storageArea is required");

  async function readState() {
    const stored = await storageArea.get(BYOK_SESSION_STORAGE_KEY);
    const source = stored?.[BYOK_SESSION_STORAGE_KEY] || {};
    const provider = normaliseByokProvider(source.provider);
    const keys = source.keys && typeof source.keys === "object" ? source.keys : {};
    return {
      provider,
      model: normaliseByokModel(provider, source.model),
      thinkHarder: Boolean(source.thinkHarder),
      keys: Object.fromEntries(Object.entries(keys).map(([name, value]) => [
        normaliseByokProvider(name),
        String(value || "").trim()
      ]).filter(([, value]) => Boolean(value)))
    };
  }

  async function writeState(state) {
    await storageArea.set({ [BYOK_SESSION_STORAGE_KEY]: state });
  }

  async function publicConfig() {
    const state = await readState();
    return {
      provider: state.provider,
      model: state.model,
      thinkHarder: state.thinkHarder,
      hasKey: Boolean(state.keys[state.provider])
    };
  }

  return {
    publicConfig,
    async saveConfig(input = {}) {
      const state = await readState();
      const provider = normaliseByokProvider(input.provider ?? state.provider);
      const model = normaliseByokModel(provider, input.model ?? state.model);
      const next = {
        ...state,
        provider,
        model,
        thinkHarder: Boolean(input.thinkHarder)
      };
      if (Object.hasOwn(input, "apiKey")) {
        const apiKey = String(input.apiKey || "").trim();
        if (apiKey) next.keys[provider] = apiKey;
      }
      await writeState(next);
      return publicConfig();
    },
    async clearKey(providerValue) {
      const state = await readState();
      const provider = normaliseByokProvider(providerValue || state.provider);
      delete state.keys[provider];
      await writeState(state);
      return publicConfig();
    },
    async clearAll() {
      await writeState(defaultState());
      return publicConfig();
    },
    async generate(input, { signal, pageOrigin = "" } = {}) {
      const payload = sanitiseGeneratePayload(input);
      const state = await readState();
      const apiKey = state.keys[state.provider];
      if (!apiKey) throw new ProviderRequestError("missing_key");
      const systemPrompt = buildSystemPrompt(payload.target, { conversational: true });
      const initialUserPrompt = buildUserPrompt({
        ...payload,
        maxCurrentCodeChars: DEFAULT_MAX_CURRENT_CODE_PROMPT_CHARS
      });
      const result = await runGenerationLoop({
        target: payload.target,
        systemPrompt,
        initialUserPrompt,
        emptyRetries: 2,
        validationRetries: 2,
        maxAttempts: 3,
        callModel: (messages) => callByokProvider({
          provider: state.provider,
          model: state.model,
          apiKey,
          messages,
          thinkHarder: state.thinkHarder,
          signal,
          pageOrigin,
          fetchImpl
        })
      });
      const reasons = result.attempts.map((attempt) => attempt.reason);
      return {
        code: result.code,
        feedback: result.feedback,
        outcome: result.outcome,
        upstreamAttempts: result.upstreamAttempts,
        validationOk: result.outcome === "ok",
        trace: {
          attempts: reasons.length,
          firstFailure: reasons.find((reason) => reason !== "ok") || null,
          finalOutcome: result.outcome,
          validationMode: "static"
        }
      };
    }
  };
}

export function publicBrokerError(error) {
  if (error?.name === "AbortError") return { code: "cancelled", status: 0 };
  if (error instanceof ProviderRequestError) {
    return { code: error.code, status: error.status };
  }
  const code = [
    "request_too_large",
    "current_code_too_large",
    "request_required",
    "unsupported_request_field"
  ].includes(error?.message) ? error.message : "generation_failed";
  return { code, status: 0 };
}
