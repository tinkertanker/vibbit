import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createModelCatalogue } from "./model-catalogue.mjs";
import { normaliseByokModel } from "../extension/byok-config.mjs";

const fixture = JSON.parse(await readFile(new URL("../scripts/audit/fixtures/model-catalogue.json", import.meta.url), "utf8"));

test("coordinator's 40-entry catalogue preserves supported native IDs and local gateway adapters without credentials", async () => {
  let calls = 0;
  const catalogue = createModelCatalogue({ origin: "https://gateway.example.test/v1", fetchImpl: async (url, init) => {
    calls++;
    assert.equal(url, "https://gateway.example.test/v1/model-catalogue");
    assert.equal(init.credentials, "omit");
    assert.equal(init.redirect, "error");
    assert.equal(init.referrerPolicy, "no-referrer");
    assert.deepEqual(init.headers, { Accept: "application/json" });
    return Response.json(fixture);
  } });
  const [models, concurrent] = await Promise.all([catalogue.load(), catalogue.load()]);
  assert.equal(models, concurrent);
  assert.equal(await catalogue.load(), models);
  assert.equal(calls, 1);
  assert.equal(fixture.data.length, 40);
  assert.equal(Object.values(models).flat().length, 38); // Native DeepSeek has no adapter here.
  assert.equal(models.openrouter.find((item) => item.default).id, "deepseek/deepseek-v4-flash");
  assert.equal(models.opencode.find((item) => item.default).id, "go/deepseek-v4-flash");
  assert.ok(models.opencode.some((item) => item.id === "zen/deepseek-v4-flash"));
  assert.ok(models.opencode.some((item) => item.id === "go/responses/gpt-5.6-luna"));
  assert.match(models.opencode.find((item) => item.id === "go/responses/muse-spark-1.2-contributor").label, /trains on data/);
  assert.equal(normaliseByokModel("openrouter", "vendor/custom-model:free"), "vendor/custom-model:free");
  assert.equal(normaliseByokModel("openai", "gpt-5.2"), "gpt-5.2");
});

test("catalogue falls back for invalid, oversized and offline responses; bounded fetch and retry", async () => {
  const invalid = [null, { ...fixture, version: 2 }, { ...fixture, data: [] },
    { ...fixture, data: [fixture.data[0], fixture.data[0]] },
    ...[{ provider: "__proto__" }, { id: "https://attacker.test/key" }, { tier: "unknown" }, { is_default: "true" }, { display_name: "bad\nlabel" }]
      .map((change) => ({ ...fixture, data: [{ ...fixture.data[0], ...change }] }))];
  for (const body of invalid) {
    const catalogue = createModelCatalogue({ origin: "https://gateway.test", fetchImpl: async () => Response.json(body) });
    assert.deepEqual(await catalogue.load(), catalogue.fallback);
  }
  for (const fetchImpl of [async () => new Response("x".repeat(131073)), async () => { throw new Error("offline"); }, async () => new Response("", { status: 503 })]) {
    const catalogue = createModelCatalogue({ origin: "https://gateway.test", fetchImpl });
    assert.deepEqual(await catalogue.load(), catalogue.fallback);
  }
  let clock = 1, calls = 0, signal;
  const catalogue = createModelCatalogue({ origin: "https://gateway.test", timeoutMs: 10, now: () => clock, fetchImpl: async (_, init) => {
    calls++;
    signal = init.signal;
    if (calls === 1) return new Promise(() => {});
    return Response.json(fixture);
  } });
  assert.deepEqual(await catalogue.load(), catalogue.fallback);
  assert.equal(signal.aborted, true);
  await catalogue.load();
  assert.equal(calls, 1);
  clock += 30001;
  assert.equal((await catalogue.load()).anthropic.length, 3);
  assert.equal(calls, 2);
});

test("metadata cannot provide transport instructions and invalid configured origins never fetch", async () => {
  for (const origin of ["", "https://user:secret@gateway.test", "https://gateway.test?token=secret", "http://untrusted.test"]) {
    const catalogue = createModelCatalogue({ origin, fetchImpl: () => assert.fail("must not fetch") });
    assert.deepEqual(await catalogue.load(), catalogue.fallback);
  }
  const catalogue = createModelCatalogue({ origin: "https://gateway.test", fetchImpl: async () => Response.json({ ...fixture,
    data: [{ ...fixture.data[0], endpoint: "https://evil.test", apiKey: "secret", protocol: "messages" }]
  }) });
  assert.deepEqual((await catalogue.load()).openai, [{ id: "gpt-6-luna", label: "GPT-6 Luna · economy", default: true }]);
});

test("Contributor disclosure survives renamed catalogue labels and offline saved/custom models", async () => {
  const id = "go/responses/muse-spark-1.2-contributor";
  const catalogue = createModelCatalogue({ origin: "https://gateway.test", fetchImpl: async () => Response.json({
    object: "list", version: 1, data: [{ id: "muse-spark-1.2-contributor", provider: "opencode-go", display_name: "Muse", tier: "premium", is_default: false }]
  }) });
  assert.match((await catalogue.load()).opencode[0].label, /trains on data/);
  const offline = createModelCatalogue();
  assert.match(offline.labelFor(id, "Saved/custom · " + id), /trains on data/);
  assert.equal(offline.labelFor("gpt-6-luna", "Luna"), "Luna");
  assert.equal(offline.labelFor(id, "Muse (trains on data)"), "Muse (trains on data)");
  const reserved = createModelCatalogue({ origin: "https://gateway.test", fetchImpl: async () => Response.json({
    object: "list", version: 1, data: [{ id: "responses", provider: "opencode-go", display_name: "Reserved", tier: "economy", is_default: true }]
  }) });
  assert.deepEqual(await reserved.load(), reserved.fallback);
});
