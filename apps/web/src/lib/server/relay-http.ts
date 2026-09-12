/**
 * HTTP surface for the relay ring, framework-free so it runs under node --test.
 *
 *   POST {type, ...payload}            → appends; 202 with the stored event
 *   GET  Accept: text/event-stream     → replays the ring past Last-Event-ID / ?since=, then streams;
 *                                        a ": ping" comment every heartbeatMs keeps proxies from closing it
 *   GET  (anything else)               → the ring as JSON { seq, events }
 */
import { parseCursor, parseRelayBody, sseFrame, type RelayStore } from "./relay-store";

export const HEARTBEAT_MS = 15_000;

export function createRelayHandlers(store: RelayStore, heartbeatMs = HEARTBEAT_MS) {
  async function POST(request: Request): Promise<Response> {
    let body: unknown;
    try { body = await request.json(); } catch { return Response.json({ error: "Body must be JSON." }, { status: 400 }); }
    const parsed = parseRelayBody(body);
    if (!parsed) return Response.json({ error: "Body needs a string `type`." }, { status: 400 });
    return Response.json(store.append(parsed.type, parsed.payload), { status: 202 });
  }

  function GET(request: Request): Response {
    const url = new URL(request.url);
    const cursor = parseCursor(request.headers.get("last-event-id") ?? url.searchParams.get("since"));
    const wantsStream = (request.headers.get("accept") ?? "").includes("text/event-stream");
    if (!wantsStream) return Response.json({ seq: store.seq, events: store.since(cursor) }, { headers: { "Cache-Control": "no-store" } });

    const enc = new TextEncoder();
    let stop: (() => void) | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (s: string) => { try { controller.enqueue(enc.encode(s)); } catch { stop?.(); } };
        send(`retry: 1000\n: relay seq ${store.seq}\n\n`);
        for (const ev of store.since(cursor)) send(sseFrame(ev));
        const unsub = store.subscribe((ev) => send(sseFrame(ev)));
        const beat = setInterval(() => send(": ping\n\n"), heartbeatMs);
        let closed = false;
        stop = () => { if (closed) return; closed = true; unsub(); clearInterval(beat); try { controller.close(); } catch { /* already closed */ } };
        request.signal?.addEventListener("abort", () => stop?.());
      },
      cancel() { stop?.(); },
    });
    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" },
    });
  }

  return { GET, POST };
}
