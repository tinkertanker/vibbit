const BACKEND = "https://vibbit.dev.tk.sg";
const APP_TOKEN = ""; // set only if your server enforces SERVER_APP_TOKEN

(function () {
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

  /* ── panel container ─────────────────────────────────────── */
  const ui = document.createElement("div");
  ui.id = "vibbit-panel";
  ui.style.cssText = "position:fixed;right:12px;bottom:12px;width:460px;max-height:84vh;overflow:auto;background:#0b1020;color:#e6e8ef;font-family:system-ui,Segoe UI,Arial,sans-serif;border:1px solid #21304f;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.35);display:none;flex-direction:column;z-index:2147483646;transform-origin:bottom right;transition:transform .2s ease,opacity .2s ease";

  /* ── build HTML ──────────────────────────────────────────── */
  ui.innerHTML = ""
    /* ═══ VIEW 1: SETUP ═══ */
    + '<div id="bv-setup" style="display:none;flex-direction:column">'

    /* header */
    + '<div id="h-setup" style="cursor:move;display:flex;align-items:center;padding:10px 12px;background:#111936;border-bottom:1px solid #21304f">'
    + '  <span style="display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;margin-right:8px">' + SETUP_HEADER_FROG_MARK + '</span>'
    + '  <span style="font-weight:600;font-size:13px">Vibbit</span>'
    + '  <button id="x-setup" aria-label="Close" style="margin-left:auto;' + S_ICON_BTN + '">' + CLOSE_SVG + '</button>'
    + '</div>'

    /* body */
    + '<div style="padding:16px 14px;display:grid;gap:12px">'
    + '  <div style="font-size:15px;font-weight:600;color:#e6e8ef">Welcome to Vibbit</div>'

    /* mode */
    + '  <div style="display:grid;gap:4px">'
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
    + '  </div>'

    /* get started */
    + '  <button id="setup-go" style="' + S_BTN_PRIMARY + ';margin-top:4px">Get Started</button>'
    + '</div>'
    + '</div>'

    /* ═══ VIEW 2: MAIN ═══ */
    + '<div id="bv-main" style="display:none;flex-direction:column">'

    /* header */
    + '<div id="h-main" style="cursor:move;display:flex;align-items:center;padding:10px 12px;background:#111936;border-bottom:1px solid #21304f">'
    + '  <span style="display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;margin-right:8px">' + MAIN_HEADER_FROG_MARK + '</span>'
    + '  <span style="font-weight:600;font-size:13px">Vibbit</span>'
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

    /* body */
    + '<div style="padding:12px 14px;display:grid;gap:10px;align-content:start;min-height:170px">'
    + '  <textarea id="p" rows="6" placeholder="Describe what you want the block code to do \u2013 try to be specific" style="resize:vertical;min-height:96px;padding:10px;border-radius:8px;border:1px solid #29324e;background:#0b1020;color:#e6e8ef;font-size:13px;line-height:1.4"></textarea>'
    + '  <label style="display:flex;gap:6px;align-items:center;font-size:12px;color:#c7d2fe;cursor:pointer"><input id="inc" type="checkbox" checked style="cursor:pointer">Use current code</label>'
    + '  <div style="display:flex;gap:8px;align-items:center">'
    + '    <button id="go" style="flex:1 1 auto;padding:10px;border:none;border-radius:8px;background:#3454D1;color:#fff;font-weight:600;cursor:pointer">Generate</button>'
    + '    <button id="revert" aria-label="Revert to previous code" title="Revert to previous code" style="width:38px;height:38px;display:none;align-items:center;justify-content:center;border:1px solid #2b3a5a;border-radius:999px;background:#1a2745;color:#d6e4ff;cursor:pointer" disabled><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 4.5H8a4.5 4.5 0 1 1-4.5 4.5"/><path d="M3.5 4.5L6 2"/><path d="M3.5 4.5 6 7"/></svg></button>'
    + '  </div>'
    + '  <button id="fix-convert" style="display:none;padding:8px 10px;border:1px solid #3b4c76;border-radius:8px;background:#17233f;color:#d6e4ff;font-size:12px;font-weight:600;cursor:pointer">Fix convert error</button>'
    + '  <div id="activity" style="min-height:18px;font-size:12px;line-height:1.2;color:#9bb1dd" aria-live="polite"></div>'
    + '</div>'

    /* feedback */
    + '<div id="fb" style="display:none;margin:0 12px 10px;padding:12px;border-radius:10px;background:linear-gradient(135deg,#1b2441,#101a33);border:1px solid #354b7d;box-shadow:0 4px 18px rgba(0,0,0,.3);">'
    + '  <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;">'
    + '    <div style="font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#8fb7ff;display:flex;align-items:center;gap:6px;">'
    + '      <span style="display:inline-flex;width:16px;height:16px;align-items:center;justify-content:center;border-radius:50%;background:#3b82f6;color:#0b1020;font-weight:700;font-size:10px;">i</span>'
    + '      Model Feedback'
    + '    </div>'
    + '    <button id="fbToggle" aria-label="Toggle feedback" style="background:rgba(148,163,255,0.15);color:#cdd9ff;border:1px solid rgba(148,163,255,0.3);border-radius:16px;padding:2px 10px;font-size:11px;font-weight:500;cursor:pointer;">Hide</button>'
    + '  </div>'
    + '  <div id="fbLines" style="display:grid;gap:6px;font-size:12px;color:#e4ecff;line-height:1.35;"></div>'
    + '</div>'

    /* log */
    + '<div style="margin:0 12px 10px;padding-top:8px;border-top:1px solid #1f2b47;">'
    + '  <button id="logToggle" aria-expanded="false" style="background:transparent;border:none;color:#98add7;font-size:11px;cursor:pointer;padding:0;line-height:1.2">Show logs</button>'
    + '  <div id="log" style="margin-top:8px;padding:8px 10px;font-size:11px;line-height:1.2;color:#9bb1dd;display:none;max-height:132px;overflow:auto;background:#0e162f;border:1px solid #22325a;border-radius:8px"></div>'
    + '</div>'
    + '</div>'

    /* ═══ VIEW 3: SETTINGS ═══ */
    + '<div id="bv-settings" style="display:none;flex-direction:column">'

    /* header */
    + '<div id="h-settings" style="cursor:move;display:flex;align-items:center;padding:10px 12px;background:#111936;border-bottom:1px solid #21304f">'
    + '  <button id="back" aria-label="Back" style="' + S_ICON_BTN + ';margin-right:6px"><svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 1L3 7l6 6"/></svg></button>'
    + '  <span style="font-weight:600;font-size:13px">Settings</span>'
    + '  <button id="x-settings" aria-label="Close" style="margin-left:auto;' + S_ICON_BTN + '">' + CLOSE_SVG + '</button>'
    + '</div>'

    /* body */
    + '<div style="padding:14px;display:grid;gap:12px">'

    /* mode */
    + '  <div style="display:grid;gap:4px">'
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
    + '</div>'

    /* resizer */
    + '<div id="rz" style="position:absolute;width:14px;height:14px;right:2px;bottom:2px;cursor:nwse-resize;background:linear-gradient(135deg,transparent 50%,#2b3a5a 50%);opacity:.9"></div>';

  document.body.appendChild(ui);
  const interactionOverlay = document.createElement("div");
  interactionOverlay.id = "vibbit-interaction-overlay";
  interactionOverlay.setAttribute("aria-hidden", "true");
  interactionOverlay.innerHTML = ""
    + '<div id="vibbit-overlay-card" data-mode="working" role="dialog" aria-modal="true" aria-labelledby="vibbit-overlay-label">'
    + '  <div id="vibbit-overlay-icon-wrap" aria-hidden="true">'
    + '    <svg id="vibbit-overlay-spinner" viewBox="0 0 44 44" fill="none" stroke="#c8d8ff" stroke-width="3">'
    + '      <circle cx="22" cy="22" r="16" stroke-opacity=".22"></circle>'
    + '      <path d="M22 6a16 16 0 0 1 16 16" stroke-linecap="round"></path>'
    + '    </svg>'
    + '    <svg id="vibbit-overlay-done" viewBox="0 0 44 44" fill="none" stroke="#9ef1b2" stroke-width="3">'
    + '      <circle cx="22" cy="22" r="16" stroke-opacity=".35"></circle>'
    + '      <path d="M14 23l6 6 10-12" stroke-linecap="round" stroke-linejoin="round"></path>'
    + '    </svg>'
    + '  </div>'
    + '  <div id="vibbit-overlay-label" role="status" aria-live="polite" aria-atomic="true">Generating code...</div>'
    + '  <button id="vibbit-overlay-cancel" type="button" style="min-width:84px;height:30px;padding:0 12px;border-radius:999px;border:1px solid rgba(124,153,232,.45);background:#15213f;color:#dbe6ff;font-size:12px;font-weight:600;line-height:1;display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;appearance:none;-webkit-appearance:none;cursor:pointer">Cancel</button>'
    + '</div>';
  document.body.appendChild(interactionOverlay);

  const runtimeStyle = document.createElement("style");
  runtimeStyle.textContent = [
    "@keyframes vibbit-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}",
    "@keyframes vibbit-overlay-pop{0%{transform:scale(.72);opacity:0}60%{transform:scale(1.08);opacity:1}100%{transform:scale(1);opacity:1}}",
    "#vibbit-interaction-overlay{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(6,10,20,.56);backdrop-filter:blur(2px);z-index:2147483647;opacity:0;visibility:hidden;pointer-events:none;transition:opacity .18s ease,visibility .18s ease}",
    "#vibbit-interaction-overlay[data-active='true']{opacity:1;visibility:visible;pointer-events:auto}",
    "#vibbit-overlay-card{min-width:176px;padding:14px 18px;border-radius:12px;border:1px solid rgba(101,126,190,.35);background:rgba(10,17,35,.94);box-shadow:0 10px 32px rgba(0,0,0,.45);color:#e6e8ef;display:grid;justify-items:center;gap:9px}",
    "#vibbit-overlay-icon-wrap{position:relative;width:44px;height:44px;display:flex;align-items:center;justify-content:center}",
    "#vibbit-overlay-spinner,#vibbit-overlay-done{position:absolute;top:0;left:0;width:44px;height:44px;transition:opacity .2s ease,transform .2s ease}",
    "#vibbit-overlay-spinner{animation:vibbit-spin .9s linear infinite;opacity:1;transform:scale(1)}",
    "#vibbit-overlay-done{opacity:0;transform:scale(.72)}",
    "#vibbit-overlay-card[data-mode='done'] #vibbit-overlay-spinner{opacity:0;transform:scale(.82)}",
    "#vibbit-overlay-card[data-mode='done'] #vibbit-overlay-done{opacity:1;transform:scale(1);animation:vibbit-overlay-pop .32s ease}",
    "#vibbit-overlay-label{font-size:13px;font-weight:600;letter-spacing:.02em;white-space:nowrap}",
    "#vibbit-overlay-cancel{display:inline-flex;align-items:center;justify-content:center;line-height:1;text-align:center}",
    "#vibbit-overlay-cancel:hover{background:#1a2a52}",
    "#vibbit-overlay-cancel:disabled{opacity:.6;cursor:default}"
  ].join("\n");
  document.head.appendChild(runtimeStyle);

  /* ── FAB ─────────────────────────────────────────────────── */
  const fab = document.createElement("div");
  fab.id = "vibbit-fab";
  fab.title = "Vibbit \u2013 AI code generator";
  fab.style.cssText = "position:fixed;right:20px;bottom:68px;width:44px;height:44px;border-radius:5px;background:#3454D1;display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 4px 14px rgba(52,84,209,.45);z-index:2147483646;transition:transform .15s ease,box-shadow .15s ease;border:none;";
  fab.innerHTML = FAB_FROG_MARK;
  fab.onmouseenter = function () { fab.style.background = "var(--secondary-background-color-hover, #2f4bc0)"; fab.style.boxShadow = "0 6px 20px rgba(52,84,209,.6)"; };
  fab.onmouseleave = function () { fab.style.background = "#3454D1"; fab.style.boxShadow = "0 4px 14px rgba(52,84,209,.45)"; };

  const openPanel = function () {
    fab.style.display = "none";
    ui.style.transform = "scale(0)";
    ui.style.opacity = "0";
    ui.style.display = "flex";
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        ui.style.transform = "scale(1)";
        ui.style.opacity = "1";
      });
    });
  };

  const closePanel = function () {
    ui.style.transform = "scale(0)";
    ui.style.opacity = "0";
    var onEnd = function () {
      ui.removeEventListener("transitionend", onEnd);
      ui.style.display = "none";
      fab.style.display = "flex";
    };
    ui.addEventListener("transitionend", onEnd);
  };

  fab.onclick = openPanel;
  document.body.appendChild(fab);

  /* ── element references ──────────────────────────────────── */
  const $ = (s) => ui.querySelector(s);

  const views = { setup: $("#bv-setup"), main: $("#bv-main"), settings: $("#bv-settings") };
  const headers = [$("#h-setup"), $("#h-main"), $("#h-settings")];
  const resizer = $("#rz");
  const overlayCard = interactionOverlay.querySelector("#vibbit-overlay-card");
  const overlayLabel = interactionOverlay.querySelector("#vibbit-overlay-label");
  const overlayCancelBtn = interactionOverlay.querySelector("#vibbit-overlay-cancel");

  /* setup view refs */
  const setupMode = $("#setup-mode");
  const setupProv = $("#setup-prov");
  const setupModel = $("#setup-model");
  const setupKey = $("#setup-key");
  const setupServer = $("#setup-server");
  const setupByokProvider = $("#setup-byok-provider");
  const setupByokModel = $("#setup-byok-model");
  const setupByokKey = $("#setup-byok-key");
  const setupManagedServer = $("#setup-managed-server");
  const setupGo = $("#setup-go");

  /* main view refs */
  const statusEl = $("#status");
  const busyIndicator = $("#busy-indicator");
  const gearBtn = $("#gear");
  const promptEl = $("#p");
  const includeCurrent = $("#inc");
  const go = $("#go");
  const revertBtn = $("#revert");
  const fixConvertBtn = $("#fix-convert");
  const activityEl = $("#activity");
  const logToggle = $("#logToggle");
  const log = $("#log");
  const feedbackBox = $("#fb");
  const feedbackLines = $("#fbLines");
  const feedbackToggle = $("#fbToggle");

  /* settings view refs */
  const setMode = $("#set-mode");
  const setProv = $("#set-prov");
  const setModel = $("#set-model");
  const setKey = $("#set-key");
  const setServer = $("#set-server");
  const setTarget = $("#set-target");
  const setByokProvider = $("#set-byok-provider");
  const setByokModel = $("#set-byok-model");
  const setByokKey = $("#set-byok-key");
  const setManagedServer = $("#set-managed-server");
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

  const applySetupMode = () => {
    setModeVisibility(setupMode.value, setupModeRefs);
  };

  const applySettingsMode = () => {
    setModeVisibility(setMode.value, settingsModeRefs);
    storageSet(STORAGE_MODE, setMode.value);
  };

  /* ── state ───────────────────────────────────────────────── */
  let undoStack = [];
  let busy = false;
  let feedbackCollapsed = false;
  let logsCollapsed = true;
  let activityTimer = 0;
  let overlayTimer = 0;
  let generationController = null;
  let lastFocusedElement = null;
  let queuedForcedRequest = "";
  let queuedForcedDialog = null;
  let lastConversionDialog = null;

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

  const hideFixConvertButton = () => {
    fixConvertBtn.style.display = "none";
    fixConvertBtn.disabled = true;
    fixConvertBtn.setAttribute("aria-hidden", "true");
  };

  const showFixConvertButton = (dialog) => {
    lastConversionDialog = dialog || null;
    fixConvertBtn.textContent = "Fix convert error";
    fixConvertBtn.style.display = "inline-flex";
    fixConvertBtn.disabled = busy;
    fixConvertBtn.style.opacity = busy ? "0.65" : "1";
    fixConvertBtn.style.cursor = busy ? "default" : "pointer";
    fixConvertBtn.setAttribute("aria-hidden", "false");
  };

  const overlayIsActive = () => interactionOverlay.dataset.active === "true";

  const restoreFocusAfterOverlay = () => {
    const target = lastFocusedElement;
    lastFocusedElement = null;
    if (!target || typeof target.focus !== "function") return;
    if (!document.contains(target)) return;
    try {
      target.focus({ preventScroll: true });
    } catch (error) {
      try { target.focus(); } catch (focusError) {}
    }
  };

  const showInteractionOverlay = () => {
    clearTimeout(overlayTimer);
    overlayCard.dataset.mode = "working";
    overlayLabel.textContent = "Generating code...";
    overlayCancelBtn.textContent = "Cancel";
    overlayCancelBtn.disabled = false;
    overlayCancelBtn.style.display = "inline-flex";
    interactionOverlay.dataset.active = "true";
    interactionOverlay.setAttribute("aria-hidden", "false");
    lastFocusedElement = document.activeElement;
    requestAnimationFrame(() => {
      try { overlayCancelBtn.focus({ preventScroll: true }); } catch (error) {}
    });
  };

  const hideInteractionOverlay = (showDoneAnimation) => {
    clearTimeout(overlayTimer);
    if (interactionOverlay.dataset.active !== "true") return;
    if (showDoneAnimation) {
      overlayCard.dataset.mode = "done";
      overlayLabel.textContent = "Done";
      overlayCancelBtn.style.display = "none";
      overlayTimer = setTimeout(() => {
        interactionOverlay.dataset.active = "false";
        interactionOverlay.setAttribute("aria-hidden", "true");
        overlayCard.dataset.mode = "working";
        overlayLabel.textContent = "Generating code...";
        overlayCancelBtn.textContent = "Cancel";
        overlayCancelBtn.disabled = false;
        overlayCancelBtn.style.display = "inline-flex";
        restoreFocusAfterOverlay();
      }, 550);
      return;
    }
    interactionOverlay.dataset.active = "false";
    interactionOverlay.setAttribute("aria-hidden", "true");
    overlayCard.dataset.mode = "working";
    overlayLabel.textContent = "Generating code...";
    overlayCancelBtn.textContent = "Cancel";
    overlayCancelBtn.disabled = false;
    overlayCancelBtn.style.display = "inline-flex";
    restoreFocusAfterOverlay();
  };

  document.addEventListener("focusin", (event) => {
    if (!overlayIsActive()) return;
    if (overlayCard.contains(event.target)) return;
    event.stopPropagation();
    try { overlayCancelBtn.focus({ preventScroll: true }); } catch (error) {}
  }, true);

  document.addEventListener("keydown", (event) => {
    if (!overlayIsActive()) return;
    const insideOverlay = overlayCard.contains(event.target);
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (!overlayCancelBtn.disabled) overlayCancelBtn.click();
      return;
    }
    if (insideOverlay) return;
    event.preventDefault();
    event.stopPropagation();
  }, true);

  overlayCancelBtn.onclick = () => {
    if (!busy || !generationController) return;
    overlayCancelBtn.disabled = true;
    overlayCancelBtn.textContent = "Cancelling...";
    setStatus("Cancelling");
    setActivity("Cancelling generation...", "neutral", true);
    logLine("Cancelling generation...");
    generationController.abort();
  };

  const setActivity = (message, tone, persistent) => {
    const palette = {
      neutral: "#9bb1dd",
      success: "#89e6a3",
      error: "#fda4af"
    };
    clearTimeout(activityTimer);
    activityEl.textContent = message || "";
    activityEl.style.color = palette[tone || "neutral"] || palette.neutral;
    if (message && !persistent) {
      activityTimer = setTimeout(() => {
        activityEl.textContent = "";
        activityEl.style.color = palette.neutral;
      }, 2600);
    }
  };

  const refreshRevertButton = () => {
    const canRevert = undoStack.length > 0 && !busy;
    revertBtn.disabled = !canRevert;
    revertBtn.style.display = canRevert ? "flex" : "none";
    revertBtn.style.pointerEvents = canRevert ? "auto" : "none";
    revertBtn.style.cursor = canRevert ? "pointer" : "default";
    revertBtn.setAttribute("aria-hidden", canRevert ? "false" : "true");
    if (fixConvertBtn.style.display !== "none") {
      fixConvertBtn.disabled = busy;
      fixConvertBtn.style.opacity = busy ? "0.65" : "1";
      fixConvertBtn.style.cursor = busy ? "default" : "pointer";
    }
  };

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
  logToggle.onclick = () => {
    logsCollapsed = !logsCollapsed;
    applyLogCollapse();
  };
  applyLogCollapse();
  hideFixConvertButton();
  setBusyIndicator(false);
  refreshRevertButton();

  /* ── resolve effective backend URL ───────────────────────── */
  const DEFAULT_SERVER = BACKEND.replace(/^https?:\/\//, "");

  const getBackendUrl = () => {
    const server = storageGet(STORAGE_SERVER);
    if (server && server.trim()) {
      const host = server.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
      return "https://" + host;
    }
    return BACKEND;
  };

  /* ── load saved state ────────────────────────────────────── */
  const savedMode = storageGet(STORAGE_MODE) || "byok";
  const savedProvider = storageGet(STORAGE_PROVIDER) || "openai";
  const savedModel = storageGet(STORAGE_MODEL);
  const savedKey = getStoredProviderKey(savedProvider);
  const savedServer = storageGet(STORAGE_SERVER) || "";
  const savedTarget = storageGet(STORAGE_TARGET) || "microbit";
  const setupDone = storageGet(STORAGE_SETUP_DONE) === "1";

  /* hydrate setup view */
  setupMode.value = savedMode;
  setupProv.value = savedProvider;
  populateModels(setupModel, savedProvider, savedModel);
  setupKey.value = savedKey;
  setupServer.value = savedServer || DEFAULT_SERVER;
  applySetupMode();

  /* hydrate settings view */
  setMode.value = savedMode;
  setProv.value = savedProvider;
  populateModels(setModel, savedProvider, savedModel);
  setKey.value = savedKey;
  setServer.value = savedServer || DEFAULT_SERVER;
  setTarget.value = savedTarget;
  applySettingsMode();

  /* show correct initial view */
  showView(setupDone ? "main" : "setup");

  /* ── setup view events ───────────────────────────────────── */
  setupMode.onchange = () => {
    applySetupMode();
  };

  setupProv.onchange = () => {
    populateModels(setupModel, setupProv.value, null);
    setupKey.value = getStoredProviderKey(setupProv.value);
  };

  setupGo.onclick = () => {
    const mode = setupMode.value;
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
    }
    storageSet(STORAGE_MODE, mode);
    storageSet(STORAGE_SETUP_DONE, "1");

    /* sync settings view with what was just saved */
    setMode.value = mode;
    setProv.value = setupProv.value;
    populateModels(setModel, setupProv.value, setupModel.value);
    setKey.value = getStoredProviderKey(setupProv.value);
    setServer.value = setupServer.value;
    applySettingsMode();

    showView("main");
  };

  /* ── settings view events ────────────────────────────────── */
  setMode.onchange = () => {
    applySettingsMode();
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
  };

  setTarget.onchange = () => {
    storageSet(STORAGE_TARGET, setTarget.value);
  };

  gearBtn.onclick = () => showView("settings");
  backBtn.onclick = () => showView("main");

  /* ── close buttons ───────────────────────────────────────── */
  $("#x-setup").onclick = closePanel;
  $("#x-main").onclick = closePanel;
  $("#x-settings").onclick = closePanel;

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
  const sanitizeMakeCode = (input) => {
    if (!input) return "";
    let text = String(input);
    if (/^```/.test(text)) text = text.replace(/^```[\s\S]*?\n/, "").replace(/```\s*$/, "");
    text = text.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n").replace(/\\t/g, "\t");
    text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    text = text.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, "\"");
    text = text.replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\u00A0/g, " ");
    text = text.replace(/^`+|`+$/g, "");
    return text.trim();
  };

  const normaliseFeedback = (items, fallback) => {
    const seen = new Set();
    const list = [];
    (Array.isArray(items) ? items : []).forEach((item) => {
      const text = String(item || "").trim();
      if (!text) return;
      const key = text.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      list.push(text);
    });
    if (!list.length && fallback) list.push(String(fallback).trim());
    return list;
  };

  const extractJsonObjectCandidates = (text) => {
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
  };

  const parseJsonObjectsFromText = (raw) => {
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
  };

  const isModelOutputObject = (parsed) => {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    return Object.prototype.hasOwnProperty.call(parsed, "code");
  };

  const extractCode = (raw) => {
    if (!raw) return "";
    const match = String(raw).match(/```[a-z]*\n([\s\S]*?)```/i);
    const code = match ? match[1] : raw;
    return sanitizeMakeCode(code);
  };

  const parseModelOutput = (raw) => {
    const parsedObjects = parseJsonObjectsFromText(raw);
    for (const parsed of parsedObjects) {
      if (!isModelOutputObject(parsed)) continue;
      const feedback = Array.isArray(parsed.feedback)
        ? parsed.feedback
        : (parsed.feedback == null ? [] : [parsed.feedback]);
      return {
        feedback: normaliseFeedback(feedback),
        code: extractCode(parsed.code == null ? "" : String(parsed.code))
      };
    }
    return { feedback: [], code: extractCode(raw) };
  };

  const validateBlocksCompatibility = (code, target) => {
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
    if (/[^\x09\x0A\x0D\x20-\x7E]/.test(code)) violations.push("non-ASCII characters");
    return { ok: violations.length === 0, violations: [...new Set(violations)] };
  };

  let BASE_TEMP = 0.1;
  let MAXTOK = 3072;

  const sysFor = (target) => {
    let namespaceList = "basic,input,music,led,radio,pins,loops,logic,variables,math,functions,arrays,text,game,images,serial,control";
    let targetName = "micro:bit";
    if (target === "arcade") {
      namespaceList = "controller,game,scene,sprites,info,music,effects";
      targetName = "Arcade";
    }
    if (target === "maker") {
      namespaceList = "pins,input,loops,music";
      targetName = "Maker";
    }
    return [
      "ROLE: You are a Microsoft MakeCode assistant.",
      "HARD REQUIREMENT: Return ONLY Microsoft MakeCode Static JavaScript that the MakeCode decompiler can convert to BLOCKS for " + targetName + " with ZERO errors.",
      "RESPONSE FORMAT (required): Return ONLY compact JSON with keys feedback and code.",
      "FORMAT DETAILS: {\"feedback\":[\"short note\"],\"code\":\"MakeCode Static TypeScript with \\\\n escapes\"}.",
      "FEEDBACK RULE: feedback must be an array with at least one short string.",
      "CODE RULE: code must be MakeCode Static TypeScript encoded as a JSON string (use escaped \\n for new lines, no markdown fences).",
      "NO COMMENTS inside the code.",
      "ERROR FIXING: If PAGE_ERRORS are provided, treat them as failing diagnostics and prioritise resolving all of them in your output.",
      "BLOCKS CONVERSION: If CONVERSION_DIALOG is provided, ensure the output can be converted from JavaScript back to Blocks in MakeCode.",
      "ALLOWED APIS: " + namespaceList + ". Prefer event handlers and forever/update loops.",
      "RANDOMNESS: For random choices, prefer list._pickRandom() from an array of options. Do NOT use randint(...).",
      "BLOCK-SAFE REQUIREMENTS (hard): no grey JavaScript blocks; every variable declaration must have an initializer; for loops must be exactly for (let i = 0; i < limit; i++) or for (let i = 0; i <= limit; i++); event registrations and function declarations must be top-level; no optional/default params in user-defined functions; callbacks/event handlers must not return a value; do not pass more arguments than block signatures support; statement assignment operators are limited to =, +=, -=.",
      "FORBIDDEN IN OUTPUT: arrow functions (=>), classes, new constructors, async/await/Promise, import/export, template strings (`), higher-order array methods (map/filter/reduce/forEach/find/some/every), namespaces/modules, enums, interfaces, type aliases, generics, timers (setTimeout/setInterval), console calls, markdown, onstart functions, null, undefined, as-casts, bitwise operators (| & ^ << >> >>>) and bitwise compound assignments.",
      "TARGET-SCOPE: Use ONLY APIs valid for " + targetName + ". Never mix Arcade APIs into micro:bit/Maker or vice versa.",
      "STYLE: Straight quotes, ASCII only, use function () { } handlers.",
      "IF UNSURE: Return a minimal program that is guaranteed to decompile to BLOCKS for " + targetName + ". Code only."
    ].join("\n");
  };

  const userFor = (request, currentCode, pageErrors, conversionDialog) => {
    const header = "USER_REQUEST:\n" + request.trim();
    const blocks = [header];
    const errors = (pageErrors || []).filter((item) => item && String(item).trim());
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
    if (currentCode && currentCode.trim().length) {
      blocks.push("<<<CURRENT_CODE>>>\n" + currentCode + "\n<<<END_CURRENT_CODE>>>");
    }
    return blocks.join("\n\n");
  };

  const stubForTarget = (target) => {
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

  const extractGeminiText = (response) => {
    try {
      if (!response) return "";
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
      if (response.promptFeedback && response.promptFeedback.blocked) return "";
    } catch (error) {
    }
    return "";
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

  const buildBackendHeaders = () => {
    const headers = { "Content-Type": "application/json" };
    if (APP_TOKEN) headers.Authorization = "Bearer " + APP_TOKEN;
    return headers;
  };

  const requestBackendGenerate = (payload, signal) => {
    const backendUrl = getBackendUrl();
    return fetch(backendUrl + "/vibbit/generate", {
      method: "POST",
      headers: buildBackendHeaders(),
      body: JSON.stringify(payload),
      signal
    }).then(async (response) => {
      if (response.ok) return response.json();
      let message = "HTTP " + response.status;
      try {
        const json = await response.json();
        if (json && json.error) message = json.error;
      } catch (error) {
      }
      throw new Error(message);
    });
  };

  /* ── generate handler ────────────────────────────────────── */
  go.onclick = () => {
    if (busy) return;
    busy = true;
    setBusyIndicator(true);
    showInteractionOverlay();
    refreshRevertButton();
    setActivity("", "neutral", true);

    clearLog();
    renderFeedback([]);
    hideFixConvertButton();
    setStatus("Working");
    logLine("Generating...");

    const request = (promptEl.value || "").trim();
    const initialForcedRequest = queuedForcedRequest;
    const initialForcedDialog = queuedForcedDialog;
    queuedForcedRequest = "";
    queuedForcedDialog = null;
    const mode = storageGet(STORAGE_MODE) || "byok";
    const target = storageGet(STORAGE_TARGET) || "microbit";
    const originalText = go.textContent;
    const undoDepthBeforeGenerate = undoStack.length;
    generationController = new AbortController();
    const signal = generationController.signal;
    let showDoneAnimation = false;
    let conversionRetryCount = 0;
    go.textContent = "Generating...";
    go.disabled = true;
    go.style.opacity = "0.7";
    go.style.cursor = "not-allowed";
    let finalFeedback = [];

    const runGenerationAttempt = (forcedRequest, forcedDialog, options) => {
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

      const currentPromise = includeCurrent.checked
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
        : Promise.resolve("");

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
          let conversionDialog = (pageContext && pageContext.conversionDialog) || forcedDialog || null;
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
            setActivity("No prompt entered; fixing detected errors.", "neutral", true);
          }

          if (mode === "managed") {
            logLine("Mode: Managed backend.");
            return requestBackendGenerate({ target, request: effectiveRequest, currentCode, pageErrors, conversionDialog }, signal);
          }

          const provider = storageGet(STORAGE_PROVIDER) || "openai";
          const apiKey = getStoredProviderKey(provider).trim();
          if (!apiKey) throw new Error("Enter API key for BYOK mode (open Settings).");
          const model = storageGet(STORAGE_MODEL) || "";

          logLine("Mode: BYOK.");
          return askValidated(provider, apiKey, model, sysFor(target), userFor(effectiveRequest, currentCode, pageErrors, conversionDialog), target, signal);
        })
        .then((result) => {
          throwIfAborted(signal);
          finalFeedback = normaliseFeedback(result && result.feedback);

          const code = extractCode(result && result.code ? result.code : "");
          if (!code) {
            finalFeedback = normaliseFeedback(
              finalFeedback.concat(["Model returned no code for this request."]),
              DEFAULT_FEEDBACK_MESSAGE
            );
            renderFeedback(finalFeedback);
            setStatus("No code");
            setActivity("No code returned.", "error");
            logLine("No code returned.");
            return;
          }

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
              showDoneAnimation = true;
              setActivity("Generation complete.", "success");
              logLine("Pasted and switched back to Blocks.");
            });
        });
    };

    const handleGenerationFailure = (error) => {
      if (isAbortError(error) || signal.aborted) {
        const shouldRestore = undoStack.length > undoDepthBeforeGenerate;
        if (!shouldRestore) {
          setStatus("Cancelled");
          setActivity("Generation cancelled.", "neutral");
          logLine("Generation cancelled.");
          return;
        }
        setStatus("Cancelling");
        setActivity("Generation cancelled. Restoring previous code...", "neutral", true);
        logLine("Generation cancelled after code updates. Restoring previous snapshot...");
        return revertEditor()
          .then(() => {
            setStatus("Cancelled");
            setActivity("Generation cancelled. Previous code restored.", "neutral");
            logLine("Previous code restored after cancellation.");
          })
          .catch((restoreError) => {
            setStatus("Error");
            setActivity("Generation cancelled but restore failed. Check logs.", "error", true);
            logLine("Restore after cancellation failed: " + (restoreError && restoreError.message ? restoreError.message : String(restoreError)));
          });
      }

      if (isConversionDialogError(error)) {
        const dialog = (error && error.dialog) || lastConversionDialog || null;
        lastConversionDialog = dialog;
        if (conversionRetryCount < 1) {
          conversionRetryCount += 1;
          logLine("MakeCode could not convert to Blocks. Retrying once with a conversion-fix prompt.");
          setStatus("Retrying");
          setActivity("MakeCode couldn't convert to Blocks. Attempting auto-fix...", "neutral", true);
          return runGenerationAttempt(buildConversionFixRequest(dialog), dialog, { snapshot: false }).catch(handleGenerationFailure);
        }
        showFixConvertButton(dialog);
        setStatus("Needs fix");
        setActivity("Still cannot convert to Blocks. Click \"Fix convert error\".", "error", true);
        logLine("Still unable to convert to Blocks after retry. Use 'Fix convert error' to try again.");
        return;
      }

      const message = error && error.message ? error.message : String(error);
      if (message === "Please enter a request.") {
        setStatus("Idle");
        setActivity("Please enter a request.", "error");
        logLine("Please enter a request.");
        return;
      }

      setStatus("Error");
      finalFeedback = normaliseFeedback(finalFeedback, DEFAULT_FAILURE_FEEDBACK);
      renderFeedback(finalFeedback);
      setActivity("Generation failed. Check logs.", "error", true);
      logLine("Request failed: " + message);
    };

    runGenerationAttempt(initialForcedRequest, initialForcedDialog)
      .catch(handleGenerationFailure)
      .finally(() => {
        generationController = null;
        busy = false;
        setBusyIndicator(false);
        hideInteractionOverlay(showDoneAnimation);
        go.textContent = originalText;
        go.disabled = false;
        go.style.opacity = "";
        go.style.cursor = "pointer";
        refreshRevertButton();
      });
  };

  revertBtn.onclick = () => {
    if (revertBtn.disabled || busy) return;
    busy = true;
    setBusyIndicator(true);
    refreshRevertButton();
    setStatus("Reverting");
    setActivity("", "neutral", true);
    logLine("Reverting to previous snapshot...");
    revertEditor()
      .then(() => {
        setStatus("Reverted");
        setActivity("Revert complete.", "success");
        logLine("Revert complete: restored previous code and switched back to Blocks.");
      })
      .catch((error) => {
        setStatus("Error");
        setActivity("Revert failed. Check logs.", "error", true);
        logLine("Revert failed: " + (error && error.message ? error.message : String(error)));
      })
      .finally(() => {
        busy = false;
        setBusyIndicator(false);
        refreshRevertButton();
      });
  };

  /* ── drag (all headers) ──────────────────────────────────── */
  (function enableDrag() {
    let dragging = false;
    let ox = 0;
    let oy = 0;
    let sx = 0;
    let sy = 0;
    const onDown = (event) => {
      dragging = true;
      ox = event.clientX;
      oy = event.clientY;
      const rect = ui.getBoundingClientRect();
      sx = rect.left;
      sy = rect.top;
      document.body.style.userSelect = "none";
    };
    headers.forEach((h) => h.addEventListener("mousedown", onDown));
    window.addEventListener("mousemove", (event) => {
      if (!dragging) return;
      const nextX = sx + (event.clientX - ox);
      const nextY = sy + (event.clientY - oy);
      ui.style.left = Math.max(0, Math.min(window.innerWidth - ui.offsetWidth, nextX)) + "px";
      ui.style.top = Math.max(0, Math.min(window.innerHeight - 60, nextY)) + "px";
      ui.style.right = "auto";
      ui.style.bottom = "auto";
    });
    window.addEventListener("mouseup", () => {
      dragging = false;
      document.body.style.userSelect = "";
    });
  })();

  /* ── resize ──────────────────────────────────────────────── */
  (function enableResize() {
    let resizing = false;
    let rx = 0;
    let ry = 0;
    let startW = 0;
    let startH = 0;
    resizer.addEventListener("mousedown", (event) => {
      resizing = true;
      rx = event.clientX;
      ry = event.clientY;
      startW = ui.offsetWidth;
      startH = ui.offsetHeight;
      document.body.style.userSelect = "none";
    });
    window.addEventListener("mousemove", (event) => {
      if (!resizing) return;
      const width = Math.max(380, startW + (event.clientX - rx));
      const height = Math.max(260, startH + (event.clientY - ry));
      ui.style.width = width + "px";
      ui.style.height = height + "px";
    });
    window.addEventListener("mouseup", () => {
      resizing = false;
      document.body.style.userSelect = "";
    });
  })();
})();
