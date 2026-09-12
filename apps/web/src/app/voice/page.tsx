"use client";

/**
 * In the room, A/B — the voice surface with two voice stacks behind one agent.
 *
 *   OpenAI Realtime  — the kit's WebRTC session (gpt-realtime), server VAD.
 *   HawkTalk         — a plain WebSocket to wss://hawktalk.ai/v1/realtime,
 *                      hold-to-talk, speech runs on HawkTalk's own silicon.
 *
 * Same prompt, same three tools, same approval gate, same transcript. The
 * page clocks each turn (end of speech → first audio → done) so the two can be
 * compared honestly, and every workplace write lands as a real Ambiguous AI
 * record that is shown back with its id.
 *
 * Built during the Agents, Everywhere hackathon (2026-09-12). Inherited from
 * the kit: the OpenAI session wiring, SYSTEM_PROMPT, and the Exa search route.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { RealtimeAgent, RealtimeSession, tool } from "@openai/agents/realtime";
import { z } from "zod";
import { SYSTEM_PROMPT, searchWebParameters } from "agent-core/shared";
import { REALTIME_MODEL } from "@/lib/realtime-config";
import { HawkTalkRealtime, type HawkTool } from "@/lib/hawktalk-realtime";

type Provider = "openai" | "hawktalk";
type Status = "idle" | "connecting" | "live" | "error";
type Turn = { provider: Provider; firstAudio?: number; done?: number; at: string };
type Pending = { name: string; args: Record<string, unknown>; resolve: (ok: boolean) => void };
type Result = { name: string; ok: boolean; status?: number; ms?: number; record?: unknown; at: string };

const VOICE_RULES = [
  SYSTEM_PROMPT,
  "",
  "You are speaking out loud. Rules for voice:",
  "- Answer in one or two sentences. Nobody wants a paragraph read to them.",
  "- Never read out a URL, an id, or a code block. Describe it instead.",
  "- You can act in the user's Ambiguous AI workspace with note_it (create a doc) and tell_team (post in chat).",
  "- Before any workplace write, say what you are about to file in one short sentence, then call the tool. The user approves it with a tap.",
  "- If a tool reports an error, say so plainly and do not pretend it worked.",
].join("\n");

const noteParams = { type: "object", properties: { title: { type: "string" }, content: { type: "string" } }, required: ["title", "content"], additionalProperties: false };
const tellParams = { type: "object", properties: { content: { type: "string" } }, required: ["content"], additionalProperties: false };

async function workplace(action: string, body: Record<string, unknown>) {
  const r = await fetch("/api/workplace", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...body }) });
  const data = (await r.json()) as { ok?: boolean; status?: number; data?: unknown; ms?: number; error?: string };
  return { ok: r.ok && data.ok !== false, status: data.status ?? r.status, ms: data.ms, record: data.data ?? data.error };
}
async function search(query: string, results?: number) {
  const r = await fetch("/api/search", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query, results }) });
  if (!r.ok) return "Search is unavailable right now. Say so rather than guessing.";
  const d = (await r.json()) as { results?: unknown };
  return JSON.stringify(d.results ?? []);
}

export default function VoicePage() {
  const [provider, setProvider] = useState<Provider>("hawktalk");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string>();
  const [lines, setLines] = useState<string[]>([]);
  const [live, setLive] = useState<{ role: string; text: string }>();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [pending, setPending] = useState<Pending>();
  const [results, setResults] = useState<Result[]>([]);
  const [holding, setHolding] = useState(false);
  const [level, setLevel] = useState(0);

  const oaRef = useRef<RealtimeSession | null>(null);
  const hawkRef = useRef<HawkTalkRealtime | null>(null);
  const clock = useRef<{ t0: number; got: boolean }>({ t0: 0, got: false });
  const turnRef = useRef<Turn | undefined>(undefined);

  const now = () => new Date().toLocaleTimeString();
  const pushTurn = useCallback((patch: Partial<Turn>) => {
    setTurns((ts) => {
      const cur = turnRef.current;
      if (!cur) return ts;
      const next = { ...cur, ...patch }; turnRef.current = next;
      const i = ts.findIndex((t) => t === cur);
      return i >= 0 ? [...ts.slice(0, i), next, ...ts.slice(i + 1)] : [...ts, next];
    });
  }, []);
  const openTurn = useCallback((p: Provider) => { turnRef.current = { provider: p, at: now() }; setTurns((ts) => [...ts, turnRef.current!]); }, []);

  /** The tap-to-approve gate, shared by both providers. */
  const gate = useCallback((name: string, args: Record<string, unknown>) =>
    new Promise<boolean>((resolve) => setPending({ name, args, resolve })), []);

  const runWorkplace = useCallback(async (name: "note_it" | "tell_team", args: Record<string, unknown>) => {
    const ok = await gate(name, args);
    setPending(undefined);
    if (!ok) { setResults((r) => [{ name, ok: false, status: 0, record: "declined by user", at: now() }, ...r]); return "The user declined. Do not retry unless asked."; }
    const res = await workplace(name, args);
    setResults((r) => [{ name, ...res, at: now() }, ...r]);
    return res.ok ? `Done. Record: ${JSON.stringify(res.record).slice(0, 400)}` : `Failed with HTTP ${res.status}: ${JSON.stringify(res.record).slice(0, 200)}`;
  }, [gate]);

  // ── OpenAI: the kit's WebRTC session ─────────────────────────────────────
  const connectOpenAI = useCallback(async () => {
    const searchTool = tool({ name: "search_web", description: "Search the live web for anything time-sensitive or factual.", parameters: searchWebParameters, execute: async ({ query, results }) => search(query, results) });
    const noteTool = tool({ name: "note_it", description: "Create a document in the user's Ambiguous AI workspace.", parameters: z.object({ title: z.string(), content: z.string() }), execute: async (a) => runWorkplace("note_it", a) });
    const tellTool = tool({ name: "tell_team", description: "Post a message to the team's Ambiguous AI chat channel.", parameters: z.object({ content: z.string() }), execute: async (a) => runWorkplace("tell_team", a) });
    const agent = new RealtimeAgent({ name: "Everywhere", instructions: VOICE_RULES, tools: [searchTool, noteTool, tellTool] });

    const r = await fetch("/api/realtime-token", { method: "POST" });
    const data = (await r.json()) as { value?: string; error?: string };
    if (!r.ok || !data.value) throw new Error(data.error ?? "Could not mint a session token.");
    const session = new RealtimeSession(agent, { transport: "webrtc", model: REALTIME_MODEL });
    session.on("history_updated", (history) => {
      const out = history.filter((it) => it.type === "message").map((it) => {
        const text = it.content.map((p) => ("transcript" in p ? p.transcript ?? "" : "text" in p ? p.text : "")).join(" ").trim();
        return text ? `${it.role === "user" ? "you" : "agent"}  ${text}` : "";
      }).filter(Boolean);
      setLines(out);
    });
    session.on("transport_event", (ev: { type?: string }) => {
      const t = ev.type ?? "";
      if (t === "input_audio_buffer.speech_stopped") { clock.current = { t0: performance.now(), got: false }; openTurn("openai"); }
      else if ((t === "response.output_audio.delta" || t === "response.audio.delta") && !clock.current.got && clock.current.t0) { clock.current.got = true; pushTurn({ firstAudio: Math.round(performance.now() - clock.current.t0) }); }
      else if (t === "response.done" && clock.current.t0) { pushTurn({ done: Math.round(performance.now() - clock.current.t0) }); clock.current.t0 = 0; }
    });
    session.on("error", (ev) => { setError(String((ev as { error?: unknown }).error ?? ev)); setStatus("error"); });
    await session.connect({ apiKey: data.value });
    oaRef.current = session;
  }, [openTurn, pushTurn, runWorkplace]);

  // ── HawkTalk: plain WebSocket, hold-to-talk ───────────────────────────────
  const connectHawk = useCallback(async () => {
    const r = await fetch("/api/hawktalk-config", { method: "POST" });
    const cfg = (await r.json()) as { endpoint?: string; key?: string; voice?: string; error?: string };
    if (!r.ok || !cfg.key || !cfg.endpoint) throw new Error(cfg.error ?? "No HawkTalk config.");
    const tools: HawkTool[] = [
      { name: "search_web", description: "Search the live web for anything time-sensitive or factual.", parameters: { type: "object", properties: { query: { type: "string" }, results: { type: "number" } }, required: ["query"] }, execute: async (a) => search(String(a.query ?? ""), typeof a.results === "number" ? a.results : undefined) },
      { name: "note_it", description: "Create a document in the user's Ambiguous AI workspace.", parameters: noteParams, execute: (a) => runWorkplace("note_it", a) },
      { name: "tell_team", description: "Post a message to the team's Ambiguous AI chat channel.", parameters: tellParams, execute: (a) => runWorkplace("tell_team", a) },
    ];
    const hawk = new HawkTalkRealtime(cfg.endpoint, cfg.key, VOICE_RULES, tools, {
      status: (s, d) => { if (s === "error") { setError(d); setStatus("error"); } else if (s === "live") setStatus("live"); },
      transcript: (role, text, final) => {
        if (final) { setLive(undefined); setLines((l) => [...l, `${role === "user" ? "you" : "agent"}  ${text}`]); }
        else setLive({ role, text });
      },
      latency: (ms) => { if (ms.firstAudio !== undefined) pushTurn({ firstAudio: Math.round(ms.firstAudio) }); if (ms.done !== undefined) pushTurn({ done: Math.round(ms.done) }); },
      level: (rms) => setLevel(rms),
    }, cfg.voice);
    await hawk.connect();
    hawkRef.current = hawk;
  }, [pushTurn, runWorkplace]);

  const connect = useCallback(async () => {
    setStatus("connecting"); setError(undefined); setLines([]); setLive(undefined);
    try { if (provider === "openai") await connectOpenAI(); else await connectHawk(); setStatus("live"); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setStatus("error"); }
  }, [provider, connectOpenAI, connectHawk]);

  const disconnect = useCallback(() => {
    oaRef.current?.close(); oaRef.current = null;
    hawkRef.current?.close(); hawkRef.current = null;
    setStatus("idle"); setHolding(false);
  }, []);
  useEffect(() => () => disconnect(), [disconnect]);

  const holdStart = () => { if (!hawkRef.current) return; setHolding(true); hawkRef.current.pressToTalk(); };
  const holdEnd = () => { if (!hawkRef.current || !holding) return; setHolding(false); openTurn("hawktalk"); hawkRef.current.release(); };

  const avg = (p: Provider, k: "firstAudio" | "done") => { const v = turns.filter((t) => t.provider === p && t[k] !== undefined).map((t) => t[k]!); return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : undefined; };

  return (
    <main className="ck-page">
      <p className="ck-eyebrow">In the room · A/B</p>
      <h1>Same agent. Two voices.</h1>
      <p className="ck-dek">
        One prompt, one set of tools, one approval gate. Flip the voice stack between <strong>OpenAI Realtime</strong> ({REALTIME_MODEL}, WebRTC)
        and <strong>HawkTalk</strong> (WebSocket, speech on its own silicon), and every turn is clocked from the end of your sentence to the first sound back.
        Workplace actions land in Ambiguous AI and are shown here with the record that came back.
      </p>

      <fieldset style={{ marginTop: "1.5rem", border: 0, padding: 0 }} disabled={status === "live" || status === "connecting"}>
        <label style={{ marginRight: "1.5rem" }}><input type="radio" name="p" checked={provider === "hawktalk"} onChange={() => setProvider("hawktalk")} /> HawkTalk</label>
        <label><input type="radio" name="p" checked={provider === "openai"} onChange={() => setProvider("openai")} /> OpenAI Realtime</label>
      </fieldset>

      <div className="ck-actions" style={{ marginTop: "1rem" }}>
        {status === "live" ? (
          <button type="button" className="ck-btn" onClick={disconnect}>End</button>
        ) : (
          <button type="button" className="ck-btn ck-btn--primary" onClick={connect} disabled={status === "connecting"}>
            {status === "connecting" ? "Connecting…" : `Start on ${provider === "openai" ? "OpenAI" : "HawkTalk"}`}
          </button>
        )}
        <span className="ck-status" data-status={status}>{status}</span>
      </div>

      {status === "live" && provider === "hawktalk" && (
        <button type="button" className="ck-btn ck-btn--primary"
          style={{ marginTop: "1rem", width: "100%", padding: "1.4rem", fontSize: "1.1rem", background: holding ? "#0a7" : undefined, touchAction: "none" }}
          onPointerDown={holdStart} onPointerUp={holdEnd} onPointerCancel={holdEnd} onPointerLeave={holdEnd}>
          {holding ? `Listening… ${"▮".repeat(Math.min(12, Math.round(level * 60)))}` : "Hold to talk"}
        </button>
      )}
      {status === "live" && provider === "openai" && (
        <p className="ck-dek" style={{ marginTop: "1rem" }}>Microphone open with server-side turn detection. Just talk.</p>
      )}

      {pending && (
        <article className="ck-card ck-card--gate" style={{ marginTop: "1.5rem" }}>
          <h3>Approve: {pending.name === "note_it" ? "create a doc" : "post to the team"}</h3>
          <pre className="ck-transcript">{JSON.stringify(pending.args, null, 2)}</pre>
          <div className="ck-actions">
            <button type="button" className="ck-btn ck-btn--primary" onClick={() => pending.resolve(true)}>Approve</button>
            <button type="button" className="ck-btn" onClick={() => pending.resolve(false)}>Decline</button>
          </div>
        </article>
      )}

      {error && (
        <article className="ck-card ck-card--gate" style={{ marginTop: "1.5rem" }}>
          <h3>Could not connect</h3><p>{error}</p>
          <p>{provider === "openai" ? <>Check <code>OPENAI_API_KEY</code> and Realtime access.</> : <>Check <code>HAWKTALK_API_KEY</code> and that the HawkTalk gateway is up.</>} Browsers need HTTPS or localhost for the microphone.</p>
        </article>
      )}

      {(lines.length > 0 || live) && (
        <section style={{ marginTop: "2rem" }}>
          <h2 style={{ fontSize: "1.05rem" }}>Transcript</h2>
          <pre className="ck-transcript">{[...lines, live ? `${live.role === "user" ? "you" : "agent"}  ${live.text} …` : ""].filter(Boolean).join("\n")}</pre>
        </section>
      )}

      {turns.length > 0 && (
        <section style={{ marginTop: "2rem" }}>
          <h2 style={{ fontSize: "1.05rem" }}>Latency, end of speech → first sound → done</h2>
          <div style={{ overflowX: "auto" }}>
            <table className="ck-table">
              <thead><tr><th>time</th><th>voice</th><th>first audio</th><th>done</th></tr></thead>
              <tbody>
                {turns.slice(-8).map((t, i) => (
                  <tr key={i}><td>{t.at}</td><td>{t.provider}</td><td>{t.firstAudio !== undefined ? `${t.firstAudio} ms` : "…"}</td><td>{t.done !== undefined ? `${t.done} ms` : "…"}</td></tr>
                ))}
                <tr><td colSpan={2}><strong>avg HawkTalk</strong></td><td>{avg("hawktalk", "firstAudio") ?? "–"} ms</td><td>{avg("hawktalk", "done") ?? "–"} ms</td></tr>
                <tr><td colSpan={2}><strong>avg OpenAI</strong></td><td>{avg("openai", "firstAudio") ?? "–"} ms</td><td>{avg("openai", "done") ?? "–"} ms</td></tr>
              </tbody>
            </table>
          </div>
        </section>
      )}

      {results.length > 0 && (
        <section style={{ marginTop: "2rem" }}>
          <h2 style={{ fontSize: "1.05rem" }}>Workplace actions (Ambiguous AI)</h2>
          {results.map((r, i) => (
            <article key={i} className="ck-card" style={{ marginTop: "0.75rem" }}>
              <h3>{r.name} — {r.ok ? "created" : `failed (${r.status})`}{r.ms ? ` · ${r.ms} ms` : ""}</h3>
              <pre className="ck-transcript" style={{ maxHeight: 160, overflow: "auto" }}>{typeof r.record === "string" ? r.record : JSON.stringify(r.record, null, 2)}</pre>
            </article>
          ))}
        </section>
      )}
    </main>
  );
}
