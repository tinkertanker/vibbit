# Agent Notes

Vibbit ships one school-facing runtime with Managed (backend-driven) and BYOK modes.

## Scope and ownership

- `work.js` is the runtime source for both extension and bookmarklet; `client.js` is legacy.
- `shared/makecode-compat-core.mjs` owns the generated compat block in `work.js`.
  Edit the shared source, run `npm run sync:compat-core`, then `npm run check:compat-core`;
  do not hand-edit the generated block. Backend and extension broker also consume this core.
- `extension/` owns extension packaging inputs, toolbar, options, bridge, and provider broker.
- `apps/backend/src/runtime.mjs` owns the managed backend; `server.mjs` there is its Node adapter.
- `dist/` and `artifacts/` are generated outputs, not editing targets.
  The extension zip is `artifacts/vibbit-extension.zip`.
- Read the relevant owners and references for the task, not the entire repository by default.

## Privacy and shared-system boundaries

- Managed provider keys stay server-side. Extension BYOK credentials and provider transport
  stay in trusted extension contexts, never MakeCode DOM/events/localStorage or MAIN-world fetches.
  Preserve sender checks and toolbar/document-bound, quota-limited generation authorization.
- Selecting Managed in a neutral build is not the hosted artifact's removal of BYOK capability.
  Bookmarklet BYOK is page-memory-only, not extension-isolated; page scripts can observe its key.
- Never expose keys, tokens, credential-bearing URLs, sensitive state, or student/teacher payloads
  in source, logs, screenshots, or shared artifacts. Gitignored files are not safe to share.
  Baked client tokens are readable distribution contents, not protected secrets.
- Preserve hosted authentication, credential encryption, origin and outbound-endpoint restrictions.
  Do not weaken safety controls to make tests pass. See [privacy details](README.md#supported-keys-and-endpoints).
- A normal implementation request authorizes scoped local edits, builds, isolated fixture/mock tests,
  and fixes for introduced failures without repeated permission prompts. Use disposable browser
  profiles and local backend state; preserve unrelated work. A plan/review-only request authorizes no edits.
- Obtain specific authorization before merge/push/tag publication, workflow dispatch, releases,
  deployment/rollback, shared infrastructure/data changes, teacher/admin writes, classroom changes,
  outbound email, or real-provider calls consuming quota or transmitting data. Local fixture state
  is distinct from shared school/operator state. Existing credentials, a production URL in a build,
  or a request to verify do not grant that authorization. Carry forward approval for the exact operation.

## Local build profiles

Run commands from the repository root, with build overrides selected intentionally.

| Intended output | Command |
| --- | --- |
| Neutral Managed + BYOK unpacked extension | `npm run build` |
| Hosted Managed unpacked extension, `https://vibbit.tk.sg` | `npm run build:hosted` |
| Hosted Managed zip | `npm run package` |
| Neutral dual-mode zip | `npm run package:neutral` |
| Bookmarklet runtime and loaders | `npm run build:bookmarklet` |

Extension builds overwrite the same `dist/`; verify `dist/content-script.js` and `dist/manifest.json`
for the intended profile. Packaging also emits the zip and already checks compat/builds.
Ordinary `build` does not check compat. Do not stack redundant build/package itineraries.
`build:hosted`/`package` hardcode the hosted backend and reject a nonempty `VIBBIT_APP_TOKEN`;
use [build override instructions](README.md#build-extension) for custom targets.
Bookmarklet output/URL options and its weaker key boundary are in the [bookmarklet guide](apps/bookmarklet/README.md).
Building a production-targeted artifact does not authorize contacting or deploying that target.

## Task-scoped verification

- Docs-only: check diff, links, commands against source, and policy consistency; no blanket build/browser suite.
- Logic/backend: targeted `node --test` files; broaden to `npm test` for shared/security changes.
  Shared compat edits require sync/check plus affected-consumer tests.
- Runtime/UI: use `npm run audit:smoke` for mocked flows and profile checks. It already builds/packages.
- Extension broker/options/permissions/manifest/reload: use `npm run audit:extension` with a display
  or virtual display; smoke injection alone does not prove extension isolation.
- Editor/Blocks compatibility: use `npm run audit:editor` with affected targets/fixtures.
  Exercise bookmarklet loader/runtime separately when that behavior changes.
- For installed-extension testing: build the intended profile, reload the extension, then refresh
  affected MakeCode tabs before retesting. Use available desktop/cloud tooling, not a required MCP.
- Inspect rendered affected UI states/screenshots and relevant DOM facts; report executed checks,
  limitations, and final `dist/` profile. Skipped checks are not passes.
- `audit:live` needs explicit authorization for real upstream traffic, not merely available secrets.
  Its legacy managed-token packaging limitation and audit coverage are documented in the reference below.
- Follow the environment's service lifecycle guidance for long-lived processes (supervised services
  in Amp orbs); do not assume tmux preserves services in every environment.

## Targeted references

- [Browser audits and desktop/cloud setup](docs/playwright-audits.md)
- [Backend setup, API, and hosted security configuration](apps/backend/README.md)
- [Release runbook](docs/release.md) and [release skill](skills/vibbit-release/SKILL.md)
  for release work only. Backend changes do not automatically authorize deployment.
  Confirm the documented Docker/SSH versus Railway target ambiguity before an authorized deployment.
  Publish release assets before deploying routes that depend on their `releases/latest` URLs.
- Environment setup sources: [Amp orb setup](.agents/setup), [Cursor configuration](.cursor/environment.json),
  and [Cursor image](.cursor/Dockerfile); do not duplicate their install itineraries here.
