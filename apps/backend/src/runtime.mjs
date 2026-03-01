import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildTargetPromptExtras,
  buildUserPrompt,
  extractGeminiText,
  normaliseFeedback,
  parseModelOutput,
  stubForTarget,
  validateBlocksCompatibility
} from "../../../shared/makecode-compat-core.mjs";

const DEFAULT_FEEDBACK = "Model completed generation without explicit feedback notes.";
const SUPPORTED_PROVIDERS = ["openai", "gemini", "openrouter"];
const DEFAULT_CORS_HEADERS = "Content-Type, Authorization, X-Vibbit-Class-Code, X-Vibbit-Session";
const MAX_JSON_BYTES = 1024 * 1024;
const CLASS_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const CLASS_CODE_LENGTH = 5;
const BOOKMARKLET_RUNTIME_ROUTE = "/bookmarklet/runtime.js";
const BOOKMARKLET_INSTALL_ROUTE = "/bookmarklet";
const EXTENSION_DOWNLOAD_ROUTE = "/download/vibbit-extension.zip";
const DEFAULT_EXTENSION_DOWNLOAD_URL = "https://github.com/tinkertanker/vibbit/releases/latest/download/vibbit-extension.zip";
const WORK_JS_USERSCRIPT_HEADER_PATTERN = /^\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\s*/;
const WORK_JS_BACKEND_CONST_PATTERN = /const BACKEND = ".*?";/;
const WORK_JS_APP_TOKEN_CONST_PATTERN = /const APP_TOKEN = ".*?";/;

const runtimeFileDir = dirname(fileURLToPath(import.meta.url));
const FAVICON_SVG_PATH = resolve(runtimeFileDir, "../../../extension/icons/vibbit-frog.svg");
let FAVICON_SVG = null;
try {
  FAVICON_SVG = readFileSync(FAVICON_SVG_PATH, "utf8");
} catch {
  // Extension icons may be missing when backend runs from a different context
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

function resolvePublicOrigin(request, requestUrl) {
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
  if (provider === "openai") return env.VIBBIT_OPENAI_MODEL || env.VIBBIT_MODEL || "gpt-4o-mini";
  if (provider === "gemini") return env.VIBBIT_GEMINI_MODEL || env.VIBBIT_MODEL || "gemini-2.5-flash";
  if (provider === "openrouter") return env.VIBBIT_OPENROUTER_MODEL || env.VIBBIT_MODEL || "openrouter/auto";
  return env.VIBBIT_MODEL || "gpt-4o-mini";
}

function resolveKeyForProvider(env, provider) {
  if (provider === "openai") return env.VIBBIT_OPENAI_API_KEY || env.VIBBIT_API_KEY || "";
  if (provider === "gemini") return env.VIBBIT_GEMINI_API_KEY || env.VIBBIT_API_KEY || "";
  if (provider === "openrouter") return env.VIBBIT_OPENROUTER_API_KEY || env.VIBBIT_API_KEY || "";
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
    }
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

  const isValidSession = (token) => {
    if (!token) return false;
    pruneExpired();
    const entry = sessions.get(token);
    if (!entry) return false;
    return entry.expiresAt > Date.now();
  };

  return {
    createSession,
    isValidSession,
    pruneExpired,
    size: () => sessions.size
  };
}

