import assert from "node:assert/strict";
import test from "node:test";

import {
  MICROBIT_EXTENSIONS,
  buildExtensionPromptExtras,
  buildSystemPrompt,
  detectRequiredExtensions,
  extensionDependencies,
  runValidateBlocks
} from "./makecode-compat-core.mjs";

test("detects extensions from generated code", () => {
  assert.deepEqual(
    detectRequiredExtensions("let strip = neopixel.create(DigitalPin.P1, 8, NeoPixelMode.RGB)"),
    ["neopixel"]
  );
  assert.deepEqual(
    detectRequiredExtensions("let d = sonar.ping(DigitalPin.P1, DigitalPin.P2, PingUnit.Centimeters)"),
    ["sonar"]
  );
  assert.deepEqual(detectRequiredExtensions("keyboard.sendString(\"hi\")"), ["blehid"]);
});

test("detects extensions from request intent before any code exists", () => {
  assert.deepEqual(detectRequiredExtensions("", "light up my LED strip in rainbow"), ["neopixel"]);
  assert.deepEqual(detectRequiredExtensions("", "measure distance with an ultrasonic sensor"), ["sonar"]);
});

test("ignores extensions in strings and comments", () => {
  assert.deepEqual(detectRequiredExtensions("basic.showString(\"neopixel.create\")"), []);
});

test("non-microbit targets never request micro:bit extensions", () => {
  assert.deepEqual(detectRequiredExtensions("neopixel.create(1, 2, 3)", "", "arcade"), []);
});

test("dependency fragment uses registry package ids", () => {
  assert.deepEqual(extensionDependencies(["neopixel", "sonar"]), { neopixel: "*", sonar: "*" });
  assert.equal(extensionDependencies(["blehid"]).blehid, MICROBIT_EXTENSIONS.blehid.pkg);
});

test("third-party packages are pinned, never tracking a branch", () => {
  for (const entry of Object.values(MICROBIT_EXTENSIONS)) {
    if (!entry.pkg.startsWith("github:")) continue;
    assert.match(entry.pkg, /#v?\d/, `${entry.id} must pin a tag`);
  }
});

test("prompt extras appear only for the relevant extension", () => {
  const extras = buildExtensionPromptExtras("microbit", "make my led strip glow").join("\n");
  assert.match(extras, /neopixel\.create/);
  assert.doesNotMatch(extras, /sonar\.ping/);
  assert.match(extras, /MUST add this extension/);
});

test("servo guidance says built-in and does not add an extension", () => {
  const extras = buildExtensionPromptExtras("microbit", "sweep a servo on P1").join("\n");
  assert.match(extras, /built into micro:bit/);
  assert.doesNotMatch(extras, /MakeCode package/);
});

test("system prompt stays lean when no extension is implied", () => {
  const plain = buildSystemPrompt("microbit", { requestHint: "count button presses" });
  assert.doesNotMatch(plain, /neopixel/);
  const strip = buildSystemPrompt("microbit", { requestHint: "rainbow on my neopixel strip" });
  assert.match(strip, /NeoPixelMode/);
});

test("extension enums and arities validate only when the extension is used", () => {
  const good = [
    "let strip = neopixel.create(DigitalPin.P1, 8, NeoPixelMode.RGB)",
    "strip.showColor(neopixel.colors(NeoPixelColors.Red))"
  ].join("\n");
  const okResult = runValidateBlocks(good, "microbit");
  assert.equal(okResult.ok, true, okResult.violations.join(", "));
  assert.deepEqual(okResult.extensions, ["neopixel"]);

  const badEnum = "let strip = neopixel.create(DigitalPin.P1, 8, NeoPixelMode.RGB)\nstrip.showColor(neopixel.colors(NeoPixelColors.Turquoise))";
  assert.ok(runValidateBlocks(badEnum, "microbit").violations.some((v) => /NeoPixelColors\.Turquoise/.test(v)));

  const badArity = "let strip = neopixel.create(DigitalPin.P1, 8)";
  assert.ok(runValidateBlocks(badArity, "microbit").violations.some((v) => /neopixel\.create arity/.test(v)));
});

test("sonar arity accepts the optional max distance argument", () => {
  const three = "let d = sonar.ping(DigitalPin.P1, DigitalPin.P2, PingUnit.Centimeters)";
  const four = "let d = sonar.ping(DigitalPin.P1, DigitalPin.P2, PingUnit.Centimeters, 200)";
  assert.equal(runValidateBlocks(three, "microbit").ok, true);
  assert.equal(runValidateBlocks(four, "microbit").ok, true);
});

test("hardware warnings surface without failing validation", () => {
  const p0 = runValidateBlocks("let strip = neopixel.create(DigitalPin.P0, 8, NeoPixelMode.RGB)", "microbit");
  assert.equal(p0.ok, true);
  assert.ok(p0.warnings.some((w) => /P0/.test(w)));

  const noGroup = runValidateBlocks("radio.sendNumber(1)", "microbit");
  assert.ok(noGroup.warnings.some((w) => /setGroup/.test(w)));

  const samePin = runValidateBlocks("let d = sonar.ping(DigitalPin.P1, DigitalPin.P1, PingUnit.Centimeters)", "microbit");
  assert.ok(samePin.warnings.some((w) => /same pin/.test(w)));

  const badAngle = runValidateBlocks("pins.servoWritePin(AnalogPin.P1, 270)", "microbit");
  assert.ok(badAngle.warnings.some((w) => /0-180/.test(w)));
});

test("clean core code produces no warnings", () => {
  const result = runValidateBlocks("basic.showNumber(1)", "microbit");
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.extensions, []);
});

test("registry examples pass the validator they are meant to teach", () => {
  for (const entry of Object.values(MICROBIT_EXTENSIONS)) {
    const result = runValidateBlocks(entry.example, "microbit");
    assert.equal(result.ok, true, `${entry.id} example: ${result.violations.join(", ")}`);
  }
});
