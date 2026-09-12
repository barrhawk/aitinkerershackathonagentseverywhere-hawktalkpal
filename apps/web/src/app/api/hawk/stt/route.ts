/**
 * HawkTalk speech-to-text, server-side so the key stays here.
 * Body: audio/wav bytes from the browser. Returns { text }.
 */
export async function POST(request: Request) {
  const key = process.env.HAWKTALK_API_KEY;
  if (!key) return Response.json({ error: "HAWKTALK_API_KEY is not set on the server." }, { status: 500 });
  const base = process.env.HAWKTALK_API_URL ?? "https://api.hawktalk.ai";
  const audio = await request.arrayBuffer();
  const form = new FormData();
  form.append("file", new Blob([audio], { type: "audio/wav" }), "turn.wav");
  form.append("model", process.env.HAWKTALK_STT_MODEL ?? "hawk-ear");
  const t0 = Date.now();
  let r: Response;
  try { r = await fetch(`${base}/v1/audio/transcriptions`, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form }); }
  catch (e) { return Response.json({ error: `HawkTalk unreachable: ${e instanceof Error ? e.message : String(e)}` }, { status: 502 }); }
  let raw = await r.text();
  if (r.status === 400 || r.status === 404) {
    // Model name not accepted: retry with the gateway default.
    const f2 = new FormData(); f2.append("file", new Blob([audio], { type: "audio/wav" }), "turn.wav");
    try { r = await fetch(`${base}/v1/audio/transcriptions`, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: f2 }); raw = await r.text(); }
    catch (e) { return Response.json({ error: `HawkTalk unreachable: ${e instanceof Error ? e.message : String(e)}` }, { status: 502 }); }
  }
  if (!r.ok) return Response.json({ error: `HawkTalk STT HTTP ${r.status}: ${raw.slice(0, 200)}` }, { status: 502 });
  let text = raw;
  try { const j = JSON.parse(raw) as { text?: string }; if (typeof j.text === "string") text = j.text; } catch { /* plain text */ }
  return Response.json({ text: text.trim(), ms: Date.now() - t0 });
}
