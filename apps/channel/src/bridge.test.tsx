import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { createChannel, type Thread } from "@copilotkit/channels";
import { startChannelsWithGatewayControl } from "@copilotkit/channels-intelligence";
import { TellTeamBridge, teamPostMessage } from "./bridge";
import { ManagedGateway, preparedDelivery } from "./testing/managed-gateway";

const post = { content: "Retry policy is fixed, deploying now", ambiguousUrl: "https://app.ambiguous.ai/channels/abc" };

async function withBridge(fn: (bridge: TellTeamBridge, base: string) => Promise<void>) {
  const bridge = new TellTeamBridge(() => {});
  const port = await bridge.listen(0);
  try {
    await fn(bridge, `http://127.0.0.1:${port}`);
  } finally {
    await bridge.close();
  }
}

describe("tell_team bridge listener", () => {
  it("accepts /enqueue and reports next-turn delivery", async () => {
    await withBridge(async (bridge, base) => {
      const r = await fetch(`${base}/enqueue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(post),
      });
      assert.equal(r.status, 202);
      assert.deepEqual(await r.json(), { queued: true, pending: 1, delivery: "next-turn" });
      assert.equal(bridge.pending, 1);
      const health = await (await fetch(`${base}/health`)).json();
      assert.deepEqual(health, { ok: true, pending: 1 });
    });
  });

  it("rejects bad bodies and unknown routes without queueing", async () => {
    await withBridge(async (bridge, base) => {
      const notJson = await fetch(`${base}/enqueue`, { method: "POST", body: "nope" });
      assert.equal(notJson.status, 400);
      const empty = await fetch(`${base}/enqueue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "   " }),
      });
      assert.equal(empty.status, 400);
      const elsewhere = await fetch(`${base}/other`, { method: "POST", body: "{}" });
      assert.equal(elsewhere.status, 404);
      assert.equal(bridge.pending, 0);
    });
  });
});

describe("tell_team bridge flush", () => {
  it("posts queued messages into a live thread in order and drains the queue", async () => {
    const bridge = new TellTeamBridge(() => {});
    bridge.enqueue({ content: "first" });
    bridge.enqueue({ content: "second", ambiguousUrl: post.ambiguousUrl });
    const postFn = mock.fn(async (_ui: unknown) => ({ id: "m1" }));
    const thread = { post: postFn } as unknown as Pick<Thread, "post">;
    assert.equal(await bridge.flush(thread), 2);
    assert.equal(postFn.mock.callCount(), 2);
    assert.equal(bridge.pending, 0);
    const rendered = JSON.stringify(postFn.mock.calls[1].arguments[0]);
    assert.match(rendered, /second/);
    assert.match(rendered, /Open in Ambiguous/);
    assert.match(rendered, /tell_team/);
  });

  it("keeps the remainder queued when a post fails and never throws", async () => {
    const bridge = new TellTeamBridge(() => {});
    bridge.enqueue({ content: "a" });
    bridge.enqueue({ content: "b" });
    const thread = {
      post: mock.fn(async () => {
        throw new Error("slack down");
      }),
    } as unknown as Pick<Thread, "post">;
    assert.equal(await bridge.flush(thread), 0);
    assert.equal(bridge.pending, 2);
  });

  it("renders the Ambiguous link only when present", () => {
    assert.doesNotMatch(JSON.stringify(teamPostMessage({ content: "x" })), /Open in Ambiguous/);
  });
});

/** Drive the SDK's own managed-delivery fixture, the same way delivery.test.tsx does. */
async function managedTurn(onTurn: (thread: Thread) => Promise<void>) {
  const gateway = new ManagedGateway();
  const channel = createChannel({ name: "support", identifyUser: "platform" });
  let failure: unknown;
  channel.onMessage(async ({ thread }) => {
    try {
      await onTurn(thread as unknown as Thread);
    } catch (error) {
      failure = error;
      throw error;
    }
  });
  const handle = await startChannelsWithGatewayControl([channel], {
    session: gateway,
    scope: { projectId: 1, channelName: "support" },
    runtimeInstanceId: "rti_bridge",
    runCanonical: async (args) => args.execute({}),
    loadHistory: async () => [],
  });
  try {
    await gateway.deliver(preparedDelivery("bridge0001", "slack", { kind: "text", text: "status?" }));
  } finally {
    await handle.stop();
  }
  return { failure, payloads: gateway.packets.map(({ payload }) => payload) };
}

describe("tell_team bridge against managed delivery", () => {
  it("lands a queued tell_team as a native Slack message on the next inbound turn", { timeout: 10_000 }, async () => {
    const bridge = new TellTeamBridge(() => {});
    bridge.enqueue(post);
    const { failure, payloads } = await managedTurn(async (thread) => {
      assert.equal(await bridge.flush(thread), 1);
    });
    assert.equal(failure, undefined);
    const created = payloads.filter((p) => p.kind === "slack.message.create");
    assert.equal(created.length, 1);
    assert.match(JSON.stringify(created[0]), /Retry policy is fixed/);
    assert.match(JSON.stringify(created[0]), /Open in Ambiguous/);
    assert.equal(payloads.at(-1)?.kind, "channel.delivery.terminal");
    assert.equal(bridge.pending, 0);
  });

  it("documents why delivery is next-turn: the SDK closes a Thread once its delivery ends", { timeout: 10_000 }, async () => {
    let captured: Thread | undefined;
    const { payloads } = await managedTurn(async (thread) => {
      captured = thread;
    });
    assert.ok(captured);
    const bridge = new TellTeamBridge(() => {});
    bridge.enqueue({ content: "too late" });
    assert.equal(await bridge.flush(captured), 0, "a post after the terminal packet must not land");
    assert.equal(bridge.pending, 1, "the message stays queued for the next live turn");
    await assert.rejects(captured.post(teamPostMessage({ content: "direct" })), (error: unknown) =>
      error instanceof Error && error.name === "ChannelDeliveryOperationsClosedError",
    );
    assert.ok(!payloads.some((p) => p.kind === "slack.message.create"));
  });
});
