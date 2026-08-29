#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  DEFAULT_MAX_CURRENT_CODE_PROMPT_CHARS,
  buildSystemPrompt,
  buildUserPrompt,
  parseModelOutput,
  runGenerationLoop,
  serializeTranscript,
  validateBlocksCompatibility
} from "../../shared/makecode-compat-core.mjs";
import {
  compileAndDecompile,
  scoreMakeCodeValidation
} from "../../shared/makecode-decompile.mjs";
import { summarizeRecords } from "./metrics.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const defaults = {
  corpus: path.join(here, "corpus.json"),
  samples: 3,
  temperature: 0.1,
  maxTokens: 3072,
  timeoutMs: 90000,
  provider: "openrouter",
  promptMode: "managed",
  policy: "raw",
  context: "full",
  maxCurrentCodeChars: DEFAULT_MAX_CURRENT_CODE_PROMPT_CHARS,
  currentCodeWindow: "production",
  maxEmptyRetries: 2,
  maxValidationRetries: 2,
  maxAttempts: 3,
  validation: "pinned",
  out: path.join(repoRoot, "output", "model-evals")
};

function usage() {
  console.log(`Usage:
  node evals/makecode-models/run.mjs --provider <openrouter|opencode-go|opencode-zen|custom> --models <id,id> [options]

Options:
  --endpoint URL       Override the OpenAI-compatible /chat/completions endpoint
  --key-env NAME       Environment variable containing the API key
  --protocol NAME      chat or responses (default: chat)
  --samples N          Repetitions per case/model (default: 3)
  --temperature N      Sampling temperature (default: 0.1)
  --seed N             Send seed + repetition number (only where supported)
  --prompt-mode MODE   managed or byok; byok adds Vibbit conversation guidance
  --policy MODE        raw one-shot baseline or production harness (default: raw)
  --context MODE       full, no-recent-chat, no-current-code, no-page-errors, or no-conversion-dialog
  --max-current-code-chars N  Current-code prompt budget (default: production budget)
  --current-code-window MODE   production, head, middle, or tail (default: production)
  --max-empty-retries N       Harness empty-output retries (default: 2)
  --max-validation-retries N  Harness compatibility/decompile retries (default: 2)
  --max-attempts N            Global Harness provider-attempt budget (default: 3)
  --validation MODE    pinned or static-only (default: pinned)
  --max-tokens N       Maximum output tokens (default: 3072)
  --timeout-ms N       Per-request timeout (default: 90000)
  --case REGEX         Run matching case IDs only
  --target LIST        Comma-separated microbit,arcade,maker filter
  --corpus PATH        Alternate corpus JSON
  --out DIR            Output root (default: output/model-evals)
  --dry-run            Validate and print the matrix without API calls

Default key variables:
  openrouter=OPENROUTER_API_KEY, opencode-go/zen=OPENCODE_API_KEY, custom=MODEL_EVAL_API_KEY`);
}

