// Self-contained so the same implementation can be generated into the classic bookmarklet.
// Metadata is UI-only: endpoints, protocol selection, and authorization stay with each adapter.
export function createModelCatalogue({ origin = "", fetchImpl = globalThis.fetch, timeoutMs = 2500, now = Date.now } = {}) {
  const fallback = {
    openai: [{ id: "gpt-6-luna", label: "GPT-6 Luna", default: true }],
    anthropic: [{ id: "claude-haiku-5-5", label: "Claude Haiku 5.5", default: true }],
    gemini: [{ id: "gemini-3-flash-preview", label: "Gemini 3 Flash", default: true }],
    openrouter: [{ id: "openai/gpt-5.6-luna", label: "GPT-5.6 Luna", default: true }],
    opencode: [
      { id: "go/responses/gpt-5.6-luna", label: "Go · GPT-5.6 Luna", default: true },
      { id: "zen/hy3-free", label: "Zen · Hy3 Free" }
    ]
  };
  const providers = ["openai", "anthropic", "gemini", "deepseek", "openrouter", "opencode-go", "opencode-zen"];
  const labelFor = (id, label = id) => /(?:^|\/)muse-spark-1\.2-contributor$/.test(id) && !/trains on data/i.test(label)
    ? `${label} (trains on data)` : label;
  const validId = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(value)
    && !value.includes("://") && !value.split("/").some((part) => !part || part === "." || part === "..");
  const gatewayOrigin = (() => {
    try {
      const url = new URL(origin);
      if (url.username || url.password || url.search || url.hash) return "";
      if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) return "";
      return url.origin;
    } catch { return ""; }
  })();
  let cached = fallback;
  let expires = 0;
  let pending;

  function parse(value) {
    if (value?.object !== "list" || value.version !== 1 || !Array.isArray(value.data) || !value.data.length || value.data.length > 500) throw new Error("invalid_catalogue");
    const result = {};
    const ids = new Set();
    const defaults = new Set();
    for (const item of value.data) {
      if (!providers.includes(item?.provider) || !validId(item.id)
        || typeof item.display_name !== "string" || !item.display_name.trim() || item.display_name.length > 120
        || /[\u0000-\u001f\u007f]/.test(item.display_name)
        || !["economy", "balanced", "premium"].includes(item.tier) || typeof item.is_default !== "boolean") throw new Error("invalid_catalogue");
      const identity = item.provider + ":" + item.id;
      if (ids.has(identity) || (item.is_default && defaults.has(item.provider))) throw new Error("invalid_catalogue");
      ids.add(identity);
      if (item.is_default) defaults.add(item.provider);
      if (item.provider === "deepseek") continue; // No native DeepSeek transport in Vibbit.
      const access = item.provider === "opencode-go" ? "go" : item.provider === "opencode-zen" ? "zen" : "";
      if (access && (item.id.includes("/") || item.id === "responses")) throw new Error("invalid_catalogue");
      const provider = access ? "opencode" : item.provider;
      // Protocol knowledge is deliberately local, never supplied by catalogue fields.
      const responses = ["gpt-5.6-luna", "grok-4.5", "muse-spark-1.2-contributor"].includes(item.id);
      const id = access ? `${access}/${responses ? "responses/" : ""}${item.id}` : item.id;
      (result[provider] ||= []).push({ id, label: labelFor(id, `${access ? (access === "go" ? "Go" : "Zen") + " · " : ""}${item.display_name} · ${item.tier}`), default: item.is_default && access !== "zen" });
    }
    return { ...fallback, ...result };
  }

  async function load() {
    if (!gatewayOrigin || now() < expires) return cached;
    if (pending) return pending;
    pending = (async () => {
      const controller = new AbortController();
      let timer;
      try {
        cached = await Promise.race([
          (async () => {
            const response = await fetchImpl(gatewayOrigin + "/v1/model-catalogue", {
              method: "GET", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer",
              headers: { Accept: "application/json" }, signal: controller.signal
            });
            if (!response.ok) throw new Error("catalogue_unavailable");
            const reader = response.body.getReader();
            const chunks = [];
            let size = 0;
            try {
              while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                size += value.byteLength;
                if (size > 131072) throw new Error("catalogue_too_large");
                chunks.push(value);
              }
            } finally { await reader.cancel(); }
            const bytes = new Uint8Array(size);
            let offset = 0;
            for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
            return parse(JSON.parse(new TextDecoder().decode(bytes)));
          })(),
          new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("catalogue_timeout")); }, timeoutMs); })
        ]);
        expires = now() + 300000;
      } catch {
        controller.abort();
        cached = fallback;
        expires = now() + 30000;
      } finally { clearTimeout(timer); }
      return cached;
    })();
    try { return await pending; } finally { pending = null; }
  }
  return { fallback, load, validId, labelFor, gatewayOrigin };
}
