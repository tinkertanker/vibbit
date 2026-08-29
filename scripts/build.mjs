import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");
const distDir = path.join(root, "dist");
const sourcePath = path.join(root, "work.js");
const manifestPath = path.join(root, "extension", "manifest.json");
const iconsSourceDir = path.join(root, "extension", "icons");
const frogSvgPath = path.join(iconsSourceDir, "vibbit-frog.svg");
const frogDataUriToken = "__VIBBIT_FROG_MARK_DATA_URI__";
const byokHostPermissions = [
  "https://api.openai.com/*",
  "https://generativelanguage.googleapis.com/*",
  "https://openrouter.ai/*",
  "https://opencode.ai/*"
];

const makecodeHostPermissions = [
  "https://makecode.microbit.org/*",
  "https://arcade.makecode.com/*",
  "https://maker.makecode.com/*"
];

const userscriptHeaderPattern = /^\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\s*/;

function overrideConst(source, name, value) {
  const stringPattern = new RegExp(`const ${name} = ".*?";`);
  const boolPattern = new RegExp(`const ${name} = (?:true|false);`);
  if (stringPattern.test(source)) {
    return source.replace(stringPattern, `const ${name} = ${JSON.stringify(value)};`);
  }
  if (boolPattern.test(source)) {
    return source.replace(boolPattern, `const ${name} = ${value === true ? "true" : "false"};`);
  }
  throw new Error(`Could not find ${name} declaration in work.js`);
}

function hostPermissionForBackend(backend) {
  const parsed = new URL(backend);
  return `${parsed.protocol}//${parsed.host}/*`;
}

function svgToDataUri(svgMarkup) {
  return `data:image/svg+xml,${encodeURIComponent(svgMarkup.replace(/\s+/g, " ").trim())}`;
}