function parseArgs(argv) {
  const options = { ...defaults };
  const numberKeys = new Set([
    "samples",
    "temperature",
    "seed",
    "max-tokens",
    "timeout-ms",
    "max-current-code-chars",
    "max-empty-retries",
    "max-validation-retries",
    "max-attempts"
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (!arg.startsWith("--") || i + 1 >= argv.length) throw new Error(`Invalid argument: ${arg}`);
    const key = arg.slice(2);
    const value = argv[++i];
    const camelKey = key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    options[camelKey] = numberKeys.has(key) ? Number(value) : value;
  }
  if (options.help) return options;
  if (!options.models) throw new Error("--models is required");
  options.models = String(options.models).split(",").map((item) => item.trim()).filter(Boolean);
  if (!options.models.length) throw new Error("--models must contain at least one model ID");
  if (!Number.isInteger(options.samples) || options.samples < 1) throw new Error("--samples must be a positive integer");
  if (!Number.isFinite(options.temperature) || options.temperature < 0) throw new Error("--temperature must be non-negative");
  options.protocol = String(options.protocol || "chat").toLowerCase();
  if (!["chat", "responses"].includes(options.protocol)) throw new Error("--protocol must be chat or responses");
  if (!["managed", "byok"].includes(options.promptMode)) throw new Error("--prompt-mode must be managed or byok");
  if (!["raw", "harness"].includes(options.policy)) throw new Error("--policy must be raw or harness");
  if (!["full", "no-recent-chat", "no-current-code", "no-page-errors", "no-conversion-dialog"].includes(options.context)) {
    throw new Error("--context must be full, no-recent-chat, no-current-code, no-page-errors, or no-conversion-dialog");
  }
  if (!["production", "head", "middle", "tail"].includes(options.currentCodeWindow)) {
    throw new Error("--current-code-window must be production, head, middle, or tail");
  }
  if (!["pinned", "static-only"].includes(options.validation)) {
    throw new Error("--validation must be pinned or static-only");
  }
  for (const key of ["maxCurrentCodeChars", "maxEmptyRetries", "maxValidationRetries", "maxAttempts"]) {
    if (!Number.isInteger(options[key]) || options[key] < 0) throw new Error(`--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} must be a non-negative integer`);
  }
  if (options.maxAttempts < 1) throw new Error("--max-attempts must be at least 1");
  return options;
}

const PROVIDERS = {
  openrouter: {
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    modelsEndpoint: "https://openrouter.ai/api/v1/models",
    keyEnv: "OPENROUTER_API_KEY"
  },
  "opencode-go": {
    endpoint: "https://opencode.ai/zen/go/v1/chat/completions",
    modelsEndpoint: "https://opencode.ai/zen/go/v1/models",
    keyEnv: "OPENCODE_API_KEY"
  },
  "opencode-zen": {
    endpoint: "https://opencode.ai/zen/v1/chat/completions",
    modelsEndpoint: "https://opencode.ai/zen/v1/models",
    keyEnv: "OPENCODE_API_KEY"
  },
  custom: { keyEnv: "MODEL_EVAL_API_KEY" }
};

function timestampTag(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function strictContract(raw) {
  const text = String(raw || "");
  try {
    const parsed = JSON.parse(text);
    const keys = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? Object.keys(parsed).sort()
      : [];
    const exactKeys = keys.length === 2 && keys[0] === "code" && keys[1] === "feedback";
    const validFeedback = Array.isArray(parsed.feedback) && parsed.feedback.length > 0
      && parsed.feedback.every((item) => typeof item === "string" && item.trim());
    const validCode = typeof parsed.code === "string" && parsed.code.trim();
    return {
      ok: Boolean(exactKeys && validFeedback && validCode),
      exactJson: true,
      exactKeys,
      validFeedback: Boolean(validFeedback),
      validCode: Boolean(validCode)
    };
  } catch {
    return { ok: false, exactJson: false, exactKeys: false, validFeedback: false, validCode: false };
  }
}

export function criteriaResult(code, testCase) {
  const required = (testCase.required || []).map((source) => ({
    pattern: source,
    pass: new RegExp(source, "m").test(code)
  }));
  const forbidden = (testCase.forbidden || []).map((source) => ({
    pattern: source,
    pass: !new RegExp(source, "m").test(code)
  }));
  const checks = [...required, ...forbidden];
  return {
    ok: checks.every((item) => item.pass),
    passed: checks.filter((item) => item.pass).length,
    total: checks.length,
    required,
    forbidden
  };
}

function provisionalScore(contract, compatibility, criteria) {
  const contractPoints = contract.ok ? 10 : 0;
  const compatibilityPoints = compatibility.ok ? 10 : 0;
  const criteriaPoints = criteria.total ? 20 * criteria.passed / criteria.total : 20;
  return {
    score: Number((contractPoints + compatibilityPoints + criteriaPoints).toFixed(2)),
    max: 40
  };
}

function emptyMakeCodeValidation(message) {
  return {
    ok: false,
    compileOk: false,
    decompileOk: false,
    nativeBlocks: false,
    greyBlocks: 0,
    snippets: [],
    diagnostics: [{ messageText: message }],
    targetRelease: null,
    hashes: {},
    roundTripOk: null,
    reason: message
  };
}

async function runPinnedMakeCodeValidation(code, target, compileImpl = compileAndDecompile) {
  if (!String(code || "").trim()) {
    const report = emptyMakeCodeValidation("empty output");
    return { report, score: scoreMakeCodeValidation(report), error: null };
  }
  try {
    const report = await compileImpl({ code, target });
    return { report, score: scoreMakeCodeValidation(report), error: null };
  } catch {
    return {
      report: null,
      score: null,
      error: { code: "pinned_validation_unavailable", status: 0 }
    };
  }
}

export function buildPrompt(testCase, options) {
  const currentCode = options.context === "no-current-code" ? "" : (testCase.currentCode || "");
  const pageErrors = options.context === "no-page-errors" ? [] : (testCase.pageErrors || []);
  const recentChat = options.context === "no-recent-chat" ? "" : (testCase.recentChat || "");
  const system = buildSystemPrompt(testCase.target, { conversational: options.promptMode === "byok" });
  const user = buildUserPrompt({
    request: testCase.request,
    currentCode,
    pageErrors,
    conversionDialog: options.context === "no-conversion-dialog" ? null : (testCase.conversionDialog || null),
    recentChat,
    maxCurrentCodeChars: options.maxCurrentCodeChars,
    currentCodeStrategy: options.currentCodeWindow
  });
  return { system, user };
}

function extractResponseText(data) {
  const content = data && data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => typeof part === "string" ? part : (part && part.text) || "").join("");
  }
  return "";
}

