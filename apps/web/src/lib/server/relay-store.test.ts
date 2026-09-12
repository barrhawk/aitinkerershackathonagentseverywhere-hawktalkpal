import assert from "node:assert/strict";
import test from "node:test";
import { createRelayStore, parseCursor, parseRelayBody, sseFrame } from "./relay-store";
import { createRelayHandlers } from "./relay-http";

test("ring keeps the last N events with monotonic seq and a server timestamp", () => {
  let t = 1000;
  const store = createRelayStore(3, () => t++);
  for (let i = 1; i <= 5; i++) store.append("transcript", { i });
  assert.equal(store.seq, 5);
  assert.equal(store.size, 3);
  assert.deepEqual(store.since(0).map((e) => e.seq), [3, 4, 5]);
  assert.deepEqual(store.since(4).map((e) => e.payload), [{ i: 5 }]);
  assert.deepEqual(store.since(0).map((e) => e.serverTs), [1002, 1003, 1004]);
});

test("subscribers see every append and a throwing subscriber does not block the rest", () => {
  const store = createRelayStore();
  const seen: number[] = [];
  const off = store.subscribe(() => { throw new Error("dead"); });
  store.subscribe((e) => seen.push(e.seq));
  store.append("a", {}); off(); store.append("b", {});
  assert.deepEqual(seen, [1, 2]);
});

test("body and cursor parsing", () => {
  assert.deepEqual(parseRelayBody({ type: " latency ", provider: "hawktalk", firstAudio: 812 }), { type: "latency", payload: { provider: "hawktalk", firstAudio: 812 } });
  assert.equal(parseRelayBody({ provider: "x" }), undefined);
  assert.equal(parseRelayBody("nope"), undefined);
  assert.equal(parseCursor("7"), 7);
  assert.equal(parseCursor("junk"), 0);
  assert.equal(parseCursor(null), 0);
  assert.equal(parseCursor("-2"), 0);
});

test("sse frame carries the seq as id and the event as data", () => {
  const f = sseFrame({ seq: 9, serverTs: 1, type: "reply", payload: { text: "hi" } });
  assert.equal(f, 'id: 9\ndata: {"seq":9,"serverTs":1,"type":"reply","payload":{"text":"hi"}}\n\n');
});

test("POST appends, plain GET returns the ring as JSON, bad bodies are 400", async () => {
  const store = createRelayStore();
  const { GET, POST } = createRelayHandlers(store);
  const post = (body: unknown) => POST(new Request("http://x/api/relay", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
  let r = await post({ type: "stack", provider: "hawktalk", status: "live" });
  assert.equal(r.status, 202);
  assert.equal(((await r.json()) as { seq: number }).seq, 1);
  await post({ type: "transcript", role: "user", text: "hey hawk" });
  r = await post({ nope: 1 }); assert.equal(r.status, 400);
  r = await POST(new Request("http://x/api/relay", { method: "POST", body: "{" })); assert.equal(r.status, 400);

  const j = (await GET(new Request("http://x/api/relay")).json()) as { seq: number; events: Array<{ type: string }> };
  assert.equal(j.seq, 2);
  assert.deepEqual(j.events.map((e) => e.type), ["stack", "transcript"]);
  const s = (await GET(new Request("http://x/api/relay?since=1")).json()) as { events: Array<{ seq: number }> };
  assert.deepEqual(s.events.map((e) => e.seq), [2]);
});

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, needle: string, budgetMs = 2000): Promise<string> {
  const dec = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + budgetMs;
  while (!buf.includes(needle)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${JSON.stringify(needle)}; got ${JSON.stringify(buf)}`);
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
  }
  return buf;
}

test("GET with Accept: text/event-stream replays past Last-Event-ID, streams new events, heartbeats, and unsubscribes on abort", async () => {
  const store = createRelayStore();
  const { GET } = createRelayHandlers(store, 30);
  store.append("stack", { provider: "openai" });
  store.append("transcript", { text: "one" });
  const ac = new AbortController();
  const res = GET(new Request("http://x/api/relay", { headers: { Accept: "text/event-stream", "Last-Event-ID": "1" }, signal: ac.signal }));
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
  const reader = res.body!.getReader();
  let buf = await readUntil(reader, "id: 2\n");
  assert.ok(!buf.includes("id: 1\n"), "seq 1 is before the cursor and must not be replayed");
  store.append("reply", { text: "two" });
  buf = await readUntil(reader, "id: 3\n");
  assert.match(buf, /id: 3\ndata: .*"type":"reply".*"text":"two"/);
  buf = await readUntil(reader, ": ping");
  ac.abort();
  const { done } = await reader.read().catch(() => ({ done: true }));
  assert.equal(done, true);
  // The dead stream is gone from the subscriber set: a later append must not throw or leak.
  store.append("after", {});
});