function parseBoolean(value, fallback) {
  if (typeof value === "boolean") return value;
  if (value == null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function readConstString(source, name) {
  const match = source.match(new RegExp(`const ${name} = "(.*?)";`));
  return match ? match[1] : "";
}

function stripPageByokTransport(source) {
  const startToken = "  // BEGIN_PAGE_BYOK_TRANSPORT";
  const endToken = "  // END_PAGE_BYOK_TRANSPORT";
  const start = source.indexOf(startToken);
  const end = source.indexOf(endToken);
  if (start < 0 || end <= start) throw new Error("Could not find page BYOK transport markers in work.js");
  const disabled = [
    startToken,
    "  const extensionOnlyProviderCall = () => Promise.reject(new Error(\"extension_broker_required\"));",
    "  const callOpenAI = extensionOnlyProviderCall;",
    "  const callGemini = extensionOnlyProviderCall;",
    "  const callOpenRouter = extensionOnlyProviderCall;",
    "  const callOpenCode = extensionOnlyProviderCall;",
    endToken
  ].join("\n");
  return source.slice(0, start) + disabled + source.slice(end + endToken.length);
}

function replaceMarkedSection(source, name, replacement) {
  const startToken = `  // BEGIN_${name}`;
  const endToken = `  // END_${name}`;
  const start = source.indexOf(startToken);
  const end = source.indexOf(endToken);
  if (start < 0 || end <= start) throw new Error(`Could not find ${name} markers in work.js`);
  return source.slice(0, start)
    + replacement
    + source.slice(end + endToken.length);
}

function stripHostedPageByokInternals(source) {
  let hosted = replaceMarkedSection(source, "PAGE_BYOK_CONFIG", [
    "  const MODEL_PRESETS = { openai: [], gemini: [], openrouter: [], opencode: [] };",
    "  const supportsThinkHarder = () => false;"
  ].join("\n"));
  hosted = replaceMarkedSection(hosted, "PAGE_BYOK_KEY_STATE", [
    "  const getStoredProviderKey = () => \"\";",
    "  const setStoredProviderKey = () => {};"
  ].join("\n"));
  hosted = replaceMarkedSection(
    hosted,
    "EXTENSION_BYOK_BRIDGE",
    "  const extensionRequest = () => Promise.reject(new Error(\"managed_only_build\"));"
  );
  return hosted.replace(/"vibbit:byok:[^"]+"/g, '"managed_only_build"');
}

function assertExtensionCredentialBoundary(source) {
  const forbidden = [
    "https://api.openai.com/v1/responses",
    "https://api.openai.com/v1/chat/completions",
    "https://generativelanguage.googleapis.com/v1beta/models/",
    "https://openrouter.ai/api/v1/chat/completions",
    "https://opencode.ai/zen/",
    'Authorization: "Bearer " + key',
    'storageSet(key, normalized)'
  ];
  const found = forbidden.filter((item) => source.includes(item));
  if (found.length) {
    throw new Error(`Extension MAIN-world bundle contains forbidden BYOK transport/key code: ${found.join(", ")}`);
  }
  if (!source.includes("const EXTENSION_BUILD = true;")) {
    throw new Error("Extension MAIN-world bundle was not marked as an extension build");
  }
}

function assertHostedManagedRuntimeBoundary(source) {
  const forbidden = [
    "__vibbit_extension_request_v2_",
    "vibbit:byok:",
    "memoryProviderKeys",
    "gpt-5.6-luna",
    "gemini-3-flash-preview",
    "deepseek/deepseek-v4-flash-0731",
    "go/responses/gpt-5.6-luna"
  ];
  const found = forbidden.filter((item) => source.includes(item));
  if (found.length) {
    throw new Error(`Hosted Managed runtime contains BYOK capability code: ${found.join(", ")}`);
  }
}

function wrapExtensionRuntime(source) {
  return `(() => {\n${source}\n})();\n`;
}

async function build() {
  const [rawClient, rawManifest, rawBackground, rawManagedBackground, rawToolbar, frogSvgMarkup] = await Promise.all([
    readFile(sourcePath, "utf8"),
    readFile(manifestPath, "utf8"),
    readFile(path.join(root, "extension", "background.js"), "utf8"),
    readFile(path.join(root, "extension", "background-managed.js"), "utf8"),
    readFile(path.join(root, "extension", "toolbar.mjs"), "utf8"),
    readFile(frogSvgPath, "utf8")
  ]);

  let builtClient = rawClient.replace(userscriptHeaderPattern, "");
  const frogDataUri = svgToDataUri(frogSvgMarkup);
  builtClient = builtClient.replaceAll(frogDataUriToken, frogDataUri);
  const manifest = JSON.parse(rawManifest);

  const buildProfile = String(process.env.VIBBIT_BUILD_PROFILE || "").trim().toLowerCase();
  const hostedManagedProfile = buildProfile === "hosted-managed";
  let backend = process.env.VIBBIT_BACKEND;
  const appToken = process.env.VIBBIT_APP_TOKEN;

  if (hostedManagedProfile) {
    if (!backend || !/^https:\/\//i.test(String(backend).trim())) {
      throw new Error("VIBBIT_BUILD_PROFILE=hosted-managed requires VIBBIT_BACKEND to be an https URL");
    }
    if (appToken) {
      throw new Error("VIBBIT_BUILD_PROFILE=hosted-managed rejects VIBBIT_APP_TOKEN");
    }
    backend = String(backend).trim();
  }

  // Ordinary builds stay dual-mode (Managed + BYOK). Code-only distribution requires an
  // explicit profile or VIBBIT_HOSTED_MANAGED=true — never inherit a source-level true.
  const hostedManagedEnabled = hostedManagedProfile
    ? true
    : parseBoolean(process.env.VIBBIT_HOSTED_MANAGED, false);
  builtClient = overrideConst(builtClient, "HOSTED_MANAGED", hostedManagedEnabled);
  builtClient = overrideConst(builtClient, "EXTENSION_BUILD", true);
  builtClient = stripPageByokTransport(builtClient);
  if (hostedManagedEnabled) builtClient = stripHostedPageByokInternals(builtClient);
  assertExtensionCredentialBoundary(builtClient);
  if (hostedManagedEnabled) assertHostedManagedRuntimeBoundary(builtClient);
  const builtBackground = hostedManagedEnabled
    ? rawManagedBackground
    : overrideConst(rawBackground, "HOSTED_MANAGED", false);

  if (hostedManagedEnabled) {
    delete manifest.options_page;
    manifest.permissions = manifest.permissions.filter((permission) => permission !== "storage");
    manifest.content_scripts = manifest.content_scripts.filter((entry) => (
      !entry.js.includes("page-bridge.js")
    ));
  }

  if (backend) {
    builtClient = overrideConst(builtClient, "BACKEND", String(backend).trim());
  }

  if (!hostedManagedEnabled && appToken !== undefined) {
    builtClient = overrideConst(builtClient, "APP_TOKEN", appToken);
  } else if (hostedManagedEnabled) {
    builtClient = overrideConst(builtClient, "APP_TOKEN", "");
  }

  const effectiveBackend = readConstString(builtClient, "BACKEND");
  if (effectiveBackend) {
    const backendPermission = hostPermissionForBackend(effectiveBackend);
    const optionalByokPermissions = hostedManagedEnabled ? [] : byokHostPermissions;
    manifest.host_permissions = [...new Set([
      ...makecodeHostPermissions,
      backendPermission,
      ...optionalByokPermissions
    ])];
  }
  const runtimeRevision = createHash("sha256").update(builtClient).digest("hex").slice(0, 16);
  builtClient = overrideConst(builtClient, "EXTENSION_RUNTIME_REVISION", runtimeRevision);
  const builtToolbar = rawToolbar.replaceAll("__VIBBIT_RUNTIME_REVISION__", runtimeRevision);
  builtClient = wrapExtensionRuntime(builtClient);

  await rm(distDir, { recursive: true, force: true });
  await mkdir(distDir, { recursive: true });

  const extensionModuleDir = path.join(distDir, "extension");
  const sharedModuleDir = path.join(distDir, "shared");
  await mkdir(extensionModuleDir, { recursive: true });
  const supportCopies = [];
  if (!hostedManagedEnabled) {
    await mkdir(sharedModuleDir, { recursive: true });
    supportCopies.push(
      copyFile(path.join(root, "extension", "byok-arm.mjs"), path.join(extensionModuleDir, "byok-arm.mjs")),
      copyFile(path.join(root, "extension", "byok-broker.mjs"), path.join(extensionModuleDir, "byok-broker.mjs")),
      copyFile(path.join(root, "extension", "byok-config.mjs"), path.join(extensionModuleDir, "byok-config.mjs")),
      copyFile(path.join(root, "extension", "provider-transport.mjs"), path.join(extensionModuleDir, "provider-transport.mjs")),
      copyFile(path.join(root, "extension", "page-bridge.js"), path.join(distDir, "page-bridge.js")),
      copyFile(path.join(root, "extension", "options.html"), path.join(distDir, "options.html")),
      copyFile(path.join(root, "extension", "options.js"), path.join(distDir, "options.js")),
      copyFile(path.join(root, "shared", "makecode-compat-core.mjs"), path.join(sharedModuleDir, "makecode-compat-core.mjs"))
    );
  }
  await Promise.all(supportCopies);

  // Copy icons
  const iconsDir = path.join(distDir, "icons");
  await mkdir(iconsDir, { recursive: true });
  const iconFiles = await readdir(iconsSourceDir);
  await Promise.all(
    iconFiles.map(file =>
      copyFile(path.join(iconsSourceDir, file), path.join(iconsDir, file))
    )
  );

  await Promise.all([
    writeFile(path.join(distDir, "content-script.js"), builtClient, "utf8"),
    writeFile(path.join(extensionModuleDir, "background.js"), builtBackground, "utf8"),
    writeFile(path.join(extensionModuleDir, "toolbar.mjs"), builtToolbar, "utf8"),
    writeFile(path.join(distDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
  ]);

  console.log("Built Chrome extension files in dist/");
  if (hostedManagedEnabled) {
    console.log("- HOSTED_MANAGED enabled (code-only Managed against baked BACKEND)");
  }
  if (effectiveBackend) {
    console.log(`- BACKEND: ${effectiveBackend}`);
    console.log(`- host_permissions: ${manifest.host_permissions.join(", ")}`);
  }
  if (!hostedManagedEnabled && appToken !== undefined) {
    console.log("- APP_TOKEN overridden via VIBBIT_APP_TOKEN");
  }
}

build().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