function extractResponsesText(data) {
  if (typeof data?.output_text === "string") return data.output_text;
  return (Array.isArray(data?.output) ? data.output : [])
    .flatMap((item) => Array.isArray(item?.content) ? item.content : [])
    .map((item) => typeof item?.text === "string" ? item.text : "")
    .join("");
}

class EvaluatorRequestError extends Error {
  constructor(code, { status = 0, latencyMs = null } = {}) {
    super(code);
    this.name = "EvaluatorRequestError";
    this.code = code;
    this.status = status;
    this.latencyMs = latencyMs;
  }
}

function safeError(error) {
  return {
    code: String(error?.code || "evaluation_error"),
    status: Number(error?.status) || 0
  };
}

async function fetchJson(url, init, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const body = await response.text();
    const latencyMs = Math.round(performance.now() - started);
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      throw new EvaluatorRequestError("provider_invalid_json", {
        status: response.status,
        latencyMs
      });
    }
    if (!response.ok) {
      throw new EvaluatorRequestError("provider_http_error", {
        status: response.status,
        latencyMs
      });
    }
    return { data, latencyMs };
  } catch (error) {
    if (error instanceof EvaluatorRequestError) throw error;
    throw new EvaluatorRequestError(
      error?.name === "AbortError" ? "provider_timeout" : "provider_network_error",
      { latencyMs: Math.round(performance.now() - started) }
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function snapshotModels(providerConfig, timeoutMs) {
  if (!providerConfig.modelsEndpoint) return null;
  try {
    const { data } = await fetchJson(providerConfig.modelsEndpoint, {}, timeoutMs);
    return data;
  } catch (error) {
    return { snapshotError: safeError(error) };
  }
}

function pricingFor(model, modelSnapshot) {
  const entries = Array.isArray(modelSnapshot?.data) ? modelSnapshot.data : [];
  return entries.find((entry) => entry.id === model)?.pricing || null;
}

function finiteUsageValue(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

export function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  return {
    inputTokens: finiteUsageValue(usage.prompt_tokens, usage.input_tokens),
    outputTokens: finiteUsageValue(usage.completion_tokens, usage.output_tokens),
    totalTokens: finiteUsageValue(usage.total_tokens),
    reasoningTokens: finiteUsageValue(
      usage.completion_tokens_details?.reasoning_tokens,
      usage.output_tokens_details?.reasoning_tokens
    ),
    cachedInputTokens: finiteUsageValue(
      usage.prompt_tokens_details?.cached_tokens,
      usage.input_tokens_details?.cached_tokens
    )
  };
}

export function estimateCost(usage, pricing) {
  if (usage?.cost !== null && usage?.cost !== undefined && usage?.cost !== ""
    && Number.isFinite(Number(usage.cost))) return Number(usage.cost);
  if (!pricing) return null;
  const promptRate = Number(pricing.prompt);
  const completionRate = Number(pricing.completion);
  if (!Number.isFinite(promptRate) || !Number.isFinite(completionRate)) return null;
  const normalized = normalizeUsage(usage);
  const promptTokens = normalized?.inputTokens;
  const completionTokens = normalized?.outputTokens;
  if (!Number.isFinite(promptTokens) || !Number.isFinite(completionTokens)) return null;
  return promptTokens * promptRate + completionTokens * completionRate;
}

function providerBody(messages, model, repetition, options) {
  const serialized = serializeTranscript(messages);
  const body = options.protocol === "responses"
    ? {
        model,
        max_output_tokens: options.maxTokens,
        input: messages
      }
    : {
        model,
        temperature: options.temperature,
        max_tokens: options.maxTokens,
        messages
      };
  if (options.protocol === "responses" && !/^gpt-/i.test(model)) body.temperature = options.temperature;
  if (options.protocol === "chat" && Number.isInteger(options.seed)) body.seed = options.seed + repetition;
  return { body, serialized };
}

async function callProvider({
  messages,
  model,
  repetition,
  options,
  providerConfig,
  apiKey,
  modelSnapshot
}) {
  const { body, serialized } = providerBody(messages, model, repetition, options);
  const attemptBase = {
    requestMessages: messages.map((message) => ({ role: message.role, content: String(message.content || "") })),
    requestTranscriptSha256: sha256(`${serialized.system}\n${serialized.user}`)
  };
  let fetched;
  try {
    fetched = await fetchJson(providerConfig.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body)
    }, options.timeoutMs);
  } catch (error) {
    error.attempt = {
      ...attemptBase,
      failed: true,
      latencyMs: error.latencyMs,
      usage: null,
      normalizedUsage: null,
      costUsd: null,
      error: safeError(error)
    };
    throw error;
  }
  const { data, latencyMs } = fetched;
  const raw = options.protocol === "responses" ? extractResponsesText(data) : extractResponseText(data);
  const usage = data.usage || null;
  return {
    ...attemptBase,
    failed: false,
    raw,
    latencyMs,
    usage,
    normalizedUsage: normalizeUsage(usage),
    costUsd: estimateCost(usage, pricingFor(model, modelSnapshot)),
    responseId: data.id || null,
    resolvedModel: data.model || null,
    finishReason: data.choices?.[0]?.finish_reason || data.status || null,
    error: null
  };
}

