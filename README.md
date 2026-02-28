# Vibbit for MakeCode

This repo ships one Vibbit runtime supporting both:

- `Managed` mode (school server with server-side API keys)
- `BYOK` mode (student/teacher brings their own key in the panel)

## Managed classroom flow

1. Teacher runs or deploys the backend (`apps/backend/`).
2. Teacher shares only:
   - server URL
   - class code
3. Teacher can inspect backend status at `/admin` (using `/admin?admin=<ADMINTOKEN>`).
4. Students open Vibbit in MakeCode, choose `Managed`, and enter URL + class code.
5. Vibbit connects to `/vibbit/connect`, receives a short-lived session token, then calls `/vibbit/generate`.
6. Provider keys stay on the server.

## Supported keys and endpoints

### Managed mode

- Endpoint used by the extension:
  - `POST {BACKEND}/vibbit/generate`
- Session bootstrap endpoint:
  - `POST {BACKEND}/vibbit/connect`
- Admin endpoints:
  - `GET {BACKEND}/admin`
  - `GET {BACKEND}/admin/status`
  - `GET {BACKEND}/bookmarklet`
  - `GET {BACKEND}/bookmarklet/runtime.js`
- Request payload supports:
  - `target`, `request`, `currentCode`, `pageErrors`, `conversionDialog`
  - optional managed overrides: `provider`, `model`

### BYOK mode

- OpenAI key -> `https://api.openai.com/v1/chat/completions`
- Gemini key -> `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`
- OpenRouter key -> `https://openrouter.ai/api/v1/chat/completions`

## Files

- `work.js`: primary runtime source (extension + bookmarklet)
- `dist/`: built extension output
- `artifacts/vibbit-extension.zip`: packaged extension
- `apps/backend/`: managed backend (classroom auth + provider proxy)

## Block compatibility guardrails

- Prompts for `micro:bit` prefer built-in icons (`basic.showIcon(IconNames.*)`) using canonical names from `pxt-microbit/libs/core/icons.ts` (for example `IconNames.Duck`).
- Runtime validation checks known enum members from `pxt-microbit` core enums (for example `Button`, `Gesture`, `TouchPin`, `DigitalPin`).
- Runtime validation checks argument counts for core block APIs (derived from `//% blockId` signatures) before accepting model output.
- Prompt guidance includes `blocks-test` style example shapes to bias towards code that decompiles cleanly to Blocks.

## Build extension

```bash
npm run build
```

Outputs:

- `dist/content-script.js`
- `dist/manifest.json`

Build-time backend overrides:

```bash
VIBBIT_BACKEND="https://your-server.example" VIBBIT_APP_TOKEN="optional-token" npm run build
```

## Build bookmarklet distribution

For users who cannot install the Chrome extension, build bookmarklet artefacts:

```bash
npm run build:bookmarklet
```

Default output is Managed-first (BYOK hidden) and writes:

- `artifacts/bookmarklet/vibbit-runtime.js`
- `artifacts/bookmarklet/bookmarklet-managed.txt`
- `artifacts/bookmarklet/install-managed.html`

To emit an additional BYOK-enabled bookmarklet:

```bash
npm run build:bookmarklet:byok
```

Set the hosted runtime URL used inside the bookmarklet link:

```bash
VIBBIT_BOOKMARKLET_RUNTIME_URL="https://cdn.example.com/vibbit-runtime.js" npm run build:bookmarklet
```

Deploy `artifacts/bookmarklet/vibbit-runtime.js` to that URL, then distribute the generated bookmarklet text or install HTML.

## Backend-hosted bookmarklet (Railway-friendly)

The managed backend can host bookmarklet assets directly, so you can avoid a separate static hosting step:

- Installer page: `GET {BACKEND}/bookmarklet`
- Runtime script: `GET {BACKEND}/bookmarklet/runtime.js`

After deploying the backend, share `{BACKEND}/bookmarklet` with students who cannot install extensions.

## Shared compat core

`work.js` (BYOK runtime) and `apps/backend/src/runtime.mjs` (managed runtime) share generated compat helpers from:

- `shared/makecode-compat-core.mjs`

Sync/check commands:

- `npm run sync:compat-core` updates the generated block in `work.js`
- `npm run check:compat-core` fails if the generated block is stale

## Run backend locally (teacher laptop)

```bash
cp apps/backend/.env.example apps/backend/.env
npm run backend:start
```

Default local URL:

- `http://localhost:8787`

On start, backend logs the classroom share line (URL + class code) and the admin URL (`/admin?admin=...`).

If provider keys are not set in env, open `/admin?admin=<ADMINTOKEN>` and configure them in the Provider Setup form.

## Deploy backend (monorepo)

Supported hosted deployment target:

- Railway

Deploy button (placeholder until template is published):

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template/REPLACE_WITH_TEMPLATE_CODE?utm_medium=integration&utm_source=button&utm_campaign=vibbit)

See full backend setup and env docs here:

- `apps/backend/README.md`

Recommended teacher flow:

1. Open [Railway New Project](https://railway.com/new) and deploy from GitHub.
2. Set service root directory to `apps/backend`.
3. Add required env vars from `apps/backend/.env.example`.
4. Generate a public domain and share URL + class code.

Cheapest hosted option:

- Use one Railway backend service only, attach a volume, and set `VIBBIT_STATE_FILE=/data/vibbit-state.json`.
- Set Railway hard usage limit to `$1`.

## Install extension in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select `dist/`
5. Rebuild (`npm run build`) and click **Reload** after changes

## Browser-test checklist

1. Build/package:
   - `npm run package`
2. Confirm artefacts:
   - `dist/content-script.js`
   - `dist/manifest.json`
   - `artifacts/vibbit-extension.zip`
3. Managed checks:
   - enter server URL + class code
   - generate and verify paste + `Revert`
   - test error-aware flow (empty prompt + page errors)
   - trigger conversion modal and verify retry + `Fix convert error`
4. BYOK checks:
   - provider + model + key
   - generation, paste, and error-context fixing
5. Reload extension and refresh MakeCode tabs after each build

## Playwright audits

- `npm run audit:smoke` -> deterministic UI smoke + screenshots
- `npm run audit:live` -> optional managed/BYOK live verification
- `npm run audit:install` -> install Chromium

Audit output:

- `output/playwright/audits/`

## Troubleshooting

- `Invalid class code`: confirm teacher shared the current code from backend logs/env.
- `Request failed: Unauthorized`: check class code/session, or `APP_TOKEN`/`SERVER_APP_TOKEN` if using legacy token mode.
- `No code returned`: try a clearer prompt or switch model.
- `Monaco not found`: open an actual MakeCode project first.
- `CORS/network errors`: check `VIBBIT_ALLOW_ORIGIN`, deployment env vars, and provider API key configuration.

## Credits

Kickstarted during work attachment by:

- [Atharv Pandit](https://github.com/Avi123-codes)
- [Josiah Menon](https://github.com/OsiahMelon)

Raffles Institution Year 4 (2025).
