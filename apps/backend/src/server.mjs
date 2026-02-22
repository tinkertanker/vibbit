import { createServer } from "node:http";

const PORT = Number(process.env.PORT || 8787);
const ALLOW_ORIGIN = process.env.VIBBIT_ALLOW_ORIGIN || "*";
const REQUEST_TIMEOUT_MS = Number(process.env.VIBBIT_REQUEST_TIMEOUT_MS || 60000);
const EMPTY_RETRIES = Number(process.env.VIBBIT_EMPTY_RETRIES || 2);
const VALIDATION_RETRIES = Number(process.env.VIBBIT_VALIDATION_RETRIES || 2);
const SERVER_APP_TOKEN = process.env.SERVER_APP_TOKEN || "";
const PROVIDER = (process.env.VIBBIT_PROVIDER || "openai").trim().toLowerCase();

function modelFor(provider) {
  if (provider === "openai") return process.env.VIBBIT_OPENAI_MODEL || process.env.VIBBIT_MODEL || "gpt-4o-mini";
  if (provider === "gemini") return process.env.VIBBIT_GEMINI_MODEL || process.env.VIBBIT_MODEL || "gemini-2.5-flash";
  if (provider === "openrouter") return process.env.VIBBIT_OPENROUTER_MODEL || process.env.VIBBIT_MODEL || "openrouter/auto";
  return process.env.VIBBIT_MODEL || "gpt-4o-mini";
}

function apiKeyFor(provider) {
  if (provider === "openai") return process.env.VIBBIT_OPENAI_API_KEY || process.env.VIBBIT_API_KEY || "";
  if (provider === "gemini") return process.env.VIBBIT_GEMINI_API_KEY || process.env.VIBBIT_API_KEY || "";
  if (provider === "openrouter") return process.env.VIBBIT_OPENROUTER_API_KEY || process.env.VIBBIT_API_KEY || "";
  return process.env.VIBBIT_API_KEY || "";
}

function respondJson(res, status, body, origin = "") {
  const allowOrigin = ALLOW_ORIGIN === "*" ? "*" : (origin || ALLOW_ORIGIN);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  });
  res.end(JSON.stringify(body));
}

function handleOptions(req, res) {
  const allowOrigin = ALLOW_ORIGIN === "*" ? "*" : (req.headers.origin || ALLOW_ORIGIN);
  res.writeHead(204, {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400"
  });
  res.end();
}

function readJson(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("Payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch (error) {
        reject(new Error("Invalid JSON"));
      }
    });

    req.on("error", reject);
  });
}

function withTimeout(promise, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const wrapped = promise(controller.signal)
    .finally(() => clearTimeout(timeoutId));

  return wrapped;
}

