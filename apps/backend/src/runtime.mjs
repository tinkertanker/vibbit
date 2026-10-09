import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildSystemPrompt,
  buildUserPrompt,
  normaliseFeedback,
  runGenerationLoop,
  serializeTranscript
} from "../../../shared/makecode-compat-core.mjs";
import {
  joinHtmlResponse,
  renderJoinAvailablePage,
  renderJoinUnavailablePage,
  resolveJoinAvailability
} from "./join-page.mjs";
import { createTeacherPortal } from "./teacher-portal.mjs";
import { assertModelOverrideMatchesTestedProfile } from "./classroom-store.mjs";
import {
  createDeploymentPolicy,
  resolveRequestPublicOrigin,
  resolveTrustedClientIp
} from "./deployment-policy.mjs";
import { createOutboundUrlPolicy } from "./outbound-url-policy.mjs";
import {
  callManagedProvider,
  createProviderConfigFromCredentialProfile,
  resolveManagedBaseUrlForProvider
} from "./provider-registry.mjs";
import { createRateLimitController } from "./rate-limit.mjs";
import {
  TkslopperHttpError,
  TkslopperRefusalError,
  TkslopperUnavailableError,
  createAttemptBudget,
  createTkslopperClient,
  parseTkslopperConfig
} from "./tkslopper-client.mjs";
import { createUsageStore } from "./usage-store.mjs";
import { compileAndDecompile } from "../../../shared/makecode-decompile.mjs";
import { createModelCatalogue } from "../../../shared/model-catalogue.mjs";

const DEFAULT_FEEDBACK = "Model completed generation without explicit feedback notes.";
const TKSLOPPER_PROVIDER_LABEL = "managed";
const TKSLOPPER_REFUSAL_MESSAGE = "The AI service declined this request. Try rephrasing it.";
const TKSLOPPER_UNAVAILABLE_MESSAGE = "Managed AI is unavailable right now. Please try again later or ask your teacher.";
const SUPPORTED_PROVIDERS = ["openai", "anthropic", "gemini", "openrouter", "opencode"];
const DEFAULT_CORS_HEADERS = "Content-Type, Authorization, X-Vibbit-Class-Code, X-Vibbit-Session";
const MAX_JSON_BYTES = 256 * 1024;
const MAX_REQUEST_CHARS = 4000;
const MAX_CURRENT_CODE_CHARS = 50000;
const MAX_PAGE_ERROR_CHARS = 500;
const MAX_RECENT_CHAT_TURNS = 4;
const MAX_RECENT_CHAT_CHARS = 400;
const MAX_ORACLE_MISS_REASON_CHARS = 220;
const MAX_ORACLE_MISS_GREY_BLOCKS = 32;
// Hidden retries stay inside one reservation. Keep this cap until quota accounting changes.
const MAX_UPSTREAM_ATTEMPTS = 3;
const CLASS_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const CLASS_CODE_LENGTH = 10;
const BOOKMARKLET_RUNTIME_ROUTE = "/bookmarklet/runtime.js";
const BOOKMARKLET_INSTALL_ROUTE = "/bookmarklet";
const EXTENSION_DOWNLOAD_ROUTE = "/download/vibbit-extension.zip";
const DEFAULT_EXTENSION_DOWNLOAD_URL = "https://github.com/tinkertanker/vibbit/releases/latest/download/vibbit-extension.zip";
const WORK_JS_USERSCRIPT_HEADER_PATTERN = /^\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\s*/;
const WORK_JS_BACKEND_CONST_PATTERN = /const BACKEND = ".*?";/;
const WORK_JS_APP_TOKEN_CONST_PATTERN = /const APP_TOKEN = ".*?";/;

const runtimeFileDir = dirname(fileURLToPath(import.meta.url));
const FAVICON_SVG_PATH = resolve(runtimeFileDir, "../../../extension/icons/vibbit-frog.svg");
const ROOT_PACKAGE_JSON_PATH = resolve(runtimeFileDir, "../../../package.json");
let FAVICON_SVG = null;
try {
  FAVICON_SVG = readFileSync(FAVICON_SVG_PATH, "utf8");
} catch {
  // Extension icons may be missing when backend runs from a different context
}
let SHIPPED_EXTENSION_VERSION = "";
try {
  const parsedRootPackage = JSON.parse(readFileSync(ROOT_PACKAGE_JSON_PATH, "utf8"));
  SHIPPED_EXTENSION_VERSION = String(parsedRootPackage && parsedRootPackage.version || "").trim();
} catch {
  // Root package metadata may be unavailable in some backend-only contexts.
}
const WORK_JS_CANDIDATE_PATHS = [
  resolve(runtimeFileDir, "../../../work.js"),
  resolve(process.cwd(), "work.js"),
  resolve(process.cwd(), "../work.js"),
  resolve(process.cwd(), "../../work.js")
];

function parseInteger(value, fallback, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function parseBoolean(value, fallback) {
  if (typeof value === "boolean") return value;
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parseCsv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function firstHeaderToken(value) {
  return String(value || "")
    .split(",")[0]
    .trim();
}

function resolvePublicOrigin(request, requestUrl, deploymentPolicy) {
  if (deploymentPolicy) {
    return resolveRequestPublicOrigin(request, requestUrl, deploymentPolicy);
  }
  const forwardedProto = firstHeaderToken(request.headers.get("x-forwarded-proto")).toLowerCase();
  const forwardedHost = firstHeaderToken(request.headers.get("x-forwarded-host"));
  const protocol = (forwardedProto === "http" || forwardedProto === "https")
    ? forwardedProto
    : String((requestUrl && requestUrl.protocol) || "https:").replace(/:$/, "");
  const host = forwardedHost || firstHeaderToken(request.headers.get("host")) || requestUrl.host;
  return `${protocol || "https"}://${host}`;
}

function normaliseProvider(value) {
  return String(value || "").trim().toLowerCase();
}

function normaliseClassCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .slice(0, CLASS_CODE_LENGTH);
}

function randomBytes(length) {
  const size = Math.max(1, Number(length) || 1);
  const bytes = new Uint8Array(size);
  if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(bytes);
    return bytes;
  }
  for (let i = 0; i < size; i += 1) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  return bytes;
}

function bytesToBase64Url(bytes) {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
  }
  let binary = "";
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function createSessionToken() {
  return "vbt_" + bytesToBase64Url(randomBytes(24));
}

function generateClassCode(length) {
  const size = parseInteger(length, CLASS_CODE_LENGTH, { min: CLASS_CODE_LENGTH, max: CLASS_CODE_LENGTH });
  const bytes = randomBytes(size);
  let code = "";
  for (let i = 0; i < size; i += 1) {
    code += CLASS_CODE_ALPHABET[bytes[i] % CLASS_CODE_ALPHABET.length];
  }
  return code;
}

function generateClassCodeFromSeed(seed, length) {
  const source = String(seed || "");
  if (!source) return generateClassCode(length);
  const size = parseInteger(length, CLASS_CODE_LENGTH, { min: CLASS_CODE_LENGTH, max: CLASS_CODE_LENGTH });

  let state = 2166136261;
  for (let i = 0; i < source.length; i += 1) {
    state ^= source.charCodeAt(i);
    state = Math.imul(state, 16777619) >>> 0;
  }

  let code = "";
  for (let i = 0; i < size; i += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const index = (state >>> 0) % CLASS_CODE_ALPHABET.length;
    code += CLASS_CODE_ALPHABET[index];
  }
  return code;
}

function resolveModelForProvider(env, provider) {
  if (provider === "openai") return env.VIBBIT_OPENAI_MODEL || env.VIBBIT_MODEL || "gpt-6-luna";
  if (provider === "anthropic") return env.VIBBIT_ANTHROPIC_MODEL || env.VIBBIT_MODEL || "claude-haiku-5-5";
  if (provider === "gemini") return env.VIBBIT_GEMINI_MODEL || env.VIBBIT_MODEL || "gemini-2.5-flash";
  if (provider === "openrouter") return env.VIBBIT_OPENROUTER_MODEL || env.VIBBIT_MODEL || "openai/gpt-5.6-luna";
  if (provider === "opencode") return env.VIBBIT_OPENCODE_MODEL || env.VIBBIT_MODEL || "gpt-5.6-luna";
  return env.VIBBIT_MODEL || "gpt-6-luna";
}

function resolveKeyForProvider(env, provider) {
  if (provider === "openai") return env.VIBBIT_OPENAI_API_KEY || env.VIBBIT_API_KEY || "";
  if (provider === "anthropic") return env.VIBBIT_ANTHROPIC_API_KEY || "";
  if (provider === "gemini") return env.VIBBIT_GEMINI_API_KEY || env.VIBBIT_API_KEY || "";
  if (provider === "openrouter") return env.VIBBIT_OPENROUTER_API_KEY || env.VIBBIT_API_KEY || "";
  if (provider === "opencode") return env.VIBBIT_OPENCODE_API_KEY || env.VIBBIT_API_KEY || "";
  return env.VIBBIT_API_KEY || "";
}

function createProviderConfig(env) {
  const requestedProviders = parseCsv(env.VIBBIT_ENABLED_PROVIDERS).map(normaliseProvider);
  const enabledProviders = (requestedProviders.length ? requestedProviders : SUPPORTED_PROVIDERS)
    .filter((provider, index, list) => SUPPORTED_PROVIDERS.includes(provider) && list.indexOf(provider) === index);
  if (!enabledProviders.length) {
    throw new Error("No supported providers enabled. Configure VIBBIT_ENABLED_PROVIDERS.");
  }

  const requestedDefault = normaliseProvider(env.VIBBIT_PROVIDER || "openai");
  const defaultProvider = enabledProviders.includes(requestedDefault) ? requestedDefault : enabledProviders[0];
  const allowedModels = {};
  for (const provider of enabledProviders) {
    const envKey = `VIBBIT_${provider.toUpperCase()}_ALLOWED_MODELS`;
    allowedModels[provider] = parseCsv(env[envKey]);
  }

  return {
    enabledProviders,
    defaultProvider,
    defaultModelFor: (provider) => resolveModelForProvider(env, provider),
    apiKeyFor: (provider) => resolveKeyForProvider(env, provider),
    allowedModels
  };
}

function createEmptyAdminProviderState() {
  return {
    defaultProvider: "",
    models: {},
    apiKeys: {},
    updatedAt: ""
  };
}

function sanitiseAdminProviderState(input, enabledProviders) {
  const providers = Array.isArray(enabledProviders) && enabledProviders.length
    ? enabledProviders
    : SUPPORTED_PROVIDERS;
  const source = input && typeof input === "object" ? input : {};
  const state = createEmptyAdminProviderState();

  const requestedDefault = normaliseProvider(source.defaultProvider || "");
  if (requestedDefault && providers.includes(requestedDefault)) {
    state.defaultProvider = requestedDefault;
  }

  const sourceModels = source.models && typeof source.models === "object" ? source.models : {};
  for (const provider of providers) {
    const model = String(sourceModels[provider] || "").trim();
    if (model) state.models[provider] = model.slice(0, 160);
  }

  const sourceKeys = source.apiKeys && typeof source.apiKeys === "object" ? source.apiKeys : {};
  for (const provider of providers) {
    const key = String(sourceKeys[provider] || "").trim();
    if (key) state.apiKeys[provider] = key.slice(0, 4096);
  }

  state.updatedAt = String(source.updatedAt || "").trim();
  return state;
}

