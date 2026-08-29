import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { stubForTarget } from "./makecode-compat-core.mjs";
import {
  compileAndDecompile,
  countGreyBlocks,
  extractGreySnippets,
  getTargetPin,
  listPinnedTargets,
  scoreMakeCodeValidation
} from "./makecode-decompile.mjs";

const LIVE_MS = 180000;

test("compat-core does not import the Node decompiler", async () => {
  const source = await readFile(new URL("./makecode-compat-core.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /makecode-decompile/);
  assert.doesNotMatch(source, /pxtworker/);
});

test("generated work.js does not embed the pxt worker", async () => {
  const source = await readFile(new URL("../work.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /pxtworker\.js/);
  assert.doesNotMatch(source, /makecode-decompile/);
});

test("pin table covers microbit, arcade, and maker with SHA commits", () => {
  assert.deepEqual(listPinnedTargets(), ["microbit", "arcade", "maker"]);
  for (const target of listPinnedTargets()) {
    const pin = getTargetPin(target);
    assert.match(pin.commit, /^[0-9a-f]{40}$/);
    assert.ok(pin.website.startsWith("https://"));
    assert.ok(pin.dependencies && Object.keys(pin.dependencies).length > 0);
  }
  assert.equal(getTargetPin("maker").hwVariant, "adafruit-circuit-playground-express");
  assert.throws(() => getTargetPin("unknown"), /Unknown MakeCode target/);
});

test("XML reject counts statement and expression grey blocks independently of decompile.success", () => {
  const xml = [
    '<xml xmlns="http://www.w3.org/1999/xhtml">',
    '<block type="pxt-on-start"></block>',
    '<block type="typescript_statement">',
    '<mutation line0="class Foo &#123;&#125;" numlines="1"></mutation>',
    "</block>",
    '<block type="typescript_expression"><field name="EXPRESSION">(() =&gt; 1)()</field></block>',
    "</xml>"
  ].join("");
  assert.equal(countGreyBlocks(xml), 2);
  assert.deepEqual(extractGreySnippets(xml), ["class Foo {}", "(() => 1)()"]);
});

test("MakeCode score awards 60 only when compile, decompile, native, and round-trip pass", () => {
  const perfect = scoreMakeCodeValidation({
    compileOk: true,
    decompileOk: true,
    nativeBlocks: true,
    roundTripOk: true
  });
  assert.equal(perfect.score, 60);
  assert.equal(perfect.max, 60);

  const noRoundTrip = scoreMakeCodeValidation({
    compileOk: true,
    decompileOk: true,
    nativeBlocks: true,
    roundTripOk: null
  });
  assert.equal(noRoundTrip.score, 55);
  assert.equal(noRoundTrip.roundTrip, 0);

  const grey = scoreMakeCodeValidation({
    compileOk: true,
    decompileOk: true,
    nativeBlocks: false,
    roundTripOk: false
  });
  assert.equal(grey.score, 45);
});

test("pinned workers compile and decompile native stubs", { timeout: LIVE_MS }, async () => {
  const cases = [
    { target: "microbit", code: 'basic.showString("Hi")\n', nativeHint: /pxt-on-start|device_print_message/ },
    { target: "arcade", code: 'game.splash("Hi")\n', nativeHint: /<block/ },
    { target: "maker", code: stubForTarget("maker") + "\n", nativeHint: /<block/ }
  ];
  for (const item of cases) {
    const report = await compileAndDecompile({ target: item.target, code: item.code });
    assert.equal(report.compileOk, true, item.target + " compile " + JSON.stringify(report.diagnostics.slice(0, 3)));
    assert.equal(report.decompileOk, true, item.target + " decompile");
    assert.equal(report.greyBlocks, 0, item.target + " grey");
    assert.equal(report.nativeBlocks, true, item.target + " native");
    assert.equal(report.ok, true, item.target + " ok");
    assert.match(report.blocksXml, item.nativeHint);
    assert.equal(report.targetRelease.commit, getTargetPin(item.target).commit);
    assert.match(report.hashes.blocksSha256, /^[0-9a-f]{64}$/);
  }
});

test("pinned Circuit Playground pin capabilities match the Maker prompt", { timeout: LIVE_MS }, async () => {
  const valid = await compileAndDecompile({
    target: "maker",
    code: [
      "pins.LED.digitalWrite(true)",
      "pins.A0.analogWrite(512)",
      "pause(pins.A1.analogRead())",
      "pins.A2.servoWrite(90)",
      "pins.LED.digitalWrite(pins.A7.digitalRead())"
    ].join("\n")
  });
  assert.equal(valid.ok, true, JSON.stringify(valid.diagnostics.slice(0, 3)));

  for (const code of [
    "pins.A3.analogWrite(512)",
    "pins.A0.analogRead()",
    "pins.A0.servoWrite(90)",
    "pins.LED.analogRead()"
  ]) {
    const report = await compileAndDecompile({ target: "maker", code });
    assert.equal(report.compileOk, false, `${code} unexpectedly compiled`);
  }
});

test("class Foo decompiles to grey typescript_statement blocks", { timeout: LIVE_MS }, async () => {
  const report = await compileAndDecompile({ target: "microbit", code: "class Foo {}\n" });
  assert.equal(report.ok, false);
  assert.equal(report.nativeBlocks, false);
  assert.ok(report.greyBlocks > 0, "grey count " + report.greyBlocks);
  assert.match(report.blocksXml, /typescript_statement/);
  assert.ok(report.snippets.some((item) => item.includes("class Foo")));
});
