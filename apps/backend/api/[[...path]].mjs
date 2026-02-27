import { createBackendRuntime } from "../src/runtime.mjs";

export const config = {
  runtime: "edge"
};

let runtime;

function getRuntime() {
  const env = (typeof process !== "undefined" && process.env) ? process.env : {};
  if (!runtime) runtime = createBackendRuntime({ env });
  return runtime;
}

export default async function handler(request) {
  return getRuntime().fetch(request);
}
