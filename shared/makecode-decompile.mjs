import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const PINS = JSON.parse(
  readFileSync(new URL("./makecode-pins.json", import.meta.url), "utf8")
);

const CDN_ROOT = "https://cdn.makecode.com";
const EMPTY_BLOCKS = '<xml xmlns="http://www.w3.org/1999/xhtml"></xml>';
const DIAGNOSTIC_ERROR = 1;
const nativeFetch = globalThis.fetch.bind(globalThis);

const services = new Map();
let hostReady = false;
let queue = Promise.resolve();

function withLock(fn) {
  const run = queue.then(fn, fn);
  queue = run.then(() => undefined, () => undefined);
  return run;
}

function sha256(value) {
  return createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function flattenMessage(messageText) {
  if (typeof messageText === "string") return messageText;
  if (messageText && typeof messageText.messageText === "string") {
    return messageText.messageText;
  }
  return String(messageText || "");
}

function summariseDiagnostics(diagnostics) {
  return (Array.isArray(diagnostics) ? diagnostics : []).map((item) => ({
    code: item && item.code,
    category: item && item.category,
    messageText: flattenMessage(item && item.messageText),
    line: item && item.line,
    fileName: item && item.fileName
  }));
}

function errorDiagnostics(diagnostics) {
  return summariseDiagnostics(diagnostics).filter((item) => Number(item.category) === DIAGNOSTIC_ERROR);
}

export function getTargetPin(target) {
  const pin = PINS[target];
  if (!pin) throw new Error("Unknown MakeCode target: " + String(target));
  return pin;
}

export function listPinnedTargets() {
  return Object.keys(PINS);
}

export function countGreyBlocks(xml) {
  const matches = String(xml || "").match(/type="typescript_(?:statement|expression)"/g);
  return matches ? matches.length : 0;
}

function decodeXmlAttr(text) {
  return String(text || "")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export function extractGreySnippets(xml) {
  const snippets = [];
  const source = String(xml || "");
  const blockRe = /<block\b[^>]*\btype="typescript_(?:statement|expression)"[^>]*>([\s\S]*?)<\/block>/gi;
  let blockMatch;
  while ((blockMatch = blockRe.exec(source)) && snippets.length < 8) {
    const body = blockMatch[1] || "";
    const lines = [];
    const lineRe = /\bline(\d+)="([^"]*)"/g;
    let lineMatch;
    while ((lineMatch = lineRe.exec(body))) {
      lines[Number(lineMatch[1])] = decodeXmlAttr(lineMatch[2]);
    }
    const fieldMatch = body.match(/<field\b[^>]*>([\s\S]*?)<\/field>/i);
    const preview = (lines.filter((item) => item != null).join(" ") || decodeXmlAttr(fieldMatch?.[1] || ""))
      .replace(/\s+/g, " ").trim();
    snippets.push((preview || "grey block").slice(0, 140));
  }
  return snippets;
}

export function scoreMakeCodeValidation(report) {
  const compile = report && report.compileOk ? 20 : 0;
  const decompile = report && report.decompileOk ? 25 : 0;
  const native = report && report.nativeBlocks ? 10 : 0;
  const roundTrip = report && report.roundTripOk === true ? 5 : 0;
  return {
    compile,
    decompile,
    native,
    roundTrip,
    score: compile + decompile + native + roundTrip,
    max: 60,
    roundTripMeasured: Boolean(report) && report.roundTripOk !== null && report.roundTripOk !== undefined
  };
}

function cacheRoot() {
  return process.env.VIBBIT_MAKECODE_CACHE
    || path.join(repoRoot, "output", "makecode-cache");
}

async function readCachedText(dest, url) {
  if (existsSync(dest)) return readFile(dest, "utf8");
  const response = await nativeFetch(url);
  if (!response.ok) throw new Error("MakeCode CDN " + response.status + " for " + url);
  const text = await response.text();
  await mkdir(path.dirname(dest), { recursive: true });
  const tmp = dest + "." + process.pid + ".tmp";
  await writeFile(tmp, text);
  await rename(tmp, dest);
  return text;
}

function ensureHost() {
  if (hostReady) return;
  const require = createRequire(import.meta.url);
  const { setHost } = require("makecode-core/built/host");
  const { createNodeHost } = require("makecode/built/nodeHost");
  setHost(createNodeHost());
  hostReady = true;
}

