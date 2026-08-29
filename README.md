# Vibbit for MakeCode

This repo ships one Vibbit runtime supporting both:

- `Managed` mode (school server with server-side API keys)
- `BYOK` mode (student/teacher brings their own provider key)

## Managed classroom flow

1. Teacher runs or deploys the backend (`apps/backend/`).
2. Teacher opens `/teacher`, signs in (Google or local/dev login), and saves an OpenAI-compatible API base URL + key.
3. Teacher creates a classroom and shares the 10-letter code (shown as `ABCDE-FGHIJ`, optionally via `/join/CODE`).
4. Students open Vibbit in MakeCode and enter the classroom code. The production package (`npm run package`) is code-only against `https://vibbit.tk.sg`; ordinary `npm run build` keeps Managed + BYOK.
5. Vibbit connects to `/vibbit/connect`, receives a short-lived session token, then calls `/vibbit/generate`.
6. Provider keys stay on the server (per classroom). Optional operator panel: `/admin?admin=<ADMINTOKEN>`.

## Supported keys and endpoints

### Managed mode

- Endpoint used by the extension:
  - `POST {BACKEND}/vibbit/generate`
- Session bootstrap endpoint:
  - `POST {BACKEND}/vibbit/connect`
- Teacher / admin endpoints:
  - `GET {BACKEND}/` (informational landing page)
  - `GET {BACKEND}/teacher` (teacher login + mint classroom codes)
  - `GET {BACKEND}/admin`
  - `GET {BACKEND}/admin/status`
  - `GET {BACKEND}/download/vibbit-extension.zip`
  - `GET {BACKEND}/bookmarklet`
  - `GET {BACKEND}/bookmarklet/runtime.js`
- Teacher classrooms accept OpenAI, OpenRouter, OpenCode, Gemini, or a custom OpenAI-compatible base URL (LiteLLM / Claude-compatible proxies). Custom public hosts require `VIBBIT_CUSTOM_ENDPOINT_ALLOWLIST`; localhost/private gateways need self-hosted mode plus `VIBBIT_ALLOW_PRIVATE_ENDPOINTS=true`. The URL must expose a `/chat/completions` endpoint (or equivalent path normalised to `/v1`).
- Request payload supports:
  - `target`, `request`, `currentCode`, `pageErrors`, `conversionDialog`
  - optional managed overrides: `provider`, `model`

### BYOK mode

- OpenAI key -> `https://api.openai.com/v1/responses` for GPT-5.6 Luna; older presets use `/v1/chat/completions`
- Gemini key -> `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`
- OpenRouter key -> `https://openrouter.ai/api/v1/chat/completions`
- OpenCode key -> OpenCode Go or Zen (`https://opencode.ai/zen/go/v1` or `https://opencode.ai/zen/v1`)

In the Chrome extension, BYOK configuration lives on the extension's options page. Keys are kept in trusted `chrome.storage.session`, cleared when Chrome exits, and never placed in MakeCode's DOM, events, `localStorage`, or provider requests from the page. Clicking the Vibbit toolbar action arms that exact MakeCode document for 15 minutes and at most 10 generations; one request may run at a time and cancellation aborts the provider fetch. While armed, hostile code already running on the MakeCode page can invoke the bounded generation capability and spend that quota, but it cannot read the key or choose an arbitrary endpoint, model, header, or provider request body. Schools that require prevention of all page-initiated quota use should use Managed mode rather than BYOK.

The bookmarklet cannot provide the same origin boundary: its BYOK key is memory-only and disappears on reload, but other scripts on the page can observe it while the bookmarklet is running. Rotate any key previously entered into an older Vibbit build that persisted keys in MakeCode `localStorage`.

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
- Maker guidance is pinned to Adafruit Circuit Playground Express and uses its fixed pin/button objects (`pins.LED`, `pins.A0`–`pins.A7`, `input.buttonA/buttonB`) and global `forever`/`pause`, rather than micro:bit-style pin enums.

Vibbit reports the validation state explicitly:

- `Done`: code was applied and the available MakeCode validation passed.
- `Applied, unverified`: code was applied, but the live editor validation probe was unavailable.
- `Fallback applied`: retries were exhausted and Vibbit applied a target-safe stub rather than claiming model output succeeded.

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

