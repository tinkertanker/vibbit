import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

function runBuild(script) {
  const result = spawnSync("npm", ["run", script], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(`${script} failed: ${result.stderr || result.stdout}`);
  }
}

async function installPageCanaries(page) {
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
}

function request(page, type, requestId, payload = {}) {
  return page.evaluate(({ eventName, type, requestId, payload }) => {
    document.dispatchEvent(new CustomEvent(eventName, { detail: { type, requestId, payload } }));
  }, { eventName: REQUEST_EVENT, type, requestId, payload });
}

let context;
try {
  runBuild("build");
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
  let slowProviderCalls = 0;
  let abortedSlowProviderCalls = 0;
  context.on("requestfailed", (request) => {
    if (request.url() === PROVIDER_URL && (request.postData() || "").includes("lifecycle-boundary")) {
      abortedSlowProviderCalls += 1;
    }
  });
  await context.route(PROVIDER_URL, async (route) => {
    providerCalls += 1;
    const requestBody = route.request().postData() || "";
    if (requestBody.includes("lifecycle-boundary")) {
      slowProviderCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    if (providerCalls === 2) await new Promise((resolve) => setTimeout(resolve, 300));
    try {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          output_text: JSON.stringify({ feedback: ["ok"], code: "basic.showIcon(IconNames.Heart)" })
        })
      });
    } catch {
      // Navigation/close lifecycle checks intentionally abort an in-flight provider fetch.
    }
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
  await installPageCanaries(page);
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

  const bridgeProbeId = "boundary_bridge_once";
  const eventCountBeforeBridgeProbe = await page.evaluate(() => window.__vibbitBoundaryEvents.length);
  await optionsPage.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: "https://makecode.microbit.org/*" });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "ISOLATED",
      files: ["page-bridge.js"]
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "ISOLATED",
      files: ["page-bridge.js"]
    });
  });
  await request(page, "vibbit:byok:status", bridgeProbeId);
  await page.waitForFunction(
    (requestId) => window.__vibbitBoundaryEvents.some((item) => item.includes(requestId)),
    bridgeProbeId,
    { timeout: 10000 }
  );
  const bridgeProbeCount = await page.evaluate(
    ({ requestId, start }) => window.__vibbitBoundaryEvents.slice(start).filter((item) => item.includes(requestId)).length,
    { requestId: bridgeProbeId, start: eventCountBeforeBridgeProbe }
  );
  check(
    "Idempotent toolbar bridge recovery",
    bridgeProbeCount === 1,
    "Repeated isolated-world bridge injection produced exactly one response for one request."
  );

  // Playwright cannot click the browser toolbar action. Seed the same exact tab/document arm
  // record after the unarmed assertion so the remaining checks exercise the real broker path.
  const firstArm = await optionsPage.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: "https://makecode.microbit.org/*" });
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "ISOLATED",
      func: () => location.href
    });
    const arm = {
      documentId: injection.documentId,
      url: tab.url,
      expiresAt: Date.now() + 60000,
      remaining: 10
    };
    await chrome.storage.session.set({
      [`vibbitByokArmV1:${tab.id}`]: arm
    });
    return { tabId: tab.id, ...arm };
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

  const armAfterConsume = await optionsPage.evaluate(async (tabId) => {
    const key = `vibbitByokArmV1:${tabId}`;
    return (await chrome.storage.session.get(key))[key];
  }, firstArm.tabId);
  check(
    "Fixed arm lifetime",
    armAfterConsume?.remaining === 8 && armAfterConsume?.expiresAt === firstArm.expiresAt,
    "Successful generation decremented only the quota and preserved the toolbar gesture expiry."
  );

  for (let index = 0; index < 8; index += 1) {
    const requestId = `boundary_quota_${index}`;
    await request(page, "vibbit:byok:generate", requestId, {
      target: "microbit",
      request: "show a heart"
    });
    await page.waitForFunction(
      (id) => window.__vibbitBoundaryEvents.some((item) => item.includes(id)),
      requestId,
      { timeout: 20000 }
    );
  }
  const exhaustedId = "boundary_quota_11th";
  await request(page, "vibbit:byok:generate", exhaustedId, {
    target: "microbit",
    request: "show a heart"
  });
  await page.waitForFunction(
    (requestId) => window.__vibbitBoundaryEvents.some((item) => item.includes(requestId)),
    exhaustedId,
    { timeout: 10000 }
  );
  const exhaustedResponse = JSON.parse(await page.evaluate(
    (requestId) => window.__vibbitBoundaryEvents.find((item) => item.includes(requestId)),
    exhaustedId
  ));
  check(
    "Exact per-arm quota",
    exhaustedResponse.error?.code === "tab_not_armed" && providerCalls === 10,
    "Ten generations reached the provider; the eleventh was rejected before transport."
  );

  const secondPage = await context.newPage();
  await installPageCanaries(secondPage);
  await secondPage.goto("https://makecode.microbit.org/#boundary-second", {
    waitUntil: "domcontentloaded",
    timeout: 120000
  });
  await secondPage.waitForTimeout(3000);
  const crossTabArms = await optionsPage.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: "https://makecode.microbit.org/*" });
    const records = [];
    for (const tab of tabs) {
      const [injection] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "ISOLATED",
        func: () => location.href
      });
      const arm = {
        documentId: injection.documentId,
        url: tab.url,
        expiresAt: Date.now() + 60000,
        remaining: 1
      };
      await chrome.storage.session.set({ [`vibbitByokArmV1:${tab.id}`]: arm });
      records.push({ tabId: tab.id, ...arm });
    }
    return records;
  });
  const crossTabIds = ["boundary_cross_tab_one", "boundary_cross_tab_two"];
  await Promise.all([
    request(page, "vibbit:byok:generate", crossTabIds[0], { target: "microbit", request: "show a heart" }),
    request(secondPage, "vibbit:byok:generate", crossTabIds[1], { target: "microbit", request: "show a heart" })
  ]);
  await Promise.all([
    page.waitForFunction((id) => window.__vibbitBoundaryEvents.some((item) => item.includes(id)), crossTabIds[0], { timeout: 20000 }),
    secondPage.waitForFunction((id) => window.__vibbitBoundaryEvents.some((item) => item.includes(id)), crossTabIds[1], { timeout: 20000 })
  ]);
  const storedCrossTabArms = await optionsPage.evaluate(async (tabIds) => {
    const keys = tabIds.map((tabId) => `vibbitByokArmV1:${tabId}`);
    return chrome.storage.session.get(keys);
  }, crossTabArms.map((arm) => arm.tabId));
  const crossTabAtomic = crossTabArms.every((arm) => {
    const stored = storedCrossTabArms[`vibbitByokArmV1:${arm.tabId}`];
    return stored?.remaining === 0 && stored?.expiresAt === arm.expiresAt;
  });
  check(
    "Independent cross-tab quota updates",
    crossTabAtomic && providerCalls === 12,
    "Concurrent armed documents each consumed only their own storage record without restoring quota."
  );

  const rejectedBefore = providerCalls;
  const rejectedCases = await optionsPage.evaluate(async (tabId) => {
    const key = `vibbitByokArmV1:${tabId}`;
    const tabs = await chrome.tabs.query({ url: "https://makecode.microbit.org/*" });
    const tab = tabs.find((candidate) => candidate.id === tabId);
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      func: () => location.href
    });
    await chrome.storage.session.set({ [key]: {
      documentId: `wrong-${injection.documentId}`,
      url: tab.url,
      expiresAt: Date.now() + 60000,
      remaining: 1
    } });
    return { key, actualDocumentId: injection.documentId };
  }, firstArm.tabId);
  const wrongDocumentId = "boundary_wrong_document";
  await request(page, "vibbit:byok:generate", wrongDocumentId, { target: "microbit", request: "show a heart" });
  await page.waitForFunction((id) => window.__vibbitBoundaryEvents.some((item) => item.includes(id)), wrongDocumentId);
  const wrongDocumentResponse = JSON.parse(await page.evaluate(
    (id) => window.__vibbitBoundaryEvents.find((item) => item.includes(id)),
    wrongDocumentId
  ));
  await optionsPage.evaluate(async ({ key, documentId }) => {
    await chrome.storage.session.set({ [key]: {
      documentId,
      url: "https://makecode.microbit.org/#editor",
      expiresAt: Date.now() - 1,
      remaining: 1
    } });
  }, { key: rejectedCases.key, documentId: rejectedCases.actualDocumentId });
  const expiredId = "boundary_expired_arm";
  await request(page, "vibbit:byok:generate", expiredId, { target: "microbit", request: "show a heart" });
  await page.waitForFunction((id) => window.__vibbitBoundaryEvents.some((item) => item.includes(id)), expiredId);
  const expiredResponse = JSON.parse(await page.evaluate(
    (id) => window.__vibbitBoundaryEvents.find((item) => item.includes(id)),
    expiredId
  ));
  check(
    "Expiry and document binding",
    wrongDocumentResponse.error?.code === "tab_not_armed"
      && expiredResponse.error?.code === "tab_not_armed"
      && providerCalls === rejectedBefore,
    "Wrong-document and expired capabilities were rejected before provider transport."
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

  const lifecycleArms = await optionsPage.evaluate(async (tabIds) => {
    const records = [];
    for (const tabId of tabIds) {
      const tabs = await chrome.tabs.query({ url: "https://makecode.microbit.org/*" });
      const tab = tabs.find((candidate) => candidate.id === tabId);
      const [injection] = await chrome.scripting.executeScript({
        target: { tabId },
        world: "ISOLATED",
        func: () => location.href
      });
      const key = `vibbitByokArmV1:${tabId}`;
      await chrome.storage.session.set({ [key]: {
        documentId: injection.documentId,
        url: tab.url,
        expiresAt: Date.now() + 60000,
        remaining: 1
      } });
      records.push({ tabId, key });
    }
    return records;
  }, [firstArm.tabId, crossTabArms.find((arm) => arm.tabId !== firstArm.tabId).tabId]);

  await request(page, "vibbit:byok:generate", "boundary_nav_abort", {
    target: "microbit",
    request: "lifecycle-boundary navigation"
  });
  for (let attempt = 0; attempt < 50 && slowProviderCalls < 1; attempt += 1) {
    await page.waitForTimeout(100);
  }
  await page.reload({ waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForTimeout(500);
  const armAfterNavigation = await optionsPage.evaluate(async (key) => (
    (await chrome.storage.session.get(key))[key] || null
  ), lifecycleArms[0].key);

  await request(secondPage, "vibbit:byok:generate", "boundary_close_abort", {
    target: "microbit",
    request: "lifecycle-boundary close"
  });
  for (let attempt = 0; attempt < 50 && slowProviderCalls < 2; attempt += 1) {
    await secondPage.waitForTimeout(100);
  }
  await secondPage.close();
  await optionsPage.waitForTimeout(3500);
  const armAfterClose = await optionsPage.evaluate(async (key) => (
    (await chrome.storage.session.get(key))[key] || null
  ), lifecycleArms[1].key);
  check(
    "Navigation and tab-close cancellation",
    slowProviderCalls === 2
      && abortedSlowProviderCalls === 2
      && armAfterNavigation === null
      && armAfterClose === null,
    `In-flight provider work was bound to the document lifecycle and each tab capability was removed (started=${slowProviderCalls}, aborted=${abortedSlowProviderCalls}).`
  );
} catch (error) {
  check("Audit execution", false, String(error.message || error));
} finally {
  if (context) await context.close();
  await rm(profile, { recursive: true, force: true });
}

const hostedProfile = await mkdtemp(path.join(tmpdir(), "vibbit-extension-hosted-boundary-"));
let hostedContext;
try {
  runBuild("build:hosted");
  const hostedManifest = JSON.parse(await readFile(path.join(extensionPath, "manifest.json"), "utf8"));
  hostedContext = await chromium.launchPersistentContext(hostedProfile, {
    headless: false,
    viewport: { width: 1200, height: 800 },
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`
    ]
  });
  const worker = hostedContext.serviceWorkers()[0]
    || await hostedContext.waitForEvent("serviceworker", { timeout: 30000 });
  const extensionId = new URL(worker.url()).hostname;
  let hostedProviderCalls = 0;
  await hostedContext.route(PROVIDER_URL, async (route) => {
    hostedProviderCalls += 1;
    await route.abort();
  });
  const hostedOptions = await hostedContext.newPage();
  await hostedOptions.goto(`chrome-extension://${extensionId}/options.html`);
  await hostedOptions.waitForFunction(
    () => /managed_only_build/.test(document.querySelector("#status")?.textContent || ""),
    { timeout: 10000 }
  );
  const hostedStatus = await hostedOptions.locator("#status").textContent();
  check(
    "Hosted-managed broker denial",
    /managed_only_build/.test(hostedStatus || "")
      && hostedProviderCalls === 0
      && !hostedManifest.options_page
      && !(hostedManifest.content_scripts || []).some((entry) => entry.js.includes("page-bridge.js")),
    "The hosted profile omits BYOK entry points and its service worker rejects direct extension-page broker access."
  );
} catch (error) {
  check("Hosted-managed audit execution", false, String(error.message || error));
} finally {
  if (hostedContext) await hostedContext.close();
  await rm(hostedProfile, { recursive: true, force: true });
  try {
    runBuild("build");
  } catch (error) {
    check("Neutral build restoration", false, String(error.message || error));
  }
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
