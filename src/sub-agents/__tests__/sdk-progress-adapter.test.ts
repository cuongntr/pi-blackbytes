import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ChildEvent } from "../sdk-child-protocol.js";
import { normalizeSdkEvent } from "../sdk-child-provider.js";
import { childEventToProgress } from "../sdk-progress-adapter.js";

describe("normalized SDK progress adapter (pure)", () => {
  it("never maps terminal or sensitive output into preview/completion", () => {
    assert.equal(
      childEventToProgress({ version: 1, type: "delta", channel: "output", text: "sensitive" }),
      undefined,
    );
    assert.equal(
      childEventToProgress({
        version: 1,
        type: "terminal",
        outcome: "success",
        refusalLatched: false,
        settlement: { gateClosed: true, runsIdle: true, runtimeDisposed: true },
      }),
      undefined,
    );
    assert.deepEqual(childEventToProgress({ version: 1, type: "progress", event: "agent_end" }), {
      type: "agent_end",
    });
  });
  it("maps bounded metadata, tool progress and per-message usage to existing meanings", () => {
    const event = childEventToProgress({
      version: 1,
      type: "tool",
      phase: "call",
      name: "read",
      callId: "synthetic",
      summary: "redacted summary",
    });
    assert.deepEqual(event, {
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_end",
        toolCall: {
          id: "synthetic",
          name: "read",
          arguments: { request: "redacted summary" },
        },
      },
    });
    assert.deepEqual(
      childEventToProgress({
        version: 1,
        type: "tool",
        phase: "end",
        name: "read",
        callId: "synthetic",
        isError: true,
      }),
      { type: "tool_execution_end", toolName: "read", toolCallId: "synthetic", isError: true },
    );
    assert.equal(
      childEventToProgress({ version: 1, type: "usage", input: 1, output: 2, total: 3, cost: 0 })
        ?.type,
      "message_end",
    );
  });
  it("raw SDK and CLI-shaped delta-only updates do not require full message snapshots", () => {
    for (const includeSnapshot of [true, false]) {
      const events: ChildEvent[] = [];
      const deltas: string[] = [];
      // Public SDK supplies snapshots; 0.85.1 CLI omits them. This is a shape fixture,
      // not a CLI or 0.85.1 runtime execution. Completed blocks redact split secrets.
      const update = {
        type: "message_update",
        ...(includeSnapshot ? { message: { role: "assistant", content: [] } } : {}),
        assistantMessageEvent: {
          type: "text_end",
          content: "PRIVATE_TOKEN=synthetic-value",
          contentIndex: 0,
        },
      };
      normalizeSdkEvent(
        update as unknown as AgentSessionEvent,
        (e) => events.push(e),
        (_channel, text) => deltas.push(text),
      );
      assert.deepEqual(deltas, ["PRIVATE_TOKEN=[REDACTED]"]);
      assert.equal(events.length, 0);
    }
  });
});
