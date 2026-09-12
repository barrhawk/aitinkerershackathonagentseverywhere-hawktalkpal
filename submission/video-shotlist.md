# Video shot list — "In the room: one agent, three voice stacks, on a phone"

Two minutes, one take of the phone screen: one complete interaction with a visible result in Ambiguous AI, one decline, one stack failure with recovery, and — if both stacks are up — one A/B flip. Every spoken line is exact so the demo can be re-run from this sheet.

Everything here is read from `apps/web/src/app/voice/page.tsx`, `voice.css`, `lib/wake-word.ts`, `lib/hawktalk-realtime.ts`, `lib/hawk-rest.ts`, `components/voice-tools.tsx`, `app/api/*` and `packages/agent-core/src/model.ts` on branch `hawktalk-ab` (HEAD `c800a9d`). No latency number is scripted; read the numbers off the screen when you get there.

**Status at the time of writing:** all three stacks completed live spoken turns on 2026-09-12; Exa search, Ambiguous writes, HawkTalk STT/TTS verified at the routes the same day.

---

## Before you press record (checklist, ~15 min)

1. Server: `npm run dev --workspace web` (Next on `127.0.0.1:3100`). The phone must reach it on a **private host** — `/api/hawktalk-config` only answers on loopback, LAN (`10.*`, `192.168.*`, `100.64–127.*`) or a `*.ts.net` tailnet name. The mic needs HTTPS on a phone, so use the tailnet HTTPS hostname (`tailscale serve`) rather than a bare LAN IP.
2. Open `https://<box>.<tailnet>.ts.net/voice` in **Chrome on Android** (the wake word uses the browser recognizer; Firefox shows "wake word needs Chrome; use the orb").
3. Env on the server (names only, no values on camera or in the repo): `HAWKTALK_API_KEY`, `OPENAI_API_KEY`, `EXA_API_KEY`, and either `AMBIGUOUS_API_KEY` or the claim-poller token file. Optional `AMBIGUOUS_CHANNEL` (defaults to `general`, else the first channel in the workspace). Optional `HAWKTALK_REALTIME_URL` (default `wss://hawktalk.ai/v1/realtime`).
4. **Stack dependencies — know these before choosing a plan.** Each stack needs two things:
   - `HawkTalk` → `HAWKTALK_API_KEY` + the HawkTalk realtime socket up.
   - `OpenAI Realtime` → `OPENAI_API_KEY` with Realtime access (`/api/realtime-token`).
   - `HawkTalk ears + CopilotKit` → the HawkTalk gateway (`/api/hawk/stt`, `/api/hawk/tts` both call `api.hawktalk.ai`) **and** an LLM key for the kit's agent: `resolveModel()` in `packages/agent-core/src/model.ts` throws unless the key named by `MODEL_PROVIDER` is set (`OPENAI_API_KEY` for `openai`, `OPENROUTER_API_KEY` for `openrouter`, or the Anthropic/Google keys). The checked-in `.env` uses `MODEL_PROVIDER=openai`.
   
   So: gateway down → two of three stacks are down (only OpenAI Realtime survives). OpenAI key missing → two of three are down too (only `HawkTalk` survives) unless `MODEL_PROVIDER` is repointed at another key.
5. Probe what is actually reachable **right now**; don't decide from memory:
   - `curl -m 8 https://api.hawktalk.ai/v1/models` (gateway + REST for Hawk+CK).
   - The realtime socket itself, at the URL the browser will dial: `websocat -E "$HAWKTALK_REALTIME_URL"` (or `wscat -c …`) and confirm you get `session.updated` after a `session.update`. A socket that opens but never answers makes the page wait **30 s** before "HawkTalk did not answer session.updated"; only a refused socket errors instantly with "socket refused — check the HawkTalk key". You need to know which one you'll get before it is on camera.
   - `POST /api/realtime-token` on the server (OpenAI).
