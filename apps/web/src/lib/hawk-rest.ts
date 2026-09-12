/**
 * HawkTalk over REST for the integrated mode: the browser records one turn as
 * WAV, the server transcribes it with HawkTalk, the CopilotKit agent answers,
 * and the reply is rendered by HawkTalk's voice endpoint and played here.
 *
 * Ducking, never AEC: while the agent speaks the mic is attenuated (subtracted,
 * never muted) on the path that reaches the recorder, while the level meter and
 * the endpointer keep reading the raw mic so talkover still registers.
 */
const TARGET_RATE = 16000;
const DUCK = 0.08;

export class TurnRecorder {
  private ctx?: AudioContext;
  private mic?: MediaStream;
  private node?: ScriptProcessorNode;
  private chunks: Float32Array[] = [];
  private preroll: Float32Array[] = [];   // last ~1.2 s, so a wake-word turn keeps the words said before capture started
  private recording = false;
  private ducked = false;
  hwRate = 48000;
  onLevel?: (rms: number) => void;

  async open() {
    this.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    this.ctx = new AudioContext();
    this.hwRate = this.ctx.sampleRate;
    const src = this.ctx.createMediaStreamSource(this.mic);
    this.node = this.ctx.createScriptProcessor(4096, 1, 1);
    this.node.onaudioprocess = (ev) => {
      const raw = ev.inputBuffer.getChannelData(0);
      if (this.onLevel) { let sum = 0; for (let i = 0; i < raw.length; i++) sum += raw[i] * raw[i]; this.onLevel(Math.sqrt(sum / raw.length)); }
      const buf = new Float32Array(raw);
      if (this.ducked) for (let i = 0; i < buf.length; i++) buf[i] *= DUCK;
      if (this.recording) this.chunks.push(buf);
      else { this.preroll.push(buf); while (this.preroll.length > Math.ceil(1.2 * this.hwRate / 4096)) this.preroll.shift(); }
    };
    const sink = this.ctx.createGain(); sink.gain.value = 0;
    src.connect(this.node); this.node.connect(sink); sink.connect(this.ctx.destination);
  }
  setDuck(on: boolean) { this.ducked = on; }
  resume() { void this.ctx?.resume(); }
  start(withPreroll = false) { this.chunks = withPreroll ? [...this.preroll] : []; this.preroll = []; this.recording = true; }
  /** Stop and return a 16 kHz mono WAV. */
  stop(): Blob {
    this.recording = false;
    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    const all = new Float32Array(total); let o = 0;
    for (const c of this.chunks) { all.set(c, o); o += c.length; }
    const ratio = this.hwRate / TARGET_RATE; const n = Math.floor(all.length / ratio);
    const pcm = new Int16Array(n);
    for (let i = 0; i < n; i++) { const s = Math.max(-1, Math.min(1, all[Math.floor(i * ratio)])); pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff; }
    const buf = new ArrayBuffer(44 + pcm.length * 2); const v = new DataView(buf);
    const str = (off: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
    str(0, "RIFF"); v.setUint32(4, 36 + pcm.length * 2, true); str(8, "WAVE"); str(12, "fmt "); v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, TARGET_RATE, true); v.setUint32(28, TARGET_RATE * 2, true);
    v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, pcm.length * 2, true);
    new Int16Array(buf, 44).set(pcm);
    return new Blob([buf], { type: "audio/wav" });
  }
  close() { this.node?.disconnect(); this.mic?.getTracks().forEach((t) => t.stop()); void this.ctx?.close(); }
}

export async function transcribe(wav: Blob): Promise<{ text: string; ms?: number }> {
  const r = await fetch("/api/hawk/stt", { method: "POST", headers: { "Content-Type": "audio/wav" }, body: wav });
  const d = (await r.json()) as { text?: string; ms?: number; error?: string };
  if (!r.ok || typeof d.text !== "string") throw new Error(d.error ?? `STT failed (${r.status})`);
  return { text: d.text, ms: d.ms };
}

let player: HTMLAudioElement | undefined;
const listeners = new Set<(playing: boolean) => void>();
/** Subscribe to playback start/stop (drives mic ducking). Returns an unsubscribe. */
export function onPlayback(cb: (playing: boolean) => void) { listeners.add(cb); return () => { listeners.delete(cb); }; }
const emit = (p: boolean) => listeners.forEach((l) => l(p));

/** Call from a user gesture: mobile browsers only allow playback started by a tap, and the reply arrives seconds later. */
export function unlockAudio() {
  if (!player) { player = new Audio(); player.preload = "auto"; }
  player.muted = true;
  player.src = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=";
  void player.play().catch(() => undefined);
  player.muted = false;
}

/** Barge-in: stop whatever is playing without leaving a rejected play() behind. */
export function stopPlayback() {
  if (!player) return;
  player.onplaying = null; player.onended = null; player.onerror = null;
  try { player.pause(); player.currentTime = 0; } catch { /* nothing loaded */ }
  player.removeAttribute("src"); player.load();
  emit(false);
}

/** Render and play; resolves with the time the audio actually started. */
export async function speak(text: string): Promise<number> {
  const r = await fetch("/api/hawk/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
  if (!r.ok) { const d = (await r.json().catch(() => ({}))) as { error?: string }; throw new Error(d.error ?? `TTS failed (${r.status})`); }
  const url = URL.createObjectURL(await r.blob());
  const a = player ?? (player = new Audio());
  a.src = url;
  return new Promise<number>((resolve, reject) => {
    a.onplaying = () => { emit(true); resolve(performance.now()); };
    a.onerror = () => { emit(false); reject(new Error("audio playback failed")); };
    a.onended = () => { URL.revokeObjectURL(url); setTimeout(() => emit(false), 150); };   // restore on the tail, not the last sample
    a.play().catch((e: unknown) => { emit(false); reject(e instanceof Error ? e : new Error(String(e))); });
  });
}

/** Short two-tone earcon for the wake word (works without a gesture once audio is unlocked). */
export function chime() {
  try {
    const ctx = new AudioContext(); const o = ctx.createOscillator(); const g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.frequency.setValueAtTime(587, ctx.currentTime); o.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.09);
    g.gain.setValueAtTime(0.12, ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.14);
    o.start(); o.stop(ctx.currentTime + 0.14); o.onended = () => void ctx.close();
  } catch { /* no audio */ }
}
