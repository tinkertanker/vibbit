# Browser validation and Playwright audits

Choose checks by the changed boundary; do not run every audit for every edit.
The [root guide](../AGENTS.md#task-scoped-verification) covers docs-only and unit-test selection.
Commands below run from the repository root. Use disposable browser profiles, fixture data,
and local backend state, not a school account or shared operator state.

## Audit selection and coverage

| Command | What it exercises | Limits and output profile |
| --- | --- | --- |
| `npm run audit:smoke` | Compat check, neutral build, hosted package, mocked Managed/BYOK UI, revert and error paths | Loads public MakeCode; injects raw `work.js` for neutral and built runtime for hosted. Provider/editor behavior is stubbed: not offline, installed-extension, or real compile proof. Leaves hosted `dist/` and zip. |
| `npm run audit:extension` | Actual unpacked extension, options/session credentials, bridge/broker, reload, hosted BYOK capability removal; mocked canary provider | Headful persistent Chromium requires a display. Seeds toolbar authorization rather than physically clicking browser chrome; exercises the shared toolbar helper after real reload. Builds both profiles and attempts to restore neutral `dist/`; check the report. |
| `npm run audit:editor` | Real released micro:bit/Arcade/Maker editors, submitted-source diagnostics and native Blocks acceptance/rejection | No build/package, extension install, or LLM call. Uses public MakeCode. Filter with `--target` or supply `--input` JSONL fixtures; optional `--headful`. |
| `npm run audit:live` | Configured real Managed/BYOK transport using environment or `.env.audit` | Requires authorization for quota/data use. Builds/packages but injects raw runtime with stubbed Monaco and Node transport proxies (bypassing browser CORS). Not extension-isolation or real-editor proof; leaves hosted outputs if packaging succeeds. See token limitation below. |

Smoke already checks/builds/packages; do not prepend another full build/package sequence.
None of the mocked checks establishes that a real provider succeeds. Live transport does not
establish that MakeCode compiled the result; its expected status is `Applied, unverified`.
Audit source contracts live in [smoke](../scripts/audit/smoke.mjs),
[extension boundary](../scripts/audit/extension-boundary.mjs),
[editor validation](../scripts/audit/editor-validation.mjs), and [live](../scripts/audit/live.mjs).

Example targeted editor run:

```bash
npm run audit:editor -- --target microbit
```

## Desktop and cloud setup

Inspect installed tooling first. If dependencies/browser are missing, install with `npm ci`
and `npm run audit:install`. Environment provisioning is owned by [Amp orb setup](../.agents/setup)
and [Cursor configuration](../.cursor/environment.json) / [image](../.cursor/Dockerfile).
Do not reinstall on every iteration or assume a macOS Chrome path in a cloud environment.

Use available browser automation (for example agent-browser, Playwright, CDP, or DevTools),
or manual Chrome/Brave testing. A particular MCP is not required. Cloud extension audits can
use an available graphical display. On Linux without `DISPLAY`, the extension audit automatically
relaunches under `xvfb-run` (which must be installed); an explicit equivalent is:

```bash
xvfb-run -a npm run audit:extension
```

For installed-extension verification, build the **intended profile**, load/reload `dist/`
at `chrome://extensions`, then refresh affected MakeCode tabs before retesting.
Keep neutral/BYOK and hosted/code-only states distinct. Audits share `dist/`; do not run
profile-changing commands concurrently or assume the previous build is still loaded.
Report missing capabilities rather than claiming injected runtime checks prove extension behavior.

### Optional desktop watch loop

Start Chrome/Brave with a disposable profile and a local remote-debugging endpoint, enable
Developer mode, and load `dist/` once. Then `npm run dev:watch-reload` rebuilds and reloads
the extension over CDP. It calls ordinary `build` (neutral under default build variables),
not `build:hosted`, and does not refresh MakeCode tabs for you.

Defaults: CDP `http://localhost:9222`, watched paths `work.js` and `extension/`, debounce 300 ms.
Overrides: `VIBBIT_DEVTOOLS_URL`, `VIBBIT_EXTENSION_ID`, `VIBBIT_WATCH_PATHS` (comma-separated),
and `VIBBIT_RELOAD_DEBOUNCE_MS`. Include other affected source paths when needed.
Keep debugging access local/private; use the environment's lifecycle manager for long-lived
watchers/services. Amp orbs require supervised orb services rather than relying on tmux survival.

## Representative behavior and evidence

Select affected states, not a duplicate checklist after every audit:

- Managed generation and Revert; neutral BYOK generation using mocked credentials/provider.
- Compile-error detection and empty-prompt auto-fix; conversion-dialog auto-retry and manual
  `Fix convert error` fallback when those paths change.
- Options, toolbar/reload, and hosted BYOK absence for extension-boundary changes.
- Actual bookmarklet loader/runtime on MakeCode for bookmarklet changes; extension injection is insufficient.

Inspect rendered screenshots for visual changes and relevant DOM/accessibility facts for interactions.
Record command/outcome, affected states, limitations, and final build profile. Physical toolbar clicks
need separate manual/available-browser-chrome validation when that interaction changes.
Audits write timestamped reports and captures under `output/playwright/audits/` (gitignored).
Inspect and sanitize captures/reports before sharing; screenshots alone do not prove unexercised behavior.

## Live authorization, secrets, and known limitation

Real provider calls can incur charges and transmit prompts/code; a configured secret is not permission.
Confirm the provider/backend target, test data, and bounded quota use before running `audit:live`.
Use authorized test credentials and a configured suitable low-cost model, not a policy-pinned model.
Teacher account save/test, classroom/admin writes, and outbound email also require authorization
when they affect real providers or shared systems. Prefer isolated fixtures for local validation.

Use [`.env.audit.example`](../.env.audit.example) for variable names, including
`AUDIT_MANAGED_BACKEND`, `AUDIT_MANAGED_APP_TOKEN`, and `AUDIT_BYOK_*`.
Keep actual values only in ignored local env files or a secret store/environment; the live script
loads `.env.audit` automatically. Backend local configuration uses
[`apps/backend/.env.example`](../apps/backend/.env.example); choose a disposable `VIBBIT_STATE_FILE`.
Never commit or share secrets, state, credential-bearing URLs, sensitive payloads, or env files
in logs/screenshots/CI artifacts. Missing live configuration is reported as skipped unless
`AUDIT_REQUIRE_SECRETS=1`; a skip is not a pass.

**Known hosted-token limitation:** `scripts/audit/live.mjs` sets `VIBBIT_APP_TOKEN` from
`AUDIT_MANAGED_APP_TOKEN`, then calls `npm run package`. That command builds hosted-managed,
which rejects a nonempty token, so this legacy-token case fails before browser validation.
Packaging also hardcodes `https://vibbit.tk.sg` rather than the audit backend override;
the subsequently injected raw runtime uses the audit backend. This is not a custom-target package test.
Document/report the limitation; any harness fix is separate work. Do not remove hosted token
restrictions or silently switch authentication/profile just to make the audit pass.
