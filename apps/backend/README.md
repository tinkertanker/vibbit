# Vibbit managed backend

Teacher-friendly backend for Vibbit managed mode.

Teachers:

1. Open `/teacher` and sign in (Google, magic link, or local/dev login)
2. Connect an AI account (tested automatically before save)
3. Create a classroom code

Students enter the classroom code (hosted package is code-only). Prefer the bookmarklet join flow unless school IT manages Chrome ZIP installs.

The backend keeps provider API keys server-side and proxies generation requests through the classroom’s configured provider (OpenAI, OpenRouter, OpenCode, Gemini, or an allow-listed custom OpenAI-compatible gateway).

## Endpoints

- `GET /` (informational landing page)
- `GET /healthz`
- `GET /teacher` (teacher portal: login + classroom minting)
- `GET /teacher/auth/google` (Google OAuth start)
- `GET /teacher/auth/google/callback`
- `POST /teacher/dev-login` (local/dev login when enabled)
- `POST /teacher/classrooms` (mint classroom)
- `GET /admin` (operator/admin panel)
- `GET /admin/status` (admin JSON)
- `GET /vibbit/config`
- `POST /vibbit/connect`
- `POST /vibbit/generate`
- `GET /download/vibbit-extension.zip` (Chrome extension zip download redirect)
- `GET /bookmarklet` (bookmarklet installer page)
- `GET /bookmarklet/runtime.js` (bookmarklet runtime script)

## Teacher portal

1. Open `/teacher`
2. Sign in with Google (set `VIBBIT_GOOGLE_CLIENT_ID` + `VIBBIT_GOOGLE_CLIENT_SECRET`), or use local email login when `VIBBIT_TEACHER_DEV_LOGIN` is enabled (default `false`; set `true` for local dev when Google is unset)
3. Connect an AI account (provider + API key + model). New accounts are tested automatically; failed tests are not saved.
4. Create a classroom and share the **classroom code** with students (shipped extension is code-only against the hosted server)

Each teacher can create multiple classrooms. Codes can be replaced or deleted from the portal. Untested or failed AI accounts cannot be used for new classrooms.

## Admin panel (operator)

- Open `/admin?admin=<ADMINTOKEN>`
- On startup, the backend logs the admin panel URL with the token redacted.
- Optional: set `VIBBIT_ADMIN_TOKEN` to provide a fixed admin token.

The operator panel still supports a shared fallback provider config for legacy single-code classrooms.

## Bookmarklet flow (no extension install)

The backend can host a bookmarklet installer page at:

- `/bookmarklet`

This page includes a managed classroom bookmarklet that loads runtime from:

- `/bookmarklet/runtime.js`

Recommended classroom flow:

1. Teacher opens `/teacher`, configures a key, and mints a code.
2. Teacher/student opens `/bookmarklet` and drags **Vibbit** to the bookmarks bar.
3. Student opens a MakeCode project and clicks the bookmarklet.
4. Student enters the classroom code in Vibbit (hosted extension is code-only).

## Classroom connection flow

1. Teacher runs/deploys backend.
2. Teacher signs in at `/teacher` and mints a classroom code (with their own API key/URL).
3. Students enter the classroom code in Vibbit managed mode (hosted builds hide the server URL).
4. Extension calls `POST /vibbit/connect` to get a short-lived session token.
5. Extension calls `POST /vibbit/generate` with that token.
6. Backend sends the request to the classroom’s OpenAI-compatible endpoint with that classroom’s key.

Legacy single-code mode (env /admin shared keys) still works alongside teacher-minted classrooms.

## Request contract

### `POST /vibbit/connect`

Request body:

```json
{
  "classCode": "ABCDE"
}
```

Success response:

```json
{
  "ok": true,
  "sessionToken": "vbt_...",
  "expiresAt": "2026-02-26T12:34:56.000Z",
  "authMode": "classroom",
  "defaultProvider": "openai",
  "defaultModel": "gpt-4o-mini"
}
```

### `POST /vibbit/generate`

Request body:

```json
{
  "target": "microbit",
  "request": "Create a simple blinking LED pattern",
  "currentCode": "optional existing JS",
  "pageErrors": ["optional diagnostics"],
  "conversionDialog": {
    "title": "optional",
    "description": "optional"
  },
  "provider": "optional override",
  "model": "optional override"
}
```

Success response:

```json
{
  "code": "basic.showIcon(IconNames.Heart)",
  "feedback": ["At least one feedback line is always returned"]
}
```

Error response:

```json
{
  "error": "Human-readable error message"
}
```

## Local quick start (teacher laptop)

```bash
cd apps/backend
cp .env.example .env
npm start
```

By default:

