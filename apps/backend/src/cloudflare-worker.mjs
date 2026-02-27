import { createBackendRuntime } from "./runtime.mjs";

let runtime;

export default {
  async fetch(request, env) {
    if (!runtime) {
      runtime = createBackendRuntime({ env });
    }
    return runtime.fetch(request);
  }
};
