import { createBackendRuntime } from "../../src/runtime.mjs";

let runtime;

function resolveEnv(context) {
  if (context && context.env && typeof context.env === "object") return context.env;
  if (typeof process !== "undefined" && process.env) return process.env;
  return {};
}

export default async (request, context) => {
  if (!runtime) runtime = createBackendRuntime({ env: resolveEnv(context) });
  return runtime.fetch(request);
};
