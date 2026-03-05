import assert from "node:assert/strict";
import test from "node:test";
import { createBackendRuntime } from "./runtime.mjs";

function createRuntime() {
  return createBackendRuntime({
    env: {
      VIBBIT_CLASSROOM_ENABLED: "false",
      SERVER_APP_TOKEN: ""
    }
  });
}

async function fetchRuntime(pathname) {
  const runtime = createRuntime();
  return runtime.fetch(new Request(`https://example.test${pathname}`));
}

test("serves favicon svg for root and /api-prefixed requests", async () => {
  for (const pathname of ["/favicon.svg", "/api/favicon.svg"]) {
    const response = await fetchRuntime(pathname);
    assert.equal(response.status, 200);
    assert.match(String(response.headers.get("content-type") || ""), /^image\/svg\+xml/);
    const body = await response.text();
    assert.match(body, /<svg[\s>]/i);
  }
});

test("redirects favicon ico requests to the matching svg path", async () => {
  const cases = [
    { pathname: "/favicon.ico", expectedLocation: "/favicon.svg" },
    { pathname: "/api/favicon.ico", expectedLocation: "/api/favicon.svg" }
  ];

  for (const { pathname, expectedLocation } of cases) {
    const response = await fetchRuntime(pathname);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), expectedLocation);
  }
});

test("renders relative favicon links on html pages for prefix-safe resolution", async () => {
  const pages = ["/", "/bookmarklet", "/admin", "/api/bookmarklet", "/api/admin"];

  for (const pathname of pages) {
    const response = await fetchRuntime(pathname);
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /href="favicon\.svg"/);
    assert.doesNotMatch(body, /href="\/favicon\.svg"/);
  }
});
