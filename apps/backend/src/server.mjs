import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createBackendRuntime } from "./runtime.mjs";

const PORT = Number(process.env.PORT || 8787);
const STATE_FILE = resolve(process.env.VIBBIT_STATE_FILE || ".vibbit-backend-state.json");

function readStateFile(filePath) {
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
  }
  return {};
}

function writeStateFile(filePath, state) {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tempPath = `${filePath}.tmp`;
  writeFileSync(tempPath, JSON.stringify(state, null, 2), "utf8");
  renameSync(tempPath, filePath);
}

function createAdminAuthToken() {
  return "vba_" + randomBytes(24).toString("base64url");
}

let persistedState = readStateFile(STATE_FILE);
const envAdminAuthToken = String(process.env.VIBBIT_ADMIN_TOKEN || "").trim();
let adminAuthToken = envAdminAuthToken || String(persistedState.adminAuthToken || "").trim();
if (!adminAuthToken) {
  adminAuthToken = createAdminAuthToken();
  persistedState = {
    ...(persistedState && typeof persistedState === "object" ? persistedState : {}),
    version: 1,
    updatedAt: new Date().toISOString(),
    adminAuthToken
  };
  writeStateFile(STATE_FILE, persistedState);
}

const runtime = createBackendRuntime({
  env: process.env,
  adminAuthToken,
  adminProviderState: persistedState.adminProviderState || {},
  persistAdminProviderState: async (nextAdminProviderState) => {
    persistedState = {
      ...(persistedState && typeof persistedState === "object" ? persistedState : {}),
      version: 1,
      updatedAt: new Date().toISOString(),
      adminAuthToken,
      adminProviderState: nextAdminProviderState
    };
    writeStateFile(STATE_FILE, persistedState);
  }
});

function toFetchRequest(req) {
  const forwardedProtoRaw = req.headers["x-forwarded-proto"];
  const forwardedHostRaw = req.headers["x-forwarded-host"];
  const forwardedProto = Array.isArray(forwardedProtoRaw)
    ? String(forwardedProtoRaw[0] || "").split(",")[0].trim().toLowerCase()
    : String(forwardedProtoRaw || "").split(",")[0].trim().toLowerCase();
  const forwardedHost = Array.isArray(forwardedHostRaw)
    ? String(forwardedHostRaw[0] || "").split(",")[0].trim()
    : String(forwardedHostRaw || "").split(",")[0].trim();

  const protocol = (forwardedProto === "http" || forwardedProto === "https")
    ? forwardedProto
    : (req.socket && req.socket.encrypted ? "https" : "http");
  const host = forwardedHost || req.headers.host || `localhost:${PORT}`;
  const url = `${protocol}://${host}${req.url || "/"}`;

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item != null) headers.append(key, item);
      }
      continue;
    }
    if (value != null) headers.set(key, value);
  }

  const method = (req.method || "GET").toUpperCase();
  const init = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    init.body = req;
    init.duplex = "half";
  }

  return new Request(url, init);
}

async function sendFetchResponse(res, response) {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });

  if (!response.body) {
    res.end();
    return;
  }

  const body = Buffer.from(await response.arrayBuffer());
  res.end(body);
}

const server = createServer(async (req, res) => {
  try {
    const request = toFetchRequest(req);
    const response = await runtime.fetch(request);
    await sendFetchResponse(res, response);
  } catch (error) {
    const message = error && error.message ? error.message : "Internal server error";
    res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: message }));
  }
});

server.listen(PORT, () => {
  const listenUrl = `http://localhost:${PORT}`;
  const lines = runtime.getStartupInfo({ listenUrl });
  for (const line of lines) console.log(line);
  console.log(`[Vibbit backend] Admin panel -> URL: ${listenUrl}/admin?admin=${adminAuthToken}`);
  console.log(`[Vibbit backend] State file=${STATE_FILE}`);
});
