"use client";

/**
 * The voice agent's tools, registered into the CopilotKit agent so its
 * approval cards and results render as CopilotKit generative UI in the chat.
 * Same three tools as the realtime providers; same server routes behind them.
 */
import { useAgentContext, useFrontendTool, useHumanInTheLoop } from "@copilotkit/react-core/v2";
import { z } from "zod";

async function workplace(action: string, body: Record<string, unknown>) {
  const r = await fetch("/api/workplace", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...body }) });
  const d = (await r.json()) as { ok?: boolean; status?: number; data?: unknown; ms?: number; error?: string };
  const ok = r.ok && d.ok !== false;
  return ok ? `Done in ${d.ms ?? "?"} ms. Record: ${JSON.stringify(d.data).slice(0, 400)}` : `Failed with HTTP ${d.status ?? r.status}: ${JSON.stringify(d.data ?? d.error).slice(0, 200)}`;
}

function Gate({ title, detail, respond, result, action }: { title: string; detail: string; respond?: (s: string) => void; result?: unknown; action: () => Promise<string> }) {
  if (!respond) return <article className="ck-card ck-card--gate"><p className="ck-gate-done">{result ? String(result) : "Waiting…"}</p></article>;
  return (
    <article className="ck-card ck-card--gate">
      <h3>{title}</h3>
      <pre className="ck-transcript">{detail}</pre>
      <div className="ck-actions">
        <button type="button" className="ck-btn ck-btn--primary" onClick={async () => respond(await action())}>Approve</button>
        <button type="button" className="ck-btn" onClick={() => respond("The user declined. Nothing was changed. Say so plainly.")}>Decline</button>
      </div>
    </article>
  );
}

export function VoiceTools({ mode }: { mode: string }) {
  useAgentContext({
    description: "Voice mode for this session. The user is speaking, and your text reply is read aloud by HawkTalk.",
    value: {
      mode,
      rules: ["Reply in one or two sentences.", "Never read out URLs, ids or code; describe them.", "Before a workplace write, say what you will file in one sentence, then call note_it or tell_team; the user approves with a tap.", "If a tool reports an error, say so; never claim success without a record."],
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

  useHumanInTheLoop({
    name: "note_it",
    description: "Create a document in the user's Ambiguous AI workspace. The user approves with a tap before it is written.",
    parameters: z.object({ title: z.string(), content: z.string() }),
    render: ({ args, respond, result }) => (
      <Gate title="Create a doc in Ambiguous?" detail={`${args.title ?? ""}\n\n${args.content ?? ""}`} respond={respond} result={result}
        action={() => workplace("note_it", { title: args.title, content: args.content })} />
    ),
  });

  useHumanInTheLoop({
    name: "tell_team",
    description: "Post a message to the team's Ambiguous AI chat channel. The user approves with a tap before it is posted.",
    parameters: z.object({ content: z.string() }),
    render: ({ args, respond, result }) => (
      <Gate title="Post to the team channel?" detail={args.content ?? ""} respond={respond} result={result}
        action={() => workplace("tell_team", { content: args.content })} />
    ),
  });

  return null;
}
