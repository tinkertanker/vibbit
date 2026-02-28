const BACKEND = "https://vibbit.dev.tk.sg";
const APP_TOKEN = ""; // set only if your server enforces SERVER_APP_TOKEN

(function () {
  const existingRuntime = window.__vibbit;
  if (existingRuntime && typeof existingRuntime.reinvoke === "function") {
    const handled = existingRuntime.reinvoke();
    if (handled !== false) return;
  }
  if (window.__vibbitStrict) return;
  window.__vibbitStrict = 1;

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitWithAbort = (ms, signal) => {
    if (!signal) return wait(ms);
    if (signal.aborted) return Promise.reject(createAbortError());
    return new Promise((resolve, reject) => {
      let done = false;
      let timer = 0;
      const onAbort = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        reject(createAbortError());
      };
      timer = setTimeout(() => {
        if (done) return;
        done = true;
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  };

  const STORAGE_MODE = "__vibbit_mode";
  const STORAGE_KEY_PREFIX = "__vibbit_key_";
  const STORAGE_PROVIDER = "__vibbit_provider";
  const STORAGE_MODEL = "__vibbit_model";
  const STORAGE_SETUP_DONE = "__vibbit_setup_done";
  const STORAGE_SERVER = "__vibbit_server";
  const STORAGE_TARGET = "__vibbit_target";
  const STORAGE_CHAT_HISTORY = "__vibbit_chat_history_v1";
  const STORAGE_CLASS_CODE = "__vibbit_class_code";
  const STORAGE_MANAGED_SESSION = "__vibbit_managed_session";
  const STORAGE_MANAGED_SESSION_EXPIRES = "__vibbit_managed_session_expires";

  const MODEL_PRESETS = {
    openai: [
      { id: "gpt-5-mini", label: "GPT-5 Mini" },
      { id: "gpt-5.2", label: "GPT-5.2", default: true }
    ],
    gemini: [
      { id: "gemini-3-flash-preview", label: "Gemini 3 Flash", default: true },
      { id: "gemini-3-pro-preview", label: "Gemini 3 Pro" },
      { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro (Preview)" }
    ],
    openrouter: [
      { id: "deepseek/deepseek-v3.2", label: "DeepSeek V3.2", default: true },
      { id: "google/gemini-3-flash-preview", label: "Gemini 3 Flash" },
      { id: "google/gemini-2.5-flash-lite-preview-09-2025", label: "Gemini 2.5 Flash Lite (Preview)" },
      { id: "openai/gpt-5.2", label: "GPT-5.2" },
      { id: "minimax/minimax-m2.5", label: "MiniMax M2.5" }
    ]
  };

  const storageGet = (key) => {
    try {
      const value = localStorage.getItem(key);
      if (value !== null) return value;
    } catch (error) {
    }
    return null;
  };

  const storageSet = (key, value) => {
    try {
      localStorage.setItem(key, value);
    } catch (error) {
    }
  };

  const storageRemove = (key) => {
    try {
      localStorage.removeItem(key);
    } catch (error) {
    }
  };

  const keyStorageForProvider = (provider) => STORAGE_KEY_PREFIX + (provider || "openai");

  const getStoredProviderKey = (provider) => storageGet(keyStorageForProvider(provider)) || "";

  const setStoredProviderKey = (provider, value) => {
    const normalized = String(value || "").trim();
    const key = keyStorageForProvider(provider);
    if (normalized) storageSet(key, normalized);
    else storageRemove(key);
  };

  const bookmarkletConfig = window.__vibbitBookmarkletConfig && typeof window.__vibbitBookmarkletConfig === "object"
    ? window.__vibbitBookmarkletConfig
    : {};
  const enableManagedMode = bookmarkletConfig.enableManaged !== false;
  const enableByokMode = bookmarkletConfig.enableByok !== false;
  const configuredForceMode = String(bookmarkletConfig.forceMode || "").trim().toLowerCase();
  const modeFlags = {
    managed: enableManagedMode,
    byok: enableByokMode
  };
  if (!modeFlags.managed && !modeFlags.byok) modeFlags.managed = true;
  if (configuredForceMode === "managed" || configuredForceMode === "byok") {
    modeFlags[configuredForceMode] = true;
  }
  const fallbackMode = modeFlags.managed ? "managed" : "byok";
  const forceMode = modeFlags[configuredForceMode] ? configuredForceMode : "";
  const coerceMode = (value) => {
    const normalized = String(value || "").trim().toLowerCase();
    if (normalized === "managed" && modeFlags.managed) return "managed";
    if (normalized === "byok" && modeFlags.byok) return "byok";
    if (forceMode) return forceMode;
    return fallbackMode;
  };

  /* ── shared styles ───────────────────────────────────────── */
  const S_LABEL = "font-size:11px;color:#9eb2ff;text-transform:uppercase;letter-spacing:0.08em";
  const S_SELECT = "width:100%;padding:8px;border-radius:8px;border:1px solid #29324e;background:#0b1020;color:#e6e8ef;cursor:pointer";
  const S_INPUT = "width:100%;padding:8px;border-radius:8px;border:1px solid #29324e;background:#0b1020;color:#e6e8ef;box-sizing:border-box";
  const S_BTN_PRIMARY = "width:100%;padding:10px;border:none;border-radius:8px;background:#3b82f6;color:#fff;font-weight:600;cursor:pointer;font-size:13px";
  const S_ICON_BTN = "background:transparent;border:none;color:#93a4c4;cursor:pointer;padding:4px;display:flex;align-items:center";
  const CLOSE_SVG = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M1 1l12 12M13 1L1 13"/></svg>';
  const FROG_MARK_DATA_URI = "__VIBBIT_FROG_MARK_DATA_URI__";
  const FROG_MARK_FALLBACK_SVG = '<svg width="128" height="128" viewBox="0 0 128 128" fill="none" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="frog-gradient" x1="20" y1="22" x2="108" y2="108" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#34D399"/><stop offset="1" stop-color="#16A34A"/></linearGradient><mask id="frog-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="128" height="128"><rect width="128" height="128" fill="black"/><g transform="translate(64 64) scale(1.2) translate(-64 -64)"><g fill="white"><circle cx="64" cy="68" r="36"/><circle cx="44" cy="38" r="15.4"/><circle cx="84" cy="38" r="15.4"/><path d="M25 104C25 90 31 84 40 84C49 84 55 90 55 104Z"/><path d="M73 104C73 90 79 84 88 84C97 84 103 90 103 104Z"/></g><circle cx="44" cy="38" r="5.5" fill="black"/><circle cx="84" cy="38" r="5.5" fill="black"/><path d="M55 104C55 98 59 93 64 93C69 93 73 98 73 104Z" fill="black"/><path d="M64 44.7L69 55.5L79.8 61.3L69 67.1L64 77.9L59 67.1L48.2 61.3L59 55.5L64 44.7Z" fill="black"/></g></mask></defs><rect width="128" height="128" fill="url(#frog-gradient)" mask="url(#frog-mask)"/></svg>';
  const encodeSvgDataUri = (svgMarkup) => "data:image/svg+xml," + encodeURIComponent(svgMarkup.replace(/\s+/g, " ").trim());
  // When running raw work.js (without the build step), use the embedded fallback icon.
  const FROG_MARK_URL = FROG_MARK_DATA_URI.indexOf("data:image/svg+xml") === 0
    ? FROG_MARK_DATA_URI
    : encodeSvgDataUri(FROG_MARK_FALLBACK_SVG);
  const frogMarkImgHtml = (size) => {
    if (!FROG_MARK_URL) return "";
    return '<img alt="" aria-hidden="true" src="' + FROG_MARK_URL + '" style="display:block;width:' + size + 'px;height:' + size + 'px">';
  };
  const SETUP_HEADER_FROG_MARK = frogMarkImgHtml(14);
  const MAIN_HEADER_FROG_MARK = frogMarkImgHtml(14);
  const FAB_FROG_MARK = frogMarkImgHtml(26.4);

  /* ── backdrop + modal container ──────────────────────────── */
  const backdrop = document.createElement("div");
  backdrop.id = "vibbit-backdrop";
  backdrop.style.cssText = "position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(6,10,24,.62);backdrop-filter:blur(3px);z-index:2147483646;transition:opacity .2s ease";

  const ui = document.createElement("div");
  ui.id = "vibbit-panel";
  ui.setAttribute("role", "dialog");
  ui.setAttribute("aria-modal", "true");
  ui.setAttribute("aria-labelledby", "vibbit-dialog-title");
  ui.style.cssText = "width:680px;max-width:calc(100vw - 48px);max-height:80vh;background:#0b1020;color:#e6e8ef;font-family:system-ui,Segoe UI,Arial,sans-serif;border:1px solid #21304f;border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.5);display:flex;flex-direction:column;overflow:hidden";

  /* ── build HTML ──────────────────────────────────────────── */
  ui.innerHTML = ""
    + '<h2 id="vibbit-dialog-title" style="position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0">Vibbit</h2>'
    /* ═══ VIEW 1: SETUP ═══ */
    + '<div id="bv-setup" style="display:none;flex-direction:column">'

    /* header */
    + '<div id="h-setup" style="display:flex;align-items:center;padding:12px 16px;background:#111936;border-bottom:1px solid #21304f">'
    + '  <span style="display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;margin-right:8px">' + SETUP_HEADER_FROG_MARK + '</span>'
    + '  <span style="font-weight:600;font-size:14px">Vibbit</span>'
    + '  <button id="x-setup" aria-label="Close" style="margin-left:auto;' + S_ICON_BTN + '">' + CLOSE_SVG + '</button>'
    + '</div>'

    /* body */
    + '<div style="padding:20px 18px;display:grid;gap:14px">'
    + '  <div style="font-size:16px;font-weight:600;color:#e6e8ef">Welcome to Vibbit</div>'

    /* mode */
    + '  <div id="setup-mode-row" style="display:grid;gap:4px">'
    + '    <div style="' + S_LABEL + '">Mode</div>'
    + '    <select id="setup-mode" style="' + S_SELECT + '">'
    + '      <option value="byok">Bring your own key</option>'
    + '      <option value="managed">Managed (school account)</option>'
    + '    </select>'
    + '  </div>'

    /* BYOK: provider */
    + '  <div id="setup-byok-provider" style="display:grid;gap:4px">'
    + '    <div style="' + S_LABEL + '">Provider</div>'
    + '    <select id="setup-prov" style="' + S_SELECT + '">'
    + '      <option value="openai">OpenAI</option>'
    + '      <option value="gemini">Gemini</option>'
    + '      <option value="openrouter">OpenRouter</option>'
    + '    </select>'
    + '  </div>'

    /* BYOK: model */
    + '  <div id="setup-byok-model" style="display:grid;gap:4px">'
    + '    <div style="' + S_LABEL + '">Model</div>'
    + '    <select id="setup-model" style="' + S_SELECT + '"></select>'
    + '  </div>'

    /* BYOK: API key */
    + '  <div id="setup-byok-key" style="display:grid;gap:4px">'
    + '    <div style="' + S_LABEL + '">API Key</div>'
    + '    <input id="setup-key" type="password" placeholder="Paste your API key" style="' + S_INPUT + '">'
    + '  </div>'

    /* Managed: server URL */
    + '  <div id="setup-managed-server" style="display:none">'
    + '    <div style="display:grid;gap:4px">'
    + '      <div style="' + S_LABEL + '">Server URL</div>'
    + '      <input id="setup-server" placeholder="vibbit.tk.sg" style="' + S_INPUT + '">'
    + '    </div>'
    + '    <div style="display:grid;gap:4px;margin-top:8px">'
    + '      <div style="' + S_LABEL + '">Class Code</div>'
    + '      <input id="setup-class-code" placeholder="From your teacher" style="' + S_INPUT + '">'
    + '    </div>'
    + '  </div>'

    /* get started */
    + '  <button id="setup-go" style="' + S_BTN_PRIMARY + ';margin-top:4px">Get Started</button>'
    + '</div>'
    + '</div>'

    /* ═══ VIEW 2: MAIN (chat layout) ═══ */
    + '<div id="bv-main" style="display:none;flex-direction:column;height:80vh;max-height:80vh">'

    /* header */
    + '<div id="h-main" style="display:flex;align-items:center;padding:12px 16px;background:#111936;border-bottom:1px solid #21304f;flex-shrink:0">'
    + '  <span style="display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;margin-right:8px">' + MAIN_HEADER_FROG_MARK + '</span>'
    + '  <span style="font-weight:600;font-size:14px">Vibbit</span>'
    + '  <span id="busy-indicator" aria-hidden="true" style="margin-left:8px;display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;opacity:0;visibility:hidden;transition:opacity .15s ease;">'
    + '    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="#9bb1dd" stroke-width="1.5" style="animation:vibbit-spin .9s linear infinite">'
    + '      <circle cx="7" cy="7" r="5" stroke-opacity=".25"></circle>'
    + '      <path d="M7 2a5 5 0 0 1 5 5" stroke-linecap="round"></path>'
    + '    </svg>'
    + '  </span>'
    + '  <span id="status" style="display:none">Idle</span>'
    + '  <button id="gear" aria-label="Settings" style="margin-left:auto;' + S_ICON_BTN + '"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M9.405 1.05c-.413-1.4-2.397-1.4-2.81 0l-.1.34a1.464 1.464 0 01-2.105.872l-.31-.17c-1.283-.698-2.686.705-1.987 1.987l.17.31a1.464 1.464 0 01-.872 2.105l-.34.1c-1.4.413-1.4 2.397 0 2.81l.34.1a1.464 1.464 0 01.872 2.105l-.17.31c-.698 1.283.705 2.686 1.987 1.987l.31-.17a1.464 1.464 0 012.105.872l.1.34c.413 1.4 2.397 1.4 2.81 0l.1-.34a1.464 1.464 0 012.105-.872l.31.17c1.283.698 2.686-.705 1.987-1.987l-.17-.31a1.464 1.464 0 01.872-2.105l.34-.1c1.4-.413 1.4-2.397 0-2.81l-.34-.1a1.464 1.464 0 01-.872-2.105l.17-.31c.698-1.283-.705-2.686-1.987-1.987l-.31.17a1.464 1.464 0 01-2.105-.872zM8 10.93a2.929 2.929 0 110-5.86 2.929 2.929 0 010 5.858z"/></svg></button>'
    + '  <button id="x-main" aria-label="Close" style="margin-left:6px;' + S_ICON_BTN + '">' + CLOSE_SVG + '</button>'
    + '</div>'

    /* chat messages area */
    + '<div id="chat-messages" style="flex:1;overflow-y:auto;padding:20px 18px;display:flex;flex-direction:column;gap:12px"></div>'

    /* input area */
    + '<div style="flex-shrink:0;border-top:1px solid #1f2b47;padding:12px 16px;background:#0d1528">'
    + '  <textarea id="p" rows="2" aria-label="Describe what you want the block code to do" placeholder="Describe what you want the block code to do\u2026" style="width:100%;resize:none;min-height:44px;max-height:120px;padding:10px 12px;border-radius:10px;border:1px solid #29324e;background:#0b1020;color:#e6e8ef;font-size:13px;line-height:1.4;box-sizing:border-box;font-family:inherit"></textarea>'
    + '  <div style="display:flex;align-items:center;justify-content:flex-end;margin-top:8px">'
    + '    <div style="display:flex;gap:8px;align-items:center">'
    + '      <button id="new-chat-btn" aria-label="Start a new chat" style="display:none;padding:6px 14px;border:1px solid #29324e;border-radius:8px;background:transparent;color:#8899bb;font-size:12px;font-weight:500;cursor:pointer">New</button>'
    + '      <button id="go" aria-label="Send message" style="padding:8px 20px;border:none;border-radius:8px;background:#3454D1;color:#fff;font-weight:600;cursor:pointer;font-size:13px;display:flex;align-items:center;gap:6px">Send <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg></button>'
    + '    </div>'
    + '  </div>'

    /* collapsible log */
    + '  <div style="margin-top:8px;padding-top:6px;border-top:1px solid #1a2340">'
    + '    <button id="logToggle" aria-expanded="false" style="background:transparent;border:none;color:#5a6d8f;font-size:10px;cursor:pointer;padding:0;line-height:1.2">Show logs</button>'
    + '    <div id="log" style="margin-top:6px;padding:6px 8px;font-size:10px;line-height:1.2;color:#7088ad;display:none;max-height:100px;overflow:auto;background:#080e1e;border:1px solid #1a2540;border-radius:6px"></div>'
    + '  </div>'
    + '</div>'
    + '</div>'

    /* ═══ VIEW 3: SETTINGS ═══ */
    + '<div id="bv-settings" style="display:none;flex-direction:column">'

    /* header */
    + '<div id="h-settings" style="display:flex;align-items:center;padding:12px 16px;background:#111936;border-bottom:1px solid #21304f">'
    + '  <button id="back" aria-label="Back" style="' + S_ICON_BTN + ';margin-right:6px"><svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 1L3 7l6 6"/></svg></button>'
    + '  <span style="font-weight:600;font-size:14px">Settings</span>'
    + '  <button id="x-settings" aria-label="Close" style="margin-left:auto;' + S_ICON_BTN + '">' + CLOSE_SVG + '</button>'
    + '</div>'

    /* body */
    + '<div style="padding:16px 18px;display:grid;gap:12px">'

    /* mode */
    + '  <div id="set-mode-row" style="display:grid;gap:4px">'
    + '    <div style="' + S_LABEL + '">Mode</div>'
    + '    <select id="set-mode" style="' + S_SELECT + '">'
    + '      <option value="byok">Bring your own key</option>'
    + '      <option value="managed">Managed (school account)</option>'
    + '    </select>'
    + '  </div>'

    /* BYOK: provider */
    + '  <div id="set-byok-provider" style="display:grid;gap:4px">'
    + '    <div style="' + S_LABEL + '">Provider</div>'
    + '    <select id="set-prov" style="' + S_SELECT + '">'
    + '      <option value="openai">OpenAI</option>'
    + '      <option value="gemini">Gemini</option>'
    + '      <option value="openrouter">OpenRouter</option>'
    + '    </select>'
    + '  </div>'

    /* BYOK: model */
    + '  <div id="set-byok-model" style="display:grid;gap:4px">'
    + '    <div style="' + S_LABEL + '">Model</div>'
    + '    <select id="set-model" style="' + S_SELECT + '"></select>'
    + '  </div>'

    /* BYOK: API key */
    + '  <div id="set-byok-key" style="display:grid;gap:4px">'
    + '    <div style="' + S_LABEL + '">API Key</div>'
    + '    <div style="display:flex;gap:8px">'
    + '      <input id="set-key" type="password" placeholder="API key" style="flex:1;padding:8px;border-radius:8px;border:1px solid #29324e;background:#0b1020;color:#e6e8ef">'
    + '      <button id="save" style="padding:8px 12px;border:none;border-radius:8px;background:#16a34a;color:#fff;font-weight:600;cursor:pointer;white-space:nowrap">Save Key</button>'
    + '    </div>'
    + '  </div>'

    /* Managed: server URL */
    + '  <div id="set-managed-server" style="display:none">'
    + '    <div style="display:grid;gap:4px">'
    + '      <div style="' + S_LABEL + '">Server URL</div>'
    + '      <input id="set-server" placeholder="vibbit.tk.sg" style="' + S_INPUT + '">'
    + '    </div>'
    + '    <div style="display:grid;gap:4px;margin-top:8px">'
    + '      <div style="' + S_LABEL + '">Class Code</div>'
    + '      <input id="set-class-code" placeholder="From your teacher" style="' + S_INPUT + '">'
    + '    </div>'
    + '  </div>'

    /* advanced (collapsible) */
    + '  <details id="set-advanced">'
    + '    <summary style="cursor:pointer;font-size:12px;color:#9eb2ff;font-weight:500;user-select:none">Advanced</summary>'
    + '    <div style="display:grid;gap:4px;margin-top:8px">'
    + '      <div style="' + S_LABEL + '">Target</div>'
    + '      <select id="set-target" style="' + S_SELECT + '">'
    + '        <option value="microbit">micro:bit</option>'
    + '        <option value="arcade">Arcade</option>'
    + '        <option value="maker">Maker</option>'
    + '      </select>'
    + '    </div>'
    + '  </details>'

    + '</div>'
    + '</div>';

  backdrop.appendChild(ui);

  /* ── preview bar (shown when modal dismissed for preview) ── */
  const previewBar = document.createElement("div");
  previewBar.id = "vibbit-preview-bar";
  previewBar.style.cssText = "position:fixed;bottom:20px;left:50%;transform:translateX(-50%);display:none;align-items:center;gap:10px;padding:8px 14px;border-radius:999px;background:rgba(10,17,35,.94);border:1px solid #21304f;box-shadow:0 6px 24px rgba(0,0,0,.45);z-index:2147483646";
  previewBar.innerHTML = ""
    + '<button id="preview-return" aria-label="Return to Vibbit" style="padding:6px 16px;border:none;border-radius:999px;background:#3454D1;color:#fff;font-size:12px;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:6px">'
    + '  <svg aria-hidden="true" width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 1L3 7l6 6"/></svg>'
    + '  Return to Vibbit'
    + '</button>'
    + '<button id="preview-new" aria-label="Start a new chat" style="padding:6px 14px;border:1px solid #29324e;border-radius:999px;background:transparent;color:#8899bb;font-size:12px;font-weight:500;cursor:pointer">New Chat</button>';

  /* hidden elements for backwards-compat refs */
  const hiddenCompat = document.createElement("div");
  hiddenCompat.style.display = "none";
  hiddenCompat.innerHTML = '<div id="activity"></div><div id="fb"><div id="fbLines"></div><button id="fbToggle"></button></div><button id="fix-convert"></button><button id="revert"></button>';
  ui.appendChild(hiddenCompat);

  const runtimeStyle = document.createElement("style");
  runtimeStyle.textContent = [
    "@keyframes vibbit-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}",
    "@keyframes vibbit-msg-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}",
    "#vibbit-backdrop{opacity:0;transition:opacity .2s ease}",
    "#vibbit-backdrop[data-active='true']{opacity:1}",
    "#vibbit-preview-bar button:hover{filter:brightness(1.15)}",
    ".vibbit-msg{animation:vibbit-msg-in .25s ease}",
    ".vibbit-msg-user{display:flex;justify-content:flex-end}",
    ".vibbit-msg-user>div{max-width:85%;padding:10px 14px;border-radius:14px 14px 4px 14px;background:#3454D1;color:#fff;font-size:13px;line-height:1.5;word-break:break-word}",
    ".vibbit-msg-assistant{display:flex;justify-content:flex-start}",
    ".vibbit-msg-assistant>div{max-width:90%;padding:12px 14px;border-radius:14px 14px 14px 4px;background:#141e38;border:1px solid #1f2d4d;color:#e0e6f0;font-size:13px;line-height:1.55;word-break:break-word}",
    ".vibbit-msg-assistant .vibbit-feedback-line{padding:6px 10px;margin-top:6px;border-left:3px solid #3b82f6;border-radius:4px;background:rgba(59,130,246,0.1);color:#c5d6ff;font-size:12px;line-height:1.4}",
    ".vibbit-msg-assistant .vibbit-msg-status{color:#7088ad;font-size:12px;display:flex;align-items:center;gap:6px}",
    ".vibbit-msg-assistant .vibbit-msg-success{color:#89e6a3;font-size:12px;font-weight:500;margin-top:8px;display:flex;align-items:center;gap:6px}",
    ".vibbit-msg-assistant .vibbit-msg-error{color:#fda4af;font-size:12px;margin-top:8px}",
    ".vibbit-msg-assistant .vibbit-msg-actions{display:flex;gap:8px;margin-top:10px}",
    ".vibbit-msg-assistant .vibbit-msg-actions button{padding:5px 14px;border-radius:8px;font-size:12px;font-weight:500;cursor:pointer;transition:filter .1s}",
    ".vibbit-msg-assistant .vibbit-msg-actions button:hover{filter:brightness(1.15)}",
    ".vibbit-btn-preview{border:none;background:#3454D1;color:#fff}",
    ".vibbit-btn-undo{border:1px solid #29324e;background:transparent;color:#8899bb}",
    ".vibbit-btn-fix{border:1px solid #d97706;background:rgba(217,119,6,0.15);color:#fbbf24}",
    ".vibbit-btn-cancel{border:1px solid #dc2626;background:rgba(220,38,38,0.18);color:#fecaca}",
    ".vibbit-empty-state{display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1;gap:14px;color:#4a5f82;padding:40px 20px;text-align:center;user-select:none}"
  ].join("\n");
  /* ── FAB ─────────────────────────────────────────────────── */
  const fab = document.createElement("div");
  fab.id = "vibbit-fab";
  fab.title = "Vibbit \u2013 AI code generator";
  fab.style.cssText = "position:fixed;right:20px;bottom:68px;width:44px;height:44px;border-radius:5px;background:#3454D1;display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 4px 14px rgba(52,84,209,.45);z-index:2147483646;transition:transform .15s ease,box-shadow .15s ease;border:none;";
  fab.innerHTML = FAB_FROG_MARK;
  fab.onmouseenter = function () { fab.style.background = "var(--secondary-background-color-hover, #2f4bc0)"; fab.style.boxShadow = "0 6px 20px rgba(52,84,209,.6)"; };
  fab.onmouseleave = function () { fab.style.background = "#3454D1"; fab.style.boxShadow = "0 4px 14px rgba(52,84,209,.45)"; };

  const ensureRuntimeMounted = () => {
    if (!document.head || !document.body) return false;
    if (!document.head.contains(runtimeStyle)) document.head.appendChild(runtimeStyle);
    if (!document.body.contains(backdrop)) document.body.appendChild(backdrop);
    if (!document.body.contains(previewBar)) document.body.appendChild(previewBar);
    if (!document.body.contains(fab)) document.body.appendChild(fab);
    return true;
  };

  const openPanel = function () {
    if (!ensureRuntimeMounted()) return;
    fab.style.display = "none";
    previewBar.style.display = "none";
    backdrop.style.display = "flex";
    requestAnimationFrame(function () {
      backdrop.dataset.active = "true";
    });
    requestAnimationFrame(function () {
      try { promptEl && promptEl.focus({ preventScroll: true }); } catch (e) {}
    });
  };

  const closePanel = function () {
    if (!ensureRuntimeMounted()) return;
    backdrop.dataset.active = "";
    previewBar.style.display = "none";
    setTimeout(function () {
      backdrop.style.display = "none";
      fab.style.display = "flex";
    }, 200);
  };

  const enterPreview = function () {
    backdrop.dataset.active = "";
    setTimeout(function () {
      backdrop.style.display = "none";
      previewBar.style.display = "flex";
    }, 200);
  };

  const exitPreview = function () {
    previewBar.style.display = "none";
    openPanel();
  };

  fab.onclick = openPanel;
  ensureRuntimeMounted();

  /* ── backdrop click to close ───────────────────────────── */
  backdrop.addEventListener("mousedown", function (e) {
    if (e.target === backdrop && !busy) closePanel();
  });

  /* ── element references ──────────────────────────────────── */
  const $ = (s) => ui.querySelector(s);

  const views = { setup: $("#bv-setup"), main: $("#bv-main"), settings: $("#bv-settings") };

  /* setup view refs */
  const setupMode = $("#setup-mode");
  const setupProv = $("#setup-prov");
  const setupModel = $("#setup-model");
  const setupKey = $("#setup-key");
  const setupServer = $("#setup-server");
  const setupClassCode = $("#setup-class-code");
  const setupByokProvider = $("#setup-byok-provider");
  const setupByokModel = $("#setup-byok-model");
  const setupByokKey = $("#setup-byok-key");
  const setupManagedServer = $("#setup-managed-server");
  const setupModeRow = $("#setup-mode-row");
  const setupGo = $("#setup-go");

  /* main view refs */
  const statusEl = $("#status");
  const busyIndicator = $("#busy-indicator");
  const gearBtn = $("#gear");
  const promptEl = $("#p");
  const go = $("#go");
  const chatMessagesEl = $("#chat-messages");
  const newChatBtn = $("#new-chat-btn");
  const logToggle = $("#logToggle");
  const log = $("#log");

  /* compat refs (hidden, used by internal helpers) */
  const revertBtn = $("#revert");
  const fixConvertBtn = $("#fix-convert");
  const activityEl = $("#activity");
  const feedbackBox = $("#fb");
  const feedbackLines = $("#fbLines");
  const feedbackToggle = $("#fbToggle");

  /* preview bar refs */
  const previewReturnBtn = previewBar.querySelector("#preview-return");
  const previewNewBtn = previewBar.querySelector("#preview-new");

  /* settings view refs */
  const setMode = $("#set-mode");
  const setProv = $("#set-prov");
  const setModel = $("#set-model");
  const setKey = $("#set-key");
  const setServer = $("#set-server");
  const setClassCode = $("#set-class-code");
  const setTarget = $("#set-target");
  const setByokProvider = $("#set-byok-provider");
  const setByokModel = $("#set-byok-model");
  const setByokKey = $("#set-byok-key");
  const setManagedServer = $("#set-managed-server");
  const setModeRow = $("#set-mode-row");
  const saveBtn = $("#save");
  const backBtn = $("#back");

  /* ── view switching ──────────────────────────────────────── */
  const showView = (name) => {
    Object.keys(views).forEach((key) => {
      views[key].style.display = key === name ? "flex" : "none";
    });
  };

  /* ── model preset population ─────────────────────────────── */
  const populateModels = (selectEl, provider, savedModel) => {
    selectEl.innerHTML = "";
    const presets = MODEL_PRESETS[provider] || [];
    let defaultId = null;
    presets.forEach((preset) => {
      const opt = document.createElement("option");
      opt.value = preset.id;
      opt.textContent = preset.label;
      selectEl.appendChild(opt);
      if (preset.default) defaultId = preset.id;
    });
    if (savedModel && presets.some((p) => p.id === savedModel)) {
      selectEl.value = savedModel;
    } else if (defaultId) {
      selectEl.value = defaultId;
    }
  };

  /* ── mode-dependent field visibility ─────────────────────── */
  const setModeVisibility = (mode, refs) => {
    const isByok = mode === "byok";
    refs.byokProvider.style.display = isByok ? "grid" : "none";
    refs.byokModel.style.display = isByok ? "grid" : "none";
    refs.byokKey.style.display = isByok ? "grid" : "none";
    refs.managedServer.style.display = isByok ? "none" : "grid";
  };

  const setupModeRefs = {
    byokProvider: setupByokProvider,
    byokModel: setupByokModel,
    byokKey: setupByokKey,
    managedServer: setupManagedServer
  };

  const settingsModeRefs = {
    byokProvider: setByokProvider,
    byokModel: setByokModel,
    byokKey: setByokKey,
    managedServer: setManagedServer
  };

  const filterModeOptions = (selectEl) => {
    const options = Array.from(selectEl.options || []);
    options.forEach((option) => {
      const modeValue = String(option.value || "").trim().toLowerCase();
      if (!modeFlags[modeValue]) option.remove();
    });
    if (!selectEl.options.length) {
      const fallbackOption = document.createElement("option");
      fallbackOption.value = fallbackMode;
      fallbackOption.textContent = fallbackMode === "managed" ? "Managed (school account)" : "Bring your own key";
      selectEl.appendChild(fallbackOption);
    }
    const mode = coerceMode(selectEl.value);
    if (selectEl.value !== mode) selectEl.value = mode;
  };

  filterModeOptions(setupMode);
  filterModeOptions(setMode);
  const showModePicker = modeFlags.byok && modeFlags.managed;
  if (setupModeRow) setupModeRow.style.display = showModePicker ? "grid" : "none";
  if (setModeRow) setModeRow.style.display = showModePicker ? "grid" : "none";

  const applySetupMode = () => {
    const mode = coerceMode(setupMode.value);
    if (setupMode.value !== mode) setupMode.value = mode;
    setModeVisibility(mode, setupModeRefs);
  };

  const applySettingsMode = () => {
    const mode = coerceMode(setMode.value);
    if (setMode.value !== mode) setMode.value = mode;
    setModeVisibility(mode, settingsModeRefs);
    storageSet(STORAGE_MODE, mode);
  };

  /* ── state ───────────────────────────────────────────────── */
  let undoStack = [];
  let busy = false;
  let logsCollapsed = true;
  let feedbackCollapsed = false;
  let generationController = null;
  let queuedForcedRequest = "";
  let queuedForcedDialog = null;
  let lastConversionDialog = null;
  let freshStartOnNextSend = false;

  /* chat conversation state */
  let chatMessages = [];       /* {role,content,feedback?,code?,status?} */
  let chatMessageEls = [];     /* parallel DOM elements */
  let loadingTicker = 0;
  let loadingTick = 0;
  let loadingAssistantIdx = -1;
  let loadingVerbPhase = "model";

  const setStatus = (value) => {
    const next = value || "";
    statusEl.textContent = next;
    ui.dataset.status = next;
  };

  const setBusyIndicator = (on) => {
    busyIndicator.style.visibility = on ? "visible" : "hidden";
    busyIndicator.style.opacity = on ? "1" : "0";
  };

  const createAbortError = () => {
    try {
      return new DOMException("Generation cancelled", "AbortError");
    } catch (error) {
      const fallback = new Error("Generation cancelled");
      fallback.name = "AbortError";
      return fallback;
    }
  };

  const isAbortError = (error) => {
    if (!error) return false;
    if (error.name === "AbortError") return true;
    const message = error && error.message ? String(error.message) : String(error);
    return /aborted|abort/i.test(message);
  };

  const throwIfAborted = (signal) => {
    if (signal && signal.aborted) throw createAbortError();
  };

  const createConversionDialogError = (dialog) => {
    const error = new Error("MakeCode could not convert generated JavaScript to Blocks.");
    error.code = "E_BLOCKS_CONVERT_DIALOG";
    error.dialog = dialog || null;
    return error;
  };

  const isConversionDialogError = (error) => {
    if (!error) return false;
    if (error.code === "E_BLOCKS_CONVERT_DIALOG") return true;
    const message = error && error.message ? String(error.message) : String(error);
    return /convert.+blocks|problem converting/i.test(message);
  };

  const buildConversionFixRequest = (dialog) => {
    const lines = [
      "Fix the current JavaScript so MakeCode can convert it to Blocks.",
      "Preserve intended behaviour and remove syntax or unsupported constructs causing conversion failure."
    ];
    const title = dialog && dialog.title ? String(dialog.title).trim() : "";
    const description = dialog && dialog.description ? String(dialog.description).trim() : "";
    if (title) lines.push("Conversion dialog title: " + title);
    if (description) lines.push("Conversion dialog detail: " + description);
    return lines.join(" ");
  };

  const hideFixConvertButton = () => {};
  const showFixConvertButton = (dialog) => { lastConversionDialog = dialog || null; };

  /* no-op compat stubs */
  const showInteractionOverlay = () => {};
  const hideInteractionOverlay = () => {};

  const setActivity = (message) => {
    activityEl.textContent = message || "";
  };

  const refreshRevertButton = () => {};

  /* ── chat rendering ────────────────────────────────────── */
  const CHAT_HISTORY_SCHEMA_VERSION = 1;
  const CHAT_HISTORY_MAX_MESSAGES = 50;
  const CHAT_HISTORY_MAX_CONTENT_CHARS = 4000;
  const CHAT_HISTORY_MAX_FEEDBACK_LINES = 6;
  const CHAT_HISTORY_MAX_FEEDBACK_CHARS = 320;
  const CHAT_HISTORY_TRUNCATION_SUFFIX = " [truncated]";
  const LOADING_TICK_MS = 1100;
  const LOADING_PHRASES = [
    "Galvanizing Gadgets",
    "Ionizing Instructions",
    "Soldering Syntax",
    "Sparking Sequences",
    "Whittling Wires",
    "Forging Firmware",
    "Knitting Nodes",
    "Etching Logic",
    "Carving Commands",
    "Incanting Inputs",
    "Transmuting Toggles",
    "Brewing Binaries",
    "Manifesting Matrices",
    "Summoning Signals",
    "Pixel-Pushing",
    "Accelerating Atoms",
    "Microing the Bits",
    "Humming Hexfiles",
    "Igniting the Breadboard",
    "Warping Radio Waves",
    "Buffing Pixels",
    "Calibrating Compasses",
    "Agitating Accelerometers",
    "Syncing Silicons",
    "Tuning Transmitters",
    "Oscillating Outputs",
    "Polishing Pins"
  ];
  const LOADING_VERBS = {
    model: LOADING_PHRASES,
    apply: LOADING_PHRASES,
    convert: LOADING_PHRASES
  };
  const ALLOWED_ASSISTANT_STATUSES = {
    generating: true,
    done: true,
    error: true,
    cancelled: true,
    "convert-error": true
  };
  const normaliseAssistantStatus = (status) => {
    const value = typeof status === "string" ? status : "";
    return ALLOWED_ASSISTANT_STATUSES[value] ? value : "cancelled";
  };

  const clampStoredText = (value, maxChars) => {
    const text = String(value || "");
    if (!maxChars || maxChars < 1 || text.length <= maxChars) return text;
    if (maxChars <= CHAT_HISTORY_TRUNCATION_SUFFIX.length + 1) {
      return text.slice(0, maxChars);
    }
    return text.slice(0, maxChars - CHAT_HISTORY_TRUNCATION_SUFFIX.length).trimEnd() + CHAT_HISTORY_TRUNCATION_SUFFIX;
  };

  const normaliseChatMessage = (msg) => {
    if (!msg || (msg.role !== "user" && msg.role !== "assistant")) return null;

    if (msg.role === "user") {
      const content = clampStoredText(msg.content, CHAT_HISTORY_MAX_CONTENT_CHARS).trim();
      if (!content) return null;
      return { role: "user", content };
    }

    const out = { role: "assistant" };
    out.status = normaliseAssistantStatus(msg.status);
    out.actionsHidden = !!msg.actionsHidden;

    const content = clampStoredText(msg.content, CHAT_HISTORY_MAX_CONTENT_CHARS).trim();
    if (content) out.content = content;

    if (Array.isArray(msg.feedback)) {
      const feedback = msg.feedback
        .map((line) => clampStoredText(line, CHAT_HISTORY_MAX_FEEDBACK_CHARS).trim())
        .filter(Boolean)
        .slice(0, CHAT_HISTORY_MAX_FEEDBACK_LINES);
      if (feedback.length) out.feedback = feedback;
    }

    return out;
  };

  const persistChatState = () => {
    try {
      const messages = [];
      for (const msg of chatMessages.slice(-CHAT_HISTORY_MAX_MESSAGES)) {
        const normalised = normaliseChatMessage(msg);
        if (normalised) messages.push(normalised);
      }

      if (!messages.length) {
        storageRemove(STORAGE_CHAT_HISTORY);
        return;
      }

      const payload = { v: CHAT_HISTORY_SCHEMA_VERSION, messages };
      storageSet(STORAGE_CHAT_HISTORY, JSON.stringify(payload));
    } catch (error) {
    }
  };

  const SPARKLE_SVG = '<svg width="32" height="32" viewBox="0 0 24 24" fill="none"><path d="M9.5 2L10.7 6.5 15 8l-4.3 1.5L9.5 14l-1.2-4.5L4 8l4.3-1.5L9.5 2z" fill="#3b82f6"/><path d="M19 10l.8 2.7L22.5 14l-2.7.8L19 17.5l-.8-2.7-2.7-.8 2.7-.8L19 10z" fill="#3b82f6" opacity=".6"/></svg>';
  const SPINNER_SMALL = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="#7088ad" stroke-width="1.5" style="animation:vibbit-spin .9s linear infinite"><circle cx="7" cy="7" r="5" stroke-opacity=".25"></circle><path d="M7 2a5 5 0 0 1 5 5" stroke-linecap="round"></path></svg>';
  const CHECK_SVG = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="#89e6a3" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 7l4 4 6-7"/></svg>';

  const renderEmptyState = () => {
    chatMessagesEl.innerHTML = '<div class="vibbit-empty-state">'
      + SPARKLE_SVG
      + '<div style="font-size:16px;font-weight:600;color:#8899bb">What would you like to build?</div>'
      + '<div style="font-size:13px;line-height:1.5;max-width:340px;color:#5a6d8f">Describe your MakeCode project and I\'ll generate the block code for you.</div>'
      + '</div>';
  };

  const scrollChatToBottom = () => {
    requestAnimationFrame(() => { chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight; });
  };

  const buildAssistantHTML = (msg) => {
    const status = normaliseAssistantStatus(msg && msg.status);
    let html = '';
    const actionsHidden = !!msg.actionsHidden;
    if (status === "generating") {
      html += '<div class="vibbit-msg-status" role="status" aria-live="polite" aria-atomic="true">' + SPINNER_SMALL + ' ' + (msg.content || "Generating...") + '</div>';
      html += '<div class="vibbit-msg-actions"><button class="vibbit-btn-cancel" data-action="cancel">Cancel</button></div>';
    } else if (status === "done") {
      if (msg.feedback && msg.feedback.length) {
        msg.feedback.forEach(function (line) {
          html += '<div class="vibbit-feedback-line">' + escapeHTML(line) + '</div>';
        });
      }
      html += '<div class="vibbit-msg-success">' + CHECK_SVG + ' Code applied to MakeCode</div>';
      if (!actionsHidden) {
        html += '<div class="vibbit-msg-actions">';
        html += '<button class="vibbit-btn-preview" data-action="preview">Preview</button>';
        if (undoStack.length > 0) {
          html += '<button class="vibbit-btn-undo" data-action="undo">Undo</button>';
        }
        html += '</div>';
      }
    } else if (status === "error") {
      html += '<div class="vibbit-msg-error">' + escapeHTML(msg.content || "Something went wrong.") + '</div>';
    } else if (status === "cancelled") {
      html += '<div class="vibbit-msg-status">' + escapeHTML(msg.content || "Cancelled.") + '</div>';
    } else if (status === "convert-error") {
      if (msg.feedback && msg.feedback.length) {
        msg.feedback.forEach(function (line) {
          html += '<div class="vibbit-feedback-line">' + escapeHTML(line) + '</div>';
        });
      }
      html += '<div class="vibbit-msg-error">MakeCode couldn\'t convert to blocks.</div>';
      if (!actionsHidden) {
        html += '<div class="vibbit-msg-actions">';
        html += '<button class="vibbit-btn-fix" data-action="fix">Fix conversion</button>';
        if (undoStack.length > 0) {
          html += '<button class="vibbit-btn-undo" data-action="undo">Undo</button>';
        }
        html += '</div>';
      }
    } else {
      html += '<div>' + escapeHTML(msg.content || "") + '</div>';
    }
    return html;
  };

  const escapeHTML = (str) => {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  };

  const addChatMessage = (msg, options) => {
    const shouldPersist = !options || options.persist !== false;

    /* remove empty state if present */
    const empty = chatMessagesEl.querySelector(".vibbit-empty-state");
    if (empty) empty.remove();

    chatMessages.push(msg);
    const wrapper = document.createElement("div");
    wrapper.className = "vibbit-msg " + (msg.role === "user" ? "vibbit-msg-user" : "vibbit-msg-assistant");
    const bubble = document.createElement("div");
    if (msg.role === "user") {
      bubble.textContent = msg.content;
    } else {
      bubble.innerHTML = buildAssistantHTML(msg);
    }
    wrapper.appendChild(bubble);
    chatMessagesEl.appendChild(wrapper);
    chatMessageEls.push(wrapper);
    scrollChatToBottom();

    /* show New Chat button after first exchange */
    if (chatMessages.length >= 1) {
      newChatBtn.style.display = "inline-flex";
    }

    /* attach action handlers for assistant messages */
    if (msg.role === "assistant") {
      wrapper.addEventListener("click", function (e) {
        const btn = e.target.closest("[data-action]");
        if (!btn) return;
        const action = btn.dataset.action;
        if (action === "cancel") handleCancelGeneration();
        if (action === "preview") enterPreview();
        if (action === "undo") handleRevert();
        if (action === "fix") handleFixConvert();
      });
    }
    if (shouldPersist) persistChatState();
    return chatMessages.length - 1;
  };

  const updateAssistantMessage = (idx, updates, options) => {
    const shouldPersist = !options || options.persist !== false;
    if (idx < 0 || idx >= chatMessages.length) return;
    const msg = chatMessages[idx];
    Object.assign(msg, updates);
    const wrapper = chatMessageEls[idx];
    if (!wrapper) return;
    const bubble = wrapper.firstChild;
    if (bubble) bubble.innerHTML = buildAssistantHTML(msg);
    scrollChatToBottom();
    if (shouldPersist) persistChatState();
  };

  const clearChat = (options) => {
    const shouldPersist = !options || options.persist !== false;
    stopLoadingTicker();
    chatMessages = [];
    chatMessageEls = [];
    undoStack = [];
    lastConversionDialog = null;
    renderEmptyState();
    newChatBtn.style.display = "none";
    clearLog();
    if (shouldPersist) persistChatState();
  };

  const restoreChatState = () => {
    let parsed = null;
    try {
      const raw = storageGet(STORAGE_CHAT_HISTORY);
      if (!raw) return;
      parsed = JSON.parse(raw);
    } catch (error) {
      storageRemove(STORAGE_CHAT_HISTORY);
      return;
    }

    const sourceMessages = Array.isArray(parsed)
      ? parsed
      : (parsed && Array.isArray(parsed.messages) ? parsed.messages : []);
    if (!sourceMessages.length) {
      storageRemove(STORAGE_CHAT_HISTORY);
      return;
    }

    const restored = [];
    for (const item of sourceMessages.slice(-CHAT_HISTORY_MAX_MESSAGES)) {
      const normalised = normaliseChatMessage(item);
      if (!normalised) continue;
      if (normalised.role === "assistant" && normalised.status === "generating") {
        normalised.status = "cancelled";
        normalised.content = "Generation was interrupted after page reload.";
      }
      restored.push(normalised);
    }
    if (!restored.length) {
      storageRemove(STORAGE_CHAT_HISTORY);
      return;
    }

    chatMessagesEl.innerHTML = "";
    chatMessages = [];
    chatMessageEls = [];
    restored.forEach((msg) => addChatMessage(msg, { persist: false }));
    persistChatState();
  };

  const retirePreviousAssistantActions = () => {
    let changed = false;
    for (let i = 0; i < chatMessages.length; i++) {
      const msg = chatMessages[i];
      if (!msg || msg.role !== "assistant") continue;
      if (msg.status !== "done" && msg.status !== "convert-error") continue;
      if (msg.actionsHidden) continue;
      msg.actionsHidden = true;
      const wrapper = chatMessageEls[i];
      const bubble = wrapper && wrapper.firstChild;
      if (bubble) bubble.innerHTML = buildAssistantHTML(msg);
      changed = true;
    }
    if (changed) persistChatState();
  };

  const loadingVerbsForPhase = (phase) => LOADING_VERBS[phase] || LOADING_VERBS.model;

  const formatLoadingLabel = (phase, tick) => {
    const verbs = loadingVerbsForPhase(phase);
    const verbIndex = Math.floor(tick / 2) % verbs.length;
    const dots = ".".repeat((tick % 3) + 1);
    return verbs[verbIndex] + dots;
  };

  const stopLoadingTicker = () => {
    if (loadingTicker) {
      clearInterval(loadingTicker);
      loadingTicker = 0;
    }
    loadingTick = 0;
    loadingAssistantIdx = -1;
    loadingVerbPhase = "model";
  };

  const setLoadingPhase = (phase) => {
    loadingVerbPhase = phase || "model";
  };

  const startLoadingTicker = (assistantIdx, phase) => {
    stopLoadingTicker();
    loadingAssistantIdx = assistantIdx;
    loadingVerbPhase = phase || "model";

    const tickOnce = () => {
      if (loadingAssistantIdx < 0) return;
      const content = formatLoadingLabel(loadingVerbPhase, loadingTick);
      loadingTick += 1;
      updateAssistantMessage(loadingAssistantIdx, { content, status: "generating" }, { persist: false });
    };

    tickOnce();
    loadingTicker = setInterval(tickOnce, LOADING_TICK_MS);
  };

  /* ── log helpers ───────────────────────────────────────── */
  const applyLogCollapse = () => {
    log.style.display = logsCollapsed ? "none" : "block";
    logToggle.textContent = logsCollapsed ? "Show logs" : "Hide logs";
    logToggle.setAttribute("aria-expanded", logsCollapsed ? "false" : "true");
  };

  const logLine = (value) => {
    const row = document.createElement("div");
    row.textContent = value;
    row.style.cssText = "line-height:1.2;padding:1px 0";
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
  };

  const clearLog = () => {
    log.innerHTML = "";
  };

  /* ── feedback panel ──────────────────────────────────────── */
  const DEFAULT_FEEDBACK_MESSAGE = "Model completed generation without explicit feedback notes.";
  const DEFAULT_FAILURE_FEEDBACK = "Generation failed before model feedback was available.";

  const applyFeedbackCollapse = () => {
    if (feedbackCollapsed) {
      feedbackLines.style.display = "none";
      feedbackToggle.textContent = "Show";
      feedbackToggle.setAttribute("aria-expanded", "false");
      feedbackBox.style.paddingBottom = "8px";
    } else {
      feedbackLines.style.display = "grid";
      feedbackToggle.textContent = "Hide";
      feedbackToggle.setAttribute("aria-expanded", "true");
      feedbackBox.style.paddingBottom = "12px";
    }
  };

  const renderFeedback = (items) => {
    feedbackLines.innerHTML = "";
    const list = normaliseFeedback(items);
    if (!list.length) {
      feedbackCollapsed = false;
      feedbackBox.style.display = "none";
      feedbackBox.setAttribute("aria-hidden", "true");
      feedbackToggle.style.visibility = "hidden";
      return;
    }

    list.forEach((item) => {
      const bubble = document.createElement("div");
      bubble.textContent = String(item).trim();
      bubble.style.cssText = "padding:8px 10px;border-left:3px solid #3b82f6;border-radius:6px;background:rgba(59,130,246,0.14);color:#f1f5ff;";
      feedbackLines.appendChild(bubble);
    });

    feedbackCollapsed = false;
    feedbackToggle.style.visibility = "visible";
    feedbackBox.style.display = "block";
    feedbackBox.setAttribute("aria-hidden", "false");
    applyFeedbackCollapse();
  };

  feedbackToggle.style.visibility = "hidden";
  feedbackToggle.onclick = () => {
    if (feedbackBox.style.display === "none") return;
    feedbackCollapsed = !feedbackCollapsed;
    applyFeedbackCollapse();
  };
  fixConvertBtn.onclick = () => {
    if (busy) return;
    queuedForcedDialog = lastConversionDialog || null;
    queuedForcedRequest = buildConversionFixRequest(queuedForcedDialog);
    setActivity("Fixing conversion error...", "neutral", true);
    go.onclick();
  };
  /* ── event wiring ─────────────────────────────────────── */
  logToggle.onclick = () => {
    logsCollapsed = !logsCollapsed;
    applyLogCollapse();
  };
  applyLogCollapse();
  hideFixConvertButton();
  setBusyIndicator(false);
  refreshRevertButton();

  /* preview bar buttons */
  previewReturnBtn.onclick = exitPreview;
  const confirmStartNewChat = () => {
    if (!undoStack.length) return true;
    return window.confirm("Start a new chat? This will clear undo history.");
  };
  previewNewBtn.onclick = () => {
    if (busy) return;
    if (!confirmStartNewChat()) return;
    previewBar.style.display = "none";
    clearChat();
    freshStartOnNextSend = true;
    logLine("New chat started. Next send will start from scratch.");
    openPanel();
  };

  /* new chat button */
  newChatBtn.onclick = () => {
    if (busy) return;
    if (!confirmStartNewChat()) return;
    clearChat();
    freshStartOnNextSend = true;
    logLine("New chat started. Next send will start from scratch.");
  };

  /* Enter to send */
  promptEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !busy) {
      e.preventDefault();
      go.click();
    }
  });

  /* auto-resize textarea */
  promptEl.addEventListener("input", () => {
    promptEl.style.height = "auto";
    promptEl.style.height = Math.min(promptEl.scrollHeight, 120) + "px";
  });

  /* Escape to close */
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && backdrop.style.display !== "none" && !busy) {
      closePanel();
    }
  });

  /* init empty state */
  renderEmptyState();
  restoreChatState();

  /* ── resolve effective backend URL ───────────────────────── */
  const DEFAULT_SERVER = BACKEND.replace(/\/+$/, "");
  const MANAGED_SESSION_REFRESH_BUFFER_MS = 15000;

  const normaliseClassCode = (value) => String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .slice(0, 5);

  const clearManagedSession = () => {
    storageRemove(STORAGE_MANAGED_SESSION);
    storageRemove(STORAGE_MANAGED_SESSION_EXPIRES);
  };

  const getStoredClassCode = () => normaliseClassCode(storageGet(STORAGE_CLASS_CODE) || "");

  const storeClassCode = (value) => {
    const normalized = normaliseClassCode(value);
    if (normalized) storageSet(STORAGE_CLASS_CODE, normalized);
    else storageRemove(STORAGE_CLASS_CODE);
    clearManagedSession();
    return normalized;
  };

  const saveManagedSession = (token, expiresAt) => {
    const safeToken = String(token || "").trim();
    if (!safeToken) {
      clearManagedSession();
      return;
    }
    storageSet(STORAGE_MANAGED_SESSION, safeToken);
    const ts = expiresAt ? Date.parse(expiresAt) : NaN;
    if (Number.isFinite(ts) && ts > 0) storageSet(STORAGE_MANAGED_SESSION_EXPIRES, String(ts));
    else storageRemove(STORAGE_MANAGED_SESSION_EXPIRES);
  };

  const getStoredManagedSession = () => {
    const token = String(storageGet(STORAGE_MANAGED_SESSION) || "").trim();
    if (!token) return "";

    const rawExpiry = storageGet(STORAGE_MANAGED_SESSION_EXPIRES);
    const expiry = rawExpiry ? Number(rawExpiry) : 0;
    if (expiry && (Date.now() + MANAGED_SESSION_REFRESH_BUFFER_MS) >= expiry) {
      clearManagedSession();
      return "";
    }
    return token;
  };

  const extractHostFromServerInput = (value) => {
    const source = String(value || "").trim();
    if (!source) return "";
    if (/^https?:\/\//i.test(source)) {
      try {
        return new URL(source).hostname.toLowerCase();
      } catch (error) {
      }
    }

    const trimmed = source.replace(/^[^@]*@/, "").split(/[/?#]/)[0];
    if (!trimmed) return "";
    const ipv6 = trimmed.match(/^\[([^\]]+)\](?::\d+)?$/);
    if (ipv6 && ipv6[1]) return ipv6[1].toLowerCase();
    return trimmed.split(":")[0].toLowerCase();
  };

  const isLikelyLocalHost = (host) => {
    const value = String(host || "").trim().toLowerCase();
    if (!value) return false;
    if (value === "localhost" || value === "0.0.0.0") return true;
    if (value.endsWith(".localhost") || value.endsWith(".local")) return true;
    if (/^127(?:\.\d{1,3}){3}$/.test(value)) return true;
    if (/^10\./.test(value)) return true;
    if (/^192\.168\./.test(value)) return true;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(value)) return true;
    return false;
  };

  const normaliseServerUrl = (value) => {
    const raw = String(value || "").trim().replace(/\/+$/, "");
    if (!raw) return "";
    if (/^https?:\/\//i.test(raw)) return raw;
    const host = extractHostFromServerInput(raw);
    const protocol = isLikelyLocalHost(host) ? "http://" : "https://";
    return protocol + raw;
  };

  const getBackendUrl = () => {
    const configured = normaliseServerUrl(storageGet(STORAGE_SERVER));
    if (configured) return configured;
    return normaliseServerUrl(BACKEND) || BACKEND;
  };

  /* ── load saved state ────────────────────────────────────── */
  const savedMode = forceMode || coerceMode(storageGet(STORAGE_MODE) || "byok");
  const savedProvider = storageGet(STORAGE_PROVIDER) || "openai";
  const savedModel = storageGet(STORAGE_MODEL);
  const savedKey = getStoredProviderKey(savedProvider);
  const savedServer = storageGet(STORAGE_SERVER) || "";
  const savedClassCode = getStoredClassCode();
  const savedTarget = storageGet(STORAGE_TARGET) || "microbit";
  const setupDone = storageGet(STORAGE_SETUP_DONE) === "1";

  /* hydrate setup view */
  setupMode.value = coerceMode(savedMode);
  setupProv.value = savedProvider;
  populateModels(setupModel, savedProvider, savedModel);
  setupKey.value = savedKey;
  setupServer.value = savedServer || DEFAULT_SERVER;
  setupClassCode.value = savedClassCode;
  applySetupMode();

  /* hydrate settings view */
  setMode.value = coerceMode(savedMode);
  setProv.value = savedProvider;
  populateModels(setModel, savedProvider, savedModel);
  setKey.value = savedKey;
  setServer.value = savedServer || DEFAULT_SERVER;
  setClassCode.value = savedClassCode;
  setTarget.value = savedTarget;
  applySettingsMode();

  /* show correct initial view */
  showView(setupDone ? "main" : "setup");

  /* ── setup view events ───────────────────────────────────── */
  setupMode.onchange = () => {
    applySetupMode();
    setMode.value = setupMode.value;
    applySettingsMode();
  };

  setupProv.onchange = () => {
    populateModels(setupModel, setupProv.value, null);
    setupKey.value = getStoredProviderKey(setupProv.value);
  };

  setupClassCode.onchange = () => {
    setupClassCode.value = normaliseClassCode(setupClassCode.value);
  };
  setupClassCode.oninput = setupClassCode.onchange;

  setupGo.onclick = () => {
    const mode = coerceMode(setupMode.value);
    setupMode.value = mode;
    if (mode === "byok") {
      const key = setupKey.value.trim();
      if (!key) {
        setupKey.style.borderColor = "#ef4444";
        setupKey.focus();
        return;
      }
      setupKey.style.borderColor = "#29324e";
      storageSet(STORAGE_PROVIDER, setupProv.value);
      storageSet(STORAGE_MODEL, setupModel.value);
      setStoredProviderKey(setupProv.value, key);
    } else {
      const server = setupServer.value.trim() || DEFAULT_SERVER;
      storageSet(STORAGE_SERVER, server);
      const classCode = storeClassCode(setupClassCode.value);
      setupClassCode.value = classCode;
    }
    storageSet(STORAGE_MODE, mode);
    storageSet(STORAGE_SETUP_DONE, "1");

    /* sync settings view with what was just saved */
    setMode.value = mode;
    setProv.value = setupProv.value;
    populateModels(setModel, setupProv.value, setupModel.value);
    setKey.value = getStoredProviderKey(setupProv.value);
    setServer.value = setupServer.value;
    setClassCode.value = setupClassCode.value;
    applySettingsMode();

    showView("main");
  };

  /* ── settings view events ────────────────────────────────── */
  setMode.onchange = () => {
    applySettingsMode();
    setupMode.value = setMode.value;
    applySetupMode();
  };

  setProv.onchange = () => {
    populateModels(setModel, setProv.value, null);
    storageSet(STORAGE_PROVIDER, setProv.value);
    /* select the default and persist */
    storageSet(STORAGE_MODEL, setModel.value);
    setKey.value = getStoredProviderKey(setProv.value);
  };

  setModel.onchange = () => {
    storageSet(STORAGE_MODEL, setModel.value);
  };

  saveBtn.onclick = () => {
    try {
      setStoredProviderKey(setProv.value, setKey.value.trim());
      setStatus("Key saved");
      logLine("BYOK API key saved in this browser.");
    } catch (error) {
      logLine("Save failed: " + error);
    }
  };

  setServer.onchange = () => {
    storageSet(STORAGE_SERVER, setServer.value.trim());
    setupServer.value = setServer.value;
    clearManagedSession();
  };
  setServer.oninput = setServer.onchange;

  setClassCode.onchange = () => {
    const classCode = storeClassCode(setClassCode.value);
    setClassCode.value = classCode;
    setupClassCode.value = classCode;
  };
  setClassCode.oninput = setClassCode.onchange;

  setTarget.onchange = () => {
    storageSet(STORAGE_TARGET, setTarget.value);
  };

  gearBtn.onclick = () => showView("settings");
  backBtn.onclick = () => showView("main");

  /* ── close buttons ───────────────────────────────────────── */
  $("#x-setup").onclick = closePanel;
  $("#x-main").onclick = closePanel;
  $("#x-settings").onclick = closePanel;

  const isPanelOpen = () => backdrop.style.display !== "none" && backdrop.dataset.active === "true";
  const togglePanel = () => {
    if (isPanelOpen()) closePanel();
    else openPanel();
  };
  const reinvokeRuntime = () => {
    if (!ensureRuntimeMounted()) return false;
    togglePanel();
    return true;
  };
  const destroyRuntime = () => {
    try {
      if (fab && fab.parentNode) fab.parentNode.removeChild(fab);
      if (previewBar && previewBar.parentNode) previewBar.parentNode.removeChild(previewBar);
      if (backdrop && backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
      if (runtimeStyle && runtimeStyle.parentNode) runtimeStyle.parentNode.removeChild(runtimeStyle);
    } catch (error) {
    }
    if (window.__vibbit === runtimeApi) {
      delete window.__vibbit;
    }
    window.__vibbitStrict = 0;
    return true;
  };
  const runtimeApi = {
    version: "1",
    open: openPanel,
    close: closePanel,
    toggle: togglePanel,
    reinvoke: reinvokeRuntime,
    destroy: destroyRuntime
  };
  window.__vibbit = runtimeApi;

  /* ── Monaco helpers ──────────────────────────────────────── */
  const clickLike = (root, labels) => {
    const list = labels.map((label) => label.toLowerCase());
    const elements = [...root.querySelectorAll("button,[role='tab'],a,[aria-label]")].filter((node) => node && node.offsetParent !== null);
    for (const el of elements) {
      const text = ((el.innerText || el.textContent || "") + " " + (el.getAttribute("aria-label") || "")).trim().toLowerCase();
      if (list.some((entry) => text === entry || text.includes(entry))) {
        el.click();
        return el;
      }
    }
    return null;
  };

  const findMonacoCtx = (timeoutMs = 18000, signal) => {
    const deadline = performance.now() + timeoutMs;
    const candidates = [window, ...[...document.querySelectorAll("iframe")].map((frame) => {
      try {
        return frame.contentWindow;
      } catch (error) {
        return null;
      }
    })].filter(Boolean);

    candidates.forEach((ctx) => {
      try {
        clickLike(ctx.document, ["javascript", "typescript", "text"]);
      } catch (error) {
      }
    });

    return new Promise((resolve, reject) => {
      (function poll() {
        if (signal && signal.aborted) {
          reject(createAbortError());
          return;
        }
        if (performance.now() >= deadline) {
          reject(new Error("Monaco not found. Open the project editor, not the home page."));
          return;
        }
        for (const ctx of candidates) {
          try {
            const monaco = ctx.monaco;
            if (!monaco || !monaco.editor) continue;
            const models = monaco.editor.getModels();
            if (!models || !models.length) continue;
            const editors = monaco.editor.getEditors ? monaco.editor.getEditors() : [];
            const editor = editors && editors.length ? editors[0] : null;
            const model = (editor && editor.getModel && editor.getModel()) || models[0];
            if (model) {
              resolve({ win: ctx, editor, model });
              return;
            }
          } catch (error) {
          }
        }
        setTimeout(poll, 100);
      })();
    });
  };

  const normaliseErrorLine = (value, limit) => {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    if (!text) return "";
    if (text.length <= (limit || 220)) return text;
    return text.slice(0, (limit || 220) - 3).trimEnd() + "...";
  };

  const collectCandidateDocs = (monacoCtx) => {
    const docs = [];
    const pushDoc = (doc) => {
      if (!doc) return;
      if (docs.includes(doc)) return;
      docs.push(doc);
    };
    try { pushDoc(document); } catch (error) {}
    try { pushDoc(monacoCtx && monacoCtx.win && monacoCtx.win.document); } catch (error) {}
    return docs;
  };

  const findConversionDialogInDoc = (doc) => {
    if (!doc) return null;
    const dialogNodes = [...doc.querySelectorAll(".ReactModal__Content[role='dialog'][aria-modal='true'], .coredialog[role='dialog'][aria-modal='true'], .ui.modal[role='dialog'][aria-modal='true']")];
    for (const dialogNode of dialogNodes) {
      const titleNode = dialogNode.querySelector(".header-title, .header h3");
      const descNode = dialogNode.querySelector(".content p");
      const stayButton = dialogNode.querySelector("button[aria-label*='Stay in JavaScript'],button.positive");
      const discardButton = dialogNode.querySelector("button[aria-label*='Discard'][aria-label*='Blocks'],button.cancel");
      const title = normaliseErrorLine(titleNode ? (titleNode.innerText || titleNode.textContent || "") : "", 180);
      const description = normaliseErrorLine(descNode ? (descNode.innerText || descNode.textContent || "") : "", 260);
      const combined = (title + " " + description).toLowerCase();
      const looksLikeConversionDialog = /problem converting|unable to convert.+back to blocks|go back to the previous blocks/i.test(combined)
        || (Boolean(stayButton) && Boolean(discardButton) && /convert|blocks/i.test(combined));
      if (!looksLikeConversionDialog) continue;
      return {
        node: dialogNode,
        title,
        description,
        stayButton,
        discardButton
      };
    }
    return null;
  };

  const detectConversionDialog = (monacoCtx) => {
    const docs = collectCandidateDocs(monacoCtx);
    for (const doc of docs) {
      try {
        const found = findConversionDialogInDoc(doc);
        if (!found) continue;
        return {
          title: found.title,
          description: found.description
        };
      } catch (error) {
      }
    }
    return null;
  };

  const dismissConversionDialogByStaying = (monacoCtx) => {
    const docs = collectCandidateDocs(monacoCtx);
    for (const doc of docs) {
      try {
        const found = findConversionDialogInDoc(doc);
        if (!found || !found.stayButton) continue;
        found.stayButton.click();
        return true;
      } catch (error) {
      }
    }
    return false;
  };

  const collectPageContext = (monacoCtx) => {
    const out = [];
    const seen = new Set();
    const isProbablyVisible = (node) => {
      try {
        if (!node || node.nodeType !== 1) return false;
        const owner = node.ownerDocument || document;
        const view = owner.defaultView || window;
        const style = view.getComputedStyle(node);
        if (!style || style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
        return node.getClientRects && node.getClientRects().length > 0;
      } catch (error) {
        return false;
      }
    };
    const pushError = (prefix, value) => {
      const cleaned = normaliseErrorLine(value, 240);
      if (!cleaned) return;
      const line = (prefix ? (prefix + ": ") : "") + cleaned;
      const key = line.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push(line);
    };

    let conversionDialog = null;
    try {
      conversionDialog = detectConversionDialog(monacoCtx);
      if (conversionDialog) {
        if (conversionDialog.title) pushError("ConvertDialog", conversionDialog.title);
        if (conversionDialog.description) pushError("ConvertDialog", conversionDialog.description);
      }
    } catch (error) {
    }

    try {
      const monaco = monacoCtx && monacoCtx.win && monacoCtx.win.monaco;
      const model = monacoCtx && monacoCtx.model;
      const markerSeverity = monaco && monaco.MarkerSeverity ? monaco.MarkerSeverity : null;
      if (monaco && monaco.editor && model && model.uri) {
        const markers = monaco.editor.getModelMarkers({ resource: model.uri }) || [];
        for (const marker of markers) {
          if (!marker) continue;
          if (markerSeverity && marker.severity !== markerSeverity.Error) continue;
          const line = marker.startLineNumber ? ("L" + marker.startLineNumber + " - " + marker.message) : marker.message;
          pushError("Editor", line);
          if (out.length >= 12) break;
        }
      }
    } catch (error) {
    }

    try {
      const selectors = [
        "[role='alert']",
        "[aria-live='assertive']",
        ".error",
        ".errors",
        ".notification-error",
        ".toast-error",
        ".problem",
        ".diagnostic",
        ".warning"
      ];
      const docs = collectCandidateDocs(monacoCtx);
      for (const doc of docs) {
        const nodes = [...doc.querySelectorAll(selectors.join(","))];
        for (const node of nodes) {
          if (!node || !node.isConnected) continue;
          if (!isProbablyVisible(node)) continue;
          const text = normaliseErrorLine(node.innerText || node.textContent || "", 240);
          if (!text) continue;
          if (node.closest("#vibbit-panel")) continue;
          if (!/(error|failed|exception|cannot|can't|invalid|diagnostic|problem|compile)/i.test(text)) continue;
          pushError("Page", text);
          if (out.length >= 12) break;
        }
        if (out.length >= 12) break;
      }
    } catch (error) {
    }

    return {
      errors: out.slice(0, 8),
      conversionDialog: conversionDialog || null
    };
  };

  const collectBlocklyWorkspaces = (rootWin) => {
    const workspaces = [];
    const queue = [rootWin, window];
    const seen = new Set();

    while (queue.length) {
      const ctx = queue.shift();
      if (!ctx || seen.has(ctx)) continue;
      seen.add(ctx);

      try {
        const blockly = ctx.Blockly;
        const ws = blockly && (typeof blockly.getMainWorkspace === "function" ? blockly.getMainWorkspace() : blockly.mainWorkspace);
        if (ws && typeof ws.getAllBlocks === "function") workspaces.push(ws);
      } catch (error) {
      }

      try {
        const frames = ctx.document ? [...ctx.document.querySelectorAll("iframe")] : [];
        for (const frame of frames) {
          try {
            if (frame.contentWindow) queue.push(frame.contentWindow);
          } catch (error) {
          }
        }
      } catch (error) {
      }
    }

    return workspaces;
  };

  const inspectGreyBlocks = (rootWin) => {
    const workspaces = collectBlocklyWorkspaces(rootWin);
    if (!workspaces.length) {
      return { checked: false, ok: true, greyBlocks: 0, reason: "Blockly workspace unavailable" };
    }

    let greyBlocks = 0;
    const snippets = [];

    for (const ws of workspaces) {
      let blocks = [];
      try {
        blocks = ws.getAllBlocks(false) || [];
      } catch (error) {
        blocks = [];
      }
      for (const block of blocks) {
        if (!block || block.type !== "typescript_statement") continue;
        greyBlocks += 1;
        if (snippets.length < 3) {
          let preview = "";
          try { preview = (block.getFieldValue && block.getFieldValue("EXPRESSION")) || ""; } catch (error) {}
          try { if (!preview && block.toString) preview = block.toString(); } catch (error) {}
          preview = String(preview || "grey block").replace(/\s+/g, " ").trim();
          snippets.push(preview.slice(0, 140));
        }
      }
    }

    if (greyBlocks > 0) {
      return {
        checked: true,
        ok: false,
        greyBlocks,
        reason: "Detected " + greyBlocks + " grey JavaScript block(s)",
        snippets
      };
    }
    return { checked: true, ok: true, greyBlocks: 0, snippets };
  };

  const waitForDecompileProbe = (monacoCtx, timeoutMs = 6000, signal) => {
    const rootWin = monacoCtx && monacoCtx.win ? monacoCtx.win : monacoCtx;
    const deadline = performance.now() + timeoutMs;
    const startedAt = performance.now();
    const minSettleMs = 1500;
    const requiredStableReads = 4;
    return new Promise((resolve) => {
      let lastSignature = "";
      let stableReads = 0;
      let lastReport = { checked: false, ok: true, greyBlocks: 0, reason: "Blockly workspace unavailable", conversionDialog: null };
      (function poll() {
        if (signal && signal.aborted) {
          resolve({ checked: true, ok: false, greyBlocks: 0, reason: "Generation cancelled before decompile check." });
          return;
        }
        try {
          const conversionDialog = detectConversionDialog(monacoCtx);
          if (conversionDialog) {
            resolve({
              checked: true,
              ok: false,
              greyBlocks: 0,
              reason: "MakeCode could not convert JavaScript back to Blocks.",
              conversionDialog
            });
            return;
          }
        } catch (error) {
        }
        const report = inspectGreyBlocks(rootWin);
        lastReport = report;
        const signature = [
          report.checked ? "checked" : "unchecked",
          report.ok ? "ok" : "bad",
          String(report.greyBlocks || 0),
          Array.isArray(report.snippets) ? report.snippets.join("|") : ""
        ].join("::");
        if (signature === lastSignature) {
          stableReads += 1;
        } else {
          lastSignature = signature;
          stableReads = 1;
        }

        if (
          report.checked
          && (performance.now() - startedAt) >= minSettleMs
          && stableReads >= requiredStableReads
        ) {
          resolve(report);
          return;
        }
        if (performance.now() >= deadline) {
          resolve(lastReport);
          return;
        }
        setTimeout(poll, 120);
      })();
    });
  };

  const pasteToMakeCode = (code, options) => {
    const shouldSnapshot = !options || options.snapshot !== false;
    const signal = options && options.signal ? options.signal : null;
    return findMonacoCtx(18000, signal).then((ctx) => {
      throwIfAborted(signal);
      logLine("Switching to JavaScript tab.");
      clickLike(ctx.win.document, ["javascript", "typescript", "text"]);
      return waitWithAbort(20, signal).then(() => {
        throwIfAborted(signal);
        if (shouldSnapshot) {
          try {
            const previous = ctx.model.getValue() || "";
            undoStack.push(previous);
            refreshRevertButton();
            logLine("Snapshot saved for revert.");
          } catch (error) {
            logLine("Snapshot failed: " + error);
          }
        }
        logLine("Pasting generated code into editor.");
        ctx.model.setValue(code);
        throwIfAborted(signal);
        if (ctx.editor && ctx.editor.setPosition) {
          ctx.editor.setPosition({ lineNumber: 1, column: 1 });
        }
        logLine("Switching back to Blocks.");
        clickLike(ctx.win.document, ["blocks"]) || (function () {
          const menu = ctx.win.document.querySelector("button[aria-label*='More'],button[aria-label*='Editor'],.menu-button,.more-button");
          if (menu) {
            menu.click();
            return clickLike(ctx.win.document, ["blocks"]);
          }
        })();
        return waitWithAbort(120, signal).then(() => {
          const conversionDialog = detectConversionDialog(ctx);
          if (conversionDialog) {
            logLine("MakeCode conversion dialog detected: " + (conversionDialog.title || "Cannot convert to Blocks."));
            if (dismissConversionDialogByStaying(ctx)) {
              logLine("Chose 'Stay in JavaScript' to preserve code for repair.");
            }
            throw createConversionDialogError(conversionDialog);
          }
          return waitForDecompileProbe(ctx, 6000, signal);
        }).then((probe) => {
          throwIfAborted(signal);
          if (probe && probe.conversionDialog) {
            logLine("MakeCode conversion dialog detected: " + (probe.conversionDialog.title || "Cannot convert to Blocks."));
            if (dismissConversionDialogByStaying(ctx)) {
              logLine("Chose 'Stay in JavaScript' to preserve code for repair.");
            }
            throw createConversionDialogError(probe.conversionDialog);
          }
          if (!probe.checked) {
            logLine("Live decompile check unavailable in this session.");
            return;
          }
          if (!probe.ok) {
            const details = probe.snippets && probe.snippets.length
              ? (" Examples: " + probe.snippets.join(" | "))
              : "";
            throw new Error((probe.reason || "Code failed live blocks decompile check.") + details);
          }
          logLine("Live decompile check passed (no grey blocks).");
        });
      });
    });
  };

  const revertEditor = () => {
    return findMonacoCtx().then((ctx) => {
      if (!undoStack.length) throw new Error("No snapshot to revert to.");
      const previous = undoStack[undoStack.length - 1];
      logLine("Switching to JavaScript tab for revert.");
      clickLike(ctx.win.document, ["javascript", "typescript", "text"]);
      return wait(20).then(() => {
        logLine("Restoring previous code.");
        ctx.model.setValue(previous);
        if (ctx.editor && ctx.editor.setPosition) {
          ctx.editor.setPosition({ lineNumber: 1, column: 1 });
        }
        logLine("Switching back to Blocks.");
        clickLike(ctx.win.document, ["blocks"]) || (function () {
          const menu = ctx.win.document.querySelector("button[aria-label*='More'],button[aria-label*='Editor'],.menu-button,.more-button");
          if (menu) {
            menu.click();
            return clickLike(ctx.win.document, ["blocks"]);
          }
        })();
      }).then(() => {
        undoStack.pop();
      });
    }).then(() => {
      refreshRevertButton();
    });
  };

  /* ── code processing ─────────────────────────────────────── */
  /* ── shared compat core (generated) ───────────────────── */
  // BEGIN_SHARED_COMPAT_CORE
  const {
    sanitizeMakeCode,
    normaliseFeedback,
    resolvePromptTargetContext,
    buildUserPrompt,
    extractCode,
    parseModelOutput,
    validateBlocksCompatibility,
    buildTargetPromptExtras,
    stubForTarget,
    extractGeminiText,
  } = (() => {
    function sanitizeMakeCode(input) {
      if (!input) return "";
      let text = String(input);
      if (/^```/.test(text)) text = text.replace(/^```[\s\S]*?\n/, "").replace(/```\s*$/, "");
      text = text.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n").replace(/\\t/g, "\t");
      text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      text = text.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, "\"");
      text = text.replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\u00A0/g, " ");
      text = text.replace(/^`+|`+$/g, "");
      return text.trim();
    }

    function normaliseFeedback(items, fallback = "") {
      const seen = new Set();
      const list = [];
      for (const item of Array.isArray(items) ? items : []) {
        const text = String(item || "").trim();
        if (!text) continue;
        const key = text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        list.push(text);
      }
      if (!list.length && fallback) list.push(fallback);
      return list;
    }

    function resolvePromptTargetContext(target) {
      if (target === "arcade") {
        return {
          targetName: "Arcade",
          namespaceList: "controller,game,scene,sprites,info,music,effects"
        };
      }
      if (target === "maker") {
        return {
          targetName: "Maker",
          namespaceList: "pins,input,loops,music"
        };
      }
      return {
        targetName: "micro:bit",
        namespaceList: "basic,input,music,led,radio,pins,loops,logic,variables,math,functions,arrays,text,game,images,serial,control"
      };
    }

    const DEFAULT_CURRENT_CODE_TRUNCATION_MARKER = "\n// ... CURRENT_CODE_TRUNCATED ...\n";

    function boundCurrentCodeForPrompt(currentCode, {
      maxChars = 0,
      truncationMarker = DEFAULT_CURRENT_CODE_TRUNCATION_MARKER
    } = {}) {
      const source = String(currentCode || "");
      if (!source.trim()) {
        return { text: "", truncated: false, omittedChars: 0 };
      }
      if (!maxChars || source.length <= maxChars) {
        return { text: source, truncated: false, omittedChars: 0 };
      }

      const budget = Math.max(0, maxChars - truncationMarker.length);
      const headBudget = Math.floor(budget * 0.65);
      const tailBudget = Math.max(0, budget - headBudget);
      const head = source.slice(0, headBudget).trimEnd();
      const tail = source.slice(source.length - tailBudget).trimStart();
      const omittedChars = Math.max(0, source.length - (head.length + tail.length));

      return {
        text: head + truncationMarker + tail,
        truncated: true,
        omittedChars
      };
    }

    function buildUserPrompt({
      request,
      currentCode,
      pageErrors,
      conversionDialog,
      recentChat,
      maxCurrentCodeChars = 0,
      truncationMarker = DEFAULT_CURRENT_CODE_TRUNCATION_MARKER
    } = {}) {
      const blocks = [];
      const recentChatTurns = Array.isArray(recentChat) ? recentChat : [];
      if (recentChatTurns.length) {
        const histLines = ["<<<RECENT_CHAT>>>"];
        for (const turn of recentChatTurns) {
          if (turn.role === "user") {
            histLines.push("Last user message: " + String(turn.content || "").trim());
          } else if (turn.role === "assistant") {
            histLines.push("Last assistant notes: " + String(turn.notes || "").trim());
          }
        }
        histLines.push("<<<END_RECENT_CHAT>>>");
        blocks.push(histLines.join("\n"));
      }

      blocks.push("USER_REQUEST:\n" + String(request || "").trim());

      const errors = Array.isArray(pageErrors)
        ? pageErrors.map((item) => String(item || "").trim()).filter(Boolean)
        : [];
      if (errors.length) {
        blocks.push("<<<PAGE_ERRORS>>>\n- " + errors.join("\n- ") + "\n<<<END_PAGE_ERRORS>>>");
      }

      const dialogTitle = conversionDialog && conversionDialog.title ? String(conversionDialog.title).trim() : "";
      const dialogDescription = conversionDialog && conversionDialog.description ? String(conversionDialog.description).trim() : "";
      if (dialogTitle || dialogDescription) {
        const lines = [];
        if (dialogTitle) lines.push("Title: " + dialogTitle);
        if (dialogDescription) lines.push("Message: " + dialogDescription);
        blocks.push("<<<CONVERSION_DIALOG>>>\n" + lines.join("\n") + "\n<<<END_CONVERSION_DIALOG>>>");
      }

      const boundedCurrentCode = boundCurrentCodeForPrompt(currentCode, {
        maxChars: maxCurrentCodeChars,
        truncationMarker
      });
      if (boundedCurrentCode.text) {
        if (boundedCurrentCode.truncated && maxCurrentCodeChars > 0) {
          blocks.push(
            "<<<CURRENT_CODE_NOTE>>>\n"
            + "Current code was truncated for prompt size. Omitted approx "
            + boundedCurrentCode.omittedChars
            + " chars from the middle.\n<<<END_CURRENT_CODE_NOTE>>>"
          );
        }
        blocks.push("<<<CURRENT_CODE>>>\n" + boundedCurrentCode.text + "\n<<<END_CURRENT_CODE>>>");
      }

      return blocks.join("\n\n");
    }

    function extractJsonObjectCandidates(text) {
      const matches = [];
      let depth = 0;
      let start = -1;
      let inString = false;
      let escaped = false;

      for (let i = 0; i < text.length; i += 1) {
        const char = text[i];

        if (inString) {
          if (escaped) {
            escaped = false;
            continue;
          }
          if (char === "\\") {
            escaped = true;
            continue;
          }
          if (char === "\"") inString = false;
          continue;
        }

        if (char === "\"") {
          inString = true;
          continue;
        }

        if (char === "{") {
          if (depth === 0) start = i;
          depth += 1;
          continue;
        }

        if (char === "}" && depth > 0) {
          depth -= 1;
          if (depth === 0 && start !== -1) {
            matches.push(text.slice(start, i + 1));
            start = -1;
          }
        }
      }

      return matches;
    }

    function parseJsonObjectsFromText(raw) {
      const text = String(raw || "").trim();
      if (!text) return [];
      const candidates = [text];
      const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
      if (fencedMatch && fencedMatch[1]) candidates.push(fencedMatch[1].trim());
      candidates.push(...extractJsonObjectCandidates(text));
      const parsedObjects = [];
      const seen = new Set();
      for (const candidate of candidates) {
        const source = String(candidate || "").trim();
        if (!source || seen.has(source)) continue;
        seen.add(source);
        try {
          const parsed = JSON.parse(source);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            parsedObjects.push(parsed);
          }
        } catch (error) {
        }
      }
      return parsedObjects;
    }

    function isModelOutputObject(parsed) {
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
      return Object.prototype.hasOwnProperty.call(parsed, "code");
    }

    function extractCode(raw) {
      if (!raw) return "";
      const match = String(raw).match(/```[a-z]*\n([\s\S]*?)```/i);
      const code = match ? match[1] : raw;
      return sanitizeMakeCode(code);
    }

    function parseModelOutput(raw) {
      const parsedObjects = parseJsonObjectsFromText(raw);
      for (const parsed of parsedObjects) {
        if (!isModelOutputObject(parsed)) continue;
        const rawFeedback = Array.isArray(parsed.feedback)
          ? parsed.feedback
          : (parsed.feedback == null ? [] : [parsed.feedback]);
        return {
          feedback: normaliseFeedback(rawFeedback),
          code: extractCode(parsed.code == null ? "" : String(parsed.code))
        };
      }
      return { feedback: [], code: extractCode(raw) };
    }

    const MICROBIT_ICON_NAMES = [
      "Heart",
      "SmallHeart",
      "Yes",
      "No",
      "Happy",
      "Sad",
      "Confused",
      "Angry",
      "Asleep",
      "Surprised",
      "Silly",
      "Fabulous",
      "Meh",
      "TShirt",
      "Rollerskate",
      "Duck",
      "House",
      "Tortoise",
      "Butterfly",
      "StickFigure",
      "Ghost",
      "Sword",
      "Giraffe",
      "Skull",
      "Umbrella",
      "Snake",
      "Rabbit",
      "Cow",
      "QuarterNote",
      "EighthNote",
      "Pitchfork",
      "Target",
      "Triangle",
      "LeftTriangle",
      "Chessboard",
      "Diamond",
      "SmallDiamond",
      "Square",
      "SmallSquare",
      "Scissors"
    ];

    const MICROBIT_DEPRECATED_ICON_ALIASES = ["EigthNote"];

    const MICROBIT_ARROW_NAMES = [
      "North",
      "NorthEast",
      "East",
      "SouthEast",
      "South",
      "SouthWest",
      "West",
      "NorthWest"
    ];

    const MICROBIT_GESTURE_NAMES = [
      "Shake",
      "LogoUp",
      "LogoDown",
      "ScreenUp",
      "ScreenDown",
      "TiltLeft",
      "TiltRight",
      "FreeFall",
      "ThreeG",
      "SixG",
      "EightG"
    ];

    const MICROBIT_ENUM_MEMBER_SETS = Object.freeze({
      Button: new Set(["A", "B", "AB"]),
      Gesture: new Set(MICROBIT_GESTURE_NAMES),
      TouchPin: new Set(["P0", "P1", "P2"]),
      Dimension: new Set(["X", "Y", "Z", "Strength"]),
      Rotation: new Set(["Pitch", "Roll"]),
      IconNames: new Set([...MICROBIT_ICON_NAMES, ...MICROBIT_DEPRECATED_ICON_ALIASES]),
      ArrowNames: new Set(MICROBIT_ARROW_NAMES),
      DigitalPin: new Set(["P0", "P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9", "P10", "P11", "P12", "P13", "P14", "P15", "P16", "P19", "P20"]),
      AnalogPin: new Set(["P0", "P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9", "P10", "P11", "P12", "P13", "P14", "P15", "P16", "P19", "P20"]),
      PulseValue: new Set(["High", "Low"]),
      BeatFraction: new Set(["Whole", "Half", "Quarter", "Eighth", "Sixteenth", "Double", "Breve"])
    });

    const MICROBIT_CALL_SIGNATURES = [
      { call: "basic.showNumber", minArgs: 1, maxArgs: 2 },
      { call: "basic.showString", minArgs: 1, maxArgs: 2 },
      { call: "basic.showIcon", minArgs: 1, maxArgs: 2 },
      { call: "basic.showLeds", minArgs: 1, maxArgs: 1 },
      { call: "basic.showArrow", minArgs: 1, maxArgs: 2 },
      { call: "basic.clearScreen", minArgs: 0, maxArgs: 0 },
      { call: "basic.forever", minArgs: 1, maxArgs: 1 },
      { call: "basic.pause", minArgs: 1, maxArgs: 1 },
      { call: "input.onButtonPressed", minArgs: 2, maxArgs: 2 },
      { call: "input.onGesture", minArgs: 2, maxArgs: 2 },
      { call: "input.onPinPressed", minArgs: 2, maxArgs: 2 },
      { call: "input.buttonIsPressed", minArgs: 1, maxArgs: 1 },
      { call: "input.temperature", minArgs: 0, maxArgs: 0 },
      { call: "input.lightLevel", minArgs: 0, maxArgs: 0 },
      { call: "input.acceleration", minArgs: 1, maxArgs: 1 },
      { call: "input.compassHeading", minArgs: 0, maxArgs: 0 },
      { call: "input.rotation", minArgs: 1, maxArgs: 1 },
      { call: "input.magneticForce", minArgs: 1, maxArgs: 1 },
      { call: "input.runningTime", minArgs: 0, maxArgs: 0 },
      { call: "music.playTone", minArgs: 2, maxArgs: 2 },
      { call: "music.ringTone", minArgs: 1, maxArgs: 1 },
      { call: "music.rest", minArgs: 1, maxArgs: 1 },
      { call: "music.beat", minArgs: 0, maxArgs: 1 },
      { call: "music.tempo", minArgs: 0, maxArgs: 0 },
      { call: "music.setTempo", minArgs: 1, maxArgs: 1 },
      { call: "music.changeTempoBy", minArgs: 1, maxArgs: 1 },
      { call: "led.plot", minArgs: 2, maxArgs: 2 },
      { call: "led.unplot", minArgs: 2, maxArgs: 2 },
      { call: "led.toggle", minArgs: 2, maxArgs: 2 },
      { call: "led.point", minArgs: 2, maxArgs: 2 },
      { call: "led.brightness", minArgs: 0, maxArgs: 0 },
      { call: "led.setBrightness", minArgs: 1, maxArgs: 1 },
      { call: "led.plotBarGraph", minArgs: 2, maxArgs: 3 },
      { call: "led.enable", minArgs: 1, maxArgs: 1 },
      { call: "radio.sendNumber", minArgs: 1, maxArgs: 1 },
      { call: "radio.sendString", minArgs: 1, maxArgs: 1 },
      { call: "radio.sendValue", minArgs: 2, maxArgs: 2 },
      { call: "radio.onReceivedNumber", minArgs: 1, maxArgs: 1 },
      { call: "radio.onReceivedString", minArgs: 1, maxArgs: 1 },
      { call: "radio.setGroup", minArgs: 1, maxArgs: 1 },
      { call: "radio.setTransmitPower", minArgs: 1, maxArgs: 1 },
      { call: "radio.setTransmitSerialNumber", minArgs: 1, maxArgs: 1 },
      { call: "game.createSprite", minArgs: 2, maxArgs: 2 },
      { call: "game.addScore", minArgs: 1, maxArgs: 1 },
      { call: "game.score", minArgs: 0, maxArgs: 0 },
      { call: "game.setScore", minArgs: 1, maxArgs: 1 },
      { call: "game.setLife", minArgs: 1, maxArgs: 1 },
      { call: "game.addLife", minArgs: 1, maxArgs: 1 },
      { call: "game.removeLife", minArgs: 1, maxArgs: 1 },
      { call: "game.gameOver", minArgs: 0, maxArgs: 0 },
      { call: "game.startCountdown", minArgs: 1, maxArgs: 1 },
      { call: "pins.digitalReadPin", minArgs: 1, maxArgs: 1 },
      { call: "pins.digitalWritePin", minArgs: 2, maxArgs: 2 },
      { call: "pins.analogReadPin", minArgs: 1, maxArgs: 1 },
      { call: "pins.analogWritePin", minArgs: 2, maxArgs: 2 },
      { call: "pins.servoWritePin", minArgs: 2, maxArgs: 2 },
      { call: "pins.map", minArgs: 5, maxArgs: 5 },
      { call: "pins.onPulsed", minArgs: 3, maxArgs: 3 },
      { call: "pins.analogSetPitchPin", minArgs: 1, maxArgs: 1 },
      { call: "pins.analogPitch", minArgs: 2, maxArgs: 2 },
      { call: "images.createImage", minArgs: 1, maxArgs: 1 },
      { call: "images.createBigImage", minArgs: 1, maxArgs: 1 },
      { call: "images.arrowImage", minArgs: 1, maxArgs: 1 },
      { call: "images.iconImage", minArgs: 1, maxArgs: 1 },
      { call: "serial.writeLine", minArgs: 1, maxArgs: 1 },
      { call: "serial.writeNumber", minArgs: 1, maxArgs: 1 },
      { call: "serial.writeValue", minArgs: 2, maxArgs: 2 },
      { call: "serial.readLine", minArgs: 0, maxArgs: 0 },
      { call: "serial.onDataReceived", minArgs: 2, maxArgs: 2 },
      { call: "serial.redirect", minArgs: 3, maxArgs: 3 },
      { call: "control.inBackground", minArgs: 1, maxArgs: 1 },
      { call: "control.reset", minArgs: 0, maxArgs: 0 },
      { call: "control.waitMicros", minArgs: 1, maxArgs: 1 }
    ];

    const MICROBIT_BLOCKS_TEST_EXAMPLES = [
      "input.onButtonPressed(Button.A, function () { basic.showIcon(IconNames.Heart) })",
      "basic.forever(function () { led.toggle(2, 2); basic.pause(100) })",
      "radio.onReceivedNumber(function (receivedNumber) { basic.showNumber(receivedNumber) })"
    ];

    function escapeRegExp(value) {
      return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    function stripNonCodeSegments(source) {
      const input = String(source || "");
      const chars = input.split("");
      let inSingle = false;
      let inDouble = false;
      let inTemplate = false;
      let inLineComment = false;
      let inBlockComment = false;
      let escaped = false;

      const blankAt = (index) => {
        const ch = chars[index];
        if (ch !== "\n" && ch !== "\r") chars[index] = " ";
      };

      for (let i = 0; i < chars.length; i += 1) {
        const char = chars[i];
        const next = i + 1 < chars.length ? chars[i + 1] : "";

        if (inLineComment) {
          if (char === "\n") {
            inLineComment = false;
          } else {
            blankAt(i);
          }
          continue;
        }
        if (inBlockComment) {
          if (char === "*" && next === "/") {
            blankAt(i);
            blankAt(i + 1);
            inBlockComment = false;
            i += 1;
          } else {
            blankAt(i);
          }
          continue;
        }
        if (inSingle) {
          if (escaped) {
            blankAt(i);
            escaped = false;
          } else if (char === "\\") {
            blankAt(i);
            escaped = true;
          } else if (char === "'") {
            inSingle = false;
          } else {
            blankAt(i);
          }
          continue;
        }
        if (inDouble) {
          if (escaped) {
            blankAt(i);
            escaped = false;
          } else if (char === "\\") {
            blankAt(i);
            escaped = true;
          } else if (char === "\"") {
            inDouble = false;
          } else {
            blankAt(i);
          }
          continue;
        }
        if (inTemplate) {
          if (escaped) {
            blankAt(i);
            escaped = false;
          } else if (char === "\\") {
            blankAt(i);
            escaped = true;
          } else if (char === "`") {
            inTemplate = false;
          } else {
            blankAt(i);
          }
          continue;
        }

        if (char === "/" && next === "/") {
          blankAt(i);
          blankAt(i + 1);
          inLineComment = true;
          i += 1;
          continue;
        }
        if (char === "/" && next === "*") {
          blankAt(i);
          blankAt(i + 1);
          inBlockComment = true;
          i += 1;
          continue;
        }
        if (char === "'") {
          inSingle = true;
          continue;
        }
        if (char === "\"") {
          inDouble = true;
          continue;
        }
        if (char === "`") {
          inTemplate = true;
          continue;
        }
      }

      return chars.join("");
    }

    function readBalancedParentheses(source, openParenIndex) {
      if (openParenIndex < 0 || source[openParenIndex] !== "(") return null;
      let depth = 0;
      let inSingle = false;
      let inDouble = false;
      let inTemplate = false;
      let inLineComment = false;
      let inBlockComment = false;
      let escaped = false;

      for (let i = openParenIndex; i < source.length; i += 1) {
        const char = source[i];
        const next = i + 1 < source.length ? source[i + 1] : "";
        if (inLineComment) {
          if (char === "\n") inLineComment = false;
          continue;
        }
        if (inBlockComment) {
          if (char === "*" && next === "/") {
            inBlockComment = false;
            i += 1;
          }
          continue;
        }
        if (inSingle) {
          if (escaped) {
            escaped = false;
          } else if (char === "\\") {
            escaped = true;
          } else if (char === "'") {
            inSingle = false;
          }
          continue;
        }
        if (inDouble) {
          if (escaped) {
            escaped = false;
          } else if (char === "\\") {
            escaped = true;
          } else if (char === "\"") {
            inDouble = false;
          }
          continue;
        }
        if (inTemplate) {
          if (escaped) {
            escaped = false;
          } else if (char === "\\") {
            escaped = true;
          } else if (char === "`") {
            inTemplate = false;
          }
          continue;
        }
        if (char === "/" && next === "/") {
          inLineComment = true;
          i += 1;
          continue;
        }
        if (char === "/" && next === "*") {
          inBlockComment = true;
          i += 1;
          continue;
        }
        if (char === "'") {
          inSingle = true;
          continue;
        }
        if (char === "\"") {
          inDouble = true;
          continue;
        }
        if (char === "`") {
          inTemplate = true;
          continue;
        }
        if (char === "(") {
          depth += 1;
          continue;
        }
        if (char === ")") {
          depth -= 1;
          if (depth === 0) {
            return { inner: source.slice(openParenIndex + 1, i), end: i };
          }
        }
      }
      return null;
    }

    function splitTopLevelArguments(source) {
      const input = String(source || "");
      if (!input.trim()) return [];

      const args = [];
      let start = 0;
      let parenDepth = 0;
      let braceDepth = 0;
      let bracketDepth = 0;
      let inSingle = false;
      let inDouble = false;
      let inTemplate = false;
      let inLineComment = false;
      let inBlockComment = false;
      let escaped = false;

      for (let i = 0; i < input.length; i += 1) {
        const char = input[i];
        const next = i + 1 < input.length ? input[i + 1] : "";
        if (inLineComment) {
          if (char === "\n") inLineComment = false;
          continue;
        }
        if (inBlockComment) {
          if (char === "*" && next === "/") {
            inBlockComment = false;
            i += 1;
          }
          continue;
        }
        if (inSingle) {
          if (escaped) {
            escaped = false;
          } else if (char === "\\") {
            escaped = true;
          } else if (char === "'") {
            inSingle = false;
          }
          continue;
        }
        if (inDouble) {
          if (escaped) {
            escaped = false;
          } else if (char === "\\") {
            escaped = true;
          } else if (char === "\"") {
            inDouble = false;
          }
          continue;
        }
        if (inTemplate) {
          if (escaped) {
            escaped = false;
          } else if (char === "\\") {
            escaped = true;
          } else if (char === "`") {
            inTemplate = false;
          }
          continue;
        }
        if (char === "/" && next === "/") {
          inLineComment = true;
          i += 1;
          continue;
        }
        if (char === "/" && next === "*") {
          inBlockComment = true;
          i += 1;
          continue;
        }
        if (char === "'") {
          inSingle = true;
          continue;
        }
        if (char === "\"") {
          inDouble = true;
          continue;
        }
        if (char === "`") {
          inTemplate = true;
          continue;
        }
        if (char === "(") {
          parenDepth += 1;
          continue;
        }
        if (char === ")") {
          parenDepth = Math.max(0, parenDepth - 1);
          continue;
        }
        if (char === "{") {
          braceDepth += 1;
          continue;
        }
        if (char === "}") {
          braceDepth = Math.max(0, braceDepth - 1);
          continue;
        }
        if (char === "[") {
          bracketDepth += 1;
          continue;
        }
        if (char === "]") {
          bracketDepth = Math.max(0, bracketDepth - 1);
          continue;
        }
        if (char === "," && parenDepth === 0 && braceDepth === 0 && bracketDepth === 0) {
          args.push(input.slice(start, i).trim());
          start = i + 1;
        }
      }
      args.push(input.slice(start).trim());
      return args.filter((arg) => arg.length > 0);
    }

    function findCallArguments(searchableCode, callPath) {
      const callRe = new RegExp("\\b" + escapeRegExp(callPath) + "\\s*\\(", "g");
      const matches = [];
      let match;
      while ((match = callRe.exec(searchableCode))) {
        const openParenOffset = match[0].lastIndexOf("(");
        const openParenIndex = openParenOffset >= 0 ? (match.index + openParenOffset) : -1;
        const segment = readBalancedParentheses(searchableCode, openParenIndex);
        if (!segment) continue;
        matches.push({ argsText: segment.inner, index: match.index });
        callRe.lastIndex = Math.max(callRe.lastIndex, segment.end + 1);
      }
      return matches;
    }

    function validateCallSignatures(code, signatures) {
      const searchableCode = stripNonCodeSegments(code);
      const violations = [];
      for (const signature of signatures) {
        const calls = findCallArguments(searchableCode, signature.call);
        if (!calls.length) continue;
        for (const callSite of calls) {
          const argCount = splitTopLevelArguments(callSite.argsText).length;
          if (argCount < signature.minArgs || argCount > signature.maxArgs) {
            const expected = signature.minArgs === signature.maxArgs
              ? String(signature.minArgs)
              : `${signature.minArgs}-${signature.maxArgs}`;
            violations.push(`${signature.call} arity (expected ${expected}, got ${argCount})`);
          }
        }
      }
      return violations;
    }

    function validateKnownEnumMembers(code, enumSets) {
      const violations = [];
      const searchable = stripNonCodeSegments(code);
      const enumReferenceRe = /\b([A-Z][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\b/g;
      let match;
      while ((match = enumReferenceRe.exec(searchable))) {
        const enumName = match[1];
        const memberName = match[2];
        const allowed = enumSets[enumName];
        if (!allowed) continue;
        if (!allowed.has(memberName)) {
          violations.push(`invalid enum member ${enumName}.${memberName}`);
        }
      }
      return violations;
    }

    function buildTargetPromptExtras(target) {
      if (target !== "microbit") return [];
      return [
        "MICRO:BIT BUILT-IN ICON/ENUM RULES (from pxt-microbit):",
        "If the request matches a built-in icon name (for example duck, heart, skull), prefer basic.showIcon(IconNames.<Name>).",
        "For known icons, do NOT hand-draw LED art with basic.showLeds(`...`) unless the user explicitly asks for a custom pattern.",
        "Valid IconNames: " + MICROBIT_ICON_NAMES.map((name) => "IconNames." + name).join(", "),
        "Deprecated alias accepted only for compatibility: IconNames.EigthNote (prefer IconNames.EighthNote).",
        "Valid ArrowNames: " + MICROBIT_ARROW_NAMES.map((name) => "ArrowNames." + name).join(", "),
        "Use exact event enums: Button.A, Button.B, Button.AB; Gesture." + MICROBIT_GESTURE_NAMES.join(", Gesture."),
        "Use only valid enum members from pxt-microbit enums.d.ts (Button, Gesture, TouchPin, Dimension, Rotation, DigitalPin, AnalogPin, PulseValue, BeatFraction).",
        "Follow canonical block signatures and argument counts from pxt-microbit //% blockId APIs. Do not invent extra arguments.",
        "MICRO:BIT BLOCKS-TEST STYLE EXAMPLES (few-shot shape guidance):",
        ...MICROBIT_BLOCKS_TEST_EXAMPLES.map((example) => "- " + example)
      ];
    }

    function validateBlocksCompatibility(code, target) {
      const rules = [
        { re: /=>/g, why: "arrow functions" },
        { re: /\bclass\s+/g, why: "classes" },
        { re: /\bnew\s+[A-Z_a-z]/g, why: "new constructor" },
        { re: /\bPromise\b|\basync\b|\bawait\b/g, why: "promises/async" },
        { re: /\bimport\s|\bexport\s/g, why: "import/export" },
        { re: /\$\{[^}]+\}/g, why: "template string interpolation" },
        { re: /\.\s*(map|forEach|filter|reduce|find|some|every)\s*\(/g, why: "higher-order array methods" },
        { re: /\bnamespace\b|\bmodule\b/g, why: "namespaces/modules" },
        { re: /\benum\b|\binterface\b|\btype\s+[A-Z_a-z]/g, why: "TS types/enums" },
        { re: /<\s*[A-Z_a-z0-9_,\s]+>/g, why: "generics syntax" },
        { re: /setTimeout\s*\(|setInterval\s*\(/g, why: "timers" },
        { re: /console\./g, why: "console calls" },
        { re: /^\s*\/\//m, why: "line comments" },
        { re: /\/\*[\s\S]*?\*\//g, why: "block comments" },
        { re: /\brandint\s*\(/g, why: "randint()" },
        { re: /(\*=|\/=|%=|\|=|&=|\^=|<<=|>>=|>>>=)/g, why: "unsupported assignment operators" }
      ];
      const bitwiseRules = [
        /<<|>>>|>>/,
        /\^/,
        /(^|[^|])\|([^|=]|$)/m,
        /(^|[^&])&([^&=]|$)/m
      ];
      const eventRegistrationRe = /\b(?:basic\.forever|loops\.forever|input\.on[A-Z_a-z0-9_]*|radio\.on[A-Z_a-z0-9_]*|pins\.on[A-Z_a-z0-9_]*|controller\.[A-Z_a-z0-9_]*\.onEvent|controller\.on[A-Z_a-z0-9_]*|sprites\.on[A-Z_a-z0-9_]*|scene\.on[A-Z_a-z0-9_]*|game\.on[A-Z_a-z0-9_]*|info\.on[A-Z_a-z0-9_]*|control\.inBackground)\s*\(/;

      if ((target === "microbit" || target === "maker") && /sprites\.|controller\.|scene\.|game\.onUpdate/i.test(code)) {
        return { ok: false, violations: ["Arcade APIs in micro:bit/Maker"] };
      }
      if (target === "arcade" && (/led\./i.test(code) || /radio\./i.test(code))) {
        return { ok: false, violations: ["micro:bit APIs in Arcade"] };
      }

      const violations = [];
      const stringStrippedCode = code.replace(
        /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g,
        (match) => " ".repeat(match.length)
      );
      for (const rule of rules) {
        if (rule.re.test(code)) violations.push(rule.why);
      }
      if (/\bnull\b/.test(stringStrippedCode)) violations.push("null");
      if (/\bundefined\b/.test(stringStrippedCode)) violations.push("undefined");
      if (/\bas\s+[A-Z_a-z][A-Z_a-z0-9_.]*/.test(stringStrippedCode)) violations.push("casts");
      if (bitwiseRules.some((rule) => rule.test(code))) violations.push("bitwise operators");
      if (/\bfor\s*\([^)]*\bin\b[^)]*\)/.test(code)) violations.push("for...in loops");

      const forHeaderRe = /for\s*\(([^)]*)\)/g;
      let forMatch;
      while ((forMatch = forHeaderRe.exec(code))) {
        const header = forMatch[1].trim();
        if (/\bof\b/.test(header)) continue;
        const parts = header.split(";").map((part) => part.trim());
        if (parts.length !== 3) {
          violations.push("invalid for-loop shape");
          continue;
        }
        const initMatch = parts[0].match(/^let\s+([A-Z_a-z][A-Z_a-z0-9_]*)\s*=\s*0$/);
        if (!initMatch) {
          violations.push("for-loop initializer must be let i = 0");
          continue;
        }
        const indexVar = initMatch[1];
        if (!new RegExp("^" + indexVar + "\\s*(<|<=)\\s*.+$").test(parts[1])) {
          violations.push("for-loop condition must be i < limit or i <= limit");
        }
        if (!new RegExp("^(?:" + indexVar + "\\+\\+|\\+\\+" + indexVar + ")$").test(parts[2])) {
          violations.push("for-loop increment must be i++");
        }
      }

      const lines = code.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
      let depth = 0;
      for (const line of lines) {
        const trimmed = line.trim();
        const lineDepth = depth;
        if (trimmed) {
          if (lineDepth > 0 && eventRegistrationRe.test(trimmed)) violations.push("nested event registration");
          const fnDecl = trimmed.match(/^function\s+([A-Z_a-z][A-Z_a-z0-9_]*)\s*\(([^)]*)\)/);
          if (fnDecl) {
            if (lineDepth > 0) violations.push("non-top-level function declaration");
            const params = fnDecl[2].trim();
            if (params && (params.includes("?") || params.includes("="))) {
              violations.push("optional/default parameters in function declaration");
            }
          }
          if (/^let\s+[A-Z_a-z][A-Z_a-z0-9_]*(\s*:\s*[^=;]+)?\s*;?$/.test(trimmed)) {
            violations.push("variable declaration without initializer");
          }
        }
        const opens = (line.match(/\{/g) || []).length;
        const closes = (line.match(/\}/g) || []).length;
          depth = Math.max(0, depth + opens - closes);
      }

      if (target === "microbit") {
        violations.push(...validateKnownEnumMembers(code, MICROBIT_ENUM_MEMBER_SETS));
        violations.push(...validateCallSignatures(code, MICROBIT_CALL_SIGNATURES));
      }

      if (/[^\x09\x0A\x0D\x20-\x7E]/.test(code)) violations.push("non-ASCII characters");
      return { ok: violations.length === 0, violations: [...new Set(violations)] };
    }

    function stubForTarget(target) {
      if (target === "arcade") {
        return [
          "controller.A.onEvent(ControllerButtonEvent.Pressed, function () {",
          "    game.splash(\"Start!\")",
          "})",
          "game.onUpdate(function () {",
          "})"
        ].join("\n");
      }
      if (target === "maker") {
        return ["loops.forever(function () {", "})"].join("\n");
      }
      return [
        "basic.onStart(function () {",
        "    basic.showString(\"Hi\")",
        "})"
      ].join("\n");
    }

    function extractGeminiText(response) {
      try {
        if (!response) return "";
        if (response.promptFeedback && response.promptFeedback.blocked) return "";
        if (response.candidates && response.candidates.length > 0) {
          const candidate = response.candidates[0];
          if (candidate.finishReason && String(candidate.finishReason).toUpperCase().includes("BLOCK")) return "";
          const parts = (candidate.content && candidate.content.parts) || [];
          let text = "";
          for (const part of parts) {
            if (part.text) text += part.text;
          }
          return (text || "").trim();
        }
      } catch {
        return "";
      }
      return "";
    }

    return {
      sanitizeMakeCode,
      normaliseFeedback,
      resolvePromptTargetContext,
      buildUserPrompt,
      extractCode,
      parseModelOutput,
      validateBlocksCompatibility,
      buildTargetPromptExtras,
      stubForTarget,
      extractGeminiText,
    };
  })();
  // END_SHARED_COMPAT_CORE

  let BASE_TEMP = 0.1;
  let MAXTOK = 3072;

  const sysFor = (target) => {
    const { namespaceList, targetName } = resolvePromptTargetContext(target);
    const targetPromptExtras = buildTargetPromptExtras(target);
    return [
      "ROLE: You are a friendly Microsoft MakeCode assistant helping a student build a " + targetName + " project. You are having a conversation – be helpful, brief, and encouraging.",
      "HARD REQUIREMENT: Return ONLY Microsoft MakeCode Static JavaScript that the MakeCode decompiler can convert to BLOCKS for " + targetName + " with ZERO errors.",
      "CONVERSATION CONTEXT: If RECENT_CHAT is provided, use only that recent context. Treat CURRENT_CODE as the source of truth for project state.",
      "CONTEXT LIMITS: CURRENT_CODE may include a truncation note if the project is large. When truncated, make conservative edits and preserve existing patterns.",
      "RESPONSE FORMAT (required): Return ONLY compact JSON with keys feedback and code.",
      "FORMAT DETAILS: {\"feedback\":[\"short note\"],\"code\":\"MakeCode Static TypeScript with \\\\n escapes\"}.",
      "FEEDBACK RULE: feedback must be an array with at least one short string.",
      "CODE RULE: code must be MakeCode Static TypeScript encoded as a JSON string (use escaped \\n for new lines, no markdown fences).",
      "NO COMMENTS inside the code.",
      "ERROR FIXING: If PAGE_ERRORS are provided, treat them as failing diagnostics and prioritise resolving all of them in your output.",
      "BLOCKS CONVERSION: If CONVERSION_DIALOG is provided, ensure the output can be converted from JavaScript back to Blocks in MakeCode.",
      "ALLOWED APIS: " + namespaceList + ". Prefer event handlers and forever/update loops.",
      ...targetPromptExtras,
      "RANDOMNESS: For random choices, prefer list._pickRandom() from an array of options. Do NOT use randint(...).",
      "BLOCK-SAFE REQUIREMENTS (hard): no grey JavaScript blocks; every variable declaration must have an initializer; for loops must be exactly for (let i = 0; i < limit; i++) or for (let i = 0; i <= limit; i++); event registrations and function declarations must be top-level; no optional/default params in user-defined functions; callbacks/event handlers must not return a value; do not pass more arguments than block signatures support; statement assignment operators are limited to =, +=, -=.",
      "FORBIDDEN IN OUTPUT: arrow functions (=>), classes, new constructors, async/await/Promise, import/export, template strings (`), higher-order array methods (map/filter/reduce/forEach/find/some/every), namespaces/modules, enums, interfaces, type aliases, generics, timers (setTimeout/setInterval), console calls, markdown, onstart functions, null, undefined, as-casts, bitwise operators (| & ^ << >> >>>) and bitwise compound assignments.",
      "TARGET-SCOPE: Use ONLY APIs valid for " + targetName + ". Never mix Arcade APIs into micro:bit/Maker or vice versa.",
      "STYLE: Straight quotes, ASCII only, use function () { } handlers.",
      "IF UNSURE: Return a minimal program that is guaranteed to decompile to BLOCKS for " + targetName + ". Code only."
    ].join("\n");
  };

  const MAX_CURRENT_CODE_PROMPT_CHARS = 12000;
  const CURRENT_CODE_TRUNCATION_MARKER = "\n// ... CURRENT_CODE_TRUNCATED ...\n";

  const userFor = (request, currentCode, pageErrors, conversionDialog, recentChat) => {
    return buildUserPrompt({
      request,
      currentCode,
      pageErrors,
      conversionDialog,
      recentChat,
      maxCurrentCodeChars: MAX_CURRENT_CODE_PROMPT_CHARS,
      truncationMarker: CURRENT_CODE_TRUNCATION_MARKER
    });
  };

  /* ── provider calls ──────────────────────────────────────── */
  const REQ_TIMEOUT_MS = 60000;
  const EMPTY_RETRIES = 2;

  const withTimeout = (promise, ms, label) => {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error((label || "request") + " timeout")), ms))
    ]);
  };



  const parseModelList = (model) => {
    if (!model) return [];
    return model.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
  };

  const callOpenAI = (key, model, system, user, signal) => {
    const resolvedModel = model || "gpt-5.2";
    const body = {
      model: resolvedModel,
      messages: [{ role: "system", content: system }, { role: "user", content: user }]
    };
    if (/^gpt-5/i.test(resolvedModel)) {
      // GPT-5 chat models require max_completion_tokens and reject non-default temperature.
      body.max_completion_tokens = MAXTOK;
    } else {
      body.temperature = BASE_TEMP;
      body.max_tokens = MAXTOK;
    }
    return withTimeout(
      fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
        body: JSON.stringify(body),
        signal
      })
        .then((response) => {
          if (!response.ok) return response.text().then((text) => { throw new Error(text); });
          return response.json();
        })
        .then((data) => ((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "").trim()),
      REQ_TIMEOUT_MS,
      "OpenAI"
    );
  };

  const callGemini = (key, model, system, user, signal) => {
    const url = "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model || "gemini-3-flash-preview") + ":generateContent?key=" + encodeURIComponent(key);
    const body = {
      contents: [{ role: "user", parts: [{ text: system + "\n\n" + user }] }],
      generationConfig: { temperature: BASE_TEMP, maxOutputTokens: MAXTOK }
    };
    return withTimeout(
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal
      })
        .then((response) => {
          if (!response.ok) return response.text().then((text) => { throw new Error(text); });
          return response.json();
        })
        .then((data) => extractGeminiText(data)),
      REQ_TIMEOUT_MS,
      "Gemini"
    );
  };

  const callOpenRouter = (key, model, system, user, signal) => {
    const models = parseModelList(model);
    const queue = models.length ? models : ["openrouter/auto"];
    const headers = {
      "Content-Type": "application/json",
      Authorization: "Bearer " + key
    };
    try { headers["HTTP-Referer"] = location && location.origin ? location.origin : ""; } catch (error) {}
    try { if (document && document.title) headers["X-Title"] = document.title; } catch (error) {}

    const sendForModel = (modelId) => {
      const body = {
        model: modelId,
        temperature: BASE_TEMP,
        max_tokens: MAXTOK,
        messages: [{ role: "system", content: system }, { role: "user", content: user }]
      };
      return withTimeout(
        fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal
        })
          .then((response) => {
            if (!response.ok) return response.text().then((text) => { throw new Error(text || ("HTTP " + response.status)); });
            return response.json();
          })
          .then((data) => ((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "").trim()),
        REQ_TIMEOUT_MS,
        "OpenRouter " + modelId
      );
    };

    const attempt = (index) => {
      if (index >= queue.length) return Promise.reject(new Error("All OpenRouter models failed"));
      const modelName = queue[index];
      logLine("OpenRouter trying " + modelName + ".");
      return sendForModel(modelName)
        .then((result) => {
          if (result && result.trim()) return result;
          if (index < queue.length - 1) {
            logLine("Model " + modelName + " returned empty result. Trying next model.");
            return attempt(index + 1);
          }
          return result;
        })
        .catch((error) => {
          if (isAbortError(error)) throw error;
          if (index < queue.length - 1) {
            logLine("Model " + modelName + " failed: " + (error && error.message ? error.message : String(error)) + ". Trying next model.");
            return attempt(index + 1);
          }
          throw error;
        });
    };

    return attempt(0);
  };

  const askValidated = (provider, apiKey, model, system, user, target, signal) => {
    const providers = { openai: callOpenAI, gemini: callGemini, openrouter: callOpenRouter };
    const names = { openai: "OpenAI", gemini: "Gemini", openrouter: "OpenRouter" };
    const callProvider = providers[provider] || providers.openai;

    const oneAttempt = (extraSystem, insistOnlyCode) => {
      const prompt = system
        + (extraSystem ? ("\n" + extraSystem) : "")
        + (insistOnlyCode ? "\nMANDATE: Output only compact JSON with keys feedback (array) and code (string). No prose." : "");
      const providerName = names[provider] || provider;
      logLine("Sending to " + providerName + " (" + (model || "default") + ").");
      throwIfAborted(signal);
      return callProvider(apiKey, model, prompt, user, signal).then((raw) => {
        throwIfAborted(signal);
        const parsed = parseModelOutput(raw);
        const code = sanitizeMakeCode(parsed.code);
        const validation = validateBlocksCompatibility(code, target);
        return { code, validation, feedback: parsed.feedback };
      });
    };

    return oneAttempt(null, false)
      .then((result) => {
        if (result.code && result.code.trim()) return result;
        const retryEmpty = (index, previous) => {
          if (index >= EMPTY_RETRIES) return previous;
          const extra = "Your last message had empty code. Return valid JSON only with feedback[] and code string.";
          return oneAttempt(extra, true).then((next) => {
            throwIfAborted(signal);
            if (next.code && next.code.trim()) return next;
            return retryEmpty(index + 1, next);
          });
        };
        return retryEmpty(0, result);
      })
      .then((firstPass) => {
        if (!firstPass.code || !firstPass.code.trim()) return firstPass;
        if (firstPass.validation && firstPass.validation.ok) return firstPass;
        const violations = (firstPass.validation && firstPass.validation.violations) || [];
        const extra = "Previous code used: " + violations.join(", ") + ". Remove ALL forbidden constructs. Use only " + (target === "arcade" ? "Arcade" : "micro:bit/Maker") + " APIs.";
        return oneAttempt(extra, true).then((secondPass) => {
          throwIfAborted(signal);
          if (secondPass.validation && secondPass.validation.ok) return secondPass;
          const secondViolations = (secondPass.validation && secondPass.validation.violations) || [];
          const strictExtra = "STRICT MODE: Output a smaller program that fully decompiles to Blocks. Absolutely no: " + secondViolations.join(", ") + ".";
          return oneAttempt(strictExtra, true);
        });
      })
      .then((finalResult) => {
        const feedback = normaliseFeedback(finalResult && finalResult.feedback);
        if (!finalResult || !finalResult.code || !finalResult.code.trim()) {
          logLine("Model returned no code after retries. Using minimal stub.");
          return { code: stubForTarget(target), feedback: normaliseFeedback(feedback.concat(["Model returned no code; provided fallback stub."])) };
        }
        if (!finalResult.validation || !finalResult.validation.ok) {
          const violations = (finalResult.validation && finalResult.validation.violations) || [];
          logLine("Model output still failed strict validation. Using minimal stub.");
          return { code: stubForTarget(target), feedback: normaliseFeedback(feedback.concat(["Validation fallback: " + (violations.join(", ") || "unknown compatibility issue")])) };
        }
        return { code: finalResult.code, feedback };
      });
  };

  const parseJsonSafe = async (response) => {
    try {
      return await response.json();
    } catch (error) {
      return null;
    }
  };

  const connectManagedSession = async (backendUrl, classCode, signal) => {
    const normalizedCode = normaliseClassCode(classCode);
    if (!normalizedCode || APP_TOKEN) return "";

    const existingSession = getStoredManagedSession();
    if (existingSession) return existingSession;

    logLine("Connecting to classroom server...");
    const response = await fetch(backendUrl + "/vibbit/connect", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Vibbit-Class-Code": normalizedCode
      },
      body: JSON.stringify({ classCode: normalizedCode }),
      signal
    });

    if (response.status === 404 || response.status === 405) {
      return "";
    }

    const json = await parseJsonSafe(response);
    if (!response.ok) {
      const message = json && json.error
        ? json.error
        : (response.status === 401 ? "Invalid class code." : ("Classroom connect failed (HTTP " + response.status + ")."));
      throw new Error(message);
    }

    const token = json && typeof json.sessionToken === "string" ? json.sessionToken.trim() : "";
    if (!token) return "";
    saveManagedSession(token, json.expiresAt);
    logLine("Connected to classroom session.");
    return token;
  };

  const buildBackendHeaders = async (backendUrl, signal) => {
    const headers = { "Content-Type": "application/json" };
    if (APP_TOKEN) {
      headers.Authorization = "Bearer " + APP_TOKEN;
      return headers;
    }

    const classCode = getStoredClassCode();
    if (classCode) headers["X-Vibbit-Class-Code"] = classCode;

    const sessionToken = await connectManagedSession(backendUrl, classCode, signal);
    if (sessionToken) headers.Authorization = "Bearer " + sessionToken;
    return headers;
  };

  const requestBackendGenerate = async (payload, signal) => {
    const backendUrl = getBackendUrl();
    const managedController = new AbortController();
    let timedOut = false;

    const abortFromCaller = () => {
      managedController.abort();
    };

    if (signal) {
      if (signal.aborted) abortFromCaller();
      else signal.addEventListener("abort", abortFromCaller, { once: true });
    }

    const timeoutId = setTimeout(() => {
      timedOut = true;
      managedController.abort();
    }, REQ_TIMEOUT_MS);

    const doRequest = async () => {
      const headers = await buildBackendHeaders(backendUrl, managedController.signal);
      return fetch(backendUrl + "/vibbit/generate", {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: managedController.signal
      });
    };

    try {
      let response = await doRequest();
      if (response.status === 401 && !APP_TOKEN && getStoredClassCode()) {
        clearManagedSession();
        response = await doRequest();
      }

      if (response.ok) return response.json();
      let message = "HTTP " + response.status;
      const json = await parseJsonSafe(response);
      if (json && json.error) message = json.error;
      throw new Error(message);
    } catch (error) {
      if (timedOut) throw new Error("The server took too long to respond. Please try again.");
      throw error;
    } finally {
      clearTimeout(timeoutId);
      if (signal) signal.removeEventListener("abort", abortFromCaller);
    }
  };

  const RECENT_CHAT_TOTAL_CHARS = 1200;
  const RECENT_CHAT_USER_CHARS = 420;
  const RECENT_CHAT_ASSISTANT_CHARS = 420;
  const RECENT_CHAT_TRUNCATION_SUFFIX = " [truncated]";

  const clampPromptText = (value, maxChars) => {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    if (!text) return "";
    if (!maxChars || maxChars < 1 || text.length <= maxChars) return text;
    if (maxChars <= RECENT_CHAT_TRUNCATION_SUFFIX.length + 1) {
      return text.slice(0, maxChars);
    }
    return text.slice(0, maxChars - RECENT_CHAT_TRUNCATION_SUFFIX.length).trimEnd() + RECENT_CHAT_TRUNCATION_SUFFIX;
  };

  /* Keep prompt context bounded: only last user message + last assistant notes. */
  const buildRecentChatContext = () => {
    let lastUser = "";
    let lastUserIdx = -1;
    let lastAssistant = "";
    let lastAssistantIdx = -1;

    for (let i = chatMessages.length - 1; i >= 0; i--) {
      const msg = chatMessages[i];
      if (!msg) continue;

      if (lastAssistantIdx < 0 && msg.role === "assistant") {
        const notes = Array.isArray(msg.feedback) && msg.feedback.length
          ? msg.feedback.join(" | ")
          : (msg.content || "");
        lastAssistant = clampPromptText(notes, RECENT_CHAT_ASSISTANT_CHARS);
        lastAssistantIdx = i;
        continue;
      }

      if (lastUserIdx < 0 && msg.role === "user" && msg.content) {
        lastUser = clampPromptText(msg.content, RECENT_CHAT_USER_CHARS);
        lastUserIdx = i;
      }

      if (lastUserIdx >= 0 && lastAssistantIdx >= 0) break;
    }

    const orderedTurns = [];
    if (lastUserIdx >= 0 && lastAssistantIdx >= 0) {
      if (lastUserIdx < lastAssistantIdx) {
        orderedTurns.push({ role: "user", content: lastUser });
        orderedTurns.push({ role: "assistant", notes: lastAssistant });
      } else {
        orderedTurns.push({ role: "assistant", notes: lastAssistant });
        orderedTurns.push({ role: "user", content: lastUser });
      }
    } else {
      if (lastAssistantIdx >= 0) orderedTurns.push({ role: "assistant", notes: lastAssistant });
      if (lastUserIdx >= 0) orderedTurns.push({ role: "user", content: lastUser });
    }

    const context = [];
    let used = 0;
    const pushTurn = (turn) => {
      if (!turn) return;
      const text = turn.role === "user" ? turn.content : turn.notes;
      if (!text) return;
      if (used >= RECENT_CHAT_TOTAL_CHARS) return;
      const remaining = RECENT_CHAT_TOTAL_CHARS - used;
      const clipped = clampPromptText(text, remaining);
      if (!clipped) return;
      if (turn.role === "user") context.push({ role: "user", content: clipped });
      else context.push({ role: "assistant", notes: clipped });
      used += clipped.length;
    };

    orderedTurns.forEach(pushTurn);
    return context;
  };

  /* ── generate handler ────────────────────────────────────── */
  const sendMessage = (forcedRequestOverride, forcedDialogOverride) => {
    if (busy) return;
    stopLoadingTicker();

    const request = forcedRequestOverride || (promptEl.value || "").trim();
    const forcedDialog = forcedDialogOverride || null;
    const recentChatContext = buildRecentChatContext();
    let includeCurrentForThisSend = true;

    /* add user message to chat */
    if (!forcedRequestOverride) {
      if (!request) {
        setStatus("Idle");
        logLine("Please enter a request.");
        return;
      }
      if (freshStartOnNextSend) {
        includeCurrentForThisSend = false;
        freshStartOnNextSend = false;
      }
      addChatMessage({ role: "user", content: request });
      promptEl.value = "";
      promptEl.style.height = "auto";
    }

    retirePreviousAssistantActions();

    /* add assistant placeholder */
    const assistantIdx = addChatMessage({ role: "assistant", content: "Generating...", status: "generating" });
    startLoadingTicker(assistantIdx, "model");

    busy = true;
    setBusyIndicator(true);
    clearLog();
    setStatus("Working");
    logLine("Generating...");
    go.disabled = true;
    go.style.opacity = "0.7";
    go.style.cursor = "not-allowed";

    const mode = storageGet(STORAGE_MODE) || "byok";
    const target = storageGet(STORAGE_TARGET) || "microbit";
    const undoDepthBeforeGenerate = undoStack.length;
    generationController = new AbortController();
    const signal = generationController.signal;
    let conversionRetryCount = 0;
    let lastGeneratedCode = "";
    let finalFeedback = [];

    const runGenerationAttempt = (forcedRequest, forcedDlg, options) => {
      const shouldSnapshot = !options || options.snapshot !== false;
      const editorCtxPromise = findMonacoCtx(18000, signal)
        .then((ctx) => {
          throwIfAborted(signal);
          return ctx;
        })
        .catch((error) => {
          if (isAbortError(error) || signal.aborted) throw error;
          return null;
        });

      const currentPromise = includeCurrentForThisSend
        ? editorCtxPromise
          .then((ctx) => {
            throwIfAborted(signal);
            if (!ctx) {
              logLine("Could not read current code.");
              return "";
            }
            logLine("Reading current JavaScript.");
            return ctx.model.getValue() || "";
          })
          .catch((error) => {
            if (isAbortError(error) || signal.aborted) throw error;
            logLine("Could not read current code.");
            return "";
          })
        : Promise.resolve("").then(() => {
          logLine("Fresh start active: skipping current code for this send.");
          return "";
        });

      const pageContextPromise = editorCtxPromise
        .then((ctx) => {
          throwIfAborted(signal);
          return collectPageContext(ctx);
        })
        .catch((error) => {
          if (isAbortError(error) || signal.aborted) throw error;
          return collectPageContext(null);
        });

      return Promise.all([currentPromise, pageContextPromise])
        .then(([currentCode, pageContext]) => {
          throwIfAborted(signal);
          const pageErrors = pageContext && Array.isArray(pageContext.errors) ? pageContext.errors.slice() : [];
          let conversionDialog = (pageContext && pageContext.conversionDialog) || forcedDlg || null;
          if (conversionDialog) {
            lastConversionDialog = conversionDialog;
            const hasDialogPrefix = pageErrors.some((line) => /^ConvertDialog:/i.test(String(line)));
            if (!hasDialogPrefix) {
              if (conversionDialog.title) pageErrors.push("ConvertDialog: " + conversionDialog.title);
              if (conversionDialog.description) pageErrors.push("ConvertDialog: " + conversionDialog.description);
            }
          }

          if (pageErrors.length) {
            logLine("Detected page errors (" + pageErrors.length + "):");
            pageErrors.forEach((line, index) => logLine("  " + (index + 1) + ". " + line));
          } else {
            logLine("No page errors detected.");
          }

          let effectiveRequest = (forcedRequest || "").trim() || request;
          if (!effectiveRequest) {
            if (!pageErrors.length && !conversionDialog) {
              throw new Error("Please enter a request.");
            }
            if (conversionDialog) {
              effectiveRequest = buildConversionFixRequest(conversionDialog);
              logLine("No prompt entered; using conversion-fix request.");
            } else {
              effectiveRequest = "Fix the current project by resolving all listed page errors while preserving existing behaviour unless a change is needed for the fix.";
              logLine("No prompt entered; using automatic error-fix request.");
            }
          }

          setLoadingPhase("model");

          if (mode === "managed") {
            logLine("Mode: Managed backend.");
            return requestBackendGenerate({ target, request: effectiveRequest, currentCode, pageErrors, conversionDialog }, signal);
          }

          const provider = storageGet(STORAGE_PROVIDER) || "openai";
          const apiKey = getStoredProviderKey(provider).trim();
          if (!apiKey) throw new Error("Enter API key for BYOK mode (open Settings).");
          const model = storageGet(STORAGE_MODEL) || "";

          logLine("Mode: BYOK.");
          return askValidated(provider, apiKey, model, sysFor(target), userFor(effectiveRequest, currentCode, pageErrors, conversionDialog, recentChatContext), target, signal);
        })
        .then((result) => {
          throwIfAborted(signal);
          finalFeedback = normaliseFeedback(result && result.feedback);

          const code = extractCode(result && result.code ? result.code : "");
          lastGeneratedCode = code;
          if (!code) {
            finalFeedback = normaliseFeedback(
              finalFeedback.concat(["Model returned no code for this request."]),
              DEFAULT_FEEDBACK_MESSAGE
            );
            renderFeedback(finalFeedback);
            setStatus("No code");
            logLine("No code returned.");
            updateAssistantMessage(assistantIdx, { content: "No code was returned by the model.", status: "error", feedback: finalFeedback });
            return;
          }

          setLoadingPhase("apply");
          setStatus("Pasting");
          return pasteToMakeCode(code, { signal, snapshot: shouldSnapshot })
            .catch((error) => {
              throwIfAborted(signal);
              if (isConversionDialogError(error)) throw error;
              const message = error && error.message ? error.message : String(error);
              if (!/grey JavaScript block/i.test(message)) throw error;
              logLine("Live decompile check failed: " + message);
              logLine("Applying minimal fallback stub.");
              finalFeedback = normaliseFeedback(finalFeedback.concat(["Live editor fallback: " + message]));
              return pasteToMakeCode(stubForTarget(target), { snapshot: false, signal });
            })
            .then(() => {
              throwIfAborted(signal);
              finalFeedback = normaliseFeedback(finalFeedback, DEFAULT_FEEDBACK_MESSAGE);
              renderFeedback(finalFeedback);
              hideFixConvertButton();
              setStatus("Done");
              logLine("Pasted and switched back to Blocks.");
              updateAssistantMessage(assistantIdx, { status: "done", feedback: finalFeedback, code: lastGeneratedCode, content: "" });
            });
        });
    };

    const handleGenerationFailure = (error) => {
      if (isAbortError(error) || signal.aborted) {
        const shouldRestore = undoStack.length > undoDepthBeforeGenerate;
        if (!shouldRestore) {
          setStatus("Cancelled");
          logLine("Generation cancelled.");
          updateAssistantMessage(assistantIdx, { status: "cancelled", content: "Generation cancelled." });
          return;
        }
        logLine("Generation cancelled after code updates. Restoring previous snapshot...");
        return revertEditor()
          .then(() => {
            setStatus("Cancelled");
            logLine("Previous code restored after cancellation.");
            updateAssistantMessage(assistantIdx, { status: "cancelled", content: "Generation cancelled. Previous code restored." });
          })
          .catch((restoreError) => {
            setStatus("Error");
            logLine("Restore after cancellation failed: " + (restoreError && restoreError.message ? restoreError.message : String(restoreError)));
            updateAssistantMessage(assistantIdx, { status: "error", content: "Cancelled, but could not restore previous code." });
          });
      }

      if (isConversionDialogError(error)) {
        const dialog = (error && error.dialog) || lastConversionDialog || null;
        lastConversionDialog = dialog;
        if (conversionRetryCount < 1) {
          conversionRetryCount += 1;
          includeCurrentForThisSend = true;
          logLine("MakeCode could not convert to Blocks. Retrying once with a conversion-fix prompt.");
          logLine("Retry will include current JavaScript context.");
          setLoadingPhase("convert");
          return runGenerationAttempt(buildConversionFixRequest(dialog), dialog, { snapshot: false }).catch(handleGenerationFailure);
        }
        setStatus("Needs fix");
        logLine("Still unable to convert to Blocks after retry.");
        updateAssistantMessage(assistantIdx, { status: "convert-error", feedback: finalFeedback, content: "", code: lastGeneratedCode });
        return;
      }

      const message = error && error.message ? error.message : String(error);
      setStatus("Error");
      finalFeedback = normaliseFeedback(finalFeedback, DEFAULT_FAILURE_FEEDBACK);
      renderFeedback(finalFeedback);
      setActivity("Generation failed. Check logs.", "error", true);
      logLine("Request failed: " + message);
      updateAssistantMessage(assistantIdx, { status: "error", content: message });
    };

    runGenerationAttempt(forcedRequestOverride || null, forcedDialog)
      .catch(handleGenerationFailure)
      .finally(() => {
        stopLoadingTicker();
        generationController = null;
        busy = false;
        setBusyIndicator(false);
        go.disabled = false;
        go.style.opacity = "";
        go.style.cursor = "";
      });
  };

  go.onclick = () => sendMessage();

  const handleCancelGeneration = () => {
    if (!busy || !generationController) return;
    const currentAssistantIdx = loadingAssistantIdx;
    stopLoadingTicker();
    if (currentAssistantIdx >= 0) {
      updateAssistantMessage(currentAssistantIdx, { status: "generating", content: "Cancelling..." }, { persist: false });
    }
    setStatus("Cancelling");
    logLine("Cancelling generation...");
    generationController.abort();
  };

  /* ── handle revert from chat action button ───────────── */
  const handleRevert = () => {
    if (busy || !undoStack.length) return;
    busy = true;
    setBusyIndicator(true);
    logLine("Reverting to previous snapshot...");
    revertEditor()
      .then(() => {
        logLine("Revert complete.");
        /* add a system message to chat */
        addChatMessage({ role: "assistant", content: "Reverted to previous code.", status: "cancelled" });
      })
      .catch((error) => {
        logLine("Revert failed: " + (error && error.message ? error.message : String(error)));
      })
      .finally(() => {
        busy = false;
        setBusyIndicator(false);
      });
  };

  /* ── handle fix conversion from chat action button ──── */
  const handleFixConvert = () => {
    if (busy) return;
    const dialog = lastConversionDialog || null;
    const fixRequest = buildConversionFixRequest(dialog);
    addChatMessage({ role: "user", content: "Fix the block conversion error" });
    sendMessage(fixRequest, dialog);
  };

  /* (revert and drag/resize removed — handled by chat UI buttons) */
})();