6. Screen recorder: Android's built-in recorder with **"Media sounds and mic"** so the agent's voice and yours are both on the track. Record portrait.
7. Chrome is signed in to Ambiguous AI on the phone. **Open in Ambiguous →** is `target="_blank"`, so it opens a new tab — the signed-in session is what matters, not a pre-opened tab.
8. **Mandatory dry run, off camera, on the stack you will record on:** lines 1, 2 and 3 in order (wake → `note_it` → spoken "Hey hawk, yes" dropping the sheet while the tool call is outstanding → decline). Time each turn with the stat strip; if a turn is over ~6 s, cut the A/B flip from the plan now (see the 1:15 rule). Then reload the page so the stat strip shows `–` in all four cells and the Conversation section is empty (stats are per page load; stack choice and wake settings persist in `localStorage`).
9. Fallback rule for the spoken yes, every plan: if the sheet has not dropped within ~3 s of your transcript appearing, **tap `Approve`** and say "or tap it" on camera. On HawkTalk the hands-free yes is gateway-dependent — `session.update` does not request `input_audio_transcription`, so the blue user bubble and the spoken decision only work if the gateway emits the transcription event on its own. On OpenAI it is backed by the SDK's default transcription and should fire.

**Hard timing rule:** if the decline card is not on screen by **1:15**, skip the flip / second search turn and go straight to failure → recovery → close. The doc must be visible in Ambiguous before **1:00**.

---

## Plan A — all three stacks reachable (the intended cut)

Total 2:00. Timecodes are targets.

### 0:00–0:08 · Cold open, phone in hand

**Shot:** Recording already running. `/voice` open, pill `IDLE`, switcher `HawkTalk | OpenAI Realtime | HawkTalk ears + CopilotKit`, orb dimmed, button `Start on HawkTalk`. Venue noise is fine — it is the point.

**Narration:**
> "I'm at a hackathon table, one hand free, and I need to file things in my team's workspace without looking at a screen. This is a voice agent on a phone that can hear me, act in Ambiguous AI, and ask before it writes."

### 0:08–0:18 · Surface tour, three things only

**Shot:** Finger on the switcher, then the `◉ Wake word` chip (turn it on now — green, phrase field `hey hawk`), then the four empty stat cells `last turn ms · avg HawkTalk · avg OpenAI · avg Hawk+CK`.

**Narration:**
> "Same agent, same three tools — Exa search, a note into Ambiguous, a message to the team — on three switchable voice stacks: OpenAI Realtime over WebRTC, HawkTalk's own models on its own silicon over a WebSocket, and HawkTalk ears with the CopilotKit agent doing the thinking. The strip at the bottom clocks every turn from the moment I stop talking to the first sound back."

### 0:18–0:24 · Go live on HawkTalk

**Action:** Tap `Start on HawkTalk`. Pill `CONNECTING` (amber) → `LIVE` (green); `End` appears; chip hint reads `listening for "hey hawk"`; orb label reads `HOLD OR SAY IT`. No narration.

### 0:24–0:52 · The complete interaction: wake → intent → sheet → spoken yes → record