function hasAdminProviderOverrides(adminProviderState) {
  const state = adminProviderState || createEmptyAdminProviderState();
  return Boolean(
    state.defaultProvider
    || Object.keys(state.models || {}).length
    || Object.keys(state.apiKeys || {}).length
  );
}

function applyAdminProviderUpdate(existingState, updateInput, enabledProviders) {
  const providers = Array.isArray(enabledProviders) && enabledProviders.length
    ? enabledProviders
    : SUPPORTED_PROVIDERS;
  const existing = sanitiseAdminProviderState(existingState, providers);
  const update = updateInput && typeof updateInput === "object" ? updateInput : {};

  const next = {
    defaultProvider: existing.defaultProvider,
    models: { ...existing.models },
    apiKeys: { ...existing.apiKeys },
    updatedAt: new Date().toISOString()
  };

  const requestedDefault = normaliseProvider(update.defaultProvider || "");
  if (requestedDefault && providers.includes(requestedDefault)) {
    next.defaultProvider = requestedDefault;
  }

  for (const provider of providers) {
    const modelField = `${provider}Model`;
    const modelValue = String(update[modelField] || "").trim();
    if (modelValue) next.models[provider] = modelValue.slice(0, 160);

    const keyField = `${provider}ApiKey`;
    const keyValue = String(update[keyField] || "").trim();
    if (keyValue) next.apiKeys[provider] = keyValue.slice(0, 4096);
  }

  return sanitiseAdminProviderState(next, providers);
}

function buildEffectiveProviderConfig(baseProviderConfig, adminProviderStateInput) {
  const enabledProviders = Array.isArray(baseProviderConfig.enabledProviders)
    ? baseProviderConfig.enabledProviders.slice()
    : SUPPORTED_PROVIDERS.slice();
  const adminProviderState = sanitiseAdminProviderState(adminProviderStateInput, enabledProviders);

  const defaultProvider = adminProviderState.defaultProvider && enabledProviders.includes(adminProviderState.defaultProvider)
    ? adminProviderState.defaultProvider
    : baseProviderConfig.defaultProvider;

  return {
    enabledProviders,
    defaultProvider,
    allowedModels: baseProviderConfig.allowedModels || {},
    defaultModelFor: (provider) => {
      const safeProvider = normaliseProvider(provider);
      return adminProviderState.models[safeProvider] || baseProviderConfig.defaultModelFor(safeProvider);
    },
    apiKeyFor: (provider) => {
      const safeProvider = normaliseProvider(provider);
      return adminProviderState.apiKeys[safeProvider] || baseProviderConfig.apiKeyFor(safeProvider);
    },
    baseUrlFor: (provider) => resolveManagedBaseUrlForProvider(provider)
  };
}

function resolveProviderSelection(providerConfig, payloadProvider, payloadModel) {
  const requestedProvider = normaliseProvider(payloadProvider || providerConfig.defaultProvider);
  if (!providerConfig.enabledProviders.includes(requestedProvider)) {
    throw new Error(`Provider '${requestedProvider || payloadProvider}' is not enabled on this server.`);
  }

  const model = String(payloadModel || providerConfig.defaultModelFor(requestedProvider)).trim();
  const allowList = providerConfig.allowedModels[requestedProvider] || [];
  if (allowList.length && model && !allowList.includes(model)) {
    throw new Error(`Model '${model}' is not allowed for provider '${requestedProvider}'.`);
  }

  const key = providerConfig.apiKeyFor(requestedProvider);
  if (!key) {
    throw new Error(`Missing API key for provider '${requestedProvider}'. Configure provider key env vars or save keys in /admin.`);
  }

  return { provider: requestedProvider, model, key };
}

function createSessionStore(ttlMs) {
  const sessions = new Map();

  const pruneExpired = () => {
    const now = Date.now();
    for (const [token, entry] of sessions.entries()) {
      if (!entry || entry.expiresAt <= now) sessions.delete(token);
    }
  };

  const createSession = (meta = {}) => {
    pruneExpired();
    const token = createSessionToken();
    const expiresAt = Date.now() + ttlMs;
    sessions.set(token, {
      createdAt: Date.now(),
      expiresAt,
      meta
    });
    return { token, expiresAt };
  };

  const getSession = (token) => {
    if (!token) return null;
    pruneExpired();
    const entry = sessions.get(token);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      sessions.delete(token);
      return null;
    }
    return {
      token,
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt,
      meta: entry.meta
    };
  };

  const isValidSession = (token) => Boolean(getSession(token));

  return {
    createSession,
    getSession,
    isValidSession,
    pruneExpired,
    size: () => sessions.size
  };
}

function createRuntimeConfig(envInput = {}) {
  const env = envInput || {};
  const deployment = createDeploymentPolicy(env);
  const allowOrigin = deployment.allowOrigin;
  const requestTimeoutMs = parseInteger(env.VIBBIT_REQUEST_TIMEOUT_MS, 60000, { min: 5000, max: 180000 });
  const emptyRetries = parseInteger(env.VIBBIT_EMPTY_RETRIES, 2, { min: 0, max: 5 });
  const validationRetries = parseInteger(env.VIBBIT_VALIDATION_RETRIES, 2, { min: 0, max: 5 });
  const bookmarkletEnabled = parseBoolean(env.VIBBIT_BOOKMARKLET_ENABLED, true);
  const bookmarkletEnableByok = parseBoolean(
    env.VIBBIT_BOOKMARKLET_ENABLE_BYOK,
    true
  );
  const extensionDownloadUrl = String(
    env.VIBBIT_EXTENSION_DOWNLOAD_URL == null
      ? DEFAULT_EXTENSION_DOWNLOAD_URL
      : env.VIBBIT_EXTENSION_DOWNLOAD_URL
  ).trim();
  const providerConfig = createProviderConfig(env);
  const appToken = String(env.SERVER_APP_TOKEN || "").trim();
  if (deployment.isHosted && appToken) {
    throw new Error("Hosted mode rejects SERVER_APP_TOKEN. Use teacher classroom codes instead.");
  }

  const classroomEnabled = appToken
    ? false
    : parseBoolean(env.VIBBIT_CLASSROOM_ENABLED, true);
  if (deployment.isHosted && !classroomEnabled) {
    throw new Error("Hosted mode requires classroom auth. Do not set VIBBIT_CLASSROOM_ENABLED=false.");
  }
  const classCodeLength = parseInteger(env.VIBBIT_CLASSROOM_CODE_LENGTH, CLASS_CODE_LENGTH, {
    min: CLASS_CODE_LENGTH,
    max: CLASS_CODE_LENGTH
  });
  const configuredCode = normaliseClassCode(env.VIBBIT_CLASSROOM_CODE || "");
  const autoGenerateCode = parseBoolean(env.VIBBIT_CLASSROOM_CODE_AUTO, true);
  const classCodeSeed = String(
    env.VIBBIT_CLASSROOM_SEED
    || env.VIBBIT_API_KEY
    || env.VIBBIT_OPENAI_API_KEY
    || env.VIBBIT_GEMINI_API_KEY
    || env.VIBBIT_OPENROUTER_API_KEY
    || env.VIBBIT_OPENCODE_API_KEY
    || ""
  );
  const legacyCodesEnabled = deployment.legacyClassroomCodesEnabled;
  const classroomCode = classroomEnabled && legacyCodesEnabled
    ? (configuredCode || (autoGenerateCode ? generateClassCodeFromSeed(classCodeSeed, classCodeLength) : ""))
    : "";
  // Hosted mode uses teacher-minted codes only; legacy single-code mode is self-hosted.

  const sessionTtlMs = parseInteger(env.VIBBIT_SESSION_TTL_MS, 8 * 60 * 60 * 1000, {
    min: 5 * 60 * 1000,
    max: 7 * 24 * 60 * 60 * 1000
  });

  let authMode = "none";
  if (appToken) authMode = "app-token";
  else if (classroomEnabled || deployment.isHosted) authMode = "classroom";
  if (deployment.isHosted && authMode !== "classroom") {
    throw new Error("Hosted mode requires classroom auth.");
  }
  const tkslopper = parseTkslopperConfig(env, { isHosted: deployment.isHosted });

  return {
    allowOrigin,
    requestTimeoutMs,
    emptyRetries,
    validationRetries,
    bookmarkletEnabled,
    bookmarkletEnableByok,
    extensionDownloadUrl,
    providerConfig,
    appToken,
    authMode,
    classroomCode,
    classCodeLength,
    sessionTtlMs,
    deployment,
    tkslopper
  };
}

function isTkslopperClassroom(runtimeConfig, classroomId) {
  const tkslopper = runtimeConfig && runtimeConfig.tkslopper;
  if (!tkslopper || !tkslopper.enabled || !classroomId) return false;
  return tkslopper.allClassrooms || tkslopper.classroomIds.includes(String(classroomId));
}

function createTkslopperProviderConfig(tkslopper) {
  return {
    enabledProviders: [TKSLOPPER_PROVIDER_LABEL],
    defaultProvider: TKSLOPPER_PROVIDER_LABEL,
    allowedModels: {},
    defaultModelFor: () => tkslopper.alias,
    apiKeyFor: () => "",
    baseUrlFor: () => "",
    source: "tkslopper"
  };
}

function buildCorsHeaders(origin, config) {
  const requestOrigin = String(origin || "").trim().replace(/\/+$/, "");
  const configuredOrigins = parseCsv(config.allowOrigin)
    .map((item) => item.replace(/\/+$/, ""))
    .filter(Boolean);

  const headers = {
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": DEFAULT_CORS_HEADERS,
    // Required by Chromium private-network access preflights when the
    // extension/page calls a localhost backend from a secure origin.
    "Access-Control-Allow-Private-Network": "true",
    "Access-Control-Max-Age": "86400"
  };

  if (!configuredOrigins.length || configuredOrigins.includes("*")) {
    headers["Access-Control-Allow-Origin"] = "*";
    return headers;
  }

  // Explicit allow-list: echo only matching origins; never fall back to another origin.
  if (requestOrigin && configuredOrigins.includes(requestOrigin)) {
    headers["Access-Control-Allow-Origin"] = requestOrigin;
  }

  return headers;
}

function respondJson(status, body, origin, config) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...buildCorsHeaders(origin, config)
    }
  });
}

function respondHtml(status, html, origin, config) {
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      ...buildCorsHeaders(origin, config)
    }
  });
}

function respondJavaScript(status, source, origin, config, extraHeaders = {}) {
  return new Response(source, {
    status,
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      ...buildCorsHeaders(origin, config),
      ...extraHeaders
    }
  });
}

function respondSvg(status, svg, origin, config) {
  return new Response(svg, {
    status,
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "public, max-age=86400",
      ...buildCorsHeaders(origin, config)
    }
  });
}

function handleOptions(origin, config) {
  return new Response(null, {
    status: 204,
    headers: buildCorsHeaders(origin, config)
  });
}

