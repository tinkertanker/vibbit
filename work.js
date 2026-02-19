const BACKEND = "https://vibbit.dev.tk.sg";
const APP_TOKEN = ""; // set only if your server enforces SERVER_APP_TOKEN

(function () {
  if (window.__vibbitStrict) return;
  window.__vibbitStrict = 1;

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const STORAGE_MODE = "__vibbit_mode";
  const STORAGE_KEY = "__vibbit_key";
  const STORAGE_PROVIDER = "__vibbit_provider";
  const STORAGE_MODEL = "__vibbit_model";
  const STORAGE_SETUP_DONE = "__vibbit_setup_done";
  const STORAGE_SERVER = "__vibbit_server";
  const STORAGE_TARGET = "__vibbit_target";

  const MODEL_PRESETS = {
    openai: [
      { id: "gpt-5-mini", label: "GPT-5 Mini" },
      { id: "gpt-5.2", label: "GPT-5.2" },
      { id: "gpt-5.2-codex", label: "GPT-5.2 Codex", default: true }
    ],
    gemini: [
      { id: "gemini-3-flash-preview", label: "Gemini 3 Flash", default: true },
      { id: "gemini-3-pro-preview", label: "Gemini 3 Pro" }
    ],
    openrouter: [
      { id: "deepseek/deepseek-v3.2", label: "DeepSeek V3.2" },
      { id: "google/gemini-3-flash-preview", label: "Gemini 3 Flash" },
      { id: "z-ai/glm-5", label: "GLM-5" },
      { id: "x-ai/grok-4.1-fast", label: "Grok 4.1 Fast" },
      { id: "moonshotai/kimi-k2.5", label: "Kimi K2.5", default: true },
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

  /* ── shared styles ───────────────────────────────────────── */
  const S_LABEL = "font-size:11px;color:#9eb2ff;text-transform:uppercase;letter-spacing:0.08em";
  const S_SELECT = "width:100%;padding:8px;border-radius:8px;border:1px solid #29324e;background:#0b1020;color:#e6e8ef;cursor:pointer";
  const S_INPUT = "width:100%;padding:8px;border-radius:8px;border:1px solid #29324e;background:#0b1020;color:#e6e8ef;box-sizing:border-box";
  const S_BTN_PRIMARY = "width:100%;padding:10px;border:none;border-radius:8px;background:#3b82f6;color:#fff;font-weight:600;cursor:pointer;font-size:13px";
  const S_ICON_BTN = "background:transparent;border:none;color:#93a4c4;cursor:pointer;padding:4px;display:flex;align-items:center";
  const CLOSE_SVG = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M1 1l12 12M13 1L1 13"/></svg>';

  /* ── panel container ─────────────────────────────────────── */
  const ui = document.createElement("div");
  ui.id = "vibbit-panel";
  ui.style.cssText = "position:fixed;right:12px;bottom:12px;width:460px;max-height:84vh;overflow:auto;background:#0b1020;color:#e6e8ef;font-family:system-ui,Segoe UI,Arial,sans-serif;border:1px solid #21304f;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.35);display:none;flex-direction:column;z-index:2147483647;transform-origin:bottom right;transition:transform .2s ease,opacity .2s ease";

  /* ── build HTML ──────────────────────────────────────────── */
  ui.innerHTML = ""
    /* ═══ VIEW 1: SETUP ═══ */
    + '<div id="bv-setup" style="display:none;flex-direction:column">'

    /* header */
    + '<div id="h-setup" style="cursor:move;display:flex;align-items:center;padding:10px 12px;background:#111936;border-bottom:1px solid #21304f">'
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
    + '  <span style="font-weight:600;font-size:13px">Vibbit</span>'
    + '  <span id="status" style="margin-left:10px;font-size:11px;color:#9bb1dd">Idle</span>'
    + '  <button id="gear" aria-label="Settings" style="margin-left:auto;' + S_ICON_BTN + '"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M6.5.7l.3 1.7a5.4 5.4 0 011.5.6l1.4-1 1.6 1.6-1 1.4c.3.5.5 1 .6 1.5l1.7.3v2.2l-1.7.3a5.4 5.4 0 01-.6 1.5l1 1.4-1.6 1.6-1.4-1a5.4 5.4 0 01-1.5.6l-.3 1.7H4.3l-.3-1.7a5.4 5.4 0 01-1.5-.6l-1.4 1L-.5 11l1-1.4A5.4 5.4 0 01-.1 8.1l-1.7-.3V5.6l1.7-.3c.1-.5.3-1 .6-1.5l-1-1.4L1.1.8l1.4 1c.5-.3 1-.5 1.5-.6L4.3.5h2.2zM5.4 4.8a2.6 2.6 0 100 5.2 2.6 2.6 0 000-5.2z"/></svg></button>'
    + '  <button id="x-main" aria-label="Close" style="margin-left:6px;' + S_ICON_BTN + '">' + CLOSE_SVG + '</button>'
    + '</div>'

    /* body */
    + '<div style="padding:12px 14px;display:grid;gap:10px">'
    + '  <textarea id="p" rows="6" placeholder="Describe what you want the block code to do \u2013 try to be specific" style="resize:vertical;min-height:96px;padding:10px;border-radius:8px;border:1px solid #29324e;background:#0b1020;color:#e6e8ef;font-size:13px;line-height:1.4"></textarea>'
    + '  <label style="display:flex;gap:6px;align-items:center;font-size:12px;color:#c7d2fe;cursor:pointer"><input id="inc" type="checkbox" checked style="cursor:pointer">Use current code</label>'
    + '  <div style="display:flex;gap:8px;flex-wrap:wrap">'
    + '    <button id="go" style="flex:1 1 48%;padding:10px;border:none;border-radius:8px;background:#3b82f6;color:#fff;font-weight:600;cursor:pointer">Generate &amp; Paste</button>'
    + '    <button id="revert" style="flex:1 1 48%;padding:10px;border:1px solid #2b3a5a;border-radius:8px;background:#223058;color:#e6e8ef;cursor:pointer" disabled>Revert</button>'
    + '  </div>'
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
    + '<div id="log" style="padding:10px 12px;font-size:11px;color:#9bb1dd;display:block;max-height:200px;overflow:auto"></div>'
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

  /* ── FAB ─────────────────────────────────────────────────── */
  const fab = document.createElement("div");
  fab.id = "vibbit-fab";
  fab.title = "Vibbit \u2013 AI code generator";
  fab.style.cssText = "position:fixed;right:20px;bottom:68px;width:44px;height:44px;border-radius:5px;background:linear-gradient(135deg,#3b82f6,#6366f1);display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 4px 14px rgba(59,130,246,.45);z-index:2147483647;transition:transform .15s ease,box-shadow .15s ease;border:none;";
  fab.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none">'
    + '<path d="M9.5 2L10.7 6.5 15 8l-4.3 1.5L9.5 14l-1.2-4.5L4 8l4.3-1.5L9.5 2z" fill="#fff"/>'
    + '<path d="M19 10l.8 2.7L22.5 14l-2.7.8L19 17.5l-.8-2.7-2.7-.8 2.7-.8L19 10z" fill="#fff" opacity=".75"/>'
    + '<path d="M14.5 2l.4 1.5L16.5 4l-1.6.5-.4 1.5-.4-1.5L12.5 4l1.6-.5.4-1.5z" fill="#fff" opacity=".5"/>'
    + '</svg>';
  fab.onmouseenter = function () { fab.style.transform = "scale(1.1)"; fab.style.boxShadow = "0 6px 20px rgba(99,102,241,.55)"; };
  fab.onmouseleave = function () { fab.style.transform = "scale(1)"; fab.style.boxShadow = "0 4px 14px rgba(59,130,246,.45)"; };

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
  const gearBtn = $("#gear");
  const promptEl = $("#p");
  const includeCurrent = $("#inc");
  const go = $("#go");
  const revertBtn = $("#revert");
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

  const setStatus = (value) => {
    statusEl.textContent = value;
  };

  const logLine = (value) => {
    const row = document.createElement("div");
    row.textContent = value;
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
  };

  const clearLog = () => {
    log.innerHTML = "";
  };

  /* ── feedback panel ──────────────────────────────────────── */
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
    const list = (items || []).filter((item) => item && String(item).trim());
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
  const savedKey = storageGet(STORAGE_KEY) || "";
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
      storageSet(STORAGE_KEY, key);
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
    setKey.value = setupKey.value;
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
  };

  setModel.onchange = () => {
    storageSet(STORAGE_MODEL, setModel.value);
  };

  saveBtn.onclick = () => {
    try {
      storageSet(STORAGE_KEY, setKey.value.trim());
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

  const findMonacoCtx = (timeoutMs = 18000) => {
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

  const pasteToMakeCode = (code) => {
    return findMonacoCtx().then((ctx) => {
      logLine("Switching to JavaScript tab.");
      clickLike(ctx.win.document, ["javascript", "typescript", "text"]);
      return wait(20).then(() => {
        try {
          const previous = ctx.model.getValue() || "";
          undoStack.push(previous);
          revertBtn.disabled = false;
          logLine("Snapshot saved for revert.");
        } catch (error) {
          logLine("Snapshot failed: " + error);
        }
        logLine("Pasting generated code into editor.");
        ctx.model.setValue(code);
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
      });
    });
  };

  const revertEditor = () => {
    return findMonacoCtx().then((ctx) => {
      if (!undoStack.length) throw new Error("No snapshot to revert to.");
      const previous = undoStack.pop();
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
      });
    }).then(() => {
      if (!undoStack.length) revertBtn.disabled = true;
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

  const separateFeedback = (raw) => {
    const feedback = [];
    if (!raw) return { feedback, body: "" };
    const lines = String(raw).replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    const bodyLines = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (/^FEEDBACK:/i.test(trimmed)) {
        feedback.push(trimmed.replace(/^FEEDBACK:\s*/i, "").trim());
      } else {
        bodyLines.push(line);
      }
    }
    return { feedback, body: bodyLines.join("\n").trim() };
  };

  const extractCode = (raw) => {
    if (!raw) return "";
    const match = String(raw).match(/```[a-z]*\n([\s\S]*?)```/i);
    const code = match ? match[1] : raw;
    return sanitizeMakeCode(code);
  };

  const validateBlocksCompatibility = (code, target) => {
    const rules = [
      { re: /=>/g, why: "arrow functions" },
      { re: /\bclass\s+/g, why: "classes" },
      { re: /\bnew\s+[A-Z_a-z]/g, why: "new constructor" },
      { re: /\bPromise\b|\basync\b|\bawait\b/g, why: "promises/async" },
      { re: /\bimport\s|\bexport\s/g, why: "import/export" },
      { re: /`/g, why: "template strings" },
      { re: /\.\s*(map|forEach|filter|reduce|find|some|every)\s*\(/g, why: "higher-order array methods" },
      { re: /\bnamespace\b|\bmodule\b/g, why: "namespaces/modules" },
      { re: /\benum\b|\binterface\b|\btype\s+[A-Z_a-z]/g, why: "TS types/enums" },
      { re: /<\s*[A-Z_a-z0-9_,\s]+>/g, why: "generics syntax" },
      { re: /setTimeout\s*\(|setInterval\s*\(/g, why: "timers" },
      { re: /console\./g, why: "console calls" },
      { re: /^\s*\/\//m, why: "line comments" },
      { re: /\/\*[\s\S]*?\*\//g, why: "block comments" }
    ];

    if ((target === "microbit" || target === "maker") && /sprites\.|controller\.|scene\.|game\.onUpdate/i.test(code)) {
      return { ok: false, violations: ["Arcade APIs in micro:bit/Maker"] };
    }
    if (target === "arcade" && (/led\./i.test(code) || /radio\./i.test(code))) {
      return { ok: false, violations: ["micro:bit APIs in Arcade"] };
    }

    const violations = [];
    for (const rule of rules) {
      if (rule.re.test(code)) violations.push(rule.why);
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
      "OPTIONAL FEEDBACK: You may send brief notes before the code. Prefix each note with FEEDBACK: .",
      "RESPONSE FORMAT: After any feedback lines, output ONLY Microsoft MakeCode Static TypeScript with no markdown fences or extra prose.",
      "NO COMMENTS inside the code.",
      "ALLOWED APIS: " + namespaceList + ". Prefer event handlers and forever/update loops.",
      "FORBIDDEN IN OUTPUT: arrow functions (=>), classes, new constructors, async/await/Promise, import/export, template strings (`), higher-order array methods (map/filter/reduce/forEach/find/some/every), namespaces/modules, enums, interfaces, type aliases, generics, timers (setTimeout/setInterval), console calls, markdown, escaped newlines, onstart functions.",
      "TARGET-SCOPE: Use ONLY APIs valid for " + targetName + ". Never mix Arcade APIs into micro:bit/Maker or vice versa.",
      "STYLE: Straight quotes, ASCII only, real newlines, use function () { } handlers.",
      "IF UNSURE: Return a minimal program that is guaranteed to decompile to BLOCKS for " + targetName + ". Code only."
    ].join("\n");
  };

  const userFor = (request, currentCode) => {
    const header = "USER_REQUEST:\n" + request.trim();
    if (currentCode && currentCode.trim().length) {
      return header + "\n\n<<<CURRENT_CODE>>>\n" + currentCode + "\n<<<END_CURRENT_CODE>>>";
    }
    return header;
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

  const callOpenAI = (key, model, system, user) => {
    const body = {
      model: model || "gpt-4o-mini",
      temperature: BASE_TEMP,
      max_tokens: MAXTOK,
      messages: [{ role: "system", content: system }, { role: "user", content: user }]
    };
    return withTimeout(
      fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
        body: JSON.stringify(body)
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

  const callGemini = (key, model, system, user) => {
    const url = "https://generativelanguage.googleapis.com/v1/models/" + encodeURIComponent(model || "gemini-2.5-flash") + ":generateContent?key=" + encodeURIComponent(key);
    const body = {
      contents: [{ role: "user", parts: [{ text: system + "\n\n" + user }] }],
      generationConfig: { temperature: BASE_TEMP, maxOutputTokens: MAXTOK }
    };
    return withTimeout(
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
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

  const callOpenRouter = (key, model, system, user) => {
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
          body: JSON.stringify(body)
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
          if (index < queue.length - 1) {
            logLine("Model " + modelName + " failed: " + (error && error.message ? error.message : String(error)) + ". Trying next model.");
            return attempt(index + 1);
          }
          throw error;
        });
    };

    return attempt(0);
  };

  const askValidated = (provider, apiKey, model, system, user, target) => {
    const providers = { openai: callOpenAI, gemini: callGemini, openrouter: callOpenRouter };
    const names = { openai: "OpenAI", gemini: "Gemini", openrouter: "OpenRouter" };
    const callProvider = providers[provider] || providers.openai;

    const oneAttempt = (extraSystem, insistOnlyCode) => {
      const prompt = system
        + (extraSystem ? ("\n" + extraSystem) : "")
        + (insistOnlyCode ? "\nMANDATE: You must output only Blocks-decompilable MakeCode Static TypeScript." : "");
      const providerName = names[provider] || provider;
      logLine("Sending to " + providerName + " (" + (model || "default") + ").");
      return callProvider(apiKey, model, prompt, user).then((raw) => {
        const parts = separateFeedback(raw);
        const code = sanitizeMakeCode(extractCode(parts.body));
        const validation = validateBlocksCompatibility(code, target);
        return { code, validation, feedback: parts.feedback };
      });
    };

    return oneAttempt(null, false)
      .then((result) => {
        if (result.code && result.code.trim()) return result;
        const retryEmpty = (index, previous) => {
          if (index >= EMPTY_RETRIES) return previous;
          const extra = "Your last message returned no code. Return ONLY Blocks-decompilable MakeCode Static TypeScript. No prose.";
          return oneAttempt(extra, true).then((next) => {
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
          if (secondPass.validation && secondPass.validation.ok) return secondPass;
          const secondViolations = (secondPass.validation && secondPass.validation.violations) || [];
          const strictExtra = "STRICT MODE: Output a smaller program that fully decompiles to Blocks. Absolutely no: " + secondViolations.join(", ") + ".";
          return oneAttempt(strictExtra, true);
        });
      })
      .then((finalResult) => {
        const feedback = finalResult && Array.isArray(finalResult.feedback) ? finalResult.feedback : [];
        if (!finalResult || !finalResult.code || !finalResult.code.trim()) {
          logLine("Model returned no code after retries. Using minimal stub.");
          return { code: stubForTarget(target), feedback };
        }
        return { code: finalResult.code, feedback };
      });
  };

  const buildBackendHeaders = () => {
    const headers = { "Content-Type": "application/json" };
    if (APP_TOKEN) headers.Authorization = "Bearer " + APP_TOKEN;
    return headers;
  };

  const requestBackendGenerate = (payload) => {
    const backendUrl = getBackendUrl();
    return fetch(backendUrl + "/vibbit/generate", {
      method: "POST",
      headers: buildBackendHeaders(),
      body: JSON.stringify(payload)
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

    clearLog();
    renderFeedback([]);
    setStatus("Working");
    logLine("Generating...");

    const request = (promptEl.value || "").trim();
    if (!request) {
      busy = false;
      setStatus("Idle");
      logLine("Please enter a request.");
      return;
    }

    const mode = storageGet(STORAGE_MODE) || "byok";
    const target = storageGet(STORAGE_TARGET) || "microbit";
    const originalText = go.textContent;
    go.textContent = "Loading...";
    go.disabled = true;
    go.style.opacity = "0.7";
    go.style.cursor = "not-allowed";

    const currentPromise = includeCurrent.checked
      ? findMonacoCtx()
        .then((ctx) => {
          logLine("Reading current JavaScript.");
          return ctx.model.getValue() || "";
        })
        .catch(() => {
          logLine("Could not read current code.");
          return "";
        })
      : Promise.resolve("");

    currentPromise
      .then((currentCode) => {
        if (mode === "managed") {
          logLine("Mode: Managed backend.");
          return requestBackendGenerate({ target, request, currentCode });
        }

        const apiKey = (storageGet(STORAGE_KEY) || "").trim();
        if (!apiKey) throw new Error("Enter API key for BYOK mode (open Settings).");
        const provider = storageGet(STORAGE_PROVIDER) || "openai";
        const model = storageGet(STORAGE_MODEL) || "";

        logLine("Mode: BYOK.");
        return askValidated(provider, apiKey, model, sysFor(target), userFor(request, currentCode), target);
      })
      .then((result) => {
        const feedback = result && Array.isArray(result.feedback) ? result.feedback : [];
        renderFeedback(feedback);

        const code = extractCode(result && result.code ? result.code : "");
        if (!code) {
          setStatus("No code");
          logLine("No code returned.");
          return;
        }

        setStatus("Pasting");
        return pasteToMakeCode(code).then(() => {
          setStatus("Done");
          logLine("Pasted and switched back to Blocks.");
        });
      })
      .catch((error) => {
        setStatus("Error");
        logLine("Request failed: " + (error && error.message ? error.message : String(error)));
      })
      .finally(() => {
        busy = false;
        go.textContent = originalText;
        go.disabled = false;
        go.style.opacity = "";
        go.style.cursor = "pointer";
      });
  };

  revertBtn.onclick = () => {
    if (revertBtn.disabled) return;
    const originalText = revertBtn.textContent;
    revertBtn.textContent = "Reverting...";
    revertBtn.disabled = true;
    revertBtn.style.opacity = "0.7";
    revertBtn.style.cursor = "not-allowed";
    setStatus("Reverting");
    logLine("Reverting to previous snapshot...");
    revertEditor()
      .then(() => {
        setStatus("Reverted");
        logLine("Revert complete: restored previous code and switched back to Blocks.");
      })
      .catch((error) => {
        setStatus("Error");
        logLine("Revert failed: " + (error && error.message ? error.message : String(error)));
      })
      .finally(() => {
        revertBtn.textContent = originalText;
        revertBtn.style.opacity = "";
        revertBtn.style.cursor = "pointer";
        if (undoStack.length) revertBtn.disabled = false;
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
