# Vibbit for MakeCode

This repo ships one Vibbit runtime supporting both:

- `Managed` mode (school server with server-side API keys)
- `BYOK` mode (student/teacher brings their own key in the panel)

## Managed classroom flow

1. Teacher runs or deploys the backend (`apps/backend/`).
2. Teacher shares only:
   - server URL
   - class code
3. Teacher can inspect backend status at `/admin` (for classroom mode: `/admin?code=<CLASSCODE>`).
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

## Run backend locally (teacher laptop)

```bash
cp apps/backend/.env.example apps/backend/.env
# set at least one provider API key, for example VIBBIT_OPENAI_API_KEY
npm run backend:start
```

Default local URL:

- `http://localhost:8787`

On start, backend logs the classroom share line (URL + class code).

## Deploy backend (monorepo)

Backend includes adapters for:

- Cloudflare Workers
- Vercel Edge
- Netlify Edge

See full backend setup and env docs here:

- `apps/backend/README.md`

One-click templates (replace `<YOUR_GITHUB_REPO_URL>`):

- Cloudflare: [Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=<YOUR_GITHUB_REPO_URL>)
- Vercel: [Deploy to Vercel](https://vercel.com/new/clone?repository-url=<YOUR_GITHUB_REPO_URL>&root-directory=apps/backend)
- Netlify: [Deploy to Netlify](https://app.netlify.com/start/deploy?repository=<YOUR_GITHUB_REPO_URL>)

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
