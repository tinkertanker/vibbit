export const SHARED_COMPAT_EXPORT_NAMES = [
  "sanitizeMakeCode",
  "normaliseFeedback",
  "resolvePromptTargetContext",
  "buildUserPrompt",
  "extractCode",
  "parseModelOutput",
  "validateBlocksCompatibility",
  "buildTargetPromptExtras",
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
