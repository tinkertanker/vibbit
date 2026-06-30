export const SHARED_COMPAT_EXPORT_NAMES = [
  "sanitizeMakeCode",
  "normaliseFeedback",
  "resolvePromptTargetContext",
  "buildUserPrompt",
  "extractCode",
  "parseModelOutput",
  "validateBlocksCompatibility",
  "buildTargetPromptExtras",
  "buildSystemPrompt",
  "buildCorrectionInstruction",
  "stubForTarget",
  "extractGeminiText"
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
  { call: "basic.onStart", minArgs: 1, maxArgs: 1 },
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

export function buildTargetPromptExtras(target) {
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

// Per-target grounding shared by Managed and BYOK system prompts. Each entry
// carries the API cheat sheet plus a worked request -> response example so the
// model sees both the supported surface and the exact output contract.
export const TARGET_API_CATALOG = {
  microbit: {
    name: "micro:bit",
    apis: [
      "basic: showNumber(n), showString(s), showIcon(IconNames), showLeds(`...`), showArrow(ArrowNames), clearScreen(), forever(handler), onStart(handler), pause(ms)",
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
    "Use event handlers and loops, e.g. input.onButtonPressed(Button.A, function () { }), basic.forever(function () { }), basic.onStart(function () { }).",
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
  "Returning a value from a callback/handler, optional or default parameters in your own functions, and assignment operators other than =, +=, -=."
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
  const { conversational = false } = options;
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
  const eventRegistrationRe = /\b(?:basic\.forever|basic\.onStart|loops\.forever|input\.on[A-Z_a-z0-9_]*|radio\.on[A-Z_a-z0-9_]*|pins\.on[A-Z_a-z0-9_]*|controller\.[A-Z_a-z0-9_]*\.onEvent|controller\.on[A-Z_a-z0-9_]*|sprites\.on[A-Z_a-z0-9_]*|scene\.on[A-Z_a-z0-9_]*|game\.on[A-Z_a-z0-9_]*|info\.on[A-Z_a-z0-9_]*|control\.inBackground)\s*\(/;

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
  return [
    "basic.onStart(function () {",
    "    basic.showString(\"Hi\")",
    "})"
  ].join("\n");
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
