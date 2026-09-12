/**
 * Hands the browser what it needs to open a HawkTalk realtime socket.
 * HawkTalk authenticates the socket with the API key in the subprotocol, so the
 * key does reach the browser for this demo. Keep it a demo key.
 */
const PRIVATE_HOST = /^(localhost|127\.0\.0\.1|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+|[a-z0-9-]+\.tail[a-z0-9]+\.ts\.net)(:\d+)?$/i;

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Extra public hosts (one per line) — written by tls/golive.sh when the demo goes public. */
function publicHosts(): string[] {
  for (const f of [join(process.cwd(), ".public-hosts"), join(process.cwd(), "..", "..", ".public-hosts")]) {
    try { return readFileSync(f, "utf8").split(/\s+/).map((h) => h.trim().toLowerCase()).filter(Boolean); } catch { /* next */ }
  }
  return [];
}

export async function POST(request: Request) {
  // Demo-only: this hands a real key to the browser, so only answer on
  // loopback, LAN, tailnet, or explicitly listed public hosts. Rotate the key after the event.
  const host = (request.headers.get("host") ?? "").toLowerCase();
  if (!PRIVATE_HOST.test(host) && !publicHosts().includes(host)) return Response.json({ error: "HawkTalk realtime is only enabled on private hosts." }, { status: 403 });
  const key = process.env.HAWKTALK_API_KEY;
  if (!key) return Response.json({ error: "HAWKTALK_API_KEY is not set on the server." }, { status: 500 });
  return Response.json({
    endpoint: process.env.HAWKTALK_REALTIME_URL ?? "wss://hawktalk.ai/v1/realtime",
    apiUrl: process.env.HAWKTALK_API_URL ?? "https://api.hawktalk.ai",
    key,
    voice: process.env.HAWKTALK_VOICE ?? "",
  });
}
