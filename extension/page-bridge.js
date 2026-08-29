(() => {
  const previous = globalThis.__vibbitExtensionBridgeV2;
  const bridgeToken = previous?.bridgeToken || crypto.randomUUID().replace(/-/g, "");
  const REQUEST_EVENT = `__vibbit_extension_request_v2_${bridgeToken}`;
  const RESPONSE_EVENT = `__vibbit_extension_response_v2_${bridgeToken}`;
  const ALLOWED = new Set([
    "vibbit:byok:generate",
    "vibbit:byok:cancel",
    "vibbit:byok:status",
    "vibbit:byok:open-options"
  ]);
  const requestIdPattern = /^[A-Za-z0-9_-]{8,80}$/;

  if (typeof previous?.listener === "function") {
    document.removeEventListener(previous.requestEvent, previous.listener);
  }

  const listener = (event) => {
    if (!(event instanceof CustomEvent)) return;
    const detail = event.detail && typeof event.detail === "object" ? event.detail : {};
    const type = String(detail.type || "");
    const requestId = String(detail.requestId || "");
    if (!ALLOWED.has(type) || !requestIdPattern.test(requestId)) return;
    chrome.runtime.sendMessage({
      type,
      requestId,
      payload: detail.payload && typeof detail.payload === "object" ? detail.payload : {}
    }).then((response) => {
      document.dispatchEvent(new CustomEvent(RESPONSE_EVENT, {
        detail: {
          requestId,
          ok: response?.ok === true,
          value: response?.ok === true ? response.value : null,
          error: response?.ok === true ? null : {
            code: String(response?.error?.code || "bridge_error"),
            status: Number(response?.error?.status) || 0
          }
        }
      }));
    }).catch(() => {
      document.dispatchEvent(new CustomEvent(RESPONSE_EVENT, {
        detail: { requestId, ok: false, value: null, error: { code: "bridge_error", status: 0 } }
      }));
    });
  };
  document.addEventListener(REQUEST_EVENT, listener);
  document.documentElement.dataset.vibbitBridgeToken = bridgeToken;
  globalThis.__vibbitExtensionBridgeV2 = { bridgeToken, listener, requestEvent: REQUEST_EVENT };
})();