async function readJson(request, maxBytes = MAX_JSON_BYTES) {
  const contentLength = Number(request.headers.get("content-length") || "");
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    const error = new Error("Payload too large");
    error.statusCode = 413;
    throw error;
  }

  if (request.body && typeof request.body.getReader === "function") {
    const reader = request.body.getReader();
    const decoder = new TextDecoder();
    let totalBytes = 0;
    let text = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        const error = new Error("Payload too large");
        error.statusCode = 413;
        throw error;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("Invalid JSON");
    }
  }

  const text = await request.text();
  const size = new TextEncoder().encode(text).length;
  if (size > maxBytes) {
    const error = new Error("Payload too large");
    error.statusCode = 413;
    throw error;
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Invalid JSON");
  }
}

async function readAdminProviderUpdate(request) {
  const contentType = String(request.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("application/json")) {
    return readJson(request, 64 * 1024);
  }

  if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    const payload = {};
    for (const [key, value] of form.entries()) {
      payload[key] = typeof value === "string" ? value : "";
    }
    return payload;
  }

  return readJson(request, 64 * 1024);
}

function withTimeout(promise, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const wrapped = promise(controller.signal)
    .finally(() => clearTimeout(timeoutId));

  return wrapped;
}

function userPromptFor(request, currentCode, pageErrors, conversionDialog, recentChat) {
  return buildUserPrompt({
    request,
    currentCode,
    pageErrors,
    conversionDialog,
    recentChat
  });
}

async function generateManaged(
  { target, request, currentCode, pageErrors, conversionDialog, provider, model, recentChat },
  runtimeConfig,
  providerConfig,
  { onUpstreamAttempt, outboundUrlPolicy, tkslopperClient, classroomId = "" } = {}
) {
  const effectiveProviderConfig = providerConfig || runtimeConfig.providerConfig;
  const useTkslopper = effectiveProviderConfig.source === "tkslopper";
  if (useTkslopper && !tkslopperClient) {
    throw new TkslopperUnavailableError({ phase: "config" });
  }
  const selected = useTkslopper
    ? null
    : resolveProviderSelection(effectiveProviderConfig, provider, model);
  const providerBaseUrl = !useTkslopper && typeof effectiveProviderConfig.baseUrlFor === "function"
    ? effectiveProviderConfig.baseUrlFor(selected.provider)
    : "";

  const system = buildSystemPrompt(target);
  const user = userPromptFor(
    request,
    currentCode || "",
    pageErrors || [],
    conversionDialog || null,
    recentChat || []
  );
  let providerCalls = 0;
  const maxAttempts = Math.min(
    MAX_UPSTREAM_ATTEMPTS,
    1 + (runtimeConfig.emptyRetries || 0) + (runtimeConfig.validationRetries || 0)
  );

  const fetchImpl = outboundUrlPolicy && typeof outboundUrlPolicy.fetchSafe === "function"
    ? (url, init) => outboundUrlPolicy.fetchSafe(url, init, { purpose: "managed provider endpoint" })
    : fetch;
  // The browser gives up on /vibbit/generate after 60 s, so managed-gateway
  // attempts share one wall-clock budget across the repair loop.
  const budget = useTkslopper
    ? createAttemptBudget({
      attemptTimeoutMs: runtimeConfig.tkslopper.attemptTimeoutMs,
      totalBudgetMs: runtimeConfig.tkslopper.totalBudgetMs,
      minAttemptMs: runtimeConfig.tkslopper.minAttemptMs
    })
    : null;

  const result = await runGenerationLoop({
    target,
    systemPrompt: system,
    initialUserPrompt: user,
    emptyRetries: runtimeConfig.emptyRetries || 0,
    validationRetries: runtimeConfig.validationRetries || 0,
    maxAttempts,
    runDecompile: (code, loopTarget) => compileAndDecompile({ code, target: loopTarget }),
    callModel: async (messages) => {
      if (providerCalls >= maxAttempts) {
        throw new Error("Upstream attempt limit reached");
      }
      const timeoutMs = budget ? budget.nextAttemptTimeoutMs() : runtimeConfig.requestTimeoutMs;
      providerCalls += 1;
      const attempt = providerCalls;
      try {
        const raw = await withTimeout(async (signal) => {
          if (useTkslopper) {
            return tkslopperClient.complete({ messages, signal, context: { classroomId, attempt } });
          }
          const flat = serializeTranscript(messages);
          return callManagedProvider({
            provider: selected.provider,
            apiKey: selected.key,
            model: selected.model,
            messages,
            system: flat.system,
            user: flat.user,
            signal,
            customBaseUrl: providerBaseUrl,
            fetchImpl
          });
        }, timeoutMs);
        if (typeof onUpstreamAttempt === "function") {
          await onUpstreamAttempt({ success: true, attempt: providerCalls });
        }
        return raw;
      } catch (error) {
        if (budget && error && error.name === "AbortError" && error.timeoutMs == null) {
          // Report the managed-gateway limit that fired, not VIBBIT_REQUEST_TIMEOUT_MS.
          try {
            error.timeoutMs = timeoutMs;
          } catch {
            // Frozen error objects keep the default message.
          }
        }
        if (typeof onUpstreamAttempt === "function") {
          await onUpstreamAttempt({ success: false, attempt: providerCalls, error });
        }
        throw error;
      }
    }
  });

  return {
    code: result.code,
    feedback: normaliseFeedback(result.feedback, DEFAULT_FEEDBACK),
    validation: result.validation,
    upstreamAttempts: result.upstreamAttempts,
    outcome: result.outcome,
    attempts: result.attempts
  };
}

function extractBearerToken(headerValue) {
  if (!headerValue) return "";
  const match = String(headerValue).match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : "";
}

function sanitiseRecentChat(raw) {
  if (!Array.isArray(raw)) return [];
  const turns = [];
  for (const item of raw) {
    if (turns.length >= MAX_RECENT_CHAT_TURNS) break;
    if (!item || typeof item !== "object") continue;
    const role = item.role === "assistant" ? "assistant" : (item.role === "user" ? "user" : "");
    if (!role) continue;
    const text = String(item.content || item.notes || "").replace(/\s+/g, " ").trim().slice(0, MAX_RECENT_CHAT_CHARS);
    if (!text) continue;
    if (role === "user") turns.push({ role, content: text });
    else turns.push({ role, notes: text });
  }
  return turns;
}

function sanitiseOracleMissPayload(payload) {
  const source = payload && typeof payload === "object" ? payload : {};
  const reason = String(source.reason || "").replace(/\s+/g, " ").trim().slice(0, MAX_ORACLE_MISS_REASON_CHARS);
  const greyRaw = Number(source.greyBlocks);
  const greyBlocks = Number.isFinite(greyRaw)
    ? Math.min(MAX_ORACLE_MISS_GREY_BLOCKS, Math.max(0, Math.trunc(greyRaw)))
    : 0;
  return { reason, greyBlocks };
}

function validatePayload(payload) {
  const target = payload && typeof payload.target === "string" ? payload.target.trim() : "";
  const request = payload && typeof payload.request === "string" ? payload.request.trim() : "";
  const currentCode = payload && typeof payload.currentCode === "string" ? payload.currentCode : "";
  const provider = payload && typeof payload.provider === "string" ? payload.provider.trim().toLowerCase() : "";
  const model = payload && typeof payload.model === "string" ? payload.model.trim() : "";
  const rawPageErrors = payload && Array.isArray(payload.pageErrors) ? payload.pageErrors : [];
  const pageErrors = rawPageErrors
    .map((item) => String(item || "").replace(/\s+/g, " ").trim().slice(0, MAX_PAGE_ERROR_CHARS))
    .filter(Boolean)
    .slice(0, 8);
  const rawConversionDialog = payload && payload.conversionDialog && typeof payload.conversionDialog === "object"
    ? payload.conversionDialog
    : null;
  const conversionDialog = rawConversionDialog
    ? {
      title: String(rawConversionDialog.title || "").replace(/\s+/g, " ").trim().slice(0, 220),
      description: String(rawConversionDialog.description || "").replace(/\s+/g, " ").trim().slice(0, 1000)
    }
    : null;
  const recentChat = sanitiseRecentChat(payload && payload.recentChat);

  const hasAutoFixContext = pageErrors.length > 0
    || (conversionDialog && (conversionDialog.title || conversionDialog.description));
  if (!request && !hasAutoFixContext) {
    return { ok: false, error: "'request' is required" };
  }
  if (request.length > MAX_REQUEST_CHARS) {
    return { ok: false, error: `'request' must be at most ${MAX_REQUEST_CHARS} characters` };
  }
  if (currentCode.length > MAX_CURRENT_CODE_CHARS) {
    return { ok: false, error: `'currentCode' must be at most ${MAX_CURRENT_CODE_CHARS} characters` };
  }

  const safeTarget = ["microbit", "arcade", "maker"].includes(target) ? target : "microbit";

  return {
    ok: true,
    value: {
      target: safeTarget,
      request,
      currentCode,
      pageErrors,
      conversionDialog,
      recentChat,
      provider,
      model
    }
  };
}

function getAuthMode(runtimeConfig) {
  return runtimeConfig.authMode || "none";
}

function getPublicServerConfig(runtimeConfig, effectiveProviderConfig = runtimeConfig.providerConfig) {
  const defaultProvider = effectiveProviderConfig.defaultProvider;
  return {
    authMode: getAuthMode(runtimeConfig),
    classCodeRequired: getAuthMode(runtimeConfig) === "classroom",
    classCodeLength: runtimeConfig.classCodeLength,
    enabledProviders: effectiveProviderConfig.enabledProviders,
    defaultProvider,
    defaultModel: effectiveProviderConfig.defaultModelFor(defaultProvider),
    bookmarkletEnabled: Boolean(runtimeConfig.bookmarkletEnabled),
    bookmarkletByokEnabled: Boolean(runtimeConfig.bookmarkletEnableByok),
    bookmarkletInstallPath: BOOKMARKLET_INSTALL_ROUTE,
    extensionDownloadEnabled: Boolean(runtimeConfig.extensionDownloadUrl),
    extensionDownloadPath: EXTENSION_DOWNLOAD_ROUTE
  };
}

function buildAdminStatus(runtimeConfig, sessionStore, adminProviderState) {
  const effectiveProviderConfig = buildEffectiveProviderConfig(runtimeConfig.providerConfig, adminProviderState);
  const status = {
    ok: true,
    timestamp: new Date().toISOString(),
    ...getPublicServerConfig(runtimeConfig, effectiveProviderConfig),
    allowOrigin: runtimeConfig.allowOrigin,
    activeSessions: sessionStore.size(),
    bookmarklet: {
      enabled: Boolean(runtimeConfig.bookmarkletEnabled),
      byokEnabled: Boolean(runtimeConfig.bookmarkletEnableByok),
      installPath: BOOKMARKLET_INSTALL_ROUTE,
      runtimePath: BOOKMARKLET_RUNTIME_ROUTE
    },
    extension: {
      enabled: Boolean(runtimeConfig.extensionDownloadUrl),
      downloadPath: EXTENSION_DOWNLOAD_ROUTE,
      downloadTarget: runtimeConfig.extensionDownloadUrl || null
    }
  };

  const providerModels = {};
  const providerKeyConfigured = {};
  const providerKeySource = {};
  for (const provider of effectiveProviderConfig.enabledProviders) {
    providerModels[provider] = effectiveProviderConfig.defaultModelFor(provider);
    const hasAdminKey = Boolean(adminProviderState && adminProviderState.apiKeys && adminProviderState.apiKeys[provider]);
    const hasEnvKey = Boolean(runtimeConfig.providerConfig.apiKeyFor(provider));
    providerKeyConfigured[provider] = hasAdminKey || hasEnvKey;
    providerKeySource[provider] = hasAdminKey ? "admin" : (hasEnvKey ? "env" : "missing");
  }

  status.providerModels = providerModels;
  status.providerKeyConfigured = providerKeyConfigured;
  status.providerKeySource = providerKeySource;
  status.managedGateway = {
    enabled: Boolean(runtimeConfig.tkslopper && runtimeConfig.tkslopper.enabled)
  };
  status.adminProviderConfig = {
    hasOverrides: hasAdminProviderOverrides(adminProviderState),
    updatedAt: adminProviderState && adminProviderState.updatedAt ? adminProviderState.updatedAt : null
  };

  if (getAuthMode(runtimeConfig) === "classroom") {
    status.classCode = runtimeConfig.classroomCode;
  }

  return status;
}