function shuffledMatrix(models, cases, samples) {
  const rows = [];
  for (let repetition = 0; repetition < samples; repetition += 1) {
    for (let caseIndex = 0; caseIndex < cases.length; caseIndex += 1) {
      for (let modelIndex = 0; modelIndex < models.length; modelIndex += 1) {
        rows.push({
          repetition,
          testCase: cases[(caseIndex + repetition) % cases.length],
          model: models[(modelIndex + caseIndex + repetition) % models.length]
        });
      }
    }
  }
  return rows;
}

function providerAttemptTotals(providerAttempts) {
  const finiteLatencies = providerAttempts.map((attempt) => attempt.latencyMs).filter(Number.isFinite);
  const finiteCosts = providerAttempts.map((attempt) => attempt.costUsd).filter(Number.isFinite);
  const normalizedUsage = {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedInputTokens: 0,
    attemptsWithUsage: 0,
    attemptsWithoutUsage: 0
  };
  for (const attempt of providerAttempts) {
    if (!attempt.normalizedUsage) {
      normalizedUsage.attemptsWithoutUsage += 1;
      continue;
    }
    normalizedUsage.attemptsWithUsage += 1;
    for (const key of ["inputTokens", "outputTokens", "reasoningTokens", "cachedInputTokens"]) {
      if (Number.isFinite(attempt.normalizedUsage[key])) normalizedUsage[key] += attempt.normalizedUsage[key];
    }
  }
  return {
    latencyMs: finiteLatencies.length
      ? finiteLatencies.reduce((sum, value) => sum + value, 0)
      : null,
    costUsd: providerAttempts.length > 0 && finiteCosts.length === providerAttempts.length
      ? finiteCosts.reduce((sum, value) => sum + value, 0)
      : null,
    normalizedUsage
  };
}

