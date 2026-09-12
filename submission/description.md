# Title

**Hey Hawk**

# Description (portal field)

Hey Hawk is a voice agent on the phone in your hand. Say the wake phrase and it answers out loud. It searches the web, files a note as an Ambiguous AI document, or posts to your team's Ambiguous channel. Before either write it shows the exact text on an approval sheet; tap or say yes or no. Approved: the next card shows the record Ambiguous returned, with an "Open in Ambiguous" link. Declined: nothing is written, the card says "declined", and the agent is told not to retry unless asked. A write the API rejects shows "failed (HTTP n)" with the API's error text.

It is for a founder at a hackathon table: hands on a laptop, she needs "note that the Realtime key is pending" filed and "demo at four, table nine" sent to the team without opening another app. The same shape works for anyone whose hands are busy and whose phone is the only screen: a mechanic under a car, a nurse between rooms.

Remove the context and the product goes with it. The phone is the only screen, so it is a PWA with wake lock, haptics and an offline state. The room is loud, so on the HawkTalk stacks the mic ducks while the agent speaks instead of echo-cancelling, and you can barge in and cancel the reply mid-sentence (the OpenAI stack uses the SDK's own mic and interruption). Three voice stacks switch on one page: OpenAI Realtime over WebRTC, HawkTalk realtime over WebSocket on HawkTalk's own models and silicon, and HawkTalk ears with the kit's CopilotKit agent reasoning. All three share the tools, the approval gate, and a per-turn clock from end of speech to first sound, averaged per stack with a delta line. The clock is for the person at the table, not the builder: it tells her which stack she can actually hold a conversation with in that room.

What has run on this build: all three stacks completed live spoken turns on 2026-09-12 (HawkTalk, OpenAI Realtime and HawkTalk ears + CopilotKit, from a phone and a laptop). Exa search, Ambiguous document and channel writes, the approval sheet, HawkTalk STT/TTS and the kit's verify suite are verified at the routes on the same day.

Repo: https://github.com/barrhawk/aitinkerershackathonagentseverywhere-hawktalkpal (branch `main`). Run instructions: the repo README, covering install, every environment variable the voice routes read, and how to reach the page from a phone.

# Sponsor technologies and what each visibly does

- **Ambiguous AI** — `note_it` creates a document; `tell_team` posts a channel message. The tools take only the text; the target channel is fixed by `AMBIGUOUS_CHANNEL` (default `general`), looked up by name or slug to its id. If no channel matches, the route currently posts to the first channel in the workspace; this fallback is disclosed here rather than fixed in this build. The result card shows the returned id and title and an "Open in Ambiguous" link. Auth for the write routes is server-side; the hourly token is renewed automatically two minutes before expiry.
- **Exa** — `search_web` on all three stacks, through the kit's server route so the key never reaches the browser. The agent reads the result back in one or two sentences.
- **CopilotKit** — the third stack. HawkTalk hears and speaks; the kit's CopilotKit agent reasons and calls the tools, registered with `useFrontendTool` and steered with `useAgentContext`. Same approval sheet and result cards as the other two stacks.
- **OpenAI** — the Realtime API over WebRTC is the first stack and the reference point for the latency clock. Completed live turns on this build.
- Trigger.dev, Auth0, Mozilla.ai — not used.

# Declarations

- **Inherited from the CopilotKit starter kit** (base commit `5c8bf4c`): the kit's `/voice` page as shipped (an OpenAI Realtime WebRTC session with the `search_web` tool and the voice rules text), its Realtime token route, the Exa search route, and the CopilotKit runtime. Everything after that commit on branch `hawktalk-ab` was built during the event: the kit's `/voice` page was extended into the three-stack page, plus the HawkTalk WebSocket client, the HawkTalk STT/TTS routes, the CopilotKit voice mode, wake word and endpointer with pre-roll, approval gate, latency clock, Ambiguous write routes and auth, and the PWA shell.
- **Account-dependent behaviour**: Ambiguous writes need a workspace credential (`AMBIGUOUS_API_KEY`, or a token file from an Ambiguous service-auth claim at `AMBIGUOUS_TOKEN_FILE`; the claim tool that produces that file is not in the repo; without the variable the code looks for `ambiguous-token.json` in the working directory, so set an absolute path outside the repo). Without it a write shows a "failed (500)" result card, not a connect error. HawkTalk stacks need a HawkTalk key and the gateway up; OpenAI Realtime needs an OpenAI key with Realtime access. If either of those keys is missing the page shows a "Could not connect" card naming the variable. For the HawkTalk WebSocket stack the page fetches the HawkTalk key from the server and uses it in the browser; that route only answers on loopback, LAN and tailnet hosts, it is a demo key, and it will be rotated after the event. Exa, Ambiguous and the HawkTalk STT/TTS routes keep their keys server-side. The wake word needs Chrome; the page says so on other browsers and offers the orb instead.
- **Sample data**: none. Every record shown is one the workspace API returned.
- No credentials are in the repo or this submission.
