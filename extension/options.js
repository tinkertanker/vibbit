import { BYOK_MODEL_PRESETS, defaultByokModel } from "./extension/byok-config.mjs";

const provider = document.querySelector("#provider");
const model = document.querySelector("#model");
const apiKey = document.querySelector("#api-key");
const thinkHarder = document.querySelector("#think-harder");
const status = document.querySelector("#status");

for (const name of Object.keys(BYOK_MODEL_PRESETS)) {
  const option = document.createElement("option");
  option.value = name;
  option.textContent = name === "openrouter" ? "OpenRouter" : name === "opencode" ? "OpenCode" : name[0].toUpperCase() + name.slice(1);
  provider.appendChild(option);
}

function populateModels(selected) {
  model.innerHTML = "";
  const presets = BYOK_MODEL_PRESETS[provider.value] || [];
  for (const preset of presets) {
    const option = document.createElement("option");
    option.value = preset.id;
    option.textContent = preset.label;
    model.appendChild(option);
  }
  model.value = presets.some((item) => item.id === selected) ? selected : defaultByokModel(provider.value);
}

function showStatus(message, error = false) {
  status.textContent = message;
  status.dataset.error = error ? "true" : "false";
}

async function send(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, payload });
  if (!response?.ok) throw new Error(response?.error?.code || "settings_error");
  return response.value;
}

async function load() {
  const config = await send("vibbit:byok:config:get");
  provider.value = config.provider;
  populateModels(config.model);
  thinkHarder.checked = config.thinkHarder;
  showStatus(config.hasKey ? "A key is stored for this provider in this Chrome session." : "No key is stored for this provider.");
}

provider.addEventListener("change", async () => {
  populateModels();
  const config = await send("vibbit:byok:config:save", {
    provider: provider.value,
    model: model.value,
    thinkHarder: thinkHarder.checked
  });
  showStatus(config.hasKey ? "A key is stored for this provider." : "No key is stored for this provider.");
});

document.querySelector("#settings").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const payload = {
      provider: provider.value,
      model: model.value,
      thinkHarder: thinkHarder.checked
    };
    if (apiKey.value.trim()) payload.apiKey = apiKey.value.trim();
    const config = await send("vibbit:byok:config:save", payload);
    apiKey.value = "";
    showStatus(config.hasKey ? "Saved securely for this Chrome session." : "Settings saved, but this provider still has no key.");
  } catch (error) {
    showStatus(`Save failed: ${error.message}`, true);
  }
});

document.querySelector("#forget").addEventListener("click", async () => {
  try {
    const config = await send("vibbit:byok:key:clear", { provider: provider.value });
    apiKey.value = "";
    showStatus(config.hasKey ? "Key remains stored." : "Provider key forgotten.");
  } catch (error) {
    showStatus(`Could not forget key: ${error.message}`, true);
  }
});

load().catch((error) => showStatus(`Could not load settings: ${error.message}`, true));
