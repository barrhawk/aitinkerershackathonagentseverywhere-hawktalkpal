/**
 * Phone → laptop relay. The voice page POSTs what it is doing (transcripts,
 * tool calls, approvals, results, latency); the companion page tails it as SSE.
 *
 * Single-instance: the ring is in this process's memory (pinned to globalThis
 * so dev hot reload keeps it). See lib/server/relay-store.ts.
 */
import { createRelayHandlers } from "@/lib/server/relay-http";
import { globalRelayStore } from "@/lib/server/relay-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handlers = createRelayHandlers(globalRelayStore());
export const GET = handlers.GET;
export const POST = handlers.POST;