function buildTrajectory(providerAttempts, policyResult = null) {
  return providerAttempts.map((attempt, attemptIndex) => {
    const harnessAttempt = policyResult?.attempts?.[attemptIndex] || {};
    return {
      attempt: attemptIndex + 1,
      requestMessages: attempt.requestMessages,
      requestTranscriptSha256: attempt.requestTranscriptSha256,
      rawCandidate: attempt.failed ? null : attempt.raw,
      parsedCandidate: attempt.failed ? null : {
        code: harnessAttempt.code || "",
        feedback: harnessAttempt.feedback || []
      },
      failureClass: attempt.failed
        ? "transport-or-provider"
        : (harnessAttempt.reason || "unknown"),
      latencyMs: attempt.latencyMs,
      usage: attempt.usage,
      normalizedUsage: attempt.normalizedUsage,
      costUsd: attempt.costUsd,
      responseId: attempt.responseId || null,
      resolvedModel: attempt.resolvedModel || null,
      finishReason: attempt.finishReason || null,
      error: attempt.error || null
    };
  });
}

export async function runHarnessEvaluation({
  target,
  systemPrompt,
  userPrompt,
  options,
  callModel,
  compileImpl = compileAndDecompile
}) {
  let validationOutage = null;
  const policyResult = await runGenerationLoop({
    target,
    systemPrompt,
    initialUserPrompt: userPrompt,
    emptyRetries: options.maxEmptyRetries,
    validationRetries: options.maxValidationRetries,
    maxAttempts: options.maxAttempts,
    callModel,
    runDecompile: options.validation === "pinned"
      ? async (code, requestedTarget) => {
          try {
            return await compileImpl({ code, target: requestedTarget });
          } catch (error) {
            validationOutage = error;
            throw error;
          }
        }
      : undefined
  });

  if (options.validation === "static-only") {
    return {
      policyResult,
      pinned: await runPinnedMakeCodeValidation(policyResult.code, target, compileImpl)
    };
  }
  const lastAttempt = policyResult.attempts[policyResult.attempts.length - 1] || null;
  if (lastAttempt?.decompile && !lastAttempt.decompile.skipped) {
    return {
      policyResult,
      pinned: {
        report: lastAttempt.decompile,
        score: scoreMakeCodeValidation(lastAttempt.decompile),
        error: null
      }
    };
  }
  return {
    policyResult,
    pinned: {
      report: null,
      score: null,
      error: validationOutage
        ? { code: "pinned_validation_unavailable", status: 0 }
        : null
    }
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  const providerConfig = { ...(PROVIDERS[options.provider] || PROVIDERS.custom) };
  if (options.endpoint) providerConfig.endpoint = options.endpoint;
  else if (options.protocol === "responses") {
    providerConfig.endpoint = providerConfig.endpoint?.replace(/\/chat\/completions$/, "/responses");
  }
  if (!providerConfig.endpoint) throw new Error("--endpoint is required for this provider");
  const keyEnv = options.keyEnv || providerConfig.keyEnv;
  const apiKey = process.env[keyEnv] || "";

  const corpus = JSON.parse(await readFile(path.resolve(options.corpus), "utf8"));
  let cases = corpus.cases || [];
  if (options.case) {
    const filter = new RegExp(options.case);
    cases = cases.filter((item) => filter.test(item.id));
  }
  if (options.target) {
    const targets = new Set(String(options.target).split(",").map((item) => item.trim()));
    cases = cases.filter((item) => targets.has(item.target));
  }
  if (!cases.length) throw new Error("No corpus cases matched the filters");

  const matrix = shuffledMatrix(options.models, cases, options.samples);
  if (options.dryRun) {
    console.log(JSON.stringify({ provider: options.provider, models: options.models, cases: cases.length, requests: matrix.length }, null, 2));
    return;
  }
  if (!apiKey) throw new Error(`${keyEnv} is required (the key is never written to output)`);

  const runDir = path.join(path.resolve(options.out), `${options.provider}-${timestampTag()}`);
  await mkdir(runDir, { recursive: true });
  const modelSnapshot = await snapshotModels(providerConfig, options.timeoutMs);
  await writeFile(path.join(runDir, "models-snapshot.json"), JSON.stringify(modelSnapshot, null, 2) + "\n");

  const records = [];
  const validationRecords = [];
  for (let index = 0; index < matrix.length; index += 1) {
    const { model, testCase, repetition } = matrix[index];
    const { system, user } = buildPrompt(testCase, options);

    process.stdout.write(`[${index + 1}/${matrix.length}] ${model} ${testCase.id} #${repetition + 1} ... `);
    const base = {
      schemaVersion: 3,
      provider: options.provider,
      endpoint: providerConfig.endpoint,
      policy: options.policy,
      context: options.context,
      validationMode: options.validation,
      requestedModel: model,
      model,
      caseId: testCase.id,
      target: testCase.target,
      targetBoard: testCase.targetBoard || null,
      category: testCase.category,
      repetition,
      temperature: options.temperature,
      promptMode: options.promptMode,
      seed: Number.isInteger(options.seed) ? options.seed + repetition : null,
      systemPromptSha256: sha256(system),
      userPromptSha256: sha256(user),
      corpusVersion: corpus.version
    };
    const providerAttempts = [];
    try {
      const invoke = async (messages) => {
        try {
          const attempt = await callProvider({
            messages,
            model,
            repetition,
            options,
            providerConfig,
            apiKey,
            modelSnapshot
          });
          providerAttempts.push(attempt);
          return attempt.raw;
        } catch (error) {
          if (error.attempt) providerAttempts.push(error.attempt);
          throw error;
        }
      };
      let policyResult;
      let pinned;
      if (options.policy === "harness") {
        ({ policyResult, pinned } = await runHarnessEvaluation({
          target: testCase.target,
          systemPrompt: system,
          userPrompt: user,
          options,
          callModel: invoke,
          compileImpl: compileAndDecompile
        }));
      } else {
        const raw = await invoke([
          { role: "system", content: system },
          { role: "user", content: user }
        ]);
        const parsed = parseModelOutput(raw);
        const compatibility = parsed.code
          ? validateBlocksCompatibility(parsed.code, testCase.target)
          : { ok: false, violations: ["empty output"] };
        pinned = await runPinnedMakeCodeValidation(parsed.code, testCase.target);
        const reason = !String(parsed.code || "").trim()
          ? "empty"
          : (!compatibility.ok ? "invalid" : (pinned.report && !pinned.report.ok ? "decompile" : "ok"));
        policyResult = {
          code: parsed.code,
          feedback: parsed.feedback,
          validation: compatibility,
          upstreamAttempts: 1,
          outcome: reason === "ok" ? (pinned.report ? "ok" : "ok-unverified") : "raw-invalid",
          attempts: [{
            raw,
            code: parsed.code,
            feedback: parsed.feedback,
            validation: compatibility,
            reason,
            decompile: pinned?.report || null
          }]
        };
      }

      const finalProviderAttempt = providerAttempts[providerAttempts.length - 1];
      const raw = finalProviderAttempt?.raw || "";
      const parsed = { code: policyResult.code, feedback: policyResult.feedback };
      const contract = strictContract(raw);
      const compatibility = policyResult.code
        ? validateBlocksCompatibility(policyResult.code, testCase.target)
        : { ok: false, violations: ["empty output"] };
      const criteria = criteriaResult(policyResult.code, testCase);
      const provisional = provisionalScore(contract, compatibility, criteria);
      const fallback = String(policyResult.outcome).startsWith("stub-");
      const pinnedAvailable = Boolean(pinned?.report);
      const makeCodeOk = Boolean(pinned?.report?.ok);
      const staticPolicyPass = !fallback && compatibility.ok && criteria.ok;
      const automatedProxyPass = staticPolicyPass && makeCodeOk;
      const strictAutomatedProxyPass = automatedProxyPass && contract.ok;
      const firstAttempt = policyResult.attempts[0] || null;
      const firstCriteria = criteriaResult(firstAttempt?.code || "", testCase);
      const firstAttemptProxyPass = firstAttempt?.decompile && !firstAttempt.decompile.skipped
        ? Boolean(firstAttempt.reason === "ok" && firstCriteria.ok && firstAttempt.decompile.ok)
        : null;
      const repairEligible = Boolean(firstAttempt && firstAttempt.reason !== "ok");
      const repaired = repairEligible && automatedProxyPass;
      const finalReason = policyResult.attempts[policyResult.attempts.length - 1]?.reason || null;
      const failureClass = automatedProxyPass
        ? (contract.ok ? null : "response-contract")
        : (fallback ? `fallback-${finalReason || "unknown"}`
          : (!compatibility.ok ? "compatibility"
            : (!criteria.ok ? "task-criteria"
              : (!pinnedAvailable ? "validation-unavailable"
                : (!makeCodeOk ? "makecode" : (!contract.ok ? "response-contract" : "unknown"))))));
      const totals = providerAttemptTotals(providerAttempts);
      const trajectory = buildTrajectory(providerAttempts, policyResult);
      const totalScore = pinned?.score
        ? Number((provisional.score + pinned.score.score).toFixed(2))
        : null;
      const record = {
        ...base,
        status: "ok",
        responseId: finalProviderAttempt?.responseId || null,
        resolvedModel: finalProviderAttempt?.resolvedModel || null,
        finishReason: finalProviderAttempt?.finishReason || null,
        latencyMs: totals.latencyMs,
        usage: providerAttempts.map((attempt) => attempt.usage),
        normalizedUsage: totals.normalizedUsage,
        costUsd: totals.costUsd,
        raw,
        parsed,
        contract,
        compatibility,
        criteria,
        provisional,
        totalScore,
        totalMax: totalScore === null ? null : 100,
        outcome: policyResult.outcome,
        upstreamAttempts: policyResult.upstreamAttempts,
        trajectory,
        makeCodeValidation: pinned?.report || null,
        validationError: pinned?.error || null,
        evaluation: {
          staticPolicyPass,
          automatedProxyPass,
          strictAutomatedProxyPass,
          firstAttemptProxyPass,
          passWithinBudget: automatedProxyPass,
          repairEligible,
          repaired,
          fallback,
          falseSuccess: pinnedAvailable ? staticPolicyPass && !makeCodeOk : null,
          failureClass,
          latencyMs: totals.latencyMs,
          costUsd: totals.costUsd
        }
      };
      records.push(record);
      validationRecords.push({
        requestedModel: model,
        caseId: testCase.id,
        repetition,
        target: testCase.target,
        targetBoard: testCase.targetBoard || null,
        policy: options.policy,
        outcome: policyResult.outcome,
        makeCodeValidation: pinned?.report || null,
        makeCodeScore: pinned?.score || null,
        totalScore,
        totalMax: totalScore === null ? null : 100,
        evaluation: record.evaluation,
        error: pinned?.error || null
      });
      const verdict = strictAutomatedProxyPass
        ? "STRICT AUTOMATED PROXY PASS"
        : (automatedProxyPass ? `AUTOMATED PROXY PASS (${failureClass})` : failureClass);
      console.log(`${policyResult.outcome}, ${policyResult.upstreamAttempts} attempt(s), ${verdict}, ${totals.latencyMs}ms`);
    } catch (error) {
      const totals = providerAttemptTotals(providerAttempts);
      const publicError = safeError(error);
      records.push({
        ...base,
        status: "error",
        error: publicError,
        latencyMs: totals.latencyMs,
        usage: providerAttempts.map((attempt) => attempt.usage),
        normalizedUsage: totals.normalizedUsage,
        costUsd: totals.costUsd,
        trajectory: buildTrajectory(providerAttempts),
        makeCodeValidation: null,
        evaluation: {
          staticPolicyPass: false,
          automatedProxyPass: false,
          strictAutomatedProxyPass: false,
          firstAttemptProxyPass: null,
          passWithinBudget: false,
          repairEligible: false,
          repaired: false,
          fallback: false,
          falseSuccess: false,
          failureClass: "transport-or-provider",
          latencyMs: totals.latencyMs,
          costUsd: totals.costUsd
        }
      });
      validationRecords.push({
        requestedModel: model,
        caseId: testCase.id,
        repetition,
        target: testCase.target,
        makeCodeValidation: null,
        makeCodeScore: { score: 0, max: 60 },
        totalScore: 0,
        totalMax: 100,
        error: publicError
      });
      console.log(`ERROR ${publicError.code}`);
    }
  }

  const resultsPath = path.join(runDir, "results.jsonl");
  await writeFile(resultsPath, records.map((item) => JSON.stringify(item)).join("\n") + "\n");
  const validationPath = path.join(runDir, "makecode-validation.jsonl");
  await writeFile(validationPath, validationRecords.map((item) => JSON.stringify(item)).join("\n") + "\n");
  const scoreByCase = new Map();
  for (const item of validationRecords) {
    if (!Number.isFinite(item.totalScore)) continue;
    if (!scoreByCase.has(item.caseId)) scoreByCase.set(item.caseId, []);
    scoreByCase.get(item.caseId).push(item.totalScore);
  }
  const caseMeans = [...scoreByCase.values()].map((scores) => (
    scores.reduce((sum, score) => sum + score, 0) / scores.length
  ));
  const meanTotal = caseMeans.length
    ? Number((caseMeans.reduce((sum, score) => sum + score, 0) / caseMeans.length).toFixed(2))
    : null;
  const summary = {
    schemaVersion: 3,
    createdAt: new Date().toISOString(),
    provider: options.provider,
    protocol: options.protocol,
    policy: options.policy,
    context: options.context,
    validationMode: options.validation,
    maxCurrentCodeChars: options.maxCurrentCodeChars,
    currentCodeWindow: options.currentCodeWindow,
    maxEmptyRetries: options.maxEmptyRetries,
    maxValidationRetries: options.maxValidationRetries,
    maxAttempts: options.maxAttempts,
    endpoint: providerConfig.endpoint,
    corpus: path.relative(repoRoot, path.resolve(options.corpus)),
    corpusVersion: corpus.version,
    models: options.models,
    samples: options.samples,
    temperature: options.temperature,
    promptMode: options.promptMode,
    seed: Number.isInteger(options.seed) ? options.seed : null,
    requests: records.length,
    successfulRequests: records.filter((item) => item.status === "ok").length,
    errors: records.filter((item) => item.status === "error").length,
    macroMeanTotalScore: meanTotal,
    metrics: summarizeRecords(records),
    note: "results.jsonl is a local, immutable evaluation capture containing raw prompts, candidates, and retry trajectories; review it as potentially sensitive. Pinned compile/decompile results live in makecode-validation.jsonl.",
    results: "results.jsonl",
    makeCodeValidation: "makecode-validation.jsonl",
    modelSnapshot: "models-snapshot.json"
  };
  await writeFile(path.join(runDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(`Run written to ${runDir}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