function createRuntimeConfig(envInput = {}) {
  const env = envInput || {};
  const allowOrigin = env.VIBBIT_ALLOW_ORIGIN || "*";
  const requestTimeoutMs = parseInteger(env.VIBBIT_REQUEST_TIMEOUT_MS, 60000, { min: 5000, max: 180000 });
  const emptyRetries = parseInteger(env.VIBBIT_EMPTY_RETRIES, 2, { min: 0, max: 5 });
  const validationRetries = parseInteger(env.VIBBIT_VALIDATION_RETRIES, 2, { min: 0, max: 5 });
  const bookmarkletEnabled = parseBoolean(env.VIBBIT_BOOKMARKLET_ENABLED, true);
  const bookmarkletEnableByok = parseBoolean(env.VIBBIT_BOOKMARKLET_ENABLE_BYOK, false);
  const extensionDownloadUrl = String(
    env.VIBBIT_EXTENSION_DOWNLOAD_URL == null
      ? DEFAULT_EXTENSION_DOWNLOAD_URL
      : env.VIBBIT_EXTENSION_DOWNLOAD_URL
  ).trim();
  const providerConfig = createProviderConfig(env);
  const appToken = String(env.SERVER_APP_TOKEN || "").trim();

  const classroomEnabled = appToken
    ? false
    : parseBoolean(env.VIBBIT_CLASSROOM_ENABLED, true);
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
    || ""
  );
  const classroomCode = classroomEnabled
    ? (configuredCode || (autoGenerateCode ? generateClassCodeFromSeed(classCodeSeed, classCodeLength) : ""))
    : "";
  if (classroomEnabled && !classroomCode) {
    throw new Error("Classroom auth is enabled but no class code is available.");
  }

  const sessionTtlMs = parseInteger(env.VIBBIT_SESSION_TTL_MS, 8 * 60 * 60 * 1000, {
    min: 5 * 60 * 1000,
    max: 7 * 24 * 60 * 60 * 1000
  });

  let authMode = "none";
  if (appToken) authMode = "app-token";
  else if (classroomEnabled) authMode = "classroom";

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
    sessionTtlMs
  };
}

