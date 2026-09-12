/**
 * tell_team → Slack bridge.
 *
 * The voice agent's `tell_team` writes to Ambiguous AI from the Next app. When
 * Slack is configured, that route also POSTs the same message here, and this
 * process posts it into the Slack thread the bot lives in.
 *
 * What the Channels SDK allows (verified against @copilotkit/channels 0.9.2 and
 * the managed-delivery fixture in bridge.test.tsx):
 *
 *   - `thread.post()` exists only on the Thread handed to an inbound handler.
 *   - Managed delivery closes that Thread's operations the moment the turn's
 *     terminal packet is sent — a captured handle throws
 *     `ChannelDeliveryOperationsClosedError` afterwards.
 *   - `thread.subscribe()` is documented as "Proactive delivery to subscribed
 *     conversations is not yet wired."
 *
 * So there is no proactive post. The closest supported behaviour is what this
 * does: queue in memory, and flush the queue into the live thread at the start
 * of the next inbound turn (a mention, or any message in a subscribed
 * conversation). Delivery is "next turn", not "now"; the README says so.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { Context, Markdown, Message, Section, type Thread } from "@copilotkit/channels";
import { z } from "zod";

export const teamPostSchema = z.object({
  content: z.string().trim().min(1).max(4000),
  ambiguousUrl: z.string().url().optional(),
  /** ISO timestamp of the original tell_team, so a late flush still reads honestly. */
  at: z.string().optional(),
});
export type TeamPost = z.infer<typeof teamPostSchema>;

export const DEFAULT_BRIDGE_PORT = 3777;
const MAX_QUEUE = 100;
const MAX_BODY_BYTES = 64 * 1024;

/** The Slack rendering of one voice-agent team message. */
export function teamPostMessage(post: TeamPost) {
  const stamp = post.at ? ` · ${post.at}` : "";
  return (
    <Message>
      <Section>
        <Markdown>{post.content}</Markdown>
      </Section>
      <Context>{`Sent by voice via tell_team${stamp}`}</Context>
      {post.ambiguousUrl && (
        <Section>
          <Markdown>{`<${post.ambiguousUrl}|Open in Ambiguous>`}</Markdown>
        </Section>
      )}
    </Message>
  );
}

export class TellTeamBridge {
  private readonly queue: TeamPost[] = [];
  private server?: Server;

  constructor(private readonly log: (line: string) => void = console.log) {}

  get pending(): number {
    return this.queue.length;
  }

  /** Accept one message. Oldest is dropped past MAX_QUEUE so a dead Slack cannot grow memory forever. */
  enqueue(post: TeamPost): number {
    const parsed = teamPostSchema.parse(post);
    this.queue.push(parsed);
    if (this.queue.length > MAX_QUEUE) this.queue.shift();
    return this.queue.length;
  }

  /**
   * Post everything queued into a LIVE thread — call this from inside an inbound
   * handler, before `runAgent`. Stops at the first failure and keeps the rest
   * queued; never throws, so a Slack hiccup cannot take the agent turn down.
   * Returns how many were posted.
   */
  async flush(thread: Pick<Thread, "post">): Promise<number> {
    let posted = 0;
    while (this.queue.length > 0) {
      const next = this.queue[0];
      try {
        // TODO(channels-sdk): replace with the proactive-delivery API once
        // `thread.subscribe()` stops saying "not yet wired". This is the single
        // place a queued tell_team reaches Slack.
        await thread.post(teamPostMessage(next));
      } catch (error) {
        this.log(`[tell_team bridge] post failed, ${this.queue.length} left queued: ${String(error)}`);
        break;
      }
      this.queue.shift();
      posted += 1;
    }
    return posted;
  }

  /** Loopback-only HTTP listener. Resolves with the bound port (useful when `port` is 0). */
  listen(port = DEFAULT_BRIDGE_PORT, host = "127.0.0.1"): Promise<number> {
    const server = createServer(async (req, res) => {
      const reply = (status: number, body: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      const url = new URL(req.url ?? "/", "http://bridge");
      if (req.method === "GET" && url.pathname === "/health") {
        return reply(200, { ok: true, pending: this.queue.length });
      }
      if (req.method !== "POST" || url.pathname !== "/enqueue") {
        return reply(404, { error: "Not found" });
      }
      let body: unknown;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return reply(400, { error: "Body must be JSON" });
      }
      const parsed = teamPostSchema.safeParse(body);
      if (!parsed.success) {
        return reply(400, { error: "Expected { content, ambiguousUrl?, at? }", issues: parsed.error.issues });
      }
      const pending = this.enqueue(parsed.data);
      // 202, not 200: accepted for delivery on the bot's next inbound Slack turn.
      return reply(202, { queued: true, pending, delivery: "next-turn" });
    });
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        const address = server.address();
        resolve(typeof address === "object" && address ? address.port : port);
      });
    });
  }

  close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return Promise.resolve();
    return new Promise((resolve) => server.close(() => resolve()));
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** The one bridge this process runs; channel.tsx flushes it, server.ts listens on it. */
export const tellTeamBridge = new TellTeamBridge();
