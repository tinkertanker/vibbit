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
  "https://openrouter.ai/*"
];

const makecodeHostPermissions = [
  "https://makecode.microbit.org/*",
  "https://arcade.makecode.com/*",
  "https://maker.makecode.com/*"
];

const userscriptHeaderPattern = /^\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\s*/;

function overrideConst(source, name, value) {
  const pattern = new RegExp(`const ${name} = ".*?";`);
  if (!pattern.test(source)) {
    throw new Error(`Could not find ${name} declaration in work.js`);
  }

  return source.replace(pattern, `const ${name} = ${JSON.stringify(value)};`);
}

function hostPermissionForBackend(backend) {
  const parsed = new URL(backend);
  return `${parsed.protocol}//${parsed.host}/*`;
}

function svgToDataUri(svgMarkup) {
  return `data:image/svg+xml,${encodeURIComponent(svgMarkup.replace(/\s+/g, " ").trim())}`;
}

async function build() {
  const [rawClient, rawManifest, frogSvgMarkup] = await Promise.all([
    readFile(sourcePath, "utf8"),
    readFile(manifestPath, "utf8"),
    readFile(frogSvgPath, "utf8")
  ]);

  let builtClient = rawClient.replace(userscriptHeaderPattern, "");
  const frogDataUri = svgToDataUri(frogSvgMarkup);
  builtClient = builtClient.replaceAll(frogDataUriToken, frogDataUri);
  const manifest = JSON.parse(rawManifest);

  const backend = process.env.VIBBIT_BACKEND;
  const appToken = process.env.VIBBIT_APP_TOKEN;

  if (backend) {
    builtClient = overrideConst(builtClient, "BACKEND", backend);
    const backendPermission = hostPermissionForBackend(backend);
    // Preserve MakeCode host permissions for toolbar-click flow
    manifest.host_permissions = [...new Set([...makecodeHostPermissions, backendPermission, ...byokHostPermissions])];
  }

  if (appToken !== undefined) {
    builtClient = overrideConst(builtClient, "APP_TOKEN", appToken);
  }

  await rm(distDir, { recursive: true, force: true });
  await mkdir(distDir, { recursive: true });

  // Copy background.js
  const backgroundSrc = path.join(root, "extension", "background.js");
  await copyFile(backgroundSrc, path.join(distDir, "background.js"));

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
    writeFile(path.join(distDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
  ]);

  console.log("Built Chrome extension files in dist/");
  if (backend) {
    console.log(`- BACKEND overridden via VIBBIT_BACKEND: ${backend}`);
    console.log(`- host_permissions set to: ${manifest.host_permissions[0]}`);
  }
  if (appToken !== undefined) {
    console.log("- APP_TOKEN overridden via VIBBIT_APP_TOKEN");
  }
}

build().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
