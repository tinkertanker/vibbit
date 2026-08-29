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
  managedFeedback: path.join(runDir, "05-managed-feedback.png"),
  byokFeedback: path.join(runDir, "06-byok-feedback.png"),
  hostedPanel: path.join(runDir, "07-hosted-panel.png"),
  error: path.join(runDir, "99-error.png")
};

const checks = [];
let overallPass = true;

function pushCheck(step, pass, detail) {
  checks.push({ step, result: pass ? "PASS" : "FAIL", detail: trimForTable(detail) });
  if (!pass) overallPass = false;
}

async function installFetchMock(page) {
  await page.evaluate(() => {
    if (!window.__smokeMonacoStub) {
      const model = {
        __value: "",
        __version: 1,
        getValue() {
          return this.__value;
        },
        getVersionId() {
          return this.__version;
        },
        setValue(next) {
          this.__value = String(next || "");
          this.__version += 1;
          window.__smokeMonacoValue = this.__value;
        }
      };
      window.__smokeMonacoModel = model;
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
      for (const label of ["JavaScript", "Blocks"]) {
        const existing = [...document.querySelectorAll("button,[role='tab']")]
          .find((node) => ((node.textContent || "") + " " + (node.getAttribute("aria-label") || "")).includes(label));
        if (existing) continue;
        const tab = document.createElement("button");
        tab.setAttribute("role", "tab");
        tab.setAttribute("aria-label", label);
        tab.textContent = label;
        tab.style.position = "fixed";
        tab.style.left = "-9999px";
        document.body.appendChild(tab);
      }
      window.__smokeMonacoStub = true;
    }

    if (!window.__smokeFetchMock) {
      const nativeFetch = window.fetch.bind(window);
      window.__smokeManagedCalls = 0;
      window.__smokeByokCalls = 0;
      window.__smokeByokBody = null;
      window.__smokeByokUrl = "";
      window.__smokeConnectCalls = 0;
      window.__smokeSessionToken = "";
      window.__smokeManagedAbortObserved = false;
      window.fetch = (input, init) => {
        const url = typeof input === "string" ? input : (input && input.url ? input.url : "");
        const headers = (init && init.headers) || {};
        const authHeader = typeof headers.get === "function"
          ? (headers.get("authorization") || headers.get("Authorization") || "")
          : (headers.Authorization || headers.authorization || "");
        if (url.includes("/vibbit/connect")) {
          window.__smokeConnectCalls += 1;
          window.__smokeSessionToken = "smoke-session-token";
          return Promise.resolve(new Response(JSON.stringify({
            ok: true,
            classroomName: "Smoke Classroom",
            sessionToken: window.__smokeSessionToken,
            expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString()
          }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }));
        }
        if (url.includes("/vibbit/generate")) {
          if (!window.__smokeSessionToken || !String(authHeader).includes(window.__smokeSessionToken)) {
            return Promise.resolve(new Response(JSON.stringify({ error: "Unauthorized" }), {
              status: 401,
              headers: { "Content-Type": "application/json" }
            }));
          }
          window.__smokeManagedCalls += 1;
          if (window.__smokeDelayManaged) {
            return new Promise((_resolve, reject) => {
              const onAbort = () => {
                window.__smokeManagedAbortObserved = true;
                reject(new DOMException("Aborted", "AbortError"));
              };
              if (init?.signal?.aborted) onAbort();
              else init?.signal?.addEventListener("abort", onAbort, { once: true });
            });
          }
          return Promise.resolve(new Response(JSON.stringify({
            code: "basic.showString(\"Managed\")",
            feedback: [],
            outcome: window.__smokeManagedOutcome || undefined
          }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }));
        }
        if (url.includes("api.openai.com/v1/chat/completions")
          || url.includes("api.openai.com/v1/responses")
          || url.includes("openrouter.ai/api/v1/chat/completions")
          || url.includes("opencode.ai/zen/")) {
          window.__smokeByokCalls += 1;
          window.__smokeByokUrl = url;
          try { window.__smokeByokBody = JSON.parse((init && init.body) || "null"); } catch {}
          const generated = window.__smokeForceInvalid
            ? "{\"feedback\":[\"retry\"],\"code\":\"const bad = () => 1\"}"
            : "{\"feedback\":[],\"code\":\"basic.showString(\\\"BYOK\\\")\"}";
          const responseBody = url.endsWith("/responses")
            ? { output: [{ content: [{ type: "output_text", text: generated }] }] }
            : { choices: [{ message: { content: generated } }] };
          return Promise.resolve(new Response(JSON.stringify(responseBody), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }));
        }
        return nativeFetch(input, init);
      };
      window.__smokeFetchMock = true;
    }
  });
}

