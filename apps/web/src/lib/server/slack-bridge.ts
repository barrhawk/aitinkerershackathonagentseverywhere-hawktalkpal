/**
 * tell_team → Slack, from the Next side.
 *
 * The Ambiguous write is the action; Slack is a best-effort echo. This module
 * hands the message to the bridge inside apps/channel (see
 * apps/channel/src/bridge.tsx) over loopback and reports what happened. It
 * never throws and never takes longer than `timeoutMs`, so a dead or absent
 * bridge cannot fail or slow the workplace write.
 *
 *   "queued"   → the bridge accepted it; it posts on the bot's next Slack turn
 *   "disabled" → INTELLIGENCE_API_KEY / CHANNEL_CODE are not both set
 *   "error"    → configured, but the bridge did not accept it in time
 */
export type SlackBridgeStatus = "queued" | "disabled" | "error";

export type TeamPost = { content: string; ambiguousUrl?: string; at?: string };

type Env = Record<string, string | undefined>;

export const DEFAULT_BRIDGE_PORT = 3777;

export function slackBridgeConfigured(env: Env = process.env): boolean {
  return Boolean(env.INTELLIGENCE_API_KEY && env.CHANNEL_CODE);
}

export function slackBridgeUrl(env: Env = process.env): string {
  const port = Number(env.CHANNEL_BRIDGE_PORT ?? DEFAULT_BRIDGE_PORT);
  return `http://127.0.0.1:${Number.isFinite(port) && port > 0 ? port : DEFAULT_BRIDGE_PORT}/enqueue`;
}

export async function enqueueTeamPost(
  post: TeamPost,
  opts: { env?: Env; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<SlackBridgeStatus> {
  const env = opts.env ?? process.env;
  if (!slackBridgeConfigured(env)) return "disabled";
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const r = await doFetch(slackBridgeUrl(env), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(post),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 2000),
    });
    return r.ok ? "queued" : "error";
  } catch {
    return "error";
  }
}
