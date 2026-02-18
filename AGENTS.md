# Agent Notes

This repository ships one school-facing runtime that supports both:

- `Managed` mode (backend-driven)
- `BYOK` mode (provider/model/key entered by the school)

## Source of truth

- Runtime script for shipping/testing: `work.js`
- Extension build output: `dist/`
- Packaged zip output: `artifacts/vibbit-extension.zip`
- Managed backend reference: `apps/backend/src/server.mjs`

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

## Supported keys and endpoints

### Managed mode

- Optional app token:
  - `APP_TOKEN` (Bearer token to your backend)
- Endpoint:
  - `POST {BACKEND}/vibbit/generate`

### BYOK mode

- OpenAI key -> `https://api.openai.com/v1/chat/completions`
- Gemini key -> `https://generativelanguage.googleapis.com/v1/models/{model}:generateContent`
- OpenRouter key -> `https://openrouter.ai/api/v1/chat/completions`

BYOK calls go directly from the browser to provider APIs. CORS is bypassed by the extension's `host_permissions` in the manifest — this only works in the Chrome extension context, not as a bookmarklet.

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

## Smoke-test checklist

1. Load extension from `dist/`.
2. Open a MakeCode project page.
3. Test `Managed` generation and `Revert`.
4. Test `BYOK` generation with at least one provider.
5. Rebuild + extension reload before re-testing code changes.

## Playwright audit scripts

- `npm run audit:smoke` -> deterministic UI smoke run with screenshot artefacts.
- `npm run audit:live` -> optional live managed/BYOK verification using secrets.
- `npm run audit:install` -> installs Chromium for local Playwright runs.

Audit output root:

- `output/playwright/audits/`

Secrets for live audits:

- keep in `.env.audit` (gitignored) or process environment variables.
- template: `.env.audit.example`.
