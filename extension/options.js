import { BYOK_MODEL_PRESETS, defaultByokModel } from "./extension/byok-config.mjs";
import { createModelCatalogue } from "./shared/model-catalogue.mjs";

const TKSLOPPER_GATEWAY_ORIGIN = "";
const catalogue = createModelCatalogue({ origin: TKSLOPPER_GATEWAY_ORIGIN });
let modelPresets = BYOK_MODEL_PRESETS;
const selections = new Map();

const provider = document.querySelector("#provider");
const model = document.querySelector("#model");
const apiKey = document.querySelector("#api-key");
const thinkHarder = document.querySelector("#think-harder");
const status = document.querySelector("#status");

for (const name of Object.keys(BYOK_MODEL_PRESETS)) {
  const option = document.createElement("option");
  option.value = name;
  option.textContent = name === "anthropic" ? "Anthropic (Claude)" : name === "openai" ? "OpenAI" : name === "openrouter" ? "OpenRouter" : name === "opencode" ? "OpenCode" : name[0].toUpperCase() + name.slice(1);
  provider.appendChild(option);
}

function populateModels(selected) {
  model.list.innerHTML = "";
  const presets = modelPresets[provider.value] || [];
  for (const preset of presets) {
    const option = document.createElement("option");
    option.value = preset.id;
    option.textContent = preset.label;
    model.list.appendChild(option);
  }
  if (selected && !presets.some((item) => item.id === selected)) {
    const option = document.createElement("option");
    option.value = selected;
    option.textContent = catalogue.labelFor(selected, "Saved/custom · " + selected);
    model.list.appendChild(option);
  }
  model.value = selected || presets.find((item) => item.default)?.id || presets[0]?.id || defaultByokModel(provider.value);
  document.querySelector("#model-warning").hidden = !catalogue.trainsOnData(model.value);
}

function showStatus(message, error = false) {
  status.textContent = message;
  status.dataset.error = error ? "true" : "false";
}

async function send(type, payload = {}) {
  if (type === "vibbit:byok:config:save" && !catalogue.validId(payload.model)) {
    throw new Error("Enter a model ID without spaces or a URL.");
  }
  const response = await chrome.runtime.sendMessage({ type, payload });
  if (!response?.ok) throw new Error(response?.error?.code || "settings_error");
  return response.value;
}

async function load() {
  document.querySelector("#settings").inert = true;
  const config = await send("vibbit:byok:config:get");
  modelPresets = await catalogue.load();
  provider.value = config.provider;
  populateModels(config.model);
  selections.set(config.provider, config.model);
  thinkHarder.checked = config.thinkHarder;
  showStatus(config.hasKey ? "A key is stored for this provider in this Chrome session." : "No key is stored for this provider.");
  document.querySelector("#settings").inert = false;
}

model.addEventListener("input", () => {
  selections.set(provider.value, model.value);
  document.querySelector("#model-warning").hidden = !catalogue.trainsOnData(model.value);
});
provider.addEventListener("change", async () => {
  populateModels(selections.get(provider.value));
  try {
    const config = await send("vibbit:byok:config:save", {
      provider: provider.value,
      model: model.value,
      thinkHarder: thinkHarder.checked
    });
    showStatus(config.hasKey ? "A key is stored for this provider." : "No key is stored for this provider.");
  } catch (error) {
    showStatus(`Save failed: ${error.message}`, true);
  }
});

document.querySelector("#settings").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    populateModels(model.value.trim());
    const payload = {
      provider: provider.value,
      model: model.value,
      thinkHarder: thinkHarder.checked
    };
    if (apiKey.value.trim()) payload.apiKey = apiKey.value.trim();
    const config = await send("vibbit:byok:config:save", payload);
    if (provider.value === config.provider) {
      populateModels(config.model);
      selections.set(config.provider, config.model);
    }
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

load().catch((error) => {
  document.querySelector("#settings").inert = false;
  showStatus(`Could not load settings: ${error.message}`, true);
});
