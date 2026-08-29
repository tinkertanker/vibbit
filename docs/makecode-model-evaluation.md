# MakeCode model evaluation

This suite compares models on the outcome Vibbit actually needs: valid response JSON containing target-correct MakeCode Static TypeScript that compiles and decompiles entirely to native Blocks.

The model sampler and corpus are available now:

- `evals/makecode-models/corpus.json`: 24 cases across micro:bit, Arcade, and Maker and across eight task categories. Micro:bit is the primary screening target; Arcade and Maker remain cross-target regression checks.
- `evals/makecode-models/corpus-adversarial.json`: separate source-hierarchy cases with instructions embedded in current code, diagnostics, conversion dialogs, stale chat, and different context positions. Do not mix these into the ordinary quality score.
- `evals/makecode-models/run.mjs`: exact Vibbit prompt construction, raw one-shot and production `runGenerationLoop` policies, immutable request/candidate/retry trajectories, pinned validation, context/retry ablations, latency, usage, and cost capture.
- `evals/makecode-models/metrics.mjs`: static-policy/automated-proxy/first-attempt/budget pass rates, conditional repair, fallback and false-success rates, failure classes, token/cost totals, latency/cost quantiles, Wilson intervals, and paired bootstrap model comparisons.
- `evals/makecode-models/compare.mjs`: paired comparison of two completed policy/context/window runs by provider, model, case, and repetition.

The sampler awards 40 contract and prefilter points in `results.jsonl`. A regex cannot establish whether an API exists or code decompiles. The remaining 60 points come from the pinned MakeCode compiler and decompiler in `shared/makecode-decompile.mjs`. Those scores are written to `makecode-validation.jsonl` beside the raw JSONL. The raw file stays immutable.

## What is being compared

Treat a row as a **model plus route**, not just a model name. For example, `glm-5.3` through OpenCode Go and Zen are separate candidates, and an equivalent OpenRouter slug is another candidate. Routing, quantization, provider fallback, and serving configuration can change quality and latency.

Record these with every run:

- requested and provider-resolved model IDs;
- gateway and endpoint;
- model-list metadata snapshot;
- corpus version and SHA-256 hashes of the exact system and user prompts;
- target, and the hardware variant for Maker;
- temperature, maximum tokens, seed if accepted, and repetition number;
- wall-clock latency, finish reason, native token counts, cache/reasoning token details, and billed cost when returned;
- MakeCode target release, PXT release, hardware variant, compile/decompile diagnostics, and grey-block count.

OpenCode's available models change. Snapshot `GET /v1/models` on each run and select `--protocol chat` for `/chat/completions` models or `--protocol responses` for `/responses` models. Models that require `/messages` are not comparable through this harness without a separate adapter. API requests use bare model IDs such as `glm-5.3`; the `opencode-go/...` and `opencode/...` prefixes are OpenCode client configuration IDs, not the API request IDs.

## Corpus design

There is one case per category per target:

1. simple generation;
2. event handlers;
3. state;
4. compile-error repair with `CURRENT_CODE` and `PAGE_ERRORS`;
5. conversion-error repair with `CURRENT_CODE` and `CONVERSION_DIALOG`;
6. positive and negative prompt adherence;
7. unsupported or invented APIs;
8. valid-looking TypeScript constructs that compile in ordinary TypeScript but do not become native Blocks.

Each case has conservative required and forbidden patterns. They are textual proxies for requested constructs and behaviours such as exact pins, timing calls, event names, and prohibited APIs. They are not a semantic oracle: equivalent code can miss a textual pattern, and matching every pattern does not prove correctness. Any pattern change is a corpus-version change and should be reviewed against known-good target output.

### Target constraints

- **micro:bit:** use the target's `basic`, `input`, and optional `radio` packages, exact enum members, block signatures, and top-level event registrations. A compile fixture that uses radio must include the radio dependency.
- **Arcade:** use Arcade sprite/controller/scene/game/info APIs and image literals. Accept canonical decompiler normalization, such as a sprite flag replacing a compatibility convenience method; score semantics or Blocks XML rather than textual round-trip identity.
- **Maker:** pin a board because Maker is a family of hardware packages, not one uniform API. The corpus uses **Adafruit Circuit Playground Express**. Canonical Maker code uses fixed button objects (`input.buttonA.onEvent(ButtonEvent.Click, ...)`) and global `forever`/`pause`. `pins.LED` and A0–A7 support digital read/write; A0–A2 support analogue output; A1–A7 support analogue input; A1–A2 support servo output. Temperature requires `TemperatureUnit.Celsius`. Pin capabilities and sensor/button packages differ by board.

Vibbit's Maker catalog now uses this same fixed Circuit Playground Express surface. Keep reporting Maker separately because it remains board-specific, not because its prompt is quarantined.