**Say, in one breath after the two-tone chime** (on HawkTalk the 1.2 s pre-roll keeps the words that follow the phrase even if you don't pause):
> "Hey hawk, note it: the Seattle demo table is by the north window, and we need a second power strip before four."

**What the screen does (don't narrate over it) — two elements to read:**
- **Orb label** reads `RELEASE TO SEND` while the wake turn is open; the **chip hint** under `◉ Wake word` reads `listening…`. ~0.9 s of silence closes the turn; orb label flips to `THINKING… <n> ms` with the counter running live.
- Your words appear as a blue bubble on the right (gateway-dependent, see step 9); the reply streams in a grey bubble and is spoken. The prompt tells it to say in one sentence what it is about to file.
- Bottom sheet: **"Create this doc in Ambiguous?"**, title and body in a mono block, hint **"Tap, or say "yes" / "no"."**, buttons `Decline` / `Approve`.
- `last turn ms` turns green with the measured number and `· HawkTalk`; `avg HawkTalk` fills.

**Say (new wake turn; the transcript resolves the sheet hands-free):**
> "Hey hawk, yes."

**Screen:** sheet drops (no haptic on a spoken yes — the triple buzz is the `Approve` tap only). A green-bordered card appears under **WORKPLACE ACTIONS · AMBIGUOUS AI**: `Doc created · <n> ms  <time>`, `<title> · id <uuid>`, link **Open in Ambiguous →**. The agent says something like "Done, it's filed."

**Action:** Tap **Open in Ambiguous →** (new tab). Hold on the doc for two full seconds — title and body you spoke are visible. Switch back to the app tab.

**Narration (over the Ambiguous tab):**
> "That's the real record — Ambiguous returned the id, the page built the link, and I never touched a keyboard."

### 0:52–1:08 · The cancel path: decline by tap

**Say:**
> "Hey hawk, tell the team the demo starts at four in the main room."

**Screen:** agent states what it will post; sheet **"Post this to the team?"** with the message text.

**Action:** Tap **Decline** (one short buzz).

**Screen:** red-bordered card `Team message declined` with `declined by user`; the agent says it was not sent (the tool returns "The user declined. Do not retry unless asked."). Nothing new in Ambiguous.

**Narration:**
> "Every write goes through that sheet. Decline, and the tool reports the decline back to the model — it can't quietly retry."

### 1:08–1:22 · The A/B flip: same tools on OpenAI Realtime, delta line appears (skip if past 1:15)

**Action:** Tap `End` (pill `IDLE`, switcher re-enables). Tap `OpenAI Realtime`, then `Start on OpenAI Realtime`. Pill `LIVE`. The orb is **disabled** on this stack (server VAD, no hold-to-talk) and its label reads `SAY THE WAKE WORD`; the mic stays muted until the phrase.

**Say the wake phrase alone, then wait:** there is **no pre-roll on OpenAI** — the mic is simply un-muted when the recognizer fires, so anything said in the same breath as "hey hawk" is lost. Wait for the chime and for the chip hint to read `mic open — talk` (orb label reads `LISTENING`), then:
> "What's the weather at Pike Place Market right now?"

**Screen:** agent calls `search_web` (Exa) and answers in a sentence or two. There is no live stopwatch on OpenAI — only the stat cell fills after first audio (its clock starts at `speech_stopped`). `last turn ms · OpenAI` and `avg OpenAI` fill, and with both averages present the delta line appears under the strip: `HawkTalk N.N× faster to first sound than OpenAI` (green) or `OpenAI N.N× faster to first sound than HawkTalk` (amber). **Read whichever it says. Do not script the number.** After `response.done` the mic re-mutes and the hint returns to `listening for "hey hawk"`.

**Narration:**
> "Flip the stack, same wake word, same tools. The delta line is measured on this phone, on this network, on these turns — not a benchmark."

### 1:22–1:40 · The failure path: a stack that cannot connect, then recovery

Two honest ways to get the error card; use whichever is true at recording time and say which.

**Option 1 (if real): HawkTalk socket unreachable.** `End`, tap `HawkTalk`, `Start on HawkTalk`. Pill `ERROR` (red), card **"Could not connect"** with `socket refused — check the HawkTalk key`, and the hint `Needs HAWKTALK_API_KEY and the HawkTalk gateway up. Mic needs HTTPS.` **Only use this live if step 5 showed the instant refusal.** If the socket opens but never answers, the error is the 30 s timeout — pre-record that card in a separate take and title-card it, don't wait 30 s on camera.

**Option 2 (reproducible on demand): OpenAI key withheld.** Separate take, server started without `OPENAI_API_KEY`: tap `OpenAI Realtime`, `Start`. Card **"Could not connect"** plus the token-route error and `Needs OPENAI_API_KEY with Realtime access.` Title-card it: *"server started without the OpenAI key"*.

**Recovery (either option):** tap a stack that is up, `Start on …`, pill `LIVE`. Don't linger on the error card after switching — the hint under it changes to the new stack's "Needs …" text until Start is pressed. Wake and ask one line:
> "Hey hawk, say hello in five words."
so the orb goes amber (`SPEAKING…`) again.

**Narration:**
> "When a stack is down the page says so, tells you what it needs, and lets you switch to one that's up. Nothing pretends to work."

**Optional 3 s barge-in beat — HawkTalk / Hawk+CK only.** While the agent is mid-sentence, **press and hold** the orb and say a word — playback stops instantly. Hold, don't tap: a quick tap is press+release and commits an empty turn to the stats. On OpenAI Realtime the orb is disabled; interruption there is talking over the agent while the mic is open (server VAD), no tap.

### 1:40–1:52 · Inherited vs built (one on-camera line)

**Shot:** scroll to the top of the page or the README.

**Narration:**
> "This sits on the CopilotKit starter kit — the OpenAI WebRTC session wiring, the system prompt and the Exa search route are the kit's. Built today: the three-stack switcher, the HawkTalk WebSocket and REST clients, the wake word with endpointing and pre-roll, the approval sheet, the Ambiguous write routes and auth, the latency strip and the PWA shell."

The laptop companion page, generative-UI record cards and a CopilotKit Channels → Slack bridge for `tell_team` were **in progress and not in git** when this sheet was written. Do not show or claim them unless the files are in `git log` when you record; if they are, film the laptop behind the phone during the first interaction and say at 0:52 "and the laptop next to me shows the same record cards live."

### 1:52–2:00 · Close: sponsors in one breath, over the stat strip

**Shot:** the stat strip and the two result cards (green doc, red decline).

**Narration (exactly this; only what is in the build):**
> "Built during Agents, Everywhere on the CopilotKit starter kit: OpenAI Realtime, CopilotKit's agent and frontend tools, Exa for search, Ambiguous AI as the workplace, and HawkTalk's own models on its own silicon. Code and run steps are in the repo."

Say "OpenRouter" here **only** if `MODEL_PROVIDER=openrouter` is what the CopilotKit agent actually ran on during the take; otherwise it belongs in the social post tags, not the video.

Cut on the green `Doc created` card.

---

## Plan B — HawkTalk gateway OFF, OpenAI key present (the state when this sheet was written)

`HawkTalk` and `HawkTalk ears + CopilotKit` are both down. Record everything on **OpenAI Realtime**; use the real HawkTalk failure as the failure shot; there is **no delta line** (it needs both averages). All OpenAI beats are unrehearsed until step 8 passes on OpenAI.

| Time | Plan A shot | Plan B change |
|---|---|---|
| 0:08–0:18 | tour | same words; add "two of the stacks run on HawkTalk's gateway, which is down at the moment I'm recording — so this take is all OpenAI Realtime." |
| 0:18–0:24 | Start on HawkTalk | **This is the failure shot.** Tap `Start on HawkTalk` → pill `ERROR`, "Could not connect" card. Only do it live if step 5 showed the instant refusal; otherwise pre-record the card. Narrate: "That's the error path: the gateway is off, the page says what it needs. Switch." Tap `OpenAI Realtime`, `Start`. |
| 0:24–0:52 | note_it on HawkTalk | Orb disabled, label `SAY THE WAKE WORD`. **No pre-roll:** say "Hey hawk", wait for the chime and the `mic open — talk` chip hint, *then* say line 1 without the wake phrase. No live stopwatch — the stat cell fills after first audio. For the approval: the mic re-mutes after every `response.done`, so say "Hey hawk", wait for `mic open — talk`, then "yes" — or tap `Approve` (step 9 fallback). |
| 0:52–1:08 | decline | same, with the same wake-then-wait cadence. |
| 1:08–1:22 | A/B flip + delta | **Replace** with a second OpenAI turn (wake, wait, then line 4). Narrate: "The HawkTalk columns stay empty in this take; the A/B is in the code and the README, not in this video." Never read a HawkTalk number; there isn't one. |
| 1:22–1:40 | failure path | already done at 0:18. Use the time for the inherited-vs-built line (1:40–1:52) and, if there is spare, one talk-over interruption while the mic is open — **no orb tap on OpenAI, the orb is disabled.** |
| 1:52–2:00 | close | same sentence — HawkTalk is still in the build, just not on camera. |

Say in the description and in the video that HawkTalk turns were not recorded on this build because the gateway was off; never say the HawkTalk stack "works" on the strength of the code alone.

## Plan C — HawkTalk UP, OpenAI key still pending

With `MODEL_PROVIDER=openai` and no `OPENAI_API_KEY`, `HawkTalk ears + CopilotKit` is also down (the kit's agent throws in `resolveModel()`), so this is a **one-stack take on `HawkTalk`** unless you first set `MODEL_PROVIDER=openrouter` + `OPENROUTER_API_KEY` (or the Anthropic/Google pair) and restart the server.

- Record on `HawkTalk` exactly as Plan A through 1:08.
- 1:08–1:22: **if** `MODEL_PROVIDER` was repointed, flip to `HawkTalk ears + CopilotKit` (`End` → tap it → `Start`); orb is hold-to-talk here too, the wake word works the same, `avg Hawk+CK` fills. No delta line (it is HawkTalk-vs-OpenAI only). Narrate: "the third column is HawkTalk's ears with CopilotKit's agent thinking — same tools, same sheet." If it was not repointed, replace this slot with a second HawkTalk turn using line 4 and say the other two stacks are keyed off in this take.
- 1:22–1:40: Option 2 (OpenAI key withheld) — real in this state with no setup.
- Close: keep "OpenAI Realtime" in the sponsor breath only if its error card was shown (it is still integrated); say "OpenRouter" only if the CopilotKit agent actually ran on it.

## Plan D — both off

Don't record. There is no honest interaction to show and the rubric's first criterion is functionality. Fix one stack first.

---

## Exact spoken lines (teleprompter)

| # | When | Say |
|---|---|---|
| 1 | complete interaction | "Hey hawk, note it: the Seattle demo table is by the north window, and we need a second power strip before four." |
| 2 | approve hands-free | "Hey hawk, yes." |
| 3 | decline path | "Hey hawk, tell the team the demo starts at four in the main room." |
| 4 | A/B or second turn (Exa) | "Hey hawk, what's the weather at Pike Place Market right now?" |
| 5 | recovery beat | "Hey hawk, say hello in five words." |

On **OpenAI Realtime** split every line: "Hey hawk" → chime → chip hint `mic open — talk` → the rest of the line. On HawkTalk / Hawk+CK the pre-roll lets you say it in one breath.

Accepted spoken approvals (regex in `page.tsx`): yes / yeah / yep / approve / approved / send it / do it / go ahead / confirm. Declines: no / nope / decline / cancel / don't / do not / stop. A sentence containing both is treated as a decline — say "yes" alone.

Wake phrase is editable next to the chip; keep `hey hawk` so lines 1–5 match. One wake fires per 4 s, so wait for the chime before each line.

---

## Rubric coverage map

| Criterion | Beats that earn it | Timecode (Plan A) |
|---|---|---|
| Core requirements & functionality | live pill, one full write with id + link resolved in Ambiguous, second tool declined, Exa answer | 0:18–1:22 |
| Innovation & theme ("what is lost if the context is removed") | cold open in the venue with one hand; wake word + spoken yes; the phone-only stat strip — take the room away and this is a chat box | 0:00–0:18, 0:24–0:52 |
| Technical execution & integration (failure/cancel path) | Decline card, "Could not connect" card, switch-and-recover, hold-to-interrupt | 0:52–1:08, 1:22–1:40 |
| Usefulness & agentic experience | the sheet before every write, the record card with a real link, latency per turn, End/switch at any time | throughout |
| Rules: inherited code declared | the on-camera inherited-vs-built line, and the header comment in `page.tsx` | 1:40–1:52 |

---

## Things the camera must never show

- The `.env` file, a terminal with env values, the HawkTalk key that `/api/hawktalk-config` hands to the browser (no devtools/network tab on camera), the Ambiguous token file, phone numbers, the account email.
- A latency number spoken from memory. Read the screen or say nothing.
- Any upstream model family behind HawkTalk. The phrase is "HawkTalk's own models on its own silicon".
- The companion page, generative-UI cards or the Slack bridge unless they are in `git log` when you record.
- An orb tap on OpenAI Realtime presented as barge-in — it is disabled there.
