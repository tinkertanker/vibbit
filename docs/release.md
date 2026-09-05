# Vibbit Release Runbook

Use this runbook for scoped preparation or execution of extension, bookmarklet, and backend/site releases.

## Authorization and release surfaces

Planning or preparing a release does not authorize merge/push, tagging, workflow dispatch,
publication, deployment, rollback, or shared-state changes. Confirm approval for the exact
operation and target before that boundary; do not re-ask for approval already granted.
Verification alone permits no shared-state writes or real-provider quota use.
Preserve the [privacy and shared-system boundaries](../AGENTS.md#privacy-and-shared-system-boundaries).

Use changed surfaces to determine what may need shipping, not as automatic instructions to ship:

- `work.js`: both extension and bookmarklet runtime.
- `extension/`: extension distribution.
- `apps/bookmarklet/`: bookmarklet build/distribution.
- `apps/backend/`: backend/site, including backend-hosted bookmarklet routes.
- Landing/download/install routes referencing `releases/latest`: publish and verify the required
  GitHub asset **before** deploying dependent backend routes.

## Local preflight and verification

1. Identify affected surfaces, intended profile/target, source revision, and approved operations.
   Inspect `git status --short`; preserve unrelated work.
2. For an extension release, choose an unused version/tag and keep `package.json` and
   `extension/manifest.json` versions in sync before the final build/tag. Do not bump extension
   versions automatically for backend-only or bookmarklet-only work.
3. Select affected tests using [browser/unit verification guidance](playwright-audits.md).
   Shared compat edits require source synchronization/checking and consumer tests. Backend-only
   logic changes need relevant backend tests, not an unrelated extension packaging itinerary.
4. Build only required artifacts:
   - Hosted extension: `npm run package` (compat check + hosted build + zip).
   - Neutral extension: `npm run package:neutral`.
   - Custom hosted target: follow [explicit profile overrides](../README.md#build-extension).
   - Bookmarklet: `npm run build:bookmarklet`, setting `VIBBIT_BOOKMARKLET_RUNTIME_URL` in that
     invocation if a specific hosted URL is required; see [bookmarklet outputs](../apps/bookmarklet/README.md).
   - If `audit:smoke` already produced the intended unchanged hosted artifact, do not rebuild it
     just to repeat this step. Audits may change `dist/`; verify the final profile before distribution.
5. Verify extension `dist/content-script.js`, `dist/manifest.json`, and
   `artifacts/vibbit-extension.zip` when applicable. Verify bookmarklet runtime, managed loader/install
   HTML, optional BYOK loader/install HTML, and the embedded runtime URL when applicable.
6. For affected browser behavior, exercise representative states from the audit guide. Test the
   intended shipped profile: hosted must not expose BYOK; neutral must retain it. Reload the built
   extension, then refresh affected MakeCode tabs. Do not overwrite a hosted test build with neutral
   `npm run build` out of habit. Test the actual bookmarklet flow when it changes.
7. Record commands, outcomes, artifact profile, and limitations. A mocked flow does not prove
   real-provider success; live checks require separately authorized target/data/quota use.

## Publish the extension release — only when authorized

1. Integrate the verified release revision into `main` and push only with authorization for those
   operations. Do not merge unrelated work or assume local `main` equals `origin/main`.
2. Create/push the approved release tag on the verified revision:
   - `git tag vX.Y.Z`
   - `git push origin vX.Y.Z`
3. Wait for [the release workflow](../.github/workflows/release-extension.yml). A `v*` tag push
   builds the hosted package and publishes GitHub assets; it is not merely a backup operation.
   Manual workflow dispatch also requires approval and is not a substitute for this tag flow.
4. Use `gh release view vX.Y.Z` and verify all four assets:
   - `vibbit-extension.zip` and `vibbit-extension.zip.sha256`
   - `vibbit-extension-vX.Y.Z.zip` and `vibbit-extension-vX.Y.Z.zip.sha256`
   Check downloaded bytes against their checksum when validating the distributable.
5. Only after required assets are live proceed to an authorized deployment of routes referencing
   their `releases/latest` URLs. A custom-target local package is not what this hosted workflow builds.

## Deployment target preflight — unresolved infrastructure history

Earlier root guidance identifies production `vibbit.tk.sg` as Docker on
`tinkertanker@dev.tk.sg:Docker/vibbit`. It describes gitignored `deploy.sh` (SSH, pull, rebuild,
restart) and `docker-compose.yml` (external `devtksg` network). These files are not checked in
and may not exist in an orb. The [backend guide](../apps/backend/README.md#railway-deployment-option)
also contains Railway deployment instructions; this does not establish the live site's current host.

Before an authorized deployment, confirm with the operator which environment/account, machine,
source revision, infrastructure files, and rollback path are current. Do not guess Docker versus
Railway, create replacement infrastructure, or SSH/deploy merely to resolve this documentation ambiguity.
Preserve hosted authentication, encryption, origin/endpoint restrictions, and sensitive persisted
teacher/admin state; do not migrate/delete/overwrite state as an incidental deployment step.

## Deploy backend and website — only for the approved target

1. Confirm the required source revision is available to the deployment mechanism. For a pull-based
   deployment, an authorized push must precede the server pull; a local commit alone is insufficient.
2. If bookmarklets reference a separately hosted runtime, publish that rebuilt runtime to the approved
   URL before distributing dependent loaders. This publication is its own authorization boundary.
3. Execute only the confirmed deployment procedure. If the operator confirms the documented Docker
   setup, inspect the local infrastructure files and run `./deploy.sh` on the machine that owns them.
   Otherwise follow the confirmed platform procedure, not an assumed fallback.
4. Verify affected routes read-only: `/healthz`, `/`, `/download/vibbit-extension.zip`, `/bookmarklet`,
   `/bookmarklet/runtime.js`; include `/admin/status` only with authorized operator access, without
   exposing its credential or sensitive response. Do not turn a route check into an admin write.
5. Confirm download redirects resolve to the intended asset and hosted runtime/install pages serve
   the intended revision. Merely opening a page does not verify generation; real-provider calls and
   classroom/account creation need their own authorization.

## Release summary and rollback

Record shipped scope/revision, tag/release URL if any, download/runtime status, validation evidence,
remaining limitations, and the known-good rollback target. Distinguish prepared from published/deployed.

Rollback also changes shared systems and needs explicit approval for its target/action:

- Extension: prepare a hotfix, or propose changing `VIBBIT_EXTENSION_DOWNLOAD_URL` to a verified
  previous zip and redeploying the backend.
- Backend/site or backend-hosted bookmarklet: propose redeploying a known-good revision with
  compatible state; do not overwrite current credentials/classrooms.
- Separately hosted bookmarklet: propose restoring the known-good runtime at its approved URL.

An incident does not itself authorize release, infrastructure, or data mutations. Preserve evidence
and present the concrete recovery action if authorization is missing.
