# Vibbit Release Runbook

Use this runbook when preparing or executing any Vibbit release that may touch the Chrome extension zip, bookmarklet artefacts, backend-hosted website pages, or download/install routes.

## Release surfaces

- `work.js` changes: treat as both extension and bookmarklet changes.
- `extension/` changes: extension release required.
- `apps/bookmarklet/` changes: bookmarklet rebuild required.
- `apps/backend/` changes: backend/site deploy required.
- Landing page, `/download/vibbit-extension.zip`, or `/bookmarklet` changes: deploy backend after the GitHub release asset is live if those pages point at `releases/latest`.

## Preflight

1. Confirm the scope:
   - full release: extension + bookmarklet + backend/site
   - extension-only release
   - bookmarklet-only release
   - backend/site-only release
2. Merge releasable work to `main` first.
3. Pick the version tag up front, for example `v0.2.3`.
4. Check the worktree:
   - `git status --short`
5. If the release touches UI/runtime behaviour, plan to run browser validation in MakeCode after building.

## Build And Verify

1. Check the shared compat block:
   - `npm run check:compat-core`
2. Build and package the extension:
   - `npm run package`
3. Verify extension artefacts:
   - `dist/content-script.js`
   - `dist/manifest.json`
   - `artifacts/vibbit-extension.zip`
4. Build bookmarklet artefacts:
   - `npm run build:bookmarklet`
5. Verify bookmarklet artefacts:
   - `artifacts/bookmarklet/vibbit-runtime.js`
   - `artifacts/bookmarklet/bookmarklet-managed.txt`
   - `artifacts/bookmarklet/install-managed.html`
   - optional: `artifacts/bookmarklet/bookmarklet-byok.txt`
   - optional: `artifacts/bookmarklet/install-byok.html`
6. If production bookmarklets should point at a specific hosted runtime URL, rebuild with:
   - `VIBBIT_BOOKMARKLET_RUNTIME_URL="https://your-runtime.example/vibbit-runtime.js" npm run build:bookmarklet`
7. For higher-risk UI/runtime releases, run:
   - `npm run audit:smoke`

## Publish The Extension Release

Only do this when the downloadable extension zip should change.

1. Push `main`.
2. Create and push the release tag:
   - `git tag vX.Y.Z`
   - `git push origin vX.Y.Z`
3. Wait for `.github/workflows/release-extension.yml` to finish.
4. Verify the GitHub release contains:
   - `vibbit-extension.zip`
   - `vibbit-extension.zip.sha256`
   - `vibbit-extension-vX.Y.Z.zip`
   - `vibbit-extension-vX.Y.Z.zip.sha256`
5. Verify release metadata and asset presence:
   - `gh release view vX.Y.Z`
6. Remember the ordering rule:
   - publish the GitHub release asset before deploying backend pages or redirects that point at `releases/latest`

## Deploy Backend And Website

Do this when backend behaviour, landing-page copy, bookmarklet install/runtime hosting, or download redirects changed.

1. Push the releasable `main` branch before any server-side pull-based deploy:
   - `git push origin main`
2. If bookmarklets use a separately hosted runtime URL, publish the rebuilt runtime first:
   - upload `artifacts/bookmarklet/vibbit-runtime.js` to the production runtime URL referenced by `VIBBIT_BOOKMARKLET_RUNTIME_URL`
3. Deploy from the local machine that has the infrastructure files:
   - `./deploy.sh`
4. Verify production routes:
   - `GET /healthz`
   - `GET /`
   - `GET /download/vibbit-extension.zip`
   - `GET /bookmarklet`
   - `GET /bookmarklet/runtime.js`
   - `GET /admin/status`
5. If `/download/vibbit-extension.zip` should resolve to the new GitHub asset, confirm the redirect now points at the latest release.
6. If the backend hosts the classroom bookmarklet/runtime, confirm `/bookmarklet` and `/bookmarklet/runtime.js` serve the new release.
7. If bookmarklets use a separately hosted runtime, open the generated install page or bookmarklet link and confirm it loads the newly published runtime.

## Browser Validation

Run this after any user-facing extension or runtime change.

1. Build the extension:
   - `npm run build`
2. Reload the unpacked extension from `dist/` in Brave or Chrome.
3. Refresh any open MakeCode tabs after the extension reload.
4. Run the smoke flow:
   - managed generation
   - revert
   - compile-error auto-fix
   - conversion-dialog auto-retry and manual fix
   - BYOK generation
5. If bookmarklet behaviour changed, test the bookmarklet flow on a MakeCode page too.

## Release Notes

Capture these before closing the release:

- scope shipped
- tag and GitHub release URL
- whether `/download/vibbit-extension.zip` now resolves to the new asset
- whether `/bookmarklet` is updated
- validation performed
- any follow-up tasks or known risks

## Rollback

- Bad extension release: cut a hotfix release quickly, or temporarily point `VIBBIT_EXTENSION_DOWNLOAD_URL` at the last known-good zip and redeploy the backend.
- Bad backend/site deploy: redeploy the previous known-good backend revision.
- Bad bookmarklet runtime:
  - backend-hosted bookmarklet: redeploy the previous backend revision
  - separately hosted runtime: restore the previous `vibbit-runtime.js`

When in doubt, restore the last known-good download/runtime endpoints first, then ship the corrective release.
