export const SHARED_COMPAT_EXPORT_NAMES = [
  "sanitizeMakeCode",
  "normaliseFeedback",
  "resolvePromptTargetContext",
  "buildUserPrompt",
  "extractCode",
  "parseModelOutput",
  "validateBlocksCompatibility",
  "buildTargetPromptExtras",
  "MICROBIT_EXTENSIONS",
  "detectRequiredExtensions",
  "extensionDependencies",
  "buildExtensionPromptExtras",
  "buildSystemPrompt",
  "buildCorrectionInstruction",
  "stubForTarget",
  "extractGeminiText",
  "runValidateBlocks",
  "buildFailedAttemptUserTurn",
  "buildDecompileFixRequest",
  "serializeTranscript",
  "runGenerationLoop"
];

export function sanitizeMakeCode(input) {
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

export function normaliseFeedback(items, fallback = "") {
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

export function resolvePromptTargetContext(target) {
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

export const DEFAULT_CURRENT_CODE_TRUNCATION_MARKER = "\n// ... CURRENT_CODE_TRUNCATED ...\n";

export function boundCurrentCodeForPrompt(currentCode, {
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

export function buildUserPrompt({
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

export function extractCode(raw) {
  if (!raw) return "";
  const match = String(raw).match(/```[a-z]*\n([\s\S]*?)```/i);
  const code = match ? match[1] : raw;
  return sanitizeMakeCode(code);
}

export function parseModelOutput(raw) {
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
  "radio.onReceivedNumber(function (receivedNumber) { basic.showNumber(receivedNumber) })",
  "basic.showIcon(IconNames.Duck); basic.pause(1000); basic.clearScreen()"
];

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function templateHasInterpolation(source) {
  const input = String(source || "");
  let inTemplate = false;
  let escaped = false;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    const next = i + 1 < input.length ? input[i + 1] : "";
    if (!inTemplate) {
      if (char === "`") inTemplate = true;
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "`") {
      inTemplate = false;
      continue;
    }
    if (char === "$" && next === "{") return true;
  }
  return false;
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


// ── micro:bit extension registry ──────────────────────────────────────────
// Each entry describes a MakeCode package that is NOT part of the core target.
// Code using these APIs will not compile unless the package is a project
// dependency, so the registry drives three things at once: prompt grounding,
// static validation, and the dependency set used by the live decompile probe.
//
// `pkg` is what goes into pxt.json dependencies. Third-party packages use the
// github:owner/repo#tag form and MUST be pinned to a tag, never to a branch.
export const MICROBIT_EXTENSIONS = Object.freeze({
  neopixel: {
    id: "neopixel",
    label: "NeoPixel",
    pkg: "neopixel",
    docs: "https://makecode.microbit.org/pkg/microsoft/pxt-neopixel",
    // Detects use in generated code.
    detect: /\bneopixel\s*\./,
    // Detects intent in a natural-language request (prompt injection trigger).
    intent: /\b(neo\s?pixel|ws2812|led strip|light strip|addressable led|rgb strip)\b/i,
    apis: [
      "neopixel.create(DigitalPin, numLeds, NeoPixelMode) -> Strip",
      "strip.show(), strip.clear(), strip.setBrightness(0-255), strip.rotate(offset)",
      "strip.setPixelColor(index, rgb), strip.showColor(rgb), strip.showRainbow(low, high)",
      "neopixel.colors(NeoPixelColors.Red), neopixel.rgb(r, g, b), neopixel.hsl(h, s, l)",
      "strip.range(start, length) -> Strip, strip.length()"
    ],
    enums: {
      NeoPixelColors: ["Red", "Orange", "Yellow", "Green", "Blue", "Indigo", "Violet", "Purple", "White", "Black"],
      NeoPixelMode: ["RGB", "RGBW", "RGB_RGB"]
    },
    signatures: [
      { call: "neopixel.create", minArgs: 3, maxArgs: 3 },
      { call: "neopixel.colors", minArgs: 1, maxArgs: 1 },
      { call: "neopixel.rgb", minArgs: 3, maxArgs: 3 },
      { call: "neopixel.hsl", minArgs: 3, maxArgs: 3 }
    ],
    rules: [
      "Create the strip once as a top-level variable: let strip = neopixel.create(DigitalPin.P1, 8, NeoPixelMode.RGB). Never create it inside a handler or a loop.",
      "Colour changes are not visible until strip.show() is called.",
      "Pixel indexes start at 0 and stop at numLeds - 1."
    ],
    example: [
      "let strip = neopixel.create(DigitalPin.P1, 8, NeoPixelMode.RGB)",
      "input.onButtonPressed(Button.A, function () {",
      "    strip.showColor(neopixel.colors(NeoPixelColors.Red))",
      "    strip.show()",
      "})"
    ].join("\n")
  },
  sonar: {
    id: "sonar",
    label: "Sonar (HC-SR04)",
    pkg: "sonar",
    docs: "https://makecode.microbit.org/pkg/microsoft/pxt-sonar",
    detect: /\bsonar\s*\./,
    intent: /\b(sonar|ultrasonic|hc-?sr04|distance sensor|range finder|rangefinder)\b/i,
    apis: [
      "sonar.ping(trig: DigitalPin, echo: DigitalPin, unit: PingUnit) -> number",
      "sonar.ping(trig, echo, unit, maxCmDistance) -> number"
    ],
    enums: { PingUnit: ["Centimeters", "Inches", "MicroSeconds"] },
    signatures: [{ call: "sonar.ping", minArgs: 3, maxArgs: 4 }],
    rules: [
      "trig and echo must be two DIFFERENT pins.",
      "sonar.ping returns 0 when nothing is in range. Guard readings with if (d > 0).",
      "Poll inside basic.forever with a pause of at least 50 ms between pings."
    ],
    example: [
      "basic.forever(function () {",
      "    let d = sonar.ping(DigitalPin.P1, DigitalPin.P2, PingUnit.Centimeters)",
      "    if (d > 0 && d < 10) {",
      "        basic.showIcon(IconNames.Heart)",
      "    } else {",
      "        basic.clearScreen()",
      "    }",
      "    basic.pause(100)",
      "})"
    ].join("\n")
  },
  blehid: {
    id: "blehid",
    label: "Bluetooth HID (keyboard/mouse)",
    // Pinned to a tag on purpose: a maintainer push to main must not break class.
    pkg: "github:bsiever/microbit-pxt-blehid#v0.3.4",
    docs: "https://makecode.microbit.org/pkg/bsiever/microbit-pxt-blehid",
    detect: /\b(keyboard|mouse|media|absmouse)\s*\./,
    intent: /\b(ble ?hid|bluetooth keyboard|bluetooth mouse|hid|act as a keyboard|control my computer|keypress|send keystrokes)\b/i,
    apis: [
      "keyboard.startKeyboardService(), keyboard.sendString(text), keyboard.sendSimultaneousKeys(keys, isDown)",
      "mouse.startMouseService(), mouse.movePointer(dx, dy), mouse.setButton(MouseButton, isDown)",
      "media.startMediaService(), media.keyCommand(MediaKey)"
    ],
    enums: {},
    signatures: [
      { call: "keyboard.startKeyboardService", minArgs: 0, maxArgs: 0 },
      { call: "keyboard.sendString", minArgs: 1, maxArgs: 1 },
      { call: "mouse.startMouseService", minArgs: 0, maxArgs: 0 },
      { call: "mouse.movePointer", minArgs: 2, maxArgs: 2 }
    ],
    rules: [
      "micro:bit V2 only. Say so in the feedback so the student checks their board.",
      "The project must be built with Project Settings > No Pairing Required: Anyone can connect via Bluetooth. Say this in the feedback.",
      "Call the start...Service() function ONCE as a top-level statement, then basic.pause(500) before sending anything.",
      "The host computer must pair with the micro:bit before keystrokes arrive."
    ],
    example: [
      "keyboard.startKeyboardService()",
      "basic.pause(500)",
      "input.onButtonPressed(Button.A, function () {",
      "    keyboard.sendString(\"hello\")",
      "})"
    ].join("\n")
  }
});

// Servo is deliberately absent: pins.servoWritePin is core micro:bit and needs
// no package. Its guidance lives in SERVO_RULES and is injected on intent only.
const SERVO_INTENT = /\b(servo|sg90|micro servo|steering|arm|gate|barrier)\b/i;
const SERVO_RULES = [
  "Servos are built in. Use pins.servoWritePin(AnalogPin.P0, angle) with angle between 0 and 180. Do NOT add an extension.",
  "Continuous rotation servos use pins.servoSetPulse(AnalogPin, micros) instead.",
  "Give a servo at least 300 ms to reach a position before writing the next angle."
];

// Hardware rules that produce warnings rather than hard validation failures.
// These are the mistakes that actually waste classroom time.
const HARDWARE_WARNINGS = [
  {
    when: (code) => /neopixel\.create\s*\(\s*DigitalPin\.P0\b/.test(code),
    warn: "NeoPixel on P0 clashes with the built-in speaker on micro:bit V2. Prefer P1 or P2."
  },
  {
    when: (code) => /pins\.servoWritePin\s*\(\s*AnalogPin\.P0\b/.test(code),
    warn: "Servo on P0 clashes with the built-in speaker on micro:bit V2. Prefer P1 or P2."
  },
  {
    when: (code) => /\bradio\./.test(code) && !/radio\.setGroup\s*\(/.test(code),
    warn: "radio is used but radio.setGroup(n) is never called. Every board in the class will hear every message."
  },
  {
    when: (code) => {
      const calls = code.match(/pins\.servoWritePin\s*\([^,]+,\s*(-?\d+)\s*\)/g) || [];
      return calls.some((call) => {
        const value = Number((call.match(/,\s*(-?\d+)\s*\)$/) || [])[1]);
        return Number.isFinite(value) && (value < 0 || value > 180);
      });
    },
    warn: "Servo angle is outside 0-180. The servo will stall or buzz."
  },
  {
    when: (code) => {
      const match = code.match(/sonar\.ping\s*\(\s*DigitalPin\.(P\d+)\s*,\s*DigitalPin\.(P\d+)/);
      return Boolean(match) && match[1] === match[2];
    },
    warn: "sonar.ping trig and echo are on the same pin. They must be two different pins."
  },
  {
    when: (code) => /function\s*\([^)]*\)\s*\{[\s\S]*?neopixel\.create\s*\(/.test(code),
    warn: "neopixel.create looks like it is inside a handler. Create the strip once at the top level."
  }
];

function extensionEntries() {
  return Object.keys(MICROBIT_EXTENSIONS).map((key) => MICROBIT_EXTENSIONS[key]);
}

// Returns the extension ids a piece of code (and/or a request) needs.
// `code` is authoritative; `request` only adds intent-based hints so the system
// prompt can be primed before any code exists.
export function detectRequiredExtensions(code, request = "", target = "microbit") {
  if (target !== "microbit") return [];
  const codeView = stripNonCodeSegments(String(code || ""));
  const requestText = String(request || "");
  const found = new Set();
  for (const entry of extensionEntries()) {
    if (entry.detect && entry.detect.test(codeView)) found.add(entry.id);
    else if (requestText && entry.intent && entry.intent.test(requestText)) found.add(entry.id);
  }
  return [...found];
}

// pxt.json dependency fragment for a detected extension set.
export function extensionDependencies(ids) {
  const deps = {};
  for (const id of ids || []) {
    const entry = MICROBIT_EXTENSIONS[id];
    if (entry) deps[entry.id] = entry.pkg === entry.id ? "*" : entry.pkg;
  }
  return deps;
}

// Prompt grounding for the detected extensions only. Injecting all of them on
// every request wastes context and biases the model towards reaching for a
// strip when led.plot would do.
export function buildExtensionPromptExtras(target, requestHint = "", code = "") {
  if (target !== "microbit") return [];
  const ids = detectRequiredExtensions(code, requestHint, target);
  const lines = [];
  for (const id of ids) {
    const entry = MICROBIT_EXTENSIONS[id];
    if (!entry) continue;
    lines.push("", "EXTENSION - " + entry.label + " (MakeCode package: " + entry.pkg + "):");
    lines.push("The student MUST add this extension to the project before the code will run. State that in the first feedback line.");
    lines.push(...entry.apis.map((api) => "- " + api));
    for (const enumName of Object.keys(entry.enums || {})) {
      lines.push("- Valid " + enumName + ": " + entry.enums[enumName].map((m) => enumName + "." + m).join(", "));
    }
    lines.push(...entry.rules.map((rule) => "- " + rule));
    lines.push("Worked example:", entry.example);
  }
  if (SERVO_INTENT.test(String(requestHint || "")) || /pins\.servo/.test(String(code || ""))) {
    lines.push("", "SERVO (built into micro:bit, no extension needed):");
    lines.push(...SERVO_RULES.map((rule) => "- " + rule));
  }
  return lines;
}

export function buildTargetPromptExtras(target) {
  if (target !== "microbit") return [];
  return [
    "MICRO:BIT BUILT-IN ICON/ENUM RULES (from pxt-microbit):",
    "If the request matches a built-in icon name (for example duck, heart, skull), prefer basic.showIcon(IconNames.<Name>).",
    "Write startup behaviour as top-level statements. They become the on start block. Do not call basic.onStart.",
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

// Per-target grounding shared by Managed and BYOK system prompts. Each entry
// carries the API cheat sheet plus a worked request -> response example so the
// model sees both the supported surface and the exact output contract.
export const TARGET_API_CATALOG = {
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
    request: "count up each time I press button A and show the number",
    feedback: ["Press A to add one and show the running count."],
    example: [
      "let count = 0",
      "input.onButtonPressed(Button.A, function () {",
      "    count += 1",
      "    basic.showNumber(count)",
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
    request: "make a player sprite I can move with the controller",
    feedback: ["Created a player sprite you can move with the D-pad."],
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
    request: "blink the LED on pin P0 on and off",
    feedback: ["Toggles P0 every half second so the LED blinks."],
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

function resolveTargetConfig(target) {
  return TARGET_API_CATALOG[target] || TARGET_API_CATALOG.microbit;
}

// Target-specific positive examples so each prompt never cites APIs from another
// platform (e.g. Arcade must not see basic.forever or input.onButtonPressed).
function buildBlockSafeDoRules(target) {
  const targetKey = TARGET_API_CATALOG[target] ? target : "microbit";
  const common = [
    "Declare every variable with let and an initial value, e.g. let score = 0.",
    "Write for loops exactly as for (let i = 0; i < limit; i++) or for (let i = 0; i <= limit; i++); walk a list with for (let item of list).",
    "Keep event registrations and function declarations at the top level, never nested inside another handler.",
    "Pick a random item with options._pickRandom() from an array of choices.",
    "Join strings with \"text\" + value, and pass function () { } for every handler."
  ];
  if (targetKey === "arcade") {
    return [
      "Use event handlers and loops, e.g. controller.A.onEvent(ControllerButtonEvent.Pressed, function () { }), game.onUpdate(function () { }).",
      "Match each block's exact argument count and use only valid Arcade enums (e.g. SpriteKind.Player, ControllerButtonEvent.Pressed).",
      ...common
    ];
  }
  if (targetKey === "maker") {
    return [
      "Use event handlers and loops, e.g. input.onButtonPressed(function () { }), loops.forever(function () { }).",
      "Match each block's exact argument count and use only valid Maker enums (e.g. DigitalPin.P0).",
      ...common
    ];
  }
  return [
    "Use event handlers and loops, e.g. input.onButtonPressed(Button.A, function () { }), basic.forever(function () { }). Write startup behaviour as top-level statements; they become the on start block.",
    "Match each block's exact argument count and use only valid enum members (e.g. Button.A, IconNames.Heart).",
    ...common
  ];
}

// Hard exclusions: each line removes a construct the MakeCode decompiler cannot
// represent as a block. Kept tight so the list stays load-bearing, not decorative.
const BLOCK_UNSAFE_RULES = [
  "Arrow functions (=>), ternary (? :), destructuring, spread/rest (...).",
  "const or var (always use let).",
  "Template-string interpolation (`${ }`). Backtick image literals img`...`, showLeds(`...`) and createImage(`...`) ARE allowed: they are a MakeCode compiler feature, not string templates.",
  "Optional chaining (?.), nullish coalescing (??), for...in loops.",
  "import/export, async/await/Promise, yield, eval, classes, interfaces, type aliases, enums, generics.",
  "Higher-order array methods (map/filter/reduce/forEach/find/some/every).",
  "randint(...) (use options._pickRandom() instead).",
  "null, undefined, casts (as), and bitwise operators (| & ^ << >> >>>) with their compound assignments.",
  "setTimeout, setInterval, console, comments, markdown fences, or any prose outside the JSON.",
  "Returning a value from a callback/handler, optional or default parameters in your own functions, and assignment operators other than =, +=, -=.",
  "basic.onStart(...) (write startup code at the top level instead)."
];

const OUTPUT_FORMAT_RULES = [
  "Return ONLY one compact JSON object: {\"feedback\":[\"short note\"],\"code\":\"MakeCode Static TypeScript with \\\\n escapes\"}.",
  "feedback is an array of one or more short, friendly strings.",
  "code is MakeCode Static TypeScript encoded as a JSON string: newlines as escaped \\n, straight quotes, ASCII only, no markdown fences, no comments.",
  "If PAGE_ERRORS are provided, treat them as failing diagnostics and fix every one of them.",
  "If CONVERSION_DIALOG is provided, rewrite the code so MakeCode can convert it back to Blocks."
];

function buildFewShotExample(config) {
  const response = JSON.stringify({
    feedback: Array.isArray(config.feedback) ? config.feedback : [],
    code: config.example || ""
  });
  return "USER_REQUEST: " + String(config.request || "") + "\nRESPONSE: " + response;
}

// Shared system-prompt builder for both Managed and BYOK paths. Structured as
// Identity -> Capabilities -> Constraints -> Format with the prime directive at
// the top and a single load-bearing rule repeated at the very end, because
// models attend most strongly to the first and last lines of a long prompt.
export function buildSystemPrompt(target, options = {}) {
  const { conversational = false, requestHint = "", currentCode = "" } = options;
  const targetKey = TARGET_API_CATALOG[target] ? target : "microbit";
  const config = TARGET_API_CATALOG[targetKey];
  const targetPromptExtras = buildTargetPromptExtras(targetKey);

  const lines = [];

  // 1. Identity + prime directive (front anchor)
  lines.push(conversational
    ? "ROLE: You are a friendly Microsoft MakeCode assistant helping a student build a " + config.name + " project. Be encouraging, brief, and conversational."
    : "ROLE: You are a Microsoft MakeCode assistant for " + config.name + ".");
  lines.push("PRIME DIRECTIVE: Output ONLY MakeCode Static TypeScript that the MakeCode decompiler converts to BLOCKS for " + config.name + " with ZERO errors. Every line must map to a block; if a feature has no block equivalent, do not use it.");

  // 2. Capabilities (grounding)
  lines.push("", "AVAILABLE APIS (use " + config.name + " APIs only, never mix in another target's APIs):", config.apis);
  if (targetPromptExtras.length) lines.push(...targetPromptExtras);
  const extensionExtras = buildExtensionPromptExtras(targetKey, requestHint, currentCode);
  if (extensionExtras.length) lines.push(...extensionExtras);

  // 3. Constraints (positive guidance first, then forbidden constructs)
  lines.push("", "WRITE BLOCK-SAFE CODE:");
  lines.push(...buildBlockSafeDoRules(targetKey).map((rule) => "- " + rule));
  lines.push("", "NEVER USE (these break Blocks conversion):");
  lines.push(...BLOCK_UNSAFE_RULES.map((rule) => "- " + rule));

  if (conversational) {
    lines.push("", "CONVERSATION: If RECENT_CHAT is provided, use only that recent context. Treat CURRENT_CODE as the source of truth for project state. If CURRENT_CODE is truncated, make conservative edits and preserve existing patterns.");
  }

  // 4. Output contract
  lines.push("", "OUTPUT FORMAT:");
  lines.push(...OUTPUT_FORMAT_RULES.map((rule) => "- " + rule));

  // Few-shot demonstration of the full request -> response contract
  lines.push("", "EXAMPLE (" + config.name + " request -> response):", buildFewShotExample(config));

  // End anchor (recency): repeat the single rule that must always hold
  lines.push("", "FINAL RULE: Reply with only the JSON object {\"feedback\":[...],\"code\":\"...\"} and no other text. If unsure, return a minimal program guaranteed to decompile to Blocks for " + config.name + ".");

  return lines.join("\n");
}

export function validateBlocksCompatibility(code, target) {
  const rules = [
    { re: /=>/g, why: "arrow functions" },
    { re: /\bclass\s+/g, why: "classes" },
    { re: /\bnew\s+[A-Z_a-z]/g, why: "new constructor" },
    { re: /\bPromise\b|\basync\b|\bawait\b/g, why: "promises/async" },
    { re: /\bimport\s|\bexport\s/g, why: "import/export" },
    { test: templateHasInterpolation, why: "template string interpolation" },
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

  const codeView = stripNonCodeSegments(code);
  const stringView = code.replace(
    /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g,
    (match) => " ".repeat(match.length)
  );

  if ((target === "microbit" || target === "maker") && /sprites\.|controller\.|scene\.|game\.onUpdate/i.test(codeView)) {
    return { ok: false, violations: ["Arcade APIs in micro:bit/Maker"], warnings: [], extensions: [] };
  }
  if (target === "arcade" && (/led\./i.test(codeView) || /radio\./i.test(codeView))) {
    return { ok: false, violations: ["micro:bit APIs in Arcade"], warnings: [], extensions: [] };
  }

  const violations = [];
  for (const rule of rules) {
    if (typeof rule.test === "function") {
      if (rule.test(code)) violations.push(rule.why);
      continue;
    }
    const haystack = (rule.why === "line comments" || rule.why === "block comments")
      ? stringView
      : codeView;
    rule.re.lastIndex = 0;
    if (rule.re.test(haystack)) violations.push(rule.why);
  }
  if (/\bnull\b/.test(stringView)) violations.push("null");
  if (/\bundefined\b/.test(stringView)) violations.push("undefined");
  if (/\bas\s+[A-Z_a-z][A-Z_a-z0-9_.]*/.test(stringView)) violations.push("casts");
  // Live MakeCode cannot convert onStart() / basic.onStart() back to the on start block.
  // Require a non-member prefix so Arcade APIs such as game.onStart are not banned.
  if (/(?:^|[^\w.])(?:basic\.)?onStart\s*\(/.test(stringView)) violations.push("basic.onStart()");
  if (bitwiseRules.some((rule) => {
    rule.lastIndex = 0;
    return rule.test(codeView);
  })) violations.push("bitwise operators");
  if (/\bfor\s*\([^)]*\bin\b[^)]*\)/.test(codeView)) violations.push("for...in loops");

  const forHeaderRe = /for\s*\(([^)]*)\)/g;
  let forMatch;
  while ((forMatch = forHeaderRe.exec(codeView))) {
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

  const lines = codeView.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
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

  const warnings = [];
  const extensions = detectRequiredExtensions(code, "", target);

  if (target === "microbit") {
    // Extension enums and signatures are merged in only when the extension is
    // actually used, so an unused NeoPixelColors.* elsewhere still fails.
    const enumSets = Object.assign({}, MICROBIT_ENUM_MEMBER_SETS);
    const signatures = [...MICROBIT_CALL_SIGNATURES];
    for (const id of extensions) {
      const entry = MICROBIT_EXTENSIONS[id];
      if (!entry) continue;
      for (const enumName of Object.keys(entry.enums || {})) {
        enumSets[enumName] = new Set(entry.enums[enumName]);
      }
      signatures.push(...(entry.signatures || []));
    }
    violations.push(...validateKnownEnumMembers(code, enumSets));
    violations.push(...validateCallSignatures(code, signatures));

    for (const rule of HARDWARE_WARNINGS) {
      try {
        if (rule.when(codeView)) warnings.push(rule.warn);
      } catch {
        // A warning heuristic must never take down validation.
      }
    }
  }

  if (/[^\x09\x0A\x0D\x20-\x7E]/.test(code)) violations.push("non-ASCII characters");
  return {
    ok: violations.length === 0,
    violations: [...new Set(violations)],
    warnings: [...new Set(warnings)],
    extensions
  };
}

export function stubForTarget(target) {
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
  return "basic.showString(\"Hi\")";
}

// Maps validator findings to concrete, positively-framed corrective actions so a
// retry tells the model how to fix the code rather than only what was wrong.
const VIOLATION_FIX_HINTS = [
  { match: /arrow function/i, hint: "replace => callbacks with function () { } handlers" },
  { match: /template string/i, hint: "build strings with \"text\" + value instead of `${ }`" },
  { match: /higher-order array/i, hint: "loop with for (let item of list) instead of map/filter/forEach" },
  { match: /for-loop|for\.\.\.in/i, hint: "use for (let i = 0; i < limit; i++)" },
  { match: /randint/i, hint: "use options._pickRandom() for random choices" },
  { match: /without initializer/i, hint: "give every let an initial value, e.g. let x = 0" },
  { match: /nested event|non-top-level/i, hint: "move event handlers and functions to the top level" },
  { match: /basic\.onStart/i, hint: "write startup behaviour as top-level statements; they become the on start block" },
  { match: /enum member/i, hint: "use only valid enum members such as Button.A or IconNames.Heart" },
  { match: /arity/i, hint: "match each block's exact argument count" },
  { match: /Arcade APIs|micro:bit APIs|other target/i, hint: "use only APIs for the selected target" },
  { match: /optional\/default parameters/i, hint: "remove optional or default parameters from your functions" },
  { match: /assignment operators/i, hint: "use only =, += or -= in statements" },
  { match: /bitwise/i, hint: "avoid bitwise operators (| & ^ << >>)" },
  { match: /class|interface|type|generic/i, hint: "remove TypeScript classes, interfaces, types and generics" },
  { match: /comment/i, hint: "remove all comments" },
  { match: /non-ASCII/i, hint: "use plain ASCII characters and straight quotes" }
];

export function buildCorrectionInstruction(violations, target, options = {}) {
  const { strict = false } = options;
  const list = (Array.isArray(violations) ? violations : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  const targetName = resolveTargetConfig(target).name;

  const hints = [];
  const seenHints = new Set();
  for (const violation of list) {
    for (const { match, hint } of VIOLATION_FIX_HINTS) {
      if (match.test(violation) && !seenHints.has(hint)) {
        seenHints.add(hint);
        hints.push(hint);
      }
    }
  }

  const parts = [strict
    ? "STRICT MODE: your previous code still will not decompile to Blocks for " + targetName + "."
    : "Your previous code will not decompile to Blocks for " + targetName + "."];
  if (list.length) parts.push("Problems: " + list.join(", ") + ".");
  if (hints.length) parts.push("Fix by: " + hints.join("; ") + ".");
  parts.push(strict
    ? "Return a smaller program that uses only block-safe " + targetName + " constructs, as JSON only."
    : "Return corrected, fully block-safe " + targetName + " code as JSON only.");
  return parts.join(" ");
}

export function extractGeminiText(response) {
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

export function runValidateBlocks(code, target) {
  return validateBlocksCompatibility(code, target);
}

function transcriptTurn(role, content) {
  return { role, content: content == null ? "" : String(content) };
}

export function buildFailedAttemptUserTurn({
  code,
  validation,
  target,
  kind,
  strict = false,
  decompile = null
} = {}) {
  const failedProgramme = code == null ? "" : String(code);
  const lines = [
    "<<<FAILED_ATTEMPT>>>",
    failedProgramme,
    "<<<END_FAILED_ATTEMPT>>>"
  ];
  if (kind === "empty") {
    lines.push("Your previous reply had empty code. Return a complete MakeCode programme as JSON only.");
  } else if (kind === "decompile") {
    lines.push(buildDecompileFixRequest({
      greyBlocks: decompile && decompile.greyBlocks,
      snippets: decompile && decompile.snippets,
      reason: (decompile && decompile.reason) || "MakeCode decompile produced grey blocks."
    }));
  } else {
    const violations = validation && Array.isArray(validation.violations) ? validation.violations : [];
    lines.push(buildCorrectionInstruction(violations, target, { strict: Boolean(strict) }));
  }
  lines.push("Return ONLY one compact JSON object: {\"feedback\":[\"short note\"],\"code\":\"MakeCode Static TypeScript\"}. No prose.");
  return lines.join("\n");
}

export function buildDecompileFixRequest({ greyBlocks, snippets, reason } = {}) {
  const count = Math.max(0, Math.trunc(Number(greyBlocks) || 0));
  const why = String(reason || "").trim();
  const examples = (Array.isArray(snippets) ? snippets : [])
    .map((item) => String(item || "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 3);
  const parts = [
    "Fix the current JavaScript so MakeCode decompiles it to native Blocks.",
    "There must be no grey typescript_statement blocks.",
    "Preserve intended behaviour."
  ];
  if (count) parts.push("Grey block count: " + count + ".");
  if (why) parts.push("Reason: " + why);
  if (examples.length) parts.push("Grey snippets: " + examples.join(" | "));
  return parts.join(" ");
}

export function serializeTranscript(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const systemParts = [];
  const rest = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const role = item.role;
    const content = item.content == null ? "" : String(item.content);
    if (role === "system") {
      systemParts.push(content);
      continue;
    }
    if (role === "user" || role === "assistant") {
      rest.push({ role, content });
    }
  }
  const system = systemParts.join("\n\n");
  if (rest.length === 1 && rest[0].role === "user") {
    return { system, user: rest[0].content };
  }
  const user = rest.map((turn) => {
    const tag = turn.role === "assistant" ? "<<<ASSISTANT>>>" : "<<<USER>>>";
    return tag + "\n" + turn.content;
  }).join("\n");
  return { system, user };
}

export async function runGenerationLoop({
  target,
  systemPrompt,
  initialUserPrompt,
  emptyRetries = 0,
  validationRetries = 0,
  maxAttempts = 1,
  callModel,
  runDecompile
} = {}) {
  const attemptLimit = Math.max(1, Math.trunc(Number(maxAttempts) || 1));
  let emptyLeft = Math.max(0, Math.trunc(Number(emptyRetries) || 0));
  let validationLeft = Math.max(0, Math.trunc(Number(validationRetries) || 0));
  let validationRetried = false;

  const messages = [
    transcriptTurn("system", systemPrompt),
    transcriptTurn("user", initialUserPrompt)
  ];
  const attempts = [];
  let last = null;

  while (attempts.length < attemptLimit) {
    const raw = await callModel(messages);
    const parsed = parseModelOutput(raw);
    const code = sanitizeMakeCode(parsed.code);
    const validation = runValidateBlocks(code, target);
    // Empty source can pass the static validator; treat it as empty, not ok.
    let reason = !String(code || "").trim()
      ? "empty"
      : (validation.ok ? "ok" : "invalid");
    let decompile = null;
    if (reason === "ok" && typeof runDecompile === "function") {
      try {
        decompile = await runDecompile(code, target);
        if (decompile && decompile.ok === false) reason = "decompile";
      } catch {
        // Worker outage must not stub every Managed generate.
        decompile = { skipped: true };
      }
    }
    last = {
      raw: raw == null ? "" : String(raw),
      code,
      feedback: parsed.feedback,
      validation,
      reason,
      decompile
    };
    attempts.push(last);

    if (reason === "ok") break;
    if (attempts.length >= attemptLimit) break;

    if (reason === "empty" && emptyLeft > 0) {
      emptyLeft -= 1;
      const assistantContent = String(raw || "").trim() || code || "(empty)";
      messages.push(transcriptTurn("assistant", assistantContent));
      messages.push(transcriptTurn("user", buildFailedAttemptUserTurn({
        code,
        validation,
        target,
        kind: "empty"
      })));
      continue;
    }

    if (reason === "invalid" && validationLeft > 0) {
      validationLeft -= 1;
      messages.push(transcriptTurn("assistant", code));
      messages.push(transcriptTurn("user", buildFailedAttemptUserTurn({
        code,
        validation,
        target,
        kind: "invalid",
        strict: validationRetried
      })));
      validationRetried = true;
      continue;
    }

    if (reason === "decompile" && validationLeft > 0) {
      validationLeft -= 1;
      messages.push(transcriptTurn("assistant", code));
      messages.push(transcriptTurn("user", buildFailedAttemptUserTurn({
        code,
        validation,
        target,
        kind: "decompile",
        decompile
      })));
      continue;
    }

    break;
  }

  const lastValidation = last && last.validation
    ? last.validation
    : { ok: false, violations: [] };
  const lastFeedback = last && Array.isArray(last.feedback) ? last.feedback : [];
  const upstreamAttempts = attempts.length;

  if (last && last.reason === "ok") {
    return {
      code: last.code,
      feedback: normaliseFeedback(lastFeedback),
      validation: lastValidation,
      upstreamAttempts,
      outcome: "ok",
      attempts
    };
  }

  if (!last || last.reason === "empty") {
    return {
      code: stubForTarget(target),
      feedback: normaliseFeedback(
        [...lastFeedback, "Model returned no code; provided fallback stub."]
      ),
      validation: lastValidation,
      upstreamAttempts,
      outcome: "stub-empty",
      attempts
    };
  }

  if (last && last.reason === "decompile") {
    const why = last.decompile && last.decompile.reason
      ? last.decompile.reason
      : "grey blocks after decompile";
    return {
      code: stubForTarget(target),
      feedback: normaliseFeedback([...lastFeedback, "Validation fallback: " + why]),
      validation: lastValidation,
      upstreamAttempts,
      outcome: "stub-invalid",
      attempts
    };
  }

  const violations = lastValidation.violations || [];
  return {
    code: stubForTarget(target),
    feedback: normaliseFeedback(
      [...lastFeedback, "Validation fallback: " + (violations.join(", ") || "unknown compatibility issue")]
    ),
    validation: lastValidation,
    upstreamAttempts,
    outcome: "stub-invalid",
    attempts
  };
}
