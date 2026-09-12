import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Server } from "node:http";
import { enqueueTeamPost, slackBridgeConfigured, slackBridgeUrl } from "./slack-bridge";

/** A stand-in for apps/channel's bridge: records bodies, answers 202 (or hangs). */
async function mockBridge(mode: "accept" | "hang" | "reject" = "accept") {
  const bodies: unknown[] = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
    req.on("end", () => {
      bodies.push({ method: req.method, url: req.url, body: JSON.parse(raw) });
      if (mode === "hang") return; // never answers; the client must time out
      res.writeHead(mode === "accept" ? 202 : 500, { "Content-Type": "application/json" });
      res.end(JSON.stringify(mode === "accept" ? { queued: true, pending: 1, delivery: "next-turn" } : { error: "boom" }));
    });
  });
  const port = await new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      resolve(typeof a === "object" && a ? a.port : 0);
    }),
  );
  return {
    bodies,
    env: { INTELLIGENCE_API_KEY: "cpk-1_test", CHANNEL_CODE: "voice-bot", CHANNEL_BRIDGE_PORT: String(port) },
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

const post = { content: "Deploy is green", ambiguousUrl: "https://app.ambiguous.ai/channels/x" };

test("disabled when Slack credentials are absent, and nothing is sent", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => { calls += 1; return new Response("{}", { status: 202 }); };
  assert.equal(await enqueueTeamPost(post, { env: {}, fetchImpl }), "disabled");
  assert.equal(await enqueueTeamPost(post, { env: { CHANNEL_CODE: "only-one" }, fetchImpl }), "disabled");
  assert.equal(calls, 0);
  assert.equal(slackBridgeConfigured({}), false);
  assert.equal(slackBridgeConfigured({ INTELLIGENCE_API_KEY: "k", CHANNEL_CODE: "c" }), true);
});

test("queued when the bridge accepts, with the exact payload", async () => {
  const bridge = await mockBridge("accept");
  try {
    assert.equal(await enqueueTeamPost(post, { env: bridge.env }), "queued");
    assert.deepEqual(bridge.bodies, [{ method: "POST", url: "/enqueue", body: post }]);
  } finally {
    await bridge.close();
  }
});

test("error when the bridge rejects, is absent, or does not answer within the timeout", async () => {
  const rejecting = await mockBridge("reject");
  try {
    assert.equal(await enqueueTeamPost(post, { env: rejecting.env }), "error");
  } finally {
    await rejecting.close();
  }
  // Port is now closed: connection refused must still resolve, never throw.
  assert.equal(await enqueueTeamPost(post, { env: rejecting.env }), "error");

  const hanging = await mockBridge("hang");
  try {
    const t0 = Date.now();
    assert.equal(await enqueueTeamPost(post, { env: hanging.env, timeoutMs: 100 }), "error");
    assert.ok(Date.now() - t0 < 1500, "must give up at the timeout, not wait on the socket");
  } finally {
    await hanging.close();
  }
});

test("bridge URL defaults to loopback :3777 and honours CHANNEL_BRIDGE_PORT", () => {
  assert.equal(slackBridgeUrl({}), "http://127.0.0.1:3777/enqueue");
  assert.equal(slackBridgeUrl({ CHANNEL_BRIDGE_PORT: "4100" }), "http://127.0.0.1:4100/enqueue");
  assert.equal(slackBridgeUrl({ CHANNEL_BRIDGE_PORT: "nope" }), "http://127.0.0.1:3777/enqueue");
});