async function serviceFor(target) {
  const cached = services.get(target);
  if (cached) return cached;
  ensureHost();
  const pin = getTargetPin(target);
  const require = createRequire(import.meta.url);
  const { NodeLanguageService } = require("makecode/built/languageService");
  const cdn = CDN_ROOT + "/commit/" + pin.commit;
  const dir = path.join(cacheRoot(), pin.commit);
  const [pxtWorkerJs, targetJsonText] = await Promise.all([
    readCachedText(path.join(dir, "pxtworker.js"), cdn + "/pxtworker.js"),
    readCachedText(path.join(dir, "target.json"), cdn + "/target.json")
  ]);
  const targetJson = JSON.parse(targetJsonText);
  const ls = new NodeLanguageService({
    cache: {
      getAsync: async () => null,
      setAsync: async () => {}
    },
    versionNumber: 1,
    cdnUrl: CDN_ROOT,
    simUrl: "",
    website: pin.website,
    pxtWorkerJs,
    targetJson,
    webConfig: { cdnUrl: CDN_ROOT, pxtVersion: pin.pxtVersion, targetVersion: pin.targetVersion },
    targetConfig: {}
  });
  await ls.registerDriverCallbacksAsync({
    cacheGet: async () => null,
    cacheSet: async () => {}
  });
  await ls.setWebConfigAsync({ cdnUrl: CDN_ROOT });
  if (pin.hwVariant) await ls.setHwVariantAsync(pin.hwVariant);
  const packed = { ls, pin, targetJson };
  services.set(target, packed);
  return packed;
}

function projectFiles(pin, code, blocksXml) {
  return {
    "pxt.json": JSON.stringify({
      name: "vibbit-decompile",
      dependencies: pin.dependencies,
      files: ["main.ts", "main.blocks"]
    }),
    "main.ts": String(code || ""),
    "main.blocks": blocksXml || EMPTY_BLOCKS
  };
}

async function compileOptions(ls, pin, files) {
  const opts = await ls.getCompileOptionsAsync(
    {
      files,
      mkcConfig: pin.hwVariant ? { hwVariant: pin.hwVariant } : {},
      config: {}
    },
    { native: false }
  );
  opts.ast = true;
  opts.errorOnGreyBlocks = true;
  opts.fileSystem = opts.fileSystem || {};
  opts.fileSystem["main.ts"] = files["main.ts"];
  opts.fileSystem["main.blocks"] = files["main.blocks"];
  return opts;
}

function failReason({ compileOk, decompileOk, greyBlocks, blocksXml }) {
  if (!compileOk) return "Pinned MakeCode compile failed.";
  if (!decompileOk) return "Pinned MakeCode decompile failed.";
  if (!String(blocksXml || "").trim()) return "Decompiler returned empty main.blocks.";
  if (greyBlocks > 0) return "Detected " + greyBlocks + " grey JavaScript block(s)";
  return "MakeCode validation failed.";
}

async function compileAndDecompileUnlocked({ code, target }) {
  const { ls, pin } = await serviceFor(target);
  const files = projectFiles(pin, code, EMPTY_BLOCKS);
  await ls.setProjectTextAsync(files);
  const opts = await compileOptions(ls, pin, files);
  const compile = ls.performOperationAsync("compile", { options: opts });
  const decompile = ls.performOperationAsync("decompile", { options: opts, fileName: "main.ts" });
  const blocksXml = decompile && decompile.outfiles && decompile.outfiles["main.blocks"]
    ? String(decompile.outfiles["main.blocks"])
    : "";
  const compileDiagnostics = summariseDiagnostics(compile && compile.diagnostics);
  const decompileDiagnostics = summariseDiagnostics(decompile && decompile.diagnostics);
  const compileOk = Boolean(compile && compile.success) && errorDiagnostics(compile && compile.diagnostics).length === 0;
  const decompileOk = Boolean(decompile && decompile.success)
    && errorDiagnostics(decompile && decompile.diagnostics).length === 0
    && Boolean(blocksXml.trim());
  const greyBlocks = countGreyBlocks(blocksXml);
  const nativeBlocks = Boolean(blocksXml.trim()) && greyBlocks === 0;
  const snippets = extractGreySnippets(blocksXml);
  const compileJs = compile && compile.outfiles
    ? (compile.outfiles["binary.js"] || compile.outfiles["binary.asm"] || "")
    : "";

  let roundTripOk = null;
  if (decompileOk && blocksXml) {
    try {
      const roundFiles = projectFiles(pin, code, blocksXml);
      await ls.setProjectTextAsync(roundFiles);
      const roundOpts = await compileOptions(ls, pin, roundFiles);
      const roundCompile = ls.performOperationAsync("compile", { options: roundOpts });
      roundTripOk = Boolean(roundCompile && roundCompile.success)
        && errorDiagnostics(roundCompile && roundCompile.diagnostics).length === 0;
    } catch {
      roundTripOk = null;
    }
  }

  const ok = compileOk && decompileOk && nativeBlocks;
  const targetRelease = {
    target,
    commit: pin.commit,
    targetVersion: pin.targetVersion,
    pxtVersion: pin.pxtVersion,
    hwVariant: pin.hwVariant,
    website: pin.website
  };
  return {
    ok,
    compileOk,
    decompileOk,
    nativeBlocks,
    greyBlocks,
    snippets,
    diagnostics: [...compileDiagnostics, ...decompileDiagnostics],
    targetRelease,
    blocksXml,
    hashes: {
      blocksSha256: blocksXml ? sha256(blocksXml) : null,
      compileJsSha256: compileJs ? sha256(compileJs) : null
    },
    roundTripOk,
    reason: ok ? "" : failReason({ compileOk, decompileOk, greyBlocks, blocksXml })
  };
}

export function compileAndDecompile(input) {
  return withLock(() => compileAndDecompileUnlocked(input));
}
