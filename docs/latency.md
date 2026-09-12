# Latency — end of speech to first sound

Only measured numbers are filled in below. A change counts as measured only if it was timed both before and after on the same setup. Anything else is marked "not measured".

## Baseline (phone, before this round)

| Stack | Release → first audio | Where measured |
|---|---|---|
| HawkTalk realtime (hold / wake word → STT → realtime WS) | ~2,100–2,200 ms | phone, page turn clock |
| HawkTalk ears + CopilotKit (STT → agent → TTS) | ~8,200 ms | phone, page turn clock |
| OpenAI Realtime (WebRTC, server VAD) | ~3,400 ms (done) | phone, page turn clock |

Where the HawkTalk realtime time goes: STT alone takes ~1,300 ms for a short clip, and a realtime text turn alone reaches first audio in 150–400 ms.

## Results of this round

Measured from the dev box, not the phone. Phone-side numbers after these changes: not measured.

| Stack | Change | Before (ms) | After (ms) | Runs | Measured on | Notes |
|---|---|---|---|---|---|---|
| HawkTalk realtime | Direct STT sent as a CORS simple request (raw WAV, key in query), so the browser skips the per-turn OPTIONS preflight | 1,412 | 1,355 | 3 each, avg | headless Chromium, dev box | STT request time. On its own, OPTIONS measured 90–98 ms. Falls back to Bearer multipart on 401/403/404/415 or a network error. |
| HawkTalk realtime | Warm the STT origin (cheap GET) when the session goes live and on each press | 1,413 | 1,414 | 3 each | headless Chromium, fresh profile | No gain on a fast link. Phone link not measured. |
| HawkTalk ears + CopilotKit | Speak the reply sentence by sentence while it streams, instead of one TTS call at the end | ~2,000 (full two-sentence reply, TTFB) | ~1,075 (first sentence, TTFB) | 2–3 each | curl → `/v1/audio/speech`, model chatterbox | TTS time to first sound. Re-timed independently: 1,090 vs 1,960. The saving grows with reply length. End-to-end phone turn: not measured. |
| HawkTalk ears + CopilotKit | STT straight from the browser instead of through the Next proxy | 2,550–2,600 (proxy) | 1,710–2,590 (direct) | 2–3 | dev box | Same within gateway noise from the box. The saved phone→laptop hop is not measured. |
| OpenAI Realtime | Ephemeral token minted in the background while idle, used on Start if under 45 s old | not measured | not measured | — | — | |

## Tried, no gain (measured)

- STT upload at 16 kHz vs 24 kHz: 1.41–1.54 s vs 1.41–1.43 s (curl). No gain.
- Trimming leading/trailing silence from the STT clip: 1.43 s vs 1.41 s. No gain.
- Changing STT model/language/response_format/temperature: all 1.40–1.42 s.
- Streamed TTS through the public gateway (`stream: true`, `response_format: pcm`): TTFB 2.00–2.06 s vs 1.96–2.07 s non-streamed. The gateway sends the clip only once it is fully rendered.
- Parallel TTS requests: 1.14 s and 2.32 s. The gateway serves them one at a time.

## Reverted in review (not measured, risk to the demo)

- Endpointer hang cut from 900 → 700 ms. Kept at 900 ms.
- OpenAI turn detection forced to semantic VAD, eagerness high. Kept at the SDK default.

## Server-side levers — proposed, not applied

Ranked by expected saving. The "measured" figures are timings of each leg taken on the servers. None of these has been deployed, so no before/after exists.

| # | Lever | Leg today | Leg on the alternative | Expected effect |
|---|---|---|---|---|
| 1 | Route public STT to the GPU speech-to-text on the voice box instead of the CPU one on the gateway box | 1,300 ms on-box (1,410–1,450 ms public) | 28 ms warm (199 ms cold) | ~1.25 s off every HawkTalk realtime turn (~2.1 s → ~0.9 s release → first audio); copilot STT drops too |
| 2 | Pass chatterbox's streamed chunks through the gateway instead of assembling one WAV | 1,710–1,740 ms public TTFB | 263 ms first chunk upstream | ~1.4 s off copilot time to first sound; needs a gateway code change plus chunked client playback |
| 3 | If STT stays on CPU, give the CPU speech-to-text more threads or a smaller model | 1,300 ms | not measured | maybe 0.4–0.6 s, unverified |
| 4 | Remove the extra relay hop on the realtime WS | ~5–10 ms | — | not worth touching |

Levers 1 and 2 restart the public gateway, which drops live realtime sessions for ~5 s. Do not apply them during a demo or recording.
