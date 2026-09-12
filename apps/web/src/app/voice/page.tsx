"use client";

/**
 * In the room, A/B — one agent, three voice stacks, on a phone.
 *
 *   OpenAI Realtime          — the kit's WebRTC session (gpt-realtime), server VAD.
 *   HawkTalk                 — plain WebSocket to wss://hawktalk.ai/v1/realtime, hold-to-talk
 *                              or wake word, speech on HawkTalk's own silicon.
 *   HawkTalk + CopilotKit    — HawkTalk hears and speaks over REST, the kit's CopilotKit
 *                              agent thinks and calls the tools.
 *
 * Same prompt, same three tools (Exa search, note_it → Ambiguous doc, tell_team →
 * Ambiguous channel), same tap-or-say approval sheet before any write, same
 * latency clock (end of speech → first sound). Every workplace write is shown
 * back as the record Ambiguous returned, with a link — and on the CopilotKit
 * stack the agent also draws its own card (generative UI, `workplace_record`).
 *
 * Everything the phone does is mirrored, fire-and-forget, to /api/relay so a
 * laptop on /companion can watch along (transcripts, tool calls, approvals,
 * results, latency). The relay never sits in the audio path.
 *
 * Built during the Agents, Everywhere hackathon (2026-09-12). Inherited from the
 * kit: the OpenAI session wiring, SYSTEM_PROMPT, and the Exa search route.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { RealtimeAgent, RealtimeSession, tool } from "@openai/agents/realtime";
import { z } from "zod";
import { useAgent, useCopilotKit } from "@copilotkit/react-core/v2";
import { SYSTEM_PROMPT, searchWebParameters } from "agent-core/shared";
import { REALTIME_MODEL } from "@/lib/realtime-config";
import { HawkTalkRealtime, type HawkTool } from "@/lib/hawktalk-realtime";
import { VoiceTools, type WorkplaceResult } from "@/components/voice-tools";
import { AgentCards } from "@/components/agent-cards";
import { TurnRecorder, transcribe, createSpeechQueue, preconnect, unlockAudio, stopPlayback, onPlayback, chime, type HawkDirect } from "@/lib/hawk-rest";
import { WakeWord, Endpointer, wakeWordSupported } from "@/lib/wake-word";
import "./voice.css";

type Provider = "openai" | "hawktalk" | "copilot";
type Status = "idle" | "connecting" | "live" | "error";
type Turn = { provider: Provider; firstAudio?: number; done?: number; at: string };
type Pending = { id: number; name: string; args: Record<string, unknown>; resolve: (ok: boolean) => void; heard: string };
type Result = { name: string; ok: boolean; status?: number; ms?: number; record?: unknown; slack?: string; at: string };

const VOICE_RULES = [
  SYSTEM_PROMPT,
  "",
  "You are speaking out loud. Rules for voice:",
  "- Answer in one or two sentences. Nobody wants a paragraph read to them.",
  "- Never read out a URL, an id, or a code block. Describe it instead.",
  "- You can act in the user's Ambiguous AI workspace with note_it (create a doc) and tell_team (post in chat).",
  "- Before any workplace write, say what you are about to file in one short sentence, then call the tool. The user approves it with a tap or by saying yes.",
  "- If a tool reports an error, say so plainly and do not pretend it worked.",
  "- The user may start with a wake phrase such as 'hey hawk'. Ignore the wake phrase itself.",
].join("\n");

/** Compact persona for the HawkTalk realtime stack: its chat model runs with a 2048-token
 *  context on the voice card, and the kit's full incident prompt plus tool schemas blew past it. */
const HAWK_RULES = [
  "You are Hawk, a voice assistant on the user's phone at a hackathon. Be warm and brief: one or two sentences.",
  "Never read out URLs, ids or code; describe them.",
  "Tools: search_web for facts; note_it creates a doc in the user's Ambiguous AI workspace; tell_team posts to the team chat there.",
  "Before note_it or tell_team, say in one short sentence what you will file, then call the tool; the user approves by tap or by saying yes.",
  "If a tool reports an error, say so plainly.",
  "The user may start with the wake phrase 'hey hawk'; ignore it.",
].join("\n");

const noteParams = { type: "object", properties: { title: { type: "string" }, content: { type: "string" } }, required: ["title", "content"], additionalProperties: false };
const tellParams = { type: "object", properties: { content: { type: "string" } }, required: ["content"], additionalProperties: false };
const YES = /\b(yes|yeah|yep|approve|approved|send it|do it|go ahead|confirm)\b/i;
const NO = /\b(no|nope|decline|cancel|don't|do not|stop)\b/i;

async function workplace(action: string, body: Record<string, unknown>): Promise<WorkplaceResult> {
  const r = await fetch("/api/workplace", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...body }) });
  const data = (await r.json()) as { ok?: boolean; status?: number; data?: unknown; ms?: number; error?: string; slack?: string };
  return { ok: r.ok && data.ok !== false, status: data.status ?? r.status, ms: data.ms, record: data.data ?? data.error, slack: data.slack };
}
/** Mirror an event to the laptop companion. Never awaited; a dead relay costs the phone nothing. */
const relay = (type: string, payload: Record<string, unknown> = {}) => {
  try { void fetch("/api/relay", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type, ...payload }), keepalive: true }).catch(() => undefined); }
  catch { /* offline or no fetch */ }
};
async function search(query: string, results?: number) {
  relay("tool_call", { name: "search_web", args: { query, results } });
  const r = await fetch("/api/search", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query, results }) });
  if (!r.ok) return "Search is unavailable right now. Say so rather than guessing.";
  const d = (await r.json()) as { results?: unknown };
  return JSON.stringify(d.results ?? []);
}
const vibe = (p: number | number[]) => { try { navigator.vibrate?.(p); } catch { /* not allowed */ } };
const stackName = (p: Provider) => (p === "openai" ? "OpenAI" : p === "copilot" ? "Hawk+CopilotKit" : "HawkTalk");

