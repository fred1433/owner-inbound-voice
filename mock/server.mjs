// Puts the mock CRM behind real HTTP on the loopback interface, so the replay sends real requests.
import http from "node:http";
import { createMockCrm } from "../site/lib/mockcrm.js";

export async function startMockServer(contracts, options) {
  const crm = createMockCrm(contracts, options);
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url, "http://127.0.0.1");
      const raw = Buffer.concat(chunks).toString();
      let body;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: "body is not JSON" }));
        return;
      }
      const query = url.search ? Object.fromEntries(url.searchParams) : undefined;
      const out = crm.handle(req.method, url.pathname, { headers: req.headers, query, body });
      res.writeHead(out.status, { "content-type": "application/json" });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  const transport = async (method, path, request) => {
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(request.query || {})) url.searchParams.set(k, String(v));
    const res = await fetch(url, {
      method,
      headers: Object.assign({ "content-type": "application/json" }, request.headers),
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
    });
    return { status: res.status, body: await res.json() };
  };
  return { crm, transport, close: () => new Promise((resolve) => server.close(resolve)) };
}
