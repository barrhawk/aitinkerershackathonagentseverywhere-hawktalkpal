# Social posts — "In the room, A/B" (Agents, Everywhere hackathon, Seattle, 2026-09-12)

Before posting: fill `https://github.com/barrhawk/aitinkerershackathonagentseverywhere-hawktalkpal` and `<VIDEO_URL>`, pick the A/B line that matches the
video (see "Gate" below), and check every handle against the sponsor slide / portal page.
Event hashtag: not specified in the material we have. Add it if the venue announces one.

## Gate: which A/B line to use

The app has three switchable voice stacks and a per-turn clock; on this build all three
have completed live turns (2026-09-12). Use the **[A/B ran]** line if the video shows two or
more stacks.

- Video shows two or more stacks completing a turn → use the **[A/B ran]** line.
- Video shows one stack → use the **[one stack]** line. Do not say "side by side" or
  "compared".
- Never post a latency number. The clock is in the app; numbers come from the demo run only.

---

## Variant 1 — X, two-tweet thread

**1/2** (263 chars, links counted as 23 each)

Built today on the @CopilotKit starter kit at AI Tinkerers "Agents, Everywhere",
Seattle: a phone voice agent for someone on their feet at an event. Wake word, ask,
"note it" / "tell the team" — it searches, then asks before it writes. Say no, nothing
is written.

**2/2 [A/B ran]** (278 chars, links counted as 23 each)

Same tools, same approval sheet, three voice stacks: @OpenAI Realtime, HawkTalk's own
models on its own silicon, HawkTalk ears + CopilotKit agent — clocked from end of speech
to first sound. Writes go to @AmbiguousAI.
Code: https://github.com/barrhawk/aitinkerershackathonagentseverywhere-hawktalkpal
Video: <VIDEO_URL>

**2/2 [one stack]** (262 chars, links counted as 23 each)

Built to compare three voice stacks (@OpenAI Realtime, HawkTalk's own models on its own
silicon, HawkTalk ears + CopilotKit agent) with a per-turn clock; the video shows one.
Writes go to @AmbiguousAI.
Code: https://github.com/barrhawk/aitinkerershackathonagentseverywhere-hawktalkpal
Video: <VIDEO_URL>

Reply to 2/2 with: `Thanks @OpenAI @CopilotKit @OpenRouterAI @AmbiguousAI, and partners Exa,
Trigger.dev, Auth0 and Mozilla.ai.`

---

## Variant 2 — X, single tweet (video and thanks go in a reply)

**[A/B ran]** (273 chars, links counted as 23 each)

Voice agent on a phone, built today at Agents, Everywhere on @CopilotKit: wake word →
Exa search → tap-or-say approval → @AmbiguousAI doc or channel, link back. Say no,
nothing is written. Three voice stacks incl. @OpenAI Realtime, clocked per turn.
https://github.com/barrhawk/aitinkerershackathonagentseverywhere-hawktalkpal

**[one stack]** (268 chars, links counted as 23 each)

Voice agent on a phone, built today at Agents, Everywhere on @CopilotKit: wake word →
Exa search → tap-or-say approval → @AmbiguousAI doc or channel, link back. Say no,
nothing is written. Built to A/B three voice stacks incl. @OpenAI Realtime.
https://github.com/barrhawk/aitinkerershackathonagentseverywhere-hawktalkpal

Reply with: `Video: <VIDEO_URL> · Thanks @OpenAI @CopilotKit @OpenRouterAI @AmbiguousAI`

---

## Variant 3 — LinkedIn (mentions must be picked from the dropdown, not typed as @text)

I spent today at the AI Tinkerers "Agents, Everywhere" global hackathon in Seattle,
building a voice agent that lives on a phone, for someone on their feet at an event.

What it does: you say a wake word, ask it something, and it can search the web (Exa),
create a document, or post to your team channel in Ambiguous AI. Every write goes through
an approval sheet first — tap it, or just say "yes" or "no". Say no and nothing is
written; the card shows "declined". If a write fails, the card shows "failed" with the
status, and the agent says so plainly. Each successful result comes back as a card with a
link to the record that was actually created.

The A/B: the same agent, same three tools, same approval sheet, run on three switchable
voice stacks — OpenAI Realtime over WebRTC, HawkTalk's own models on HawkTalk's own
silicon over a WebSocket, and a third mode where HawkTalk does the hearing and speaking
while the CopilotKit agent does the reasoning. A per-turn clock measures end of speech to
first sound.
  [A/B ran] ...so you can compare stacks in the room rather than on a slide.
  [one stack] ...built to compare stacks in the room; today's video shows one of them
  completing the full loop.

Why the context matters: a voice agent in a venue, on a phone, with someone waiting for an
answer, is a different problem from a chat box on a laptop. Barge-in, ducking, wake lock,
an offline state, and an approval step you can operate with one thumb are the point, not
the polish.

Built on the CopilotKit starter kit. Inherited from the kit: the OpenAI Realtime session
wiring, the system prompt, the Exa search route, and the CopilotKit agent. Built during the
event: the phone shell, the HawkTalk WebSocket stack and the HawkTalk-ears + CopilotKit
stack, the note_it and tell_team tools, the approval sheet with spoken yes/no, the wake
word, the latency clock, server-side Ambiguous auth, and the PWA.

Thanks to the sponsors OpenAI, CopilotKit, OpenRouter and Ambiguous AI, and partners Exa,
Trigger.dev, Auth0, and Mozilla.ai.

Code and run instructions: https://github.com/barrhawk/aitinkerershackathonagentseverywhere-hawktalkpal
Two-minute demo: <VIDEO_URL>

---

## Handles to verify at the venue

If a handle is still unconfirmed at post time, use the plain name. A wrong tag is worse
than no tag.

| Sponsor / partner | Handle used | Confidence |
|---|---|---|
| OpenAI | @OpenAI | high |
| CopilotKit | @CopilotKit | high on X; LinkedIn page name may differ |
| OpenRouter | @OpenRouterAI | medium — confirm on X |
| Ambiguous AI | @AmbiguousAI | **unconfirmed — confirm first; this is the write-path sponsor** |
| Exa | @ExaAILabs | medium — plain name in copy; add handle if confirmed |
| Trigger.dev | @triggerdotdev | medium |
| Auth0 | @auth0 | high |
| Mozilla.ai | @mozilla_ai | unconfirmed — plain name unless confirmed |

## Notes for whoever posts

- No latency numbers, on any platform.
- "HawkTalk's own models on its own silicon" is the only way to describe the HawkTalk
  stack. Do not name model families.
- OpenRouter is a sponsor thank-you only. The app does not use OpenRouter; do not say
  "built with OpenRouter".
- The Ambiguous result card with a real "Open in Ambiguous" link IS in git and may be
  claimed. What is in progress at time of writing and must NOT be claimed unless it is in
  the video: the generative-UI record cards, the laptop companion page, and Slack posting
  via CopilotKit Channels.
- Character counts above include the URL placeholders at X's fixed 23 characters per link.
  Recount after any edit; X's limit is 280.
