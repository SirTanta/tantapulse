/**
 * Standalone server for Lane 2 test-cap endpoint.
 * Wraps the Vercel-style handler (req, res) with Node http primitives.
 */

import http from "node:http";

// Shim res.status().json() for the Vercel-style handler
function wrapHandler(handler) {
  return async (nodeReq, nodeRes) => {
    const url = new URL(nodeReq.url, "http://localhost");

    // Build a Vercel-style req
    const vercelReq = {
      method: nodeReq.method,
      url: nodeReq.url,
      query: Object.fromEntries(url.searchParams),
      headers: nodeReq.headers,
    };

    // Build a Vercel-style res
    const chunks = [];
    // Disconnect the real socket — we capture the body ourselves
    const vercelRes = {
      _statusCode: 200,
      _headers: {},
      _body: null,
      status(code) {
        this._statusCode = code;
        return this;
      },
      setHeader(key, val) {
        this._headers[key] = val;
      },
      json(data) {
        this._body = JSON.stringify(data, null, 2);
        nodeRes.writeHead(this._statusCode, {
          "Content-Type": "application/json",
          ...this._headers,
        });
        nodeRes.end(this._body);
      },
      end(data) {
        nodeRes.end(data);
      },
    };

    try {
      await handler(vercelReq, vercelRes);
    } catch (err) {
      console.error("Handler error:", err);
      nodeRes.statusCode = 500;
      nodeRes.end(JSON.stringify({ error: err.message }));
    }
  };
}

async function main() {
  const mod = await import("./api/lane2/test-cap.js");
  const handler = wrapHandler(mod.default);

  const server = http.createServer(handler);
  server.listen(3177, () => console.log("listening on 3177"));
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
