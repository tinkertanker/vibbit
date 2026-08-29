#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  currentCodeWindow: "head",
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
  --context MODE       full, no-recent-chat, no-current-code, or no-page-errors
  --max-current-code-chars N  Current-code prompt budget (default: production budget)
  --current-code-window MODE   head, middle, or tail comparison (default: head)
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
  if (!["full", "no-recent-chat", "no-current-code", "no-page-errors"].includes(options.context)) {
    throw new Error("--context must be full, no-recent-chat, no-current-code, or no-page-errors");
  }
  if (!["head", "middle", "tail"].includes(options.currentCodeWindow)) {
    throw new Error("--current-code-window must be head, middle, or tail");
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

function criteriaResult(code, testCase) {
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

async function runPinnedMakeCodeValidation(code, target) {
  if (!String(code || "").trim()) {
    const report = emptyMakeCodeValidation("empty output");
    return { report, score: scoreMakeCodeValidation(report), error: null };
  }
  try {
    const report = await compileAndDecompile({ code, target });
    return { report, score: scoreMakeCodeValidation(report), error: null };
  } catch (error) {
    const report = emptyMakeCodeValidation(error.message);
    return { report, score: scoreMakeCodeValidation(report), error: error.message };
  }
}

function selectCurrentCodeWindow(value, maxChars, mode) {
  const source = String(value || "");
  if (!maxChars || source.length <= maxChars || mode === "head") return source;
  if (mode === "tail") return source.slice(-maxChars);
  const start = Math.max(0, Math.floor((source.length - maxChars) / 2));
  return source.slice(start, start + maxChars);
}

function buildPrompt(testCase, options) {
  const sourceCode = options.context === "no-current-code" ? "" : (testCase.currentCode || "");
  const currentCode = selectCurrentCodeWindow(sourceCode, options.maxCurrentCodeChars, options.currentCodeWindow);
  const pageErrors = options.context === "no-page-errors" ? [] : (testCase.pageErrors || []);
  const recentChat = options.context === "no-recent-chat" ? "" : (testCase.recentChat || "");
  const system = buildSystemPrompt(testCase.target, { conversational: options.promptMode === "byok" });
  const user = buildUserPrompt({
    request: testCase.request,
    currentCode,
    pageErrors,
    conversionDialog: options.context === "no-page-errors" ? null : (testCase.conversionDialog || null),
    recentChat,
    maxCurrentCodeChars: options.maxCurrentCodeChars
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
      throw new Error(`HTTP ${response.status}: non-JSON response (${body.slice(0, 160)})`);
    }
    if (!response.ok) {
      const detail = data?.error?.message || data?.message || body.slice(0, 200);
      throw new Error(`HTTP ${response.status}: ${detail}`);
    }
    return { data, latencyMs };
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
    return { snapshotError: error.message };
  }
}

function pricingFor(model, modelSnapshot) {
  const entries = Array.isArray(modelSnapshot?.data) ? modelSnapshot.data : [];
  return entries.find((entry) => entry.id === model)?.pricing || null;
}

function estimateCost(usage, pricing) {
  if (Number.isFinite(Number(usage?.cost))) return Number(usage.cost);
  if (!pricing) return null;
  const promptRate = Number(pricing.prompt);
  const completionRate = Number(pricing.completion);
  if (!Number.isFinite(promptRate) || !Number.isFinite(completionRate)) return null;
  const promptTokens = Number(usage?.prompt_tokens || 0);
  const completionTokens = Number(usage?.completion_tokens || 0);
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
  const { data, latencyMs } = await fetchJson(providerConfig.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body)
  }, options.timeoutMs);
  const raw = options.protocol === "responses" ? extractResponsesText(data) : extractResponseText(data);
  const usage = data.usage || null;
  return {
    raw,
    latencyMs,
    usage,
    costUsd: estimateCost(usage, pricingFor(model, modelSnapshot)),
    responseId: data.id || null,
    resolvedModel: data.model || null,
    finishReason: data.choices?.[0]?.finish_reason || data.status || null,
    requestMessages: messages.map((message) => ({ role: message.role, content: String(message.content || "") })),
    requestTranscriptSha256: sha256(`${serialized.system}\n${serialized.user}`)
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
      schemaVersion: 2,
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
    try {
      const providerAttempts = [];
      const invoke = async (messages) => {
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
      };
      let policyResult;
      let pinned;
      if (options.policy === "harness") {
        policyResult = await runGenerationLoop({
          target: testCase.target,
          systemPrompt: system,
          initialUserPrompt: user,
          emptyRetries: options.maxEmptyRetries,
          validationRetries: options.maxValidationRetries,
          maxAttempts: options.maxAttempts,
          callModel: invoke,
          runDecompile: options.validation === "pinned"
            ? async (code, target) => (await runPinnedMakeCodeValidation(code, target)).report
            : undefined
        });
        const lastAttempt = policyResult.attempts[policyResult.attempts.length - 1] || null;
        pinned = options.validation === "pinned" && lastAttempt?.decompile && !lastAttempt.decompile.skipped
          ? {
              report: lastAttempt.decompile,
              score: scoreMakeCodeValidation(lastAttempt.decompile),
              error: null
            }
          : null;
      } else {
        const raw = await invoke([
          { role: "system", content: system },
          { role: "user", content: user }
        ]);
        const parsed = parseModelOutput(raw);
        const compatibility = parsed.code
          ? validateBlocksCompatibility(parsed.code, testCase.target)
          : { ok: false, violations: ["empty output"] };
        pinned = options.validation === "pinned"
          ? await runPinnedMakeCodeValidation(parsed.code, testCase.target)
          : null;
        const reason = !String(parsed.code || "").trim()
          ? "empty"
          : (!compatibility.ok ? "invalid" : (pinned && !pinned.report.ok ? "decompile" : "ok"));
        policyResult = {
          code: parsed.code,
          feedback: parsed.feedback,
          validation: compatibility,
          upstreamAttempts: 1,
          outcome: reason === "ok" ? "ok" : "raw-invalid",
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
      const makeCodeOk = options.validation === "static-only" ? compatibility.ok : Boolean(pinned?.report?.ok);
      const harnessPass = !fallback && compatibility.ok && criteria.ok && makeCodeOk;
      const hardPass = harnessPass && contract.ok;
      const firstAttempt = policyResult.attempts[0] || null;
      const firstCriteria = criteriaResult(firstAttempt?.code || "", testCase);
      const firstMakeCodeOk = options.validation === "static-only"
        ? Boolean(firstAttempt?.validation?.ok)
        : Boolean(firstAttempt?.decompile?.ok);
      const firstAttemptPass = Boolean(firstAttempt?.reason === "ok" && firstCriteria.ok && firstMakeCodeOk);
      const repairEligible = Boolean(firstAttempt && firstAttempt.reason !== "ok");
      const repaired = repairEligible && harnessPass;
      const finalReason = policyResult.attempts[policyResult.attempts.length - 1]?.reason || null;
      const failureClass = harnessPass
        ? (contract.ok ? null : "response-contract")
        : (fallback ? `fallback-${finalReason || "unknown"}`
          : (!compatibility.ok ? "compatibility"
            : (!criteria.ok ? "task-criteria"
              : (!makeCodeOk ? "decompile" : (!contract.ok ? "response-contract" : "unknown")))));
      const latencyMs = providerAttempts.reduce((sum, attempt) => sum + attempt.latencyMs, 0);
      const numericCosts = providerAttempts.map((attempt) => attempt.costUsd).filter(Number.isFinite);
      const costUsd = numericCosts.length === providerAttempts.length
        ? numericCosts.reduce((sum, value) => sum + value, 0)
        : null;
      const trajectory = providerAttempts.map((attempt, attemptIndex) => {
        const harnessAttempt = policyResult.attempts[attemptIndex] || {};
        return {
          attempt: attemptIndex + 1,
          requestMessages: attempt.requestMessages,
          requestTranscriptSha256: attempt.requestTranscriptSha256,
          rawCandidate: attempt.raw,
          parsedCandidate: {
            code: harnessAttempt.code || "",
            feedback: harnessAttempt.feedback || []
          },
          failureClass: harnessAttempt.reason || "unknown",
          latencyMs: attempt.latencyMs,
          usage: attempt.usage,
          costUsd: attempt.costUsd,
          responseId: attempt.responseId,
          resolvedModel: attempt.resolvedModel,
          finishReason: attempt.finishReason
        };
      });
      const record = {
        ...base,
        status: "ok",
        responseId: finalProviderAttempt?.responseId || null,
        resolvedModel: finalProviderAttempt?.resolvedModel || null,
        finishReason: finalProviderAttempt?.finishReason || null,
        latencyMs,
        usage: providerAttempts.map((attempt) => attempt.usage),
        costUsd,
        raw,
        parsed,
        contract,
        compatibility,
        criteria,
        provisional,
        outcome: policyResult.outcome,
        upstreamAttempts: policyResult.upstreamAttempts,
        trajectory,
        makeCodeValidation: pinned?.report || null,
        evaluation: {
          hardPass,
          harnessPass,
          firstAttemptPass,
          passWithinBudget: harnessPass,
          repairEligible,
          repaired,
          fallback,
          falseSuccess: !fallback && ["ok", "ok-unverified"].includes(policyResult.outcome) && !harnessPass,
          failureClass,
          latencyMs,
          costUsd
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
        makeCodeScore: pinned?.score || { score: compatibility.ok ? 20 : 0, max: 20 },
        totalScore: Number((provisional.score + (pinned?.score?.score || 0)).toFixed(2)),
        totalMax: 100,
        evaluation: record.evaluation,
        error: pinned?.error || null
      });
      const verdict = hardPass ? "HARD PASS" : (harnessPass ? `HARNESS PASS (${failureClass})` : failureClass);
      console.log(`${policyResult.outcome}, ${policyResult.upstreamAttempts} attempt(s), ${verdict}, ${latencyMs}ms`);
    } catch (error) {
      records.push({
        ...base,
        status: "error",
        error: error.message,
        makeCodeValidation: null,
        evaluation: {
          hardPass: false,
          harnessPass: false,
          firstAttemptPass: false,
          passWithinBudget: false,
          repairEligible: false,
          repaired: false,
          fallback: false,
          falseSuccess: false,
          failureClass: "transport-or-provider",
          latencyMs: null,
          costUsd: null
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
        error: error.message
      });
      console.log(`ERROR ${error.message}`);
    }
  }

  const resultsPath = path.join(runDir, "results.jsonl");
  await writeFile(resultsPath, records.map((item) => JSON.stringify(item)).join("\n") + "\n");
  const validationPath = path.join(runDir, "makecode-validation.jsonl");
  await writeFile(validationPath, validationRecords.map((item) => JSON.stringify(item)).join("\n") + "\n");
  const scored = validationRecords.filter((item) => item.makeCodeValidation);
  const meanTotal = scored.length
    ? Number((scored.reduce((sum, item) => sum + item.totalScore, 0) / scored.length).toFixed(2))
    : null;
  const summary = {
    schemaVersion: 2,
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
    meanTotalScore: meanTotal,
    metrics: summarizeRecords(records),
    note: "results.jsonl is a local, immutable evaluation capture containing raw prompts, candidates, and retry trajectories; review it as potentially sensitive. Pinned compile/decompile results live in makecode-validation.jsonl.",
    results: "results.jsonl",
    makeCodeValidation: "makecode-validation.jsonl",
    modelSnapshot: "models-snapshot.json"
  };
  await writeFile(path.join(runDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(`Run written to ${runDir}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
