/**
 * Client for Tinkertanker's shared inference gateway (tkslopper).
 *
 * Vibbit keeps ownership of prompts, the repair transcript, validation and all
 * user-facing errors. This module only exchanges the backend service credential
 * for a short-lived grant and makes single, non-retried gateway calls.
 *
 * The service credential and grant access token are secrets: they are never
 * logged, returned or included in thrown messages.
 */

export const TKSLOPPER_ENDPOINTS = ["chat", "responses"];
export const TKSLOPPER_DEFAULT_CHAT_ALIAS = "text.chat.v1";
export const TKSLOPPER_DEFAULT_RESPONSES_ALIAS = "text.response.v1";
export const TKSLOPPER_ALIAS_PATTERN = /^[a-z][a-z0-9._:-]*\.v[1-9][0-9]*$/;
export const TKSLOPPER_SERVICE_CREDENTIAL_PATTERN = /^tksvc_[A-Za-z0-9_-]{8,64}_[A-Za-z0-9_-]{16,128}$/;
export const TKSLOPPER_DEFAULT_RETRY_AFTER_SECONDS = 30;

const GRANT_REFRESH_MARGIN_MS = 60 * 1000;
const DEFAULT_EXCHANGE_TIMEOUT_MS = 10 * 1000;
const REQUEST_ID_PATTERN = /^[\x21-\x7E]{1,128}$/;
const ERROR_CODE_PATTERN = /^[a-z_]{1,64}$/;

export class TkslopperHttpError extends Error {
  constructor(message, { status = 0, code = "", requestId = "", phase = "inference", retryAfterSeconds = 0 } = {}) {
    super(message);
    this.name = "TkslopperHttpError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.phase = phase;
    this.retryAfterSeconds = retryAfterSeconds;
    this.retryable = false;
  }
}

// Grant exchange refused, or the gateway kept rejecting a fresh grant.
// Nothing reached a provider, but Vibbit still does not retry.
export class TkslopperUnavailableError extends TkslopperHttpError {
  constructor(options = {}) {
    super("Managed AI is unavailable", options);
    this.name = "TkslopperUnavailableError";
  }
}

export class TkslopperRefusalError extends Error {
  constructor({ requestId = "" } = {}) {
    super("Managed AI declined the request");
    this.name = "TkslopperRefusalError";
    this.requestId = requestId;
    this.retryable = false;
  }
}

export class TkslopperProtocolError extends Error {
  constructor(message, { requestId = "", phase = "inference" } = {}) {
    super(message);
    this.name = "TkslopperProtocolError";
    this.requestId = requestId;
    this.phase = phase;
    this.retryable = false;
  }
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createAbortError(message) {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) {
    throw createAbortError("Managed AI attempt aborted");
  }
}

