import {
  createTeacherId,
  createTeacherPortalStore,
  formatClassCode,
  isCredentialProfileReady,
  normaliseApiBaseUrl,
  sanitiseTeacherPortalState
} from "./classroom-store.mjs";
import {
  callManagedProvider,
  CREDENTIAL_PROFILE_PROVIDERS,
  defaultModelForCredentialProvider,
  normaliseCredentialProvider,
  providerDisplayName
} from "./provider-registry.mjs";
import { createMagicLinkAuth } from "./magic-link-auth.mjs";
import { resolveTrustedClientIp } from "./deployment-policy.mjs";
import { createRateLimitConfig } from "./rate-limit.mjs";
import { createModelCatalogue } from "../../../shared/model-catalogue.mjs";

const TEACHER_SESSION_COOKIE = "vibbit_teacher_session";
const OAUTH_STATE_COOKIE = "vibbit_oauth_state";
const TEACHER_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function randomBytes(length) {
  const size = Math.max(1, Number(length) || 1);
  const bytes = new Uint8Array(size);
  if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(bytes);
    return bytes;
  }
  for (let i = 0; i < size; i += 1) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  return bytes;
}

function bytesToBase64Url(bytes) {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
  }
  let binary = "";
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function parseBoolean(value, fallback) {
  if (typeof value === "boolean") return value;
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parseCookies(headerValue) {
  const cookies = {};
  for (const part of String(headerValue || "").split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function serializeCookie(name, value, {
  maxAgeSeconds,
  httpOnly = true,
  sameSite = "Lax",
  path = "/",
  secure = false
} = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, `SameSite=${sameSite}`];
  if (httpOnly) parts.push("HttpOnly");
  if (secure) parts.push("Secure");
  if (Number.isFinite(maxAgeSeconds)) parts.push(`Max-Age=${Math.max(0, Math.trunc(maxAgeSeconds))}`);
  return parts.join("; ");
}

function clearCookie(name, { secure = false, path = "/" } = {}) {
  return serializeCookie(name, "", { maxAgeSeconds: 0, secure, path });
}

function createSessionToken() {
  return "vtt_" + bytesToBase64Url(randomBytes(24));
}

function createCsrfToken() {
  return "csrf_" + bytesToBase64Url(randomBytes(18));
}

const TEACHER_SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
};

function csrfHiddenInput(csrfToken) {
  return `<input type="hidden" name="csrfToken" value="${escapeHtml(csrfToken)}">`;
}

function createTeacherSessionStore(ttlMs = TEACHER_SESSION_TTL_MS) {
  const sessions = new Map();

  const prune = () => {
    const now = Date.now();
    for (const [token, entry] of sessions.entries()) {
      if (!entry || entry.expiresAt <= now) sessions.delete(token);
    }
  };

  return {
    create(meta = {}) {
      prune();
      const token = createSessionToken();
      const expiresAt = Date.now() + ttlMs;
      sessions.set(token, { createdAt: Date.now(), expiresAt, meta });
      return { token, expiresAt };
    },
    get(token) {
      prune();
      const entry = sessions.get(String(token || "").trim());
      if (!entry || entry.expiresAt <= Date.now()) return null;
      return entry;
    },
    destroy(token) {
      sessions.delete(String(token || "").trim());
    }
  };
}

function resolveGoogleConfig(env = {}, deploymentPolicy = null) {
  const clientId = String(env.VIBBIT_GOOGLE_CLIENT_ID || env.GOOGLE_CLIENT_ID || "").trim();
  const clientSecret = String(env.VIBBIT_GOOGLE_CLIENT_SECRET || env.GOOGLE_CLIENT_SECRET || "").trim();
  const configuredRedirect = String(
    env.VIBBIT_GOOGLE_REDIRECT_URI || env.GOOGLE_REDIRECT_URI || ""
  ).trim();
  const enabled = Boolean(clientId && clientSecret);
  // Dev login defaults off. Hosted policy forbids it; self-hosted needs explicit opt-in.
  const allowDevLogin = deploymentPolicy
    ? Boolean(deploymentPolicy.allowDevLogin)
    : parseBoolean(env.VIBBIT_TEACHER_DEV_LOGIN, false);
  return {
    clientId,
    clientSecret,
    configuredRedirect,
    enabled,
    allowDevLogin
  };
}

function buildGoogleAuthUrl({ clientId, redirectUri, state }) {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "select_account");
  url.searchParams.set("access_type", "online");
  return url.toString();
}

async function exchangeGoogleCode({ clientId, clientSecret, redirectUri, code }) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    signal: AbortSignal.timeout(15_000),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code"
    })
  });
  if (!response.ok) {
    throw new Error(`Google token exchange failed (${response.status})`);
  }
  return response.json();
}

async function fetchGoogleUserInfo(accessToken) {
  const response = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    signal: AbortSignal.timeout(15_000),
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!response.ok) {
    throw new Error(`Google userinfo failed (${response.status})`);
  }
  return response.json();
}

