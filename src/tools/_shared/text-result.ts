import type { AgentToolResult } from "@mariozechner/pi-coding-agent";

/**
 * Tool result containing only text content blocks.
 * Structurally compatible with the framework's AgentToolResult.
 */
export type TextToolResult<TDetails = unknown> = {
  content: Array<{ type: "text"; text: string }>;
  details: TDetails | undefined;
};

// Compile-time check: TextToolResult is assignable to the framework result shape.
void 0 as unknown as TextToolResult<undefined> satisfies AgentToolResult<undefined>;

/** Wrap a plain string into the array-of-blocks format expected by the pi framework. */
export function textResult<TDetails = unknown>(
  text: string,
  details?: TDetails,
): TextToolResult<TDetails> {
  return { content: [{ type: "text", text }], details };
}
