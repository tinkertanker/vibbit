import { createServer } from "node:http";
import { createBackendRuntime } from "./runtime.mjs";

const PORT = Number(process.env.PORT || 8787);
const runtime = createBackendRuntime({ env: process.env });

function toFetchRequest(req) {
  const protocol = req.socket && req.socket.encrypted ? "https" : "http";
  const host = req.headers.host || `localhost:${PORT}`;
  const url = `${protocol}://${host}${req.url || "/"}`;

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item != null) headers.append(key, item);
      }
      continue;
    }
    if (value != null) headers.set(key, value);
  }

  const method = (req.method || "GET").toUpperCase();
  const init = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    init.body = req;
    init.duplex = "half";
  }

  return new Request(url, init);
}

async function sendFetchResponse(res, response) {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });

  if (!response.body) {
    res.end();
    return;
  }

  const body = Buffer.from(await response.arrayBuffer());
  res.end(body);
}

const server = createServer(async (req, res) => {
  try {
    const request = toFetchRequest(req);
    const response = await runtime.fetch(request);
    await sendFetchResponse(res, response);
  } catch (error) {
    const message = error && error.message ? error.message : "Internal server error";
    res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: message }));
  }
});

server.listen(PORT, () => {
  const listenUrl = `http://localhost:${PORT}`;
  const lines = runtime.getStartupInfo({ listenUrl });
  for (const line of lines) console.log(line);
});
