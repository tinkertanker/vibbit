# Vibbit Bookmarklet Build

This package builds a bookmarklet distribution for users who cannot install the Chrome extension.

Outputs are written to:

- `artifacts/bookmarklet/vibbit-runtime.js`
- `artifacts/bookmarklet/bookmarklet-managed.txt`
- `artifacts/bookmarklet/install-managed.html`
- `artifacts/bookmarklet/bookmarklet-byok.txt`
- `artifacts/bookmarklet/install-byok.html`

BYOK loader/install outputs are included by default. `VIBBIT_BOOKMARKLET_ENABLE_BYOK=false`
omits those outputs; it does not strip BYOK code from the shared runtime or provide the
hosted extension's capability boundary. Each build replaces the bookmarklet output directory.

Bookmarklet BYOK keys live only in page memory until reload, but other scripts on that page
can observe them. This is not the extension's trusted-context credential isolation.
Managed provider keys stay on the backend. See [credential boundaries](../../README.md#supported-keys-and-endpoints).

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

To emit only the Managed loader/install page (with the shared runtime unchanged):

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

Baked tokens are readable in the distributed runtime, not protected secrets. Never bake provider
keys or confidential credentials into a bookmarklet artifact; prefer the Managed classroom/session flow.
Building artifacts is local preparation, not permission to publish the runtime, change shared hosting,
or call real providers. Follow the authorized [release flow](../../docs/release.md) and exercise the
actual loader/runtime on MakeCode when bookmarklet behavior changes. Do not substitute extension-only
tests for bookmarklet coverage.