function teacherShell({ title, body, notice = "", error = "" }) {
  const noticeHtml = notice
    ? `<p class="notice">${escapeHtml(notice)}</p>`
    : "";
  const errorHtml = error
    ? `<p class="error">${escapeHtml(error)}</p>`
    : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="icon" type="image/svg+xml" href="favicon.svg" />
    <title>${escapeHtml(title)} · Vibbit</title>
    <style>
      :root {
        color-scheme: dark;
        --bg-1: #0b1220;
        --bg-2: #121f38;
        --panel: rgba(13, 27, 49, 0.96);
        --text: #e8eefc;
        --muted: #b9c9e5;
        --link: #7ec8ff;
        --line: rgba(158, 186, 228, 0.28);
        --accent: #77c7ff;
        --accent-strong: #59b4ff;
        --danger: #ff8f9f;
        --ok: #7dffb2;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        font: 16px/1.5 "Avenir Next", "Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif;
        color: var(--text);
        background:
          radial-gradient(circle at 10% 0%, #1a2e56 0%, rgba(26, 46, 86, 0) 46%),
          radial-gradient(circle at 100% 100%, #173058 0%, rgba(23, 48, 88, 0) 44%),
          linear-gradient(160deg, var(--bg-2), var(--bg-1));
      }
      main {
        width: min(920px, 94vw);
        margin: 2rem auto 3rem;
        padding: clamp(1.2rem, 2.4vw, 2rem);
        border-radius: 1.1rem;
        background: var(--panel);
        border: 1px solid var(--line);
        box-shadow: 0 24px 56px rgba(0, 0, 0, 0.36);
      }
      h1 { margin: 0 0 0.35rem; font-size: clamp(1.8rem, 4vw, 2.4rem); }
      h2 { margin: 1.4rem 0 0.5rem; font-size: 1.15rem; }
      p { margin: 0.35rem 0; color: var(--muted); }
      a { color: var(--link); text-decoration: none; }
      a:hover { text-decoration: underline; }
      .top {
        display: flex;
        justify-content: space-between;
        gap: 1rem;
        align-items: flex-start;
        flex-wrap: wrap;
      }
      .muted { color: var(--muted); }
      .notice, .error {
        margin-top: 0.9rem;
        padding: 0.7rem 0.85rem;
        border-radius: 0.65rem;
        border: 1px solid var(--line);
      }
      .notice { color: var(--ok); background: rgba(125, 255, 178, 0.08); }
      .error { color: var(--danger); background: rgba(255, 143, 159, 0.1); }
      .panel {
        margin-top: 1rem;
        padding: 1rem;
        border-radius: 0.9rem;
        border: 1px solid var(--line);
        background: linear-gradient(180deg, rgba(18, 39, 68, 0.8), rgba(13, 28, 50, 0.82));
      }
      label {
        display: grid;
        gap: 0.3rem;
        margin: 0.7rem 0;
        color: var(--muted);
        font-size: 0.95rem;
      }
      input, select, button, textarea {
        font: inherit;
      }
      input, select, textarea {
        width: 100%;
        border-radius: 0.55rem;
        border: 1px solid rgba(126, 200, 255, 0.35);
        background: rgba(8, 18, 34, 0.95);
        color: var(--text);
        padding: 0.55rem 0.7rem;
      }
      .row {
        display: flex;
        flex-wrap: wrap;
        gap: 0.55rem;
        align-items: center;
      }
      .actions { margin-top: 0.85rem; }
      button, .btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 0.6rem;
        border: 1px solid transparent;
        padding: 0.55rem 0.85rem;
        font-weight: 600;
        cursor: pointer;
        color: #061a30;
        background: linear-gradient(180deg, var(--accent), var(--accent-strong));
        border-color: rgba(150, 220, 255, 0.45);
      }
      button.secondary, .btn.secondary {
        color: var(--text);
        background: rgba(126, 200, 255, 0.16);
        border-color: rgba(126, 200, 255, 0.4);
      }
      button.danger {
        color: #2a0610;
        background: linear-gradient(180deg, #ffb0bb, #ff8f9f);
      }
      code, .code {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        border-radius: 0.4rem;
        padding: 0.12rem 0.34rem;
        background: rgba(8, 18, 34, 0.95);
        border: 1px solid rgba(106, 145, 198, 0.45);
        color: #dbe9ff;
      }
      .code-lg {
        font-size: 1.35rem;
        letter-spacing: 0.12em;
        font-weight: 700;
      }
      .hint { font-size: 0.92rem; }
      .classroom-meta {
        display: grid;
        gap: 0.35rem;
        margin-bottom: 0.6rem;
      }
      .status {
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
        font-size: 0.85rem;
        font-weight: 600;
        border-radius: 999px;
        padding: 0.15rem 0.55rem;
        border: 1px solid var(--line);
      }
      .status.ok { color: var(--ok); background: rgba(125, 255, 178, 0.08); }
      .status.warn { color: #ffd27a; background: rgba(255, 210, 122, 0.1); }
      .status.bad { color: var(--danger); background: rgba(255, 143, 159, 0.1); }
      .share-row {
        display: flex;
        flex-wrap: wrap;
        gap: 0.6rem;
        align-items: center;
        margin: 0.55rem 0 0.2rem;
      }
      details.settings {
        margin-top: 0.85rem;
        border-top: 1px solid rgba(158, 186, 228, 0.18);
        padding-top: 0.7rem;
      }
      details.settings > summary {
        cursor: pointer;
        color: var(--link);
        font-weight: 600;
        user-select: none;
      }
      @media (max-width: 720px) {
        main { margin-top: 1rem; }
      }
    </style>
  </head>
  <body>
    <main>
      ${body}
      ${noticeHtml}
      ${errorHtml}
    </main>
  </body>
</html>`;
}

function renderCredentialProviderOptions(selectedProvider = "openai") {
  const current = normaliseCredentialProvider(selectedProvider);
  return CREDENTIAL_PROFILE_PROVIDERS.map((provider) => {
    const selected = provider === current ? " selected" : "";
    return `<option value="${escapeHtml(provider)}"${selected}>${escapeHtml(providerDisplayName(provider))}</option>`;
  }).join("");
}

function renderCredentialProfileOptions({
  credentialProfiles,
  selectedProfileId = "",
  defaultProfileId = "",
  readyOnly = false
}) {
  const selectedId = String(selectedProfileId || "").trim();
  const defaultId = String(defaultProfileId || "").trim();
  const defaultProfile = credentialProfiles.find((profile) => profile.id === defaultId) || null;
  const profiles = readyOnly
    ? credentialProfiles.filter((profile) => profile.ready)
    : credentialProfiles;
  const items = [];
  if (!readyOnly || (defaultProfile && defaultProfile.ready)) {
    items.push(
      `<option value="">Default AI account${defaultProfile ? ` — ${escapeHtml(defaultProfile.name)}` : " — not set"}</option>`
    );
  }
  for (const profile of profiles) {
    const selected = profile.id === selectedId ? " selected" : "";
    const readyLabel = profile.ready ? "ready" : "needs testing";
    const suffix = profile.id === defaultId ? " · default" : "";
    items.push(
      `<option value="${escapeHtml(profile.id)}"${selected}>${escapeHtml(profile.name)} — ${escapeHtml(profile.providerLabel)} (${readyLabel}${escapeHtml(suffix)})</option>`
    );
  }
  return items.join("");
}

function formatUsageLine(usage, dailyLimit) {
  const used = Number(usage && usage.acceptedGenerations) || 0;
  const limit = Math.max(1, Number(dailyLimit) || 500);
  return `${used} of ${limit} used today (hidden retries included)`;
}

function withTimeout(promise, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  return promise(controller.signal).finally(() => clearTimeout(timeoutId));
}

async function testCredentialProfileConnection(profile, { outboundUrlPolicy } = {}) {
  const provider = normaliseCredentialProvider(profile && profile.provider);
  const apiKey = String((profile && profile.apiKey) || "").trim();
  const defaultModel = String((profile && profile.defaultModel) || "").trim()
    || defaultModelForCredentialProvider(provider);
  const customBaseUrl = String((profile && profile.customBaseUrl) || "").trim();
  if (!apiKey) throw new Error("Credential profile is missing an API key");
  if (provider === "custom" && !customBaseUrl) {
    throw new Error("Custom provider requires a custom base URL");
  }
  const fetchImpl = outboundUrlPolicy && typeof outboundUrlPolicy.fetchSafe === "function"
    ? (url, init) => outboundUrlPolicy.fetchSafe(url, init, { purpose: "credential profile test" })
    : fetch;
  return withTimeout((signal) => callManagedProvider({
    provider,
    apiKey,
    model: defaultModel,
    system: "You are testing API credentials. Reply with OK.",
    user: "Reply with OK.",
    signal,
    customBaseUrl,
    maxTokens: provider === "anthropic" || /^gpt-6[.-]/.test(defaultModel) ? 1024 : 32,
    fetchImpl
  }), 12000);
}

function renderLoginPage({
  googleEnabled,
  allowDevLogin,
  magicLinkEnabled,
  publicOrigin,
  notice = "",
  error = ""
}) {
  const googleBlock = googleEnabled
    ? `<p><a class="btn" href="/teacher/auth/google">Continue with Google</a></p>`
    : `<p class="hint">Google sign-in is not configured. Set <code>VIBBIT_GOOGLE_CLIENT_ID</code> and <code>VIBBIT_GOOGLE_CLIENT_SECRET</code> to enable it.</p>`;

  const magicBlock = magicLinkEnabled
    ? `
      <div class="panel">
        <h2>Email magic link</h2>
        <p class="hint">We will email a one-time sign-in link. The response is the same whether or not the account exists.</p>
        <form method="post" action="/teacher/auth/magic">
          <label>Email
            <input type="email" name="email" required placeholder="teacher@school.edu" autocomplete="username" />
          </label>
          <div class="actions row">
            <button type="submit">Email me a sign-in link</button>
          </div>
        </form>
      </div>
    `
    : "";

  const devBlock = allowDevLogin
    ? `
      <div class="panel">
        <h2>Local teacher login</h2>
        <p class="hint">Self-hosted opt-in only. Set <code>VIBBIT_TEACHER_DEV_LOGIN=true</code>. Forbidden in hosted mode.</p>
        <form method="post" action="/teacher/dev-login">
          <label>Email
            <input type="email" name="email" required placeholder="teacher@school.edu" autocomplete="username" />
          </label>
          <label>Display name (optional)
            <input type="text" name="name" placeholder="Ms Tan" maxlength="120" />
          </label>
          <div class="actions row">
            <button type="submit">Open teacher portal</button>
          </div>
        </form>
      </div>
    `
    : "";

  const body = `
    <div class="top">
      <div>
        <h1>Teacher portal</h1>
        <p>Sign in, connect an AI account, then create classroom codes for your students.</p>
      </div>
      <a class="btn secondary" href="/">Back to Vibbit</a>
    </div>
    <div class="panel">
      <h2>Sign in</h2>
      ${googleBlock}
      <p class="hint">Students enter only your classroom code. Share a <code>/join/CODE</code> link for projector instructions. Hosted students use server <code>${escapeHtml(publicOrigin)}</code>.</p>
    </div>
    ${magicBlock}
    ${devBlock}
    <div class="panel">
      <h2>AI providers</h2>
      <p class="hint">OpenAI, OpenRouter, OpenCode Go/Zen, Gemini, or (advanced) a custom OpenAI-compatible gateway.</p>
    </div>
  `;

  return teacherShell({ title: "Teacher login", body, notice, error });
}

function renderDashboardPage({
  teacher,
  modelPresets,
  managedClassroomModels,
  classrooms,
  credentialProfiles,
  publicOrigin,
  csrfToken,
  dailyGenerateLimit = 500,
  notice = "",
  error = ""
}) {
  const defaultProfile = credentialProfiles.find((profile) => profile.isDefault) || null;
  const readyProfiles = credentialProfiles.filter((profile) => profile.ready);
  const canMintClassroom = readyProfiles.length > 0;
  const classroomProfileOptions = renderCredentialProfileOptions({
    credentialProfiles,
    defaultProfileId: teacher.defaultCredentialProfileId,
    readyOnly: true
  });
  const profileCards = credentialProfiles.length
    ? credentialProfiles.map((profile) => {
      const statusClass = profile.ready ? "ok" : (profile.lastTestOk === false ? "bad" : "warn");
      const statusLabel = profile.ready
        ? "Ready"
        : (profile.lastTestOk === false ? "Test failed" : "Needs testing");
      return `
      <div class="panel">
        <div class="classroom-meta">
          <div class="row" style="justify-content:space-between;">
            <strong>${escapeHtml(profile.name)}</strong>
            <span class="status ${statusClass}">${escapeHtml(statusLabel)}</span>
          </div>
          <div class="hint">${escapeHtml(profile.providerLabel)} · ${escapeHtml(profile.modelLabel)}${profile.isDefault ? " · default" : ""} · used by ${escapeHtml(profile.usageCount)} classroom${profile.usageCount === 1 ? "" : "s"}</div>
        </div>
        <details class="settings">
          <summary>Edit AI account</summary>
          <form method="post" action="/teacher/profiles/${escapeHtml(profile.id)}" data-profile-form>
            ${csrfHiddenInput(csrfToken)}
            <label>Name
              <input type="text" name="name" value="${escapeHtml(profile.name)}" maxlength="120" required />
            </label>
            <label>Provider
              <select name="provider" data-provider-select>
                ${renderCredentialProviderOptions(profile.provider)}
              </select>
            </label>
            <label>Default model
              <input type="text" name="defaultModel" list="current-models" value="${escapeHtml(profile.defaultModel)}" maxlength="160" required />
            </label>
            <label>API key ${profile.hasApiKey ? "(leave blank to keep the saved key)" : ""}
              <input type="password" name="apiKey" autocomplete="off" placeholder="${profile.hasApiKey ? "••••••••" : "sk-..."}" />
            </label>
            <details data-advanced-details ${profile.provider === "custom" ? "open" : ""}>
              <summary>Advanced</summary>
              <label data-custom-base-url-row>Custom base URL
                <input type="url" name="customBaseUrl" value="${escapeHtml(profile.customBaseUrl)}" placeholder="https://your-gateway.example/v1" />
              </label>
              <p class="hint">Only custom OpenAI-compatible gateways need a base URL.</p>
            </details>
            <label class="row" style="display:flex;gap:0.5rem;align-items:center;">
              <input type="checkbox" name="makeDefault" value="1" ${profile.isDefault ? "checked" : ""} style="width:auto" />
              Use as default AI account
            </label>
            <div class="actions row">
              <button type="submit" class="secondary" formaction="/teacher/profiles/${escapeHtml(profile.id)}/test">Test and save</button>
              <button type="submit">Save</button>
            </div>
          </form>
          <form method="post" action="/teacher/profiles/${escapeHtml(profile.id)}/delete" class="actions" onsubmit="return confirm('Delete this AI account? Classrooms that still use it must be reassigned first.');">
            ${csrfHiddenInput(csrfToken)}
            <button type="submit" class="danger">Delete AI account</button>
          </form>
        </details>
      </div>
    `;
    }).join("")
    : `<div class="panel"><p>Connect an AI account below, then create a classroom.</p></div>`;
  const classroomCards = classrooms.length
    ? classrooms.map((classroom) => {
      const displayCode = formatClassCode(classroom.code);
      const joinPath = `/join/${encodeURIComponent(displayCode)}`;
      const usageLine = formatUsageLine(classroom.usage, dailyGenerateLimit);
      const statusClass = classroom.enabled ? "ok" : "warn";
      const statusLabel = classroom.enabled ? "Active" : "Disabled";
      return `
      <div class="panel">
        <div class="classroom-meta">
          <div class="row" style="justify-content:space-between;">
            <strong>${escapeHtml(classroom.name)}</strong>
            <span class="status ${statusClass}">${escapeHtml(statusLabel)}</span>
          </div>
          <div class="share-row">
            <span class="code code-lg">${escapeHtml(displayCode)}</span>
            <a class="btn secondary" href="${escapeHtml(joinPath)}">Share with students</a>
          </div>
          <div class="hint">${escapeHtml(usageLine)}</div>
          ${managedClassroomModels[classroom.id]
            ? `<div class="hint">Managed gateway: ${escapeHtml(managedClassroomModels[classroom.id])}</div>`
            : `<div class="hint">AI account: ${escapeHtml(classroom.resolvedCredentialProfileName || "Not set")}${classroom.usingTeacherDefault ? " (default)" : ""} · ${escapeHtml(classroom.resolvedProviderLabel || "—")} / ${escapeHtml(classroom.modelLabel || "—")}</div>`}
        </div>
        <details class="settings">
          <summary>Classroom settings</summary>
          <form method="post" action="/teacher/classrooms/${escapeHtml(classroom.id)}">
            ${csrfHiddenInput(csrfToken)}
            <label>Classroom name
              <input type="text" name="name" value="${escapeHtml(classroom.name)}" maxlength="120" required />
            </label>
            <label>AI account
              <select name="credentialProfileId">
                ${renderCredentialProfileOptions({
                  credentialProfiles,
                  selectedProfileId: classroom.credentialProfileId,
                  defaultProfileId: teacher.defaultCredentialProfileId,
                  readyOnly: false
                })}
              </select>
            </label>
            <label>Model override (optional)
              <input type="text" name="modelOverride" value="${escapeHtml(classroom.modelOverride || "")}" maxlength="160" placeholder="Leave blank, or match the tested AI account model" />
            </label>
            <p class="hint">Must match the tested AI account model, or leave blank.</p>
            <label class="row" style="display:flex;gap:0.5rem;align-items:center;">
              <input type="checkbox" name="enabled" value="1" ${classroom.enabled ? "checked" : ""} style="width:auto" />
              Classroom enabled
            </label>
            <div class="actions row">
              <button type="submit">Save classroom</button>
            </div>
          </form>
          <form method="post" action="/teacher/classrooms/${escapeHtml(classroom.id)}/rotate" class="actions" onsubmit="return confirm('Replace this classroom code? Connected students will need the new code.');">
            ${csrfHiddenInput(csrfToken)}
            <button type="submit" class="secondary">Replace classroom code</button>
          </form>
          <form method="post" action="/teacher/classrooms/${escapeHtml(classroom.id)}/delete" class="actions" onsubmit="return confirm('Delete classroom ${escapeHtml(classroom.name)}? This cannot be undone.');">
            ${csrfHiddenInput(csrfToken)}
            <button type="submit" class="danger">Delete classroom</button>
          </form>
        </details>
      </div>
    `;
    }).join("")
    : `<div class="panel"><p>No classrooms yet. Create one below after a tested AI account is ready.</p></div>`;

  const body = `
    <div class="top">
      <div>
        <h1>Teacher portal</h1>
        <p>Signed in as <strong>${escapeHtml(teacher.name || teacher.email)}</strong></p>
      </div>
      <div class="row">
        <a class="btn secondary" href="/">Home</a>
        <form method="post" action="/teacher/logout">${csrfHiddenInput(csrfToken)}<button type="submit" class="secondary">Sign out</button></form>
      </div>
    </div>

    <div class="panel">
      <h2>How students connect</h2>
      <p>Share a classroom code (shown as <code>ABCDE-FGHIJ</code>). Students open Vibbit and enter only that code.</p>
      <p class="hint">Share the join page so students install the bookmarklet first, then open MakeCode. Chrome ZIP installs usually need a teacher or IT helper.</p>
    </div>

    <h2>Your classrooms</h2>
    ${classroomCards}

    <div class="panel">
      <h2>Create a classroom</h2>
      ${canMintClassroom
        ? `
          <form method="post" action="/teacher/classrooms">
            ${csrfHiddenInput(csrfToken)}
            <label>Classroom name
              <input type="text" name="name" value="My class" maxlength="120" required />
            </label>
            <label>AI account
              <select name="credentialProfileId">
                ${classroomProfileOptions}
              </select>
            </label>
            <label>Model override (optional)
              <input type="text" name="modelOverride" value="" maxlength="160" placeholder="Leave blank, or match the tested AI account model" />
            </label>
            <p class="hint">Must match the tested AI account model, or leave blank.</p>
            <div class="actions row">
              <button type="submit">Create classroom</button>
            </div>
          </form>
        `
        : `<p>Connect and successfully test an AI account first. Untested accounts cannot be used for classrooms.</p>`}
    </div>

    <h2>AI accounts</h2>
    ${profileCards}

    <div class="panel">
      <h2>Connect an AI account</h2>
      <p class="hint">New accounts are tested automatically before they are saved.</p>
      <form method="post" action="/teacher/profiles" data-profile-form>
        ${csrfHiddenInput(csrfToken)}
        <label>Name
          <input type="text" name="name" value="School default" maxlength="120" required />
        </label>
        <label>Provider
          <select name="provider" data-provider-select>
            ${renderCredentialProviderOptions("openai")}
          </select>
        </label>
        <label>Default model (optional)
          <input type="text" name="defaultModel" value="" maxlength="160" list="current-models" placeholder="Leave blank for the provider default" />
        </label>
        <datalist id="current-models">
          ${Object.entries(modelPresets).flatMap(([provider, models]) => models.map((model) =>
            `<option value="${escapeHtml(model.id)}">${escapeHtml(providerDisplayName(provider) + " · " + model.label + (model.default ? " (default)" : ""))}</option>`
          )).join("")}
        </datalist>
        <p class="hint">Suggestions come from the configured tkslopper catalogue, with offline defaults if unavailable. Leave blank for the provider default, or enter any model ID supported by your account. Saved models are kept.</p>
        <label>API key
          <input type="password" name="apiKey" autocomplete="off" required placeholder="sk-..." />
        </label>
        <details data-advanced-details>
          <summary>Advanced</summary>
          <label data-custom-base-url-row>
            Custom base URL
            <input type="url" name="customBaseUrl" value="" placeholder="https://your-gateway.example/v1" />
          </label>
          <p class="hint">Only custom OpenAI-compatible gateways need a base URL.</p>
        </details>
        <label class="row" style="display:flex;gap:0.5rem;align-items:center;">
          <input type="checkbox" name="makeDefault" value="1" ${defaultProfile ? "" : "checked"} style="width:auto" />
          Use as default AI account
        </label>
        <div class="actions row">
          <button type="submit">Test and save AI account</button>
        </div>
      </form>
    </div>

  `;

  return teacherShell({ title: "Teacher portal", body, notice, error });
}

const MAX_FORM_BODY_BYTES = 64 * 1024;

async function readRequestTextLimited(request, maxBytes = MAX_FORM_BODY_BYTES) {
  const contentLength = Number(request.headers.get("content-length") || "");
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    const error = new Error("Form body too large");
    error.statusCode = 413;
    throw error;
  }
  if (!request.body || typeof request.body.getReader !== "function") {
    const text = await request.text();
    const size = new TextEncoder().encode(text).length;
    if (size > maxBytes) {
      const error = new Error("Form body too large");
      error.statusCode = 413;
      throw error;
    }
    return text;
  }
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value || new Uint8Array(0);
    total += chunk.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // ignore cancel failures after size rejection
      }
      const error = new Error("Form body too large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

async function readFormBody(request) {
  const contentType = String(request.headers.get("content-type") || "").toLowerCase();
  const text = await readRequestTextLimited(request, MAX_FORM_BODY_BYTES);
  if (contentType.includes("application/json")) {
    if (!text) return {};
    return JSON.parse(text);
  }
  const params = new URLSearchParams(text);
  const body = {};
  for (const [key, value] of params.entries()) {
    body[key] = value;
  }
  return body;
}

function redirectResponse(location, { cookies = [], origin = "", corsHeaders = {} } = {}) {
  const headers = new Headers({
    Location: location,
    ...TEACHER_SECURITY_HEADERS,
    ...corsHeaders
  });
  for (const cookie of cookies) {
    headers.append("Set-Cookie", cookie);
  }
  return new Response(null, { status: 303, headers });
}

function htmlResponse(status, html, { cookies = [], corsHeaders = {} } = {}) {
  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    ...TEACHER_SECURITY_HEADERS,
    ...corsHeaders
  });
  for (const cookie of cookies) {
    headers.append("Set-Cookie", cookie);
  }
  return new Response(html, { status, headers });
}

export function createTeacherPortal({
  env = {},
  initialState = {},
  persistState,
  respondCorsHeaders = () => ({}),
  deploymentPolicy = null,
  outboundUrlPolicy = null,
  usageStore = null,
  modelCatalogue = createModelCatalogue({ origin: env.VIBBIT_TKSLOPPER_GATEWAY_URL }),
  getManagedClassroomModels = async () => ({})
} = {}) {
  const google = resolveGoogleConfig(env, deploymentPolicy);
  const magicLink = createMagicLinkAuth(env);
  const rateLimitConfig = createRateLimitConfig(env);
  const store = createTeacherPortalStore(sanitiseTeacherPortalState(initialState), {
    persist: persistState
  });
  const sessions = createTeacherSessionStore();
  const oauthStates = new Map();
  const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
  const MAX_OAUTH_STATES = 1000;

  const pruneOAuthStates = () => {
    const ts = Date.now();
    for (const [state, entry] of oauthStates.entries()) {
      if (!entry || ts - entry.createdAt > OAUTH_STATE_TTL_MS) oauthStates.delete(state);
    }
    while (oauthStates.size > MAX_OAUTH_STATES) {
      const oldest = oauthStates.keys().next().value;
      if (oldest == null) break;
      oauthStates.delete(oldest);
    }
  };

  const validateCustomEndpointUrl = async (provider, customBaseUrl) => {
    if (normaliseCredentialProvider(provider) !== "custom") return "";
    if (!String(customBaseUrl || "").trim()) {
      throw new Error("Custom provider requires a custom base URL");
    }
    const normalised = normaliseApiBaseUrl(customBaseUrl);
    if (!outboundUrlPolicy || typeof outboundUrlPolicy.assertSafeUrl !== "function") {
      return normalised;
    }
    const safe = await outboundUrlPolicy.assertSafeUrl(normalised, {
      purpose: "credential profile custom base URL"
    });
    return safe.href || normalised;
  };

  const buildProfileInput = async (body, existingProfile = null) => {
    const provider = normaliseCredentialProvider(
      body.provider || (existingProfile && existingProfile.provider) || "openai"
    );
    let defaultModel = body.defaultModel ?? existingProfile?.defaultModel;
    if (!String(defaultModel || "").trim()) {
      const models = (await modelCatalogue.load())[provider] || [];
      defaultModel = models.find((model) => model.default)?.id || models[0]?.id || defaultModelForCredentialProvider(provider);
    }
    return {
      name: body.name,
      provider,
      apiKey: body.apiKey,
      customBaseUrl: await validateCustomEndpointUrl(
        provider,
        body.customBaseUrl != null
          ? body.customBaseUrl
          : (existingProfile && existingProfile.customBaseUrl)
      ),
      defaultModel,
      makeDefault: parseBoolean(body.makeDefault, false)
    };
  };

  const isSecureRequest = (requestUrl) => {
    if (deploymentPolicy && deploymentPolicy.publicOrigin) {
      return String(deploymentPolicy.publicOrigin).startsWith("https://");
    }
    return String(requestUrl.protocol || "").startsWith("https");
  };

  const getSessionFromRequest = (request) => {
    const cookies = parseCookies(request.headers.get("cookie"));
    const token = cookies[TEACHER_SESSION_COOKIE];
    if (!token) return null;
    return sessions.get(token);
  };

  const getTeacherFromRequest = (request) => {
    const session = getSessionFromRequest(request);
    if (!session || !session.meta || !session.meta.teacherId) return null;
    return store.getTeacher(session.meta.teacherId);
  };

  const requireAuthenticatedMutation = async (request, corsHeaders) => {
    const session = getSessionFromRequest(request);
    if (!session || !session.meta || !session.meta.teacherId) {
      return {
        error: redirectResponse("/teacher?error=Please%20sign%20in", { corsHeaders })
      };
    }
    const teacher = store.getTeacher(session.meta.teacherId);
    if (!teacher) {
      return {
        error: redirectResponse("/teacher?error=Please%20sign%20in", { corsHeaders })
      };
    }
    const body = await readFormBody(request);
    const submitted = String(body.csrfToken || "").trim();
    const expected = String(session.meta.csrfToken || "").trim();
    if (!submitted || submitted !== expected) {
      return {
        error: redirectResponse("/teacher?error=Invalid%20session%20token", { corsHeaders })
      };
    }
    return { session, teacher, body };
  };

  const startTeacherSession = (teacher, requestUrl) => {
    const session = sessions.create({
      teacherId: teacher.id,
      csrfToken: createCsrfToken()
    });
    const secure = isSecureRequest(requestUrl);
    return serializeCookie(TEACHER_SESSION_COOKIE, session.token, {
      maxAgeSeconds: Math.floor(TEACHER_SESSION_TTL_MS / 1000),
      secure
    });
  };

  const clearTeacherSessionCookie = (requestUrl) => clearCookie(TEACHER_SESSION_COOKIE, {
    secure: isSecureRequest(requestUrl)
  });

  const resolveRedirectUri = (publicOrigin) => {
    if (google.configuredRedirect) return google.configuredRedirect;
    const origin = (deploymentPolicy && deploymentPolicy.publicOrigin)
      || publicOrigin
      || "";
    return `${String(origin).replace(/\/+$/, "")}/teacher/auth/google/callback`;
  };

  const handle = async (request, {
    pathname,
    origin,
    publicOrigin,
    requestUrl
  }) => {
    const corsHeaders = respondCorsHeaders(origin) || {};
    const notice = String(requestUrl.searchParams.get("notice") || "").trim();
    const error = String(requestUrl.searchParams.get("error") || "").trim();

    if (pathname === "/teacher" && request.method === "GET") {
      const session = getSessionFromRequest(request);
      const teacher = session && session.meta && session.meta.teacherId
        ? store.getTeacher(session.meta.teacherId)
        : null;
      if (!teacher) {
        const html = renderLoginPage({
          googleEnabled: google.enabled,
          allowDevLogin: google.allowDevLogin,
          magicLinkEnabled: magicLink.enabled,
          publicOrigin,
          notice,
          error
        });
        return htmlResponse(200, html, { corsHeaders });
      }
      const classrooms = store.listClassroomsForTeacher(teacher.id).map((classroom) => {
        const view = store.publicClassroomView(classroom);
        view.modelLabel = modelCatalogue.labelFor(view.resolvedModel || "");
        if (usageStore && typeof usageStore.publicView === "function") {
          view.usage = usageStore.publicView(classroom.id);
        }
        return view;
      });
      const profileUsageCounts = {};
      for (const classroom of classrooms) {
        const profileId = String(classroom.resolvedCredentialProfileId || "").trim();
        if (!profileId) continue;
        profileUsageCounts[profileId] = (profileUsageCounts[profileId] || 0) + 1;
      }
      const credentialProfiles = store.listCredentialProfilesForTeacher(teacher.id).map((profile) => {
        const view = store.publicCredentialProfileView(profile);
        view.modelLabel = modelCatalogue.labelFor(view.defaultModel);
        view.isDefault = teacher.defaultCredentialProfileId === profile.id;
        view.usageCount = profileUsageCounts[profile.id] || 0;
        return view;
      });
      const [modelPresets, managedClassroomModels] = await Promise.all([
        modelCatalogue.load(), getManagedClassroomModels(classrooms)
      ]);
      const html = renderDashboardPage({
        teacher,
        modelPresets,
        managedClassroomModels,
        classrooms,
        credentialProfiles,
        publicOrigin,
        csrfToken: session.meta.csrfToken,
        dailyGenerateLimit: rateLimitConfig.generatePerClassroomPerDay,
        notice,
        error
      });
      return htmlResponse(200, html, { corsHeaders });
    }

    if (pathname === "/teacher/auth/google" && request.method === "GET") {
      if (!google.enabled) {
        return redirectResponse("/teacher?error=Google%20sign-in%20is%20not%20configured", { corsHeaders });
      }
      pruneOAuthStates();
      const state = bytesToBase64Url(randomBytes(18));
      oauthStates.set(state, { createdAt: Date.now() });
      const redirectUri = resolveRedirectUri(publicOrigin);
      const authUrl = buildGoogleAuthUrl({
        clientId: google.clientId,
        redirectUri,
        state
      });
      const secure = isSecureRequest(requestUrl);
      return redirectResponse(authUrl, {
        cookies: [
          serializeCookie(OAUTH_STATE_COOKIE, state, {
            maxAgeSeconds: 600,
            secure
          })
        ],
        corsHeaders
      });
    }

    if (pathname === "/teacher/auth/google/callback" && request.method === "GET") {
      if (!google.enabled) {
        return redirectResponse("/teacher?error=Google%20sign-in%20is%20not%20configured", { corsHeaders });
      }
      try {
        const code = String(requestUrl.searchParams.get("code") || "").trim();
        const state = String(requestUrl.searchParams.get("state") || "").trim();
        const cookies = parseCookies(request.headers.get("cookie"));
        const expectedState = cookies[OAUTH_STATE_COOKIE];
        if (!code || !state || !expectedState || state !== expectedState || !oauthStates.has(state)) {
          throw new Error("Invalid OAuth state");
        }
        const oauthEntry = oauthStates.get(state);
        if (!oauthEntry || Date.now() - oauthEntry.createdAt > OAUTH_STATE_TTL_MS) {
          oauthStates.delete(state);
          throw new Error("Invalid OAuth state");
        }
        oauthStates.delete(state);

        const redirectUri = resolveRedirectUri(publicOrigin);
        const tokenPayload = await exchangeGoogleCode({
          clientId: google.clientId,
          clientSecret: google.clientSecret,
          redirectUri,
          code
        });
        const accessToken = String(tokenPayload.access_token || "").trim();
        if (!accessToken) throw new Error("Missing Google access token");
        const profile = await fetchGoogleUserInfo(accessToken);
        if (profile.email_verified !== true) {
          throw new Error("Google account email is not verified");
        }
        const email = String(profile.email || "").trim().toLowerCase();
        const subject = String(profile.sub || email).trim();
        if (!email || !subject) throw new Error("Google account did not return an email");

        const teacher = await store.upsertTeacher({
          id: createTeacherId("google", subject),
          email,
          name: String(profile.name || "").trim(),
          picture: String(profile.picture || "").trim(),
          provider: "google",
          linkByVerifiedEmail: true
        });
        const sessionCookie = startTeacherSession(teacher, requestUrl);
        const secure = isSecureRequest(requestUrl);
        return redirectResponse("/teacher?notice=Signed%20in%20with%20Google", {
          cookies: [
            sessionCookie,
            clearCookie(OAUTH_STATE_COOKIE, { secure })
          ],
          corsHeaders
        });
      } catch (err) {
        const message = encodeURIComponent((err && err.message) || "Google sign-in failed");
        return redirectResponse(`/teacher?error=${message}`, {
          cookies: [clearCookie(OAUTH_STATE_COOKIE, { secure: isSecureRequest(requestUrl) })],
          corsHeaders
        });
      }
    }

    if (pathname === "/teacher/auth/magic" && request.method === "POST") {
      if (!magicLink.enabled) {
        return redirectResponse("/teacher?error=Magic%20link%20sign-in%20is%20not%20configured", { corsHeaders });
      }
      const body = await readFormBody(request);
      const clientIp = resolveTrustedClientIp(request, deploymentPolicy || { trustProxy: false }) || "local";
      const magicOrigin = (deploymentPolicy && deploymentPolicy.publicOrigin) || publicOrigin;
      await magicLink.requestLink({
        email: body.email,
        publicOrigin: magicOrigin,
        clientIp
      });
      return redirectResponse(
        `/teacher?notice=${encodeURIComponent("If that email can sign in, a magic link has been sent.")}`,
        { corsHeaders }
      );
    }

    if (pathname === "/teacher/auth/magic/callback" && request.method === "GET") {
      if (!magicLink.enabled) {
        return redirectResponse("/teacher?error=Magic%20link%20sign-in%20is%20not%20configured", { corsHeaders });
      }
      const token = String(requestUrl.searchParams.get("token") || "").trim();
      const consumed = magicLink.consumeToken(token);
      if (!consumed || !consumed.email) {
        return redirectResponse("/teacher?error=Magic%20link%20is%20invalid%20or%20expired", { corsHeaders });
      }
      const teacher = await store.upsertTeacher({
        id: createTeacherId("magic", consumed.email),
        email: consumed.email,
        name: consumed.email.split("@")[0],
        provider: "magic",
        linkByVerifiedEmail: true
      });
      const sessionCookie = startTeacherSession(teacher, requestUrl);
      return redirectResponse("/teacher?notice=Signed%20in%20with%20email", {
        cookies: [sessionCookie],
        corsHeaders
      });
    }

    if (pathname === "/teacher/dev-login" && request.method === "POST") {
      if (!google.allowDevLogin) {
        return redirectResponse("/teacher?error=Local%20teacher%20login%20is%20disabled", { corsHeaders });
      }
      try {
        const body = await readFormBody(request);
        const email = String(body.email || "").trim().toLowerCase();
        const name = String(body.name || "").trim();
        if (!email || !email.includes("@")) throw new Error("A valid email is required");
        const teacher = await store.upsertTeacher({
          id: createTeacherId("local", email),
          email,
          name: name || email.split("@")[0],
          provider: "local"
        });
        const sessionCookie = startTeacherSession(teacher, requestUrl);
        return redirectResponse("/teacher?notice=Signed%20in", {
          cookies: [sessionCookie],
          corsHeaders
        });
      } catch (err) {
        const message = encodeURIComponent((err && err.message) || "Login failed");
        return redirectResponse(`/teacher?error=${message}`, { corsHeaders });
      }
    }

    if (pathname === "/teacher/logout" && request.method === "POST") {
      const auth = await requireAuthenticatedMutation(request, corsHeaders);
      if (auth.error) return auth.error;
      const cookies = parseCookies(request.headers.get("cookie"));
      sessions.destroy(cookies[TEACHER_SESSION_COOKIE]);
      return redirectResponse("/teacher?notice=Signed%20out", {
        cookies: [clearTeacherSessionCookie(requestUrl)],
        corsHeaders
      });
    }

    if (pathname === "/teacher/profiles" && request.method === "POST") {
      const auth = await requireAuthenticatedMutation(request, corsHeaders);
      if (auth.error) return auth.error;
      const { teacher, body } = auth;
      try {
        const profileInput = await buildProfileInput(body);
        const draftProfile = {
          provider: profileInput.provider,
          apiKey: profileInput.apiKey,
          defaultModel: profileInput.defaultModel,
          customBaseUrl: profileInput.customBaseUrl
        };
        await testCredentialProfileConnection(draftProfile, { outboundUrlPolicy });
        await store.createCredentialProfile(teacher.id, {
          ...profileInput,
          lastTestedAt: new Date().toISOString(),
          lastTestOk: true
        });
        return redirectResponse("/teacher?notice=AI%20account%20tested%20and%20saved", { corsHeaders });
      } catch (err) {
        const message = encodeURIComponent((err && err.message) || "Could not save AI account");
        return redirectResponse(`/teacher?error=${message}`, { corsHeaders });
      }
    }

    const profileMatch = pathname.match(/^\/teacher\/profiles\/([^/]+)(?:\/(delete|test))?$/);
    if (profileMatch && request.method === "POST") {
      const auth = await requireAuthenticatedMutation(request, corsHeaders);
      if (auth.error) return auth.error;
      const { teacher, body } = auth;
      const profileId = decodeURIComponent(profileMatch[1]);
      const action = profileMatch[2] || "update";
      try {
        if (action === "delete") {
          await store.deleteCredentialProfile(teacher.id, profileId);
          return redirectResponse("/teacher?notice=Credential%20profile%20deleted", { corsHeaders });
        }
        const existingProfile = store.getCredentialProfile(profileId);
        if (!existingProfile || existingProfile.teacherId !== teacher.id) {
          throw new Error("Credential profile not found");
        }
        const profileInput = await buildProfileInput(body, existingProfile);
        const providerChanged = body.provider != null
          && normaliseCredentialProvider(body.provider) !== normaliseCredentialProvider(existingProfile.provider);
        if (action === "test") {
          const draftProfile = {
            ...existingProfile,
            ...profileInput,
            apiKey: profileInput.apiKey != null && String(profileInput.apiKey).trim()
              ? profileInput.apiKey
              : (providerChanged ? "" : existingProfile.apiKey)
          };
          // Failed tests must not overwrite a working classroom config.
          await testCredentialProfileConnection(draftProfile, { outboundUrlPolicy });
          await store.updateCredentialProfile(teacher.id, profileId, {
            ...profileInput,
            lastTestedAt: new Date().toISOString(),
            lastTestOk: true
          });
          return redirectResponse("/teacher?notice=AI%20account%20tested%20and%20saved", { corsHeaders });
        }
        await store.updateCredentialProfile(teacher.id, profileId, profileInput);
        return redirectResponse("/teacher?notice=Credential%20profile%20saved", { corsHeaders });
      } catch (err) {
        const message = encodeURIComponent((err && err.message) || "Credential profile update failed");
        return redirectResponse(`/teacher?error=${message}`, { corsHeaders });
      }
    }

    if (pathname === "/teacher/classrooms" && request.method === "POST") {
      const auth = await requireAuthenticatedMutation(request, corsHeaders);
      if (auth.error) return auth.error;
      const { teacher, body } = auth;
      try {
        await store.createClassroom(teacher.id, {
          name: body.name,
          credentialProfileId: body.credentialProfileId,
          modelOverride: body.modelOverride
        });
        return redirectResponse("/teacher?notice=Classroom%20created", { corsHeaders });
      } catch (err) {
        const message = encodeURIComponent((err && err.message) || "Could not create classroom");
        return redirectResponse(`/teacher?error=${message}`, { corsHeaders });
      }
    }

    const classroomMatch = pathname.match(/^\/teacher\/classrooms\/([^/]+)(?:\/(rotate|delete))?$/);
    if (classroomMatch && request.method === "POST") {
      const auth = await requireAuthenticatedMutation(request, corsHeaders);
      if (auth.error) return auth.error;
      const { teacher, body } = auth;
      const classroomId = decodeURIComponent(classroomMatch[1]);
      const action = classroomMatch[2] || "update";
      try {
        if (action === "rotate") {
          await store.rotateClassroomCode(teacher.id, classroomId);
          return redirectResponse("/teacher?notice=Classroom%20code%20replaced", { corsHeaders });
        }
        if (action === "delete") {
          await store.deleteClassroom(teacher.id, classroomId);
          return redirectResponse("/teacher?notice=Classroom%20deleted", { corsHeaders });
        }
        await store.updateClassroom(teacher.id, classroomId, {
          name: body.name,
          credentialProfileId: body.credentialProfileId,
          modelOverride: body.modelOverride,
          enabled: body.enabled != null
        });
        return redirectResponse("/teacher?notice=Classroom%20saved", { corsHeaders });
      } catch (err) {
        const message = encodeURIComponent((err && err.message) || "Classroom update failed");
        return redirectResponse(`/teacher?error=${message}`, { corsHeaders });
      }
    }

    return null;
  };

  return {
    handle,
    store,
    googleEnabled: google.enabled,
    allowDevLogin: google.allowDevLogin,
    getStartupLines(listenUrl) {
      const lines = [
        `[Vibbit backend] Teacher portal -> ${(listenUrl || "<your-server-url>")}/teacher`
      ];
      if (google.enabled) {
        lines.push("[Vibbit backend] Teacher Google sign-in enabled");
      } else if (google.allowDevLogin) {
        lines.push("[Vibbit backend] Teacher local/dev login enabled (set Google OAuth env vars for production)");
      }
      lines.push(`[Vibbit backend] Teacher classrooms=${store.countClassrooms()}`);
      return lines;
    }
  };
}
