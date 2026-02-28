# Agent Notes

This repository ships one school-facing runtime that supports both:

- `Managed` mode (backend-driven)
- `BYOK` mode (provider/model/key entered by the school)

## Source of truth

- Runtime script for shipping/testing: `work.js`
- Extension build output: `dist/`
- Packaged zip output: `artifacts/vibbit-extension.zip`
- Managed backend core: `apps/backend/src/runtime.mjs`
- Node adapter entrypoint: `apps/backend/src/server.mjs`

`client.js` is legacy and not the primary build source.

## Build a working browser-test version

Use this exact flow when asked to prepare a testable build:

1. Build:
   - `npm run build`
2. Package:
   - `npm run package`
3. Verify outputs:
   - `dist/content-script.js`
   - `dist/manifest.json`
   - `artifacts/vibbit-extension.zip`
4. For local browser testing, load unpacked from `dist/` at `chrome://extensions`.

## Bookmarklet build flow

Use this when packaging for users who cannot install browser extensions:

1. Build Managed-first bookmarklet artefacts:
   - `npm run build:bookmarklet`
2. Optional BYOK-enabled bookmarklet artefacts:
   - `npm run build:bookmarklet:byok`
3. Verify outputs:
   - `artifacts/bookmarklet/vibbit-runtime.js`
   - `artifacts/bookmarklet/bookmarklet-managed.txt`
   - optional: `artifacts/bookmarklet/bookmarklet-byok.txt`

Use `VIBBIT_BOOKMARKLET_RUNTIME_URL` when generating production bookmarklet links.

## Supported keys and endpoints

### Managed mode

- Classroom auth flow:
  - Students enter backend URL + class code in Vibbit
  - Extension calls `POST {BACKEND}/vibbit/connect` and receives a session token
  - Generation uses that session token on `POST {BACKEND}/vibbit/generate`
- Endpoints:
  - `GET {BACKEND}/healthz`
  - `GET {BACKEND}/admin` (`?code=<CLASSCODE>` in classroom mode)
  - `GET {BACKEND}/admin/status`
  - `GET {BACKEND}/bookmarklet`
  - `GET {BACKEND}/bookmarklet/runtime.js`
  - `GET {BACKEND}/vibbit/config`
  - `POST {BACKEND}/vibbit/connect`
  - `POST {BACKEND}/vibbit/generate`
- Legacy optional app token:
  - `APP_TOKEN` (Bearer token, only for `SERVER_APP_TOKEN` mode)
- Payload supports:
  - `target`, `request`, `currentCode`, `pageErrors`, `conversionDialog` (detected editor/page diagnostics + conversion modal details)
  - optional managed overrides: `provider`, `model`

### BYOK mode

- OpenAI key -> `https://api.openai.com/v1/chat/completions`
- Gemini key -> `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`
- OpenRouter key -> `https://openrouter.ai/api/v1/chat/completions`

## Build-time overrides

- `VIBBIT_BACKEND`
- `VIBBIT_APP_TOKEN`

Example:

```bash
VIBBIT_BACKEND="https://your-server.example" VIBBIT_APP_TOKEN="optional-token" npm run package
```

## Managed backend in-repo

- Start backend: `npm run backend:start`
- Dev backend (watch): `npm run backend:dev`
- Backend env template: `apps/backend/.env.example`
- Hosted deployment target: Railway (see `apps/backend/README.md`)
- Admin panel can save provider keys/models without env vars (persisted via `VIBBIT_STATE_FILE`) and is protected by an admin token (`/admin?admin=...`)

## Smoke-test checklist

1. Load extension from `dist/`.
2. Open a MakeCode project page.
3. Test `Managed` generation and `Revert`.
4. Introduce a compile error and confirm generation includes/fixes detected page errors (including empty-prompt auto-fix flow).
5. Trigger MakeCode's `problem converting your code` modal and confirm auto-retry + `Fix convert error` fallback.
6. Test `BYOK` generation with at least one provider.
7. Rebuild + extension reload before re-testing code changes.
8. After reloading the extension, refresh any open MakeCode tabs before testing again.

## Mandatory post-change browser validation

After finishing any feature or fix that is worth human testing, always do all of the following:

1. Build the extension (`npm run build`).
2. Update/reload the extension in Chrome using DevTools MCP.
3. Reload any open MakeCode page tabs before manual verification.

## Auto-reload dev loop (Chrome)

When iterating on extension UI/runtime code, prefer this loop so Chrome reloads the unpacked extension after edits:

1. Start Chrome with remote debugging and a persistent profile, e.g.
   - `/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.chrome-debug-profile"`
2. Load unpacked extension once from `dist/` at `chrome://extensions`.
3. Ensure `Developer mode` is enabled (reload button required).
4. Run:
   - `npm run dev:watch-reload`

Defaults:

- CDP endpoint: `http://localhost:9222`
- watched paths: `work.js`, `extension/`

Optional env overrides:

- `VIBBIT_DEVTOOLS_URL` (custom CDP URL)
- `VIBBIT_EXTENSION_ID` (target extension id instead of manifest name)
- `VIBBIT_WATCH_PATHS` (comma-separated watch paths)
- `VIBBIT_RELOAD_DEBOUNCE_MS` (debounce in milliseconds)

## Playwright audit scripts

- `npm run audit:smoke` -> deterministic UI smoke run with screenshot artefacts.
- `npm run audit:live` -> optional live managed/BYOK verification using secrets.
- `npm run audit:install` -> installs Chromium for local Playwright runs.

Audit output root:

- `output/playwright/audits/`

Secrets for live audits:

- keep in `.env.audit` (gitignored) or process environment variables.
- template: `.env.audit.example`.
