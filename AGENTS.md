# Agent Notes

This repository ships one school-facing runtime that supports both:

- `Managed` mode (backend-driven)
- `BYOK` mode (provider/model/key entered by the school)

## Source of truth

- Runtime script for shipping/testing: `work.js`
- Extension build output: `dist/`
- Packaged zip output: `artifacts/bit-vibe-extension.zip`

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
   - `artifacts/bit-vibe-extension.zip`
4. For local browser testing, load unpacked from `dist/` at `chrome://extensions`.

## Supported keys and endpoints

### Managed mode

- Optional app token:
  - `APP_TOKEN` (Bearer token to your backend)
- Endpoint:
  - `POST {BACKEND}/mcai/generate`

### BYOK mode

- OpenAI key -> `https://api.openai.com/v1/chat/completions`
- Gemini key -> `https://generativelanguage.googleapis.com/v1/models/{model}:generateContent`
- OpenRouter key -> `https://openrouter.ai/api/v1/chat/completions`

## Build-time overrides

- `BITVIBE_BACKEND`
- `BITVIBE_APP_TOKEN`

Example:

```bash
BITVIBE_BACKEND="https://your-server.example" BITVIBE_APP_TOKEN="optional-token" npm run package
```

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
