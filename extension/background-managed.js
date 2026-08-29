import { isMakeCodeUrl, togglePageUi } from "./toolbar.mjs";

const HOSTED_MANAGED = true;

chrome.action.onClicked.addListener(async (tab) => {
  if (!Number.isInteger(tab.id) || !isMakeCodeUrl(tab.url)) return;
  await togglePageUi(tab.id, { includeBridge: false });
});

chrome.runtime.onMessage.addListener((_message, _sender, sendResponse) => {
  sendResponse({ ok: false, error: { code: HOSTED_MANAGED ? "managed_only_build" : "internal_error", status: 0 } });
  return false;
});