function buildCorsHeaders(origin, config) {
  const requestOrigin = String(origin || "").trim().replace(/\/+$/, "");
  const configuredOrigins = parseCsv(config.allowOrigin)
    .map((item) => item.replace(/\/+$/, ""))
    .filter(Boolean);

  let allowOrigin = "*";
  if (configuredOrigins.length && !configuredOrigins.includes("*")) {
    if (requestOrigin && configuredOrigins.includes(requestOrigin)) allowOrigin = requestOrigin;
    else allowOrigin = configuredOrigins[0];
  }

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": DEFAULT_CORS_HEADERS,
    // Required by Chromium private-network access preflights when the
    // extension/page calls a localhost backend from a secure origin.
    "Access-Control-Allow-Private-Network": "true",
    "Access-Control-Max-Age": "86400"
  };
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
  const text = await request.text();
  const size = new TextEncoder().encode(text).length;
  if (size > maxBytes) {
    throw new Error("Payload too large");
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (error) {
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

const TARGET_CONFIGS = {
  microbit: {
    name: "micro:bit",
    apis: [
      "basic: showNumber(n), showString(s), showIcon(IconNames), showLeds(`...`), showArrow(ArrowNames), clearScreen(), forever(handler), pause(ms)",
      "input: onButtonPressed(Button.A/B/AB, handler), onGesture(Gesture.Shake/Tilt/..., handler), onPinPressed(TouchPin.P0/P1/P2, handler), buttonIsPressed(Button), temperature(), lightLevel(), acceleration(Dimension.X/Y/Z), compassHeading(), rotation(Rotation), magneticForce(Dimension), runningTime()",
      "music: playTone(Note, BeatFraction), ringTone(freq), rest(BeatFraction), beat(BeatFraction), tempo(), setTempo(bpm), changeTempoBy(delta)",
      "led: plot(x,y), unplot(x,y), toggle(x,y), point(x,y), brightness(), setBrightness(n), plotBarGraph(value, high), enable(on)",
      "radio: sendNumber(n), sendString(s), sendValue(name, n), onReceivedNumber(handler), onReceivedString(handler), setGroup(id), setTransmitPower(n), setTransmitSerialNumber(on)",
      "game: createSprite(x,y), .move(n), .turn(Direction,degrees), .ifOnEdgeBounce(), .isTouching(other), .isTouchingEdge(), addScore(n), score(), setScore(n), setLife(n), addLife(n), removeLife(n), gameOver(), startCountdown(ms)",
      "pins: digitalReadPin(DigitalPin), digitalWritePin(DigitalPin,value), analogReadPin(AnalogPin), analogWritePin(AnalogPin,value), servoWritePin(AnalogPin,value), map(value,fromLow,fromHigh,toLow,toHigh), onPulsed(DigitalPin,PulseValue,handler), analogSetPitchPin(AnalogPin), analogPitch(freq,ms)",
      "images: createImage(`...`), createBigImage(`...`), arrowImage(ArrowNames), iconImage(IconNames)",
      "serial: writeLine(s), writeNumber(n), writeValue(name,value), readLine(), onDataReceived(delimiter,handler), redirect(tx,rx,rate)",
      "control: inBackground(handler), reset(), waitMicros(us)",
      "loops, logic, variables, math, functions, arrays, text (standard language built-ins)"
    ].join("\n"),
    example: [
      "input.onButtonPressed(Button.A, function () {",
      "    basic.showString(\"Hello\")",
      "})",
      "let count = 0",
      "basic.forever(function () {",
      "    count += 1",
      "    basic.showNumber(count)",
      "    basic.pause(1000)",
      "})"
    ].join("\n")
  },
  arcade: {
    name: "Arcade",
    apis: [
      "sprites: create(img, SpriteKind), createProjectileFromSprite(img, sprite, vx, vy), onCreated(SpriteKind, handler), onDestroyed(SpriteKind, handler), onOverlap(SpriteKind, SpriteKind, handler), allOfKind(SpriteKind)",
      "controller: moveSprite(sprite, vx, vy), controller.A.onEvent(ControllerButtonEvent, handler), controller.B.onEvent(ControllerButtonEvent, handler), dx(), dy()",
      "scene: setBackgroundColor(color), setBackgroundImage(img), cameraFollowSprite(sprite), setTileMapLevel(tilemap), onHitWall(SpriteKind, handler), onOverlapTile(SpriteKind, tile, handler)",
      "game: onUpdate(handler), onUpdateInterval(ms, handler), splash(title, subtitle?), over(win), reset()",
      "info: score(), setScore(n), changeScoreBy(n), life(), setLife(n), changeLifeBy(n), startCountdown(s), onCountdownEnd(handler), onLifeZero(handler)",
      "music: playTone(freq, ms), playMelody(melody, tempo), setVolume(vol)",
      "effects: spray, fire, warm radial, cool radial, halo, fountain (applied via sprite.startEffect())",
      "animation: runImageAnimation(sprite, frames, interval, loop), runMovementAnimation(sprite, path, interval, loop)"
    ].join("\n"),
    example: [
      "let mySprite = sprites.create(img`",
      "    . . . . . . . . . . . . . . . .",
      "    . . . . . . . . . . . . . . . .",
      "    . . . . . 7 7 7 7 7 . . . . . .",
      "    . . . . 7 7 7 7 7 7 7 . . . . .",
      "    . . . 7 7 7 7 7 7 7 7 7 . . . .",
      "    . . . . 7 7 7 7 7 7 7 . . . . .",
      "    . . . . . 7 7 7 7 7 . . . . . .",
      "    . . . . . . . . . . . . . . . .",
      "`, SpriteKind.Player)",
      "controller.moveSprite(mySprite)",
      "mySprite.setStayInScreen(true)"
    ].join("\n")
  },
  maker: {
    name: "Maker",
    apis: [
      "pins: digitalReadPin(DigitalPin), digitalWritePin(DigitalPin, value), analogReadPin(AnalogPin), analogWritePin(AnalogPin, value), servoWritePin(AnalogPin, value), map(value, fromLow, fromHigh, toLow, toHigh)",
      "input: onButtonPressed(handler), buttonIsPressed(), temperature(), lightLevel()",
      "loops: forever(handler), pause(ms)",
      "music: playTone(freq, ms), ringTone(freq), rest(ms), setTempo(bpm)"
    ].join("\n"),
    example: [
      "let on = false",
      "loops.forever(function () {",
      "    on = !(on)",
      "    if (on) {",
      "        pins.digitalWritePin(DigitalPin.P0, 1)",
      "    } else {",
      "        pins.digitalWritePin(DigitalPin.P0, 0)",
      "    }",
      "    loops.pause(500)",
      "})"
    ].join("\n")
  }
};

function systemPromptFor(target) {
  const targetKey = TARGET_CONFIGS[target] ? target : "microbit";
  const config = TARGET_CONFIGS[targetKey];
  const targetPromptExtras = buildTargetPromptExtras(targetKey);

  return [
    `You are a Microsoft MakeCode assistant for ${config.name}.`,
    `Your ONLY job is to produce MakeCode Static TypeScript that the MakeCode editor can decompile into visual BLOCKS for ${config.name}. Every line you output must be representable as a block. If a language feature has no block equivalent, do not use it.`,
    "",
    "AVAILABLE APIs:",
    config.apis,
    ...targetPromptExtras,
    "",
    "BLOCK-COMPATIBLE PATTERNS (use these):",
    "- Event handlers: input.onButtonPressed(Button.A, function () { })",
    "- Forever loops: basic.forever(function () { })",
    "- Variables with let: let x = 0",
    "- Control flow: if/else, while, for (let i = 0; i < n; i++), for (let v of list)",
    "- Random choice from a list: options._pickRandom()",
    "- Named functions: function doSomething() { }",
    "",
    "BLOCK-SAFE REQUIREMENTS (hard):",
    "- No grey JavaScript blocks: every line must map to editable blocks",
    "- Every variable declaration must have an initializer (let x = ...)",
    "- For loops must be exactly: for (let i = 0; i < limit; i++) or for (let i = 0; i <= limit; i++)",
    "- Event registrations and function declarations must be top-level",
    "- Do not use optional/default parameters in user-defined functions",
    "- Do not return a value inside callbacks/event handlers",
    "- Do not pass more arguments than a block signature supports",
    "- In statements, assignment operators are limited to =, +=, -=",
    "",
    "AVOID (these won't decompile to blocks):",
    "- Arrow functions (=>), ternary (? :), destructuring, spread/rest (...)",
    "- const, var (use let for all variables)",
    "- Template literals for strings (use \"string\" + variable, not `${}`). Exception: backtick image literals like img`...` and showLeds(`...`) ARE allowed — these are a special MakeCode compiler feature, not string templates.",
    "- Optional chaining (?.), nullish coalescing (??)",
    "- for...in loops",
    "- import/export, async/await, yield, eval",
    "- Classes, interfaces, type aliases, enums, generics in user code",
    "- Higher-order array methods (map/filter/reduce/forEach)",
    "- randint(...) (use list._pickRandom() for random selections)",
    "- null, undefined, casts (as), bitwise operators (| & ^ << >> >>>), bitwise compound assignments",
    "- setTimeout, setInterval, console, Promise",
    "- Comments, markdown fences, prose after code",
    "",
    "RESPONSE FORMAT:",
    "- Return ONLY a JSON object with this exact shape:",
    "- {\"feedback\":[\"short note\"],\"code\":\"MakeCode Static TypeScript with \\\\n escapes\"}",
    "- feedback must be an array of one or more short strings",
    "- code must be MakeCode Static TypeScript encoded as a JSON string (use escaped \\n for new lines, no markdown fences)",
    "- Straight quotes, ASCII only, function () { } handlers",
    "- If PAGE_ERRORS are provided, treat them as failing diagnostics and prioritise resolving all of them",
    "- If CONVERSION_DIALOG is provided, ensure the output converts from JavaScript back to Blocks in MakeCode",
    "",
    `TARGET SCOPE: Use ONLY ${config.name} APIs listed above. Never mix APIs from other targets.`,
    "",
    "EXAMPLE:",
    config.example,
    "",
    `If unsure about an API, return a minimal working program for ${config.name}.`
  ].join("\n");
}

function userPromptFor(request, currentCode, pageErrors, conversionDialog) {
  return buildUserPrompt({
    request,
    currentCode,
    pageErrors,
    conversionDialog
  });
}

async function callOpenAI(key, model, system, user, signal) {
  const body = {
    model,
    temperature: 0.1,
    max_tokens: 3072,
    messages: [{ role: "system", content: system }, { role: "user", content: user }]
  };

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + key
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`OpenAI error (${response.status})`);
  }

  const data = await response.json();
  return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
}

