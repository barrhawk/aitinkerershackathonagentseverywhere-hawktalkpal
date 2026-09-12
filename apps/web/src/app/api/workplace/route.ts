/**
 * The two workplace actions the voice agent can take in Ambiguous AI, kept
 * server-side so the key never reaches the browser. Both return the created
 * record so the page can show a verifiable result, not just an "ok".
 *
 *   note_it   → POST /api/documents            (a doc in the workspace)
 *   tell_team → POST /api/channels/{id}/messages (a chat message)
 */
const BASE = "https://app.ambiguous.ai";

async function ambiguous(path: string, body: unknown) {
  const key = process.env.AMBIGUOUS_API_KEY;
  if (!key) return { ok: false, status: 500, data: { error: "AMBIGUOUS_API_KEY is not set on the server." } };
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let data: unknown = null;
  try { data = await r.json(); } catch { data = { error: await r.text().catch(() => "") }; }
  return { ok: r.ok, status: r.status, data };
}

export async function POST(request: Request) {
  const body = (await request.json()) as { action?: string; title?: string; content?: string; channel?: string };
  const t0 = Date.now();
  if (body.action === "note_it") {
    const res = await ambiguous("/api/documents", {
      type: "doc", title: body.title || "Voice note", content: body.content || "",
    });
    return Response.json({ ...res, action: body.action, ms: Date.now() - t0 }, { status: res.ok ? 200 : res.status });
  }
  if (body.action === "tell_team") {
    const channel = body.channel || process.env.AMBIGUOUS_CHANNEL || "general";
    const res = await ambiguous(`/api/channels/${encodeURIComponent(channel)}/messages`, { content: body.content || "" });
    return Response.json({ ...res, action: body.action, ms: Date.now() - t0 }, { status: res.ok ? 200 : res.status });
  }
  return Response.json({ error: "Unknown action" }, { status: 400 });
}
