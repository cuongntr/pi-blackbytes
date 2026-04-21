import type { AgentToolResult } from "@mariozechner/pi-coding-agent";

/**
 * Tool result containing only text content blocks.
 * Structurally compatible with the framework's AgentToolResult.
 */
export type TextToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: undefined;
};

// Compile-time check: TextToolResult is assignable to AgentToolResult<undefined>
void 0 as unknown as TextToolResult satisfies AgentToolResult<undefined>;

/** Wrap a plain string into the array-of-blocks format expected by the pi framework. */
export function textResult(text: string): TextToolResult {
  return { content: [{ type: "text", text }], details: undefined };
}