function sanitizeMakeCode(input) {
  if (!input) return "";
  let text = String(input);
  if (/^```/.test(text)) text = text.replace(/^```[\s\S]*?\n/, "").replace(/```\s*$/, "");
  text = text.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n").replace(/\\t/g, "\t");
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  text = text.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"');
  text = text.replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\u00A0/g, " ");
  text = text.replace(/^`+|`+$/g, "");
  return text.trim();
}

function separateFeedback(raw) {
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
}

function extractCode(raw) {
  if (!raw) return "";
  const match = String(raw).match(/```[a-z]*\n([\s\S]*?)```/i);
  const code = match ? match[1] : raw;
  return sanitizeMakeCode(code);
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

const TARGET_CONFIGS = {
  microbit: {
    name: "micro:bit",
    apis: [
      "basic: showNumber(n), showString(s), showIcon(IconNames), showLeds(`...`), showArrow(ArrowNames), clearScreen(), forever(handler), pause(ms)",
      "input: onButtonPressed(Button.A/B/AB, handler), onGesture(Gesture.Shake/Tilt/..., handler), onPinPressed(TouchPin.P0/P1/P2, handler), buttonIsPressed(Button), temperature(), lightLevel(), acceleration(Dimension.X/Y/Z), compassHeading(), rotation(Rotation), magneticForce(Dimension), runningTime()",
      "music: playTone(Note, BeatFraction), ringTone(freq), rest(BeatFraction), beat(BeatFraction), tempo(), setTempo(bpm), changeTempoBy(delta)",
      "led: plot(x,y), unplot(x,y), toggle(x,y), point(x,y), brightness(), setBrightness(n), plotBarGraph(value, high), enable(on)",
      "radio: sendNumber(n), sendString(s), sendValue(name, n), onReceivedNumber(handler), onReceivedString(handler), setGroup(id), setTransmitPower(n), setTransmitSerialNumber(on)",
      "game: createSprite(x,y), .move(n), .turn(Direction,degrees), .ifOnEdgeBounce(), .isTouching(other), .isTouchingEdge(), addScore(n), score(), setScore(n), setLife(n), addLife(n), removeLife(n), gameOver(), startCountdown(ms)",
      "pins: digitalReadPin(DigitalPin), digitalWritePin(DigitalPin,value), analogReadPin(AnalogPin), analogWritePin(AnalogPin,value), servoWritePin(AnalogPin,value), map(value,fromLow,fromHigh,toLow,toHigh), onPulsed(DigitalPin,PulseValue,handler), analogSetPitchPin(AnalogPin), analogPitch(freq,ms)",
      "images: createImage(`...`), createBigImage(`...`), arrowImage(ArrowNames), iconImage(IconNames)",
      "serial: writeLine(s), writeNumber(n), writeValue(name,value), readLine(), onDataReceived(delimiter,handler), redirect(tx,rx,rate)",
      "control: inBackground(handler), reset(), waitMicros(us)",
      "loops, logic, variables, math, functions, arrays, text (standard language built-ins)"
    ].join("\n"),
    example: [
      "input.onButtonPressed(Button.A, function () {",
      "    basic.showString(\"Hello\")",
      "})",
      "let count = 0",
      "basic.forever(function () {",
      "    count += 1",
      "    basic.showNumber(count)",
      "    basic.pause(1000)",
      "})"
    ].join("\n")
  },
  arcade: {
    name: "Arcade",
    apis: [
      "sprites: create(img, SpriteKind), createProjectileFromSprite(img, sprite, vx, vy), onCreated(SpriteKind, handler), onDestroyed(SpriteKind, handler), onOverlap(SpriteKind, SpriteKind, handler), allOfKind(SpriteKind)",
      "controller: moveSprite(sprite, vx, vy), controller.A.onEvent(ControllerButtonEvent, handler), controller.B.onEvent(ControllerButtonEvent, handler), dx(), dy()",
      "scene: setBackgroundColor(color), setBackgroundImage(img), cameraFollowSprite(sprite), setTileMapLevel(tilemap), onHitWall(SpriteKind, handler), onOverlapTile(SpriteKind, tile, handler)",
      "game: onUpdate(handler), onUpdateInterval(ms, handler), splash(title, subtitle?), over(win), reset()",
      "info: score(), setScore(n), changeScoreBy(n), life(), setLife(n), changeLifeBy(n), startCountdown(s), onCountdownEnd(handler), onLifeZero(handler)",
      "music: playTone(freq, ms), playMelody(melody, tempo), setVolume(vol)",
      "effects: spray, fire, warm radial, cool radial, halo, fountain (applied via sprite.startEffect())",
      "animation: runImageAnimation(sprite, frames, interval, loop), runMovementAnimation(sprite, path, interval, loop)"
    ].join("\n"),
    example: [
      "let mySprite = sprites.create(img`",
      "    . . . . . . . . . . . . . . . .",
      "    . . . . . . . . . . . . . . . .",
      "    . . . . . 7 7 7 7 7 . . . . . .",
      "    . . . . 7 7 7 7 7 7 7 . . . . .",
      "    . . . 7 7 7 7 7 7 7 7 7 . . . .",
      "    . . . . 7 7 7 7 7 7 7 . . . . .",
      "    . . . . . 7 7 7 7 7 . . . . . .",
      "    . . . . . . . . . . . . . . . .",
      "`, SpriteKind.Player)",
      "controller.moveSprite(mySprite)",
      "mySprite.setStayInScreen(true)"
    ].join("\n")
  },
  maker: {
    name: "Maker",
    apis: [
      "pins: digitalReadPin(DigitalPin), digitalWritePin(DigitalPin, value), analogReadPin(AnalogPin), analogWritePin(AnalogPin, value), servoWritePin(AnalogPin, value), map(value, fromLow, fromHigh, toLow, toHigh)",
      "input: onButtonPressed(handler), buttonIsPressed(), temperature(), lightLevel()",
      "loops: forever(handler), pause(ms)",
      "music: playTone(freq, ms), ringTone(freq), rest(ms), setTempo(bpm)"
    ].join("\n"),
    example: [
      "let on = false",
      "loops.forever(function () {",
      "    on = !(on)",
      "    if (on) {",
      "        pins.digitalWritePin(DigitalPin.P0, 1)",
      "    } else {",
      "        pins.digitalWritePin(DigitalPin.P0, 0)",
      "    }",
      "    loops.pause(500)",
      "})"
    ].join("\n")
  }
};