function providerDisplayName(provider) {
  if (provider === "openai") return "OpenAI";
  if (provider === "anthropic") return "Anthropic (Claude)";
  if (provider === "openrouter") return "OpenRouter";
  if (provider === "opencode") return "OpenCode";
  if (provider === "gemini") return "Gemini";
  return provider;
}

function buildAdminAuthQuery(requestUrl, extras = {}) {
  const params = new URLSearchParams();
  const admin = String(requestUrl.searchParams.get("admin") || "").trim();
  if (admin) params.set("admin", admin);
  for (const [key, value] of Object.entries(extras || {})) {
    if (value == null) continue;
    const text = String(value).trim();
    if (!text) continue;
    params.set(key, text);
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderLandingPage({
  extensionDownloadEnabled,
  bookmarkletEnabled,
  bookmarkletHref
} = {}) {
  const repoUrl = "https://github.com/tinkertanker/vibbit";
  const releasesUrl = "https://github.com/tinkertanker/vibbit/releases";
  const tinkercademyUrl = "https://tinkercademy.com";
  const slidesUrl = "https://1drv.ms/p/c/21dfaef5d0fccb4a/IQAKZM4cKK8zRYasGC45G6yvAcUdrDNoPAOGWaeOajftVtA";
  const installUrl = EXTENSION_DOWNLOAD_ROUTE;
  const canDownloadExtension = Boolean(extensionDownloadEnabled);
  const canUseBookmarklet = Boolean(bookmarkletEnabled);
  const canDragInstallBookmarklet = canUseBookmarklet && Boolean(String(bookmarkletHref || "").trim());
  const extensionPrimaryAction = canDownloadExtension
    ? `<a class="action action-primary" href="${escapeHtml(installUrl)}">Download Chrome extension (.zip)</a>`
    : `<a class="action action-primary" href="${escapeHtml(releasesUrl)}" target="_blank" rel="noreferrer">Open GitHub releases</a>`;
  const extensionInstallCopy = canDownloadExtension
    ? "Not on Chrome Web Store yet; unzip the file and load it in Chrome via <code>chrome://extensions</code> with <strong>Developer mode</strong> enabled."
    : "Direct extension download is not enabled on this server. Use GitHub releases for the latest packaged build.";
  const bookmarkletPanel = canUseBookmarklet
    ? `
        <div class="bookmarklet-inline">
          <h3>Bookmarklet option</h3>
                <p>Prefer not to install an extension? Drag this to your bookmarks bar and click on it to activate in MakeCode.</p>
          <div class="cta-row">
            ${canDragInstallBookmarklet
              ? `<a class="action action-secondary" href="${escapeHtml(bookmarkletHref)}">Vibbit</a>`
              : `<a href="${escapeHtml(BOOKMARKLET_INSTALL_ROUTE)}">Open bookmarklet installer</a>`}
          </div>
        </div>
      `
    : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="icon" type="image/svg+xml" href="favicon.svg" />
    <title>Vibbit</title>
    <style>
      :root {
        color-scheme: dark;
        --bg-1: #0b1220;
        --bg-2: #121f38;
        --panel: #0d1b31;
        --text: #e8eefc;
        --muted: #b9c9e5;
        --link: #7ec8ff;
        --line: rgba(158, 186, 228, 0.28);
        --accent: #77c7ff;
        --accent-strong: #59b4ff;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        font: 16px/1.5 "Avenir Next", "Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif;
        background:
          radial-gradient(circle at 8% 0%, #1a2e56 0%, rgba(26, 46, 86, 0) 46%),
          radial-gradient(circle at 100% 100%, #173058 0%, rgba(23, 48, 88, 0) 44%),
          linear-gradient(160deg, var(--bg-2), var(--bg-1));
        color: var(--text);
      }
      main {
        width: min(1080px, 94vw);
        padding: clamp(1.25rem, 2.6vw, 2.25rem);
        border-radius: 1.2rem;
        background: linear-gradient(180deg, rgba(13, 27, 49, 0.95), rgba(9, 20, 39, 0.98));
        border: 1px solid var(--line);
        box-shadow: 0 24px 56px rgba(0, 0, 0, 0.36);
      }
      h1 { margin: 0; font-size: clamp(2rem, 5.6vw, 3.2rem); line-height: 1.08; }
      h2 { margin: 0 0 0.45rem; font-size: 1.2rem; }
      h3 { margin: 0 0 0.35rem; font-size: 1rem; }
      p { margin: 0; color: var(--muted); }
      a { color: var(--link); text-decoration: none; }
      a:hover { text-decoration: underline; }
      .hero {
        display: grid;
        gap: 1.1rem;
      }
      .brand {
        display: flex;
        align-items: center;
        gap: 0.75rem;
      }
      .brand svg { flex-shrink: 0; }
      .intro {
        max-width: 100%;
        font-size: 1.1rem;
      }
      .grid {
        margin-top: 1.4rem;
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 1rem;
      }
      .panel {
        background: linear-gradient(180deg, rgba(18, 39, 68, 0.8), rgba(13, 28, 50, 0.82));
        border: 1px solid var(--line);
        border-radius: 0.95rem;
        padding: 1.15rem;
      }
      .panel p + p { margin-top: 0.55rem; }
      .list {
        list-style: none;
        margin: 0.8rem 0 0;
        padding: 0;
      }
      .list li { margin: 0.52rem 0; }
      .row { display: inline-flex; align-items: center; gap: 0.45rem; }
      .muted { color: var(--muted); }
      .cta-row {
        margin-top: 0.8rem;
        margin-bottom: 1rem;
        display: flex;
        flex-wrap: wrap;
        gap: 0.6rem;
      }
      .action {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 0.4rem;
        border-radius: 0.64rem;
        border: 1px solid transparent;
        padding: 0.6rem 0.88rem;
        font-weight: 600;
        font-family: inherit;
        font-size: 1rem;
        line-height: 1.25;
      }
      .action:hover { text-decoration: none; }
      .action-primary {
        color: #061a30;
        background: linear-gradient(180deg, var(--accent), var(--accent-strong));
        border-color: rgba(150, 220, 255, 0.45);
      }
      .action-primary:hover { filter: brightness(1.04); }
      .action-secondary {
        color: var(--text);
        background: rgba(126, 200, 255, 0.16);
        border-color: rgba(126, 200, 255, 0.4);
      }
      .action-secondary:hover {
        background: rgba(126, 200, 255, 0.24);
      }
      code {
        border-radius: 0.4rem;
        padding: 0.12rem 0.34rem;
        background: rgba(8, 18, 34, 0.95);
        border: 1px solid rgba(106, 145, 198, 0.45);
        color: #dbe9ff;
      }
      .bookmarklet-inline {
        margin-top: 1rem;
        border-top: 1px solid rgba(126, 200, 255, 0.28);
        padding-top: 0.8rem;
      }
      .bookmarklet-inline p {
        margin-top: 0.35rem;
      }
      .project-note {
        margin-top: 1rem;
        color: var(--muted);
      }
      @media (max-width: 860px) {
        .grid { grid-template-columns: 1fr; }
        .panel-install { order: -1; }
      }
    </style>
  </head>
  <body>
    <main>
      <section class="hero">
        <div class="brand">
          <svg width="56" height="56" viewBox="0 0 128 128" role="img" aria-label="Vibbit frog icon" fill="none" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <linearGradient id="frog-gradient" x1="20" y1="22" x2="108" y2="108" gradientUnits="userSpaceOnUse">
                <stop offset="0" stop-color="#34D399"/>
                <stop offset="1" stop-color="#16A34A"/>
              </linearGradient>
              <mask id="frog-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="128" height="128">
                <rect width="128" height="128" fill="black"/>
                <g transform="translate(64 64) scale(1.2) translate(-64 -64)">
                  <g fill="white">
                    <circle cx="64" cy="68" r="36"/>
                    <circle cx="44" cy="38" r="15.4"/>
                    <circle cx="84" cy="38" r="15.4"/>
                    <path d="M25 104C25 90 31 84 40 84C49 84 55 90 55 104Z"/>
                    <path d="M73 104C73 90 79 84 88 84C97 84 103 90 103 104Z"/>
                  </g>
                  <circle cx="44" cy="38" r="5.5" fill="black"/>
                  <circle cx="84" cy="38" r="5.5" fill="black"/>
                  <path d="M55 104C55 98 59 93 64 93C69 93 73 98 73 104Z" fill="black"/>
                  <path d="M64 44.7L69 55.5L79.8 61.3L69 67.1L64 77.9L59 67.1L48.2 61.3L59 55.5L64 44.7Z" fill="black"/>
                </g>
              </mask>
            </defs>
            <rect width="128" height="128" fill="url(#frog-gradient)" mask="url(#frog-mask)"/>
          </svg>
          <h1>Vibbit</h1>
        </div>
        <p class="intro">Vibbit is an AI coding assistant for micro:bit MakeCode, available as a Chrome extension and bookmarklet, with both managed backend mode and BYOK provider support.</p>
        <div class="cta-row">
          <a class="action action-primary" href="/teacher">Teacher portal</a>
          ${canUseBookmarklet
            ? `<a class="action action-secondary" href="${escapeHtml(BOOKMARKLET_INSTALL_ROUTE)}">Bookmarklet</a>`
            : ""}
        </div>
        <p style="color: var(--muted);">Teachers sign in, add an OpenAI-compatible API key, and mint a classroom code for students.</p>
      </section>

      <section class="grid">
        <article class="panel">
          <h2>Info and resources</h2>
          <ul class="list">
            <li>
              <a class="row" href="${escapeHtml(repoUrl)}" target="_blank" rel="noreferrer">
                <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.5-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.01.08-2.1 0 0 .67-.21 2.2.82a7.49 7.49 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.09.16 1.9.08 2.1.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>
                tinkertanker/vibbit on GitHub
              </a>
            </li>
            <li><a href="${escapeHtml(releasesUrl)}" target="_blank" rel="noreferrer">GitHub releases</a></li>
            ${SHIPPED_EXTENSION_VERSION
              ? `<li>Current version: <code>v${escapeHtml(SHIPPED_EXTENSION_VERSION)}</code></li>`
              : ""}
            <li>
              <a class="row" href="${escapeHtml(slidesUrl)}" target="_blank" rel="noreferrer">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M4 3h12a2 2 0 0 1 2 2v2h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm2 12h10V5H4v10h2Zm2 4h12V9H8v10Zm2-8h8v2h-8v-2Z"/></svg>
                Launch slides from micro:bit Live Global 2026
              </a>
            </li>
          </ul>
        </article>

        <article class="panel panel-install">
          <h2>Install Vibbit</h2>
          <div class="cta-row">
            ${extensionPrimaryAction}
          </div>
          <p>${extensionInstallCopy}</p>
          ${bookmarkletPanel}
        </article>
      </section>
      <p class="project-note">A project by <a href="${escapeHtml(tinkercademyUrl)}" target="_blank" rel="noreferrer">Tinkercademy</a> from Singapore.</p>
    </main>
  </body>
</html>`;
}

function escapeTextarea(value) {
  return String(value ?? "").replace(/<\/textarea/gi, "<\\/textarea");
}

function renderBookmarkletInstallPage({ bookmarkletHref, runtimeUrl, byokEnabled }) {

  return [
    "<!doctype html>",
    "<html lang=\"en\">",
    "<head>",
    "<meta charset=\"utf-8\">",
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    "<link rel=\"icon\" type=\"image/svg+xml\" href=\"favicon.svg\">",
    "<title>Vibbit Bookmarklet</title>",
    "<style>",
    "body{margin:0;background:#0b1324;color:#e6edf8;font:14px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif}",
    ".wrap{max-width:980px;margin:32px auto;padding:0 16px}",
    ".card{background:#111b33;border:1px solid #243152;border-radius:12px;padding:16px;margin-bottom:14px}",
    "h1{margin:0 0 6px;font-size:24px}",
    "h2{margin:0 0 8px;font-size:17px}",
    "p{margin:8px 0;color:#c0cee8}",
    ".bookmarklet{display:inline-block;padding:10px 14px;border-radius:10px;background:#2b6de8;color:#fff;text-decoration:none;font-weight:600}",
    ".bookmarklet:hover{background:#245fd0}",
    "code,textarea{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace}",
    "textarea{width:100%;min-height:84px;box-sizing:border-box;border:1px solid #2a3a5f;border-radius:8px;background:#091127;color:#e6edf8;padding:10px}",
    "ol{margin:8px 0 0 20px;color:#c0cee8}",
    "li{margin:4px 0}",
    "</style>",
    "</head>",
    "<body>",
    "<main class=\"wrap\">",
    "<section class=\"card\">",
    "<h1>Install Vibbit Bookmarklet</h1>",
    "<p>This page is hosted by your Vibbit backend, so students can launch Vibbit without installing a browser extension.</p>",
    "<ol>",
    "<li>Show the bookmarks bar in your browser.</li>",
    "<li>Drag the bookmarklet button below into the bookmarks bar.</li>",
    "<li>Open a MakeCode project page and click the bookmark.</li>",
    "</ol>",
    "</section>",
    "<section class=\"card\">",
    "<h2>Vibbit bookmarklet</h2>",
    byokEnabled
      ? "<p>Choose managed or BYOK mode once Vibbit opens.</p>"
      : "<p>This bookmarklet uses managed mode.</p>",
    `<p><a class="bookmarklet" href="${escapeHtml(bookmarkletHref)}">Vibbit</a></p>`,
    `<textarea readonly>${escapeTextarea(bookmarkletHref)}</textarea>`,
    "</section>",
    "<section class=\"card\">",
    "<h2>Runtime URL</h2>",
    `<p><code>${escapeHtml(runtimeUrl)}</code></p>`,
    "</section>",
    "</main>",
    "</body>",
    "</html>"
  ].join("");
}

function renderAdminPanel(runtimeConfig, sessionStore, requestUrl, adminProviderState, adminAuthToken, modelPresets, managedModelLabel, modelCatalogue) {
  const status = buildAdminStatus(runtimeConfig, sessionStore, adminProviderState);
  const authHint = adminAuthToken
    ? "Admin token auth is enabled. Open this page with <code>?admin=...</code>, or send <code>X-Vibbit-Admin-Token</code>, or <code>Authorization: Bearer ...</code>."
    : "Admin auth token is not configured.";

  const authQuery = buildAdminAuthQuery(requestUrl);
  const baseUrl = `${requestUrl.origin}`;
  const healthzUrl = `${baseUrl}/healthz`;
  const configUrl = `${baseUrl}/vibbit/config`;
  const statusUrl = `${baseUrl}/admin/status${authQuery}`;
  const saveConfigUrl = `${baseUrl}/admin/config${authQuery}`;
  const bookmarkletUrl = `${baseUrl}${BOOKMARKLET_INSTALL_ROUTE}`;
  const extensionDownloadUrl = `${baseUrl}${EXTENSION_DOWNLOAD_ROUTE}`;
  const saveNotice = requestUrl.searchParams.get("saved") === "1"
    ? "<p class=\"notice\">Provider settings saved.</p>"
    : "";

  const defaultProviderOptions = status.enabledProviders.map((provider) => {
    const selected = provider === status.defaultProvider ? " selected" : "";
    return `<option value="${escapeHtml(provider)}"${selected}>${escapeHtml(providerDisplayName(provider))}</option>`;
  }).join("");

  const providerSetupRows = status.enabledProviders.map((provider) => {
    const providerName = providerDisplayName(provider);
    const modelValue = status.providerModels && status.providerModels[provider]
      ? status.providerModels[provider]
      : "";
    const keyConfigured = Boolean(status.providerKeyConfigured && status.providerKeyConfigured[provider]);
    const keySource = status.providerKeySource && status.providerKeySource[provider]
      ? status.providerKeySource[provider]
      : "missing";
    return [
      "<div class=\"metric\">",
      `<div class=\"label\">${escapeHtml(providerName)} model</div>`,
      `<input class=\"input\" type=\"text\" name="${escapeHtml(provider)}Model" list="models-${escapeHtml(provider)}" value="${escapeHtml(modelValue)}" placeholder="Model id">`,
      `<datalist id="models-${escapeHtml(provider)}">${(modelPresets[provider] || []).map((model) => `<option value="${escapeHtml(model.id)}">${escapeHtml(model.label)}</option>`).join("")}</datalist>`,
      "</div>",
      "<div class=\"metric\">",
      `<div class=\"label\">${escapeHtml(providerName)} API key (${escapeHtml(keyConfigured ? `configured via ${keySource}` : "missing")})</div>`,
      `<input class=\"input\" type=\"password\" name="${escapeHtml(provider)}ApiKey" placeholder="${escapeHtml(keyConfigured ? "Leave blank to keep current key" : "Paste API key")}" autocomplete="off">`,
      "</div>"
    ].join("");
  }).join("");

  return [
    "<!doctype html>",
    "<html lang=\"en\">",
    "<head>",
    "<meta charset=\"utf-8\">",
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    "<link rel=\"icon\" type=\"image/svg+xml\" href=\"favicon.svg\">",
    "<title>Vibbit Backend Admin</title>",
    "<style>",
    "body{margin:0;background:#0b1324;color:#e6edf8;font:14px/1.45 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif}",
    ".wrap{max-width:980px;margin:32px auto;padding:0 16px}",
    ".card{background:#111b33;border:1px solid #243152;border-radius:12px;padding:16px;margin-bottom:14px}",
    "h1{margin:0 0 4px;font-size:22px}",
    "h2{margin:0 0 10px;font-size:16px}",
    "p{margin:6px 0;color:#c0cee8}",
    "code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace}",
    "pre{margin:0;padding:14px;background:#0a1222;border:1px solid #1d2a47;border-radius:10px;overflow:auto;color:#d7e3ff}",
    "a{color:#9ec3ff;text-decoration:none}",
    "a:hover{text-decoration:underline}",
    ".grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}",
    ".metric{background:#0b162b;border:1px solid #1d2b49;border-radius:10px;padding:10px}",
    ".label{font-size:12px;color:#9eb1d6;margin-bottom:6px}",
    ".value{font-size:15px;font-weight:600;color:#f4f8ff}",
    ".input,.select{width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #2a3a5f;border-radius:8px;background:#091127;color:#e6edf8}",
    ".btn{margin-top:12px;background:#2b6de8;color:#fff;border:none;border-radius:8px;padding:9px 14px;font-weight:600;cursor:pointer}",
    ".btn:hover{background:#245fd0}",
    ".notice{display:inline-block;background:#0f2a1f;border:1px solid #1f6542;color:#b8f5d3;border-radius:8px;padding:7px 10px}",
    "</style>",
    "</head>",
    "<body>",
    "<main class=\"wrap\">",
    "<div class=\"card\">",
    "<h1>Vibbit Backend Admin</h1>",
    `<p>${authHint}</p>`,
    "</div>",
    "<div class=\"card\">",
    "<h2>Server Status</h2>",
    "<div class=\"grid\">",
    `<div class=\"metric\"><div class=\"label\">Auth mode</div><div class=\"value\">${escapeHtml(status.authMode)}</div></div>`,
    `<div class=\"metric\"><div class=\"label\">Default provider</div><div class=\"value\">${escapeHtml(status.defaultProvider)}</div></div>`,
    `<div class=\"metric\"><div class=\"label\">Default model</div><div class=\"value\">${escapeHtml(modelCatalogue.labelFor(status.defaultModel))}</div></div>`,
    managedModelLabel ? `<div class="metric"><div class="label">Managed gateway model</div><div class="value">${escapeHtml(managedModelLabel)}</div></div>` : "",
    `<div class=\"metric\"><div class=\"label\">Active sessions</div><div class=\"value\">${escapeHtml(status.activeSessions)}</div></div>`,
    "</div>",
    "</div>",
    "<div class=\"card\">",
    "<h2>Provider Setup</h2>",
    "<p>You can configure provider defaults and API keys here. Leave API key fields blank to keep the current value.</p>",
    "<p>Muse Contributor trains on submitted data. Choose it only if your school permits this.</p>",
    saveNotice,
    `<form method="POST" action="${escapeHtml(saveConfigUrl)}">`,
    "<div class=\"grid\">",
    "<div class=\"metric\">",
    "<div class=\"label\">Default provider</div>",
    `<select class="select" name="defaultProvider">${defaultProviderOptions}</select>`,
    "</div>",
    providerSetupRows,
    "</div>",
    "<button class=\"btn\" type=\"submit\">Save provider settings</button>",
    "</form>",
    "</div>",
    "<div class=\"card\">",
    "<h2>Quick Links</h2>",
    `<p><a href="${escapeHtml(healthzUrl)}" target="_blank" rel="noreferrer">/healthz</a></p>`,
    `<p><a href="${escapeHtml(configUrl)}" target="_blank" rel="noreferrer">/vibbit/config</a></p>`,
    `<p><a href="${escapeHtml(bookmarkletUrl)}" target="_blank" rel="noreferrer">${BOOKMARKLET_INSTALL_ROUTE}</a></p>`,
    `<p><a href="${escapeHtml(extensionDownloadUrl)}" target="_blank" rel="noreferrer">${EXTENSION_DOWNLOAD_ROUTE}</a></p>`,
    `<p><a href="${escapeHtml(statusUrl)}" target="_blank" rel="noreferrer">/admin/status</a></p>`,
    "</div>",
    "<div class=\"card\">",
    "<h2>Admin JSON</h2>",
    `<pre>${escapeHtml(JSON.stringify(status, null, 2))}</pre>`,
    "</div>",
    "</main>",
    "</body>",
    "</html>"
  ].join("");
}

function isAdminRequestAuthorised(request, runtimeConfig, requestUrl, adminAuthToken) {
  const configuredAdminToken = String(adminAuthToken || "").trim();
  if (configuredAdminToken) {
    const headerToken = String(request.headers.get("x-vibbit-admin-token") || "").trim();
    const queryToken = String(requestUrl.searchParams.get("admin") || "").trim();
    const legacyQueryToken = String(requestUrl.searchParams.get("token") || "").trim();
    const bearer = extractBearerToken(request.headers.get("authorization"));
    const candidate = headerToken || queryToken || legacyQueryToken || bearer;
    return Boolean(candidate && candidate === configuredAdminToken);
  }

  return getAuthMode(runtimeConfig) === "none";
}

function isClassroomCodeValid(candidate, runtimeConfig) {
  if (!runtimeConfig.classroomCode) return false;
  return normaliseClassCode(candidate) === runtimeConfig.classroomCode;
}

function getRequestSession(request, sessionStore) {
  const authHeader = request.headers.get("authorization");
  const bearer = extractBearerToken(authHeader);
  const sessionHeader = String(request.headers.get("x-vibbit-session") || "").trim();
  // Prefer Authorization bearer (client contract) so a forged x-vibbit-session
  // cannot switch the rate-limit bucket away from the authenticated session.
  return sessionStore.getSession(bearer) || sessionStore.getSession(sessionHeader) || null;
}

function isGenerateRequestAuthorised(request, runtimeConfig, sessionStore) {
  const authMode = getAuthMode(runtimeConfig);
  if (authMode === "none") return true;

  const authHeader = request.headers.get("authorization");
  const bearer = extractBearerToken(authHeader);

  if (authMode === "app-token") {
    return Boolean(bearer && bearer === runtimeConfig.appToken);
  }

  if (authMode === "classroom") {
    return Boolean(getRequestSession(request, sessionStore));
  }

  return false;
}

function buildStartupInfo(runtimeConfig, { listenUrl, effectiveProviderConfig } = {}) {
  const providerConfig = effectiveProviderConfig || runtimeConfig.providerConfig;
  const deployment = runtimeConfig.deployment || {};
  const info = [
    `[Vibbit backend] Deployment mode=${deployment.mode || "self-hosted"}`,
    `[Vibbit backend] Provider=${providerConfig.defaultProvider} model=${providerConfig.defaultModelFor(providerConfig.defaultProvider)}`,
    `[Vibbit backend] Enabled providers=${providerConfig.enabledProviders.join(", ")}`,
    `[Vibbit backend] Auth mode=${getAuthMode(runtimeConfig)}`
  ];
  if (listenUrl) info.unshift(`[Vibbit backend] Listening on ${listenUrl}`);
  if (deployment.publicOrigin) {
    info.push(`[Vibbit backend] Public origin=${deployment.publicOrigin}`);
  }
  if (getAuthMode(runtimeConfig) === "classroom") {
    if (runtimeConfig.classroomCode) {
      info.push(`[Vibbit backend] Legacy class code -> URL: ${listenUrl || "<your-server-url>"} | class code: ${runtimeConfig.classroomCode}`);
    } else if (deployment.isHosted) {
      info.push("[Vibbit backend] Hosted mode: legacy class codes disabled; teachers mint codes at /teacher");
    }
    info.push(`[Vibbit backend] Teachers mint classroom codes at ${(deployment.publicOrigin || listenUrl || "<your-server-url>")}/teacher`);
  }
  if (runtimeConfig.bookmarkletEnabled) {
    info.push(`[Vibbit backend] Bookmarklet install page -> ${(listenUrl || "<your-server-url>") + BOOKMARKLET_INSTALL_ROUTE}`);
    info.push(`[Vibbit backend] Bookmarklet runtime -> ${(listenUrl || "<your-server-url>") + BOOKMARKLET_RUNTIME_ROUTE}`);
  }
  if (runtimeConfig.extensionDownloadUrl) {
    info.push(`[Vibbit backend] Extension download -> ${(listenUrl || "<your-server-url>") + EXTENSION_DOWNLOAD_ROUTE}`);
    info.push(`[Vibbit backend] Extension asset source -> ${runtimeConfig.extensionDownloadUrl}`);
  }
  if (getAuthMode(runtimeConfig) === "app-token") {
    info.push("[Vibbit backend] SERVER_APP_TOKEN auth enabled");
  }
  const tkslopper = runtimeConfig.tkslopper;
  if (tkslopper && tkslopper.enabled) {
    const scope = tkslopper.allClassrooms ? "all classrooms" : `${tkslopper.classroomIds.length} classroom(s)`;
    info.push(`[Vibbit backend] Managed gateway enabled for ${scope}: endpoint=${tkslopper.endpoint} alias=${tkslopper.alias}`);
  }
  return info;
}

function classifyRequestError(error, runtimeConfig) {
  const isTimeout = error && error.name === "AbortError";
  if (isTimeout) {
    return {
      status: 504,
      message: `Generation timed out after ${Number.isFinite(error.timeoutMs) ? error.timeoutMs : runtimeConfig.requestTimeoutMs}ms`
    };
  }

  const message = error && error.message ? error.message : "Internal server error";
  if (message === "Invalid JSON" || message === "Payload too large" || message === "'request' is required") {
    return { status: 400, message };
  }
  if (message.includes("is not enabled on this server") || message.includes("is not allowed for provider")) {
    return { status: 400, message };
  }
  return { status: 500, message };
}

function loadBookmarkletRuntimeTemplate() {
  for (const candidatePath of WORK_JS_CANDIDATE_PATHS) {
    try {
      const source = readFileSync(candidatePath, "utf8");
      if (!source) continue;
      return source.replace(WORK_JS_USERSCRIPT_HEADER_PATTERN, "");
    } catch {
    }
  }
  return "";
}

function buildBookmarkletRuntimeSource(templateSource, backendUrl, catalogueOrigin) {
  if (!templateSource) {
    return [
      `console.error(${JSON.stringify("Vibbit bookmarklet runtime source is unavailable on this backend deployment.")});`,
      `alert(${JSON.stringify("Vibbit bookmarklet runtime is not available on this server.")});`
    ].join("\n");
  }

  let output = templateSource;
  output = output.replace(/const TKSLOPPER_GATEWAY_ORIGIN = ".*?";/, `const TKSLOPPER_GATEWAY_ORIGIN = ${JSON.stringify(catalogueOrigin)};`);
  const backendLine = `const BACKEND = ${JSON.stringify(backendUrl)};`;
  const appTokenLine = 'const APP_TOKEN = "";';

  output = WORK_JS_BACKEND_CONST_PATTERN.test(output)
    ? output.replace(WORK_JS_BACKEND_CONST_PATTERN, backendLine)
    : `${backendLine}\n${output}`;
  output = WORK_JS_APP_TOKEN_CONST_PATTERN.test(output)
    ? output.replace(WORK_JS_APP_TOKEN_CONST_PATTERN, appTokenLine)
    : `${appTokenLine}\n${output}`;

  return output;
}

function buildBookmarkletLoaderSource(runtimeUrl, config) {
  const bookmarkletConfig = Object.assign({}, config || {}, { __launchPanelOnLoad: true });
  return (
    "(function(){" +
      "try{" +
        "var w=window,d=document;" +
        "w.__vibbitBookmarkletConfig=Object.assign({},w.__vibbitBookmarkletConfig||{}," + JSON.stringify(bookmarkletConfig) + ");" +
        "if(w.__vibbit&&typeof w.__vibbit.reinvoke==='function'){" +
          "if(w.__vibbit.reinvoke()!==false)return;" +
        "}" +
        "var src=" + JSON.stringify(runtimeUrl) + ";" +
        "if(!src){alert('Vibbit bookmarklet runtime URL is not configured.');return;}" +
        "var id='vibbit-bookmarklet-runtime';" +
        "var existing=d.getElementById(id);" +
        "if(existing&&existing.parentNode){existing.parentNode.removeChild(existing);}" +
        "var script=d.createElement('script');" +
        "script.id=id;" +
        "script.async=true;" +
        "script.src=src+(src.indexOf('?')===-1?'?':'&')+'v='+Date.now();" +
        "script.onerror=function(){alert('Vibbit bookmarklet could not load its runtime.');};" +
        "(d.head||d.documentElement).appendChild(script);" +
      "}catch(err){" +
        "alert('Vibbit bookmarklet failed: '+(err&&err.message?err.message:String(err)));" +
      "}" +
    "})();"
  );
}

function buildBookmarkletHref(runtimeUrl, config) {
  return "javascript:" + buildBookmarkletLoaderSource(runtimeUrl, config);
}

function resolveExtensionDownloadTarget(request, requestUrl, runtimeConfig) {
  const configured = String(runtimeConfig.extensionDownloadUrl || "").trim();
  if (!configured) return "";
  if (/^https?:\/\//i.test(configured)) return configured;
  try {
    const publicOrigin = resolvePublicOrigin(request, requestUrl, runtimeConfig.deployment);
    return new URL(configured, `${publicOrigin}/`).toString();
  } catch {
    return "";
  }
}

export function createBackendRuntime(options = {}) {
  const env = options.env || (typeof process !== "undefined" ? process.env : {});
  const runtimeConfig = createRuntimeConfig(env);
  const bookmarkletRuntimeTemplate = loadBookmarkletRuntimeTemplate();
  const sessionStore = createSessionStore(runtimeConfig.sessionTtlMs);
  const adminAuthToken = String(
    options.adminAuthToken
    || env.VIBBIT_ADMIN_TOKEN
    || runtimeConfig.appToken
    || ""
  ).trim();
  const persistAdminProviderState = typeof options.persistAdminProviderState === "function"
    ? options.persistAdminProviderState
    : (() => Promise.resolve());
  const persistTeacherPortalState = typeof options.persistTeacherPortalState === "function"
    ? options.persistTeacherPortalState
    : (() => Promise.resolve());
  let adminProviderState = sanitiseAdminProviderState(
    options.adminProviderState || createEmptyAdminProviderState(),
    runtimeConfig.providerConfig.enabledProviders
  );
  const deployment = runtimeConfig.deployment;
  const outboundUrlPolicy = options.outboundUrlPolicy
    || createOutboundUrlPolicy(env, {
      dnsLookup: typeof options.dnsLookup === "function" ? options.dnsLookup : undefined,
      // Tests inject dnsLookup and mock globalThis.fetch; keep that path mockable.
      // Production (no injected dnsLookup) pins DNS on outbound provider calls.
      pinDns: typeof options.dnsLookup !== "function",
      fetchImpl: typeof options.outboundFetch === "function" ? options.outboundFetch : null
    });
  const rateLimits = options.rateLimits
    || createRateLimitController(env, {
      now: typeof options.now === "function" ? options.now : undefined,
      persistDailyUsage: typeof options.persistDailyUsage === "function"
        ? options.persistDailyUsage
        : undefined,
      loadDailyUsage: typeof options.loadDailyUsage === "function"
        ? options.loadDailyUsage
        : undefined
    });
  const usageStore = options.usageStore || createUsageStore({
    now: typeof options.now === "function" ? options.now : undefined,
    persist: typeof options.persistUsageState === "function" ? options.persistUsageState : undefined,
    initialState: options.usageState || {}
  });
  const modelCatalogue = createModelCatalogue({ origin: env.VIBBIT_TKSLOPPER_GATEWAY_URL, fetchImpl: options.catalogueFetch || globalThis.fetch });
  const teacherPortal = createTeacherPortal({
    env,
    initialState: options.teacherPortalState || {},
    persistState: persistTeacherPortalState,
    respondCorsHeaders: (origin) => buildCorsHeaders(origin, runtimeConfig),
    deploymentPolicy: deployment,
    outboundUrlPolicy,
    usageStore,
    modelCatalogue,
    getManagedClassroomModels: async (classrooms) => {
      const managed = classrooms.filter((classroom) => isTkslopperClassroom(runtimeConfig, classroom.id));
      if (!managed.length || !tkslopperClient) return {};
      const label = await getManagedModelLabel();
      return Object.fromEntries(managed.map((classroom) => [classroom.id, label]));
    }
  });
  const getEffectiveProviderConfig = () => buildEffectiveProviderConfig(runtimeConfig.providerConfig, adminProviderState);
  const tkslopperConfig = runtimeConfig.tkslopper;
  // Operator-configured endpoints, so they bypass the teacher endpoint policy.
  const tkslopperClient = tkslopperConfig.enabled
    ? createTkslopperClient({
      controlPlaneUrl: tkslopperConfig.controlPlaneUrl,
      gatewayUrl: tkslopperConfig.gatewayUrl,
      serviceCredential: tkslopperConfig.serviceCredential,
      endpoint: tkslopperConfig.endpoint,
      alias: tkslopperConfig.alias,
      maxOutputTokens: tkslopperConfig.maxOutputTokens,
      temperature: tkslopperConfig.temperature,
      grantTtlSeconds: tkslopperConfig.grantTtlSeconds,
      fetchImpl: typeof options.tkslopperFetch === "function" ? options.tkslopperFetch : undefined,
      now: typeof options.now === "function" ? options.now : undefined,
      randomUUID: typeof options.randomUUID === "function" ? options.randomUUID : undefined,
      logger: typeof options.tkslopperLogger === "function"
        ? options.tkslopperLogger
        : (record) => console.info("[Vibbit tkslopper]", JSON.stringify(record))
    })
    : null;
  const tkslopperProviderConfig = tkslopperClient ? createTkslopperProviderConfig(tkslopperConfig) : null;
  const getManagedModelLabel = async () => {
    if (!tkslopperClient) return "";
    const model = await tkslopperClient.getModelMetadata();
    return [model.display_name ? `${model.display_name} (${model.id})` : model.id, model.provider, model.tier].filter(Boolean).join(" · ");
  };
  const publicOriginFor = (request, requestUrl) => resolvePublicOrigin(request, requestUrl, deployment);

  const resolveProviderConfigForSession = async (session) => {
    const classroomId = session && session.meta && session.meta.classroomId
      ? String(session.meta.classroomId)
      : "";
    if (!classroomId) return getEffectiveProviderConfig();
    const classroom = teacherPortal.store.getClassroom(classroomId);
    const sessionVersion = Number(session && session.meta && session.meta.sessionVersion);
    if (
      !classroom
      || !classroom.enabled
      || !Number.isFinite(sessionVersion)
      || sessionVersion !== classroom.sessionVersion
    ) {
      throw Object.assign(new Error("Classroom session is no longer valid"), { statusCode: 401 });
    }
    if (tkslopperProviderConfig && isTkslopperClassroom(runtimeConfig, classroom.id)) {
      return tkslopperProviderConfig;
    }
    const profile = teacherPortal.store.getEffectiveCredentialProfileForClassroom(classroom);
    if (!profile) {
      throw Object.assign(new Error("Classroom is missing a credential profile"), { statusCode: 503 });
    }
    if (!profile.apiKey || profile.lastTestOk !== true) {
      throw Object.assign(
        new Error("Classroom AI account is not ready. Ask your teacher to test and save it."),
        { statusCode: 503 }
      );
    }
    try {
      assertModelOverrideMatchesTestedProfile(profile, classroom.modelOverride);
    } catch (error) {
      throw Object.assign(
        new Error((error && error.message) || "Classroom model is not ready"),
        { statusCode: 503 }
      );
    }
    if (profile.provider === "custom") {
      try {
        await outboundUrlPolicy.assertSafeUrl(profile.customBaseUrl, {
          purpose: "credential profile custom base URL"
        });
      } catch (error) {
        throw Object.assign(
          new Error((error && error.message) || "Credential profile endpoint is not allowed"),
          { statusCode: 503 }
        );
      }
    }
    return createProviderConfigFromCredentialProfile(profile, {
      modelOverride: classroom.modelOverride
    });
  };

  const respondRateLimited = (origin, decision) => new Response(JSON.stringify({
    error: "Too many requests. Please wait and try again.",
    reason: decision.reason || "rate_limited"
  }), {
    status: 429,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Retry-After": String(Math.max(1, Number(decision.retryAfterSeconds) || 1)),
      ...buildCorsHeaders(origin, runtimeConfig)
    }
  });

  const handleConnect = async (request, origin) => {
    const clientIp = resolveTrustedClientIp(request, deployment) || "local";
    const connectLimit = rateLimits.checkConnect({ clientIp });
    if (!connectLimit.ok) {
      // Do not persist rejected-connect metrics — that amplifies disk writes under flood.
      return respondRateLimited(origin, connectLimit);
    }

    const authMode = getAuthMode(runtimeConfig);
    const body = await readJson(request, 16 * 1024);
    const providedCode = body && (body.classCode || body.code);
    let classroomId = "";
    let classroomName = "";
    let sessionMeta = null;
    let publicProviderConfig = getPublicServerConfig(runtimeConfig, getEffectiveProviderConfig());

    if (authMode === "app-token") {
      const token = extractBearerToken(request.headers.get("authorization"));
      if (!token || token !== runtimeConfig.appToken) {
        return respondJson(401, { error: "Unauthorized" }, origin, runtimeConfig);
      }
    } else if (authMode === "classroom") {
      const classHeader = request.headers.get("x-vibbit-class-code");
      const candidateCode = providedCode || classHeader;
      const teacherClassroom = teacherPortal.store.findClassroomByCode(candidateCode);
      if (teacherClassroom && tkslopperProviderConfig && isTkslopperClassroom(runtimeConfig, teacherClassroom.id)) {
        // Managed-gateway classrooms do not need a tested teacher credential profile.
        classroomId = teacherClassroom.id;
        classroomName = String(teacherClassroom.name || "").trim().slice(0, 120);
        publicProviderConfig = getPublicServerConfig(runtimeConfig, tkslopperProviderConfig);
        sessionMeta = {
          student: String((body && body.student) || "").trim().slice(0, 120),
          classroomId,
          sessionVersion: teacherClassroom.sessionVersion
        };
      } else if (teacherClassroom) {
        const effectiveProfile = teacherPortal.store.getEffectiveCredentialProfileForClassroom(teacherClassroom);
        if (!effectiveProfile) {
          return respondJson(503, {
            error: "Classroom is not ready yet. Ask your teacher to choose a credential profile."
          }, origin, runtimeConfig);
        }
        if (!effectiveProfile.apiKey || effectiveProfile.lastTestOk !== true) {
          return respondJson(503, {
            error: "Classroom is not ready yet. Ask your teacher to test and save the AI account."
          }, origin, runtimeConfig);
        }
        try {
          assertModelOverrideMatchesTestedProfile(effectiveProfile, teacherClassroom.modelOverride);
        } catch (error) {
          return respondJson(503, {
            error: (error && error.message)
              || "Classroom model is not ready. Ask your teacher to clear or retest the classroom model."
          }, origin, runtimeConfig);
        }
        classroomId = teacherClassroom.id;
        classroomName = String(teacherClassroom.name || "").trim().slice(0, 120);
        publicProviderConfig = getPublicServerConfig(
          runtimeConfig,
          createProviderConfigFromCredentialProfile(effectiveProfile, {
            modelOverride: teacherClassroom.modelOverride
          })
        );
        sessionMeta = {
          student: String((body && body.student) || "").trim().slice(0, 120),
          classroomId,
          sessionVersion: teacherClassroom.sessionVersion
        };
      } else if (!isClassroomCodeValid(candidateCode, runtimeConfig)) {
        return respondJson(401, { error: "Invalid class code" }, origin, runtimeConfig);
      }
    }

    const session = sessionStore.createSession(sessionMeta || {
      student: String((body && body.student) || "").trim().slice(0, 120),
      classroomId
    });

    await usageStore.recordConnect(classroomId || "legacy");

    return respondJson(200, {
      ok: true,
      ...publicProviderConfig,
      ...(classroomName ? { classroomName } : {}),
      sessionToken: session.token,
      expiresAt: new Date(session.expiresAt).toISOString()
    }, origin, runtimeConfig);
  };

  const fetchHandler = async (request) => {
    const origin = request.headers.get("origin") || "";
    const requestUrl = new URL(request.url);
    const rawPathname = requestUrl.pathname;
    const pathname = rawPathname === "/api"
      ? "/"
      : (rawPathname.startsWith("/api/") ? rawPathname.slice(4) : rawPathname);

    if (request.method === "OPTIONS") {
      return handleOptions(origin, runtimeConfig);
    }

    if (rawPathname === "/" && request.method === "GET") {
      const publicOrigin = publicOriginFor(request, requestUrl);
      const runtimeUrl = `${publicOrigin}${BOOKMARKLET_RUNTIME_ROUTE}`;
      const bookmarkletConfig = runtimeConfig.bookmarkletEnableByok
        ? { enableManaged: true, enableByok: true }
        : { forceMode: "managed", enableManaged: true, enableByok: false };
      const bookmarkletHref = runtimeConfig.bookmarkletEnabled
        ? buildBookmarkletHref(runtimeUrl, bookmarkletConfig)
        : "";
      const html = renderLandingPage({
        extensionDownloadEnabled: Boolean(runtimeConfig.extensionDownloadUrl),
        bookmarkletEnabled: Boolean(runtimeConfig.bookmarkletEnabled),
        bookmarkletHref
      });
      return respondHtml(200, html, origin, runtimeConfig);
    }

    if ((pathname === "/favicon.svg" || pathname === "/favicon.ico")
      && (request.method === "GET" || request.method === "HEAD")) {
      if (pathname === "/favicon.ico") {
        return new Response(null, {
          status: 302,
          headers: {
            Location: rawPathname.replace(/\.ico$/i, ".svg"),
            "Cache-Control": "public, max-age=86400",
            ...buildCorsHeaders(origin, runtimeConfig)
          }
        });
      }
      if (FAVICON_SVG) {
        return respondSvg(200, FAVICON_SVG, origin, runtimeConfig);
      }
      return new Response(null, { status: 404, headers: buildCorsHeaders(origin, runtimeConfig) });
    }

    if (pathname === EXTENSION_DOWNLOAD_ROUTE && request.method === "GET") {
      const targetUrl = resolveExtensionDownloadTarget(request, requestUrl, runtimeConfig);
      if (!targetUrl) {
        return respondJson(404, { error: "Extension download is not configured on this server." }, origin, runtimeConfig);
      }
      return new Response(null, {
        status: 302,
        headers: {
          Location: targetUrl,
          "Cache-Control": "no-store",
          ...buildCorsHeaders(origin, runtimeConfig)
        }
      });
    }

    if (runtimeConfig.bookmarkletEnabled && pathname === BOOKMARKLET_RUNTIME_ROUTE && request.method === "GET") {
      const publicOrigin = publicOriginFor(request, requestUrl);
      const runtimeSource = buildBookmarkletRuntimeSource(bookmarkletRuntimeTemplate, publicOrigin, modelCatalogue.gatewayOrigin);
      return respondJavaScript(200, runtimeSource, origin, runtimeConfig, {
        "Cache-Control": "no-store"
      });
    }

    if (runtimeConfig.bookmarkletEnabled && pathname === BOOKMARKLET_INSTALL_ROUTE && request.method === "GET") {
      const publicOrigin = publicOriginFor(request, requestUrl);
      const runtimeUrl = `${publicOrigin}${BOOKMARKLET_RUNTIME_ROUTE}`;
      const bookmarkletConfig = runtimeConfig.bookmarkletEnableByok
        ? { enableManaged: true, enableByok: true }
        : { forceMode: "managed", enableManaged: true, enableByok: false };
      const bookmarkletHref = buildBookmarkletHref(runtimeUrl, {
        ...bookmarkletConfig
      });
      const html = renderBookmarkletInstallPage({
        bookmarkletHref,
        runtimeUrl,
        byokEnabled: runtimeConfig.bookmarkletEnableByok
      });
      return respondHtml(200, html, origin, runtimeConfig);
    }

    if (pathname === "/healthz" && request.method === "GET") {
      return respondJson(200, {
        ok: true,
        ...getPublicServerConfig(runtimeConfig, getEffectiveProviderConfig()),
        tokenRequired: getAuthMode(runtimeConfig) !== "none",
        activeSessions: sessionStore.size()
      }, origin, runtimeConfig);
    }

    if (pathname === "/vibbit/config" && request.method === "GET") {
      return respondJson(200, {
        ok: true,
        ...getPublicServerConfig(runtimeConfig, getEffectiveProviderConfig())
      }, origin, runtimeConfig);
    }

    if (pathname === "/vibbit/connect" && request.method === "POST") {
      try {
        return await handleConnect(request, origin);
      } catch (error) {
        const { status, message } = classifyRequestError(error, runtimeConfig);
        return respondJson(status, { error: message }, origin, runtimeConfig);
      }
    }

    if (pathname === "/teacher" || pathname.startsWith("/teacher/")) {
      const teacherResponse = await teacherPortal.handle(request, {
        pathname,
        origin,
        publicOrigin: publicOriginFor(request, requestUrl),
        requestUrl
      });
      if (teacherResponse) return teacherResponse;
    }

    const joinMatch = pathname.match(/^\/join\/([A-Za-z0-9-]{3,24})$/);
    if (joinMatch && request.method === "GET") {
      const corsHeaders = buildCorsHeaders(origin, runtimeConfig);
      const clientIp = resolveTrustedClientIp(request, deployment) || "local";
      const joinLimit = rateLimits.checkJoin({ clientIp });
      if (!joinLimit.ok) {
        return new Response(renderJoinUnavailablePage(), {
          status: 429,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Retry-After": String(Math.max(1, Number(joinLimit.retryAfterSeconds) || 1)),
            "Cache-Control": "no-store",
            ...corsHeaders
          }
        });
      }
      const joinCode = joinMatch[1];
      const availability = resolveJoinAvailability(teacherPortal.store, joinCode);
      const html = availability.available
        ? renderJoinAvailablePage({
          code: availability.code,
          classroomName: availability.classroom && availability.classroom.name,
          publicOrigin: publicOriginFor(request, requestUrl),
          codeOnly: deployment.mode === "hosted",
          bookmarkletPath: BOOKMARKLET_INSTALL_ROUTE,
          extensionPath: EXTENSION_DOWNLOAD_ROUTE
        })
        : renderJoinUnavailablePage();
      return joinHtmlResponse(200, html, { corsHeaders });
    }

    if (pathname === "/admin" || pathname.startsWith("/admin/")) {
      if (!deployment.adminPanelEnabled) {
        return respondJson(404, {
          error: "Admin panel is unavailable in hosted mode. Use /teacher."
        }, origin, runtimeConfig);
      }
    }

    if (pathname === "/admin" && request.method === "GET") {
      if (!isAdminRequestAuthorised(request, runtimeConfig, requestUrl, adminAuthToken)) {
        return respondJson(401, { error: "Unauthorized" }, origin, runtimeConfig);
      }
      const [presets, managedModelLabel] = await Promise.all([modelCatalogue.load(), getManagedModelLabel()]);
      const html = renderAdminPanel(runtimeConfig, sessionStore, requestUrl, adminProviderState, adminAuthToken, presets, managedModelLabel, modelCatalogue);
      return respondHtml(200, html, origin, runtimeConfig);
    }

    if (pathname === "/admin/status" && request.method === "GET") {
      if (!isAdminRequestAuthorised(request, runtimeConfig, requestUrl, adminAuthToken)) {
        return respondJson(401, { error: "Unauthorized" }, origin, runtimeConfig);
      }
      return respondJson(200, buildAdminStatus(runtimeConfig, sessionStore, adminProviderState), origin, runtimeConfig);
    }

    if (pathname === "/admin/config" && request.method === "POST") {
      if (!isAdminRequestAuthorised(request, runtimeConfig, requestUrl, adminAuthToken)) {
        return respondJson(401, { error: "Unauthorized" }, origin, runtimeConfig);
      }
      try {
        const update = await readAdminProviderUpdate(request);
        adminProviderState = applyAdminProviderUpdate(
          adminProviderState,
          update,
          runtimeConfig.providerConfig.enabledProviders
        );
        await persistAdminProviderState(adminProviderState);

        const acceptsJson = String(request.headers.get("accept") || "").toLowerCase().includes("application/json")
          || String(request.headers.get("content-type") || "").toLowerCase().includes("application/json");
        if (acceptsJson) {
          return respondJson(200, buildAdminStatus(runtimeConfig, sessionStore, adminProviderState), origin, runtimeConfig);
        }

        const nextQuery = buildAdminAuthQuery(requestUrl, { saved: "1" });
        return new Response(null, {
          status: 303,
          headers: {
            Location: `/admin${nextQuery}`,
            ...buildCorsHeaders(origin, runtimeConfig)
          }
        });
      } catch (error) {
        const { status, message } = classifyRequestError(error, runtimeConfig);
        return respondJson(status, { error: message }, origin, runtimeConfig);
      }
    }

    if (pathname === "/vibbit/generate" && request.method === "POST") {
      try {
        if (!isGenerateRequestAuthorised(request, runtimeConfig, sessionStore)) {
          return respondJson(401, { error: "Unauthorized" }, origin, runtimeConfig);
        }

        const payload = await readJson(request);
        const validated = validatePayload(payload);
        if (!validated.ok) {
          return respondJson(400, { error: validated.error }, origin, runtimeConfig);
        }

        const session = getRequestSession(request, sessionStore);
        const classroomId = session && session.meta && session.meta.classroomId
          ? String(session.meta.classroomId)
          : "";
        if (classroomId && (validated.value.provider || validated.value.model)) {
          return respondJson(400, {
            error: "Classroom sessions cannot override provider or model."
          }, origin, runtimeConfig);
        }

        const sessionToken = session && session.token ? String(session.token) : "";
        let providerConfig;
        try {
          providerConfig = await resolveProviderConfigForSession(session);
        } catch (error) {
          if (error && Number.isFinite(error.statusCode)) {
            return respondJson(error.statusCode, {
              error: error.message || "Request failed"
            }, origin, runtimeConfig);
          }
          throw error;
        }

        const reservation = await rateLimits.reserveGenerate({
          sessionToken,
          classroomId
        });
        if (!reservation.ok) {
          // In-memory counter only — do not persist rejected-generate metrics
          // (that amplifies disk/crypto work under flood). Same posture as connect.
          await usageStore.recordRateLimited(classroomId || "legacy");
          return respondRateLimited(origin, reservation);
        }

        try {
          await usageStore.recordAcceptedGeneration(classroomId || "legacy");
          const result = await generateManaged(
            validated.value,
            runtimeConfig,
            providerConfig,
            {
              outboundUrlPolicy,
              tkslopperClient,
              classroomId,
              onUpstreamAttempt: async ({ success }) => {
                await usageStore.recordUpstreamAttempt(classroomId || "legacy", { success });
              }
            }
          );
          return respondJson(200, {
            code: result.code,
            feedback: result.feedback,
            outcome: result.outcome,
            upstreamAttempts: result.upstreamAttempts,
            validationOk: result.outcome === "ok"
          }, origin, runtimeConfig);
        } finally {
          if (typeof reservation.release === "function") reservation.release();
        }
      } catch (error) {
        if (error instanceof TkslopperRefusalError) {
          return respondJson(422, { error: TKSLOPPER_REFUSAL_MESSAGE }, origin, runtimeConfig);
        }
        if (error instanceof TkslopperUnavailableError) {
          return respondJson(503, { error: TKSLOPPER_UNAVAILABLE_MESSAGE }, origin, runtimeConfig);
        }
        if (error instanceof TkslopperHttpError && (error.status === 402 || error.status === 429)) {
          return respondRateLimited(origin, {
            reason: "managed_ai_limited",
            retryAfterSeconds: error.retryAfterSeconds
          });
        }
        if (error && Number.isFinite(error.statusCode)) {
          return respondJson(error.statusCode, {
            error: error.message || "Request failed"
          }, origin, runtimeConfig);
        }
        if (error && error.statusCode === 413) {
          return respondJson(413, { error: error.message || "Payload too large" }, origin, runtimeConfig);
        }
        const { status, message } = classifyRequestError(error, runtimeConfig);
        const statusCode = /too large/i.test(message) ? 413 : status;
        return respondJson(statusCode, { error: message }, origin, runtimeConfig);
      }
    }

    if (pathname === "/vibbit/oracle-miss" && request.method === "POST") {
      try {
        if (!isGenerateRequestAuthorised(request, runtimeConfig, sessionStore)) {
          return respondJson(401, { error: "Unauthorized" }, origin, runtimeConfig);
        }
        const session = getRequestSession(request, sessionStore);
        if (getAuthMode(runtimeConfig) === "classroom" && !session) {
          return respondJson(401, { error: "Unauthorized" }, origin, runtimeConfig);
        }
        const payload = await readJson(request, 16 * 1024);
        sanitiseOracleMissPayload(payload);
        const classroomId = session && session.meta && session.meta.classroomId
          ? String(session.meta.classroomId)
          : "";
        // Count only. Do not persist reason, snippets, or code.
        await usageStore.recordOracleMiss(classroomId || "legacy");
        return respondJson(200, { ok: true }, origin, runtimeConfig);
      } catch (error) {
        const { status, message } = classifyRequestError(error, runtimeConfig);
        return respondJson(status, { error: message }, origin, runtimeConfig);
      }
    }

    return respondJson(404, { error: "Not found" }, origin, runtimeConfig);
  };

  return {
    config: runtimeConfig,
    fetch: fetchHandler,
    teacherPortal,
    rateLimits,
    usageStore,
    getStartupInfo: (options) => {
      const listenUrl = options && options.listenUrl;
      return [
        ...buildStartupInfo(runtimeConfig, {
          ...(options || {}),
          effectiveProviderConfig: getEffectiveProviderConfig()
        }),
        ...teacherPortal.getStartupLines(listenUrl)
      ];
    }
  };
}