- URL: `http://localhost:8787`
- Auth mode: `classroom`
- Teacher portal: `http://localhost:8787/teacher`

Open `/teacher`, sign in with local/dev login, paste an OpenAI-compatible key + base URL, mint a code, and share URL + code with students.

## LiteLLM and Claude-compatible endpoints

Teachers can point a custom AI account at an OpenAI-compatible gateway. Built-in providers (OpenAI, OpenRouter, OpenCode, Gemini) need no allow-list. Custom public hosts require `VIBBIT_CUSTOM_ENDPOINT_ALLOWLIST`. Localhost or private HTTP gateways require self-hosted mode plus `VIBBIT_ALLOW_PRIVATE_ENDPOINTS=true`.

| Provider / gateway | Example base URL |
| --- | --- |
| OpenAI | `https://api.openai.com/v1` |
| OpenRouter | `https://openrouter.ai/api/v1` |
| OpenCode Go | `https://opencode.ai/zen/go/v1` |
| LiteLLM proxy | `http://localhost:4000/v1` (self-hosted + private endpoints) |
| Claude via OpenAI-compatible proxy | your proxy’s `/v1` URL (allow-listed if public) |

Vibbit normally calls `{baseUrl}/chat/completions` with the teacher’s API key. GPT-5.6 Luna on OpenAI and OpenCode models documented for the Responses API are routed to `/responses`. OpenCode model names may use `go/` or `zen/` prefixes (for example, `go/gpt-5.6-luna` or `zen/hy3-free`); an omitted prefix defaults to Go. You do not need to run LiteLLM inside this repo — point the classroom at an existing LiteLLM (or similar) deployment if you want multi-provider routing.

## Environment variables

Core:

- `PORT` (default `8787`)
- `VIBBIT_ALLOW_ORIGIN` (default `*`)
- `VIBBIT_REQUEST_TIMEOUT_MS` (default `60000`)
- `VIBBIT_EMPTY_RETRIES` (default `2`)
- `VIBBIT_VALIDATION_RETRIES` (default `2`)
- `VIBBIT_STATE_FILE` (default `.vibbit-backend-state.json`; persisted admin + teacher portal state)
- `VIBBIT_ADMIN_TOKEN` (optional fixed admin token; if empty, auto-generated and persisted in `VIBBIT_STATE_FILE`)
- `VIBBIT_BOOKMARKLET_ENABLED` (default `true`; enables `/bookmarklet` and `/bookmarklet/runtime.js`)
- `VIBBIT_BOOKMARKLET_ENABLE_BYOK` (default `true`; adds BYOK-enabled bookmarklet option on `/bookmarklet`)
- `VIBBIT_EXTENSION_DOWNLOAD_URL` (default `https://github.com/tinkertanker/vibbit/releases/latest/download/vibbit-extension.zip`; target URL for `/download/vibbit-extension.zip`)

Teacher portal:

- `VIBBIT_GOOGLE_CLIENT_ID` / `VIBBIT_GOOGLE_CLIENT_SECRET` (Google OAuth)
- `VIBBIT_GOOGLE_REDIRECT_URI` (optional; default `{origin}/teacher/auth/google/callback`)
- `VIBBIT_TEACHER_DEV_LOGIN` (default `false`; set `true` for local dev when Google is unset)

Hosted deployment (required):

- `VIBBIT_DEPLOYMENT_MODE=hosted`
- `VIBBIT_PUBLIC_ORIGIN` (canonical HTTPS origin)
- `VIBBIT_CREDENTIAL_ENCRYPTION_KEY` (32-byte base64/base64url)
- `VIBBIT_CUSTOM_ENDPOINT_ALLOWLIST` (optional comma list for teacher custom gateways beyond built-in providers)
- `VIBBIT_TRUST_PROXY=true` when the process sits behind Railway/nginx/Cloudflare (or similar), so per-IP connect limits use real client addresses instead of the proxy hop

Rate limits (classroom-friendly defaults):

- `VIBBIT_RATE_CONNECT_PER_IP_PER_MIN` (default `60`; sized for a NAT’d class joining together)
- `VIBBIT_RATE_CONNECT_GLOBAL_PER_MIN` (default `300`)
- `VIBBIT_RATE_GENERATE_PER_SESSION_PER_MIN` (default `6`)
- `VIBBIT_RATE_GENERATE_PER_CLASSROOM_PER_DAY` (default `500`)

Classroom auth:

