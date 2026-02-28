# Vibbit Bookmarklet Build

This package builds a bookmarklet distribution for users who cannot install the Chrome extension.

Outputs are written to:

- `artifacts/bookmarklet/vibbit-runtime.js`
- `artifacts/bookmarklet/bookmarklet-managed.txt`
- `artifacts/bookmarklet/install-managed.html`

Optional BYOK-enabled outputs (when `--enable-byok` is used):

- `artifacts/bookmarklet/bookmarklet-byok.txt`
- `artifacts/bookmarklet/install-byok.html`

## Build

From repository root:

```bash
npm run build:bookmarklet
```

Enable BYOK bookmarklet output:

```bash
npm run build:bookmarklet:byok
```

Set a runtime URL for production bookmarklets:

```bash
VIBBIT_BOOKMARKLET_RUNTIME_URL="https://cdn.example.com/vibbit-runtime.js" npm run build:bookmarklet
```

Optional runtime overrides:

- `VIBBIT_BACKEND`
- `VIBBIT_APP_TOKEN`
