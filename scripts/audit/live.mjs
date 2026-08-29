import { readFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import {
  assertFileExists,
  buildMarkdownTable,
  createAuditRunDir,
  loadAuditEnv,
  providerConfigFromEnv,
  repoRoot,
  runCommand,
  trimForTable,
  writeText
} from "./utils.mjs";

const runDir = await createAuditRunDir("live");
const screenshots = {
  managed: path.join(runDir, "10-managed-live.png"),
  byok: path.join(runDir, "20-byok-live.png"),
  error: path.join(runDir, "99-live-error.png")
};

const checks = [];
let overallPass = true;

function pushCheck(step, result, detail) {
  checks.push({ step, result, detail: trimForTable(detail) });
  if (result === "FAIL") overallPass = false;
}

function overrideConst(source, name, value) {
  const pattern = new RegExp(`const ${name} = ".*?";`);
  if (!pattern.test(source)) {
    throw new Error(`Could not locate ${name} in runtime source`);
  }
  return source.replace(pattern, `const ${name} = ${JSON.stringify(value)};`);
}

function buildCorsHeaders(request) {
  const requestedHeaders = request.headers()["access-control-request-headers"] || "*";
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": requestedHeaders,
    "access-control-max-age": "86400"
  };
}

function createProxyHandler(counter) {
  return async (route) => {
    const request = route.request();
    counter.count += 1;

    if (request.method() === "OPTIONS") {
      await route.fulfill({
        status: 204,
        headers: buildCorsHeaders(request),
        body: ""
      });
      return;
    }

    const forwardHeaders = { ...request.headers() };
    delete forwardHeaders.host;
    delete forwardHeaders.origin;
    delete forwardHeaders["content-length"];

    const response = await fetch(request.url(), {
      method: request.method(),
      headers: forwardHeaders,
      body: request.postDataBuffer() || undefined,
      redirect: "follow"
    });

    const responseHeaders = {};
    response.headers.forEach((value, key) => {
      if (key.toLowerCase() === "content-encoding") return;
      if (key.toLowerCase() === "content-length") return;
      if (key.toLowerCase() === "transfer-encoding") return;
      responseHeaders[key] = value;
    });

    await route.fulfill({
      status: response.status,
      headers: {
        ...responseHeaders,
        ...buildCorsHeaders(request)
      },
      body: Buffer.from(await response.arrayBuffer())
    });
  };
}

async function waitForTerminalStatus(page) {
  await page.waitForFunction(() => {
    const finalStates = ["Done", "Applied, unverified", "Fallback applied", "Error", "No code", "Idle"];
    const status = document.querySelector("#status")?.textContent?.trim() || "";
    return finalStates.includes(status);
  }, undefined, { timeout: 90000 });

  return page.evaluate(() => {
    return {
      status: document.querySelector("#status")?.textContent?.trim() || "",
      log: document.querySelector("#log")?.textContent || ""
    };
  });
}

async function ensureAuditRuntime(page, runtimeSource) {
  await page.addInitScript(() => {
    try {
      localStorage.clear();
      sessionStorage.clear();
    } catch {
      // Ignore storage access errors in hardened browser contexts.
    }
  });

  await page.goto("https://makecode.microbit.org/", {
    waitUntil: "domcontentloaded",
    timeout: 120000
  });
  await page.waitForTimeout(4000);

  await page.addScriptTag({ content: runtimeSource });
  await page.waitForSelector("#vibbit-fab", { timeout: 20000 });
  await page.click("#vibbit-fab");
  await page.waitForSelector("#setup-go", { timeout: 20000 });

  // Complete one-time setup in BYOK mode with a placeholder key so we can
  // exercise both Managed and BYOK in a single live audit run.
  await page.selectOption("#setup-mode", "byok");
  await page.fill("#setup-key", "audit-placeholder-key");
  await page.click("#setup-go");
  await page.waitForSelector("#go", { timeout: 20000 });

  await page.evaluate(() => {
    if (window.__auditMonacoStub) return;

    const model = {
      __value: "",
      getValue() {
        return this.__value;
      },
      setValue(next) {
        this.__value = String(next || "");
      }
    };

    const editor = {
      getModel() {
        return model;
      },
      setPosition() {}
    };

    window.monaco = {
      editor: {
        getModels() {
          return [model];
        },
        getEditors() {
          return [editor];
        }
      }
    };

    window.__auditMonacoStub = true;
  });
}

