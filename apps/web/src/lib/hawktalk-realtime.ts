/**
 * HawkTalk realtime — a minimal browser client for wss://hawktalk.ai/v1/realtime.
 *
 * HawkTalk speaks the OpenAI Realtime *event* dialect (session.update,
 * input_audio_buffer.*, response.create, response.audio.delta, function calls)
 * over a plain WebSocket with 24 kHz pcm16 both ways, and adds
 * `x_sample_rate_hz` on audio deltas. This file owns mic capture, playback,
 * tool round-trips and the latency clock so the voice page can A/B it against
 * the OpenAI WebRTC session with the same tools and the same transcript.
 *
 * Written for the Agents, Everywhere hackathon (2026-09-12).
 */

export type HawkTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<string>;
};

export type HawkEvents = {
  status: (s: "connecting" | "live" | "idle" | "error", detail?: string) => void;
  /** Non-fatal, per-turn problem from the gateway (shown, not disconnected). */
  note: (msg: string) => void;
  transcript: (role: "user" | "agent", text: string, final: boolean) => boolean | void; // true = consumed as an approval answer
  latency: (ms: { firstAudio?: number; done?: number }) => void;
  tool: (name: string, args: Record<string, unknown>, result?: string) => void;
  level: (rms: number) => void;
};

const SAMPLE_RATE = 24000;
const DUCK = 0.08;   // ducking, never AEC: attenuate the mic while the agent speaks, never mute it

function pcm16ToB64(f32: Float32Array): string {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  let bin = "";
  const bytes = new Uint8Array(out.buffer);
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  }
  return btoa(bin);
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function wavFromPcm16(chunks: Uint8Array[], rate: number): Blob {
  const n = chunks.reduce((a, c) => a + c.length, 0);
  const buf = new ArrayBuffer(44 + n); const v = new DataView(buf); const u8 = new Uint8Array(buf);
  const str = (o: number, t: string) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + n, true); str(8, "WAVE"); str(12, "fmt "); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, n, true);
  let o = 44; for (const c of chunks) { u8.set(c, o); o += c.length; }
  return new Blob([buf], { type: "audio/wav" });
}

/** Linear resample from the hardware rate to 24 kHz. Browsers ignore the requested rate. */
function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input;
  const ratio = from / to;
  const n = Math.floor(input.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * ratio;
    const i0 = Math.floor(x);
    const i1 = Math.min(i0 + 1, input.length - 1);
    out[i] = input[i0] + (input[i1] - input[i0]) * (x - i0);
  }
  return out;
}

export class HawkTalkRealtime {
  private ws?: WebSocket;
  private ctx?: AudioContext;
  private mic?: MediaStream;
  private micNode?: ScriptProcessorNode;
  private duck?: GainNode;
  private playhead = 0;
  private talking = false;
  private tCommit = 0;
  private gotAudio = false;
  private aiBuf = "";
  private meBuf = "";
  private hwRate = 48000;
  private preroll: string[] = [];   // last ~1.2 s of encoded frames for wake-word turns
  private ducked = false;
  private unduckTimer?: ReturnType<typeof setTimeout>;
  private turnFrames: Uint8Array[] = [];
  private responding = false;        // a response is in flight on the server
  private retriedCreate = false;   // raw pcm16 of the current turn, for STT-first turns
  /** Transcribe locally-captured audio via /api/hawk/stt and send input_text; the gateway's
   *  realtime path has no ASR while the voice card serves it. */
  sttFirst = true;
  private noSimpleStt = false;       // gateway refused the preflight-free STT form; use Bearer multipart
  private lastWarm = 0;

  constructor(
    private endpoint: string,
    private key: string,
    private instructions: string,
    private tools: HawkTool[],
    private on: Partial<HawkEvents>,
    private voice = "",
    private apiUrl = "",
  ) {}

