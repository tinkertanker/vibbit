---
name: vibbit-release
description: Coordinate Vibbit releases across the Chrome extension, bookmarklet artefacts, and backend-hosted website/download pages. Use when Codex needs to plan, prepare, verify, or execute a Vibbit release, cut a version tag, publish GitHub release assets, update bookmarklet/runtime artefacts, deploy the backend site, or assemble release notes and rollback steps.
---

# Vibbit Release

## Overview

Use this skill for any Vibbit shipping task that spans more than one surface. The source of truth is the versioned runbook in [`docs/release.md`](/Users/yingjie/Developer/tt-projects/bitvibe-extension/docs/release.md).

## Read First

1. Read [`docs/release.md`](/Users/yingjie/Developer/tt-projects/bitvibe-extension/docs/release.md) before making release decisions.
2. If the extension zip is involved, also read [`.github/workflows/release-extension.yml`](/Users/yingjie/Developer/tt-projects/bitvibe-extension/.github/workflows/release-extension.yml).
3. If backend/site deployment is involved, read [`AGENTS.md`](/Users/yingjie/Developer/tt-projects/bitvibe-extension/AGENTS.md) and [`apps/backend/README.md`](/Users/yingjie/Developer/tt-projects/bitvibe-extension/apps/backend/README.md) for current deployment assumptions.

## Workflow

1. Determine the release scope first:
   - extension zip
   - bookmarklet artefacts
   - backend/site deploy
   - full coordinated release
2. Pick the next unreleased version and bump the shipped extension version fields before tagging:
   - `package.json`
   - `extension/manifest.json`
3. Follow the ordered sequence in [`docs/release.md`](/Users/yingjie/Developer/tt-projects/bitvibe-extension/docs/release.md) instead of improvising.
4. Treat `work.js` changes as extension plus bookmarklet changes.
5. Publish GitHub release assets before deploying backend routes that point at `releases/latest`.
6. Finish with explicit verification and a short release summary.

## Output Expectations

When using this skill, end with:

- release scope
- build/package commands run
- tag or release URL, if any
- deployment status, if any
- validation completed
- follow-up items or rollback note

## Guardrails

- Do not cut a tag or deploy anything unless the user actually asked for a release, not just a plan.
- Keep the release runbook in [`docs/release.md`](/Users/yingjie/Developer/tt-projects/bitvibe-extension/docs/release.md) up to date when the process changes.
- Prefer small releases and call out partial-release assumptions explicitly.
