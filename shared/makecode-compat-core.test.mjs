import assert from "node:assert/strict";
import test from "node:test";

import {
  TARGET_API_CATALOG,
  boundCurrentCodeForPrompt,
  buildCorrectionInstruction,
  buildDecompileFixRequest,
  buildFailedAttemptUserTurn,
  buildSystemPrompt,
  parseModelOutput,
  runGenerationLoop,
  runValidateBlocks,
  serializeTranscript,
  stubForTarget,
  validateBlocksCompatibility
} from "./makecode-compat-core.mjs";

const TARGETS = ["microbit", "arcade", "maker"];

test("current-code window strategies share the core prompt boundary", () => {
  const source = `HEAD-${"m".repeat(200)}-TAIL`;
  const production = boundCurrentCodeForPrompt(source, { maxChars: 100, strategy: "production" });
  const head = boundCurrentCodeForPrompt(source, { maxChars: 100, strategy: "head" });
  const middle = boundCurrentCodeForPrompt(source, { maxChars: 100, strategy: "middle" });
  const tail = boundCurrentCodeForPrompt(source, { maxChars: 100, strategy: "tail" });
  assert.match(production.text, /HEAD-/);
  assert.match(production.text, /-TAIL/);
  assert.match(head.text, /HEAD-/);
  assert.doesNotMatch(head.text, /-TAIL/);
  assert.doesNotMatch(middle.text, /HEAD-|-TAIL/);
  assert.doesNotMatch(tail.text, /HEAD-/);
  assert.match(tail.text, /-TAIL/);
  for (const result of [production, head, middle, tail]) {
    assert.equal(result.truncated, true);
    assert(result.text.length <= 100);
    assert(result.omittedChars > 0);
  }
});

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
  assert.ok(buildSystemPrompt("maker").includes("support .digitalWrite(boolean) and .digitalRead()"));
  assert.ok(buildSystemPrompt("maker").includes("input.buttonA.onEvent(ButtonEvent.Click"));
  assert.doesNotMatch(buildSystemPrompt("maker"), /loops\.forever\(function|DigitalPin\.P0/);
  const microbit = buildSystemPrompt("microbit");
  assert.ok(!microbit.includes("onStart(handler)"));
  assert.ok(!/onstart functions/i.test(microbit));
  assert.match(microbit, /top-level statements/i);
  assert.match(microbit, /on start block/i);
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
  assert.ok(!blockSafe(microbit).includes("basic.onStart"));
  assert.ok(blockSafe(microbit).includes("top-level statements"));
  assert.ok(!blockSafe(microbit).includes("game.onUpdate"));
  assert.ok(blockSafe(arcade).includes("game.onUpdate"));
  assert.ok(!blockSafe(arcade).includes("input.onButtonPressed"));
  assert.ok(!blockSafe(arcade).includes("basic.forever"));
  assert.ok(blockSafe(maker).includes("forever(function"));
  assert.ok(blockSafe(maker).includes("input.buttonA.onEvent"));
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

test("permissive production parsing recovers fenced and malformed JSON-shaped output", () => {
  const fenced = parseModelOutput("```json\n{\"feedback\":[\"ok\"],\"code\":\"basic.showNumber(1)\"}\n```");
  assert.equal(fenced.code, "basic.showNumber(1)");
  assert.deepEqual(fenced.feedback, ["ok"]);

  const malformed = parseModelOutput("Here is the code:\n```typescript\nbasic.showNumber(2)\n```");
  assert.equal(malformed.code, "basic.showNumber(2)");
  assert.deepEqual(malformed.feedback, []);
});

test("permissive production parsing uses the first valid object from multiple candidates", () => {
  const output = [
    "preface",
    JSON.stringify({ ignored: true }),
    JSON.stringify({ feedback: ["first"], code: "basic.showNumber(1)" }),
    JSON.stringify({ feedback: ["second"], code: "basic.showNumber(2)" })
  ].join("\n");
  const parsed = parseModelOutput(output);
  assert.equal(parsed.code, "basic.showNumber(1)");
  assert.deepEqual(parsed.feedback, ["first"]);
});

test("fallback stub is block-safe for its target", () => {
  for (const target of TARGETS) {
    const result = validateBlocksCompatibility(stubForTarget(target), target);
    assert.ok(result.ok, `${target} stub violations: ${result.violations.join(", ")}`);
  }
});

test("basic.onStart is rejected even at the top level", () => {
  const topLevel = [
    "basic.onStart(function () {",
    "    basic.showString(\"Hi\")",
    "})"
  ].join("\n");
  const topLevelResult = validateBlocksCompatibility(topLevel, "microbit");
  assert.equal(topLevelResult.ok, false);
  assert.ok(topLevelResult.violations.includes("basic.onStart()"));
  assert.ok(!topLevelResult.violations.includes("nested event registration"));

  const nested = [
    "input.onButtonPressed(Button.A, function () {",
    "    basic.onStart(function () {",
    "        basic.showString(\"Hi\")",
    "    })",
    "})"
  ].join("\n");
  const nestedResult = validateBlocksCompatibility(nested, "microbit");
  assert.equal(nestedResult.ok, false);
  assert.ok(nestedResult.violations.includes("basic.onStart()"));
  assert.ok(
    !nestedResult.violations.includes("nested event registration"),
    "onStart is not a nestable handler; the unwrap hint must be the only signal"
  );

  const bare = "onStart(function () { basic.showString(\"Hi\") })";
  const bareResult = validateBlocksCompatibility(bare, "microbit");
  assert.equal(bareResult.ok, false);
  assert.ok(bareResult.violations.includes("basic.onStart()"));

  const otherTarget = "game.onStart(function () { })";
  const otherResult = validateBlocksCompatibility(otherTarget, "arcade");
  assert.ok(!otherResult.violations.includes("basic.onStart()"));

  const inString = "basic.showString(\"call basic.onStart( now\")";
  const inStringResult = validateBlocksCompatibility(inString, "microbit");
  assert.ok(!inStringResult.violations.includes("basic.onStart()"), inStringResult.violations.join(", "));
});

test("string literals do not trip forbidden-construct rules", () => {
  const arrowText = 'basic.showString("press => to continue")';
  const arrowResult = validateBlocksCompatibility(arrowText, "microbit");
  assert.equal(arrowResult.ok, true, arrowResult.violations.join(", "));

  const classText = 'basic.showString("class")';
  const classResult = validateBlocksCompatibility(classText, "microbit");
  assert.equal(classResult.ok, true, classResult.violations.join(", "));

  const ledPattern = [
    "basic.showLeds(`",
    "    . . class . .",
    "    . . . . .",
    "    . . . . .",
    "    . . . . .",
    "    . . . . .",
    "`)"
  ].join("\n");
  const ledResult = validateBlocksCompatibility(ledPattern, "microbit");
  assert.equal(ledResult.ok, true, ledResult.violations.join(", "));
  assert.ok(!ledResult.violations.includes("classes"));
  assert.ok(!ledResult.violations.includes("template string interpolation"));
});

test("comments inside strings are not treated as comments", () => {
  const url = 'basic.showString("http://makecode.microbit.org")';
  const urlResult = validateBlocksCompatibility(url, "microbit");
  assert.equal(urlResult.ok, true, urlResult.violations.join(", "));
  assert.ok(!urlResult.violations.includes("line comments"));

  const nested = 'basic.showString("/* class */")';
  const nestedResult = validateBlocksCompatibility(nested, "microbit");
  assert.equal(nestedResult.ok, true, nestedResult.violations.join(", "));
  assert.ok(!nestedResult.violations.includes("block comments"));
  assert.ok(!nestedResult.violations.includes("classes"));
});

test("real forbidden constructs still fail after string stripping", () => {
  const arrow = "input.onButtonPressed(Button.A, () => { basic.showIcon(IconNames.Heart) })";
  const arrowResult = validateBlocksCompatibility(arrow, "microbit");
  assert.equal(arrowResult.ok, false);
  assert.ok(arrowResult.violations.includes("arrow functions"));

  const constructed = "let sprite = new Sprite()";
  const constructedResult = validateBlocksCompatibility(constructed, "arcade");
  assert.equal(constructedResult.ok, false);
  assert.ok(constructedResult.violations.includes("new constructor"));

  const commented = 'basic.showString("Hi")\n// students: press A';
  const commentedResult = validateBlocksCompatibility(commented, "microbit");
  assert.equal(commentedResult.ok, false);
  assert.ok(commentedResult.violations.includes("line comments"));

  const interpolated = "basic.showString(`press ${name}`)";
  const interpolatedResult = validateBlocksCompatibility(interpolated, "microbit");
  assert.equal(interpolatedResult.ok, false);
  assert.ok(interpolatedResult.violations.includes("template string interpolation"));
});

test("correction instruction turns violations into actionable fixes", () => {
  const message = buildCorrectionInstruction(["arrow functions", "randint()"], "microbit");
  assert.ok(message.includes("micro:bit"));
  assert.ok(message.includes("function () { }"));
  assert.ok(message.includes("options._pickRandom()"));
  assert.ok(message.includes("Problems:"));
  assert.ok(message.includes("Fix by:"));
});

test("onStart correction tells the model to unwrap, not to hoist the wrapper", () => {
  const message = buildCorrectionInstruction(["basic.onStart()"], "microbit");
  assert.match(message, /top-level statements/i);
  assert.match(message, /on start block/i);
  assert.ok(!/move event handlers and functions to the top level/i.test(message));
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

const VALID_HEART = "basic.showIcon(IconNames.Heart)";
const ARROW_UNSAFE = "input.onButtonPressed(Button.A, () => { basic.showIcon(IconNames.Heart) })";
const DUCK_ONSTART = [
  "basic.onStart(function () {",
  "    basic.showIcon(IconNames.Duck)",
  "    basic.pause(1000)",
  "    basic.clearScreen()",
  "})"
].join("\n");
const DUCK_TOPLEVEL = [
  "basic.showIcon(IconNames.Duck)",
  "basic.pause(1000)",
  "basic.clearScreen()"
].join("\n");

function jsonOutput(code, feedback = ["ok"]) {
  return JSON.stringify({ feedback, code });
}

test("failed user turn includes the previous programme and JSON mandate", () => {
  const turn = buildFailedAttemptUserTurn({
    code: ARROW_UNSAFE,
    validation: { ok: false, violations: ["arrow functions"] },
    target: "microbit",
    kind: "invalid"
  });
  assert.ok(turn.includes("<<<FAILED_ATTEMPT>>>"));
  assert.ok(turn.includes("<<<END_FAILED_ATTEMPT>>>"));
  assert.ok(turn.includes(ARROW_UNSAFE));
  assert.ok(turn.includes("function () { }"));
  assert.match(turn, /JSON only|compact JSON/i);

  const emptyTurn = buildFailedAttemptUserTurn({
    code: "",
    validation: { ok: false, violations: [] },
    target: "microbit",
    kind: "empty"
  });
  assert.ok(emptyTurn.includes("<<<FAILED_ATTEMPT>>>\n\n<<<END_FAILED_ATTEMPT>>>"));
  assert.match(emptyTurn, /empty/i);
  assert.match(emptyTurn, /JSON only|compact JSON/i);
});

test("generation loop retries empty output and keeps the failed turn", async () => {
  const calls = [];
  const result = await runGenerationLoop({
    target: "microbit",
    systemPrompt: "sys",
    initialUserPrompt: "show a heart",
    emptyRetries: 2,
    validationRetries: 2,
    maxAttempts: 3,
    callModel: async (messages) => {
      calls.push(messages.slice());
      if (calls.length === 1) return jsonOutput("", ["empty"]);
      return jsonOutput(VALID_HEART, ["heart"]);
    }
  });
  assert.equal(result.outcome, "ok");
  assert.equal(result.upstreamAttempts, 2);
  assert.equal(result.code, VALID_HEART);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].map((item) => item.role), ["system", "user"]);
  assert.equal(calls[1][2].role, "assistant");
  assert.equal(calls[1][3].role, "user");
  assert.ok(calls[1][3].content.includes("<<<FAILED_ATTEMPT>>>"));
  assert.match(calls[1][3].content, /empty/i);
});

test("generation loop retries invalid output and the next user turn includes FAILED_ATTEMPT", async () => {
  const calls = [];
  const result = await runGenerationLoop({
    target: "microbit",
    systemPrompt: "sys",
    initialUserPrompt: "show a heart",
    emptyRetries: 2,
    validationRetries: 2,
    maxAttempts: 3,
    callModel: async (messages) => {
      calls.push(messages.slice());
      if (calls.length === 1) return jsonOutput(ARROW_UNSAFE, ["arrow"]);
      return jsonOutput(VALID_HEART, ["fixed"]);
    }
  });
  assert.equal(result.outcome, "ok");
  assert.equal(result.upstreamAttempts, 2);
  assert.equal(result.code, VALID_HEART);
  assert.equal(result.validation.ok, true);
  assert.equal(calls.length, 2);
  const second = calls[1];
  assert.equal(second[0].role, "system");
  assert.equal(second[1].role, "user");
  assert.equal(second[2].role, "assistant");
  assert.equal(second[2].content, ARROW_UNSAFE);
  assert.ok(second[3].content.includes("<<<FAILED_ATTEMPT>>>"));
  assert.ok(second[3].content.includes(ARROW_UNSAFE));
  assert.ok(second[3].content.includes("arrow functions"));
});

test("generation loop reports completed attempts before a later provider failure", async () => {
  const completed = [];
  let calls = 0;
  await assert.rejects(runGenerationLoop({
    target: "microbit",
    systemPrompt: "sys",
    initialUserPrompt: "show a heart",
    validationRetries: 1,
    maxAttempts: 2,
    callModel: async () => {
      calls += 1;
      if (calls === 1) return jsonOutput(ARROW_UNSAFE, ["arrow"]);
      throw new Error("provider unavailable");
    },
    onAttempt: (attempt, attemptNumber) => completed.push({ attempt, attemptNumber })
  }), /provider unavailable/);
  assert.equal(completed.length, 1);
  assert.equal(completed[0].attemptNumber, 1);
  assert.equal(completed[0].attempt.code, ARROW_UNSAFE);
  assert.equal(completed[0].attempt.reason, "invalid");
});

test("generation loop accepts legal programmes whose strings mention forbidden tokens", async () => {
  const legal = 'basic.showString("press => to continue")';
  const result = await runGenerationLoop({
    target: "microbit",
    systemPrompt: "sys",
    initialUserPrompt: "prompt the student",
    emptyRetries: 2,
    validationRetries: 2,
    maxAttempts: 3,
    callModel: async () => jsonOutput(legal, ["ok"])
  });
  assert.equal(result.outcome, "ok");
  assert.equal(result.upstreamAttempts, 1);
  assert.equal(result.code, legal);
  assert.equal(result.validation.ok, true);
});

test("generation loop stubs empty and invalid outcomes", async () => {
  const empty = await runGenerationLoop({
    target: "microbit",
    systemPrompt: "sys",
    initialUserPrompt: "show a heart",
    emptyRetries: 2,
    validationRetries: 2,
    maxAttempts: 3,
    callModel: async () => jsonOutput("")
  });
  assert.equal(empty.outcome, "stub-empty");
  assert.equal(empty.code, stubForTarget("microbit"));
  assert.equal(empty.upstreamAttempts, 3);
  assert.equal(empty.attempts[empty.attempts.length - 1].reason, "empty");
  assert.ok(empty.feedback.some((line) => /no code/i.test(line)));

  const invalid = await runGenerationLoop({
    target: "microbit",
    systemPrompt: "sys",
    initialUserPrompt: "show a heart",
    emptyRetries: 2,
    validationRetries: 2,
    maxAttempts: 3,
    callModel: async () => jsonOutput(ARROW_UNSAFE)
  });
  assert.equal(invalid.outcome, "stub-invalid");
  assert.equal(invalid.code, stubForTarget("microbit"));
  assert.equal(invalid.upstreamAttempts, 3);
  assert.equal(invalid.validation.ok, false);
  assert.ok(invalid.feedback.some((line) => /Validation fallback/i.test(line)));
});

test("serializeTranscript keeps a single user turn and flattens later turns", () => {
  const single = serializeTranscript([
    { role: "system", content: "sys-a" },
    { role: "system", content: "sys-b" },
    { role: "user", content: "please show a heart" }
  ]);
  assert.equal(single.system, "sys-a\n\nsys-b");
  assert.equal(single.user, "please show a heart");

  const flattened = serializeTranscript([
    { role: "system", content: "sys" },
    { role: "user", content: "first" },
    { role: "assistant", content: ARROW_UNSAFE },
    { role: "user", content: "<<<FAILED_ATTEMPT>>>\n" + ARROW_UNSAFE }
  ]);
  assert.equal(flattened.system, "sys");
  assert.ok(flattened.user.includes("<<<USER>>>\nfirst"));
  assert.ok(flattened.user.includes("<<<ASSISTANT>>>\n" + ARROW_UNSAFE));
  assert.ok(flattened.user.includes("<<<FAILED_ATTEMPT>>>"));
});

test("duck fixture: basic.onStart fails the oracle and top-level statements pass", () => {
  const wrapped = runValidateBlocks(DUCK_ONSTART, "microbit");
  assert.equal(wrapped.ok, false);
  assert.ok(wrapped.violations.includes("basic.onStart()"));

  const topLevel = runValidateBlocks(DUCK_TOPLEVEL, "microbit");
  assert.equal(topLevel.ok, true, topLevel.violations.join(", "));
  assert.match(DUCK_TOPLEVEL, /basic\.showIcon\(IconNames\.Duck\)/);
  assert.match(DUCK_TOPLEVEL, /basic\.pause\(1000\)/);
  assert.match(DUCK_TOPLEVEL, /basic\.clearScreen\(\)/);
});

test("generation loop retries basic.onStart with the failed duck programme", async () => {
  const calls = [];
  const result = await runGenerationLoop({
    target: "microbit",
    systemPrompt: "sys",
    initialUserPrompt: "Show the built-in duck icon, pause for one second, then clear the screen.",
    emptyRetries: 2,
    validationRetries: 2,
    maxAttempts: 3,
    callModel: async (messages) => {
      calls.push(messages.slice());
      if (calls.length === 1) return jsonOutput(DUCK_ONSTART, ["duck"]);
      return jsonOutput(DUCK_TOPLEVEL, ["fixed"]);
    }
  });
  assert.equal(result.outcome, "ok");
  assert.equal(result.upstreamAttempts, 2);
  assert.equal(result.code, DUCK_TOPLEVEL);
  assert.ok(calls[1][3].content.includes("<<<FAILED_ATTEMPT>>>"));
  assert.ok(calls[1][3].content.includes(DUCK_ONSTART));
  assert.match(calls[1][3].content, /top-level statements/i);
});

test("decompile fix request uses British spelling and names grey blocks", () => {
  const text = buildDecompileFixRequest({
    greyBlocks: 2,
    snippets: ["foo()", "bar()", "baz()", "dropped"],
    reason: "Detected 2 grey JavaScript block(s)"
  });
  assert.ok(text.includes("behaviour"));
  assert.ok(text.includes("typescript_statement"));
  assert.ok(text.includes("Grey block count: 2."));
  assert.ok(text.includes("Detected 2 grey JavaScript block(s)"));
  assert.ok(text.includes("foo()"));
  assert.ok(text.includes("bar()"));
  assert.ok(text.includes("baz()"));
  assert.ok(!text.includes("dropped"));
});

test("generation loop retries a headless decompile miss using the same retry budget", async () => {
  const calls = [];
  let decompileCalls = 0;
  const result = await runGenerationLoop({
    target: "microbit",
    systemPrompt: "sys",
    initialUserPrompt: "show a heart",
    emptyRetries: 2,
    validationRetries: 2,
    maxAttempts: 3,
    runDecompile: async () => {
      decompileCalls += 1;
      if (decompileCalls === 1) {
        return {
          ok: false,
          greyBlocks: 1,
          snippets: ["grey()"],
          reason: "Detected 1 grey JavaScript block(s)"
        };
      }
      return { ok: true, greyBlocks: 0, snippets: [] };
    },
    callModel: async (messages) => {
      calls.push(messages.slice());
      return jsonOutput(VALID_HEART, ["heart"]);
    }
  });
  assert.equal(result.outcome, "ok");
  assert.equal(result.upstreamAttempts, 2);
  assert.equal(decompileCalls, 2);
  assert.equal(result.code, VALID_HEART);
  assert.ok(calls[1][3].content.includes("<<<FAILED_ATTEMPT>>>"));
  assert.ok(calls[1][3].content.includes(VALID_HEART));
  assert.ok(calls[1][3].content.includes("Grey block count: 1."));
});

test("generation loop labels a decompiler outage as unverified without stubbing", async () => {
  const result = await runGenerationLoop({
    target: "microbit",
    systemPrompt: "sys",
    initialUserPrompt: "show a heart",
    emptyRetries: 2,
    validationRetries: 2,
    maxAttempts: 3,
    runDecompile: async () => {
      throw new Error("cdn down");
    },
    callModel: async () => jsonOutput(VALID_HEART, ["ok"])
  });
  assert.equal(result.outcome, "ok-unverified");
  assert.equal(result.upstreamAttempts, 1);
  assert.equal(result.code, VALID_HEART);
  assert.equal(result.attempts[0].decompile.skipped, true);
});

test("generation loop stubs after decompile retries are exhausted", async () => {
  const result = await runGenerationLoop({
    target: "microbit",
    systemPrompt: "sys",
    initialUserPrompt: "show a heart",
    emptyRetries: 0,
    validationRetries: 1,
    maxAttempts: 2,
    runDecompile: async () => ({
      ok: false,
      greyBlocks: 2,
      snippets: ["oops()"],
      reason: "Detected 2 grey JavaScript block(s)"
    }),
    callModel: async () => jsonOutput('basic.showIcon(IconNames.Heart)', ["ok"])
  });
  assert.equal(result.outcome, "stub-invalid");
  assert.equal(result.upstreamAttempts, 2);
  assert.equal(result.code, stubForTarget("microbit"));
  assert.ok(result.feedback.some((line) => /grey/i.test(line)));
});
