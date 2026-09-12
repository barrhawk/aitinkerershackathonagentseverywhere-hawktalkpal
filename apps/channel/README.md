# Slack thread agent

**OpenAI + CopilotKit Channels + Exa**

Build an agent that reads an existing conversation, researches what matters, and replies in the same Slack thread with native cards and source links. Try a team research discussion, support handoff, project decision, or incident review. The included incident scenario shows how the infrastructure fits together; replace it with your own workflow.

[![Slack thread agent demo](../../assets/demos/slack.gif)](../../assets/demos/slack.mp4)

_Scroll through a completed Slack thread: incident context, Exa source cards, and the final answer. The preview is sped up; click it for the full MP4._

## Get started

Use Node.js 22+, then clone and install the kit:

```bash
git clone https://github.com/CopilotKit/agents-everywhere-starter-kit.git
cd agents-everywhere-starter-kit
npm ci
cp .env.example .env
```

Run the commands below from the repository root. Configure root `.env` with [OpenAI](../../using-sponsor-tools.md#openai), [CopilotKit Intelligence](../../using-sponsor-tools.md#copilotkit), and [Exa](../../using-sponsor-tools.md#exa):

```dotenv
MODEL_PROVIDER=openai
OPENAI_API_KEY=your-key
MODEL=gpt-5.6-sol
CHANNEL_CODE=your-channel-code
INTELLIGENCE_API_KEY=your-project-key
EXA_API_KEY=your-key
EXA_SEARCH_TYPE=fast
```

Choose an OpenAI model available to your account. Start the official onboarding handoff:

```bash
npm run channel:setup -- --no-clipboard
```

This installs the maintained `channels-setup` skill and prints a prompt. Give that prompt to your coding agent in this checkout and specify **Slack**, using the existing `apps/channel` app. Have the agent follow the skill through sign-in, project/Channel configuration, Slack installation, and a real reply. The command alone does not create the Channel. Keep existing `.env` values; the listener reads `CHANNEL_CODE` and `INTELLIGENCE_API_KEY`. The [setup guide](../../dev-docs/setup.md) and [screenshot walkthrough](../../dev-docs/channels-sdk-walkthrough/README.md) provide manual reference.

```bash
npm run dev:slack
```

Invite the bot to a Slack channel and mention it in a populated thread. CopilotKit Intelligence manages the Slack connection; this listener needs no public tunnel or Slack app token on the managed path.

## Try the flow

1. Add two or three facts to a Slack thread before mentioning the agent.
2. Ask it to catch up using the thread and render a card. Verify facts came from earlier messages rather than your last prompt.
3. Ask it to research a related question with Exa. `search_web` posts native **Search sources** cards when sources are returned; open the links and separate published evidence from facts in your thread.
4. Ask a follow-up that relies on the discussion. Check the answer and card remain in the same thread.

Use [demo prompts](../../dev-docs/demo-prompts.md#slack-context-sources-card-follow-up) for exact incident inputs. If you add an external write, enforce approval in code before that write. The included proposal card records a decision without executing a production action.

## Customize these files

| Piece | File |
|---|---|
| Agent and model | [Shared agent factory](../../packages/agent-core/src/agent.ts), using CopilotKit's built-in agent |
| Channel lifecycle | [src/channel.tsx](src/channel.tsx): mention, subscribe, respond to subscribed messages |
| Channel-only run adapter | [src/agent.ts](src/agent.ts): keeps outer transcript/state while using fresh inner agent runs |
| Thread context and research | [src/tools.tsx](src/tools.tsx) and [src/search.tsx](src/search.tsx): `read_thread` and Exa-backed `search_web` |
| Native cards | [src/components.tsx](src/components.tsx): incident card and timeline via Channels JSX |
| Prompt | [Shared prompt](../../packages/agent-core/src/prompt.ts) |

OpenRouter can be used as the model gateway through the shared provider settings in [using-sponsor-tools.md](../../using-sponsor-tools.md#openrouter). Teams or another messaging platform can reuse the Channels pattern, but this starter app is wired for managed Slack.

## Give this to your coding agent

```text
Read the root hackathon overview, rules, sponsor guide, and AGENTS.md.
Read .agents/skills/build-channels-agent/SKILL.md before changing Slack code.
If Slack is not connected, run npm run channel:setup -- --no-clipboard
from the repository root and follow its prompt using the channels-setup
skill. Select Slack and connect the existing apps/channel app.
Adapt apps/channel to our project's user and conversation. Preserve
read_thread, use Exa when research helps, and render results with Channels JSX.
Replace incident-specific schemas, tools, and prompts with our own workflow.
Demonstrate that earlier messages change the answer and return source links.
Run npm run verify and document the live Slack checks separately.
```

## tell_team → Slack

The voice page's `tell_team` tool posts to the team's Ambiguous AI chat channel
(`apps/web/src/app/api/workplace/route.ts`). When Slack is configured, the same
message is echoed into the Slack thread this bot lives in, through a small
bridge inside this process ([src/bridge.tsx](src/bridge.tsx)):

```
phone → /api/workplace (tell_team) → Ambiguous write (the action)
                                   → POST 127.0.0.1:3777/enqueue   (this process)
                                                  ↓
                        next @mention / subscribed message → thread.post(...)
```

The Ambiguous write is never blocked by Slack: the enqueue is bounded to 2 s and
the route reports `slack: "queued" | "disabled" | "error"`, which the voice
page shows under the result card.

**Delivery is next-turn, not instant.** This is a limit of the Channels SDK
(0.9.2), verified in [src/bridge.test.tsx](src/bridge.test.tsx) against the
SDK's own managed-delivery fixture:

- `thread.post()` exists only on the Thread handed to an inbound handler; there
  is no "post into channel X" API.
- Managed delivery closes that Thread once the turn's terminal packet is sent,
  so a captured handle throws `ChannelDeliveryOperationsClosedError` later.
- `thread.subscribe()` is documented as "Proactive delivery to subscribed
  conversations is not yet wired."

So queued messages are posted at the start of the bot's next inbound Slack turn
(a mention, or any message in a conversation it is subscribed to), before the
agent runs. The queue is in memory (max 100) and is lost on restart. The single
call site carries a `TODO(channels-sdk)` for when proactive delivery ships.

| Variable | Meaning |
|---|---|
| `INTELLIGENCE_API_KEY`, `CHANNEL_CODE` | Both required. Without both, the web route reports `slack: "disabled"` and sends nothing. |
| `CHANNEL_BRIDGE_PORT` | Loopback port shared by the web route and this bridge. Default `3777`; set `0` to disable the listener. |

`GET /health` on the bridge returns `{ ok, pending }`. Live Slack delivery of a
queued message is not exercised offline; the offline tests cover the listener,
the flush, and the managed-delivery packet the flush produces.

## Verify and limits

Run `npm run verify` for root/channel typechecks and offline tests. Live Slack delivery, Exa search, and model responses require your own accounts and should be documented separately from local tests.

Keep the pinned Channels/runtime pair and the `@ag-ui/client` override. The [Channels skill](../../.agents/skills/build-channels-agent/SKILL.md) supplies the verified API vocabulary. [Channels guide](https://copilotkit.ai/channels-guide.md) · [OpenTag reference app](https://github.com/CopilotKit/OpenTag)