// Let one caller stop waiting without cancelling work shared with other callers.
function raceWithSignal(promise, signal) {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(createAbortError("Managed AI attempt aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

function joinUrl(baseUrl, path) {
  return String(baseUrl || "").replace(/\/+$/, "") + path;
}

function safeRequestId(value) {
  const text = String(value || "").trim();
  return REQUEST_ID_PATTERN.test(text) ? text : "";
}

function safeErrorCode(value) {
  const text = String(value || "").trim();
  return ERROR_CODE_PATTERN.test(text) ? text : "";
}

function parseRetryAfterSeconds(headerValue, now = Date.now) {
  const text = String(headerValue || "").trim();
  if (!text) return TKSLOPPER_DEFAULT_RETRY_AFTER_SECONDS;
  if (/^\d+$/.test(text)) {
    return Math.min(3600, Math.max(1, Number(text)));
  }
  const date = Date.parse(text);
  if (Number.isFinite(date)) {
    return Math.min(3600, Math.max(1, Math.ceil((date - now()) / 1000)));
  }
  return TKSLOPPER_DEFAULT_RETRY_AFTER_SECONDS;
}

// An abort while the body downloads is still a timeout, never "malformed".
async function readJsonBody(response, signal) {
  let text = "";
  try {
    text = await response.text();
  } catch (error) {
    if ((error && error.name === "AbortError") || (signal && signal.aborted)) {
      throw createAbortError("Managed AI attempt aborted");
    }
    return { ok: false, value: null };
  }
  throwIfAborted(signal);
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, value: null };
  }
}

function safeUsage(value) {
  if (!isObject(value)) return null;
  const usage = {};
  for (const key of ["prompt_tokens", "completion_tokens", "input_tokens", "output_tokens", "total_tokens"]) {
    if (Number.isFinite(value[key])) usage[key] = value[key];
  }
  return Object.keys(usage).length ? usage : null;
}

/**
 * Interpret a Chat Completions body. Mirrors tkslopper's
 * examples/chat-completion.ts requireCompleteChatText, except that truncated
 * or incomplete answers return "" so Vibbit's bounded empty-retry path runs.
 */
export function interpretChatCompletion(value, { requestId = "" } = {}) {
  const malformed = () => {
    throw new TkslopperProtocolError("Managed AI returned a malformed chat completion", { requestId });
  };
  if (!isObject(value) || !Array.isArray(value.choices)) malformed();
  const matches = value.choices.filter((choice) => isObject(choice) && choice.index === 0);
  if (matches.length !== 1) malformed();
  const choice = matches[0];
  if (
    !isObject(choice.message)
    || choice.message.role !== "assistant"
    || !("content" in choice.message)
    || !("refusal" in choice.message)
    || !("finish_reason" in choice)
  ) {
    malformed();
  }
  const { content, refusal } = choice.message;
  if (!(content === null || typeof content === "string") || !(refusal === null || typeof refusal === "string")) {
    malformed();
  }
  const finishReason = choice.finish_reason;
  if (finishReason === "content_filter" || refusal !== null) {
    throw new TkslopperRefusalError({ requestId });
  }
  // Partial content is never a result.
  if (finishReason === "length" || finishReason === null) {
    return { text: "", outcome: finishReason === null ? "incomplete" : "length" };
  }
  if (finishReason !== "stop") malformed();
  if (content === null || content.length === 0) {
    return { text: "", outcome: "incomplete" };
  }
  return { text: content, outcome: "stop" };
}

/**
 * Interpret a Responses body. tkslopper has not published a Responses outcome
 * contract yet, so only status "completed" with non-empty output text counts.
 */
export function interpretResponsesResult(value, { requestId = "" } = {}) {
  const malformed = () => {
    throw new TkslopperProtocolError("Managed AI returned a malformed response", { requestId });
  };
  if (!isObject(value) || typeof value.status !== "string") malformed();
  const output = value.output == null ? [] : value.output;
  if (!Array.isArray(output)) malformed();

  const textParts = [];
  let refused = false;
  for (const item of output) {
    if (!isObject(item)) malformed();
    if (item.type === "reasoning") continue;
    if (item.type !== "message" || !Array.isArray(item.content)) malformed();
    for (const part of item.content) {
      if (!isObject(part)) malformed();
      if (part.type === "refusal") {
        refused = true;
      } else if (part.type === "output_text") {
        if (typeof part.text !== "string") malformed();
        textParts.push(part.text);
      } else {
        malformed();
      }
    }
  }

  if (refused) throw new TkslopperRefusalError({ requestId });
  if (value.status !== "completed") {
    return { text: "", outcome: /^[a-z_]{1,32}$/.test(value.status) ? value.status : "incomplete" };
  }
  const text = textParts.join("");
  if (!text) return { text: "", outcome: "incomplete" };
  return { text, outcome: "completed" };
}

function normaliseMessages(messages) {
  if (!Array.isArray(messages) || !messages.length) {
    throw new TkslopperProtocolError("Managed AI request has no messages", { phase: "request" });
  }
  return messages.map((item) => {
    const role = item && item.role;
    if (role !== "system" && role !== "user" && role !== "assistant") {
      throw new TkslopperProtocolError("Managed AI request has an unsupported message role", { phase: "request" });
    }
    return { role, content: item.content == null ? "" : String(item.content) };
  });
}

function readEnvString(env, key) {
  return String(env[key] == null ? "" : env[key]).trim();
}

function parseStrictInteger(env, key, fallback, { min, max }) {
  const raw = readEnvString(env, key);
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${key} must be a whole number.`);
  const value = Number(raw);
  if (value < min || value > max) throw new Error(`${key} must be between ${min} and ${max}.`);
  return value;
}

// Errors name the variable only, never its value (URLs may carry secrets).
function parseServiceUrl(env, key, { requireHttps }) {
  const raw = readEnvString(env, key);
  if (!raw) throw new Error(`${key} is required when VIBBIT_TKSLOPPER_ENABLED=true.`);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${key} must be an absolute URL.`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${key} must use http or https.`);
  }
  if (requireHttps && parsed.protocol !== "https:") {
    throw new Error(`${key} must use https in hosted mode.`);
  }
  if (parsed.username || parsed.password) throw new Error(`${key} must not include credentials.`);
  if (parsed.search || parsed.hash) throw new Error(`${key} must not include a query or hash.`);
  if (/\/v1\/?$/i.test(parsed.pathname)) throw new Error(`${key} must be the base URL without /v1.`);
  return (parsed.origin + parsed.pathname).replace(/\/+$/, "");
}

/**
 * Parse VIBBIT_TKSLOPPER_* settings. When the flag is off nothing else is read,
 * so a broken managed-gateway config never blocks rollback. When it is on, any
 * missing or invalid setting fails startup.
 */
export function parseTkslopperConfig(envInput = {}, { isHosted = false } = {}) {
  const env = envInput || {};
  const enabledRaw = readEnvString(env, "VIBBIT_TKSLOPPER_ENABLED").toLowerCase();
  const enabled = ["1", "true", "yes", "on"].includes(enabledRaw);
  if (!enabled) return { enabled: false };

  const controlPlaneUrl = parseServiceUrl(env, "VIBBIT_TKSLOPPER_CONTROL_PLANE_URL", { requireHttps: isHosted });
  const gatewayUrl = parseServiceUrl(env, "VIBBIT_TKSLOPPER_GATEWAY_URL", { requireHttps: isHosted });

  const serviceCredential = readEnvString(env, "VIBBIT_TKSLOPPER_SERVICE_CREDENTIAL");
  if (!serviceCredential) {
    throw new Error("VIBBIT_TKSLOPPER_SERVICE_CREDENTIAL is required when VIBBIT_TKSLOPPER_ENABLED=true.");
  }
  if (serviceCredential.length > 256 || !TKSLOPPER_SERVICE_CREDENTIAL_PATTERN.test(serviceCredential)) {
    throw new Error("VIBBIT_TKSLOPPER_SERVICE_CREDENTIAL must be a tkslopper service credential (tksvc_<id>_<secret>).");
  }

  const endpoint = (readEnvString(env, "VIBBIT_TKSLOPPER_ENDPOINT") || "chat").toLowerCase();
  if (!TKSLOPPER_ENDPOINTS.includes(endpoint)) {
    throw new Error("VIBBIT_TKSLOPPER_ENDPOINT must be 'chat' or 'responses'.");
  }
  const alias = readEnvString(env, "VIBBIT_TKSLOPPER_ALIAS")
    || (endpoint === "responses" ? TKSLOPPER_DEFAULT_RESPONSES_ALIAS : TKSLOPPER_DEFAULT_CHAT_ALIAS);
  if (!TKSLOPPER_ALIAS_PATTERN.test(alias)) {
    throw new Error("VIBBIT_TKSLOPPER_ALIAS must be a versioned capability alias such as text.chat.v1.");
  }

  const maxOutputTokens = parseStrictInteger(env, "VIBBIT_TKSLOPPER_MAX_OUTPUT_TOKENS", 3072, { min: 1, max: 131072 });
  const temperatureRaw = readEnvString(env, "VIBBIT_TKSLOPPER_TEMPERATURE");
  let temperature = null;
  if (temperatureRaw && endpoint !== "chat") {
    throw new Error("VIBBIT_TKSLOPPER_TEMPERATURE applies to the chat endpoint only.");
  }
  if (temperatureRaw) {
    temperature = Number(temperatureRaw);
    if (!/^\d+(\.\d+)?$/.test(temperatureRaw) || temperature < 0 || temperature > 2) {
      throw new Error("VIBBIT_TKSLOPPER_TEMPERATURE must be empty or a number from 0 to 2.");
    }
  }
  const grantTtlSeconds = parseStrictInteger(env, "VIBBIT_TKSLOPPER_GRANT_TTL_SECONDS", 900, { min: 60, max: 3600 });
  const attemptTimeoutMs = parseStrictInteger(env, "VIBBIT_TKSLOPPER_ATTEMPT_TIMEOUT_MS", 45000, { min: 1000, max: 180000 });
  const totalBudgetMs = parseStrictInteger(env, "VIBBIT_TKSLOPPER_TOTAL_BUDGET_MS", 55000, { min: 1000, max: 600000 });
  const minAttemptMs = parseStrictInteger(env, "VIBBIT_TKSLOPPER_MIN_ATTEMPT_MS", 10000, { min: 0, max: 600000 });
  if (minAttemptMs > totalBudgetMs) {
    throw new Error("VIBBIT_TKSLOPPER_MIN_ATTEMPT_MS must not exceed VIBBIT_TKSLOPPER_TOTAL_BUDGET_MS.");
  }

  const classroomIdsRaw = readEnvString(env, "VIBBIT_TKSLOPPER_CLASSROOM_IDS");
  const classroomIds = classroomIdsRaw.split(",").map((item) => item.trim()).filter(Boolean);
  const allClassrooms = classroomIds.includes("*");

  const config = {
    enabled: true,
    allClassrooms,
    classroomIds: allClassrooms ? [] : classroomIds,
    controlPlaneUrl,
    gatewayUrl,
    endpoint,
    alias,
    maxOutputTokens,
    temperature,
    grantTtlSeconds,
    attemptTimeoutMs,
    totalBudgetMs,
    minAttemptMs
  };
  // Non-enumerable so the credential never rides along if config is serialised.
  Object.defineProperty(config, "serviceCredential", { value: serviceCredential, enumerable: false });
  return config;
}

/**
 * Per-generate wall-clock budget. Each attempt gets
 * min(attemptTimeoutMs, remaining budget); no attempt starts with less than
 * minAttemptMs remaining.
 */
export function createAttemptBudget({
  attemptTimeoutMs,
  totalBudgetMs,
  minAttemptMs,
  now = Date.now
} = {}) {
  const startedAt = now();
  return {
    nextAttemptTimeoutMs() {
      const remaining = totalBudgetMs - (now() - startedAt);
      if (remaining < minAttemptMs) {
        const error = createAbortError("Managed AI generate budget exhausted");
        error.timeoutMs = totalBudgetMs;
        throw error;
      }
      return Math.min(attemptTimeoutMs, remaining);
    }
  };
}

export function createTkslopperClient({
  controlPlaneUrl,
  gatewayUrl,
  serviceCredential,
  endpoint = "chat",
  alias,
  maxOutputTokens = 3072,
  temperature = null,
  grantTtlSeconds = 900,
  fetchImpl,
  now = Date.now,
  randomUUID = () => globalThis.crypto.randomUUID(),
  logger = () => {},
  exchangeTimeoutMs = DEFAULT_EXCHANGE_TIMEOUT_MS
} = {}) {
  const selectedEndpoint = TKSLOPPER_ENDPOINTS.includes(endpoint) ? endpoint : "chat";
  const selectedAlias = String(alias || "").trim()
    || (selectedEndpoint === "responses" ? TKSLOPPER_DEFAULT_RESPONSES_ALIAS : TKSLOPPER_DEFAULT_CHAT_ALIAS);
  const credential = String(serviceCredential || "");
  const doFetch = typeof fetchImpl === "function" ? fetchImpl : (url, init) => fetch(url, init);
  const tokenUrl = joinUrl(controlPlaneUrl, "/v1/token");
  const inferenceUrl = joinUrl(
    gatewayUrl,
    selectedEndpoint === "responses" ? "/v1/responses" : "/v1/chat/completions"
  );

  let cachedGrant = null;
  let inflightExchange = null;

  const log = (record) => {
    try {
      logger(record);
    } catch {
      // Logging must never break generation.
    }
  };

  const exchangeGrant = async () => {
    const controller = new AbortController();
    // Covers headers and body, so a stalled control plane cannot pin the shared exchange.
    const timeoutId = setTimeout(() => controller.abort(), exchangeTimeoutMs);
    try {
      return await exchangeGrantWithSignal(controller.signal);
    } finally {
      clearTimeout(timeoutId);
    }
  };

  const exchangeGrantWithSignal = async (signal) => {
    let response;
    try {
      response = await doFetch(tokenUrl, {
        method: "POST",
        redirect: "error",
        signal,
        headers: {
          Authorization: `Bearer ${credential}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ capabilities: [selectedAlias], ttl_seconds: grantTtlSeconds })
      });
    } catch {
      log({ event: "tkslopper.exchange", status: 0 });
      throw new TkslopperUnavailableError({ phase: "exchange" });
    }

    const requestId = safeRequestId(response.headers.get("x-tkslopper-request-id"));
    let parsed;
    try {
      parsed = await readJsonBody(response, signal);
    } catch {
      log({ event: "tkslopper.exchange", status: response.status, outcome: "timeout" });
      throw new TkslopperUnavailableError({ status: response.status, phase: "exchange" });
    }
    const bodyRequestId = parsed.ok && isObject(parsed.value) ? safeRequestId(parsed.value.request_id) : "";
    const code = parsed.ok && isObject(parsed.value) && isObject(parsed.value.error)
      ? safeErrorCode(parsed.value.error.code)
      : "";
    log({
      event: "tkslopper.exchange",
      status: response.status,
      ...(code ? { code } : {}),
      requestId: requestId || bodyRequestId || undefined
    });

    if (!response.ok) {
      throw new TkslopperUnavailableError({
        status: response.status,
        code,
        requestId: requestId || bodyRequestId,
        phase: "exchange"
      });
    }
    const grant = parsed.value;
    if (
      !parsed.ok
      || !isObject(grant)
      || typeof grant.access_token !== "string"
      || !grant.access_token
      || !Number.isFinite(grant.expires_in)
      || grant.expires_in <= 0
    ) {
      throw new TkslopperUnavailableError({ status: response.status, code: "invalid_grant", phase: "exchange" });
    }
    const lifetimeMs = grant.expires_in * 1000;
    return {
      accessToken: grant.access_token,
      expiresAt: now() + lifetimeMs,
      // Short-lived grants (capped by the environment) still get reused for half their life.
      refreshMarginMs: Math.min(GRANT_REFRESH_MARGIN_MS, lifetimeMs / 2)
    };
  };

  // Single-flight: concurrent callers share one in-flight exchange.
  const getGrant = (signal) => {
    // Check before starting an exchange nobody would await.
    throwIfAborted(signal);
    if (cachedGrant && cachedGrant.expiresAt - now() > cachedGrant.refreshMarginMs) {
      return Promise.resolve(cachedGrant);
    }
    if (!inflightExchange) {
      inflightExchange = exchangeGrant()
        .then((grant) => {
          cachedGrant = grant;
          return grant;
        })
        .finally(() => {
          inflightExchange = null;
        });
      // Callers may stop waiting; the shared promise must never reject unobserved.
      inflightExchange.catch(() => {});
    }
    return raceWithSignal(inflightExchange, signal);
  };

  const dropGrant = (rejected) => {
    if (cachedGrant && rejected && cachedGrant.accessToken === rejected.accessToken) {
      cachedGrant = null;
    }
  };

  const buildBody = (messages) => {
    const body = selectedEndpoint === "responses"
      ? { model: selectedAlias, input: messages, max_output_tokens: maxOutputTokens, stream: false }
      : { model: selectedAlias, messages, max_tokens: maxOutputTokens, stream: false };
    // Temperature is a chat-only knob; the Responses body stays strict.
    if (temperature != null && selectedEndpoint === "chat") body.temperature = temperature;
    return body;
  };

  const sendOnce = async (grant, bodyText, signal) => {
    throwIfAborted(signal);
    // A new key for every physical request; the gateway never replays.
    const idempotencyKey = String(randomUUID());
    try {
      return await doFetch(inferenceUrl, {
        method: "POST",
        redirect: "error",
        signal,
        headers: {
          Authorization: `Bearer ${grant.accessToken}`,
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey
        },
        body: bodyText
      });
    } catch (error) {
      if (error && error.name === "AbortError") throw error;
      if (signal && signal.aborted) throw createAbortError("Managed AI attempt aborted");
      return null;
    }
  };

  const complete = async ({ messages, signal, context = {} } = {}) => {
    const bodyText = JSON.stringify(buildBody(normaliseMessages(messages)));
    const logBase = {
      event: "tkslopper.inference",
      endpoint: selectedEndpoint,
      ...(context.classroomId ? { classroomId: String(context.classroomId) } : {}),
      ...(Number.isFinite(context.attempt) ? { attempt: context.attempt } : {})
    };

    let grant = await getGrant(signal);
    let response = await sendOnce(grant, bodyText, signal);
    let resent = false;

    if (response && (response.status === 401 || response.status === 403)) {
      const rejectedRequestId = safeRequestId(response.headers.get("x-tkslopper-request-id"));
      log({ ...logBase, status: response.status, requestId: rejectedRequestId || undefined });
      // Rejected before any provider call: refresh once and resend once.
      dropGrant(grant);
      await readJsonBody(response, signal);
      grant = await getGrant(signal);
      response = await sendOnce(grant, bodyText, signal);
      resent = true;
    }

    if (!response) {
      log({ ...logBase, status: 0, ...(resent ? { resent } : {}) });
      throw new TkslopperHttpError("Managed AI request failed (network error)", { status: 0 });
    }

    const headerRequestId = safeRequestId(response.headers.get("x-tkslopper-request-id"));
    const parsed = await readJsonBody(response, signal);
    const bodyRequestId = parsed.ok && isObject(parsed.value) ? safeRequestId(parsed.value.request_id) : "";
    const requestId = headerRequestId || bodyRequestId;

    if (!response.ok) {
      const code = parsed.ok && isObject(parsed.value) && isObject(parsed.value.error)
        ? safeErrorCode(parsed.value.error.code)
        : "";
      log({
        ...logBase,
        status: response.status,
        ...(code ? { code } : {}),
        ...(resent ? { resent } : {}),
        requestId: requestId || undefined
      });
      if (response.status === 401 || response.status === 403) {
        // Do not hand the rejected grant to the next request.
        dropGrant(grant);
        throw new TkslopperUnavailableError({ status: response.status, code, requestId });
      }
      const retryAfterSeconds = response.status === 402 || response.status === 429
        ? parseRetryAfterSeconds(response.headers.get("retry-after"), now)
        : 0;
      throw new TkslopperHttpError(`Managed AI request failed (HTTP ${response.status})`, {
        status: response.status,
        code,
        requestId,
        retryAfterSeconds
      });
    }

    if (!parsed.ok) {
      log({ ...logBase, status: response.status, outcome: "malformed", requestId: requestId || undefined });
      throw new TkslopperProtocolError("Managed AI returned a non-JSON response", { requestId });
    }

    let result;
    try {
      result = selectedEndpoint === "responses"
        ? interpretResponsesResult(parsed.value, { requestId })
        : interpretChatCompletion(parsed.value, { requestId });
    } catch (error) {
      log({
        ...logBase,
        status: response.status,
        outcome: error instanceof TkslopperRefusalError ? "refused" : "malformed",
        requestId: requestId || undefined
      });
      throw error;
    }
    const usage = safeUsage(parsed.value.usage);
    log({
      ...logBase,
      status: response.status,
      outcome: result.outcome,
      ...(usage ? { usage } : {}),
      ...(resent ? { resent } : {}),
      requestId: requestId || undefined
    });
    return result.text;
  };

  return {
    endpoint: selectedEndpoint,
    alias: selectedAlias,
    complete
  };
}
