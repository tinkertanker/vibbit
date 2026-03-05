# Vibbit Bookmarklet Build

This package builds a bookmarklet distribution for users who cannot install the Chrome extension.

Outputs are written to:

- `artifacts/bookmarklet/vibbit-runtime.js`
- `artifacts/bookmarklet/bookmarklet-managed.txt`
- `artifacts/bookmarklet/install-managed.html`
- `artifacts/bookmarklet/bookmarklet-byok.txt`
- `artifacts/bookmarklet/install-byok.html`

BYOK-enabled outputs are included by default to match the extension feature set.
Use `VIBBIT_BOOKMARKLET_ENABLE_BYOK=false` to build managed-only outputs.

## Build

From repository root:

```bash
npm run build:bookmarklet
```

This command emits both managed and BYOK artifacts by default.

You can also run the legacy BYOK variant command:

```bash
npm run build:bookmarklet:byok
```

To emit managed-only output:

```bash
VIBBIT_BOOKMARKLET_ENABLE_BYOK=false npm run build:bookmarklet
```

Set a runtime URL for production bookmarklets:

```bash
VIBBIT_BOOKMARKLET_RUNTIME_URL="https://cdn.example.com/vibbit-runtime.js" npm run build:bookmarklet
```

Optional runtime overrides:

- `VIBBIT_BACKEND`
- `VIBBIT_APP_TOKEN`