async function configureModeInSettings(page, mode, options = {}) {
  await page.click("#gear");
  await page.waitForSelector("#set-mode", { timeout: 20000 });
  await page.selectOption("#set-mode", mode);

  if (mode === "byok") {
    if (options.provider) {
      await page.selectOption("#set-prov", options.provider);
    }

    if (options.model) {
      await page.evaluate((targetModel) => {
        const modelSel = document.querySelector("#set-model");
        if (modelSel) {
          const found = Array.from(modelSel.options).some((opt) => opt.value === targetModel);
          if (found) {
            modelSel.value = targetModel;
            modelSel.dispatchEvent(new Event("change", { bubbles: true }));
          }
        }
        // Runtime reads model from local storage, so force the intended model.
        localStorage.setItem("__vibbit_model", targetModel);
      }, options.model);
    }

    if (typeof options.key === "string" && options.key.length) {
      await page.fill("#set-key", options.key);
      await page.click("#save");
    }
  }

  if (options.target) {
    await page.selectOption("#set-target", options.target);
  }

  await page.click("#back");
  await page.waitForSelector("#go", { timeout: 20000 });
}

function byokKeyForProvider(provider) {
  if (provider === "openai") return process.env.AUDIT_BYOK_OPENAI_KEY || "";
  if (provider === "gemini") return process.env.AUDIT_BYOK_GEMINI_KEY || "";
  if (provider === "openrouter") return process.env.AUDIT_BYOK_OPENROUTER_KEY || "";
  if (provider === "opencode") return process.env.AUDIT_BYOK_OPENCODE_KEY || "";
  return "";
}

const envLoad = await loadAuditEnv();
const providerConfig = providerConfigFromEnv();
const managedBackend = (process.env.AUDIT_MANAGED_BACKEND || "").trim();
const managedToken = process.env.AUDIT_MANAGED_APP_TOKEN || "";
const byokPrompt = process.env.AUDIT_BYOK_PROMPT || "Create a tiny MakeCode micro:bit program that shows a heart icon forever.";
const managedPrompt = process.env.AUDIT_MANAGED_PROMPT || "Create a tiny MakeCode micro:bit program that flashes an LED dot.";

const hasManaged = managedBackend.length > 0;
const hasByok = Boolean(providerConfig && byokKeyForProvider(providerConfig.provider));
const requireSecrets = process.env.AUDIT_REQUIRE_SECRETS === "1";

if (!hasManaged && !hasByok) {
  const message = envLoad.exists
    ? `No live secrets available in ${envLoad.envFile}.`
    : `No live secrets available. Create ${envLoad.envFile} from .env.audit.example.`;
  pushCheck("Secrets discovery", requireSecrets ? "FAIL" : "SKIPPED", message);

  const reportPath = path.join(runDir, "REPORT.md");
  const report = [
    "# Playwright Live Audit",
    "",
    `- Date: ${new Date().toISOString()}`,
    `- Run directory: \`${runDir}\``,
    "",
    "## Checks",
    "",
    buildMarkdownTable(checks),
    "",
    "## Outcome",
    "",
    requireSecrets ? "FAIL" : "SKIPPED"
  ].join("\n");

  await writeText(reportPath, report + "\n");
  console.log(`SUMMARY: ${requireSecrets ? "FAIL" : "SKIPPED"}`);
  console.log(`ARTEFACT_DIR: ${runDir}`);
  console.log(`REPORT: ${reportPath}`);
  if (requireSecrets) process.exitCode = 1;
  process.exit();
}

const buildEnv = { ...process.env };
if (hasManaged) {
  buildEnv.VIBBIT_BACKEND = managedBackend;
  buildEnv.VIBBIT_APP_TOKEN = managedToken;
}

await runCommand("npm", ["run", "build"], { cwd: repoRoot, env: buildEnv });
await runCommand("npm", ["run", "package"], { cwd: repoRoot, env: buildEnv });
await assertFileExists(path.join(repoRoot, "dist", "content-script.js"));
await assertFileExists(path.join(repoRoot, "dist", "manifest.json"));
await assertFileExists(path.join(repoRoot, "artifacts", "vibbit-extension.zip"));
pushCheck("Build + package (live)", "PASS", "Build/package succeeded with live audit environment overrides.");

