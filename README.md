# bit:vibe for micro:bit

This repository provides the `bit:vibe` panel for MakeCode micro:bit and supports both deployment models in one version:

- `Managed` mode: you use a hosted backend (`/mcai/generate`)
- `BYOK` mode: you enter your own provider/model/key in the panel

## Supported keys and endpoints

### Managed mode

- Optional app token: `APP_TOKEN` (sent as `Authorization: Bearer <token>`)
- Endpoint used by the client:
  - `POST {BACKEND}/mcai/generate`
- Request payload:
  - `target`: `microbit | arcade | maker`
  - `request`: natural-language prompt
  - `currentCode`: optional current editor code

### BYOK mode

- Provider keys:
  - OpenAI API key
  - Gemini API key
  - OpenRouter API key
- Request auth details:
  - OpenAI and OpenRouter keys are sent in the `Authorization` header
  - Gemini keys are sent as the API key parameter expected by Google
- Provider endpoints:
  - OpenAI: `https://api.openai.com/v1/chat/completions`
  - Gemini: `https://generativelanguage.googleapis.com/v1/models/{model}:generateContent`
  - OpenRouter: `https://openrouter.ai/api/v1/chat/completions`

## Files

- `work.js`: primary runtime script (bookmarklet and extension source)
- `client.js`: earlier userscript variant kept in repo
- `extension/manifest.json`: Chrome extension manifest template
- `scripts/build.mjs`: builds `dist/` extension files from `work.js`
- `scripts/package.mjs`: zips `dist/` into `artifacts/bit-vibe-extension.zip`

## Runtime modes

### Managed mode

- Uses `BACKEND` + optional `APP_TOKEN`
- Sends `target`, `request`, and optional `currentCode` to `/mcai/generate`
- Best for centrally managed roll-outs

### BYOK mode

- School chooses provider (`OpenAI`, `Gemini`, `OpenRouter`)
- School supplies model + API key in the panel
- Key is stored in browser local storage for convenience
- Useful when teams prefer to use their own billing and policy setup

## Configure defaults

In `work.js`:

```js
const BACKEND = "https://mcai.dev.tk.sg";
const APP_TOKEN = "";
```

Set `APP_TOKEN` only if your backend enforces bearer auth.

## Build extension

```bash
npm run build
```

Outputs:

- `dist/content-script.js`
- `dist/manifest.json`

Optional build-time backend overrides:

```bash
BITVIBE_BACKEND="https://your-server.example" BITVIBE_APP_TOKEN="optional-token" npm run build
```

## Package extension zip

```bash
npm run package
```

This builds first, then creates:

- `artifacts/bit-vibe-extension.zip`

## Install in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this repo's `dist/` directory
5. Click **Reload** after each rebuild (`npm run build`) to test the latest code

## Browser testing quickstart

1. Build a fresh bundle:
   - `npm run package`
2. Confirm artefacts exist:
   - `dist/content-script.js`
   - `dist/manifest.json`
   - `artifacts/bit-vibe-extension.zip`
3. Load unpacked extension from `dist/` in Chrome.
4. Open one MakeCode editor page, for example:
   - `https://makecode.microbit.org/`
5. Managed smoke test:
   - choose `Managed`
   - enter a simple prompt
   - confirm code is generated and pasted, then test `Revert`
6. BYOK smoke test:
   - switch to `Bring your own key`
   - select provider + model, enter key
   - confirm generation and paste both work
7. If updating config values (`BITVIBE_BACKEND` or `BITVIBE_APP_TOKEN`), rebuild and reload the extension.

## Playwright audits

Two audit tiers are available:

1. `npm run audit:smoke`
   - No secrets needed.
   - Runs build/package checks and captures UI smoke screenshots.
2. `npm run audit:live`
   - Optional live checks for managed backend and BYOK provider calls.
   - Reads secrets from environment variables or `.env.audit`.

Install browser support once:

```bash
npm run audit:install
```

Smoke audit:

```bash
npm run audit:smoke
```

Live audit with secrets:

```bash
cp .env.audit.example .env.audit
# edit .env.audit with real values
npm run audit:live
```

Audit artefacts are written under `output/playwright/audits/<run-id>/` and are ignored from Git.

## Bookmarklet usage

You can also run `work.js` as a bookmarklet payload. The same panel supports both `Managed` and `BYOK` modes.

## Troubleshooting

- `Request failed: Unauthorized`: verify `APP_TOKEN` and server settings.
- `No code returned`: try a clearer prompt or switch model in BYOK mode.
- `Monaco not found`: open an actual MakeCode project first (not the landing page).
- `CORS/network errors`: ensure backend origins are allowed; for BYOK, check provider key and API availability.

## Credits

Kickstarted during work attachment by:

- [Atharv Pandit](https://github.com/Avi123-codes)
- [Josiah Menon](https://github.com/OsiahMelon)

Raffles Institution Year 4 (2025).
