/**
 * Wake word for the in-person demo: the page listens for a phrase ("hey hawk")
 * with the browser's speech recognizer, and hands the turn to whichever voice
 * stack is live. Detection only; the actual audio still goes to the provider.
 * Chrome on Android supports this; Firefox does not, and the page says so.
 */
type Rec = {
  continuous: boolean; interimResults: boolean; lang: string;
  onresult: ((ev: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null; onerror: ((ev: { error?: string }) => void) | null;
  start: () => void; stop: () => void; abort: () => void;
};

export function wakeWordSupported(): boolean {
  const w = window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
  return Boolean(w.SpeechRecognition || w.webkitSpeechRecognition);
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

export class WakeWord {
  private rec?: Rec;
  private running = false;
  private lastFire = 0;
  private phrase: string;
  constructor(phrase: string, private onWake: (heard: string) => void, private onState?: (s: string) => void) { this.phrase = norm(phrase); }
  setPhrase(p: string) { this.phrase = norm(p); }
  start() {
    const w = window as unknown as { SpeechRecognition?: new () => Rec; webkitSpeechRecognition?: new () => Rec };
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) { this.onState?.("wake word not supported in this browser"); return; }
    this.running = true;
    const r = new Ctor(); this.rec = r;
    r.continuous = true; r.interimResults = true; r.lang = "en-US";
    r.onresult = (ev) => {
      let text = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) text += ev.results[i][0].transcript + " ";
      const t = norm(text);
      if (!this.phrase || !t.includes(this.phrase)) return;
      if (Date.now() - this.lastFire < 4000) return;   // one wake per turn
      this.lastFire = Date.now();
      const after = t.slice(t.indexOf(this.phrase) + this.phrase.length).trim();
      this.onWake(after);
    };
    r.onerror = (ev) => { this.onState?.(`wake word: ${ev.error ?? "error"}`); };
    r.onend = () => { if (this.running) { try { r.start(); } catch { /* restarts on next tick */ } } };
    try { r.start(); this.onState?.(`listening for "${this.phrase}"`); } catch (e) { this.onState?.(`wake word failed: ${e instanceof Error ? e.message : String(e)}`); }
  }
  stop() { this.running = false; try { this.rec?.abort(); } catch { /* noop */ } this.rec = undefined; this.onState?.("wake word off"); }
}

/** End-of-speech detector on mic level: quiet for `hangMs` after any speech ends the turn. */
export class Endpointer {
  private lastLoud = 0; private started = 0; private timer?: ReturnType<typeof setInterval>;
  constructor(private threshold = 0.012, private hangMs = 900, private maxMs = 12000) {}
  begin(onEnd: () => void) {
    this.started = performance.now(); this.lastLoud = this.started;
    clearInterval(this.timer);
    this.timer = setInterval(() => {
      const now = performance.now();
      if ((this.lastLoud > this.started + 250 && now - this.lastLoud > this.hangMs) || now - this.started > this.maxMs) { this.cancel(); onEnd(); }
    }, 60);
  }
  level(rms: number) { if (rms > this.threshold) this.lastLoud = performance.now(); }
  cancel() { clearInterval(this.timer); this.timer = undefined; }
}
