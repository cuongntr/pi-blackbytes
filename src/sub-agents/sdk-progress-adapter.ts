import type { ChildEvent } from "./sdk-child-protocol.js";
import type { PiSessionEvent } from "./types.js";

/** Normalized progress only. Output/terminal are deliberately not progress or completion proof. */
export function childEventToProgress(event: ChildEvent): PiSessionEvent | undefined {
  switch (event.type) {
    case "session":
      return { type: "session" };
    case "progress":
      return { type: event.event };
    case "model":
      return {
        type: "message_start",
        message: { role: "assistant", model: `${event.model.provider}/${event.model.id}` },
      };
    case "delta":
      return event.channel === "output"
        ? undefined
        : {
            type: "message_update",
            assistantMessageEvent: { type: `${event.channel}_delta`, delta: event.text },
          };
    case "usage":
      return {
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          usage: {
            input: event.input,
            output: event.output,
            totalTokens: event.total,
            cost: { total: event.cost },
          },
        },
      };
    case "tool":
      if (event.phase === "call")
        return {
          type: "message_update",
          assistantMessageEvent: {
            type: "toolcall_end",
            toolCall: {
              id: event.callId,
              name: event.name,
              arguments: event.summary ? { request: event.summary } : {},
            },
          },
        };
      return {
        type: `tool_execution_${event.phase}`,
        toolName: event.name,
        toolCallId: event.callId,
        ...(event.isError === undefined ? {} : { isError: event.isError }),
      };
    default:
      return undefined;
  }
}
