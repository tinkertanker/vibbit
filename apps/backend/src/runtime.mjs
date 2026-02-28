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
    defaultModel: effectiveProviderConfig.defaultModelFor(defaultProvider)
  };
}

function buildAdminStatus(runtimeConfig, sessionStore, adminProviderState) {
  const effectiveProviderConfig = buildEffectiveProviderConfig(runtimeConfig.providerConfig, adminProviderState);
  const status = {
    ok: true,
    timestamp: new Date().toISOString(),
    ...getPublicServerConfig(runtimeConfig, effectiveProviderConfig),
    allowOrigin: runtimeConfig.allowOrigin,
    activeSessions: sessionStore.size()
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

export function createBackendRuntime(options = {}) {
  const env = options.env || (typeof process !== "undefined" ? process.env : {});
  const runtimeConfig = createRuntimeConfig(env);
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
