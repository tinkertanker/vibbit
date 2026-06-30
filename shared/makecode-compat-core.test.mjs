import assert from "node:assert/strict";
import test from "node:test";

import {
  TARGET_API_CATALOG,
  buildCorrectionInstruction,
  buildSystemPrompt,
  parseModelOutput,
  stubForTarget,
  validateBlocksCompatibility
} from "./makecode-compat-core.mjs";

const TARGETS = ["microbit", "arcade", "maker"];

test("system prompt keeps the four-block skeleton with front and end anchors", () => {
  for (const target of TARGETS) {
    const prompt = buildSystemPrompt(target);
    const config = TARGET_API_CATALOG[target];
    assert.match(prompt, /^ROLE: /, `${target} prompt starts with ROLE`);
    assert.ok(prompt.includes("PRIME DIRECTIVE:"), `${target} prompt has prime directive`);
    assert.ok(prompt.includes("AVAILABLE APIS"), `${target} prompt lists APIs`);
    assert.ok(prompt.includes("WRITE BLOCK-SAFE CODE:"), `${target} prompt has positive rules`);
    assert.ok(prompt.includes("NEVER USE"), `${target} prompt has forbidden rules`);
    assert.ok(prompt.includes("OUTPUT FORMAT:"), `${target} prompt has output contract`);
    assert.ok(prompt.includes("EXAMPLE (" + config.name), `${target} prompt has a worked example`);
    assert.match(prompt, /FINAL RULE: [\s\S]*$/, `${target} prompt ends with FINAL RULE anchor`);
    assert.ok(prompt.includes(config.name), `${target} prompt names the target`);
  }
});

test("system prompt grounds the model in target-specific APIs only", () => {
  assert.ok(buildSystemPrompt("microbit").includes("basic:"));
  assert.ok(buildSystemPrompt("arcade").includes("sprites:"));
  assert.ok(buildSystemPrompt("maker").includes("loops:"));
  // micro:bit on start is a real block and must not be forbidden anymore
  const microbit = buildSystemPrompt("microbit");
  assert.ok(microbit.includes("onStart(handler)"));
  assert.ok(!/onstart functions/i.test(microbit));
});

test("block-safe examples stay within each target's API surface", () => {
  const microbit = buildSystemPrompt("microbit");
  const arcade = buildSystemPrompt("arcade");
  const maker = buildSystemPrompt("maker");
  const blockSafe = (prompt) => {
    const start = prompt.indexOf("WRITE BLOCK-SAFE CODE:");
    const end = prompt.indexOf("NEVER USE");
    return prompt.slice(start, end);
  };
  assert.ok(blockSafe(microbit).includes("input.onButtonPressed"));
  assert.ok(blockSafe(microbit).includes("basic.onStart"));
  assert.ok(!blockSafe(microbit).includes("game.onUpdate"));
  assert.ok(blockSafe(arcade).includes("game.onUpdate"));
  assert.ok(!blockSafe(arcade).includes("input.onButtonPressed"));
  assert.ok(!blockSafe(arcade).includes("basic.forever"));
  assert.ok(blockSafe(maker).includes("loops.forever"));
  assert.ok(!blockSafe(maker).includes("game.onUpdate"));
  assert.ok(!blockSafe(maker).includes("basic.forever"));
});

test("conversational option toggles chat guidance without changing the contract", () => {
  const managed = buildSystemPrompt("microbit");
  const byok = buildSystemPrompt("microbit", { conversational: true });
  assert.ok(!managed.includes("CONVERSATION:"));
  assert.ok(byok.includes("CONVERSATION:"));
  assert.ok(byok.includes("friendly"));
  // Both still demand the same JSON contract
  assert.ok(managed.includes("OUTPUT FORMAT:") && byok.includes("OUTPUT FORMAT:"));
});

test("unknown targets fall back to micro:bit", () => {
  assert.equal(buildSystemPrompt("nonsense"), buildSystemPrompt("microbit"));
});

test("few-shot example code is block-safe for its target", () => {
  for (const target of TARGETS) {
    const { example } = TARGET_API_CATALOG[target];
    const result = validateBlocksCompatibility(example, target);
    assert.ok(result.ok, `${target} example violations: ${result.violations.join(", ")}`);
  }
});

test("few-shot response parses as the model output contract and stays block-safe", () => {
  for (const target of TARGETS) {
    const prompt = buildSystemPrompt(target);
    const match = prompt.match(/RESPONSE: (\{[\s\S]*?\})\n/);
    assert.ok(match, `${target} prompt embeds a RESPONSE JSON object`);
    const parsed = parseModelOutput(match[1]);
    assert.ok(parsed.feedback.length >= 1, `${target} example has feedback`);
    assert.ok(parsed.code.trim().length > 0, `${target} example has code`);
    const result = validateBlocksCompatibility(parsed.code, target);
    assert.ok(result.ok, `${target} parsed example violations: ${result.violations.join(", ")}`);
  }
});

test("fallback stub is block-safe for its target", () => {
  for (const target of TARGETS) {
    const result = validateBlocksCompatibility(stubForTarget(target), target);
    assert.ok(result.ok, `${target} stub violations: ${result.violations.join(", ")}`);
  }
});

test("basic.onStart must be top-level on micro:bit", () => {
  const nested = [
    "input.onButtonPressed(Button.A, function () {",
    "    basic.onStart(function () {",
    "        basic.showString(\"Hi\")",
    "    })",
    "})"
  ].join("\n");
  const result = validateBlocksCompatibility(nested, "microbit");
  assert.equal(result.ok, false);
  assert.ok(result.violations.includes("nested event registration"));
});

test("correction instruction turns violations into actionable fixes", () => {
  const message = buildCorrectionInstruction(["arrow functions", "randint()"], "microbit");
  assert.ok(message.includes("micro:bit"));
  assert.ok(message.includes("function () { }"));
  assert.ok(message.includes("options._pickRandom()"));
  assert.ok(message.includes("Problems:"));
  assert.ok(message.includes("Fix by:"));
});

test("strict correction instruction escalates and targets the right platform", () => {
  const message = buildCorrectionInstruction(["Arcade APIs in micro:bit/Maker"], "arcade", { strict: true });
  assert.ok(message.startsWith("STRICT MODE:"));
  assert.ok(message.includes("Arcade"));
  assert.ok(message.includes("only APIs for the selected target"));
});

test("correction instruction is safe with no violations", () => {
  const message = buildCorrectionInstruction([], "maker");
  assert.ok(message.includes("Maker"));
  assert.ok(!message.includes("Problems:"));
  assert.ok(message.length > 0);
});
