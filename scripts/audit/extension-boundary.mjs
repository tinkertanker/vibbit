import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { chromium } from "playwright";

import {
  buildMarkdownTable,
  createAuditRunDir,
  repoRoot,
  writeText
} from "./utils.mjs";

if (process.platform === "linux" && !process.env.DISPLAY && !process.env.VIBBIT_UNDER_XVFB) {
  const result = spawnSync("xvfb-run", ["-a", process.execPath, ...process.argv.slice(1)], {
    env: { ...process.env, VIBBIT_UNDER_XVFB: "1" },
    stdio: "inherit"
  });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

const CANARY = "extension-secret-canary";
const REQUEST_EVENT = "__vibbit_extension_request_v1";
const RESPONSE_EVENT = "__vibbit_extension_response_v1";
const PROVIDER_URL = "https://api.openai.com/v1/responses";
const runDir = await createAuditRunDir("extension-boundary");
const profile = await mkdtemp(path.join(tmpdir(), "vibbit-extension-boundary-"));
const extensionPath = path.join(repoRoot, "dist");
const checks = [];

function check(step, pass, detail) {
  checks.push({ step, result: pass ? "PASS" : "FAIL", detail });
}

function request(page, type, requestId, payload = {}) {
  return page.evaluate(({ eventName, type, requestId, payload }) => {
    document.dispatchEvent(new CustomEvent(eventName, { detail: { type, requestId, payload } }));
  }, { eventName: REQUEST_EVENT, type, requestId, payload });
}

let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    headless: false,
    viewport: { width: 1400, height: 900 },
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`
    ]
  });
  const worker = context.serviceWorkers()[0]
    || await context.waitForEvent("serviceworker", { timeout: 30000 });
  const extensionId = new URL(worker.url()).hostname;
  check("MV3 broker loaded", /\/extension\/background\.js$/.test(worker.url()), "Module service worker started from the built extension.");

  let providerCalls = 0;
  await context.route(PROVIDER_URL, async (route) => {
    providerCalls += 1;
    if (providerCalls === 2) await new Promise((resolve) => setTimeout(resolve, 300));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        output_text: JSON.stringify({ feedback: ["ok"], code: "basic.showIcon(IconNames.Heart)" })
      })
    });
  });

  const optionsPage = await context.newPage();
  await optionsPage.goto(`chrome-extension://${extensionId}/options.html`);
  await optionsPage.fill("#api-key", CANARY);
  await optionsPage.click("button[type='submit']");
  await optionsPage.waitForFunction(() => /Saved securely/.test(document.querySelector("#status")?.textContent || ""));
  const optionsKeyAfterSave = await optionsPage.locator("#api-key").inputValue();
  const trustedSession = await optionsPage.evaluate(async () => chrome.storage.session.get(null));
  check(
    "Extension-origin session storage",
    optionsKeyAfterSave === "" && JSON.stringify(trustedSession).includes(CANARY),
    "The options field clears after save; the key exists only in trusted extension session storage."
  );

  const page = await context.newPage();
  await page.addInitScript(({ responseEvent, providerUrl }) => {
    window.__vibbitBoundaryEvents = [];
    window.__vibbitBoundaryProviderFetches = [];
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (...args) => {
      const url = String(args[0]?.url || args[0] || "");
      if (url.startsWith(providerUrl)) window.__vibbitBoundaryProviderFetches.push(url);
      return nativeFetch(...args);
    };
    document.addEventListener(responseEvent, (event) => {
      window.__vibbitBoundaryEvents.push(JSON.stringify(event.detail));
    });
  }, { responseEvent: RESPONSE_EVENT, providerUrl: PROVIDER_URL });
  await page.goto("https://makecode.microbit.org/#editor", {
    waitUntil: "domcontentloaded",
    timeout: 120000
  });
  await page.waitForTimeout(7000);

  const unarmedId = "boundary_unarmed_1";
  await request(page, "vibbit:byok:generate", unarmedId, {
    target: "microbit",
    request: "show a heart"
  });
  await page.waitForFunction(
    (requestId) => window.__vibbitBoundaryEvents.some((item) => item.includes(requestId)),
    unarmedId,
    { timeout: 10000 }
  );
  const unarmedResponse = JSON.parse(await page.evaluate(() => window.__vibbitBoundaryEvents.at(-1)));
  check(
    "Explicit arming gate",
    unarmedResponse.ok === false && unarmedResponse.error?.code === "tab_not_armed" && providerCalls === 0,
    "An unarmed MakeCode document cannot spend provider quota."
  );

  // Playwright cannot click the browser toolbar action. Seed the same exact tab/document arm
  // record after the unarmed assertion so the remaining checks exercise the real broker path.
  await optionsPage.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: "https://makecode.microbit.org/*" });
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "ISOLATED",
      func: () => location.href
    });
    await chrome.storage.session.set({
      vibbitByokArmsV1: {
        [String(tab.id)]: {
          documentId: injection.documentId,
          url: tab.url,
          expiresAt: Date.now() + 60000,
          remaining: 2
        }
      }
    });
  });

  const armedId = "boundary_armed_123";
  await request(page, "vibbit:byok:generate", armedId, {
    target: "microbit",
    request: "show a heart"
  });
  await page.waitForFunction(
    (requestId) => window.__vibbitBoundaryEvents.some((item) => item.includes(requestId)),
    armedId,
    { timeout: 20000 }
  );
  const armedResponse = JSON.parse(await page.evaluate(() => window.__vibbitBoundaryEvents.at(-1)));
  check(
    "Bounded semantic broker",
    armedResponse.ok === true
      && armedResponse.value?.outcome === "ok"
      && providerCalls === 1
      && !JSON.stringify(armedResponse).includes(CANARY),
    "The armed request returned code/outcome/metadata only; provider transport remained in the service worker."
  );

  const concurrentIds = ["boundary_race_one", "boundary_race_two"];
  await Promise.all(concurrentIds.map((requestId) => request(page, "vibbit:byok:generate", requestId, {
    target: "microbit",
    request: "show a heart"
  })));
  await page.waitForFunction(
    (requestIds) => requestIds.every((requestId) => window.__vibbitBoundaryEvents.some((item) => item.includes(requestId))),
    concurrentIds,
    { timeout: 20000 }
  );
  const concurrentResponses = await page.evaluate((requestIds) => requestIds.map((requestId) => JSON.parse(
    window.__vibbitBoundaryEvents.find((item) => item.includes(requestId))
  )), concurrentIds);
  const concurrentSuccesses = concurrentResponses.filter((response) => response.ok === true).length;
  const concurrentRejections = concurrentResponses.filter((response) => response.error?.code === "request_in_progress").length;
  check(
    "One active request per document",
    concurrentSuccesses === 1 && concurrentRejections === 1 && providerCalls === 2,
    "Concurrent generation attempts produced one provider call and one request_in_progress rejection."
  );

  const pageState = await page.evaluate((canary) => ({
    providerFetches: window.__vibbitBoundaryProviderFetches,
    eventContainsCanary: JSON.stringify(window.__vibbitBoundaryEvents).includes(canary),
    domContainsCanary: document.documentElement.outerHTML.includes(canary),
    localStorageContainsCanary: JSON.stringify({ ...localStorage }).includes(canary)
  }), CANARY);
  check(
    "Page credential confidentiality",
    pageState.providerFetches.length === 0
      && !pageState.eventContainsCanary
      && !pageState.domContainsCanary
      && !pageState.localStorageContainsCanary,
    "MakeCode fetch hooks, DOM, localStorage, and bridge events did not observe the provider request or key."
  );
} catch (error) {
  check("Audit execution", false, String(error.message || error));
} finally {
  if (context) await context.close();
  await rm(profile, { recursive: true, force: true });
}

const passed = checks.every((item) => item.result === "PASS");
await writeFile(path.join(runDir, "results.json"), JSON.stringify({
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  passed,
  note: "Toolbar arming is approximated only after an independent unarmed check; Playwright cannot click Chrome's extension action.",
  checks
}, null, 2) + "\n");
await writeText(path.join(runDir, "REPORT.md"), [
  "# Extension BYOK boundary audit",
  "",
  buildMarkdownTable(checks),
  "",
  "Playwright first proves that an unarmed document is rejected. It then seeds the exact tab/document arm record because browser toolbar chrome is outside Playwright's page automation surface.",
  "",
  `Overall: **${passed ? "PASS" : "FAIL"}**`,
  ""
].join("\n"));
console.log(`Extension boundary audit ${passed ? "passed" : "failed"}: ${runDir}`);
if (!passed) process.exitCode = 1;