## Distribute extension (website + GitHub)

Extension packaging is built into the repo:

```bash
npm run package
```

Output:

- `artifacts/vibbit-extension.zip`

Website download route:

- `GET {BACKEND}/download/vibbit-extension.zip`

By default, that backend route redirects to the latest GitHub release asset:

- `https://github.com/tinkertanker/vibbit/releases/latest/download/vibbit-extension.zip`

To ship a new downloadable version on GitHub:

1. Push a release tag (for example `v0.2.1`).
2. GitHub Actions workflow `.github/workflows/release-extension.yml` builds and packages the extension.
3. The workflow publishes release assets:
   - `vibbit-extension.zip` (stable filename for latest download URL)
   - `vibbit-extension-<tag>.zip` (versioned copy)
   - matching `.sha256` checksum files

Optional backend override:

- Set `VIBBIT_EXTENSION_DOWNLOAD_URL` to any custom hosted zip URL if you do not want to use GitHub release assets.

## Build bookmarklet distribution

For users who cannot install the Chrome extension, build bookmarklet artefacts:

```bash
npm run build:bookmarklet
```

Default output includes both managed and BYOK bookmarklets (matching the extension):

- `artifacts/bookmarklet/vibbit-runtime.js`
- `artifacts/bookmarklet/bookmarklet-managed.txt`
- `artifacts/bookmarklet/install-managed.html`
- `artifacts/bookmarklet/bookmarklet-byok.txt`
- `artifacts/bookmarklet/install-byok.html`

To emit managed-only output:

```bash
VIBBIT_BOOKMARKLET_ENABLE_BYOK=false npm run build:bookmarklet
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

## Release runbook

For coordinated extension, bookmarklet, and backend/site releases, use:

- `docs/release.md`

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

On start, backend logs the classroom share line and admin path. Supply `VIBBIT_ADMIN_TOKEN` through the environment; the token is not printed.

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
4. Generate a public domain, mint a classroom code, and share the code (hosted extension students need only the code).

Cheapest hosted option:

- Use one Railway backend service only, attach a volume, and set `VIBBIT_STATE_FILE=/data/vibbit-state.json`.
- Set Railway hard usage limit to `$1`.

## Install extension in Chrome (unpacked)

Vibbit is not on the Chrome Web Store yet. Install it as an unpacked extension:

- Download the latest zip from `https://vibbit.tk.sg/download/vibbit-extension.zip`, or
- Build locally with `npm run build` and use `dist/`.

Then:

1. If you downloaded the zip, unzip it first.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the unzipped folder (or `dist/` for local builds) containing `manifest.json`.
6. For updates, rebuild/re-download and click **Reload** on the extension card.

## Browser-test checklist

1. Build/package:
   - `npm run package`
2. Confirm artefacts:
   - `dist/content-script.js`
   - `dist/manifest.json`
   - `artifacts/vibbit-extension.zip`
3. Managed checks after `npm run package` (hosted/code-only):
   - enter classroom code only (server URL hidden; baked `https://vibbit.tk.sg`)
   - generate and verify paste + `Revert`
   - test error-aware flow (empty prompt + page errors)
   - trigger conversion modal and verify retry + `Fix convert error`
4. BYOK checks after `npm run build` (neutral dual-mode):
   - click the toolbar action to arm the tab, then use **Open BYOK Settings** for provider + model + session key
   - generation, paste, and error-context fixing
5. Reload extension and refresh MakeCode tabs after each build

## Playwright audits

- `npm run audit:smoke` -> deterministic UI smoke + screenshots
- `npm run audit:extension` -> real unpacked-extension key/isolation/arming canary (uses Xvfb automatically in Linux orbs)
- `npm run audit:editor` -> released MakeCode editor valid/invalid/grey-block conversion checks
- `npm run audit:live` -> optional managed/BYOK live verification
- `npm run audit:install` -> install Chromium

Audit output:

- `output/playwright/audits/`

Model and Harness policy evaluation, including raw-vs-retry runs, immutable trajectories, adversarial context cases, ablations, Wilson intervals, and paired model comparisons, is documented in `docs/makecode-model-evaluation.md`.

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
