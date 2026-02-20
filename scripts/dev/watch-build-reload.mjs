import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");

const manifestPath = path.join(repoRoot, "extension", "manifest.json");
const defaultWatchTargets = ["work.js", "extension"];

const browserUrl = process.env.VIBBIT_DEVTOOLS_URL || "http://localhost:9222";
const explicitExtensionId = (process.env.VIBBIT_EXTENSION_ID || "").trim();
const debounceMs = Number(process.env.VIBBIT_RELOAD_DEBOUNCE_MS || 300);

function parseWatchTargets() {
  const fromEnv = (process.env.VIBBIT_WATCH_PATHS || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  if (fromEnv.length > 0) return fromEnv;
  return defaultWatchTargets;
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: process.env,
      stdio: "inherit"
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
    });
  });
}

function toShortReason(reason) {
  return reason.length > 140 ? `${reason.slice(0, 137)}...` : reason;
}

async function readExtensionName() {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  return manifest.name || "Vibbit";
}

async function reloadExtensionInChrome({ extensionId, extensionName }) {
  const browser = await chromium.connectOverCDP(browserUrl);
  const context = browser.contexts()[0];
  if (!context) {
    await browser.close();
    throw new Error("No Chrome context available over CDP.");
  }

  const page = await context.newPage();
  try {
    await page.goto("chrome://extensions/", {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });

    await page.waitForTimeout(250);

    const result = await page.evaluate(({ targetId, targetName }) => {
      const manager = document.querySelector("extensions-manager");
      if (!manager || !manager.shadowRoot) {
        return { ok: false, message: "extensions-manager not available." };
      }

      const itemList = manager.shadowRoot.querySelector("extensions-item-list");
      if (!itemList || !itemList.shadowRoot) {
        return { ok: false, message: "extensions-item-list not available." };
      }

      const items = Array.from(itemList.shadowRoot.querySelectorAll("extensions-item"));
      const parsed = items.map((item) => {
        const sr = item.shadowRoot;
        const name = sr?.querySelector("#name")?.textContent?.trim() || "";
        const idText = sr?.querySelector("#extension-id")?.textContent?.trim() || "";
        const idMatch = idText.match(/[a-p]{32}/);
        const id = idMatch ? idMatch[0] : "";
        const reloadButton = sr?.querySelector("#dev-reload-button");
        return { item, name, id, hasReloadButton: Boolean(reloadButton), reloadButton };
      });

      const summary = parsed.map((entry) => ({ name: entry.name, id: entry.id, hasReloadButton: entry.hasReloadButton }));
      let target = null;

      if (targetId) {
        target = parsed.find((entry) => entry.id === targetId) || null;
      } else {
        target = parsed.find((entry) => entry.name === targetName) || null;
      }

      if (!target) {
        return {
          ok: false,
          message: targetId
            ? `Extension with id '${targetId}' not found on chrome://extensions.`
            : `Extension named '${targetName}' not found on chrome://extensions.`,
          summary
        };
      }

      if (!target.reloadButton) {
        return {
          ok: false,
          message: "Reload button unavailable. Ensure Developer mode is enabled on chrome://extensions.",
          name: target.name,
          id: target.id
        };
      }

      target.reloadButton.click();
      return { ok: true, name: target.name, id: target.id };
    }, {
      targetId: extensionId,
      targetName: extensionName
    });

    if (!result || !result.ok) {
      const details = result && result.summary ? ` Available extensions: ${JSON.stringify(result.summary)}.` : "";
      throw new Error(`${result?.message || "Unknown reload failure."}${details}`);
    }

    return result;
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

const watchedPaths = parseWatchTargets().map((relPath) => path.resolve(repoRoot, relPath));
const extensionName = await readExtensionName();

let buildInFlight = false;
let rerunQueued = false;
let debounceTimer = null;
const pendingReasons = new Set();

function queueBuild(reason) {
  pendingReasons.add(toShortReason(reason));

  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void runBuildReloadLoop();
  }, debounceMs);
}

async function runBuildReloadLoop() {
  if (buildInFlight) {
    rerunQueued = true;
    return;
  }

  buildInFlight = true;
  const reasons = Array.from(pendingReasons);
  pendingReasons.clear();

  const stamp = new Date().toISOString();
  console.log(`[${stamp}] Change detected: ${reasons.join(", ") || "manual trigger"}`);

  try {
    await runCommand("npm", ["run", "build"]);
    const reloaded = await reloadExtensionInChrome({
      extensionId: explicitExtensionId,
      extensionName
    });
    console.log(`[${new Date().toISOString()}] Extension reloaded (${reloaded.name}, ${reloaded.id}).`);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Build/reload failed: ${error.message}`);
  } finally {
    buildInFlight = false;
    if (rerunQueued) {
      rerunQueued = false;
      queueBuild("queued-change");
    }
  }
}

const watchers = [];
for (const targetPath of watchedPaths) {
  const watcher = fs.watch(targetPath, { recursive: true }, (eventType, filename) => {
    const fileNameText = filename ? String(filename) : "(unknown)";
    queueBuild(`${eventType}:${path.relative(repoRoot, path.join(targetPath, fileNameText))}`);
  });
  watcher.on("error", (error) => {
    console.error(`[watch-error] ${targetPath}: ${error.message}`);
  });
  watchers.push(watcher);
}

console.log("Watching for extension edits...");
console.log(`- Browser URL: ${browserUrl}`);
console.log(`- Extension lookup: ${explicitExtensionId || extensionName}`);
console.log(`- Watch targets: ${watchedPaths.map((entry) => path.relative(repoRoot, entry)).join(", ")}`);
console.log(`- Debounce: ${debounceMs}ms`);
console.log("Press Ctrl+C to stop.");

queueBuild("startup");

const shutdown = () => {
  for (const watcher of watchers) watcher.close();
  console.log("\nStopped extension watch reload.");
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
