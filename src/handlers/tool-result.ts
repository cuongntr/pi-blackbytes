import { computeCID } from "../utils/cid.js";

export interface ToolResultEvent {
  toolName: string;
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
}

function rewriteWithHashlineAnchors(text: string): string {
  if (text.length === 0) return text;
  const trailingNewline = text.endsWith("\n");
  const body = trailingNewline ? text.slice(0, -1) : text;
  const lines = body.length === 0 && trailingNewline ? [""] : body.split("\n");
  const annotated = lines
    .map((line, idx) => {
      const lineNum = idx + 1;
      const cid = computeCID(lineNum, line);
      return `${lineNum}#${cid}|${line}`;
    })
    .join("\n");
  return trailingNewline ? `${annotated}\n` : annotated;
}

export function processToolResult(
  event: ToolResultEvent,
  config: { hashline_edit: boolean },
): ToolResultEvent | null {
  try {
    if (!config.hashline_edit || event.isError) return null;

    if (event.toolName === "read") {
      if (!event.content) return null;
      let changed = false;
      const newContent = event.content.map((block) => {
        if (block.type !== "text" || block.text === undefined) return block;
        changed = true;
        return { ...block, text: rewriteWithHashlineAnchors(block.text) };
      });
      if (!changed) return null;
      return { ...event, content: newContent };
    }

    return null;
  } catch {
    return null;
  }
}
