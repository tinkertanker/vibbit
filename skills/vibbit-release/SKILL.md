---
name: vibbit-release
description: Coordinates Vibbit extension, bookmarklet, and backend/site releases. Use when planning, preparing, verifying, or explicitly executing a release or rollback.
---

# Vibbit Release

## Overview

Use this skill for scoped Vibbit release work. The source of truth is the versioned
[release runbook](../../docs/release.md), not a second build/deploy itinerary here.

## Read First

1. Read the relevant sections of [docs/release.md](../../docs/release.md) for the requested surfaces.
2. For extension publication, inspect [the release workflow](../../.github/workflows/release-extension.yml).
3. For backend/site deployment, consult [root boundaries](../../AGENTS.md) and
   [backend configuration](../../apps/backend/README.md). Resolve the runbook's Docker/SSH versus
   Railway ambiguity with the operator before an authorized deployment; do not guess or probe by deploying.

## Workflow

1. Determine the release scope first:
   - extension zip
   - bookmarklet artefacts
   - backend/site deploy
   - full coordinated release
2. Distinguish local preparation from approved publication/deployment. For extension releases only,
   keep `package.json` and `extension/manifest.json` versions in sync before the final build/tag.
3. Follow the applicable ordered steps in [docs/release.md](../../docs/release.md).
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

- A plan-only request authorizes no edits, tags, publication, or deployment. Local release preparation
  does not authorize merge/push/tag publication, workflow dispatch, release, deployment, or rollback.
  Confirm approval for each exact shared-state operation/target; retain approval already granted.
- Preserve [privacy, shared-state, and provider-quota boundaries](../../AGENTS.md#privacy-and-shared-system-boundaries).
  Secrets being configured do not authorize real-provider tests, teacher/admin writes, or outbound email.
- Validate the intended artifact profile and refresh MakeCode tabs after extension reload.
  Do not weaken hosted safety controls to work around the documented live-audit token limitation.
- Keep the [release runbook](../../docs/release.md) up to date when the process changes.
- Prefer small releases and call out partial-release assumptions explicitly.