let runtimeSource = await readFile(path.join(repoRoot, "work.js"), "utf8");
if (hasManaged) {
  runtimeSource = overrideConst(runtimeSource, "BACKEND", managedBackend);
  runtimeSource = overrideConst(runtimeSource, "APP_TOKEN", managedToken);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

try {
  await ensureAuditRuntime(page, runtimeSource);

  if (hasManaged) {
    // Mirror runtime construction exactly: BACKEND + "/vibbit/generate"
    const managedTarget = managedBackend + "/vibbit/generate";
    const managedProxyCounter = { count: 0 };
    const managedProxyHandler = createProxyHandler(managedProxyCounter);
    const managedPattern = new RegExp(`^${managedTarget.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);

    await page.route(managedPattern, managedProxyHandler);

    await configureModeInSettings(page, "managed");
    if (await page.isChecked("#inc")) await page.uncheck("#inc");
    await page.fill("#p", managedPrompt);
    await page.click("#go");

    const managedState = await waitForTerminalStatus(page);
    await page.screenshot({ path: screenshots.managed, fullPage: false });

    const managedPass = managedState.status === "Applied, unverified";
    pushCheck(
      "Managed live transport (editor validation unavailable in this audit)",
      managedPass ? "PASS" : "FAIL",
      `status='${managedState.status}', proxiedRequests=${managedProxyCounter.count}, logHasManaged=${managedState.log.includes("Mode: Managed backend.")}.`
    );

    await page.unroute(managedPattern, managedProxyHandler);
  } else {
    pushCheck("Managed live request", "SKIPPED", "Skipped (AUDIT_MANAGED_BACKEND not set).");
  }

  if (hasByok && providerConfig) {
    const byokProxyCounter = { count: 0 };
    const byokProxyHandler = createProxyHandler(byokProxyCounter);
    await page.route(providerConfig.endpointRegex, byokProxyHandler);

    await configureModeInSettings(page, "byok", {
      provider: providerConfig.provider,
      model: providerConfig.model,
      key: providerConfig.key
    });
    if (await page.isChecked("#inc")) await page.uncheck("#inc");
    await page.fill("#p", byokPrompt);
    await page.click("#go");

    const byokState = await waitForTerminalStatus(page);
    await page.screenshot({ path: screenshots.byok, fullPage: false });

    const byokPass = byokState.status === "Applied, unverified";
    pushCheck(
      `BYOK live transport (${providerConfig.provider}; editor validation unavailable in this audit)`,
      byokPass ? "PASS" : "FAIL",
      `status='${byokState.status}', proxiedRequests=${byokProxyCounter.count}, logHasByok=${byokState.log.includes("Mode: BYOK.")}.`
    );

    await page.unroute(providerConfig.endpointRegex, byokProxyHandler);
  } else {
    pushCheck("BYOK live request", "SKIPPED", "Skipped (provider key not configured).");
  }
} catch (error) {
  overallPass = false;
  try {
    await page.screenshot({ path: screenshots.error, fullPage: true });
  } catch {
    // Keep the primary failure context.
  }
  pushCheck("Live audit execution", "FAIL", error && error.message ? error.message : String(error));
} finally {
  await browser.close();
}

const reportPath = path.join(runDir, "REPORT.md");
const report = [
  "# Playwright Live Audit",
  "",
  `- Date: ${new Date().toISOString()}`,
  `- Run directory: \`${runDir}\``,
  `- Env file: \`${envLoad.envFile}\` (${envLoad.exists ? "found" : "missing"})`,
  "",
  "## Checks",
  "",
  buildMarkdownTable(checks),
  "",
  "## Screenshots",
  "",
  `- \`${screenshots.managed}\``,
  `- \`${screenshots.byok}\``,
  "",
  "## Notes",
  "",
  "- Live requests are proxied through Node in the Playwright route handler to avoid browser CORS limitations while preserving runtime request payloads.",
  "- Secrets are sourced from environment variables or `.env.audit` and are never printed in the report.",
  "",
  "## Outcome",
  "",
  overallPass ? "PASS" : "FAIL"
].join("\n");

await writeText(reportPath, report + "\n");

console.log(`SUMMARY: ${overallPass ? "PASS" : "FAIL"}`);
console.log(`ARTEFACT_DIR: ${runDir}`);
console.log(`REPORT: ${reportPath}`);
console.log(`SCREENSHOTS: ${screenshots.managed},${screenshots.byok}`);

if (!overallPass) {
  process.exitCode = 1;
}
