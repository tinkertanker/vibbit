# Playwright audits

This repo provides two Playwright audit tiers:

1. **Smoke audit** (`npm run audit:smoke`)
- No secrets required.
- Validates build/package outputs.
- Injects `work.js` into MakeCode and captures UI proof screenshots.

2. **Live audit** (`npm run audit:live`)
- Uses secrets from environment variables or `.env.audit`.
- Optionally validates:
  - Managed runtime call (`AUDIT_MANAGED_BACKEND`)
  - BYOK provider call (`AUDIT_BYOK_*`)
- Writes run report + screenshots to `output/playwright/audits/live-<timestamp>/`.

## Quick start

Install dependencies and browser once:

```bash
npm install
npm run audit:install
```

Run smoke:

```bash
npm run audit:smoke
```

Run live (if secrets configured):

```bash
cp .env.audit.example .env.audit
# edit .env.audit with real values
npm run audit:live
```

## Secrets strategy

### Local development

- Keep real keys only in `.env.audit` (gitignored) or shell exports.
- Never put secrets in source, docs, or committed logs.
- The live script loads `.env.audit` automatically if present.

### CI

- Store secrets in CI secret store.
- Inject them as environment variables at runtime.
- Do not persist `.env.audit` in CI artefacts.

### BYOK recommendations

- Start with one provider (`AUDIT_BYOK_PROVIDER=openai`) for stability.
- Keep a low-cost model in audit config (for example `gpt-4o-mini`).
- Rotate keys regularly and scope them for test usage only.

## Output layout

Each run writes to a timestamped directory:

- `output/playwright/audits/smoke-<timestamp>/`
- `output/playwright/audits/live-<timestamp>/`

Each directory includes:

- `REPORT.md`
- screenshots (`*.png`)

`output/playwright/` is ignored from Git.
