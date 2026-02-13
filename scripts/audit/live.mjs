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

function pushCheck(step, pass, detail) {
  checks.push({ step, result: pass ? "PASS" : "FAIL", detail: trimForTable(detail) });
  if (!pass) overallPass = false;
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
    const finalStates = ["Done", "Error", "No code", "Idle"];
    const status = document.querySelector("#status")?.textContent?.trim() || "";
    return finalStates.includes(status);
  }, { timeout: 90000 });

  return page.evaluate(() => {
    return {
      status: document.querySelector("#status")?.textContent?.trim() || "",
      log: document.querySelector("#log")?.textContent || ""
    };
  });
}

async function ensureAuditRuntime(page, runtimeSource) {
  await page.goto("https://makecode.microbit.org/", {
    waitUntil: "domcontentloaded",
    timeout: 120000
  });
  await page.waitForTimeout(4000);

  await page.addScriptTag({ content: runtimeSource });
  await page.waitForSelector("#mode", { timeout: 20000 });

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

function byokKeyForProvider(provider) {
  if (provider === "openai") return process.env.AUDIT_BYOK_OPENAI_KEY || "";
  if (provider === "gemini") return process.env.AUDIT_BYOK_GEMINI_KEY || "";
  if (provider === "openrouter") return process.env.AUDIT_BYOK_OPENROUTER_KEY || "";
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
  pushCheck("Secrets discovery", false, message);

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
  buildEnv.BITVIBE_BACKEND = managedBackend;
  buildEnv.BITVIBE_APP_TOKEN = managedToken;
}

await runCommand("npm", ["run", "build"], { cwd: repoRoot, env: buildEnv });
await runCommand("npm", ["run", "package"], { cwd: repoRoot, env: buildEnv });
await assertFileExists(path.join(repoRoot, "dist", "content-script.js"));
await assertFileExists(path.join(repoRoot, "dist", "manifest.json"));
await assertFileExists(path.join(repoRoot, "artifacts", "bit-vibe-extension.zip"));
pushCheck("Build + package (live)", true, "Build/package succeeded with live audit environment overrides.");

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
    const managedTarget = new URL("/mcai/generate", managedBackend).toString();
    const managedProxyCounter = { count: 0 };
    const managedProxyHandler = createProxyHandler(managedProxyCounter);
    const managedPattern = new RegExp(`^${managedTarget.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);

    await page.route(managedPattern, managedProxyHandler);

    await page.selectOption("#mode", "managed");
    if (await page.isChecked("#inc")) await page.uncheck("#inc");
    await page.fill("#p", managedPrompt);
    await page.click("#go");

    const managedState = await waitForTerminalStatus(page);
    await page.screenshot({ path: screenshots.managed, fullPage: false });

    const managedPass = managedState.status === "Done";
    pushCheck(
      "Managed live request",
      managedPass,
      `status='${managedState.status}', proxiedRequests=${managedProxyCounter.count}, logHasManaged=${managedState.log.includes("Mode: Managed backend.")}.`
    );

    await page.unroute(managedPattern, managedProxyHandler);
  } else {
    pushCheck("Managed live request", true, "Skipped (AUDIT_MANAGED_BACKEND not set).");
  }

  if (hasByok && providerConfig) {
    const byokProxyCounter = { count: 0 };
    const byokProxyHandler = createProxyHandler(byokProxyCounter);
    await page.route(providerConfig.endpointRegex, byokProxyHandler);

    await page.selectOption("#mode", "byok");
    await page.selectOption("#prov", providerConfig.provider);
    await page.fill("#model", providerConfig.model);
    await page.fill("#key", providerConfig.key);
    if (await page.isChecked("#inc")) await page.uncheck("#inc");
    await page.fill("#p", byokPrompt);
    await page.click("#go");

    const byokState = await waitForTerminalStatus(page);
    await page.screenshot({ path: screenshots.byok, fullPage: false });

    const byokPass = byokState.status === "Done";
    pushCheck(
      `BYOK live request (${providerConfig.provider})`,
      byokPass,
      `status='${byokState.status}', proxiedRequests=${byokProxyCounter.count}, logHasByok=${byokState.log.includes("Mode: BYOK.")}.`
    );

    await page.unroute(providerConfig.endpointRegex, byokProxyHandler);
  } else {
    pushCheck("BYOK live request", true, "Skipped (provider key not configured).");
  }
} catch (error) {
  overallPass = false;
  try {
    await page.screenshot({ path: screenshots.error, fullPage: true });
  } catch {
    // Keep the primary failure context.
  }
  pushCheck("Live audit execution", false, error && error.message ? error.message : String(error));
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