export default function VoicePage() {
  const [provider, setProvider] = useState<Provider>("hawktalk");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string>();
  const [lines, setLines] = useState<string[]>([]);
  const [live, setLive] = useState<{ role: string; text: string }>();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [pending, setPending] = useState<Pending[]>([]);
  const [results, setResults] = useState<Result[]>([]);
  const [holding, setHolding] = useState(false);
  const [level, setLevel] = useState(0);
  const [thinking, setThinking] = useState<string>();
  const [online, setOnline] = useState(true);
  const [tick, setTick] = useState<number>();
  const [wakeOn, setWakeOn] = useState(false);
  const [liveAudio, setLiveAudio] = useState(true);   // HawkTalk: stream mic audio in (in-socket STT) instead of uploading a WAV first
  const [wakePhrase, setWakePhrase] = useState("hey hawk");
  const [wakeState, setWakeState] = useState<string>();

  const oaRef = useRef<RealtimeSession | null>(null);
  const hawkRef = useRef<HawkTalkRealtime | null>(null);
  const recRef = useRef<TurnRecorder | null>(null);
  const unsubRef = useRef<{ unsubscribe: () => void } | null>(null);
  const wakeRef = useRef<WakeWord | null>(null);
  const wakeOnRef = useRef(false);
  const endRef = useRef(new Endpointer(0.012, 900, 8000));
  const pendingSeq = useRef(0);
  const pendingRef = useRef<Pending[]>([]);
  const clock = useRef<{ t0: number; got: boolean }>({ t0: 0, got: false });
  const releaseAt = useRef(0);
  const turnRef = useRef<Turn | undefined>(undefined);
  const lockRef = useRef<WakeLockSentinel | null>(null);
  const relayedRef = useRef(new Set<string>());
  const { agent } = useAgent({ agentId: "default" });
  const { copilotkit } = useCopilotKit();
  const lastUserText = useRef("");
  const directRef = useRef<HawkDirect | undefined>(undefined);
  const tokenRef = useRef<{ value: string; at: number } | undefined>(undefined);

  const now = () => new Date().toLocaleTimeString();
  const pushTurn = useCallback((patch: Partial<Turn>) => {
    const cur = turnRef.current; if (!cur) return;
    const next = { ...cur, ...patch }; turnRef.current = next;
    setTurns((ts) => { const i = ts.findIndex((t) => t === cur); return i >= 0 ? [...ts.slice(0, i), next, ...ts.slice(i + 1)] : [...ts, next]; });
    if (patch.done !== undefined) relay("latency", { provider: next.provider, firstAudio: next.firstAudio, done: next.done });
  }, []);
  const openTurn = useCallback((p: Provider) => { turnRef.current = { provider: p, at: now() }; setTurns((ts) => [...ts, turnRef.current!]); }, []);

  // ── settings, online state, wake lock, service worker ───────────────────
  useEffect(() => { try { const j = JSON.parse(localStorage.getItem("voice-ab") ?? "{}"); if (j.provider) setProvider(j.provider); if (typeof j.wakeOn === "boolean") setWakeOn(j.wakeOn); if (typeof j.liveAudio === "boolean") setLiveAudio(j.liveAudio); if (new URLSearchParams(location.search).get("audio") === "stream") setLiveAudio(true); if (j.wakePhrase) setWakePhrase(j.wakePhrase); } catch { /* fresh browser */ } }, []);
  useEffect(() => { wakeOnRef.current = wakeOn; try { localStorage.setItem("voice-ab", JSON.stringify({ provider, wakeOn, wakePhrase, liveAudio })); } catch { /* private mode */ } }, [provider, wakeOn, wakePhrase, liveAudio]);
  useEffect(() => { const up = () => setOnline(navigator.onLine); up(); window.addEventListener("online", up); window.addEventListener("offline", up); return () => { window.removeEventListener("online", up); window.removeEventListener("offline", up); }; }, []);
  useEffect(() => { if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => undefined); }, []);
  useEffect(() => { if (error) relay("error", { provider, message: error }); }, [error, provider]);
  // OpenAI stack selected and idle: keep a fresh ephemeral token on hand so Start skips the mint round trip.
  useEffect(() => {
    if (provider !== "openai" || status === "live" || status === "connecting") return;
    let dead = false;
    const mint = () => { fetch("/api/realtime-token", { method: "POST" }).then((r) => (r.ok ? r.json() : undefined)).then((d?: { value?: string }) => { if (!dead && d?.value) tokenRef.current = { value: d.value, at: performance.now() }; }).catch(() => undefined); };
    mint(); const id = setInterval(mint, 40_000);
    return () => { dead = true; clearInterval(id); };
  }, [provider, status]);
  useEffect(() => {
    const acquire = async () => { if (status === "live" && "wakeLock" in navigator && document.visibilityState === "visible") { try { lockRef.current = await navigator.wakeLock.request("screen"); } catch { /* battery saver */ } } };
    if (status !== "live") { lockRef.current?.release().catch(() => undefined); lockRef.current = null; return; }
    void acquire();
    const onVis = () => { if (document.visibilityState === "visible") void acquire(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { document.removeEventListener("visibilitychange", onVis); lockRef.current?.release().catch(() => undefined); lockRef.current = null; };
  }, [status]);
  // Running stopwatch from release until the first sound, so the wait itself is visible.
  useEffect(() => {
    if (!thinking && !clock.current.t0) { setTick(undefined); return; }
    const id = setInterval(() => { const t0 = releaseAt.current || clock.current.t0; setTick(t0 ? Math.round(performance.now() - t0) : undefined); }, 50);
    return () => clearInterval(id);
  }, [thinking, holding]);

  // ── approval gate, shared by all three stacks ──────────────────────────
  const gate = useCallback((name: string, args: Record<string, unknown>) =>
    new Promise<boolean>((resolve) => {
      const id = ++pendingSeq.current;
      relay("tool_call", { name, args });
      // Remember the utterance that triggered this write: a spoken yes/no must come from a NEWER one.
      const item: Pending = { id, name, args, heard: lastUserText.current, resolve: (ok) => { setPending((q) => { const n = q.filter((x) => x.id !== id); pendingRef.current = n; return n; }); relay("approval", { name, ok }); resolve(ok); } };
      setPending((q) => { const n = [...q, item]; pendingRef.current = n; return n; });
    }), []);
  const addResult = useCallback((name: string, res: { ok: boolean; status?: number; ms?: number; record?: unknown; slack?: string }) => {
    setResults((r) => [{ name, ...res, at: now() }, ...r]);
    const rec = res.record && typeof res.record === "object" ? (res.record as { id?: string; title?: string; url?: string; error?: string }) : undefined;
    relay("result", { name, ok: res.ok, status: res.status, ms: res.ms, slack: res.slack, id: rec?.id, title: rec?.title, url: rec?.url, error: rec?.error ?? (typeof res.record === "string" ? res.record : undefined) });
  }, []);
  const runWorkplace = useCallback(async (name: "note_it" | "tell_team", args: Record<string, unknown>) => {
    const ok = await gate(name, args);
    if (!ok) { addResult(name, { ok: false, status: 0, record: "declined by user" }); return "The user declined. Do not retry unless asked."; }
    const res = await workplace(name, args); addResult(name, res);
    return res.ok ? `Done. Record: ${JSON.stringify(res.record).slice(0, 400)}` : `Failed with HTTP ${res.status}: ${JSON.stringify(res.record).slice(0, 200)}`;
  }, [gate, addResult]);
  /** A spoken yes/no while a sheet is up resolves it, so approval can be hands-free. */
  const spokenDecision = useCallback((text: string) => {
    const q = pendingRef.current; if (!q.length) return false;
    if (text.trim() === q[0].heard.trim()) return false;   // the sentence that asked for the write is not the answer
    if (YES.test(text) && !NO.test(text)) { q[0].resolve(true); return true; }
    if (NO.test(text)) { q[0].resolve(false); return true; }
    return false;
  }, []);

  // ── OpenAI: the kit's WebRTC session ────────────────────────────────────
  const connectOpenAI = useCallback(async () => {
    const searchTool = tool({ name: "search_web", description: "Search the live web for anything time-sensitive or factual.", parameters: searchWebParameters, execute: async ({ query, results }) => search(query, results) });
    const noteTool = tool({ name: "note_it", description: "Create a document in the user's Ambiguous AI workspace.", parameters: z.object({ title: z.string(), content: z.string() }), execute: async (a) => runWorkplace("note_it", a) });
    const tellTool = tool({ name: "tell_team", description: "Post a message to the team's Ambiguous AI chat channel.", parameters: z.object({ content: z.string() }), execute: async (a) => runWorkplace("tell_team", a) });
    const rtAgent = new RealtimeAgent({ name: "Everywhere", instructions: VOICE_RULES, tools: [searchTool, noteTool, tellTool] });
    // A token minted in the background while this stack sat selected makes Start instant; stale or missing = mint now.
    let apiKey = tokenRef.current && performance.now() - tokenRef.current.at < 45_000 ? tokenRef.current.value : undefined;
    tokenRef.current = undefined;
    if (!apiKey) {
      const r = await fetch("/api/realtime-token", { method: "POST" });
      const data = (await r.json()) as { value?: string; error?: string };
      if (!r.ok || !data.value) throw new Error(data.error ?? "Could not mint a session token.");
      apiKey = data.value;
    }
    const session = new RealtimeSession(rtAgent, { transport: "webrtc", model: REALTIME_MODEL });
    session.on("history_updated", (history) => {
      const out = history.filter((it) => it.type === "message").map((it) => {
        const text = it.content.map((p) => ("transcript" in p ? p.transcript ?? "" : "text" in p ? p.text : "")).join(" ").trim();
        return text ? `${it.role === "user" ? "you" : "agent"}  ${text}` : "";
      }).filter(Boolean);
      setLines(out);
      for (const it of history) {
        if (it.type !== "message" || !("status" in it) || it.status !== "completed" || relayedRef.current.has(it.itemId)) continue;
        const text = it.content.map((p) => ("transcript" in p ? p.transcript ?? "" : "text" in p ? p.text : "")).join(" ").trim();
        if (!text) continue;
        relayedRef.current.add(it.itemId);
        relay(it.role === "user" ? "transcript" : "reply", { provider: "openai", role: it.role === "user" ? "user" : "agent", text });
      }
      const lastUser = [...history].reverse().find((it) => it.type === "message" && it.role === "user");
      if (lastUser && lastUser.type === "message") { const t = lastUser.content.map((p) => ("transcript" in p ? p.transcript ?? "" : "")).join(" "); if (t) { spokenDecision(t); lastUserText.current = t; } }
    });
    session.on("transport_event", (ev: { type?: string }) => {
      const t = ev.type ?? "";
      if (t === "input_audio_buffer.speech_stopped") { clock.current = { t0: performance.now(), got: false }; releaseAt.current = 0; setThinking("thinking…"); openTurn("openai"); }
      else if ((t === "response.output_audio.delta" || t === "response.audio.delta") && !clock.current.got && clock.current.t0) { clock.current.got = true; setThinking("speaking…"); pushTurn({ firstAudio: Math.round(performance.now() - clock.current.t0) }); }
      else if (t === "response.done" && clock.current.t0) { pushTurn({ done: Math.round(performance.now() - clock.current.t0) }); clock.current.t0 = 0; setThinking(undefined); if (wakeOnRef.current) { session.mute(true); setWakeState(`listening for "${wakePhrase}"`); } }
    });
    session.on("error", (ev) => { setError(String((ev as { error?: unknown }).error ?? ev)); setStatus("error"); });
    await session.connect({ apiKey });
    if (wakeOnRef.current) session.mute(true);
    oaRef.current = session;
  }, [openTurn, pushTurn, runWorkplace, spokenDecision, wakePhrase]);

  // ── HawkTalk realtime ───────────────────────────────────────────────────
  const connectHawk = useCallback(async () => {
    const r = await fetch("/api/hawktalk-config", { method: "POST" });
    const cfg = (await r.json()) as { endpoint?: string; key?: string; voice?: string; apiUrl?: string; error?: string };
    if (!r.ok || !cfg.key || !cfg.endpoint) throw new Error(cfg.error ?? "No HawkTalk config.");
    const tools: HawkTool[] = [
      { name: "search_web", description: "Search the live web for anything time-sensitive or factual.", parameters: { type: "object", properties: { query: { type: "string" }, results: { type: "number" } }, required: ["query"] }, execute: async (a) => search(String(a.query ?? ""), typeof a.results === "number" ? a.results : undefined) },
      { name: "note_it", description: "Create a document in the user's Ambiguous AI workspace.", parameters: noteParams, execute: (a) => runWorkplace("note_it", a) },
      { name: "tell_team", description: "Post a message to the team's Ambiguous AI chat channel.", parameters: tellParams, execute: (a) => runWorkplace("tell_team", a) },
    ];
    const hawk = new HawkTalkRealtime(cfg.endpoint, cfg.key, HAWK_RULES, tools, {
      status: (s, d) => { if (s === "error") { setError(d); setStatus("error"); } else if (s === "live") setStatus("live"); else if (s === "idle") { setError("HawkTalk socket closed — tap Start"); setStatus("error"); setThinking(undefined); } },
      note: (msg) => { setLines((l) => [...l, `agent  ⚠ ${msg}`]); setThinking(undefined); releaseAt.current = 0; },
      awaitingAnswer: () => pendingRef.current.length > 0,
      reset: () => { setTimeout(() => { void reconnectRef.current(); }, 0); },
      turn: (phase) => {
        if (phase === "start") { stopPlayback(); setHolding(true); vibe(10); }
        else if (phase === "cancel") setHolding(false);
        else { setHolding(false); openTurn("hawktalk"); releaseAt.current = performance.now(); setThinking("thinking…"); }
      },
      transcript: (role, text, final) => {
        if (final) { setLive(undefined); setLines((l) => [...l, `${role === "user" ? "you" : "agent"}  ${text}`]); relay(role === "user" ? "transcript" : "reply", { provider: "hawktalk", role: role === "user" ? "user" : "agent", text }); if (role === "user") { const used = spokenDecision(text); lastUserText.current = text; return used; } }
        else setLive({ role, text });
        return false;
      },
      latency: (ms) => { if (ms.firstAudio !== undefined) { setThinking("speaking…"); pushTurn({ firstAudio: Math.round(ms.firstAudio) }); } if (ms.done !== undefined) { if (ms.done > 0) pushTurn({ done: Math.round(ms.done) }); setThinking(undefined); releaseAt.current = 0; } },
      level: (rms) => { setLevel(rms); endRef.current.level(rms); },
    }, cfg.voice, cfg.apiUrl ?? "");
    hawk.sttFirst = !liveAudio; hawk.handsFree = liveAudio; hawk.vadOn = !wakeOnRef.current;
    try { await hawk.connect(); } catch (e) { hawk.close(); throw e; }
    hawkRef.current = hawk;
  }, [pushTurn, runWorkplace, spokenDecision, liveAudio, openTurn]);

  // ── HawkTalk ears + CopilotKit agent ────────────────────────────────────
  const connectCopilot = useCallback(async () => {
    // Ears straight to HawkTalk from the browser when the config route allows it (private/listed hosts); else the /api/hawk/stt proxy.
    directRef.current = undefined;
    void fetch("/api/hawktalk-config", { method: "POST" }).then((r) => (r.ok ? r.json() : undefined)).then((cfg?: { apiUrl?: string; key?: string }) => {
      if (cfg?.apiUrl && cfg.key) { directRef.current = { apiUrl: cfg.apiUrl, key: cfg.key }; preconnect(cfg.apiUrl); }
    }).catch(() => undefined);
    const rec = new TurnRecorder(); rec.onLevel = (rms) => { setLevel(rms); endRef.current.level(rms); }; await rec.open(); recRef.current = rec;
    const offDuck = onPlayback((playing) => rec.setDuck(playing));
    unsubRef.current?.unsubscribe();
    unsubRef.current = { unsubscribe: () => offDuck() };
  }, [agent, pushTurn]);
  const copilotTurn = useCallback(async (wav: Blob) => {
    releaseAt.current = performance.now(); setThinking("transcribing…");
    // Silent capture = the mic is muted, wrong, or owned by another app. Say so; don't transcribe silence.
    const pcm = new Int16Array(await wav.arrayBuffer(), 44); let peak = 0;
    for (let i = 0; i < pcm.length; i += 4) { const a = Math.abs(pcm[i]); if (a > peak) peak = a; }
    if (peak < 200) { setLines((l) => [...l, `agent  ⚠ mic captured silence (peak ${peak}/32767) — check the input device / mute, or another app holds the mic`]); setThinking(undefined); releaseAt.current = 0; return; }
    const heard = await transcribe(wav, directRef.current);
    if (!heard.text) { setThinking(undefined); releaseAt.current = 0; return; }
    setLines((l) => [...l, `you  ${heard.text}`]); relay("transcript", { provider: "copilot", role: "user", text: heard.text });
    if (spokenDecision(heard.text)) { setThinking(undefined); releaseAt.current = 0; return; }
    lastUserText.current = heard.text;
    setThinking("thinking…");
    agent.addMessage({ id: crypto.randomUUID(), role: "user", content: heard.text });
    const before = agent.messages.length;
    // Subscribe on the agent we are about to run (CopilotKit swaps the instance once runtime info loads).
    // Speak while the reply streams: each finished sentence goes to TTS at once (in parallel) and plays in order.
    let heardFirst: () => void = () => undefined; const firstSound = new Promise<void>((res) => { heardFirst = res; });
    const voice = createSpeechQueue(
      (started) => { heardFirst(); setThinking("speaking…"); if (releaseAt.current) { const ms = Math.round(started - releaseAt.current); pushTurn({ firstAudio: ms, done: ms }); releaseAt.current = 0; } },
      (e) => setError(e instanceof Error ? e.message : String(e)),
    );
    const drafts = new Map<string, { text: string; said: number }>();
    const SENTENCE = /[.!?…]["')\]]*\s/g;   // a sentence end followed by whitespace, so "3.5" mid-stream never splits
    const sayReady = (d: { text: string; said: number }) => {
      SENTENCE.lastIndex = d.said; let end = -1; let m: RegExpExecArray | null;
      while ((m = SENTENCE.exec(d.text))) end = m.index + m[0].length;
      if (end - d.said >= 20) { voice.say(d.text.slice(d.said, end)); d.said = end; }
    };
    const finish = (id: string) => {
      const d = drafts.get(id); drafts.delete(id); if (!d) return;
      const reply = d.text.trim(); if (!reply) return;
      voice.say(d.text.slice(d.said)); d.said = d.text.length;
      setLines((l) => [...l, `agent  ${reply}`]); relay("reply", { provider: "copilot", role: "agent", text: reply });
    };
    const sub = agent.subscribe({
      onTextMessageStartEvent: ({ event }: { event: { messageId: string } }) => { drafts.set(event.messageId, { text: "", said: 0 }); },
      onTextMessageContentEvent: ({ event }: { event: { messageId: string; delta?: string } }) => {
        const d = drafts.get(event.messageId) ?? { text: "", said: 0 }; d.text += event.delta ?? ""; drafts.set(event.messageId, d); sayReady(d);
      },
      onTextMessageEndEvent: ({ event }: { event: { messageId: string } }) => finish(event.messageId),
    } as never);
    try {
      await copilotkit.runAgent({ agent });   // the core attaches useFrontendTool tools and runs the tool loop
    } catch (e) {
      setLines((l) => [...l, `agent  ⚠ CopilotKit agent failed: ${e instanceof Error ? e.message : String(e)}`]);
    } finally { sub.unsubscribe(); }
    for (const id of [...drafts.keys()]) finish(id);   // a stream that never sent its end event still gets its tail spoken once
    // Fallback: if the stream events never reached us, speak the last assistant message from the transcript.
    const last = agent.messages[agent.messages.length - 1] as { role?: string; content?: unknown } | undefined;
    if (voice.count === 0 && agent.messages.length > before && last?.role === "assistant" && typeof last.content === "string" && last.content.trim()) {
      const reply = last.content.trim(); setLines((l) => [...l, `agent  ${reply}`]); relay("reply", { provider: "copilot", role: "agent", text: reply });
      voice.say(reply);
    }
    // Clear "speaking…" at first sound (as before): the orb must take a new hold and the native wake listener must get the mic back while the reply plays.
    await Promise.race([firstSound, voice.drain()]);
    if (voice.count) { setThinking(undefined); releaseAt.current = 0; }
    if (agent.messages.length <= before) {
      // Nothing came back: say why, instead of a silent turn. Usually the runtime has no model key.
      let why = "no reply from the CopilotKit runtime";
      try { const r = await fetch("/api/copilotkit/info"); if (!r.ok) { const j = (await r.json().catch(() => ({}))) as { message?: string; error?: string }; why = j.message ?? j.error ?? `runtime HTTP ${r.status}`; } } catch { /* offline */ }
      setLines((l) => [...l, `agent  ⚠ ${why}`]); releaseAt.current = 0;
    }
    setThinking((t) => (t === "thinking…" ? undefined : t));
  }, [agent, copilotkit, spokenDecision, pushTurn]);

  // ── lifecycle ───────────────────────────────────────────────────────────
  const disconnect = useCallback(() => {
    const wasUp = !!(oaRef.current || hawkRef.current || recRef.current);
    oaRef.current?.close(); oaRef.current = null;
    hawkRef.current?.close(); hawkRef.current = null;
    recRef.current?.close(); recRef.current = null;
    unsubRef.current?.unsubscribe(); unsubRef.current = null;
    stopPlayback(); endRef.current.cancel(); wakeRef.current?.stop(); wakeRef.current = null;
    setPending((q) => { q.forEach((x) => x.resolve(false)); pendingRef.current = []; return []; });
    releaseAt.current = 0; clock.current.t0 = 0;
    setStatus("idle"); setHolding(false); setThinking(undefined);
    if (wasUp) relay("stack", { status: "idle" });
  }, []);
  const connect = useCallback(async (keepLines = false) => {
    disconnect(); // never stack a second session/mic on a failed or live one
    setStatus("connecting"); setError(undefined); if (!keepLines) setLines([]); setLive(undefined); unlockAudio(); relayedRef.current.clear();
    relay("stack", { provider, status: "connecting", ua: typeof navigator !== "undefined" ? navigator.userAgent.slice(0, 120) : "" });
    try { if (provider === "openai") await connectOpenAI(); else if (provider === "copilot") await connectCopilot(); else await connectHawk(); setStatus("live"); relay("stack", { provider, status: "live" }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setStatus("error"); }
  }, [provider, connectOpenAI, connectHawk, connectCopilot, disconnect]);
  useEffect(() => { if (hawkRef.current) hawkRef.current.vadOn = !wakeOn; }, [wakeOn]);
  const reconnectRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => { reconnectRef.current = () => connect(true); }, [connect]);
  useEffect(() => () => disconnect(), [disconnect]);

  const bargeIn = () => { stopPlayback(); hawkRef.current?.bargeIn(); setThinking(undefined); };
  const holdStart = () => {
    unlockAudio(); vibe(15); bargeIn();
    if (recRef.current) { if (thinking && !pendingRef.current.length) return; recRef.current.resume(); setHolding(true); recRef.current.start(); return; }
    if (!hawkRef.current) return; setHolding(true); hawkRef.current.pressToTalk();
  };
  const holdEnd = () => {
    if (!holding) return; setHolding(false); vibe(10); endRef.current.cancel();
    if (recRef.current) { openTurn("copilot"); const wav = recRef.current.stop(); copilotTurn(wav).catch((e) => { setError(e instanceof Error ? e.message : String(e)); setThinking(undefined); }); return; }
    if (!hawkRef.current) return; openTurn("hawktalk"); releaseAt.current = performance.now(); setThinking("thinking…"); hawkRef.current.release();
  };

  const onWake = useCallback(() => {
    if (holding) return;
    chime(); bargeIn();
    if (oaRef.current) { oaRef.current.mute(false); setWakeState("mic open — talk"); return; }
    if (recRef.current) {
      const rec = recRef.current; rec.resume(); rec.start(true); setHolding(true); setWakeState("listening…");
      endRef.current.begin(() => { setHolding(false); openTurn("copilot"); const wav = rec.stop(); setWakeState(`listening for "${wakePhrase}"`); copilotTurn(wav).catch((e) => { setError(e instanceof Error ? e.message : String(e)); setThinking(undefined); }); });
      return;
    }
    if (hawkRef.current) {
      const hawk = hawkRef.current; hawk.pressToTalk(true); setHolding(true); setWakeState("listening…");
      endRef.current.begin(() => { setHolding(false); openTurn("hawktalk"); releaseAt.current = performance.now(); setThinking("thinking…"); hawk.release(); setWakeState(`listening for "${wakePhrase}"`); });
    }
  }, [holding, openTurn, copilotTurn, wakePhrase]); // eslint-disable-line react-hooks/exhaustive-deps
  const onWakeRef = useRef(onWake); useEffect(() => { onWakeRef.current = onWake; }, [onWake]);
  // Native wake word: the Android wrapper app listens with the system recognizer (a WebView has no
  // Web Speech API) and dispatches this event on the page when it hears the phrase.
  useEffect(() => {
    const h = () => { if (status === "live") onWakeRef.current(); };
    window.addEventListener("hawk-wake", h);
    return () => window.removeEventListener("hawk-wake", h);
  }, [status]);
  // Android shell: only one client gets the mic. Tell the native wake-word listener to
  // step aside while the page is using it (recording, thinking/speaking, or an OpenAI WebRTC session).
  useEffect(() => {
    const n = (window as unknown as { HawkNative?: { postMessage(m: string): void } }).HawkNative;
    if (!n) return;
    const busy = status === "connecting" || (status === "live" && (provider === "openai" || holding || !!thinking));
    try { n.postMessage(busy ? "mic:busy" : "mic:free"); } catch { /* not in the shell */ }
  }, [status, provider, holding, thinking]);
  useEffect(() => {
    if (status !== "live" || !wakeOn) { wakeRef.current?.stop(); wakeRef.current = null; if (status === "live" && oaRef.current) oaRef.current.mute(false); if (!wakeOn) setWakeState(undefined); return; }
    if (!wakeWordSupported()) { setWakeState(/\bwv\b/.test(navigator.userAgent) ? `app is listening for "${wakePhrase}"` : "wake word needs Chrome; use the orb"); return; }
    const w = new WakeWord(wakePhrase, () => onWakeRef.current(), setWakeState); wakeRef.current = w; w.start();
    if (oaRef.current) oaRef.current.mute(true);
    return () => { w.stop(); };
  }, [status, wakeOn, wakePhrase]);

  // ── view ────────────────────────────────────────────────────────────────
  const avg = (p: Provider, k: "firstAudio" | "done") => { const v = turns.filter((t) => t.provider === p && t[k] !== undefined).map((t) => t[k]!); return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : undefined; };
  const last = [...turns].reverse().find((t) => t.firstAudio !== undefined);
  const hk = avg("hawktalk", "firstAudio"), oa = avg("openai", "firstAudio");
  const handsFree = provider === "hawktalk" && liveAudio && !wakeOn;
  const orbState = status !== "live" ? "off" : holding ? "hold" : thinking?.startsWith("speak") ? "speaking" : thinking ? "thinking" : provider === "openai" || handsFree ? "open" : "idle";
  const orbLabel = !online ? "offline" : status !== "live" ? "start first" : provider === "openai" ? (wakeOn && wakeState?.startsWith("listening for") ? "say the wake word" : "listening") : holding ? (handsFree ? "hearing you…" : "release to send") : thinking ? `${thinking}${tick !== undefined ? ` ${tick} ms` : ""}` : handsFree ? "listening — just talk" : wakeOn ? "hold or say it" : "hold to talk";
  const recordOf = (rec: unknown) => (rec && typeof rec === "object" ? (rec as { id?: string; title?: string; url?: string; error?: string }) : undefined);

  return (
    <main className="va">
      <header className="va-top">
        <div><div className="va-brand">Agents, Everywhere · in the room</div><h1 className="va-title">Voice A/B</h1></div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {!online && <span className="va-pill" data-s="error">offline</span>}
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
        {provider === "hawktalk" && (
          <button type="button" className="va-chip" aria-pressed={liveAudio} disabled={status === "live" || status === "connecting"}
            title="Stream mic audio into the HawkTalk socket (transcribed in-socket) instead of uploading it first. Applies on Start."
            onClick={() => setLiveAudio(!liveAudio)}>⚡ Hands-free live audio</button>
        )}
        <input className="va-input" type="text" value={wakePhrase} onChange={(e) => setWakePhrase(e.target.value)} disabled={!wakeOn} aria-label="wake phrase" />
      </div>
      {wakeState && <div className="va-hint" style={{ marginTop: 6 }} aria-live="polite">{wakeState}</div>}

      <div className="va-stage">
        <button type="button" className="va-orb" data-state={orbState} aria-label={orbLabel} disabled={status !== "live" || provider === "openai" || !online}
          style={{ ["--lvl" as string]: `${Math.min(28, Math.round(level * 160))}px` }}
          onPointerDown={holdStart} onPointerUp={holdEnd} onPointerCancel={holdEnd} onPointerLeave={holdEnd} onContextMenu={(e) => e.preventDefault()}>
          {status !== "live" ? "—" : provider === "openai" ? "live" : holding ? "…" : "talk"}
        </button>
        <div className="va-state" aria-live="polite">{orbLabel}</div>
      </div>

      {status !== "live" && (
        <button type="button" className="va-primary" onClick={() => void connect()} disabled={status === "connecting" || !online}>
          {status === "connecting" ? "Connecting…" : `Start on ${stackName(provider)}`}
        </button>
      )}

      {error && (
        <article className="va-card va-err" role="alert">
          <h3>Could not connect</h3>
          <div className="va-hint">{error}</div>
          <div className="va-hint" style={{ marginTop: 6 }}>{provider === "openai" ? "Needs OPENAI_API_KEY with Realtime access." : "Needs HAWKTALK_API_KEY and the HawkTalk gateway up."} Mic needs HTTPS.</div>
        </article>
      )}

      <div className="va-stats">
        <div className="va-stat" data-hot={last ? "1" : "0"}><b>{last?.firstAudio ?? "–"}</b><small>last turn ms{last ? ` · ${stackName(last.provider)}` : ""}</small></div>
        <div className="va-stat"><b>{hk ?? "–"}</b><small>avg HawkTalk</small></div>
        <div className="va-stat"><b>{oa ?? "–"}</b><small>avg OpenAI</small></div>
        <div className="va-stat"><b>{avg("copilot", "firstAudio") ?? "–"}</b><small>avg Hawk+CK</small></div>
      </div>
      {hk && oa && (
        <div className="va-hint" style={{ textAlign: "center", marginTop: 8, color: hk < oa ? "var(--acc)" : "var(--warn)" }}>
          {hk < oa ? `HawkTalk ${(oa / hk).toFixed(1)}× faster to first sound than OpenAI` : `OpenAI ${(hk / oa).toFixed(1)}× faster to first sound than HawkTalk`}
        </div>
      )}

      {(lines.length > 0 || live) && (
        <section className="va-sec" aria-live="polite">
          <h2>Conversation</h2>
          <div className="va-chat">
            {lines.map((l, i) => { const role = l.startsWith("you") ? "you" : "agent"; return <div key={i} className="va-msg" data-role={role}>{l.replace(/^(you|agent)\s+/, "")}</div>; })}
            {live && <div className="va-msg" data-role={live.role === "user" ? "you" : "agent"} data-live="1">{live.text}…</div>}
          </div>
        </section>
      )}

      {results.length > 0 && (
        <section className="va-sec" aria-live="polite">
          <h2>Workplace actions · Ambiguous AI</h2>
          {results.map((r, i) => { const rec = recordOf(r.record); return (
            <article key={i} className="va-card" data-ok={r.ok ? "1" : "0"}>
              <h3>{r.name === "note_it" ? "Doc" : "Team message"} {r.ok ? "created" : r.status === 0 ? "declined" : `failed (${r.status})`}{r.ms ? ` · ${r.ms} ms` : ""} <span className="va-hint">{r.at}</span></h3>
              <div className="va-hint">{rec ? [rec.title, rec.id ? `id ${rec.id}` : "", rec.error].filter(Boolean).join(" · ") : typeof r.record === "string" ? r.record : ""}</div>
              {r.slack && <div className="va-hint">{r.slack === "queued" ? "Slack: queued — posts on the bot's next turn" : r.slack === "disabled" ? "Slack: off (no INTELLIGENCE_API_KEY / CHANNEL_CODE)" : "Slack: bridge unreachable"}</div>}
              {rec?.url && <a href={rec.url} target="_blank" rel="noreferrer">Open in Ambiguous →</a>}
            </article>
          ); })}
        </section>
      )}

      {provider === "copilot" && <AgentCards names={["workplace_record"]} title="Agent-drawn cards · generative UI" />}

      {provider === "copilot" && <VoiceTools mode="HawkTalk ears + CopilotKit agent" gate={gate} onResult={addResult} />}

      <footer className="va-hint va-foot">companion: <a href="/companion">/companion</a> — open it on a laptop to watch this session live</footer>

      {pending.length > 0 && (
        <div className="va-sheet" role="dialog" aria-label="approval">
          <h3>{pending[0].name === "note_it" ? "Create this doc in Ambiguous?" : "Post this to the team?"}{pending.length > 1 ? ` (1 of ${pending.length})` : ""}</h3>
          <pre>{pending[0].name === "note_it" ? `${String(pending[0].args.title ?? "")}\n\n${String(pending[0].args.content ?? "")}` : String(pending[0].args.content ?? "")}</pre>
          <div className="va-hint" style={{ marginBottom: 10 }}>Tap, or say “yes” / “no”.</div>
          <div className="va-actions">
            <button type="button" className="va-no" onClick={() => { vibe(10); pending[0].resolve(false); }}>Decline</button>
            <button type="button" className="va-ok" onClick={() => { vibe([20, 30, 20]); pending[0].resolve(true); }}>Approve</button>
          </div>
        </div>
      )}
    </main>
  );
}
