"use client";

/**
 * Companion — the laptop view of a phone voice session.
 *
 * The voice page (/voice) mirrors everything it does to /api/relay; this page
 * tails that ring over SSE and lays it out for a screen across the room:
 * conversation and tool/approval/result cards on the left, a latency board on
 * the right, the live stack in the header. EventSource reconnects on its own
 * and resumes from Last-Event-ID, so a dropped proxy costs nothing.
 *
 * A collapsible CopilotChat (same "default" agent) takes typed follow-ups, and
 * the same three tools are mounted here with a gate that renders an
 * approve/decline card, so note_it / tell_team work from the laptop too.
 * The last few relay events ride along as agent context, so a typed question
 * can refer to what the phone just said without sharing a thread.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CopilotChat, useAgentContext } from "@copilotkit/react-core/v2";
import { VoiceTools } from "@/components/voice-tools";
import "./companion.css";

type RelayEvent = { seq: number; serverTs: number; type: string; payload: Record<string, unknown> };
type Conn = "connecting" | "live" | "reconnecting";
type Pending = { id: number; name: string; args: Record<string, unknown>; resolve: (ok: boolean) => void };
type Provider = "openai" | "hawktalk" | "copilot";

const PROVIDERS: Provider[] = ["hawktalk", "openai", "copilot"];
const stackName = (p: unknown) => (p === "openai" ? "OpenAI Realtime" : p === "copilot" ? "HawkTalk ears + CopilotKit" : p === "hawktalk" ? "HawkTalk" : "—");
const str = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v));
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const clock = (ts: number) => new Date(ts).toLocaleTimeString([], { hour12: false });

/** Same fire-and-forget mirror the phone uses, so laptop-side tool activity lands in the same timeline. */
const relay = (type: string, payload: Record<string, unknown> = {}) => {
  try { void fetch("/api/relay", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type, source: "companion", ...payload }), keepalive: true }).catch(() => undefined); }
  catch { /* offline */ }
};

