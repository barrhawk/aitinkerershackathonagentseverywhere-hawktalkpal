"use client";

/**
 * Headless generative UI.
 *
 * The voice page has no CopilotChat, so nothing would draw the components the
 * agent invokes with `useComponent`. This walks the agent's own message list
 * and hands each matching tool call to `useRenderToolCall()` — the same
 * registry-backed renderer CopilotChatToolCallsView uses inside the chat
 * widget (react-core v2 exports it; it only needs the CopilotKitProvider).
 *
 * Renders newest first, so the latest record sits under the result cards.
 */
import { UseAgentUpdate, useAgent, useRenderToolCall } from "@copilotkit/react-core/v2";

type Messages = ReturnType<typeof useAgent>["agent"]["messages"];
type ToolMessage = Extract<Messages[number], { role: "tool" }>;

export function AgentCards({ names, title, agentId = "default" }: { names: string[]; title?: string; agentId?: string }) {
  const { agent } = useAgent({ agentId, updates: [UseAgentUpdate.OnMessagesChanged] });
  const renderToolCall = useRenderToolCall();
  const messages = agent.messages;
  const cards = messages.flatMap((m) => {
    if (m.role !== "assistant" || !m.toolCalls?.length) return [];
    return m.toolCalls.filter((tc) => names.includes(tc.function.name)).map((toolCall) => {
      const toolMessage = messages.find((x): x is ToolMessage => x.role === "tool" && x.toolCallId === toolCall.id);
      return { id: toolCall.id, node: renderToolCall({ toolCall, toolMessage }) };
    });
  }).reverse();
  if (!cards.length) return null;
  return (
    <section className="va-sec" aria-live="polite">
      {title && <h2>{title}</h2>}
      {cards.map((c) => <div key={c.id}>{c.node}</div>)}
    </section>
  );
}