async function callOpenRouter(key, model, system, user, signal) {
  const body = {
    model,
    temperature: 0.1,
    max_tokens: 3072,
    messages: [{ role: "system", content: system }, { role: "user", content: user }]
  };

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + key
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`OpenRouter error (${response.status})`);
  }

  const data = await response.json();
  return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
}

async function callGemini(key, model, system, user, signal) {
  const url = "https://generativelanguage.googleapis.com/v1/models/" + encodeURIComponent(model) + ":generateContent?key=" + encodeURIComponent(key);
  const body = {
    contents: [{ role: "user", parts: [{ text: system + "\n\n" + user }] }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 3072
    }
  };

  const response = await fetch(url, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`Gemini error (${response.status})`);
  }

  const data = await response.json();
  return extractGeminiText(data);
}

async function generateManaged({ target, request, currentCode, pageErrors, conversionDialog, provider, model }, runtimeConfig, providerConfig) {
  const selected = resolveProviderSelection(providerConfig || runtimeConfig.providerConfig, provider, model);

  const system = systemPromptFor(target);
  const user = userPromptFor(request, currentCode || "", pageErrors || [], conversionDialog || null);
  const callProvider = async (systemPrompt) => withTimeout(async (signal) => {
    if (selected.provider === "openai") return callOpenAI(selected.key, selected.model, systemPrompt, user, signal);
    if (selected.provider === "gemini") return callGemini(selected.key, selected.model, systemPrompt, user, signal);
    if (selected.provider === "openrouter") return callOpenRouter(selected.key, selected.model, systemPrompt, user, signal);
    throw new Error(`Unsupported provider '${selected.provider}'`);
  }, runtimeConfig.requestTimeoutMs);

  const oneAttempt = async (extraSystem, insistOnlyCode) => {
    const prompt = system
      + (extraSystem ? ("\n" + extraSystem) : "")
      + (insistOnlyCode ? "\nMANDATE: Output only compact JSON with keys feedback (array) and code (string). No prose." : "");
    const raw = await callProvider(prompt);
    const parsed = parseModelOutput(raw);
    const code = parsed.code;
    const validation = code ? validateBlocksCompatibility(code, target) : { ok: false, violations: ["empty output"] };
    return { code, feedback: parsed.feedback, validation };
  };

  let result = await oneAttempt("", false);

  for (let i = 0; i < runtimeConfig.emptyRetries && (!result.code || !result.code.trim()); i++) {
    result = await oneAttempt("Your last message had empty code. Return valid JSON only with feedback[] and code string.", true);
  }

  for (let i = 0; i < runtimeConfig.validationRetries && result.code && result.code.trim() && result.validation && !result.validation.ok; i++) {
    const violations = result.validation.violations || [];
    const extra = i === 0
      ? ("Previous code used: " + violations.join(", ") + ". Remove ALL forbidden constructs and return fully Blocks-compatible code.")
      : ("STRICT MODE: Output a smaller program that fully decompiles to Blocks. Absolutely no: " + violations.join(", ") + ".");
    result = await oneAttempt(extra, true);
  }

  if (!result.code || !result.code.trim()) {
    return {
      code: stubForTarget(target),
      feedback: normaliseFeedback(
        [...(result.feedback || []), "Model returned no code; provided fallback stub."],
        DEFAULT_FEEDBACK
      )
    };
  }

  if (!result.validation || !result.validation.ok) {
    const violations = (result.validation && result.validation.violations) || [];
    return {
      code: stubForTarget(target),
      feedback: normaliseFeedback(
        [...(result.feedback || []), "Validation fallback: " + (violations.join(", ") || "unknown compatibility issue")],
        DEFAULT_FEEDBACK
      )
    };
  }

  return {
    code: result.code,
    feedback: normaliseFeedback(result.feedback, DEFAULT_FEEDBACK)
  };
}

