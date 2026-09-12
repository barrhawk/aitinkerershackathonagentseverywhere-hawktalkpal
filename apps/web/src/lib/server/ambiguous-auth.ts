/**
 * Ambiguous AI credential resolution for server routes.
 *
 * Preference order: a static API key in AMBIGUOUS_API_KEY; otherwise the
 * service-auth token file written by the claim poller (access token, one hour,
 * renewed with the identity assertion via the jwt-bearer grant, 24 h).
 */
import { readFileSync, writeFileSync } from "node:fs";

const TOKEN_FILE = process.env.AMBIGUOUS_TOKEN_FILE ?? "/home/osprey/hack/ambiguous-token.json";
const TOKEN_ENDPOINT = "https://app.ambiguous.ai/oauth/token";
const RESOURCE = "https://app.ambiguous.ai/mcp";

type TokenFile = { access_token: string; identity_assertion?: string; expires_in?: number; obtained_at?: number; assertion_expires?: string };

function readFile(): TokenFile | undefined { try { return JSON.parse(readFileSync(TOKEN_FILE, "utf8")) as TokenFile; } catch { return undefined; } }

export async function ambiguousBearer(): Promise<string | undefined> {
  const key = process.env.AMBIGUOUS_API_KEY;
  if (key && !key.startsWith("wk_")) return key;
  const t = readFile();
  if (!t?.access_token) return undefined;
  const age = Date.now() / 1000 - (t.obtained_at ?? 0);
  if (age < (t.expires_in ?? 3600) - 120) return t.access_token;
  if (!t.identity_assertion) return t.access_token;
  // Renew with the service-issued assertion.
  const body = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: t.identity_assertion, resource: RESOURCE });
  const r = await fetch(TOKEN_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!r.ok) return t.access_token;
  const n = (await r.json()) as TokenFile;
  const merged: TokenFile = { ...t, ...n, identity_assertion: n.identity_assertion ?? t.identity_assertion, obtained_at: Date.now() / 1000 };
  try { writeFileSync(TOKEN_FILE, JSON.stringify(merged)); } catch { /* read-only fs */ }
  return merged.access_token;
}
