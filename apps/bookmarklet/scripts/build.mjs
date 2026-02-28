import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "../../..");
const outputDir = path.join(root, "artifacts", "bookmarklet");
const sourcePath = path.join(root, "work.js");
const frogSvgPath = path.join(root, "extension", "icons", "vibbit-frog.svg");
const userscriptHeaderPattern = /^\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\s*/;
const frogDataUriToken = "__VIBBIT_FROG_MARK_DATA_URI__";
const defaultRuntimeUrl = "https://example.com/vibbit-runtime.js";

function getOption(prefix) {
  const arg = process.argv.find((item) => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : "";
}

function hasTruthyEnv(name) {
  return /^(1|true|yes|on)$/i.test(String(process.env[name] || "").trim());
}

function overrideConst(source, name, value) {
  const pattern = new RegExp(`const ${name} = ".*?";`);
  if (!pattern.test(source)) {
    throw new Error(`Could not find ${name} declaration in work.js`);
  }
  return source.replace(pattern, `const ${name} = ${JSON.stringify(value)};`);
}

function svgToDataUri(svgMarkup) {
  return `data:image/svg+xml,${encodeURIComponent(svgMarkup.replace(/\s+/g, " ").trim())}`;
}

function makeLoaderSource(runtimeUrl, config) {
  return (
    "(function(){" +
      "try{" +
        "var w=window,d=document;" +
        "w.__vibbitBookmarkletConfig=Object.assign({},w.__vibbitBookmarkletConfig||{}," + JSON.stringify(config) + ");" +
        "if(w.__vibbit&&typeof w.__vibbit.reinvoke==='function'){" +
          "if(w.__vibbit.reinvoke()!==false)return;" +
        "}" +
        "var src=" + JSON.stringify(runtimeUrl) + ";" +
        "if(!src){alert('Vibbit bookmarklet runtime URL is not configured.');return;}" +
        "var id='vibbit-bookmarklet-runtime';" +
        "var existing=d.getElementById(id);" +
        "if(existing&&existing.parentNode){existing.parentNode.removeChild(existing);}" +
        "var script=d.createElement('script');" +
        "script.id=id;" +
        "script.async=true;" +
        "script.src=src+(src.indexOf('?')===-1?'?':'&')+'v='+Date.now();" +
        "script.onerror=function(){alert('Vibbit bookmarklet could not load its runtime.');};" +
        "(d.head||d.documentElement).appendChild(script);" +
      "}catch(err){" +
        "alert('Vibbit bookmarklet failed: '+(err&&err.message?err.message:String(err)));" +
      "}" +
    "})();"
  );
}

function makeInstallHtml(bookmarkletHref, label, runtimeUrl) {
  return [
    "<!doctype html>",
    "<html lang=\"en\">",
    "<head>",
    "  <meta charset=\"utf-8\">",
    "  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    "  <title>Vibbit Bookmarklet</title>",
    "</head>",
    "<body>",
    "  <h1>Vibbit Bookmarklet</h1>",
    `  <p>Drag this link to your bookmarks bar: <a href="${bookmarkletHref}">${label}</a></p>`,
    "  <p>Open a MakeCode project page, then click the bookmark to launch Vibbit.</p>",
    `  <p>Runtime URL: <code>${runtimeUrl}</code></p>`,
    "</body>",
    "</html>",
    ""
  ].join("\n");
}

function writeBookmarkletFiles(outputRoot, suffix, runtimeUrl, config, enableByok) {
  const loader = makeLoaderSource(runtimeUrl, config);
  const bookmarkletHref = "javascript:" + loader;
  const label = enableByok ? "Vibbit (BYOK enabled)" : "Vibbit (Managed)";
  return Promise.all([
    writeFile(path.join(outputRoot, `loader-${suffix}.js`), `${loader}\n`, "utf8"),
    writeFile(path.join(outputRoot, `bookmarklet-${suffix}.txt`), `${bookmarkletHref}\n`, "utf8"),
    writeFile(path.join(outputRoot, `install-${suffix}.html`), makeInstallHtml(bookmarkletHref, label, runtimeUrl), "utf8")
  ]);
}

async function run() {
  const enableByok = process.argv.includes("--enable-byok") || hasTruthyEnv("VIBBIT_BOOKMARKLET_ENABLE_BYOK");
  const runtimeUrl = getOption("--runtime-url=") || String(process.env.VIBBIT_BOOKMARKLET_RUNTIME_URL || "").trim() || defaultRuntimeUrl;

  const [runtimeSourceRaw, frogSvgMarkup] = await Promise.all([
    readFile(sourcePath, "utf8"),
    readFile(frogSvgPath, "utf8")
  ]);

  let runtimeSource = runtimeSourceRaw.replace(userscriptHeaderPattern, "");
  runtimeSource = runtimeSource.replaceAll(frogDataUriToken, svgToDataUri(frogSvgMarkup));

  const backend = String(process.env.VIBBIT_BACKEND || "").trim();
  const appTokenRaw = process.env.VIBBIT_APP_TOKEN;
  if (backend) runtimeSource = overrideConst(runtimeSource, "BACKEND", backend);
  if (appTokenRaw !== undefined) runtimeSource = overrideConst(runtimeSource, "APP_TOKEN", String(appTokenRaw));

  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  await writeFile(path.join(outputDir, "vibbit-runtime.js"), runtimeSource, "utf8");

  await writeBookmarkletFiles(
    outputDir,
    "managed",
    runtimeUrl,
    { forceMode: "managed", enableManaged: true, enableByok: false },
    false
  );

  if (enableByok) {
    await writeBookmarkletFiles(
      outputDir,
      "byok",
      runtimeUrl,
      { enableManaged: true, enableByok: true },
      true
    );
  }

  const info = {
    builtAt: new Date().toISOString(),
    runtimeUrl,
    runtimeFile: "vibbit-runtime.js",
    includeByokBookmarklet: enableByok,
    backendOverride: backend || null,
    appTokenOverride: appTokenRaw !== undefined
  };
  await writeFile(path.join(outputDir, "build-info.json"), `${JSON.stringify(info, null, 2)}\n`, "utf8");

  console.log(`Built bookmarklet artefacts in ${outputDir}`);
  console.log("- Managed bookmarklet: bookmarklet-managed.txt");
  if (enableByok) {
    console.log("- BYOK-enabled bookmarklet: bookmarklet-byok.txt");
  } else {
    console.log("- BYOK bookmarklet not emitted (enable with --enable-byok).");
  }
  if (runtimeUrl === defaultRuntimeUrl) {
    console.log("- Warning: runtime URL is placeholder. Set VIBBIT_BOOKMARKLET_RUNTIME_URL for real use.");
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