function systemPromptFor(target) {
  const config = TARGET_CONFIGS[target] || TARGET_CONFIGS.microbit;

  return [
    `You are a Microsoft MakeCode assistant for ${config.name}.`,
    `Your ONLY job is to produce MakeCode Static TypeScript that the MakeCode editor can decompile into visual BLOCKS for ${config.name}. Every line you output must be representable as a block. If a language feature has no block equivalent, do not use it.`,
    "",
    "AVAILABLE APIs:",
    config.apis,
    "",
    "BLOCK-COMPATIBLE PATTERNS (use these):",
    "- Event handlers: input.onButtonPressed(Button.A, function () { })",
    "- Forever loops: basic.forever(function () { })",
    "- Variables with let: let x = 0",
    "- Control flow: if/else, while, for (let i = 0; i < n; i++), for (let v of list)",
    "- Random choice from a list: options._pickRandom()",
    "- Named functions: function doSomething() { }",
    "",
    "BLOCK-SAFE REQUIREMENTS (hard):",
    "- No grey JavaScript blocks: every line must map to editable blocks",
    "- Every variable declaration must have an initializer (let x = ...)",
    "- For loops must be exactly: for (let i = 0; i < limit; i++) or for (let i = 0; i <= limit; i++)",
    "- Event registrations and function declarations must be top-level",
    "- Do not use optional/default parameters in user-defined functions",
    "- Do not return a value inside callbacks/event handlers",
    "- Do not pass more arguments than a block signature supports",
    "- In statements, assignment operators are limited to =, +=, -=",
    "",
    "AVOID (these won't decompile to blocks):",
    "- Arrow functions (=>), ternary (? :), destructuring, spread/rest (...)",
    "- const, var (use let for all variables)",
    "- Template literals for strings (use \"string\" + variable, not `${}`). Exception: backtick image literals like img`...` and showLeds(`...`) ARE allowed — these are a special MakeCode compiler feature, not string templates.",
    "- Optional chaining (?.), nullish coalescing (??)",
    "- for...in loops",
    "- import/export, async/await, yield, eval",
    "- Classes, interfaces, type aliases, enums, generics in user code",
    "- Higher-order array methods (map/filter/reduce/forEach)",
    "- randint(...) (use list._pickRandom() for random selections)",
    "- null, undefined, casts (as), bitwise operators (| & ^ << >> >>>), bitwise compound assignments",
    "- setTimeout, setInterval, console, Promise",
    "- Comments, markdown fences, prose after code",
    "",
    "RESPONSE FORMAT:",
    "- You may prefix short notes with FEEDBACK: (one per line)",
    "- Then output ONLY MakeCode Static TypeScript, no markdown fences or extra prose",
    "- Straight quotes, ASCII only, real newlines, function () { } handlers",
    "- If PAGE_ERRORS are provided, treat them as failing diagnostics and prioritise resolving all of them",
    "- If CONVERSION_DIALOG is provided, ensure the output converts from JavaScript back to Blocks in MakeCode",
    "",
    `TARGET SCOPE: Use ONLY ${config.name} APIs listed above. Never mix APIs from other targets.`,
    "",
    "EXAMPLE:",
    config.example,
    "",
    `If unsure about an API, return a minimal working program for ${config.name}.`
  ].join("\n");
}