function extractBearerToken(headerValue) {
  if (!headerValue) return "";
  const match = String(headerValue).match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : "";
}

function validatePayload(payload) {
  const target = payload && typeof payload.target === "string" ? payload.target.trim() : "";
  const request = payload && typeof payload.request === "string" ? payload.request.trim() : "";
  const currentCode = payload && typeof payload.currentCode === "string" ? payload.currentCode : "";
  const provider = payload && typeof payload.provider === "string" ? payload.provider.trim().toLowerCase() : "";
  const model = payload && typeof payload.model === "string" ? payload.model.trim() : "";
  const rawPageErrors = payload && Array.isArray(payload.pageErrors) ? payload.pageErrors : [];
  const pageErrors = rawPageErrors
    .map((item) => String(item || "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 8);
  const rawConversionDialog = payload && payload.conversionDialog && typeof payload.conversionDialog === "object"
    ? payload.conversionDialog
    : null;
  const conversionDialog = rawConversionDialog
    ? {
      title: String(rawConversionDialog.title || "").replace(/\s+/g, " ").trim().slice(0, 220),
      description: String(rawConversionDialog.description || "").replace(/\s+/g, " ").trim().slice(0, 320)
    }
    : null;

  if (!request) {
    return { ok: false, error: "'request' is required" };
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
  if (provider === "openrouter") return "OpenRouter";
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

function renderLandingPage({ extensionDownloadEnabled } = {}) {
  const repoUrl = "https://github.com/tinkertanker/vibbit";
  const releasesUrl = "https://github.com/tinkertanker/vibbit/releases";
  const installGuideUrl = "https://github.com/tinkertanker/vibbit#install-extension-in-chrome-unpacked";
  const tinkercademyUrl = "https://tinkercademy.com";
  const slidesUrl = "https://1drv.ms/p/c/21dfaef5d0fccb4a/IQAKZM4cKK8zRYasGC45G6yvAcUdrDNoPAOGWaeOajftVtA";
  const installUrl = EXTENSION_DOWNLOAD_ROUTE;
  const canDownloadExtension = Boolean(extensionDownloadEnabled);
  const extensionDownloadLink = canDownloadExtension
    ? `<li><a href="${escapeHtml(installUrl)}">Download Chrome extension (.zip)</a></li>`
    : `<li>Chrome extension download is not available on this server right now. See <a href="${escapeHtml(releasesUrl)}" target="_blank" rel="noreferrer">GitHub releases</a>.</li>`;
  const unpackedInstallHint = canDownloadExtension
    ? "<li>Not on Chrome Web Store yet: unzip the file and load it in Chrome via <code>chrome://extensions</code> with <strong>Developer mode</strong> enabled.</li>"
    : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <title>Vibbit</title>
    <style>
      :root {
        color-scheme: light dark;
        --bg: #0b1220;
        --panel: #121b2c;
        --text: #e8eefc;
        --muted: #b8c4df;
        --link: #7ec8ff;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        font: 16px/1.5 Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
        background: radial-gradient(circle at top, #1a2640, var(--bg));
        color: var(--text);
      }
      main {
        width: min(760px, 92vw);
        padding: 2rem;
        border-radius: 1rem;
        background: color-mix(in srgb, var(--panel) 92%, black 8%);
        border: 1px solid rgba(255, 255, 255, 0.12);
        box-shadow: 0 20px 50px rgba(0, 0, 0, 0.35);
      }
      h1 { margin: 0 0 0.75rem; font-size: clamp(2rem, 7vw, 3rem); }
      p { margin: 0.7rem 0; color: var(--muted); }
      a { color: var(--link); text-decoration: none; }
      a:hover { text-decoration: underline; }
      .brand {
        display: flex;
        align-items: center;
        gap: 0.75rem;
      }
      .brand svg { flex-shrink: 0; }
      .links {
        list-style: none;
        margin: 1.2rem 0 0;
        padding: 0;
      }
      .links li { margin: 0.55rem 0; }
      .row { display: inline-flex; align-items: center; gap: 0.45rem; }
    </style>
  </head>
  <body>
    <main>
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

      <p>Vibbit is an AI coding assistant for micro:bit MakeCode, available as a Chrome extension and bookmarklet, with both managed backend mode and BYOK provider support.</p>

      <ul class="links">
        <li>
          <a class="row" href="${escapeHtml(repoUrl)}" target="_blank" rel="noreferrer">
            <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.5-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.01.08-2.1 0 0 .67-.21 2.2.82a7.49 7.49 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.09.16 1.9.08 2.1.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>
            tinkertanker/vibbit on GitHub
          </a>
        </li>
        <li>A project by <a href="${escapeHtml(tinkercademyUrl)}" target="_blank" rel="noreferrer">Tinkercademy</a> from Singapore.</li>
        <li><a href="${escapeHtml(slidesUrl)}" target="_blank" rel="noreferrer">Launch slides (Micro:bit Live 2026)</a></li>
        ${extensionDownloadLink}
        ${unpackedInstallHint}
        <li><a href="${escapeHtml(installGuideUrl)}" target="_blank" rel="noreferrer">Unpacked installation instructions</a></li>
        <li><a href="${escapeHtml(releasesUrl)}" target="_blank" rel="noreferrer">GitHub releases</a></li>
      </ul>
    </main>
  </body>
</html>`;
}

function escapeTextarea(value) {
  return String(value ?? "").replace(/<\/textarea/gi, "<\\/textarea");
}

function renderBookmarkletInstallPage({ managedHref, byokHref, runtimeUrl, enableByok }) {
  const byokSection = enableByok
    ? [
      "<section class=\"card\">",
      "<h2>Optional BYOK bookmarklet</h2>",
      "<p>Use this only if your students should enter provider keys directly in the browser.</p>",
      `<p><a class="bookmarklet" href="${escapeHtml(byokHref)}">Vibbit (BYOK enabled)</a></p>`,
      `<textarea readonly>${escapeTextarea(byokHref)}</textarea>`,
      "</section>"
    ].join("")
    : "";

  return [
    "<!doctype html>",
    "<html lang=\"en\">",
    "<head>",
    "<meta charset=\"utf-8\">",
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    "<link rel=\"icon\" type=\"image/svg+xml\" href=\"/favicon.svg\">",
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
    "<h2>Managed classroom bookmarklet</h2>",
    "<p>Recommended for schools. Students use server URL + class code; provider keys stay on your backend.</p>",
    `<p><a class="bookmarklet" href="${escapeHtml(managedHref)}">Vibbit (Managed)</a></p>`,
    `<textarea readonly>${escapeTextarea(managedHref)}</textarea>`,
    "</section>",
    byokSection,
    "<section class=\"card\">",
    "<h2>Runtime URL</h2>",
    `<p><code>${escapeHtml(runtimeUrl)}</code></p>`,
    "</section>",
    "</main>",
    "</body>",
    "</html>"
  ].join("");
}

function renderAdminPanel(runtimeConfig, sessionStore, requestUrl, adminProviderState, adminAuthToken) {
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
      `<input class=\"input\" type=\"text\" name="${escapeHtml(provider)}Model" value="${escapeHtml(modelValue)}" placeholder="Model id">`,
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
    "<link rel=\"icon\" type=\"image/svg+xml\" href=\"/favicon.svg\">",
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
    `<div class=\"metric\"><div class=\"label\">Default model</div><div class=\"value\">${escapeHtml(status.defaultModel)}</div></div>`,
    `<div class=\"metric\"><div class=\"label\">Active sessions</div><div class=\"value\">${escapeHtml(status.activeSessions)}</div></div>`,
    "</div>",
    "</div>",
    "<div class=\"card\">",
    "<h2>Provider Setup</h2>",
    "<p>You can configure provider defaults and API keys here. Leave API key fields blank to keep the current value.</p>",
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

function isGenerateRequestAuthorised(request, runtimeConfig, sessionStore) {
  const authMode = getAuthMode(runtimeConfig);
  if (authMode === "none") return true;

  const authHeader = request.headers.get("authorization");
  const bearer = extractBearerToken(authHeader);

  if (authMode === "app-token") {
    return Boolean(bearer && bearer === runtimeConfig.appToken);
  }

  if (authMode === "classroom") {
    const sessionHeader = String(request.headers.get("x-vibbit-session") || "").trim();
    if (sessionStore.isValidSession(sessionHeader) || sessionStore.isValidSession(bearer)) {
      return true;
    }
    return false;
  }

  return false;
}

function buildStartupInfo(runtimeConfig, { listenUrl, effectiveProviderConfig } = {}) {
  const providerConfig = effectiveProviderConfig || runtimeConfig.providerConfig;
  const info = [
    `[Vibbit backend] Provider=${providerConfig.defaultProvider} model=${providerConfig.defaultModelFor(providerConfig.defaultProvider)}`,
    `[Vibbit backend] Enabled providers=${providerConfig.enabledProviders.join(", ")}`,
    `[Vibbit backend] Auth mode=${getAuthMode(runtimeConfig)}`
  ];
  if (listenUrl) info.unshift(`[Vibbit backend] Listening on ${listenUrl}`);
  if (getAuthMode(runtimeConfig) === "classroom") {
    info.push(`[Vibbit backend] Share with students -> URL: ${listenUrl || "<your-server-url>"} | class code: ${runtimeConfig.classroomCode}`);
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
  return info;
}

function classifyRequestError(error, runtimeConfig) {
  const isTimeout = error && error.name === "AbortError";
  if (isTimeout) {
    return {
      status: 504,
      message: `Generation timed out after ${runtimeConfig.requestTimeoutMs}ms`
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

function buildBookmarkletRuntimeSource(templateSource, backendUrl) {
  if (!templateSource) {
    return [
      `console.error(${JSON.stringify("Vibbit bookmarklet runtime source is unavailable on this backend deployment.")});`,
      `alert(${JSON.stringify("Vibbit bookmarklet runtime is not available on this server.")});`
    ].join("\n");
  }

  let output = templateSource;
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
  return (
    "(function(){" +
      "try{" +
        "var w=window,d=document;" +
        "w.__vibbitBookmarkletConfig=Object.assign({},w.__vibbitBookmarkletConfig||{}," + JSON.stringify(config || {}) + ");" +
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
    const publicOrigin = resolvePublicOrigin(request, requestUrl);
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
  let adminProviderState = sanitiseAdminProviderState(
    options.adminProviderState || createEmptyAdminProviderState(),
    runtimeConfig.providerConfig.enabledProviders
  );
  const getEffectiveProviderConfig = () => buildEffectiveProviderConfig(runtimeConfig.providerConfig, adminProviderState);

  const handleConnect = async (request, origin) => {
    const authMode = getAuthMode(runtimeConfig);
    const body = await readJson(request, 16 * 1024);
    const providedCode = body && (body.classCode || body.code);

    if (authMode === "app-token") {
      const token = extractBearerToken(request.headers.get("authorization"));
      if (!token || token !== runtimeConfig.appToken) {
        return respondJson(401, { error: "Unauthorized" }, origin, runtimeConfig);
      }
    } else if (authMode === "classroom") {
      const classHeader = request.headers.get("x-vibbit-class-code");
      if (!isClassroomCodeValid(providedCode || classHeader, runtimeConfig)) {
        return respondJson(401, { error: "Invalid class code" }, origin, runtimeConfig);
      }
    }

    const session = sessionStore.createSession({
      student: String((body && body.student) || "").trim().slice(0, 120)
    });

    return respondJson(200, {
      ok: true,
      ...getPublicServerConfig(runtimeConfig, getEffectiveProviderConfig()),
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
      const html = renderLandingPage({
        extensionDownloadEnabled: Boolean(runtimeConfig.extensionDownloadUrl)
      });
      return respondHtml(200, html, origin, runtimeConfig);
    }

    if ((rawPathname === "/favicon.svg" || rawPathname === "/favicon.ico") && request.method === "GET") {
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
      const publicOrigin = resolvePublicOrigin(request, requestUrl);
      const runtimeSource = buildBookmarkletRuntimeSource(bookmarkletRuntimeTemplate, publicOrigin);
      return respondJavaScript(200, runtimeSource, origin, runtimeConfig, {
        "Cache-Control": "no-store"
      });
    }

    if (runtimeConfig.bookmarkletEnabled && pathname === BOOKMARKLET_INSTALL_ROUTE && request.method === "GET") {
      const publicOrigin = resolvePublicOrigin(request, requestUrl);
      const runtimeUrl = `${publicOrigin}${BOOKMARKLET_RUNTIME_ROUTE}`;
      const managedHref = buildBookmarkletHref(runtimeUrl, {
        forceMode: "managed",
        enableManaged: true,
        enableByok: false
      });
      const byokHref = buildBookmarkletHref(runtimeUrl, {
        enableManaged: true,
        enableByok: true
      });
      const html = renderBookmarkletInstallPage({
        managedHref,
        byokHref,
        runtimeUrl,
        enableByok: runtimeConfig.bookmarkletEnableByok
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

    if (pathname === "/admin" && request.method === "GET") {
      if (!isAdminRequestAuthorised(request, runtimeConfig, requestUrl, adminAuthToken)) {
        return respondJson(401, { error: "Unauthorized" }, origin, runtimeConfig);
      }
      const html = renderAdminPanel(runtimeConfig, sessionStore, requestUrl, adminProviderState, adminAuthToken);
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

        const result = await generateManaged(validated.value, runtimeConfig, getEffectiveProviderConfig());
        return respondJson(200, result, origin, runtimeConfig);
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
    getStartupInfo: (options) => buildStartupInfo(runtimeConfig, {
      ...(options || {}),
      effectiveProviderConfig: getEffectiveProviderConfig()
    })
  };
}
