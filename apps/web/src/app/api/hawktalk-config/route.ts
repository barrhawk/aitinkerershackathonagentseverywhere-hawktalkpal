/**
 * Hands the browser what it needs to open a HawkTalk realtime socket.
 * HawkTalk authenticates the socket with the API key in the subprotocol, so the
 * key does reach the browser for this demo. Keep it a demo key.
 */
export async function POST() {
  const key = process.env.HAWKTALK_API_KEY;
  if (!key) return Response.json({ error: "HAWKTALK_API_KEY is not set on the server." }, { status: 500 });
  return Response.json({
    endpoint: process.env.HAWKTALK_REALTIME_URL ?? "wss://hawktalk.ai/v1/realtime",
    key,
    voice: process.env.HAWKTALK_VOICE ?? "",
  });
}
