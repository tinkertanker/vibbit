import { readFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import {
  assertFileExists,
  buildMarkdownTable,
  createAuditRunDir,
  repoRoot,
  runCommand,
  trimForTable,
  writeText
} from "./utils.mjs";

const runDir = await createAuditRunDir("smoke");
const screenshots = {
  makecode: path.join(runDir, "01-makecode-page.png"),
  panel: path.join(runDir, "02-panel-visible.png"),
  managed: path.join(runDir, "03-managed-mode.png"),
  byok: path.join(runDir, "04-byok-mode.png"),
  status: path.join(runDir, "05-log-or-status.png"),
  error: path.join(runDir, "99-error.png")
};

const checks = [];
let overallPass = true;

function pushCheck(step, pass, detail) {
  checks.push({ step, result: pass ? "PASS" : "FAIL", detail: trimForTable(detail) });
  if (!pass) overallPass = false;
}

async function runBuildAndPackage() {
  await runCommand("npm", ["run", "build"], { cwd: repoRoot });
  await runCommand("npm", ["run", "package"], { cwd: repoRoot });
  await assertFileExists(path.join(repoRoot, "dist", "content-script.js"));
  await assertFileExists(path.join(repoRoot, "dist", "manifest.json"));
  await assertFileExists(path.join(repoRoot, "artifacts", "bit-vibe-extension.zip"));
  pushCheck("Build + package", true, "`npm run build` and `npm run package` succeeded; expected artefacts exist.");
}

async function runSmokeUi() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  try {
    await page.goto("https://makecode.microbit.org/", { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForTimeout(5000);
    await page.screenshot({ path: screenshots.makecode, fullPage: false });
    pushCheck("01 MakeCode loads", true, `Screenshot saved at \`${screenshots.makecode}\`.`);

    const runtime = await readFile(path.join(repoRoot, "work.js"), "utf8");
    await page.addScriptTag({ content: runtime });
    await page.waitForSelector("#mode", { timeout: 20000 });
    await page.screenshot({ path: screenshots.panel, fullPage: false });

    const panelVisible = await page.evaluate(() => {
      const panel = document.querySelector("#mode")?.closest("div");
      return Boolean(panel && panel.getBoundingClientRect().width > 0 && panel.getBoundingClientRect().height > 0);
    });
    pushCheck(
      "02 Panel visible",
      panelVisible,
      panelVisible
        ? `Panel rendered and screenshot saved at \`${screenshots.panel}\`.`
        : "Panel controls were not visible after injecting `work.js`."
    );

    const managedState = await page.evaluate(() => {
      const mode = document.querySelector("#mode");
      const managedHint = document.querySelector("#managedHint");
      const byokRow = document.querySelector("#byokRow");
      return {
        modeValue: mode ? mode.value : "",
        managedHintVisible: managedHint ? managedHint.style.display !== "none" : false,
        byokHidden: byokRow ? byokRow.style.display === "none" : false
      };
    });
    await page.screenshot({ path: screenshots.managed, fullPage: false });
    pushCheck(
      "03 Managed mode default",
      managedState.modeValue === "managed" && managedState.managedHintVisible && managedState.byokHidden,
      `Mode=${managedState.modeValue}, managedHintVisible=${managedState.managedHintVisible}, byokHidden=${managedState.byokHidden}.`
    );

    await page.selectOption("#mode", "byok");
    await page.waitForTimeout(400);
    const byokState = await page.evaluate(() => {
      const byokRow = document.querySelector("#byokRow");
      const byokKeyRow = document.querySelector("#byokKeyRow");
      return {
        rowVisible: byokRow ? byokRow.style.display !== "none" : false,
        keyVisible: byokKeyRow ? byokKeyRow.style.display !== "none" : false
      };
    });
    await page.screenshot({ path: screenshots.byok, fullPage: false });
    pushCheck(
      "04 BYOK mode toggle",
      byokState.rowVisible && byokState.keyVisible,
      `byokRowVisible=${byokState.rowVisible}, byokKeyVisible=${byokState.keyVisible}.`
    );

    await page.fill("#p", "");
    await page.click("#go");
    await page.waitForTimeout(1000);

    const statusState = await page.evaluate(() => {
      const status = document.querySelector("#status")?.textContent?.trim() || "";
      const logText = document.querySelector("#log")?.textContent || "";
      return { status, logText };
    });

    await page.screenshot({ path: screenshots.status, fullPage: false });
    pushCheck(
      "05 Status/log feedback",
      statusState.status === "Idle" && statusState.logText.includes("Please enter a request."),
      `status='${statusState.status}', logHasPromptValidation=${statusState.logText.includes("Please enter a request.")}.`
    );
  } catch (error) {
    try {
      await page.screenshot({ path: screenshots.error, fullPage: true });
    } catch {
      // Keep primary failure instead of screenshot failure.
    }
    pushCheck("UI smoke execution", false, error && error.message ? error.message : String(error));
  } finally {
    await browser.close();
  }
}

await runBuildAndPackage();
await runSmokeUi();

const reportPath = path.join(runDir, "REPORT.md");
const screenshotList = [
  screenshots.makecode,
  screenshots.panel,
  screenshots.managed,
  screenshots.byok,
  screenshots.status
].map((filePath) => `- \`${filePath}\``);

const report = [
  "# Playwright Smoke Audit",
  "",
  `- Date: ${new Date().toISOString()}`,
  `- Run directory: \`${runDir}\``,
  "",
  "## Checks",
  "",
  buildMarkdownTable(checks),
  "",
  "## Screenshots",
  "",
  ...screenshotList,
  "",
  "## Runtime source",
  "",
  `- \`${path.join(repoRoot, "work.js")}\``,
  "",
  "## Outcome",
  "",
  overallPass ? "PASS" : "FAIL"
].join("\n");

await writeText(reportPath, report + "\n");

console.log(`SUMMARY: ${overallPass ? "PASS" : "FAIL"}`);
console.log(`ARTEFACT_DIR: ${runDir}`);
console.log(`REPORT: ${reportPath}`);
console.log(`SCREENSHOTS: ${Object.values(screenshots).slice(0, 5).join(",")}`);

if (!overallPass) {
  process.exitCode = 1;
}
