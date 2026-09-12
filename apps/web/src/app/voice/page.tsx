"use client";

/**
 * In the room, A/B — the voice surface with two voice stacks behind one agent.
 *
 *   OpenAI Realtime  — the kit's WebRTC session (gpt-realtime), server VAD.
 *   HawkTalk         — a plain WebSocket to wss://hawktalk.ai/v1/realtime,
 *                      hold-to-talk, speech runs on HawkTalk's own silicon.
 *   HawkTalk + CopilotKit — HawkTalk is the ears and mouth (REST STT/TTS), the
 *                      kit's CopilotKit agent is the brain, and its approval
 *                      cards and results render as CopilotKit generative UI.
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
import { CopilotChat, useAgent } from "@copilotkit/react-core/v2";
import { VoiceTools } from "@/components/voice-tools";
import { TurnRecorder, transcribe, speak, unlockAudio } from "@/lib/hawk-rest";
import { WakeWord, Endpointer, wakeWordSupported } from "@/lib/wake-word";
import "./voice.css";

type Provider = "openai" | "hawktalk" | "copilot";
type Status = "idle" | "connecting" | "live" | "error";
type Turn = { provider: Provider; firstAudio?: number; done?: number; at: string };
type Pending = { id: number; name: string; args: Record<string, unknown>; resolve: (ok: boolean) => void };
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
  "- The user may start with a wake phrase such as 'hey hawk'. Ignore the wake phrase itself.",
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
  const [wakeOn, setWakeOn] = useState(false);
  const [wakePhrase, setWakePhrase] = useState("hey hawk");
  const [wakeState, setWakeState] = useState<string>();
  const wakeRef = useRef<WakeWord | null>(null);
  const endRef = useRef(new Endpointer());
  const wakeOnRef = useRef(false);
  useEffect(() => { try { const j = JSON.parse(localStorage.getItem("voice-ab") ?? "{}"); if (j.provider) setProvider(j.provider); if (typeof j.wakeOn === "boolean") setWakeOn(j.wakeOn); if (j.wakePhrase) setWakePhrase(j.wakePhrase); } catch { /* fresh browser */ } }, []);
  useEffect(() => { wakeOnRef.current = wakeOn; try { localStorage.setItem("voice-ab", JSON.stringify({ provider, wakeOn, wakePhrase })); } catch { /* private mode */ } }, [provider, wakeOn, wakePhrase]);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string>();
  const [lines, setLines] = useState<string[]>([]);
  const [live, setLive] = useState<{ role: string; text: string }>();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [pending, setPending] = useState<Pending[]>([]);
  const pendingSeq = useRef(0);
  const [results, setResults] = useState<Result[]>([]);
  const [holding, setHolding] = useState(false);
  const [level, setLevel] = useState(0);

  const oaRef = useRef<RealtimeSession | null>(null);
  const hawkRef = useRef<HawkTalkRealtime | null>(null);
  const recRef = useRef<TurnRecorder | null>(null);
  const { agent } = useAgent({ agentId: "default" });
  const [thinking, setThinking] = useState<string>();
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

  /** The tap-to-approve gate for the two realtime providers; the CopilotKit mode uses its own human-in-the-loop card. */
  const gate = useCallback((name: string, args: Record<string, unknown>) =>
    new Promise<boolean>((resolve) => {
      const id = ++pendingSeq.current;
      // One card per call: two tools in one turn ("note X and tell the team Y") must both get answered.
      setPending((q) => [...q, { id, name, args, resolve: (ok) => { setPending((q2) => q2.filter((x) => x.id !== id)); resolve(ok); } }]);
    }), []);

  const runWorkplace = useCallback(async (name: "note_it" | "tell_team", args: Record<string, unknown>) => {
    const ok = await gate(name, args);
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
      else if (t === "response.done" && clock.current.t0) { pushTurn({ done: Math.round(performance.now() - clock.current.t0) }); clock.current.t0 = 0; if (wakeOnRef.current) { session.mute(true); setWakeState(`listening for "${wakePhrase}"`); } }
    });
    session.on("error", (ev) => { setError(String((ev as { error?: unknown }).error ?? ev)); setStatus("error"); });
    await session.connect({ apiKey: data.value });
    if (wakeOnRef.current) session.mute(true);   // wake word opens the mic
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
      level: (rms) => { setLevel(rms); endRef.current.level(rms); },
    }, cfg.voice);
    await hawk.connect();
    hawkRef.current = hawk;
  }, [pushTurn, runWorkplace]);

  // ── HawkTalk ears + CopilotKit agent ─────────────────────────────────────
  const releaseAt = useRef(0);
  const unsubRef = useRef<{ unsubscribe: () => void } | null>(null);
  const connectCopilot = useCallback(async () => {
    const rec = new TurnRecorder(); rec.onLevel = (rms) => { setLevel(rms); endRef.current.level(rms); }; await rec.open(); recRef.current = rec;
    // Speak every assistant message the agent finishes, including the one it
    // produces after an approval card is answered (that is a second run the
    // page does not start itself). Deltas are accumulated per message id.
    const drafts = new Map<string, string>();
    const sub = {
      onTextMessageStartEvent: ({ event }: { event: { messageId: string } }) => { drafts.set(event.messageId, ""); },
      onTextMessageContentEvent: ({ event }: { event: { messageId: string; delta?: string } }) => { drafts.set(event.messageId, (drafts.get(event.messageId) ?? "") + (event.delta ?? "")); },
      onTextMessageEndEvent: async ({ event }: { event: { messageId: string } }) => {
        const reply = (drafts.get(event.messageId) ?? "").trim(); drafts.delete(event.messageId);
        if (!reply) return;
        setLines((l) => [...l, `agent  ${reply}`]);
        setThinking("speaking…");
        try {
          const started = await speak(reply);
          if (releaseAt.current) { const ms = Math.round(started - releaseAt.current); pushTurn({ firstAudio: ms, done: ms }); releaseAt.current = 0; }
        } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
        setThinking(undefined);
      },
    };
    unsubRef.current?.unsubscribe();
    unsubRef.current = agent.subscribe(sub as never);
  }, [agent, pushTurn]);
  const copilotTurn = useCallback(async (wav: Blob) => {
    releaseAt.current = performance.now();
    setThinking("transcribing…");
    const heard = await transcribe(wav);
    if (!heard.text) { setThinking(undefined); releaseAt.current = 0; return; }
    setLines((l) => [...l, `you  ${heard.text}`]);
    setThinking("thinking…");
    agent.addMessage({ id: crypto.randomUUID(), role: "user", content: heard.text });
    await agent.runAgent({});
    setThinking((t) => (t === "thinking…" ? undefined : t));
  }, [agent]);

  /** A wake phrase was heard: open a turn on whichever stack is live and let the endpointer close it. */
  const onWake = useCallback(() => {
    if (thinking || holding) return;
    unlockAudio();
    if (oaRef.current) { oaRef.current.mute(false); setWakeState("mic open — talk"); return; }   // server VAD ends the turn
    if (recRef.current) {
      const rec = recRef.current; rec.start(true); setHolding(true); setWakeState("listening…");
      endRef.current.begin(() => { setHolding(false); openTurn("copilot"); const wav = rec.stop(); setWakeState(`listening for "${wakePhrase}"`); copilotTurn(wav).catch((e) => { setError(e instanceof Error ? e.message : String(e)); setThinking(undefined); }); });
      return;
    }
    if (hawkRef.current) {
      const hawk = hawkRef.current; hawk.pressToTalk(true); setHolding(true); setWakeState("listening…");
      endRef.current.begin(() => { setHolding(false); openTurn("hawktalk"); hawk.release(); setWakeState(`listening for "${wakePhrase}"`); });
    }
  }, [thinking, holding, openTurn, copilotTurn, wakePhrase]);
  const onWakeRef = useRef(onWake); useEffect(() => { onWakeRef.current = onWake; }, [onWake]);

  useEffect(() => {
    if (status !== "live" || !wakeOn) { wakeRef.current?.stop(); wakeRef.current = null; if (status === "live" && oaRef.current) oaRef.current.mute(false); if (!wakeOn) setWakeState(undefined); return; }
    if (!wakeWordSupported()) { setWakeState("wake word needs Chrome (Android/desktop); use hold-to-talk"); return; }
    const w = new WakeWord(wakePhrase, () => onWakeRef.current(), setWakeState); wakeRef.current = w; w.start();
    if (oaRef.current) oaRef.current.mute(true);
    return () => { w.stop(); };
  }, [status, wakeOn, wakePhrase]);

  const connect = useCallback(async () => {
    setStatus("connecting"); setError(undefined); setLines([]); setLive(undefined);
    try { if (provider === "openai") await connectOpenAI(); else if (provider === "copilot") await connectCopilot(); else await connectHawk(); setStatus("live"); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setStatus("error"); }
  }, [provider, connectOpenAI, connectHawk, connectCopilot]);

  const disconnect = useCallback(() => {
    oaRef.current?.close(); oaRef.current = null;
    hawkRef.current?.close(); hawkRef.current = null;
    recRef.current?.close(); recRef.current = null;
    unsubRef.current?.unsubscribe(); unsubRef.current = null;
    setPending((q) => { q.forEach((x) => x.resolve(false)); return []; });
    endRef.current.cancel(); wakeRef.current?.stop(); wakeRef.current = null;
    setStatus("idle"); setHolding(false); setThinking(undefined);
  }, []);
  useEffect(() => () => disconnect(), [disconnect]);

  const holdStart = () => {
    unlockAudio();
    if (recRef.current) { if (thinking) return; setHolding(true); recRef.current.start(); return; }
    if (!hawkRef.current) return; setHolding(true); hawkRef.current.pressToTalk();
  };
  const holdEnd = () => {
    if (!holding) return; setHolding(false);
    if (recRef.current) { openTurn("copilot"); const wav = recRef.current.stop(); copilotTurn(wav).catch((e) => { setError(e instanceof Error ? e.message : String(e)); setThinking(undefined); }); return; }
    if (!hawkRef.current) return; openTurn("hawktalk"); hawkRef.current.release();
  };

  const avg = (p: Provider, k: "firstAudio" | "done") => { const v = turns.filter((t) => t.provider === p && t[k] !== undefined).map((t) => t[k]!); return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : undefined; };

  const stackName = (p: Provider) => (p === "openai" ? "OpenAI" : p === "copilot" ? "Hawk+CopilotKit" : "HawkTalk");
  const orbState = status !== "live" ? "off" : holding ? "hold" : thinking?.startsWith("speak") ? "speaking" : thinking ? "thinking" : provider === "openai" ? "open" : "idle";
  const orbLabel = status !== "live" ? "start first" : provider === "openai" ? (wakeOn && wakeState?.startsWith("listening for") ? "say the wake word" : "listening") : holding ? "release to send" : thinking ?? (wakeOn ? "hold or say it" : "hold to talk");
  const last = [...turns].reverse().find((t) => t.firstAudio !== undefined);
  const recordLine = (rec: unknown) => { const r = rec as { id?: string; title?: string; url?: string; error?: string } | string | null; if (!r || typeof r === "string") return String(r ?? ""); return [r.id ? `id ${r.id}` : "", r.title ?? "", r.error ?? ""].filter(Boolean).join(" · "); };
  const recordUrl = (rec: unknown) => { const r = rec as { url?: string; web_url?: string; link?: string } | null; return (r && (r.url || r.web_url || r.link)) || undefined; };

  return (
    <main className="va">
      <header className="va-top">
        <div>
          <div className="va-brand">Agents, Everywhere · in the room</div>
          <h1 className="va-title">Voice A/B</h1>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span className="va-pill" data-s={status}>{status}</span>
          {status === "live" && <button type="button" className="va-ghost" onClick={disconnect}>End</button>}
        </div>
      </header>

      <div className="va-seg" role="group" aria-label="voice stack">
        {(["hawktalk", "openai", "copilot"] as Provider[]).map((p) => (
          <button key={p} type="button" aria-pressed={provider === p} disabled={status === "live" || status === "connecting"} onClick={() => setProvider(p)}>
            {p === "hawktalk" ? "HawkTalk" : p === "openai" ? "OpenAI Realtime" : "HawkTalk ears + CopilotKit"}
          </button>
        ))}
      </div>

      <div className="va-row">
        <button type="button" className="va-chip" aria-pressed={wakeOn} onClick={() => setWakeOn(!wakeOn)}>◉ Wake word</button>
        <input className="va-input" type="text" value={wakePhrase} onChange={(e) => setWakePhrase(e.target.value)} disabled={!wakeOn} aria-label="wake phrase" />
      </div>
      {wakeState && <div className="va-hint" style={{ marginTop: 6 }}>{wakeState}</div>}

      <div className="va-stage">
        <button type="button" className="va-orb" data-state={orbState} disabled={status !== "live" || provider === "openai"}
          style={{ ["--lvl" as string]: `${Math.min(28, Math.round(level * 160))}px` }}
          onPointerDown={holdStart} onPointerUp={holdEnd} onPointerCancel={holdEnd} onPointerLeave={holdEnd} onContextMenu={(e) => e.preventDefault()}>
          {status !== "live" ? "—" : provider === "openai" ? "live" : holding ? "…" : "talk"}
        </button>
        <div className="va-state">{orbLabel}</div>
      </div>

      {status !== "live" && (
        <button type="button" className="va-primary" onClick={connect} disabled={status === "connecting"}>
          {status === "connecting" ? "Connecting…" : `Start on ${stackName(provider)}`}
        </button>
      )}

      {error && (
        <article className="va-card va-err">
          <h3>Could not connect</h3>
          <div className="va-hint">{error}</div>
          <div className="va-hint" style={{ marginTop: 6 }}>{provider === "openai" ? "Needs OPENAI_API_KEY with Realtime access." : "Needs HAWKTALK_API_KEY and the HawkTalk gateway up."} Mic needs HTTPS.</div>
        </article>
      )}

      <div className="va-stats">
        <div className="va-stat" data-hot={last ? "1" : "0"}><b>{last?.firstAudio ?? "–"}</b><small>last turn ms{last ? ` · ${stackName(last.provider)}` : ""}</small></div>
        <div className="va-stat"><b>{avg("hawktalk", "firstAudio") ?? "–"}</b><small>avg HawkTalk</small></div>
        <div className="va-stat"><b>{avg("openai", "firstAudio") ?? "–"}</b><small>avg OpenAI</small></div>
        <div className="va-stat"><b>{avg("copilot", "firstAudio") ?? "–"}</b><small>avg Hawk+CK</small></div>
      </div>

      {(lines.length > 0 || live) && (
        <section className="va-sec">
          <h2>Conversation</h2>
          <div className="va-chat">
            {lines.map((l, i) => { const role = l.startsWith("you") ? "you" : "agent"; return <div key={i} className="va-msg" data-role={role}>{l.replace(/^(you|agent)\s+/, "")}</div>; })}
            {live && <div className="va-msg" data-role={live.role === "user" ? "you" : "agent"} data-live="1">{live.text}…</div>}
          </div>
        </section>
      )}

      {results.length > 0 && (
        <section className="va-sec">
          <h2>Workplace actions · Ambiguous AI</h2>
          {results.map((r, i) => (
            <article key={i} className="va-card" data-ok={r.ok ? "1" : "0"}>
              <h3>{r.name === "note_it" ? "Doc created" : "Team message"}{r.ok ? "" : ` failed (${r.status})`}{r.ms ? ` · ${r.ms} ms` : ""} <span className="va-hint">{r.at}</span></h3>
              <div className="va-hint">{recordLine(r.record)}</div>
              {recordUrl(r.record) && <a href={recordUrl(r.record)} target="_blank" rel="noreferrer">Open in Ambiguous</a>}
              <pre>{typeof r.record === "string" ? r.record : JSON.stringify(r.record, null, 2)}</pre>
            </article>
          ))}
        </section>
      )}

      {turns.length > 1 && (
        <section className="va-sec">
          <h2>Turns</h2>
          <div className="va-card">
            <pre style={{ maxHeight: 200 }}>{turns.slice(-10).map((t) => `${t.at}  ${stackName(t.provider).padEnd(14)}  first ${t.firstAudio ?? "…"} ms  done ${t.done ?? "…"} ms`).join("\n")}</pre>
          </div>
        </section>
      )}

      {provider === "copilot" && (
        <details open>
          <summary>CopilotKit agent · approvals and results render here</summary>
          <VoiceTools mode="HawkTalk ears + CopilotKit agent" />
          <CopilotChat className="ck-chat" agentId="default" labels={{ welcomeMessageText: "Hold the orb and talk, or say the wake word.", chatInputPlaceholder: "…or type" }} />
        </details>
      )}

      {pending.length > 0 && (
        <div className="va-sheet" role="dialog" aria-label="approval">
          <h3>{pending[0].name === "note_it" ? "Create this doc in Ambiguous?" : "Post this to the team?"}{pending.length > 1 ? ` (1 of ${pending.length})` : ""}</h3>
          <pre>{pending[0].name === "note_it" ? `${String(pending[0].args.title ?? "")}\n\n${String(pending[0].args.content ?? "")}` : String(pending[0].args.content ?? "")}</pre>
          <div className="va-actions">
            <button type="button" className="va-no" onClick={() => pending[0].resolve(false)}>Decline</button>
            <button type="button" className="va-ok" onClick={() => pending[0].resolve(true)}>Approve</button>
          </div>
        </div>
      )}
    </main>
  );
}