- `VIBBIT_CLASSROOM_ENABLED` (default `true` unless `SERVER_APP_TOKEN` is set)
- `VIBBIT_CLASSROOM_CODE` (optional legacy fixed code)
- `VIBBIT_CLASSROOM_CODE_AUTO` (default `true`; legacy auto code for simple single-tenant setups)
- `VIBBIT_CLASSROOM_CODE_LENGTH` (default `10`; teacher-minted codes are 10 unambiguous letters, shown as `ABCDE-FGHIJ`)
- `VIBBIT_CLASSROOM_SEED` (optional deterministic seed for legacy auto code)
- `VIBBIT_SESSION_TTL_MS` (default `28800000` = 8h)

Legacy app-token auth:

- `SERVER_APP_TOKEN` (if set, class-code mode is disabled)

Provider routing (legacy shared fallback /admin):

- `VIBBIT_ENABLED_PROVIDERS` (comma list; default `openai,gemini,openrouter,opencode`)
- `VIBBIT_PROVIDER` default provider
- `VIBBIT_MODEL` default fallback model
- `VIBBIT_OPENAI_ALLOWED_MODELS`, `VIBBIT_GEMINI_ALLOWED_MODELS`, `VIBBIT_OPENROUTER_ALLOWED_MODELS`, `VIBBIT_OPENCODE_ALLOWED_MODELS` (optional comma allow-lists)

Provider keys/models (legacy shared fallback):

- `VIBBIT_API_KEY` (shared fallback; optional)
- `VIBBIT_OPENAI_API_KEY`, `VIBBIT_OPENAI_MODEL` (optional)
- `VIBBIT_GEMINI_API_KEY`, `VIBBIT_GEMINI_MODEL` (optional)
- `VIBBIT_OPENROUTER_API_KEY`, `VIBBIT_OPENROUTER_MODEL` (optional)
- `VIBBIT_OPENCODE_API_KEY`, `VIBBIT_OPENCODE_MODEL` (optional; OpenCode Go/Zen, selected with a `go/` or `zen/` model prefix)

If these are omitted, set provider keys/models via `/admin` (legacy) or per-classroom in `/teacher`.

For local implementation/tests, prefer mocked upstreams, disposable fixture accounts, and an isolated
`VIBBIT_STATE_FILE`. Real account save/test can call a provider and consume quota. Shared teacher/admin
writes, classroom changes, outbound email, real-provider calls, and deployment require specific
authorization; available credentials are not permission. Never expose keys, state, or sensitive
school data in logs/artifacts, or weaken hosted security settings to make local tests pass.

## Railway deployment option

The instructions below describe a deployment option, not verified infrastructure for the live site.
Earlier root guidance named Docker/SSH at `tinkertanker@dev.tk.sg:Docker/vibbit` for `vibbit.tk.sg`;
the local deployment files are gitignored. Confirm the current target/account and procedure with
the operator before any authorized deployment. See [deployment target preflight](../../docs/release.md#deployment-target-preflight--unresolved-infrastructure-history).
Do not guess or create/mutate infrastructure to resolve this ambiguity. The steps below require
authorization for the specific deployment, configuration, and shared-state changes.

Deploy button (placeholder until template is published):

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template/REPLACE_WITH_TEMPLATE_CODE?utm_medium=integration&utm_source=button&utm_campaign=vibbit)

### Deploy from GitHub (recommended)

1. Open [Railway New Project](https://railway.com/new) and choose **Deploy from GitHub repo**.
2. Select this repository.
3. Set the service root directory to `apps/backend`.
4. Add environment variables from `.env.example` (provider API keys are optional if teachers use `/teacher`).
5. For Google login, create an OAuth client and set `VIBBIT_GOOGLE_CLIENT_ID` / `VIBBIT_GOOGLE_CLIENT_SECRET` (redirect URI `{your-domain}/teacher/auth/google/callback`).
6. Generate a public domain for the service.
7. Share that HTTPS URL plus teacher-minted classroom codes with students.
8. For no-extension usage, share `https://vibbit.tk.sg/bookmarklet` (or your own hosted domain).
9. For extension download installs, share `https://vibbit.tk.sg/download/vibbit-extension.zip` (or your own hosted domain).

### Cheapest setup (single-service, low-budget)

To keep usage as low as possible (targeting Railway Free credit):

1. Run only one backend service (no Postgres/Redis service).
2. Attach a Railway volume and set `VIBBIT_STATE_FILE=/data/vibbit-state.json`.
3. Keep one replica for this service.
4. Set Railway hard usage limit to `$1` so spend cannot exceed budget.

### Deploy with CLI

```bash
cd apps/backend
npx @railway/cli login
npx @railway/cli link
npm run deploy:railway
```

## Notes

- For multi-replica deployments, keep session validation consistent across instances (stateless signed tokens or shared store).
- `VIBBIT_STATE_FILE` stores admin-saved provider keys and teacher classroom credentials; treat it as sensitive and do not commit it.
- `GET /vibbit/config` is useful for quick diagnostics without exposing secrets.
