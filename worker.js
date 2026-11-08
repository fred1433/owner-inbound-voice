// Serves site/ under theaipipe.com/demos/owner-inbound-voice/ (static files only).
// Audio gets byte ranges here: browsers need them to seek, and Safari to play at all.
const BASE = "/demos/owner-inbound-voice";

async function withRange(res, rangeHeader) {
  const bytes = await res.arrayBuffer();
  const total = bytes.byteLength;
  const headers = new Headers(res.headers);
  headers.set("Accept-Ranges", "bytes");
  headers.delete("Content-Length");
  if (!rangeHeader) return new Response(bytes, { status: 200, headers });
  const m = /^bytes=(\d*)-(\d*)/.exec(rangeHeader);
  let start = m && m[1] !== "" ? Number(m[1]) : null;
  let end = m && m[2] !== "" ? Number(m[2]) : null;
  if (m && start === null && end !== null) {
    start = Math.max(total - end, 0);
    end = total - 1;
  }
  if (start === null || start >= total) {
    headers.set("Content-Range", "bytes */" + total);
    return new Response(null, { status: 416, headers });
  }
  if (end === null || end >= total) end = total - 1;
  headers.set("Content-Range", "bytes " + start + "-" + end + "/" + total);
  return new Response(bytes.slice(start, end + 1), { status: 206, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === BASE) return Response.redirect(url.origin + BASE + "/", 308);
    if (!url.pathname.startsWith(BASE + "/")) return new Response("Not found", { status: 404 });
    const path = url.pathname.slice(BASE.length) || "/";
    const isAudio = path.endsWith(".mp3");
    const assetRequest = new Request(new URL(path, url.origin), { method: request.method, headers: isAudio ? {} : request.headers });
    const res = await env.ASSETS.fetch(assetRequest);
    const served = isAudio && res.ok && request.method !== "HEAD" ? await withRange(res, request.headers.get("Range")) : res;
    const out = new Response(served.body, served);
    const loc = out.headers.get("Location");
    if (loc && loc.startsWith("/")) out.headers.set("Location", BASE + loc);
    out.headers.set("X-Robots-Tag", "noindex, nofollow");
    return out;
  },
};