async function runBuildAndPackage() {
  await runCommand("npm", ["run", "check:compat-core"], { cwd: repoRoot });
  pushCheck("Compat core sync", true, "`npm run check:compat-core` passed.");

  await runCommand("npm", ["run", "build"], { cwd: repoRoot });
  const neutralManifest = JSON.parse(
    await readFile(path.join(repoRoot, "dist", "manifest.json"), "utf8")
  );
  const neutralScript = await readFile(path.join(repoRoot, "dist", "content-script.js"), "utf8");
  const neutralHasByokPerms = (neutralManifest.host_permissions || []).includes("https://api.openai.com/*")
    && (neutralManifest.host_permissions || []).includes("https://generativelanguage.googleapis.com/*")
    && (neutralManifest.host_permissions || []).includes("https://openrouter.ai/*")
    && (neutralManifest.host_permissions || []).includes("https://opencode.ai/*");
  pushCheck(
    "Neutral build keeps BYOK host permissions",
    neutralHasByokPerms && /const HOSTED_MANAGED = false;/.test(neutralScript),
    `byokPerms=${neutralHasByokPerms}, hostedManagedFalse=${/const HOSTED_MANAGED = false;/.test(neutralScript)}.`
  );

  await runCommand("npm", ["run", "package"], { cwd: repoRoot });
  await assertFileExists(path.join(repoRoot, "dist", "content-script.js"));
  await assertFileExists(path.join(repoRoot, "dist", "manifest.json"));
  await assertFileExists(path.join(repoRoot, "artifacts", "vibbit-extension.zip"));

  const hostedManifest = JSON.parse(
    await readFile(path.join(repoRoot, "dist", "manifest.json"), "utf8")
  );
  const hostedScript = await readFile(path.join(repoRoot, "dist", "content-script.js"), "utf8");
  const hostedBackground = await readFile(path.join(repoRoot, "dist", "extension", "background.js"), "utf8");
  const hostedForbiddenFiles = [
    "page-bridge.js",
    "options.html",
    "options.js",
    "extension/byok-arm.mjs",
    "extension/byok-broker.mjs",
    "extension/byok-config.mjs",
    "extension/provider-transport.mjs",
    "shared/makecode-compat-core.mjs"
  ];
  const hostedFilesMissing = (await Promise.all(hostedForbiddenFiles.map(async (name) => {
    try {
      await readFile(path.join(repoRoot, "dist", name));
      return false;
    } catch (error) {
      if (error?.code === "ENOENT") return true;
      throw error;
    }
  }))).every(Boolean);
  const { stdout: zipEntries } = await runCommand(
    "unzip",
    ["-Z1", path.join(repoRoot, "artifacts", "vibbit-extension.zip")],
    { cwd: repoRoot, stream: false }
  );
  const hostedZipStripped = hostedForbiddenFiles.every((name) => !zipEntries.split(/\r?\n/).includes(name));
  const hostedHasByokPerms = (hostedManifest.host_permissions || []).some((item) => (
    item.includes("api.openai.com")
    || item.includes("generativelanguage.googleapis.com")
    || item.includes("openrouter.ai")
    || item.includes("opencode.ai")
  ));
  const hostedRuntimeHasByokCapability = [
    "__vibbit_extension_request_v2_",
    "vibbit:byok:",
    "memoryProviderKeys",
    "gpt-5.6-luna",
    "gemini-3-flash-preview",
    "deepseek/deepseek-v4-flash-0731",
    "go/responses/gpt-5.6-luna"
  ].some((item) => hostedScript.includes(item));
  pushCheck(
    "Hosted package is code-only Managed",
    /const HOSTED_MANAGED = true;/.test(hostedScript)
      && /const BACKEND = "https:\/\/vibbit\.tk\.sg";/.test(hostedScript)
      && /const HOSTED_MANAGED = true;/.test(hostedBackground)
      && !hostedHasByokPerms
      && !hostedRuntimeHasByokCapability
      && !(hostedManifest.permissions || []).includes("storage")
      && !hostedManifest.options_page
      && !(hostedManifest.content_scripts || []).some((entry) => entry.js.includes("page-bridge.js"))
      && hostedFilesMissing
      && hostedZipStripped
      && (hostedManifest.host_permissions || []).includes("https://vibbit.tk.sg/*"),
    `hostedManaged=${/const HOSTED_MANAGED = true;/.test(hostedScript)}, brokerDenied=${/const HOSTED_MANAGED = true;/.test(hostedBackground)}, byokPermsRemoved=${!hostedHasByokPerms}, byokRuntimeRemoved=${!hostedRuntimeHasByokCapability}, byokFilesRemoved=${hostedFilesMissing && hostedZipStripped}.`
  );
  pushCheck("Build + package", true, "`npm run build` (neutral) and `npm run package` (hosted) succeeded.");
}

