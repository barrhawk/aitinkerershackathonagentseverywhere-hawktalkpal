/**
 * HawkTalk text-to-speech, server-side so the key stays here.
 * Body: { text }. Returns the audio bytes with HawkTalk's content type.
 */
export async function POST(request: Request) {
  const key = process.env.HAWKTALK_API_KEY;
  if (!key) return Response.json({ error: "HAWKTALK_API_KEY is not set on the server." }, { status: 500 });
  const base = process.env.HAWKTALK_API_URL ?? "https://api.hawktalk.ai";
  const { text } = (await request.json()) as { text?: string };
  if (!text) return Response.json({ error: "text is required" }, { status: 400 });
  const body: Record<string, unknown> = { model: process.env.HAWKTALK_TTS_MODEL ?? "gooder", input: text };
  if (process.env.HAWKTALK_VOICE) body.voice = process.env.HAWKTALK_VOICE;
  let r: Response;
  try { r = await fetch(`${base}/v1/audio/speech`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }); }
  catch (e) { return Response.json({ error: `HawkTalk unreachable: ${e instanceof Error ? e.message : String(e)}` }, { status: 502 }); }
  if (!r.ok) return Response.json({ error: `HawkTalk TTS HTTP ${r.status}: ${(await r.text()).slice(0, 200)}` }, { status: 502 });
  return new Response(r.body, { headers: { "Content-Type": r.headers.get("content-type") ?? "audio/wav", "Cache-Control": "no-store" } });
}
