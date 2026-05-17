/**
 * Override the built-in read tool's renderResult to strip LINE#ID| anchors
 * from the displayed content while preserving them in conversation history
 * (where the LLM uses them for hashline_edit precision).
 */
import type { ExtensionAPI, ReadToolDetails } from "@earendil-works/pi-coding-agent";
import { SettingsManager, createReadToolDefinition } from "@earendil-works/pi-coding-agent";

const ANCHOR_PATTERN = /^\d+#[A-Z]{2}\|/;

function stripAnchors(text: string): string {
  return text
    .split("\n")
    .map((line) => (ANCHOR_PATTERN.test(line) ? line.replace(ANCHOR_PATTERN, "") : line))
    .join("\n");
}

function stripContentAnchors(
  content: ReadonlyArray<{ type: string; text?: string }>,
): typeof content {
  return content.map((block) => {
    if (block.type === "text" && typeof block.text === "string") {
      return { ...block, text: stripAnchors(block.text) };
    }
    return block;
  }) as unknown as typeof content;
}

export function registerCleanReadRenderer(pi: ExtensionAPI, cwd: string): void {
  let readOptions: { autoResizeImages?: boolean } = {};
  try {
    const settings = SettingsManager.create(cwd, process.env.PI_AGENT_DIR);
    readOptions = { autoResizeImages: settings.getImageAutoResize() };
  } catch {
    // ignore
  }

  const original = createReadToolDefinition(cwd, readOptions);
  const originalRenderResult = original.renderResult;

  if (!originalRenderResult) return;

  // Re-register with stripped-anchor renderResult
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const override = {
    ...original,
    renderResult(
      result: { content: ReadonlyArray<{ type: string; text?: string }>; details: ReadToolDetails },
      options: any,
      theme: any,
      context: any,
    ) {
      const cleanResult = {
        ...result,
        content: stripContentAnchors(result.content),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return originalRenderResult(cleanResult as any, options, theme, context);
    },
  };

  pi.registerTool(override as any);
}
