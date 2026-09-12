/**
 * The relay: an in-memory ring of what the phone is doing, so a laptop can
 * watch along. The voice page POSTs events; the companion page tails them
 * over SSE. Pure state and formatting live here so they can be tested with
 * plain node --test; the Next route in app/api/relay is a thin wrapper.
 *
 * Single-instance by design: the ring lives in this process. Fine for the dev
 * server and a laptop on the same LAN; a multi-instance deploy would need a
 * shared store. The ring is pinned to globalThis so Next's dev hot reload,
 * which re-evaluates route modules, does not empty it mid-demo.
 */

export type RelayEvent = { seq: number; serverTs: number; type: string; payload: Record<string, unknown> };
export type RelayStore = {
  append(type: string, payload: Record<string, unknown>): RelayEvent;
  /** Events with seq greater than `seq` (0 = everything still in the ring). */
  since(seq: number): RelayEvent[];
  subscribe(fn: (ev: RelayEvent) => void): () => void;
  readonly seq: number;
  readonly size: number;
};

export const RING_SIZE = 200;

export function createRelayStore(limit = RING_SIZE, now: () => number = Date.now): RelayStore {
  const ring: RelayEvent[] = [];
  const subs = new Set<(ev: RelayEvent) => void>();
  let seq = 0;
  return {
    append(type, payload) {
      const ev: RelayEvent = { seq: ++seq, serverTs: now(), type, payload };
      ring.push(ev);
      if (ring.length > limit) ring.splice(0, ring.length - limit);
      for (const fn of subs) { try { fn(ev); } catch { /* a dead subscriber never blocks the rest */ } }
      return ev;
    },
    since(from) { return ring.filter((e) => e.seq > from); },
    subscribe(fn) { subs.add(fn); return () => { subs.delete(fn); }; },
    get seq() { return seq; },
    get size() { return ring.length; },
  };
}

/**
 * One SSE frame. `id:` carries the seq so a reconnecting EventSource resumes
 * with Last-Event-ID. Deliberately no `event:` line: the type rides inside the
 * data so every frame lands on `onmessage`, and a relay type named "error"
 * can never collide with EventSource's own error event.
 */
export function sseFrame(ev: RelayEvent): string {
  return `id: ${ev.seq}\ndata: ${JSON.stringify(ev)}\n\n`;
}

/** Normalise a POST body into (type, payload); anything without a string `type` is rejected. */
export function parseRelayBody(body: unknown): { type: string; payload: Record<string, unknown> } | undefined {
  if (!body || typeof body !== "object") return undefined;
  const { type, ...rest } = body as Record<string, unknown>;
  if (typeof type !== "string" || !type.trim()) return undefined;
  return { type: type.trim(), payload: rest };
}

/** Parse a resume cursor from Last-Event-ID or ?since=; garbage means "from the start". */
export function parseCursor(raw: string | null | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

const KEY = "__hawkRelayStore";
export function globalRelayStore(): RelayStore {
  const g = globalThis as typeof globalThis & { [KEY]?: RelayStore };
  if (!g[KEY]) g[KEY] = createRelayStore();
  return g[KEY];
}
