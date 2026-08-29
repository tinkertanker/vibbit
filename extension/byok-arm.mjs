export const ARM_TTL_MS = 15 * 60 * 1000;
export const MAX_GENERATIONS_PER_ARM = 10;
export const ARM_STORAGE_KEY_PREFIX = "vibbitByokArmV1:";

export function armStorageKey(tabId) {
  return `${ARM_STORAGE_KEY_PREFIX}${tabId}`;
}

export function createArm({ documentId, url, now = Date.now() }) {
  if (!documentId) return null;
  return {
    documentId: String(documentId),
    url: String(url || ""),
    expiresAt: now + ARM_TTL_MS,
    remaining: MAX_GENERATIONS_PER_ARM
  };
}

export function armMatchesDocument(arm, { documentId, url, now = Date.now() }) {
  return Boolean(arm?.documentId && documentId)
    && arm.documentId === String(documentId)
    && arm.url === String(url || "")
    && Number(arm.expiresAt) > now
    && Number(arm.remaining) > 0;
}

export function consumeArm(arm) {
  return { ...arm, remaining: Number(arm.remaining) - 1 };
}
