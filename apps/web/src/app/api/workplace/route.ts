/**
 * The two workplace actions the voice agent can take in Ambiguous AI, kept
 * server-side so the key never reaches the browser. Both return the created
 * record so the page can show a verifiable result, not just an "ok".
 *
 *   note_it   → POST /api/documents            (a doc in the workspace)
 *   tell_team → POST /api/channels/{id}/messages (a chat message)
 */
import { ambiguousBearer } from "@/lib/server/ambiguous-auth";

const BASE = "https://app.ambiguous.ai";

async function ambiguous(path: string, body: unknown) {
  const key = await ambiguousBearer();
  if (!key) return { ok: false, status: 500, data: { error: "No Ambiguous credential: set AMBIGUOUS_API_KEY or complete the agent claim." } };
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let data: unknown = null;
  try { data = await r.json(); } catch { data = { error: await r.text().catch(() => "") }; }
  return { ok: r.ok, status: r.status, data };
}

/** Ambiguous returns ids, not links; attach a best-effort web URL so the page can offer "Open in Ambiguous". */
function withUrl(data: unknown, build: (id: string) => string): unknown {
  if (!data || typeof data !== "object") return data;
  const d = data as Record<string, unknown>;
  if (typeof d.url === "string" || typeof d.web_url === "string") return d;
  const id = typeof d.id === "string" ? d.id : typeof (d.document as { id?: string } | undefined)?.id === "string" ? (d.document as { id: string }).id : undefined;
  return id ? { ...d, url: build(id) } : d;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let channelCache: { at: number; list: Array<{ id: string; name?: string; slug?: string }> } | undefined;

/** Channel ids are UUIDs; accept a name or slug and look it up (cached for a minute). */
async function resolveChannel(nameOrId: string): Promise<{ ok: true; id: string } | { ok: false; status: number; data: unknown }> {
  if (UUID.test(nameOrId)) return { ok: true, id: nameOrId };
  const key = await ambiguousBearer();
  if (!key) return { ok: false, status: 500, data: { error: "No Ambiguous credential: set AMBIGUOUS_API_KEY or complete the agent claim." } };
  if (!channelCache || Date.now() - channelCache.at > 60_000) {
    const r = await fetch(`${BASE}/api/channels`, { headers: { Authorization: `Bearer ${key}` } });
    if (!r.ok) return { ok: false, status: r.status, data: { error: `Could not list channels: HTTP ${r.status}` } };
    const j = (await r.json()) as unknown;
    const list = (Array.isArray(j) ? j : (j as { data?: unknown; channels?: unknown; items?: unknown }).data ?? (j as { channels?: unknown }).channels ?? (j as { items?: unknown }).items ?? []) as Array<{ id: string; name?: string; slug?: string }>;
    channelCache = { at: Date.now(), list };
  }
  const want = nameOrId.toLowerCase().replace(/^#/, "");
  const hit = channelCache.list.find((c) => (c.name ?? "").toLowerCase() === want || (c.slug ?? "").toLowerCase() === want) ?? channelCache.list[0];
  return hit ? { ok: true, id: hit.id } : { ok: false, status: 404, data: { error: `No channel named ${nameOrId} and no channels in the workspace.` } };
}

export async function POST(request: Request) {
  const body = (await request.json()) as { action?: string; title?: string; content?: string; channel?: string };
  const t0 = Date.now();
  if (body.action === "note_it") {
    const res = await ambiguous("/api/documents", {
      type: "doc", title: body.title || "Voice note", content: body.content || "",
    });
    return Response.json({ ...res, data: withUrl(res.data, (id) => `${BASE}/documents/${id}`), action: body.action, ms: Date.now() - t0 }, { status: res.ok ? 200 : res.status });
  }
  if (body.action === "tell_team") {
    const channel = await resolveChannel(body.channel || process.env.AMBIGUOUS_CHANNEL || "general");
    if (!channel.ok) return Response.json({ ok: false, status: channel.status, data: channel.data, action: body.action, ms: Date.now() - t0 }, { status: channel.status });
    const res = await ambiguous(`/api/channels/${encodeURIComponent(channel.id)}/messages`, { content: body.content || "" });
    return Response.json({ ...res, data: withUrl(res.data, () => `${BASE}/channels/${channel.id}`), action: body.action, ms: Date.now() - t0 }, { status: res.ok ? 200 : res.status });
  }
  return Response.json({ error: "Unknown action" }, { status: 400 });
}