function userPromptFor(request, currentCode, pageErrors, conversionDialog) {
  const header = "USER_REQUEST:\n" + request.trim();
  const blocks = [header];
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
  if (currentCode && String(currentCode).trim()) {
    blocks.push("<<<CURRENT_CODE>>>\n" + currentCode + "\n<<<END_CURRENT_CODE>>>");
  }
  return blocks.join("\n\n");
}

async function callOpenAI(key, model, system, user, signal) {
  const body = {
    model,
    temperature: 0.1,
    max_tokens: 3072,
    messages: [{ role: "system", content: system }, { role: "user", content: user }]
  };

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + key
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`OpenAI error (${response.status})`);
  }

  const data = await response.json();
  return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
}

async function callOpenRouter(key, model, system, user, signal) {
  const body = {
    model,
    temperature: 0.1,
    max_tokens: 3072,
    messages: [{ role: "system", content: system }, { role: "user", content: user }]
  };

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + key
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`OpenRouter error (${response.status})`);
  }

  const data = await response.json();
  return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
}

async function callGemini(key, model, system, user, signal) {
  const url = "https://generativelanguage.googleapis.com/v1/models/" + encodeURIComponent(model) + ":generateContent?key=" + encodeURIComponent(key);
  const body = {
    contents: [{ role: "user", parts: [{ text: system + "\n\n" + user }] }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 3072
    }
  };

  const response = await fetch(url, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`Gemini error (${response.status})`);
  }

  const data = await response.json();
  return extractGeminiText(data);
}

async function generateManaged({ target, request, currentCode, pageErrors, conversionDialog }) {
  const provider = PROVIDER;
  const key = apiKeyFor(provider);
  const model = modelFor(provider);

  if (!key) {
    throw new Error(`Missing API key for provider '${provider}'. Set VIBBIT_API_KEY or provider-specific key.`);
  }

  const system = systemPromptFor(target);
  const user = userPromptFor(request, currentCode || "", pageErrors || [], conversionDialog || null);
  const callProvider = async (systemPrompt) => withTimeout(async (signal) => {
    if (provider === "openai") return callOpenAI(key, model, systemPrompt, user, signal);
    if (provider === "gemini") return callGemini(key, model, systemPrompt, user, signal);
    if (provider === "openrouter") return callOpenRouter(key, model, systemPrompt, user, signal);
    throw new Error(`Unsupported VIBBIT_PROVIDER '${provider}'`);
  }, REQUEST_TIMEOUT_MS);

  const oneAttempt = async (extraSystem, insistOnlyCode) => {
    const prompt = system
      + (extraSystem ? ("\n" + extraSystem) : "")
      + (insistOnlyCode ? "\nMANDATE: You must output only Blocks-decompilable MakeCode Static TypeScript." : "");
    const raw = await callProvider(prompt);
    const parts = separateFeedback(raw);
    const code = extractCode(parts.body);
    const validation = code ? validateBlocksCompatibility(code, target) : { ok: false, violations: ["empty output"] };
    return { code, feedback: parts.feedback, validation };
  };

  let result = await oneAttempt("", false);

  for (let i = 0; i < EMPTY_RETRIES && (!result.code || !result.code.trim()); i++) {
    result = await oneAttempt("Your last message returned no code. Return ONLY Blocks-decompilable MakeCode Static TypeScript. No prose.", true);
  }

  for (let i = 0; i < VALIDATION_RETRIES && result.code && result.code.trim() && result.validation && !result.validation.ok; i++) {
    const violations = result.validation.violations || [];
    const extra = i === 0
      ? ("Previous code used: " + violations.join(", ") + ". Remove ALL forbidden constructs and return fully Blocks-compatible code.")
      : ("STRICT MODE: Output a smaller program that fully decompiles to Blocks. Absolutely no: " + violations.join(", ") + ".");
    result = await oneAttempt(extra, true);
  }

  if (!result.code || !result.code.trim()) {
    return {
      code: stubForTarget(target),
      feedback: [...result.feedback, "Model returned no code; provided fallback stub."]
    };
  }

  if (!result.validation || !result.validation.ok) {
    const violations = (result.validation && result.validation.violations) || [];
    return {
      code: stubForTarget(target),
      feedback: [...result.feedback, "Validation fallback: " + violations.join(", ")]
    };
  }

  return { code: result.code, feedback: result.feedback };
}

