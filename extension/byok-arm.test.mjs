import assert from "node:assert/strict";
import test from "node:test";

import {
  ARM_TTL_MS,
  MAX_GENERATIONS_PER_ARM,
  armMatchesDocument,
  armStorageKey,
  consumeArm,
  createArm
} from "./byok-arm.mjs";

test("toolbar arm is fixed to one document for 15 minutes and 10 generations", () => {
  const now = 1_000_000;
  const arm = createArm({ documentId: "document-a", url: "https://makecode.microbit.org/#editor", now });
  assert.deepEqual(arm, {
    documentId: "document-a",
    url: "https://makecode.microbit.org/#editor",
    expiresAt: now + 15 * 60 * 1000,
    remaining: 10
  });
  assert.equal(ARM_TTL_MS, 15 * 60 * 1000);
  assert.equal(MAX_GENERATIONS_PER_ARM, 10);
  assert.equal(armStorageKey(7), "vibbitByokArmV1:7");
  assert.equal(armMatchesDocument(arm, {
    documentId: "document-a",
    url: "https://makecode.microbit.org/#editor",
    now: now + ARM_TTL_MS - 1
  }), true);
  assert.equal(armMatchesDocument(arm, {
    documentId: "document-b",
    url: arm.url,
    now
  }), false);
  assert.equal(armMatchesDocument(arm, {
    documentId: arm.documentId,
    url: "https://makecode.microbit.org/#other",
    now
  }), false);
  assert.equal(armMatchesDocument(arm, {
    documentId: arm.documentId,
    url: arm.url,
    now: now + ARM_TTL_MS
  }), false);
});

test("consuming an arm decrements only its quota", () => {
  const arm = createArm({ documentId: "document-a", url: "https://maker.makecode.com/", now: 10 });
  const consumed = consumeArm(arm);
  assert.equal(consumed.remaining, arm.remaining - 1);
  assert.equal(consumed.expiresAt, arm.expiresAt);
  assert.equal(consumed.documentId, arm.documentId);
  assert.equal(consumed.url, arm.url);
  assert.equal(arm.remaining, MAX_GENERATIONS_PER_ARM);
});
