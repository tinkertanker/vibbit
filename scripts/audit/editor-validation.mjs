import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { chromium } from "playwright";

import {
  buildMarkdownTable,
  createAuditRunDir,
  repoRoot,
  trimForTable,
  writeText
} from "./utils.mjs";

const TARGET_URLS = {
  microbit: "https://makecode.microbit.org/#editor",
  arcade: "https://arcade.makecode.com/#editor",
  maker: "https://maker.makecode.com/#editor"
};

const DEFAULT_FIXTURES = [
  {
    id: "microbit-native-pass",
    target: "microbit",
    expect: "pass",
    code: "basic.showIcon(IconNames.Heart)\nbasic.pause(1000)"
  },
  {
    id: "microbit-compile-reject",
    target: "microbit",
    expect: "reject",
    code: "input.onButtonPressed(Button.C, function () {\n    basic.showNumber(1, 2)\n})"
  },
  {
    id: "microbit-grey-reject",
    target: "microbit",
    expect: "reject",
    code: "const twice = (value: number) => value * 2\nbasic.showNumber(twice(3))"
  },
  {
    id: "arcade-native-pass",
    target: "arcade",
    expect: "pass",
    code: "info.setScore(0)\ncontroller.A.onEvent(ControllerButtonEvent.Pressed, function () {\n    info.changeScoreBy(1)\n})"
  },
  {
    id: "maker-circuit-playground-native-pass",
    target: "maker",
    expect: "pass",
    code: "forever(function () {\n    pins.LED.digitalWrite(true)\n    pause(500)\n    pins.LED.digitalWrite(false)\n    pause(500)\n})"
  }
];

function parseArgs(argv) {
  const options = { input: "", target: "", timeoutMs: 120000, headful: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--headful") options.headful = true;
    else if (arg === "--input") options.input = argv[++index];
    else if (arg === "--target") options.target = argv[++index];
    else if (arg === "--timeout-ms") options.timeoutMs = Number(argv[++index]);
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.target && !TARGET_URLS[options.target]) throw new Error(`Unknown target: ${options.target}`);
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 10000) throw new Error("--timeout-ms must be at least 10000");
  return options;
}

function usage() {
  console.log(`Usage: node scripts/audit/editor-validation.mjs [options]

Options:
  --input PATH       JSONL fixtures or evaluator results (parsed.code is accepted)
  --target TARGET    microbit, arcade, or maker filter
  --timeout-ms N     Navigation/editor timeout (default: 120000)
  --headful          Open a visible browser

Each input row needs id/caseId, target, and code (or parsed.code). "expect" may be
"pass" or "reject" and defaults to "pass".`);
}

async function loadFixtures(inputPath) {
  if (!inputPath) return DEFAULT_FIXTURES;
  const text = await readFile(path.resolve(inputPath), "utf8");
  return text.split(/\r?\n/).filter(Boolean).map((line, index) => {
    const row = JSON.parse(line);
    return {
      id: String(row.id || row.caseId || `row-${index + 1}`),
      target: String(row.target || "microbit"),
      expect: row.expect === "reject" ? "reject" : "pass",
      code: String(row.code ?? row.parsed?.code ?? "")
    };
  });
}

async function visibleText(page, selector) {
  return page.locator(selector).evaluateAll((nodes) => nodes
    .filter((node) => Boolean(node.offsetWidth || node.offsetHeight))
    .map((node) => String(node.textContent || "").replace(/\s+/g, " ").trim())
    .filter(Boolean));
}