## Scoring

Score a response out of 100 only when pinned validation is available. Provider/transport failures count as zero; compiler/decompiler infrastructure outages are unmeasured rather than model failures. Macro-average by case so repeated successes or failures do not change case weighting. Use micro:bit results as the primary product signal while retaining separate Arcade and Maker regressions:

| Dimension | Points | Rule |
|---|---:|---|
| Strict JSON contract | 10 | Raw response is exactly one JSON object with only `feedback` (non-empty string array) and non-empty string `code`; no fences or prose. |
| Vibbit static prefilter | 10 | `validateBlocksCompatibility(code, target)` reports no violation. |
| Prompt/repair adherence | 20 | Pro-rate the case's required and forbidden textual proxy criteria. Review failures before changing patterns. |
| Target compile | 20 | Pinned target compilation succeeds with no error diagnostics. |
| TypeScript-to-Blocks decompile | 25 | Decompiler succeeds, emits non-empty `main.blocks`, and has no error diagnostics. |
| Native Blocks only | 10 | No `typescript_statement` or `typescript_expression` XML. |
| Blocks round trip | 5 | Recompile the emitted Blocks/derived TypeScript successfully without errors. |

The first three dimensions are the harness's **40-point provisional score**. Never rank production candidates on that score alone.

A **strict automated proxy pass** requires all of the following, regardless of weighted score:

- successful provider request and non-empty code;
- strict JSON contract;
- target compilation;
- successful decompilation;
- zero grey TypeScript statement/expression blocks;
- all required and forbidden case criteria;
- for repair cases, the textual proxy criteria for removing the reported bad construct and retaining requested behaviour pass.

Report:

- macro-average score per model-plus-route candidate (each of 24 cases equal weight), automated-proxy pass rate, and pass rate by target and category;
- JSON, compile, decompile, grey-block, unsupported-API, and adherence failure rates separately;
- median and p95 latency, input/output/reasoning token totals, known/unknown cost counts, total known cost, and cost per strict automated-proxy pass when accounting is complete;
- 95% Wilson intervals for pass rates and paired bootstrap confidence intervals for score/pass-rate differences, resampling by case and repetition;
- worst-case results. Do not let strong micro:bit results hide a Maker or repair failure.

`summary.json` calculates these policy metrics overall and by model-plus-route candidate, model, provider, target, and category. `macroMeanTotalScoreByCandidate` is the ranking surface; the singular `macroMeanTotalScore` is populated only for one-candidate runs so routes with different repetition counts are never blended into one headline. `staticPolicyPass` reports the bounded policy and regex checks. `automatedProxyPass` additionally requires pinned compile/decompile/native Blocks and is unmeasured (`null`) during compiler/decompiler outages. `strictAutomatedProxyPass` additionally requires the strict two-key JSON contract. These names are deliberate: corpus regexes are proxies and can pass semantically wrong programmes (for example, incrementing a counter outside an empty button handler).

An automated threshold is not a release gate by itself. Pre-register thresholds before unblinding, require no statistically or practically meaningful regression versus the incumbent, and perform blinded semantic review of finalist outputs—especially state/event relationships and adversarial cases—before a model or prompt change can ship.

## Sampling strategy

Use three phases, with most screening spend on micro:bit:

1. **Micro:bit screen:** 5 repetitions × 8 micro:bit cases per candidate at Vibbit's temperature 0.1.
2. **Cross-target check:** 3 repetitions × the 16 Arcade and Maker cases for candidates that pass the micro:bit screen.
3. **Final:** at least 10 repetitions × all 24 cases for the shortlist and incumbent. Five is an acceptable budget-constrained minimum, but gives wide intervals.

Keep system/user prompts, max tokens, temperature, target versions, board, and retry policy identical. Use `--prompt-mode managed` for an apples-to-apples primary model comparison. Vibbit's BYOK route adds conversational guidance, so use `--prompt-mode byok` only for a separate route-faithful benchmark. Run `--policy raw` first: correction retries can hide first-pass model quality and multiply cost. Then run `--policy harness`; it calls the same `runGenerationLoop` implementation as production and records each request transcript, raw candidate, failure class, retry, latency, usage, cost, fallback, and final outcome.

For evidence-gated context changes, compare one variable at a time:

- `--context full|no-recent-chat|no-current-code|no-page-errors|no-conversion-dialog` (the two diagnostic ablations are independent);
- `--max-current-code-chars N` and `--current-code-window production|head|middle|tail`; all strategies use the shared prompt-boundary implementation, and `production` is the 65/35 head+tail policy;
- `--max-empty-retries N`, `--max-validation-retries N`, and `--max-attempts N`;
- `--validation pinned|static-only` controls whether pinned validation participates in Harness retries. Final scoring still runs the pinned oracle once, so static-policy false successes can be measured without enabling that policy in production.

