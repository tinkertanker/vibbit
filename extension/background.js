import { createByokBroker, publicBrokerError } from "./byok-broker.mjs";

const MAKECODE_HOSTS = new Set([
  "makecode.microbit.org",
  "arcade.makecode.com",
  "maker.makecode.com"
]);
const ARM_STORAGE_KEY = "vibbitByokArmsV1";
const ARM_TTL_MS = 15 * 60 * 1000;
const MAX_GENERATIONS_PER_ARM = 10;
const REQUEST_TIMEOUT_MS = 120000;
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,80}$/;
const activeRequests = new Map();

const broker = createByokBroker({ storageArea: chrome.storage.session });

const accessLevelTask = chrome.storage.session.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" });
if (accessLevelTask?.catch) accessLevelTask.catch(() => {});

function isMakeCodeUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" && MAKECODE_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

function isExtensionPage(sender) {
  const extensionOrigin = `chrome-extension://${chrome.runtime.id}/`;
  return sender.id === chrome.runtime.id
    && String(sender.url || "").startsWith(extensionOrigin)
    && (!sender.tab || String(sender.tab.url || "").startsWith(extensionOrigin));
}

function isTrustedPageSender(sender) {
  return sender.id === chrome.runtime.id
    && sender.frameId === 0
    && Number.isInteger(sender.tab?.id)
    && isMakeCodeUrl(sender.tab.url);
}

async function readArms() {
  const stored = await chrome.storage.session.get(ARM_STORAGE_KEY);
  const source = stored?.[ARM_STORAGE_KEY];
  return source && typeof source === "object" ? source : {};
}

async function writeArms(arms) {
  await chrome.storage.session.set({ [ARM_STORAGE_KEY]: arms });
}

async function armTab(tabId, documentId, url) {
  if (!documentId) return false;
  const arms = await readArms();
  arms[String(tabId)] = {
    documentId: String(documentId),
    url: String(url || ""),
    expiresAt: Date.now() + ARM_TTL_MS,
    remaining: MAX_GENERATIONS_PER_ARM
  };
  await writeArms(arms);
  return true;
}

async function getArm(sender, { consume = false } = {}) {
  const tabId = sender.tab?.id;
  if (!Number.isInteger(tabId)) return null;
  const arms = await readArms();
  const arm = arms[String(tabId)];
  const documentMatches = Boolean(arm?.documentId && sender.documentId)
    && arm.documentId === String(sender.documentId);
  const valid = arm
    && documentMatches
    && arm.url === String(sender.tab.url || "")
    && Number(arm.expiresAt) > Date.now()
    && Number(arm.remaining) > 0;
  if (!valid) {
    if (arm) {
      delete arms[String(tabId)];
      await writeArms(arms);
    }
    return null;
  }
  if (consume) {
    arm.remaining = Number(arm.remaining) - 1;
    arm.expiresAt = Date.now() + ARM_TTL_MS;
    await writeArms(arms);
  }
  return { ...arm };
}

async function currentDocument(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "ISOLATED",
    func: () => location.href
  });
  return results?.[0] || null;
}

async function togglePageUi(tabId) {
  let state = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => ({
      panel: Boolean(document.getElementById("vibbit-panel")),
      visible: document.getElementById("vibbit-panel")?.style.display !== "none"
    })
  });
  if (!state?.[0]?.result?.panel) {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      files: ["content-script.js"]
    });
    state = [{ result: { panel: true, visible: false } }];
  }
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => {
      const panel = document.getElementById("vibbit-panel");
      const backdrop = document.getElementById("vibbit-backdrop");
      const fab = document.getElementById("vibbit-fab");
      const shouldOpen = !panel || panel.style.display === "none" || backdrop?.style.display === "none";
      if (backdrop) {
        backdrop.style.display = shouldOpen ? "flex" : "none";
        backdrop.dataset.active = shouldOpen ? "true" : "";
      }
      if (panel) panel.style.display = "flex";
      if (fab) fab.style.display = "none";
    }
  });
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!Number.isInteger(tab.id) || !isMakeCodeUrl(tab.url)) return;
  const injection = await currentDocument(tab.id);
  if (!await armTab(tab.id, injection?.documentId || "", tab.url)) return;
  await togglePageUi(tab.id);
});

function activeKey(sender) {
  return `${sender.tab?.id || 0}:${String(sender.documentId || "")}`;
}

async function handleExtensionMessage(message) {
  if (message.type === "vibbit:byok:config:get") return { ok: true, value: await broker.publicConfig() };
  if (message.type === "vibbit:byok:config:save") return { ok: true, value: await broker.saveConfig(message.payload) };
  if (message.type === "vibbit:byok:key:clear") return { ok: true, value: await broker.clearKey(message.payload?.provider) };
  if (message.type === "vibbit:byok:clear-all") return { ok: true, value: await broker.clearAll() };
  return { ok: false, error: { code: "unknown_operation", status: 0 } };
}

async function handlePageMessage(message, sender) {
  if (message.type === "vibbit:byok:open-options") {
    if (!await getArm(sender)) {
      return { ok: false, error: { code: "tab_not_armed", status: 0 } };
    }
    await chrome.runtime.openOptionsPage();
    return { ok: true, value: null };
  }
  if (message.type === "vibbit:byok:status") {
    const [config, arm] = await Promise.all([broker.publicConfig(), getArm(sender)]);
    return { ok: true, value: { ...config, armed: Boolean(arm), remaining: arm?.remaining || 0 } };
  }
  const requestId = String(message.requestId || "");
  if (!REQUEST_ID_RE.test(requestId)) {
    return { ok: false, error: { code: "invalid_request_id", status: 0 } };
  }
  const key = activeKey(sender);
  if (message.type === "vibbit:byok:cancel") {
    const active = activeRequests.get(key);
    if (active?.requestId === requestId) active.controller.abort();
    return { ok: true, value: null };
  }
  if (message.type !== "vibbit:byok:generate") {
    return { ok: false, error: { code: "unknown_operation", status: 0 } };
  }
  if (activeRequests.has(key)) {
    return { ok: false, error: { code: "request_in_progress", status: 0 } };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  activeRequests.set(key, { requestId, controller });
  try {
    const arm = await getArm(sender, { consume: true });
    if (!arm) {
      return { ok: false, error: { code: "tab_not_armed", status: 0 } };
    }
    const pageUrl = new URL(sender.tab.url);
    const value = await broker.generate(message.payload, {
      signal: controller.signal,
      pageOrigin: pageUrl.origin
    });
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: publicBrokerError(error) };
  } finally {
    clearTimeout(timeout);
    const active = activeRequests.get(key);
    if (active?.requestId === requestId) activeRequests.delete(key);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const input = message && typeof message === "object" ? message : {};
  let task;
  if (isExtensionPage(sender)) task = handleExtensionMessage(input);
  else if (isTrustedPageSender(sender)) task = handlePageMessage(input, sender);
  else task = Promise.resolve({ ok: false, error: { code: "unauthorized_sender", status: 0 } });
  task.then(sendResponse).catch(() => {
    sendResponse({ ok: false, error: { code: "internal_error", status: 0 } });
  });
  return true;
});