async function runNeutralUiSmoke(page) {
  const runtime = await readFile(path.join(repoRoot, "work.js"), "utf8");
  pushCheck(
    "02 Prompt format guard",
    !runtime.includes("FEEDBACK:"),
    "Runtime prompt no longer uses legacy FEEDBACK: prefix instructions."
  );
  pushCheck(
    "03 Prompt micro:bit guardrails",
    runtime.includes("MICRO:BIT BUILT-IN ICON/ENUM RULES")
      && runtime.includes("MICRO:BIT BLOCKS-TEST STYLE EXAMPLES"),
    "Runtime prompt keeps pxt-microbit icon/enum + blocks-test style guidance."
  );
  const sharedCompatCore = await readFile(path.join(repoRoot, "shared", "makecode-compat-core.mjs"), "utf8");
  pushCheck(
    "03b Backend prompt micro:bit guardrails",
    sharedCompatCore.includes("MICRO:BIT BUILT-IN ICON/ENUM RULES")
      && sharedCompatCore.includes("MICRO:BIT BLOCKS-TEST STYLE EXAMPLES"),
    "Backend prompt keeps pxt-microbit icon/enum + blocks-test style guidance."
  );

  await page.addScriptTag({ content: runtime });
  await page.waitForSelector("#vibbit-fab", { timeout: 20000 });
  await page.click("#vibbit-fab");
  await page.waitForSelector("#setup-go", { timeout: 20000 });
  await page.screenshot({ path: screenshots.panel, fullPage: false });

  const panelVisible = await page.evaluate(() => {
    const panel = document.querySelector("#vibbit-panel");
    const setupView = document.querySelector("#bv-setup");
    if (!panel || !setupView) return false;
    const panelRect = panel.getBoundingClientRect();
    const setupStyle = getComputedStyle(setupView);
    return panelRect.width > 0 && panelRect.height > 0 && setupStyle.display !== "none";
  });
  pushCheck(
    "04 Panel visible",
    panelVisible,
    panelVisible
      ? `Panel rendered and screenshot saved at \`${screenshots.panel}\`.`
      : "Panel controls were not visible after injecting `work.js`."
  );

  const modalAccessibility = await page.evaluate(() => {
    const panel = document.querySelector("#vibbit-panel");
    const backdrop = document.querySelector("#vibbit-backdrop");
    const controls = [...(panel?.querySelectorAll("input,select,textarea") || [])];
    const unnamed = controls.filter((control) => (
      !control.labels?.length && !String(control.getAttribute("aria-label") || "").trim()
    )).map((control) => control.id || control.tagName);
    const outside = [...document.body.children].filter((node) => (
      node !== backdrop && node.id !== "vibbit-preview-bar" && node.id !== "vibbit-live-status"
    ));
    const focusable = [...(panel?.querySelectorAll(
      'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])'
    ) || [])].filter((node) => Boolean(node.offsetWidth || node.offsetHeight || node.getClientRects().length));
    focusable.at(-1)?.focus();
    return {
      unnamed,
      outsideInert: outside.length > 0 && outside.every((node) => node.inert === true),
      firstId: focusable[0]?.id || ""
    };
  });
  const dynamicSiblingInert = await page.evaluate(async () => {
    const sibling = document.createElement("button");
    sibling.id = "smoke-dynamic-modal-sibling";
    sibling.textContent = "Late page control";
    document.body.appendChild(sibling);
    await new Promise((resolve) => setTimeout(resolve, 0));
    return sibling.inert === true;
  });
  await page.keyboard.press("Tab");
  const focusTrapped = await page.evaluate((firstId) => (
    document.activeElement?.id === firstId
      && document.querySelector("#vibbit-panel")?.contains(document.activeElement)
  ), modalAccessibility.firstId);
  await page.click("#x-setup");
  await page.waitForFunction(() => document.querySelector("#vibbit-backdrop")?.style.display === "none");
  const dynamicSiblingRestored = await page.evaluate(() => {
    const sibling = document.querySelector("#smoke-dynamic-modal-sibling");
    const restored = sibling?.inert === false;
    sibling?.remove();
    return restored;
  });
  await page.evaluate(() => {
    const probe = document.createElement("button");
    probe.id = "smoke-focus-restore";
    probe.textContent = "Focus probe";
    document.body.appendChild(probe);
    probe.focus();
    window.__vibbit.open();
  });
  await page.waitForFunction(() => document.querySelector("#vibbit-backdrop")?.dataset.active === "true");
  await page.click("#x-setup");
  await page.waitForFunction(() => document.querySelector("#vibbit-backdrop")?.style.display === "none");
  const focusRestored = await page.evaluate(() => {
    const restored = document.activeElement?.id === "smoke-focus-restore";
    document.querySelector("#smoke-focus-restore")?.remove();
    window.__vibbit.open();
    return restored;
  });
  await page.waitForFunction(() => document.querySelector("#vibbit-backdrop")?.dataset.active === "true");
  pushCheck(
    "04b Modal keyboard and screen-reader contract",
    modalAccessibility.unnamed.length === 0
      && modalAccessibility.outsideInert
      && dynamicSiblingInert
      && dynamicSiblingRestored
      && focusTrapped
      && focusRestored,
    `unnamedControls=${modalAccessibility.unnamed.join(",") || "none"}, outsideInert=${modalAccessibility.outsideInert}, dynamicSiblingInert=${dynamicSiblingInert}, dynamicSiblingRestored=${dynamicSiblingRestored}, focusTrapped=${focusTrapped}, focusRestored=${focusRestored}.`
  );

  const setupDefault = await page.evaluate(() => {
    const mode = document.querySelector("#setup-mode");
    const modeRow = document.querySelector("#setup-mode-row");
    const byokProvider = document.querySelector("#setup-byok-provider");
    const byokModel = document.querySelector("#setup-byok-model");
    const byokKey = document.querySelector("#setup-byok-key");
    const managedServer = document.querySelector("#setup-managed-server");
    return {
      modeValue: mode ? mode.value : "",
      modeRowHidden: modeRow ? getComputedStyle(modeRow).display === "none" : false,
      byokProviderVisible: byokProvider ? getComputedStyle(byokProvider).display !== "none" : false,
      byokModelVisible: byokModel ? getComputedStyle(byokModel).display !== "none" : false,
      byokKeyVisible: byokKey ? getComputedStyle(byokKey).display !== "none" : false,
      managedServerHidden: managedServer ? getComputedStyle(managedServer).display === "none" : false
    };
  });
  pushCheck(
    "05 Setup defaults (neutral BYOK)",
    setupDefault.modeValue === "byok"
      && !setupDefault.modeRowHidden
      && setupDefault.byokProviderVisible
      && setupDefault.byokModelVisible
      && setupDefault.byokKeyVisible
      && setupDefault.managedServerHidden,
    `mode=${setupDefault.modeValue}, modeRowHidden=${setupDefault.modeRowHidden}, byokVisible=${setupDefault.byokProviderVisible}.`
  );

  await page.selectOption("#setup-mode", "managed");
  await page.waitForTimeout(400);
  const managedState = await page.evaluate(() => {
    const mode = document.querySelector("#setup-mode");
    const byokProvider = document.querySelector("#setup-byok-provider");
    const managedServer = document.querySelector("#setup-managed-server");
    const managedServerUrl = document.querySelector("#setup-managed-server-url");
    const classCode = document.querySelector("#setup-class-code");
    return {
      modeValue: mode ? mode.value : "",
      byokProviderHidden: byokProvider ? getComputedStyle(byokProvider).display === "none" : false,
      managedServerVisible: managedServer ? getComputedStyle(managedServer).display !== "none" : false,
      serverUrlVisible: managedServerUrl ? getComputedStyle(managedServerUrl).display !== "none" : false,
      classCodeVisible: classCode ? getComputedStyle(classCode).display !== "none" : false
    };
  });
  await page.screenshot({ path: screenshots.managed, fullPage: false });
  pushCheck(
    "06 Setup mode toggle (managed)",
    managedState.modeValue === "managed"
      && managedState.byokProviderHidden
      && managedState.managedServerVisible
      && managedState.serverUrlVisible
      && managedState.classCodeVisible,
    `mode=${managedState.modeValue}, serverUrlVisible=${managedState.serverUrlVisible}, classCodeVisible=${managedState.classCodeVisible}.`
  );

  await installFetchMock(page);
  await page.fill("#setup-server", "vibbit.tk.sg");
  await page.fill("#setup-class-code", "SMOKE-TESTA");
  await page.click("#setup-go");
  await page.waitForSelector("#go", { timeout: 20000 });

  const joinedState = await page.evaluate(() => ({
    connectCalls: Number(window.__smokeConnectCalls || 0),
    badge: document.querySelector("#classroom-badge")?.textContent || ""
  }));
  pushCheck(
    "07 Join verifies classroom on Get Started",
    joinedState.connectCalls === 1 && joinedState.badge.includes("Smoke Classroom"),
    `connectCalls=${joinedState.connectCalls}, badge='${joinedState.badge}'.`
  );

  await page.fill("#p", "Create a tiny managed program");
  await page.click("#go");
  await page.waitForFunction(() => {
    const status = document.querySelector("#status")?.textContent?.trim() || "";
    return ["Done", "Applied, unverified", "Fallback applied", "Error"].includes(status);
  }, { timeout: 30000 });

  const managedGenerationState = await page.evaluate(() => {
    const status = document.querySelector("#status")?.textContent?.trim() || "";
    const pastedCode = window.__smokeMonacoValue || "";
    return {
      status,
      pastedCode,
      connectCalls: Number(window.__smokeConnectCalls || 0),
      managedCalls: Number(window.__smokeManagedCalls || 0)
    };
  });
  await page.screenshot({ path: screenshots.managedFeedback, fullPage: false });
  pushCheck(
    "08 Managed mocked generation",
    managedGenerationState.status === "Applied, unverified"
      && managedGenerationState.connectCalls === 1
      && managedGenerationState.managedCalls === 1
      && managedGenerationState.pastedCode.includes("basic.showString(\"Managed\")"),
    `status='${managedGenerationState.status}', connectCalls=${managedGenerationState.connectCalls}, managedCalls=${managedGenerationState.managedCalls}.`
  );

  await page.evaluate(() => {
    window.__smokeManagedOutcome = "ok-unverified";
    const sourceFile = { name: "main.ts", content: "" };
    const blocksFile = { name: "main.blocks", content: "<xml></xml>" };
    const workspace = {
      isFlyout: false,
      isDisposed() { return false; },
      getAllBlocks() { return []; }
    };
    const textEditor = {};
    const blocksEditor = {
      editor: workspace,
      loadingXml: false,
      loadingXmlPromise: null,
      delayLoadXml: null,
      typeScriptSaveable: true
    };
    const project = {
      state: { header: { id: "smoke-live-project", editor: "tsprj" }, currFile: sourceFile },
      editor: textEditor,
      editorFile: sourceFile,
      textEditor,
      blocksEditor,
      updatingEditorFile: false,
      isBlocksActive() { return this.editor === blocksEditor; },
      saveCurrentSourceAsync() {
        sourceFile.content = window.__smokeMonacoModel.getValue();
        return Promise.resolve();
      }
    };
    window.__smokeLiveProject = project;
    window.__smokeLiveTextEditor = textEditor;
    window.__smokeLiveSourceFile = sourceFile;
    window.__smokeOriginalE = window.E;
    window.E = { getEditor() { return project; } };
    window.__smokeBlocksClickHandler = (event) => {
      const control = event.target?.closest?.("button,[role='tab'],a,[aria-label]");
      const label = ((control?.textContent || "") + " " + (control?.getAttribute?.("aria-label") || "")).toLowerCase();
      if (!label.includes("blocks") || label.includes("javascript")) return;
      project.editor = blocksEditor;
      project.editorFile = blocksFile;
      project.state.currFile = blocksFile;
      project.state.header.editor = "blocksprj";
    };
    document.addEventListener("click", window.__smokeBlocksClickHandler, true);
  });
  await page.fill("#p", "Verify the live editor can upgrade an upstream unverified result");
  await page.click("#go");
  await page.waitForFunction(() => (
    ["Done", "Applied, unverified", "Fallback applied", "Error"].includes(
      document.querySelector("#status")?.textContent?.trim()
    )
  ), { timeout: 30000 });
  const liveUpgradeState = await page.evaluate(() => ({
    status: document.querySelector("#status")?.textContent?.trim() || "",
    liveStatus: document.querySelector("#vibbit-live-status")?.textContent?.trim() || "",
    log: document.querySelector("#log")?.textContent || ""
  }));
  pushCheck(
    "08b Live validation upgrades upstream unverified outcome",
    liveUpgradeState.status === "Done"
      && liveUpgradeState.liveStatus === "Done"
      && /Live decompile check passed/.test(liveUpgradeState.log),
    `status='${liveUpgradeState.status}', liveStatus='${liveUpgradeState.liveStatus}', liveProbePassed=${/Live decompile check passed/.test(liveUpgradeState.log)}, log='${liveUpgradeState.log.slice(-320)}'.`
  );
  await page.evaluate(() => {
    document.removeEventListener("click", window.__smokeBlocksClickHandler, true);
    const project = window.__smokeLiveProject;
    project.editor = window.__smokeLiveTextEditor;
    project.editorFile = window.__smokeLiveSourceFile;
    project.state.currFile = window.__smokeLiveSourceFile;
    project.state.header.editor = "tsprj";
  });
  await page.fill("#p", "Do not verify a stale Blocks workspace");
  await page.click("#go");
  await page.waitForFunction(() => (
    ["Done", "Applied, unverified", "Fallback applied", "Error"].includes(
      document.querySelector("#status")?.textContent?.trim()
    )
  ), { timeout: 30000 });
  const staleWorkspaceState = await page.evaluate(() => ({
    status: document.querySelector("#status")?.textContent?.trim() || "",
    log: document.querySelector("#log")?.textContent || ""
  }));
  pushCheck(
    "08c Stale Blocks workspace fails closed",
    staleWorkspaceState.status === "Applied, unverified"
      && /Live decompile check unavailable/.test(staleWorkspaceState.log),
    `status='${staleWorkspaceState.status}', validationUnavailable=${/Live decompile check unavailable/.test(staleWorkspaceState.log)}.`
  );
  await page.evaluate(() => {
    delete window.__smokeManagedOutcome;
    document.removeEventListener("click", window.__smokeBlocksClickHandler, true);
    delete window.__smokeBlocksClickHandler;
    delete window.__smokeLiveProject;
    delete window.__smokeLiveTextEditor;
    delete window.__smokeLiveSourceFile;
    window.E = window.__smokeOriginalE;
    delete window.__smokeOriginalE;
  });

  const managedCallsBeforeClose = await page.evaluate(() => {
    window.__smokeDelayManaged = true;
    window.__smokeManagedAbortObserved = false;
    return Number(window.__smokeManagedCalls || 0);
  });
  await page.fill("#p", "close-cancels active generation");
  await page.click("#go");
  await page.waitForFunction(
    (before) => Number(window.__smokeManagedCalls || 0) > before,
    managedCallsBeforeClose,
    { timeout: 10000 }
  );
  await page.click("#x-main");
  await page.waitForFunction(() => (
    window.__smokeManagedAbortObserved === true
      && document.querySelector("#vibbit-backdrop")?.style.display === "none"
      && document.querySelector("#vibbit-live-status")?.textContent?.trim() === "Cancelled"
  ), { timeout: 10000 });
  const closeCancellation = await page.evaluate(() => {
    const result = {
      aborted: window.__smokeManagedAbortObserved === true,
      hidden: document.querySelector("#vibbit-backdrop")?.style.display === "none",
      liveStatus: document.querySelector("#vibbit-live-status")?.textContent?.trim() || ""
    };
    window.__smokeDelayManaged = false;
    window.__vibbit.open();
    return result;
  });
  pushCheck(
    "08d Closing Vibbit cancels active generation",
    closeCancellation.aborted && closeCancellation.hidden && closeCancellation.liveStatus === "Cancelled",
    `providerAbortObserved=${closeCancellation.aborted}, panelHidden=${closeCancellation.hidden}, liveStatus='${closeCancellation.liveStatus}'.`
  );

  await page.evaluate(() => {
    localStorage.setItem("__vibbit_mode", "byok");
    localStorage.setItem("__vibbit_provider", "opencode");
    localStorage.setItem("__vibbit_model", "go/hy3");
  });
  await page.click("#gear");
  await page.waitForSelector("#set-mode", { timeout: 10000 });
  await page.selectOption("#set-mode", "byok");
  await page.selectOption("#set-prov", "openai");
  const openAiDefault = await page.locator("#set-model").inputValue();
  await page.selectOption("#set-prov", "openrouter");
  const openRouterModels = await page.locator("#set-model option").evaluateAll((options) => options.map((option) => option.value));
  const openRouterDefault = await page.locator("#set-model").inputValue();
  await page.selectOption("#set-prov", "opencode");
  const openCodeModels = await page.locator("#set-model option").evaluateAll((options) => options.map((option) => option.value));
  const openCodeDefault = await page.locator("#set-model").inputValue();
  pushCheck(
    "09 Provider model presets and defaults",
    openAiDefault === "gpt-5.6-luna"
      && openRouterDefault === "openai/gpt-5.6-luna"
      && openCodeDefault === "go/responses/gpt-5.6-luna"
      && openRouterModels.includes("qwen/qwen3.8-27b")
      && openRouterModels.includes("tencent/hy3")
      && openCodeModels.includes("go/hy3")
      && openCodeModels.includes("go/responses/muse-spark-1.2-contributor"),
    `defaults=${openAiDefault},${openRouterDefault},${openCodeDefault}; openRouter=${openRouterModels.join(",")}; openCode=${openCodeModels.join(",")}.`
  );
  await page.selectOption("#set-prov", "openai");
  await page.selectOption("#set-model", "gpt-5.2");
  await page.fill("#set-key", "smoke-dummy-key");
  await page.click("#save");
  const unsupportedThinkingHidden = await page.locator("#think-harder-wrap").evaluate((element) => element.style.display === "none");
  await page.selectOption("#set-model", "gpt-5.6-luna");
  const supportedThinkingVisible = await page.locator("#think-harder-wrap").evaluate((element) => element.style.display === "inline-flex");
  pushCheck(
    "10 Think harder follows model capability",
    unsupportedThinkingHidden && supportedThinkingVisible,
    `gpt52Hidden=${unsupportedThinkingHidden}, lunaVisible=${supportedThinkingVisible}.`
  );
  await page.waitForTimeout(200);
  await page.click("#back");
  await page.waitForSelector("#go", { timeout: 10000 });
  await page.check("#think-harder");

  await page.fill("#p", "Create a tiny OpenAI byok program");
  await page.click("#go");
  await page.waitForFunction(() => {
    const status = document.querySelector("#status")?.textContent?.trim() || "";
    return ["Done", "Applied, unverified", "Fallback applied", "Error"].includes(status);
  }, { timeout: 30000 });

  const byokGenerationState = await page.evaluate(() => {
    const status = document.querySelector("#status")?.textContent?.trim() || "";
    const pastedCode = window.__smokeMonacoValue || "";
    const logText = document.querySelector("#log")?.textContent || "";
    return {
      status,
      pastedCode,
      logText,
      byokCalls: Number(window.__smokeByokCalls || 0),
      managedCalls: Number(window.__smokeManagedCalls || 0),
      byokUrl: window.__smokeByokUrl,
      byokBody: window.__smokeByokBody
    };
  });
  await page.screenshot({ path: screenshots.byokFeedback, fullPage: false });
  pushCheck(
    "11 OpenAI Responses generation",
    byokGenerationState.status === "Applied, unverified"
      && byokGenerationState.pastedCode.includes("basic.showString(\"BYOK\")")
      && byokGenerationState.byokCalls >= 1
      && byokGenerationState.byokUrl === "https://api.openai.com/v1/responses"
      && byokGenerationState.byokBody?.model === "gpt-5.6-luna"
      && byokGenerationState.byokBody?.max_output_tokens === 16384
      && byokGenerationState.byokBody?.reasoning?.effort === "max",
    `status='${byokGenerationState.status}', byokCalls=${byokGenerationState.byokCalls}, url='${byokGenerationState.byokUrl}', model='${byokGenerationState.byokBody?.model || ""}', reasoning='${byokGenerationState.byokBody?.reasoning?.effort || ""}'.`
  );

  const hasProbeLog = /Live decompile check (passed|unavailable|failed)/i.test(byokGenerationState.logText);
  pushCheck("12 Decompile probe log", hasProbeLog, `logHasProbeMessage=${hasProbeLog}.`);

  await page.click("#gear");
  await page.selectOption("#set-prov", "opencode");
  await page.selectOption("#set-model", "go/hy3");
  await page.fill("#set-key", "smoke-dummy-key");
  await page.click("#save");
  await page.click("#back");
  await page.fill("#p", "Create a tiny OpenCode byok program");
  await page.click("#go");
  await page.waitForFunction(() => Number(window.__smokeByokCalls || 0) >= 2, { timeout: 30000 });
  await page.waitForFunction(() => document.querySelector("#status")?.textContent?.trim() === "Applied, unverified", { timeout: 30000 });
  const openCodeChatState = await page.evaluate(() => ({
    url: window.__smokeByokUrl,
    body: window.__smokeByokBody
  }));
  pushCheck(
    "13 OpenCode Chat Completions generation",
    openCodeChatState.url === "https://opencode.ai/zen/go/v1/chat/completions"
      && openCodeChatState.body?.model === "hy3"
      && openCodeChatState.body?.max_tokens === 16384
      && openCodeChatState.body?.reasoning?.effort === "xhigh",
    `url='${openCodeChatState.url}', model='${openCodeChatState.body?.model || ""}', reasoning='${openCodeChatState.body?.reasoning?.effort || ""}'.`
  );

  await page.click("#gear");
  await page.selectOption("#set-model", "go/responses/muse-spark-1.2-contributor");
  await page.click("#back");
  await page.fill("#p", "Create another tiny byok program");
  await page.click("#go");
  await page.waitForFunction(() => Number(window.__smokeByokCalls || 0) >= 3, { timeout: 30000 });
  await page.waitForFunction(() => document.querySelector("#status")?.textContent?.trim() === "Applied, unverified", { timeout: 30000 });
  const responsesState = await page.evaluate(() => ({
    url: window.__smokeByokUrl,
    body: window.__smokeByokBody,
    code: window.__smokeMonacoValue || ""
  }));
  pushCheck(
    "14 OpenCode Responses generation",
    responsesState.url === "https://opencode.ai/zen/go/v1/responses"
      && responsesState.body?.model === "muse-spark-1.2-contributor"
      && responsesState.body?.max_output_tokens === 16384
      && responsesState.body?.reasoning?.effort === "xhigh"
      && responsesState.code.includes("basic.showString(\"BYOK\")"),
    `url='${responsesState.url}', model='${responsesState.body?.model || ""}', maxOutputTokens=${responsesState.body?.max_output_tokens || 0}.`
  );

  const callsBeforeFallback = await page.evaluate(() => {
    window.__smokeForceInvalid = true;
    return Number(window.__smokeByokCalls || 0);
  });
  await page.fill("#p", "Exercise exhausted validation retries");
  await page.click("#go");
  await page.waitForFunction(() => document.querySelector("#status")?.textContent?.trim() === "Fallback applied", { timeout: 30000 });
  const fallbackState = await page.evaluate(() => ({
    calls: Number(window.__smokeByokCalls || 0),
    code: window.__smokeMonacoValue || "",
    warning: [...document.querySelectorAll(".vibbit-msg-error")].map((node) => node.textContent || "").join(" ")
  }));
  pushCheck(
    "15 Exhausted retries expose fallback outcome",
    fallbackState.calls === callsBeforeFallback + 3
      && fallbackState.code === 'basic.showString("Hi")'
      && /minimal fallback was applied/i.test(fallbackState.warning),
    `calls=${fallbackState.calls - callsBeforeFallback}, code='${fallbackState.code}', warning=${/minimal fallback was applied/i.test(fallbackState.warning)}.`
  );
}

