import React from "react";

/**
 * Generative UI for a workplace write — the agent calls `workplace_record`
 * after note_it / tell_team and this card is what it draws.
 *
 * Props arrive incrementally while the tool call streams, so every field is
 * optional and the card renders a skeleton until `id` lands.
 */
export interface WorkplaceRecordProps {
  kind?: string;
  title?: string;
  id?: string;
  url?: string;
  ms?: number;
  ok?: boolean;
}

export type WorkplaceRecord = { kind: "doc" | "message"; title: string; id: string; url?: string; ms?: number; ok: boolean };

/** Ambiguous ids are UUIDs; eight characters is enough to recognise one on a phone. */
export const shortId = (id: string) => (id.length > 12 ? `${id.slice(0, 8)}…` : id);

/**
 * Collapse a /api/workplace result into the fields the agent hands back to
 * `workplace_record`. Ambiguous nests the record under `document` / `message`
 * on some routes and returns it flat on others; both are handled.
 */
export function toWorkplaceRecord(
  name: "note_it" | "tell_team",
  args: Record<string, unknown>,
  res: { ok: boolean; ms?: number; record: unknown },
): WorkplaceRecord {
  const rec = res.record && typeof res.record === "object" ? (res.record as Record<string, unknown>) : {};
  const inner = (rec.document ?? rec.message) as Record<string, unknown> | undefined;
  const pick = (k: string) => { const v = inner?.[k] ?? rec[k]; return typeof v === "string" ? v : undefined; };
  const fallbackTitle = name === "note_it" ? String(args.title ?? "Voice note") : String(args.content ?? "Team message").slice(0, 60);
  return {
    kind: name === "note_it" ? "doc" : "message",
    title: pick("title") ?? fallbackTitle,
    id: pick("id") ?? (typeof res.record === "string" ? res.record : pick("error") ?? "no id"),
    url: pick("url") ?? pick("web_url"),
    ms: res.ms,
    ok: res.ok,
  };
}

export function WorkplaceRecordCard({ kind, title, id, url, ms, ok }: WorkplaceRecordProps) {
  const label = kind === "message" ? "Team message" : kind === "doc" ? "Doc" : "Workplace record";
  const settled = ok !== undefined;
  const state = !settled ? "filing…" : ok ? (kind === "message" ? "posted" : "created") : "failed";
  return (
    <article className="va-card va-record" data-ok={!settled ? "" : ok ? "1" : "0"} data-kind={kind ?? ""}>
      <h3>
        {label} {state}
        {ms !== undefined ? ` · ${ms} ms` : ""}
      </h3>
      <div className="va-hint">
        {title ?? "Waiting for the record…"}
        {id ? ` · id ${shortId(id)}` : ""}
      </div>
      {url && (
        <a href={url} target="_blank" rel="noreferrer">
          Open in Ambiguous →
        </a>
      )}
    </article>
  );
}
