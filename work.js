const BACKEND = "https://bitvibe.dev.tk.sg";
const APP_TOKEN = ""; // set only if your server enforces SERVER_APP_TOKEN

(function () {
  if (window.__bitvibeStrict) return;
  window.__bitvibeStrict = 1;

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const STORAGE_MODE = "__bitvibe_mode";
  const STORAGE_KEY = "__bitvibe_key";
  const STORAGE_PROVIDER = "__bitvibe_provider";
  const STORAGE_MODEL = "__bitvibe_model";

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

  const ui = document.createElement("div");
  ui.id = "bitvibe-panel";
  ui.style.cssText = "position:fixed;right:12px;bottom:12px;width:460px;max-height:84vh;overflow:auto;background:#0b1020;color:#e6e8ef;font-family:system-ui,Segoe UI,Arial,sans-serif;border:1px solid #21304f;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.35);display:none;flex-direction:column;z-index:2147483647;transform-origin:bottom right;transition:transform .2s ease,opacity .2s ease";
  ui.innerHTML = ""
    + '<div id="h" style="cursor:move;display:flex;align-items:center;padding:10px 12px;background:#111936;border-bottom:1px solid #21304f">'
    + '  <span style="font-weight:600;font-size:13px">bit:vibe</span>'
    + '  <span id="status" style="margin-left:10px;font-size:11px;color:#9bb1dd">Idle</span>'
    + '  <button id="x" aria-label="Close" style="margin-left:auto;background:transparent;border:none;color:#93a4c4;cursor:pointer;padding:4px;display:flex;align-items:center"><svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M1 1l12 12M13 1L1 13"/></svg></button>'
    + "</div>"
    + '<div style="padding:10px 12px;display:grid;gap:8px;border-bottom:1px solid #21304f">'
    + '  <div style="display:grid;gap:6px">'
    + '    <div style="font-size:11px;color:#9eb2ff;text-transform:uppercase;letter-spacing:0.08em">Mode</div>'
    + '    <select id="mode" style="padding:8px;border-radius:8px;border:1px solid #29324e;background:#0b1020;color:#e6e8ef;cursor:pointer">'
    + '      <option value="managed">Managed (school account)</option>'
    + '      <option value="byok">Bring your own key</option>'
    + "    </select>"
    + "  </div>"
    + '  <div id="managedHint" style="font-size:12px;color:#b8c6e8">Managed mode uses your configured backend at <span style="color:#d5e4ff">BACKEND</span>.</div>'
    + '  <div id="byokRow" style="display:none;gap:8px">'
    + '    <select id="prov" style="flex:1;padding:8px;border-radius:8px;border:1px solid #29324e;background:#0b1020;color:#e6e8ef;cursor:pointer">'
    + '      <option value="openai">OpenAI</option>'
    + '      <option value="gemini">Gemini</option>'
    + '      <option value="openrouter">OpenRouter</option>'
    + "    </select>"
    + '    <input id="model" placeholder="gpt-4o-mini or gemini-2.5-flash or openrouter/auto" style="flex:1;padding:8px;border-radius:8px;border:1px solid #29324e;background:#0b1020;color:#e6e8ef">'
    + "  </div>"
    + '  <div id="byokKeyRow" style="display:none;gap:8px">'
    + '    <input id="key" type="password" placeholder="API key" style="flex:1;padding:8px;border-radius:8px;border:1px solid #29324e;background:#0b1020;color:#e6e8ef">'
    + '    <button id="save" style="padding:8px 12px;border:none;border-radius:8px;background:#16a34a;color:#fff;font-weight:600;cursor:pointer">Save Key</button>'
    + "  </div>"
    + '  <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
    + '    <select id="target" style="flex:1 1 48%;padding:8px;border-radius:8px;border:1px solid #29324e;background:#0b1020;color:#e6e8ef;cursor:pointer">'
    + '      <option value="microbit">micro:bit</option>'
    + '      <option value="arcade">Arcade</option>'
    + '      <option value="maker">Maker</option>'
    + "    </select>"
    + '    <label style="display:flex;gap:6px;align-items:center;font-size:12px;color:#c7d2fe;cursor:pointer"><input id="inc" type="checkbox" checked style="cursor:pointer">Use current code</label>'
    + "  </div>"
    + '  <textarea id="p" rows="3" placeholder="Describe what you want the block code to do - try to be specific" style="resize:vertical;min-height:64px;padding:8px;border-radius:8px;border:1px solid #29324e;background:#0b1020;color:#e6e8ef"></textarea>'
    + '  <div style="display:flex;gap:8px;flex-wrap:wrap">'
    + '    <button id="go" style="flex:1 1 48%;padding:10px;border:none;border-radius:8px;background:#3b82f6;color:#fff;font-weight:600;cursor:pointer">Generate & Paste</button>'
    + '    <button id="revert" style="flex:1 1 48%;padding:10px;border:1px solid #2b3a5a;border-radius:8px;background:#223058;color:#e6e8ef;cursor:pointer" disabled>Revert</button>'
    + "  </div>"
    + "</div>"
    + '<div id="fb" style="display:none;margin:12px;margin-top:0;padding:12px;border-radius:10px;background:linear-gradient(135deg,#1b2441,#101a33);border:1px solid #354b7d;box-shadow:0 4px 18px rgba(0,0,0,.3);">'
    + '  <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;">'
    + '    <div style="font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#8fb7ff;display:flex;align-items:center;gap:6px;">'
    + '      <span style="display:inline-flex;width:16px;height:16px;align-items:center;justify-content:center;border-radius:50%;background:#3b82f6;color:#0b1020;font-weight:700;font-size:10px;">i</span>'
    + "      Model Feedback"
    + "    </div>"
    + '    <button id="fbToggle" aria-label="Toggle feedback" style="background:rgba(148,163,255,0.15);color:#cdd9ff;border:1px solid rgba(148,163,255,0.3);border-radius:16px;padding:2px 10px;font-size:11px;font-weight:500;cursor:pointer;">Hide</button>'
    + "  </div>"
    + '  <div id="fbLines" style="display:grid;gap:6px;font-size:12px;color:#e4ecff;line-height:1.35;"></div>'
    + "</div>"
    + '<div id="log" style="padding:10px 12px;font-size:11px;color:#9bb1dd;display:block;max-height:200px;overflow:auto"></div>'
    + '<div id="rz" style="position:absolute;width:14px;height:14px;right:2px;bottom:2px;cursor:nwse-resize;background:linear-gradient(135deg,transparent 50%,#2b3a5a 50%);opacity:.9"></div>';
  document.body.appendChild(ui);

  const fab = document.createElement("div");
  fab.id = "bitvibe-fab";
  fab.title = "bit:vibe \u2013 AI code generator";
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

  const $ = (s) => ui.querySelector(s);
  const header = $("#h");
  const statusEl = $("#status");
  const closeBtn = $("#x");
  const resizer = $("#rz");

  const modeSel = $("#mode");
  const managedHint = $("#managedHint");
  const byokRow = $("#byokRow");
  const byokKeyRow = $("#byokKeyRow");
  const providerSel = $("#prov");
  const keyInput = $("#key");
  const modelInput = $("#model");
  const saveBtn = $("#save");

  const targetSel = $("#target");
  const includeCurrent = $("#inc");
  const promptEl = $("#p");
  const go = $("#go");
  const revertBtn = $("#revert");
  const log = $("#log");
  const feedbackBox = $("#fb");
  const feedbackLines = $("#fbLines");
  const feedbackToggle = $("#fbToggle");

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

  const applyMode = () => {
    const isByok = modeSel.value === "byok";
    byokRow.style.display = isByok ? "flex" : "none";
    byokKeyRow.style.display = isByok ? "flex" : "none";
    managedHint.style.display = isByok ? "none" : "block";
    storageSet(STORAGE_MODE, modeSel.value);
  };

  try {
    const savedMode = storageGet(STORAGE_MODE);
    if (savedMode === "managed" || savedMode === "byok") {
      modeSel.value = savedMode;
    }
    const savedKey = storageGet(STORAGE_KEY);
    if (savedKey) keyInput.value = savedKey;
    const savedProvider = storageGet(STORAGE_PROVIDER);
    if (savedProvider) providerSel.value = savedProvider;
    const savedModel = storageGet(STORAGE_MODEL);
    if (savedModel) modelInput.value = savedModel;
  } catch (error) {
  }
  applyMode();

  modeSel.onchange = applyMode;
  providerSel.onchange = () => {
    storageSet(STORAGE_PROVIDER, providerSel.value);
  };
  modelInput.onchange = () => {
    storageSet(STORAGE_MODEL, modelInput.value.trim());
  };
  saveBtn.onclick = () => {
    try {
      storageSet(STORAGE_KEY, keyInput.value.trim());
      setStatus("Key saved");
      logLine("BYOK API key saved in this browser.");
    } catch (error) {
      logLine("Save failed: " + error);
    }
  };

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
    return fetch(BACKEND + "/bitvibe/generate", {
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

    const mode = modeSel.value;
    const target = targetSel.value.trim();
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

        const apiKey = keyInput.value.trim();
        if (!apiKey) throw new Error("Enter API key for BYOK mode.");
        const provider = providerSel.value;
        const model = modelInput.value.trim();

        storageSet(STORAGE_KEY, apiKey);
        storageSet(STORAGE_PROVIDER, provider);
        storageSet(STORAGE_MODEL, model);

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

  (function enableDrag() {
    let dragging = false;
    let ox = 0;
    let oy = 0;
    let sx = 0;
    let sy = 0;
    header.addEventListener("mousedown", (event) => {
      dragging = true;
      ox = event.clientX;
      oy = event.clientY;
      const rect = ui.getBoundingClientRect();
      sx = rect.left;
      sy = rect.top;
      document.body.style.userSelect = "none";
    });
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

  closeBtn.onclick = closePanel;
})();