Compare two completed runs without conflating models or cases:

```bash
node evals/makecode-models/compare.mjs \
  --left output/model-evals/raw/results.jsonl \
  --right output/model-evals/harness/results.jsonl \
  --out comparison.json
```

Run the adversarial corpus under both raw and Harness policies before adding stronger source-hierarchy prompt language. It is a comparison path, not an automatic production rule stack or prompt-injection classifier.

The harness rotates case and model order deterministically to reduce time-of-day and warm-cache bias. Run candidates from the same gateway in one interleaved matrix. Alternate gateway order across replicated runs. A provider seed is only a request hint and is not assumed to make results deterministic; repeated samples remain mandatory. If all candidates support a seed, use `--seed 1701` and still vary repetition (`1701 + repetition`). Otherwise omit seed for every candidate in the primary comparison.

Freeze the corpus before unblinding model labels. If a case is invalid, correct it for all models and rerun that case; do not selectively waive failures.

## Running the sampler now

Validate the corpus and matrix without secrets:

```bash
node --check evals/makecode-models/run.mjs
node evals/makecode-models/run.mjs \
  --provider openrouter \
  --models openai/gpt-5.6-luna,deepseek/deepseek-v4-flash-0731,xiaomi/mimo-v2.5,qwen/qwen3.8-27b,tencent/hy3 \
  --target microbit \
  --samples 5 \
  --policy raw \
  --prompt-mode managed \
  --dry-run
```

OpenCode Go, restricted to models listed with a chat-completions endpoint:

```bash
export OPENCODE_GO_API_KEY='...'
node evals/makecode-models/run.mjs \
  --provider opencode-go \
  --key-env OPENCODE_GO_API_KEY \
  --models deepseek-v4-flash,glm-5.3,kimi-k3,mimo-v2.5,hy3 \
  --samples 3
```

For an OpenCode Go Responses API model such as GPT-5.6 Luna:

```bash
node evals/makecode-models/run.mjs \
  --provider opencode-go \
  --key-env OPENCODE_GO_API_KEY \
  --protocol responses \
  --models gpt-5.6-luna \
  --target microbit \
  --samples 3
```

OpenCode Zen:

```bash
export OPENCODE_GO_API_KEY='...'
node evals/makecode-models/run.mjs \
  --provider opencode-zen \
  --key-env OPENCODE_GO_API_KEY \
  --models hy3-free,nemotron-3-ultra-free,nemotron-3.5-lightning-free \
  --samples 3
```

OpenRouter using models configured or under consideration for Vibbit:

```bash
export OPENROUTER_API_KEY='...'
node evals/makecode-models/run.mjs \
  --provider openrouter \
  --models openai/gpt-5.6-luna,deepseek/deepseek-v4-flash-0731,xiaomi/mimo-v2.5,qwen/qwen3.8-27b,tencent/hy3 \
  --target microbit \
  --samples 5
```

Results go to ignored `output/model-evals/<provider>-<timestamp>/`:

- `results.jsonl`: local immutable provider capture with exact request messages, each candidate/retry trajectory, parsed/final output, policy outcome, validation, usage/cost, and evaluation fields;
- `makecode-validation.jsonl`: pinned compile, decompile, grey-block, hash, 60-point score, and policy outcome records;
- `models-snapshot.json`: provider model metadata at run time;
- `summary.json`: run configuration, counts, aggregate policy metrics, confidence intervals, and paired model comparisons.

`--dry-run` still validates the matrix without API calls and without loading a compiler worker.

Secrets are read only from the named environment variable and are never written. Provider failures are persisted only as structured code/status fields; response bodies are not written because an endpoint could echo credentials. `results.jsonl` does contain prompts, current code, diagnostics, recent chat, and successful raw model output so that trajectories are reproducible; treat it as potentially sensitive local evaluation data and do not use it as production telemetry. Both Chat and Responses token schemas are normalized. Missing or null cost remains unknown rather than becoming zero; use a frozen price snapshot when estimating omitted cost.

## True MakeCode validation

The eval runner now calls `compileAndDecompile` from `shared/makecode-decompile.mjs` after each successful sample. That module loads a pinned `pxtworker.js` and `target.json` from `https://cdn.makecode.com/commit/<sha>/` for micro:bit, Arcade, and Maker. Pins live in `shared/makecode-pins.json`.

For each JSONL response with code:

1. Build an isolated in-memory project with `main.ts`, `main.blocks`, and target-specific `pxt.json`. Maker also sets the Circuit Playground Express hardware variant.
2. Compile through the pinned worker. Require `success` and no error diagnostics.
3. Decompile `main.ts` with `ast = true` and `errorOnGreyBlocks = true`. Require `success`, no error diagnostics, and non-empty `outfiles["main.blocks"]`.
4. Independently reject XML containing `typescript_statement` or `typescript_expression` blocks.
5. Recompile the emitted Blocks when the decompile step succeeded, and record `roundTripOk`. If that step throws, store `null` and award no round-trip points.
6. Write target/PXT release IDs, diagnostics, output hashes, and grey-block count into `makecode-validation.jsonl`. Leave `results.jsonl` unchanged.

`mkc build` alone is insufficient: it tests compilation but has no decompile command. Do not point `mkc.json.targetWebsite` at a live origin without a trailing slash. The SHA-indexed CDN worker is the pin.

Managed generation uses the same module inside `runGenerationLoop` via `runDecompile`. The extension and BYOK routes omit that callback, so they still use the student-visible Blockly probe after paste.

### Browser validation

Where direct compiler-worker integration is unavailable, Playwright can load each target editor, import/set `main.ts`, switch to Blocks, reject the conversion dialog, and inspect Blockly for grey blocks. This is slower and more timing-sensitive but exercises the exact released editor. It must run separately against:

- `https://makecode.microbit.org/`;
- `https://arcade.makecode.com/`;
- `https://maker.makecode.com/` with the pinned board.

Run `npm run audit:editor` for this validation. Each fixture gets a fresh browser context. The audit saves an exact `main.ts` model revision, directly starts the released editor's PXT typecheck, and accepts only the diagnostics callback carrying the unique snapshot object captured by that invocation; older in-flight callbacks are forwarded to MakeCode but cannot satisfy the audit. It attributes the resulting package diagnostics only if the project, source-file identity/content, model, version, URI, and source are unchanged. It then requires exactly one visible workspace owned by the released editor's active Blocks component before inspecting `getAllBlocks(false)`—never toolbox/flyout SVG nodes—and rejects ambiguity or either grey block type. Its default fixtures cover native micro:bit, Arcade, the exact Maker fallback, a rejection that specifically requires compile diagnostics, and statement/expression conversion rejection. Pass evaluator JSONL through `--input PATH` (and optionally `--target`) to validate sampled candidates. The existing `npm run audit:smoke` still stubs Monaco/provider calls and is not released-editor evidence.

## What is automated now vs. deferred

Automated now:

- exact production prompt builders from `shared/makecode-compat-core.mjs`;
- balanced prompt fixture generation including errors and conversion-dialog context;
- strict raw JSON and permissive production parser outcomes;
- Vibbit compatibility prefilter and case criteria;
- repeated, interleaved sampling for OpenRouter and chat-compatible OpenCode Go/Zen models;
- separate raw one-shot and exact production Harness-policy runs with complete retry trajectories;
- independent context, retry-budget, validation-policy, and production/head/middle/tail current-code comparison flags plus a cross-run paired comparator;
- an adversarial source-hierarchy corpus kept separate from the ordinary score;
- static-policy/automated-proxy/first-attempt/budget pass, conditional repair, fallback, false-success, failure-class, Wilson, and paired-bootstrap metrics;
- latency, resolved model, token usage, provider cost where supplied, prompt hashes, and model metadata snapshots;
- pinned target compile and TypeScript-to-Blocks decompile through `shared/makecode-decompile.mjs`;
- grey-block statement/expression rejection and optional Blocks round-trip compilation.
- released-editor conversion checks through `npm run audit:editor`;
- unpacked-extension credential/arming boundary canaries through `npm run audit:extension`.

Still deferred:

- provider-funded raw-vs-Harness, context, adversarial, and retry ablations for a frozen model shortlist;
- a product decision on whether source-hierarchy prompt changes beat the current prompt without ordinary-task regressions;
- production telemetry, pending a school-approved retention/redaction policy (offline evaluation traces are intentionally local instead).

## Sources

- Vibbit source: `shared/makecode-compat-core.mjs`, `work.js`, `apps/backend/src/runtime.mjs`, `scripts/audit/smoke.mjs`, and `scripts/audit/live.mjs`.
- OpenCode Go API/model list and changing model roster: <https://opencode.ai/docs/go>
- OpenCode Zen endpoints and per-token pricing: <https://opencode.ai/docs/zen>
- OpenRouter usage/cost accounting: <https://openrouter.ai/docs/cookbook/administration/usage-accounting>
- MakeCode CLI: <https://makecode.com/cli>
- MakeCode command-line compiler: <https://github.com/microsoft/pxt-mkc>
- PXT decompiler implementation: <https://github.com/microsoft/pxt/blob/master/pxtcompiler/emitter/decompiler.ts>
- Target sources: <https://github.com/microsoft/pxt-microbit>, <https://github.com/microsoft/pxt-arcade>, and <https://github.com/microsoft/pxt-maker>
