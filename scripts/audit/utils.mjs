import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const repoRoot = path.resolve(__dirname, "../..");

export function timestampTag(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join("") + "-" + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join("");
}

export async function ensureDir(dirPath) {
  await mkdir(dirPath, { recursive: true });
  return dirPath;
}

export async function createAuditRunDir(kind) {
  const outputRoot = path.join(repoRoot, "output", "playwright", "audits");
  await ensureDir(outputRoot);
  const runDir = path.join(outputRoot, `${kind}-${timestampTag()}`);
  await ensureDir(runDir);
  return runDir;
}

export async function assertFileExists(filePath) {
  await stat(filePath);
  return filePath;
}

export async function writeText(filePath, text) {
  await writeFile(filePath, text, "utf8");
  return filePath;
}

export function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || repoRoot,
      env: options.env || process.env,
      stdio: options.stdio || ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    if (child.stdout) {
      child.stdout.on("data", (chunk) => {
        const text = chunk.toString();
        stdout += text;
        if (options.stream !== false) process.stdout.write(text);
      });
    }

    if (child.stderr) {
      child.stderr.on("data", (chunk) => {
        const text = chunk.toString();
        stderr += text;
        if (options.stream !== false) process.stderr.write(text);
      });
    }

    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}`));
    });
  });
}

function unquote(value) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    const inner = trimmed.slice(1, -1);
    return inner
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t");
  }
  return trimmed;
}

export async function loadAuditEnv() {
  const envFile = process.env.AUDIT_ENV_FILE
    ? path.resolve(process.env.AUDIT_ENV_FILE)
    : path.join(repoRoot, ".env.audit");

  try {
    const raw = await readFile(envFile, "utf8");
    const loaded = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const splitAt = trimmed.indexOf("=");
      if (splitAt < 1) continue;
      const key = trimmed.slice(0, splitAt).trim();
      const value = unquote(trimmed.slice(splitAt + 1));
      if (!(key in process.env)) {
        process.env[key] = value;
        loaded.push(key);
      }
    }
    return { envFile, loaded, exists: true };
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { envFile, loaded: [], exists: false };
    }
    throw error;
  }
}

export function providerConfigFromEnv() {
  const preferred = (process.env.AUDIT_BYOK_PROVIDER || "").trim().toLowerCase();
  const provider = preferred || (
    process.env.AUDIT_BYOK_OPENAI_KEY ? "openai" :
    process.env.AUDIT_BYOK_GEMINI_KEY ? "gemini" :
    process.env.AUDIT_BYOK_OPENROUTER_KEY ? "openrouter" :
    ""
  );

  if (!provider) return null;

  if (provider === "openai") {
    return {
      provider,
      key: process.env.AUDIT_BYOK_OPENAI_KEY || "",
      model: process.env.AUDIT_BYOK_OPENAI_MODEL || "gpt-4o-mini",
      endpointRegex: /^https:\/\/api\.openai\.com\/v1\/chat\/completions$/
    };
  }

  if (provider === "gemini") {
    const model = process.env.AUDIT_BYOK_GEMINI_MODEL || "gemini-2.5-flash";
    return {
      provider,
      key: process.env.AUDIT_BYOK_GEMINI_KEY || "",
      model,
      endpointRegex: /^https:\/\/generativelanguage\.googleapis\.com\/v1\/models\/.+:generateContent\?key=/
    };
  }

  if (provider === "openrouter") {
    return {
      provider,
      key: process.env.AUDIT_BYOK_OPENROUTER_KEY || "",
      model: process.env.AUDIT_BYOK_OPENROUTER_MODEL || "openrouter/auto",
      endpointRegex: /^https:\/\/openrouter\.ai\/api\/v1\/chat\/completions$/
    };
  }

  return null;
}

export function buildMarkdownTable(rows) {
  const lines = ["| Step | Result | Detail |", "|---|---|---|"];
  for (const row of rows) {
    lines.push(`| ${row.step} | ${row.result} | ${row.detail} |`);
  }
  return lines.join("\n");
}

export function trimForTable(text) {
  return String(text || "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}