function extractBearerToken(headerValue) {
  if (!headerValue) return "";
  const match = String(headerValue).match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : "";
}

function validatePayload(payload) {
  const target = payload && typeof payload.target === "string" ? payload.target.trim() : "";
  const request = payload && typeof payload.request === "string" ? payload.request.trim() : "";
  const currentCode = payload && typeof payload.currentCode === "string" ? payload.currentCode : "";
  const rawPageErrors = payload && Array.isArray(payload.pageErrors) ? payload.pageErrors : [];
  const pageErrors = rawPageErrors
    .map((item) => String(item || "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 8);
  const rawConversionDialog = payload && payload.conversionDialog && typeof payload.conversionDialog === "object"
    ? payload.conversionDialog
    : null;
  const conversionDialog = rawConversionDialog
    ? {
      title: String(rawConversionDialog.title || "").replace(/\s+/g, " ").trim().slice(0, 220),
      description: String(rawConversionDialog.description || "").replace(/\s+/g, " ").trim().slice(0, 320)
    }
    : null;

  if (!request) {
    return { ok: false, error: "'request' is required" };
  }

  const safeTarget = ["microbit", "arcade", "maker"].includes(target) ? target : "microbit";

  return {
    ok: true,
    value: {
      target: safeTarget,
      request,
      currentCode,
      pageErrors,
      conversionDialog
    }
  };
}

const server = createServer(async (req, res) => {
  const origin = req.headers.origin || "";
  const pathname = new URL(req.url || "/", "http://localhost").pathname;

  if (req.method === "OPTIONS") {
    handleOptions(req, res);
    return;
  }

  if (pathname === "/healthz" && req.method === "GET") {
    respondJson(res, 200, {
      ok: true,
      provider: PROVIDER,
      model: modelFor(PROVIDER),
      tokenRequired: Boolean(SERVER_APP_TOKEN)
    }, origin);
    return;
  }

  if (pathname === "/vibbit/generate" && req.method === "POST") {
    try {
      if (SERVER_APP_TOKEN) {
        const token = extractBearerToken(req.headers.authorization);
        if (!token || token !== SERVER_APP_TOKEN) {
          respondJson(res, 401, { error: "Unauthorized" }, origin);
          return;
        }
      }

      const payload = await readJson(req);
      const validated = validatePayload(payload);

      if (!validated.ok) {
        respondJson(res, 400, { error: validated.error }, origin);
        return;
      }

      const result = await generateManaged(validated.value);
      respondJson(res, 200, result, origin);
    } catch (error) {
      const message = error && error.name === "AbortError"
        ? `Generation timed out after ${REQUEST_TIMEOUT_MS}ms`
        : (error && error.message ? error.message : "Internal server error");
      respondJson(res, 500, { error: message }, origin);
    }
    return;
  }

  respondJson(res, 404, { error: "Not found" }, origin);
});

server.listen(PORT, () => {
  console.log(`[Vibbit backend] Listening on http://localhost:${PORT}`);
  console.log(`[Vibbit backend] Provider=${PROVIDER} model=${modelFor(PROVIDER)}`);
  if (SERVER_APP_TOKEN) {
    console.log("[Vibbit backend] SERVER_APP_TOKEN auth enabled");
  }
});
