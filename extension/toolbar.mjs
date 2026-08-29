const MAKECODE_HOSTS = new Set([
  "makecode.microbit.org",
  "arcade.makecode.com",
  "maker.makecode.com"
]);
const RUNTIME_API_VERSION = "2";

export function isMakeCodeUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" && MAKECODE_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

export async function currentDocument(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "ISOLATED",
    func: () => location.href
  });
  return results?.[0] || null;
}

export async function togglePageUi(tabId, { includeBridge = true } = {}) {
  if (includeBridge) {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      files: ["page-bridge.js"]
    });
  }

  const [state] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => ({
      panel: Boolean(document.getElementById("vibbit-panel")),
      runtimeVersion: String(window.__vibbit?.version || "")
    })
  });
  const staleRuntime = state?.result?.runtimeVersion !== RUNTIME_API_VERSION;
  if (staleRuntime) {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        if (typeof window.__vibbit?.destroy === "function") {
          window.__vibbit.destroy();
          return;
        }
        for (const id of ["vibbit-panel", "vibbit-backdrop", "vibbit-preview-bar", "vibbit-fab", "vibbit-runtime-style"]) {
          document.getElementById(id)?.remove();
        }
        delete window.__vibbit;
        window.__vibbitStrict = 0;
      }
    });
  }
  if (staleRuntime || !state?.result?.panel) {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      files: ["content-script.js"]
    });
  }
  const [toggled] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: (expectedVersion) => {
      const runtime = window.__vibbit;
      if (String(runtime?.version || "") !== expectedVersion || typeof runtime.toggle !== "function") return false;
      runtime.toggle();
      return true;
    },
    args: [RUNTIME_API_VERSION]
  });
  return toggled?.result === true;
}