async function runHostedUiSmoke(browser) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  try {
    await page.addInitScript(() => {
      try {
        localStorage.clear();
        sessionStorage.clear();
      } catch {
        // Ignore storage access errors.
      }
    });
    await page.goto("https://makecode.microbit.org/", { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForTimeout(3000);

    const hostedRuntime = await readFile(path.join(repoRoot, "dist", "content-script.js"), "utf8");
    await page.addScriptTag({ content: hostedRuntime });
    await page.waitForSelector("#vibbit-panel", { state: "attached", timeout: 20000 });
    await page.evaluate(() => {
      const backdrop = document.querySelector("#vibbit-backdrop");
      const panel = document.querySelector("#vibbit-panel");
      if (backdrop) {
        backdrop.style.display = "flex";
        backdrop.dataset.active = "true";
      }
      if (panel) panel.style.display = "flex";
    });
    await page.waitForSelector("#setup-go", { timeout: 20000 });
    await page.screenshot({ path: screenshots.hostedPanel, fullPage: false });

    const hostedSetup = await page.evaluate(() => {
      const mode = document.querySelector("#setup-mode");
      const modeRow = document.querySelector("#setup-mode-row");
      const byokProvider = document.querySelector("#setup-byok-provider");
      const managedServerUrl = document.querySelector("#setup-managed-server-url");
      const classCode = document.querySelector("#setup-class-code");
      return {
        modeValue: mode ? mode.value : "",
        modeRowHidden: modeRow ? getComputedStyle(modeRow).display === "none" : false,
        byokHidden: byokProvider ? getComputedStyle(byokProvider).display === "none" : false,
        serverUrlHidden: managedServerUrl ? getComputedStyle(managedServerUrl).display === "none" : false,
        classCodeVisible: classCode ? getComputedStyle(classCode).display !== "none" : false
      };
    });
    pushCheck(
      "16 Hosted-managed UI is code-only",
      hostedSetup.modeValue === "managed"
        && hostedSetup.modeRowHidden
        && hostedSetup.byokHidden
        && hostedSetup.serverUrlHidden
        && hostedSetup.classCodeVisible,
      `mode=${hostedSetup.modeValue}, modeRowHidden=${hostedSetup.modeRowHidden}, serverUrlHidden=${hostedSetup.serverUrlHidden}.`
    );

    await installFetchMock(page);
    await page.fill("#setup-class-code", "HOSTEDCODE");
    await page.click("#setup-go");
    await page.waitForSelector("#go", { timeout: 20000 });
    const hostedJoin = await page.evaluate(() => ({
      connectCalls: Number(window.__smokeConnectCalls || 0),
      badge: document.querySelector("#classroom-badge")?.textContent || ""
    }));
    pushCheck(
      "17 Hosted join verifies classroom code",
      hostedJoin.connectCalls === 1 && hostedJoin.badge.includes("Smoke Classroom"),
      `connectCalls=${hostedJoin.connectCalls}, badge='${hostedJoin.badge}'.`
    );
  } finally {
    await page.close();
  }
}

async function runSmokeUi() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  try {
    await page.addInitScript(() => {
      try {
        localStorage.clear();
        sessionStorage.clear();
      } catch {
        // Ignore storage access errors.
      }
    });

    await page.goto("https://makecode.microbit.org/", { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForTimeout(5000);
    await page.screenshot({ path: screenshots.makecode, fullPage: false });
    pushCheck("01 MakeCode loads", true, `Screenshot saved at \`${screenshots.makecode}\`.`);

    await runNeutralUiSmoke(page);
    await runHostedUiSmoke(browser);
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
  screenshots.managedFeedback,
  screenshots.byokFeedback,
  screenshots.hostedPanel
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
  `- Neutral source: \`${path.join(repoRoot, "work.js")}\``,
  `- Hosted package: \`${path.join(repoRoot, "dist", "content-script.js")}\``,
  "",
  "## Outcome",
  "",
  overallPass ? "PASS" : "FAIL"
].join("\n");

await writeText(reportPath, report + "\n");

console.log(`SUMMARY: ${overallPass ? "PASS" : "FAIL"}`);
console.log(`ARTEFACT_DIR: ${runDir}`);
console.log(`REPORT: ${reportPath}`);
console.log(`SCREENSHOTS: ${Object.values(screenshots).slice(0, 7).join(",")}`);

if (!overallPass) {
  process.exitCode = 1;
}
