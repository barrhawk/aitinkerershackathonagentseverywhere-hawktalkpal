"use client";

/**
 * The voice agent's tools, registered on the CopilotKit agent for the
 * "HawkTalk ears + CopilotKit agent" mode. Same three tools as the realtime
 * providers, and the same page-level approval sheet and result cards: the page
 * hands in `gate` and `onResult`, so nothing here renders on its own.
 *
 * Generative UI: `workplace_record` is a component the agent draws after a
 * write, from the fields the tool handed back. Inside CopilotChat (the
 * companion page) it renders in the transcript; on the voice page, which has
 * no chat widget, `<AgentCards names={["workplace_record"]} />` draws it.
 */
import { useAgentContext, useComponent, useFrontendTool } from "@copilotkit/react-core/v2";
import { z } from "zod";

import { WorkplaceRecordCard, toWorkplaceRecord } from "./workplace-record";

export type WorkplaceResult = { ok: boolean; status: number; ms?: number; record: unknown };

async function workplace(action: string, body: Record<string, unknown>): Promise<WorkplaceResult> {
  const r = await fetch("/api/workplace", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...body }) });
  const d = (await r.json()) as { ok?: boolean; status?: number; data?: unknown; ms?: number; error?: string };
  return { ok: r.ok && d.ok !== false, status: d.status ?? r.status, ms: d.ms, record: d.data ?? d.error };
}

export function VoiceTools({ mode, gate, onResult }: {
  mode: string;
  gate: (name: string, args: Record<string, unknown>) => Promise<boolean>;
  onResult: (name: "note_it" | "tell_team", res: WorkplaceResult | { ok: false; status: 0; record: string }) => void;
}) {
  useAgentContext({
    description: "Voice mode for this session. The user is speaking, and your text reply is read aloud by HawkTalk.",
    value: {
      mode,
      rules: ["Reply in one or two sentences.", "Never read out URLs, ids or code; describe them.", "Before a workplace write, say what you will file in one sentence, then call note_it or tell_team; the user approves with a tap or by saying yes.", "If a tool reports an error, say so; never claim success without a record.", "After note_it or tell_team returns, call workplace_record with exactly the fields it returned (kind, title, id, url, ms, ok) and, in the same reply, tell the user in one sentence what happened.", "The user may start with a wake phrase such as 'hey hawk'; ignore it."],
    },
  });

  useFrontendTool({
    name: "search_web",
    description: "Search the live web for anything time-sensitive or factual.",
    parameters: z.object({ query: z.string(), results: z.number().optional() }),
    handler: async ({ query, results }) => {
      const r = await fetch("/api/search", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query, results }) });
      if (!r.ok) return "Search is unavailable right now. Say so rather than guessing.";
      return JSON.stringify(((await r.json()) as { results?: unknown }).results ?? []);
    },
  });

  const run = async (name: "note_it" | "tell_team", args: Record<string, unknown>) => {
    const ok = await gate(name, args);
    if (!ok) { onResult(name, { ok: false, status: 0, record: "declined by user" }); return "The user declined. Nothing was changed. Say so plainly."; }
    const res = await workplace(name, args);
    onResult(name, res);
    const record = JSON.stringify(toWorkplaceRecord(name, args, res));
    return res.ok ? `Done in ${res.ms ?? "?"} ms. Now call workplace_record with ${record}` : `Failed with HTTP ${res.status}: ${JSON.stringify(res.record).slice(0, 200)}. Now call workplace_record with ${record}`;
  };

  useFrontendTool({
    name: "note_it",
    description: "Create a document in the user's Ambiguous AI workspace. The user approves before it is written.",
    parameters: z.object({ title: z.string(), content: z.string() }),
    handler: (a) => run("note_it", a),
  }, [gate, onResult]);

  useFrontendTool({
    name: "tell_team",
    description: "Post a message to the team's Ambiguous AI chat channel. The user approves before it is posted.",
    parameters: z.object({ content: z.string() }),
    handler: (a) => run("tell_team", a),
  }, [gate, onResult]);

  useComponent({
    name: "workplace_record",
    description: "Show the user the record a workplace write produced. Call it once after every note_it or tell_team, with the fields from that tool's result.",
    parameters: z.object({
      kind: z.enum(["doc", "message"]),
      title: z.string().optional(),
      id: z.string(),
      url: z.string().optional(),
      ms: z.number().optional(),
      ok: z.boolean(),
    }),
    render: WorkplaceRecordCard,
    followUp: false,
  });

  return null;
}