async function validateFixture(browser, fixture, runDir, timeoutMs) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const screenshot = path.join(runDir, `${fixture.id.replace(/[^a-z0-9_-]+/gi, "-")}.png`);
  const started = performance.now();
  try {
    const targetUrl = TARGET_URLS[fixture.target];
    if (!targetUrl) throw new Error(`Unknown target: ${fixture.target}`);
    if (!fixture.code.trim()) throw new Error("Fixture code is empty");
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    if (fixture.target === "maker") {
      const boardsHeading = page.getByRole("heading", { name: "Boards", exact: true });
      const board = page.getByRole("button", { name: "adafruit-circuit-playground-express", exact: true });
      await board.waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
      if (await board.isVisible().catch(() => false)) {
        await board.first().click();
        await boardsHeading.waitFor({ state: "hidden", timeout: 30000 });
      }
      await page.waitForTimeout(1000);
      await page.waitForFunction(() => ![...document.querySelectorAll(".ui.loader,.loading")]
        .some((node) => Boolean(node.offsetWidth || node.offsetHeight)), null, {
        timeout: 30000
      });
    }
    const javascriptTab = page.getByText("JavaScript", { exact: true }).filter({ visible: true }).first();
    await javascriptTab.waitFor({ state: "visible", timeout: timeoutMs });
    await javascriptTab.click();
    await page.waitForFunction(
      () => Boolean(window.monaco?.editor?.getModels?.().length),
      null,
      { timeout: timeoutMs }
    );
    await page.evaluate((code) => {
      const models = window.monaco.editor.getModels();
      const model = models.find((item) => /main\.ts$/i.test(item.uri?.path || item.uri?.toString?.() || "")) || models[0];
      model.setValue(code);
    }, fixture.code);
    await page.waitForTimeout(2500);

    const blocksTab = page.getByText("Blocks", { exact: true }).filter({ visible: true }).first();
    await blocksTab.click();
    await page.waitForFunction(() => {
      const visibleDialog = [...document.querySelectorAll("[role='dialog'],.ReactModal__Content")]
        .some((node) => Boolean(node.offsetWidth || node.offsetHeight)
          && /problem converting|unable to convert|grey javascript/i.test(node.textContent || ""));
      const selectedBlocks = [...document.querySelectorAll(".blocks-menuitem")]
        .some((node) => /selected|active/.test(node.className));
      return visibleDialog || selectedBlocks;
    }, null, { timeout: 30000 });
    await page.waitForTimeout(1500);

    const dialogs = await visibleText(page, "[role='dialog'],.ReactModal__Content");
    const conversionDialog = dialogs.find((text) => /problem converting|unable to convert|grey javascript/i.test(text)) || "";
    const blockState = await page.evaluate(() => {
      const selectedBlocks = [...document.querySelectorAll(".blocks-menuitem")]
        .some((node) => /selected|active/.test(node.className));
      const blockNodes = [...document.querySelectorAll("g.blocklyDraggable")];
      const greyBlocks = blockNodes.filter((node) => /typescript_statement/.test(node.className?.baseVal || node.className || ""));
      const nativeBlocks = blockNodes.filter((node) => {
        const classes = node.className?.baseVal || node.className || "";
        return !/blocklyShadow|typescript_statement/.test(classes);
      });
      return { selectedBlocks, greyBlocks: greyBlocks.length, nativeBlocks: nativeBlocks.length };
    });
    const releasedEditorAccepted = blockState.selectedBlocks
      && !conversionDialog
      && blockState.greyBlocks === 0
      && blockState.nativeBlocks > 0;
    const releasedEditorRejected = Boolean(conversionDialog) || blockState.greyBlocks > 0;
    const passed = fixture.expect === "pass" ? releasedEditorAccepted : releasedEditorRejected;
    await page.screenshot({ path: screenshot, fullPage: false });
    return {
      id: fixture.id,
      target: fixture.target,
      expect: fixture.expect,
      passed,
      releasedEditorAccepted,
      releasedEditorRejected,
      greyBlocks: blockState.greyBlocks,
      nativeBlocks: blockState.nativeBlocks,
      conversionDialog,
      finalUrl: page.url(),
      latencyMs: Math.round(performance.now() - started),
      screenshot: path.relative(repoRoot, screenshot)
    };
  } catch (error) {
    await page.screenshot({ path: screenshot, fullPage: false }).catch(() => {});
    return {
      id: fixture.id,
      target: fixture.target,
      expect: fixture.expect,
      passed: false,
      error: error.message,
      latencyMs: Math.round(performance.now() - started),
      screenshot: path.relative(repoRoot, screenshot)
    };
  } finally {
    await page.close();
  }
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  usage();
  process.exit(0);
}

let fixtures = await loadFixtures(options.input);
if (options.target) fixtures = fixtures.filter((fixture) => fixture.target === options.target);
if (!fixtures.length) throw new Error("No editor-validation fixtures matched");

const runDir = await createAuditRunDir("editor-validation");
const browser = await chromium.launch({ headless: !options.headful });
const results = [];
try {
  for (const fixture of fixtures) {
    process.stdout.write(`Released editor: ${fixture.target}/${fixture.id} ... `);
    const result = await validateFixture(browser, fixture, runDir, options.timeoutMs);
    results.push(result);
    console.log(result.passed ? "PASS" : `FAIL ${result.error || result.conversionDialog || "unexpected editor outcome"}`);
  }
} finally {
  await browser.close();
}

await writeFile(path.join(runDir, "results.json"), JSON.stringify({
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  editorUrls: TARGET_URLS,
  results
}, null, 2) + "\n");

const report = [
  "# Released MakeCode editor validation",
  "",
  "This audit writes each fixture into the real released Monaco editor, switches to Blocks, and requires either native blocks with no grey `typescript_statement` nodes or an explicit conversion rejection.",
  "",
  buildMarkdownTable(results.map((result) => ({
    step: `${result.target}/${result.id} (${result.expect})`,
    result: result.passed ? "PASS" : "FAIL",
    detail: trimForTable(
      result.error
      || result.conversionDialog
      || `native=${result.nativeBlocks ?? "-"}, grey=${result.greyBlocks ?? "-"}, ${result.finalUrl || ""}`
    )
  }))),
  "",
  `Overall: **${results.every((result) => result.passed) ? "PASS" : "FAIL"}**`,
  ""
].join("\n");
await writeText(path.join(runDir, "REPORT.md"), report);
console.log(`Report written to ${runDir}`);
if (results.some((result) => !result.passed)) process.exitCode = 1;