  async connect(): Promise<void> {
    this.on.status?.("connecting");
    // Mic first so a denied permission fails before we open a socket.
    this.mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    this.hwRate = this.ctx.sampleRate;
    this.duck = this.ctx.createGain();
    this.duck.connect(this.ctx.destination);

    const ws = new WebSocket(this.endpoint, ["realtime", "openai-insecure-api-key." + this.key]);
    this.ws = ws;
    ws.onopen = () => undefined;
    ws.onerror = () => this.on.status?.("error", "socket refused — check the HawkTalk key");
    ws.onclose = () => this.on.status?.("idle");
    ws.onmessage = (m) => this.handle(JSON.parse(String(m.data)));

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("HawkTalk did not answer session.updated")), 30000);
      const orig = this.on.status;
      this.on.status = (s, d) => {
        orig?.(s, d);
        if (s === "live") { clearTimeout(t); resolve(); }
        if (s === "error") { clearTimeout(t); reject(new Error(d)); }
      };
    });
  }

  private sttSimpleUrl() { return `${this.apiUrl}/v1/audio/transcriptions?api_key=${encodeURIComponent(this.key)}`; }
  /** Open (or keep open) the TLS connection to the STT origin before the turn is released, so the
   *  upload does not pay a handshake (and, on the Bearer fallback, seeds the preflight cache). Cheap 404. */
  private warmStt() {
    if (!this.sttFirst || !this.apiUrl) return;
    const now = performance.now(); if (now - this.lastWarm < 3000) return; this.lastWarm = now;
    const req = this.noSimpleStt
      ? fetch(`${this.apiUrl}/v1/audio/transcriptions`, { method: "GET", headers: { Authorization: `Bearer ${this.key}` } })
      : fetch(this.sttSimpleUrl(), { method: "GET" });
    void req.then((r) => r.body?.cancel()).catch(() => undefined);
  }

  private send(o: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(o));
  }

  private handle(e: Record<string, any>) {
    switch (e.type) {
      case "session.created":
        this.send({
          type: "session.update",
          session: {
            modalities: ["text", "audio"],
            instructions: this.instructions,
            input_audio_format: "pcm16",
            turn_detection: null,
            ...(this.voice ? { voice: this.voice } : {}),
            tools: this.tools.map((t) => ({
              type: "function", name: t.name, description: t.description, parameters: t.parameters,
            })),
            tool_choice: "auto",
          },
        });
        break;
      case "session.updated":
        this.startMic();
        this.warmStt();
        this.on.status?.("live");
        break;
      case "conversation.item.input_audio_transcription.delta":
        this.meBuf = e.delta || this.meBuf; this.on.transcript?.("user", this.meBuf, false); break;
      case "conversation.item.input_audio_transcription.completed":
        this.on.transcript?.("user", e.transcript || this.meBuf, true); this.meBuf = ""; break;
      case "response.created":
        this.responding = true; this.retriedCreate = false; this.aiBuf = ""; this.gotAudio = false; break;
      case "response.text.delta":
      case "response.audio_transcript.delta":
      case "response.output_audio_transcript.delta":
        this.aiBuf += e.delta || ""; this.on.transcript?.("agent", this.aiBuf, false); break;
      case "response.audio.delta":
        if (!this.gotAudio) { this.gotAudio = true; this.on.latency?.({ firstAudio: performance.now() - this.tCommit }); }
        this.play(e.delta, e.x_sample_rate_hz || SAMPLE_RATE);
        break;
      case "response.function_call_arguments.done":
        void this.runTool(e);
        break;
      case "response.done":
        this.responding = false;
        if (this.aiBuf) this.on.transcript?.("agent", this.aiBuf, true);
        this.on.latency?.({ done: performance.now() - this.tCommit });
        this.aiBuf = "";
        break;
      case "error": {
        const msg: string = e.error?.message || "gateway error";
        // Benign races: a cancel with nothing to cancel, or a create while the previous turn's
        // response is still marked active (cancel it and create once more).
        if (/no active response/i.test(msg)) break;
        if (/already has an active response/i.test(msg) && !this.retriedCreate) {
          this.retriedCreate = true; this.responding = true;
          this.send({ type: "response.cancel" });
          setTimeout(() => this.send({ type: "response.create", response: { modalities: ["text", "audio"] } }), 250);
          break;
        }
        this.on.note?.(msg);
        this.on.latency?.({ done: 0 });
        break;
      }
    }
  }

  private async runTool(e: Record<string, any>) {
    const tool = this.tools.find((t) => t.name === e.name);
    let args: Record<string, unknown> = {};
    try { args = JSON.parse(e.arguments || "{}"); } catch { /* keep empty */ }
    this.on.tool?.(e.name, args);
    const output = tool ? await tool.execute(args) : `Unknown tool ${e.name}`;
    this.on.tool?.(e.name, args, output);
    this.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: e.call_id, output } });
    this.send({ type: "response.create", response: { modalities: ["text", "audio"] } });
  }

  private startMic() {
    if (!this.ctx || !this.mic) return;
    const src = this.ctx.createMediaStreamSource(this.mic);
    // ScriptProcessor is deprecated but works everywhere without a worklet file.
    const node = this.ctx.createScriptProcessor(4096, 1, 1);
    node.onaudioprocess = (ev) => {
      const input = ev.inputBuffer.getChannelData(0);
      let sum = 0; for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
      this.on.level?.(Math.sqrt(sum / input.length));   // raw level: talkover still registers while ducked
      let frame = input;
      if (this.ducked) { frame = new Float32Array(input.length); for (let i = 0; i < input.length; i++) frame[i] = input[i] * DUCK; }
      const b64 = pcm16ToB64(resample(frame, this.hwRate, SAMPLE_RATE));
      if (!this.talking) { this.preroll.push(b64); while (this.preroll.length > Math.ceil(1.2 * this.hwRate / 4096)) this.preroll.shift(); return; }
      if (this.sttFirst) { this.turnFrames.push(b64ToBytes(b64)); return; }
      this.send({ type: "input_audio_buffer.append", audio: b64 });
    };
    src.connect(node);
    const sink = this.ctx.createGain(); sink.gain.value = 0; node.connect(sink); sink.connect(this.ctx.destination);
    this.micNode = node;
  }

  /** Hold-to-talk: press opens the turn, release commits it. With `withPreroll` the last second of audio is sent first (wake word). */
  pressToTalk(withPreroll = false) {
    if (!this.ws) return;
    void this.ctx?.resume();
    this.stopPlayback();
    if (this.responding) { this.send({ type: "response.cancel" }); this.responding = false; }
    this.send({ type: "input_audio_buffer.clear" });
    this.turnFrames = [];
    if (withPreroll) for (const b64 of this.preroll) { if (this.sttFirst) this.turnFrames.push(b64ToBytes(b64)); else this.send({ type: "input_audio_buffer.append", audio: b64 }); }
    this.preroll = [];
    this.talking = true;
    this.warmStt();
  }
  release() {
    if (!this.talking) return;
    this.talking = false;
    this.tCommit = performance.now();
    if (this.sttFirst) { void this.sttThenSend(); return; }
    this.send({ type: "input_audio_buffer.commit" });
    this.send({ type: "response.create", response: { modalities: ["text", "audio"] } });
  }
  private async sttThenSend() {
    const frames = this.turnFrames; this.turnFrames = [];
    if (!frames.length) { this.on.note?.("nothing captured"); this.on.latency?.({ done: 0 }); return; }
    // Silent capture = another app/device owns the mic. Say so instead of sending silence to STT.
    let peak = 0; for (const c of frames) { const v = new Int16Array(c.buffer, c.byteOffset, c.byteLength >> 1); for (let i = 0; i < v.length; i += 4) { const a = Math.abs(v[i]); if (a > peak) peak = a; } }
    if (peak < 200) { this.on.note?.(`mic captured silence (peak ${peak}/32767) — another app or device may hold the mic; ctx ${this.ctx?.state ?? "?"} @${this.hwRate} Hz`); this.on.latency?.({ done: 0 }); return; }
    try {
      const wav = wavFromPcm16(frames, SAMPLE_RATE);
      let r: Response; let d: { text?: string; error?: string };
      if (this.apiUrl) {
        // Direct to HawkTalk with the session key: skips the relay through the dev server.
        // Fast path: raw body + key in the query is a CORS "simple" request, so the browser skips
        // the OPTIONS preflight it would otherwise send before every turn. Bearer multipart is the fallback.
        let fast: Response | undefined;
        if (!this.noSimpleStt) {
          try {
            fast = await fetch(this.sttSimpleUrl(), { method: "POST", body: new Blob([wav]) });
            if (fast.status === 401 || fast.status === 403 || fast.status === 404 || fast.status === 415) { this.noSimpleStt = true; fast = undefined; }
          } catch { this.noSimpleStt = true; fast = undefined; }
        }
        if (fast) r = fast;
        else {
          const form = new FormData(); form.append("file", wav, "turn.wav");
          r = await fetch(`${this.apiUrl}/v1/audio/transcriptions`, { method: "POST", headers: { Authorization: `Bearer ${this.key}` }, body: form });
        }
        const raw = await r.text(); try { d = JSON.parse(raw) as { text?: string }; } catch { d = { text: raw }; }
      } else {
        r = await fetch("/api/hawk/stt", { method: "POST", headers: { "Content-Type": "audio/wav" }, body: wav });
        d = (await r.json()) as { text?: string; error?: string };
      }
      const text = (d.text ?? "").trim();
      if (!r.ok || !text) { this.on.note?.(d.error ? `transcription: ${d.error}` : "didn't catch that"); this.on.latency?.({ done: 0 }); return; }
      if (this.on.transcript?.("user", text, true) === true) { this.on.latency?.({ done: 0 }); return; } // yes/no answered the sheet; not a new turn
      this.send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
      this.send({ type: "response.create", response: { modalities: ["text", "audio"] } });
    } catch (e) { this.on.note?.(`transcription failed: ${e instanceof Error ? e.message : String(e)}`); this.on.latency?.({ done: 0 }); }
  }

  private play(b64: string, rate: number) {
    if (!this.ctx || !this.duck) return;
    const bin = atob(b64 || ""); if (!bin.length) return;
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const pcm = new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2));
    const buf = this.ctx.createBuffer(1, pcm.length, rate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
    const s = this.ctx.createBufferSource(); s.buffer = buf; s.connect(this.duck);
    const at = Math.max(this.ctx.currentTime, this.playhead);
    s.start(at); this.playhead = at + buf.duration;
    // Duck for as long as audio is scheduled, and restore on the tail (+150 ms), not on the last delta.
    this.ducked = true; clearTimeout(this.unduckTimer);
    this.unduckTimer = setTimeout(() => { this.ducked = false; }, Math.max(0, (this.playhead - this.ctx.currentTime) * 1000) + 150);
  }
  /** Barge-in: drop scheduled audio and un-duck the mic. */
  bargeIn() { this.stopPlayback(); if (this.responding) { this.send({ type: "response.cancel" }); this.responding = false; } }
  private stopPlayback() { this.playhead = 0; this.ducked = false; clearTimeout(this.unduckTimer); if (this.duck && this.ctx) { this.duck.disconnect(); this.duck = this.ctx.createGain(); this.duck.connect(this.ctx.destination); } }

  close() {
    if (this.ws) { this.ws.onclose = null; this.ws.onerror = null; } // a deliberate close is not an error
    try { this.ws?.close(); } catch { /* noop */ }
    this.micNode?.disconnect();
    this.mic?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close();
    this.ws = undefined;
  }
}