export default function CompanionPage() {
  const [events, setEvents] = useState<RelayEvent[]>([]);
  const [conn, setConn] = useState<Conn>("connecting");
  const [pending, setPending] = useState<Pending[]>([]);
  const [chatOpen, setChatOpen] = useState(false);
  const pendingSeq = useRef(0);
  const feedRef = useRef<HTMLDivElement>(null);

  // ── relay subscription; EventSource reconnects by itself with Last-Event-ID ──
  useEffect(() => {
    let es: EventSource | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    const open = () => {
      if (closed) return;
      es = new EventSource("/api/relay");
      es.onopen = () => setConn("live");
      es.onerror = () => {
        setConn("reconnecting");
        // EventSource retries CLOSED connections only if it got that far; a hard close needs our own retry.
        if (es?.readyState === EventSource.CLOSED) { es.close(); timer = setTimeout(open, 1500); }
      };
      es.onmessage = (m) => {
        let ev: RelayEvent | undefined;
        try { ev = JSON.parse(m.data) as RelayEvent; } catch { return; }
        if (!ev || typeof ev.seq !== "number") return;
        setEvents((list) => (list.some((e) => e.seq === ev!.seq) ? list : [...list, ev!].slice(-400)));
      };
    };
    open();
    return () => { closed = true; es?.close(); if (timer) clearTimeout(timer); };
  }, []);
  useEffect(() => { const el = feedRef.current; if (el) el.scrollTop = el.scrollHeight; }, [events.length]);

  // ── derived boards ──────────────────────────────────────────────────────
  const stack = useMemo(() => [...events].reverse().find((e) => e.type === "stack"), [events]);
  const lat = useMemo(() => events.filter((e) => e.type === "latency"), [events]);
  const lastTurn = lat[lat.length - 1];
  const board = useMemo(() => PROVIDERS.map((p) => {
    const rows = lat.filter((e) => e.payload.provider === p);
    const mean = (k: "firstAudio" | "done") => { const v = rows.map((e) => num(e.payload[k])).filter((x): x is number => x !== undefined); return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : undefined; };
    return { p, n: rows.length, firstAudio: mean("firstAudio"), done: mean("done") };
  }), [lat]);
  const hk = board.find((b) => b.p === "hawktalk")?.firstAudio, oa = board.find((b) => b.p === "openai")?.firstAudio;
  const feed = useMemo(() => events.filter((e) => e.type !== "latency" && e.type !== "stack"), [events]);

  // The typed agent can see what the phone just did.
  useAgentContext({
    description: "Live voice session mirrored from the phone (most recent relay events, oldest first).",
    // Stringified once: relay payloads are JSON already, and the hook wants a JsonSerializable.
    value: JSON.stringify({ liveStack: stack ? { provider: str(stack.payload.provider), status: str(stack.payload.status) } : null, recent: events.slice(-20).map((e) => ({ at: clock(e.serverTs), type: e.type, ...e.payload })) }),
  });

  // ── approval gate for tools called from this page ───────────────────────
  const gate = useCallback((name: string, args: Record<string, unknown>) =>
    new Promise<boolean>((resolve) => {
      const id = ++pendingSeq.current;
      relay("tool_call", { name, args });
      const item: Pending = { id, name, args, resolve: (ok) => { setPending((q) => q.filter((x) => x.id !== id)); relay("approval", { name, ok }); resolve(ok); } };
      setPending((q) => [...q, item]);
    }), []);
  const onResult = useCallback((name: "note_it" | "tell_team", res: { ok: boolean; status?: number; ms?: number; record?: unknown }) => {
    const rec = res.record && typeof res.record === "object" ? (res.record as { id?: string; title?: string; url?: string; error?: string }) : undefined;
    relay("result", { name, ok: res.ok, status: res.status, ms: res.ms, id: rec?.id, title: rec?.title, url: rec?.url, error: rec?.error ?? (typeof res.record === "string" ? res.record : undefined) });
  }, []);

  const card = (e: RelayEvent) => {
    const p = e.payload;
    const t = clock(e.serverTs);
    switch (e.type) {
      case "transcript": return <div className="cp-msg" data-role="you"><span className="cp-t">{t}</span>{str(p.text)}</div>;
      case "reply": return <div className="cp-msg" data-role="agent"><span className="cp-t">{t}</span>{str(p.text)}</div>;
      case "tool_call": { const a = (p.args ?? {}) as Record<string, unknown>; return (
        <article className="cp-card" data-kind="tool"><h3>tool · {str(p.name)}{p.source === "companion" ? " · from laptop" : ""} <span className="cp-t">{t}</span></h3>
          <pre>{p.name === "search_web" ? str(a.query) : p.name === "note_it" ? `${str(a.title)}\n\n${str(a.content)}` : str(a.content ?? a)}</pre></article>); }
      case "approval": return <article className="cp-card" data-kind={p.ok ? "ok" : "no"}><h3>{p.ok ? "approved" : "declined"} · {str(p.name)} <span className="cp-t">{t}</span></h3></article>;
      case "result": { const ok = p.ok === true; const url = typeof p.url === "string" ? p.url : undefined; return (
        <article className="cp-card" data-kind={ok ? "ok" : "no"}>
          <h3>{p.name === "note_it" ? "Doc" : p.name === "tell_team" ? "Team message" : str(p.name)} {ok ? "created" : p.status === 0 ? "declined" : `failed (${str(p.status)})`}{num(p.ms) ? ` · ${num(p.ms)} ms` : ""} <span className="cp-t">{t}</span></h3>
          <div className="cp-sub">{[str(p.title), p.id ? `id ${str(p.id)}` : "", str(p.error)].filter(Boolean).join(" · ")}</div>
          {url && <a href={url} target="_blank" rel="noreferrer">Open in Ambiguous →</a>}
        </article>); }
      case "error": return <article className="cp-card" data-kind="no"><h3>error{p.provider ? ` · ${stackName(p.provider)}` : ""} <span className="cp-t">{t}</span></h3><div className="cp-sub">{str(p.message)}</div></article>;
      default: return <article className="cp-card"><h3>{e.type} <span className="cp-t">{t}</span></h3><pre>{JSON.stringify(p)}</pre></article>;
    }
  };

  return (
    <main className="cp">
      <header className="cp-top">
        <div>
          <div className="cp-brand">Agents, Everywhere · companion</div>
          <h1 className="cp-title">{stack && stack.payload.status !== "idle" ? stackName(stack.payload.provider) : "No stack live"}</h1>
        </div>
        <div className="cp-pills">
          {stack && <span className="cp-pill" data-s={str(stack.payload.status)}>{str(stack.payload.status)}</span>}
          <span className="cp-pill" data-s={conn === "live" ? "live" : "warn"}>relay {conn}</span>
          <span className="cp-pill">{events.length} events</span>
        </div>
      </header>

      <div className="cp-grid">
        <section className="cp-col" aria-label="conversation">
          <h2>Conversation</h2>
          <div className="cp-feed" ref={feedRef} aria-live="polite">
            {feed.length === 0 && <div className="cp-empty">Waiting for the phone. Open <code>/voice</code>, start a stack, and talk.</div>}
            {feed.map((e) => <div key={e.seq}>{card(e)}</div>)}
          </div>
          {pending.length > 0 && (
            <article className="cp-card cp-gate" role="dialog" aria-label="approval">
              <h3>{pending[0].name === "note_it" ? "Create this doc in Ambiguous?" : "Post this to the team?"}{pending.length > 1 ? ` (1 of ${pending.length})` : ""}</h3>
              <pre>{pending[0].name === "note_it" ? `${str(pending[0].args.title)}\n\n${str(pending[0].args.content)}` : str(pending[0].args.content)}</pre>
              <div className="cp-actions">
                <button type="button" className="cp-no" onClick={() => pending[0].resolve(false)}>Decline</button>
                <button type="button" className="cp-ok" onClick={() => pending[0].resolve(true)}>Approve</button>
              </div>
            </article>
          )}
        </section>

        <aside className="cp-col" aria-label="latency">
          <h2>Latency · end of speech → first sound</h2>
          <div className="cp-big" data-hot={lastTurn ? "1" : "0"}>
            <b>{lastTurn ? num(lastTurn.payload.firstAudio) ?? "–" : "–"}</b>
            <small>ms · last turn{lastTurn ? ` · ${stackName(lastTurn.payload.provider)}` : ""}{lastTurn && num(lastTurn.payload.done) !== undefined ? ` · done ${num(lastTurn.payload.done)} ms` : ""}</small>
          </div>
          <table className="cp-board">
            <thead><tr><th>stack</th><th>first sound</th><th>done</th><th>turns</th></tr></thead>
            <tbody>
              {board.map((b) => (
                <tr key={b.p} data-live={stack?.payload.provider === b.p && stack.payload.status === "live" ? "1" : "0"}>
                  <td>{stackName(b.p)}</td><td>{b.firstAudio ?? "–"}</td><td>{b.done ?? "–"}</td><td>{b.n}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {hk && oa && (
            <div className="cp-verdict" data-win={hk < oa ? "hawk" : "openai"}>
              {hk < oa ? `HawkTalk ${(oa / hk).toFixed(1)}× faster to first sound than OpenAI` : `OpenAI ${(hk / oa).toFixed(1)}× faster to first sound than HawkTalk`}
            </div>
          )}

          <details className="cp-panel" open={chatOpen} onToggle={(e) => setChatOpen((e.currentTarget as HTMLDetailsElement).open)}>
            <summary>Typed follow-ups · same agent, same tools</summary>
            <div className="cp-hint">Runs on the kit&apos;s CopilotKit runtime (needs OPENAI_API_KEY). Workplace writes ask for approval here, like on the phone.</div>
            <div className="cp-chatwrap">
              <CopilotChat agentId="default" className="cp-chat" labels={{ welcomeMessageText: "Ask about what the phone just did, or file a note.", chatInputPlaceholder: "Type a follow-up…" }} />
            </div>
          </details>
        </aside>
      </div>

      <VoiceTools mode="Laptop companion: the user is typing, not speaking; reply in text and keep it short." gate={gate} onResult={onResult} />
    </main>
  );
}
