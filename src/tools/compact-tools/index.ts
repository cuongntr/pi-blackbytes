import type {
  AgentToolResult,
  BashToolDetails,
  BashToolInput,
  EditToolDetails,
  EditToolInput,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  FindToolDetails,
  FindToolInput,
  LsToolDetails,
  LsToolInput,
  ReadToolDetails,
  ReadToolInput,
  Theme,
  ToolDefinition,
  WriteToolInput,
} from "@mariozechner/pi-coding-agent";
import {
  SettingsManager,
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  keyHint,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { Static, TSchema } from "typebox";
import type { BlackbytesConfig } from "../../config/schema.js";

interface ToolExpansionUi {
  readonly getToolsExpanded?: () => boolean;
  readonly setToolsExpanded?: (expanded: boolean) => void;
  readonly notify?: (message: string, level?: "info" | "warning" | "error") => void;
}

interface ToolInfoLike {
  readonly name?: unknown;
  readonly sourceInfo?: {
    readonly source?: unknown;
  };
}

export interface CompactToolsRuntimeConfig {
  readonly enabled: boolean;
  readonly defaultExpanded: boolean;
}

type ResultLike<TDetails> = Pick<AgentToolResult<TDetails>, "content" | "details">;
type SummaryBuilder<TArgs, TDetails> = (
  args: Partial<TArgs>,
  result: ResultLike<TDetails>,
  theme: Theme,
  isError: boolean,
) => string;
type PartialSummary<TDetails> = string | ((result: ResultLike<TDetails>, theme: Theme) => string);

export function getCompactToolsConfig(config: BlackbytesConfig): CompactToolsRuntimeConfig {
  return {
    enabled: config.compact_tools?.enabled ?? true,
    defaultExpanded: config.compact_tools?.default_expanded ?? false,
  };
}

function getToolExpansionUi(ctx: ExtensionContext | ExtensionCommandContext): ToolExpansionUi {
  return ctx.ui as unknown as ToolExpansionUi;
}

function shortenPath(path: string): string {
  const home = process.env.HOME;
  if (home && path.startsWith(home)) return `~${path.slice(home.length)}`;
  return path;
}

function getTextContent(result: {
  readonly content: ReadonlyArray<{ type: string; text?: string }>;
}): string {
  return result.content
    .filter(
      (content): content is { type: string; text: string } =>
        content.type === "text" && typeof content.text === "string",
    )
    .map((content) => content.text)
    .join("\n");
}

function lineCount(text: string): number {
  if (!text) return 0;
  return text.split("\n").length;
}

function expandHint(): string {
  try {
    return keyHint("app.tools.expand", "to expand");
  } catch {
    return "ctrl+o to expand";
  }
}

function compactRead(
  args: Partial<ReadToolInput> & { file_path?: string },
  result: ResultLike<ReadToolDetails | undefined>,
  theme: Theme,
  isError: boolean,
): string {
  const path = shortenPath(args.file_path ?? args.path ?? "?");
  if (isError) {
    return `${theme.fg("error", `✗ read ${path} — error`)} ${expandHint()}`;
  }

  const text = getTextContent(result);
  const lines = lineCount(text);
  const truncation = result.details?.truncation;

  let info = theme.fg("success", "✓ ") + theme.fg("toolTitle", theme.bold("read "));
  info += theme.fg("accent", path);

  if (args.offset || args.limit) {
    const start = args.offset ?? 1;
    const end = args.limit ? start + args.limit - 1 : "";
    info += theme.fg("muted", ` :${start}${end ? `-${end}` : ""}`);
  }

  info += theme.fg("dim", ` (${lines} lines`);
  if (truncation?.truncated) {
    info += theme.fg("warning", `, truncated from ${truncation.totalLines}`);
  }
  info += `${theme.fg("dim", ")")} ${expandHint()}`;
  return info;
}

function compactBash(
  args: Partial<BashToolInput>,
  result: ResultLike<BashToolDetails | undefined>,
  theme: Theme,
  isError: boolean,
): string {
  const command = args.command ?? "?";
  const shortCommand = command.length > 60 ? `${command.slice(0, 57)}...` : command;

  const text = getTextContent(result);
  const lines = lineCount(text);
  const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");

  let info = `${icon} ${theme.fg("toolTitle", theme.bold("$ "))}${theme.fg(
    "toolOutput",
    shortCommand,
  )}`;
  info += theme.fg("dim", ` (${lines} lines`);
  if (result.details?.truncation?.truncated) {
    info += theme.fg("warning", ", truncated");
  }
  info += theme.fg("dim", ")");
  if (isError) info += theme.fg("error", " [error]");
  info += ` ${expandHint()}`;
  return info;
}

function compactEdit(
  args: Partial<EditToolInput>,
  _result: ResultLike<EditToolDetails | undefined>,
  theme: Theme,
  isError: boolean,
): string {
  const path = shortenPath(args.path ?? "?");
  if (isError) {
    return `${theme.fg("error", `✗ edit ${path} — error`)} ${expandHint()}`;
  }

  const editCount = Array.isArray(args.edits) ? args.edits.length : 1;
  let info = theme.fg("success", "✓ ") + theme.fg("toolTitle", theme.bold("edit "));
  info += theme.fg("accent", path);
  info += theme.fg("dim", ` (${editCount} edit${editCount === 1 ? "" : "s"})`);
  info += ` ${expandHint()}`;
  return info;
}

function compactWrite(
  args: Partial<WriteToolInput>,
  _result: ResultLike<undefined>,
  theme: Theme,
  isError: boolean,
): string {
  const path = shortenPath(args.path ?? "?");
  if (isError) {
    return `${theme.fg("error", `✗ write ${path} — error`)} ${expandHint()}`;
  }

  const lines = args.content ? lineCount(args.content) : 0;
  let info = theme.fg("success", "✓ ") + theme.fg("toolTitle", theme.bold("write "));
  info += theme.fg("accent", path);
  info += theme.fg("dim", ` (${lines} lines)`);
  info += ` ${expandHint()}`;
  return info;
}

function compactFind(
  args: Partial<FindToolInput>,
  result: ResultLike<FindToolDetails | undefined>,
  theme: Theme,
  isError: boolean,
): string {
  const pattern = args.pattern ?? "?";
  if (isError) {
    return `${theme.fg("error", `✗ find "${pattern}" — error`)} ${expandHint()}`;
  }

  const text = getTextContent(result);
  const count = text ? text.split("\n").filter((line) => line.trim()).length : 0;
  let info = theme.fg("success", "✓ ") + theme.fg("toolTitle", theme.bold("find "));
  info += theme.fg("accent", `"${pattern}"`);
  if (args.path) info += theme.fg("muted", ` in ${shortenPath(args.path)}`);
  info += theme.fg("dim", ` (${count} results)`);
  if (result.details?.truncation?.truncated) {
    info += theme.fg("warning", ", truncated");
  }
  info += ` ${expandHint()}`;
  return info;
}

function compactLs(
  args: Partial<LsToolInput>,
  result: ResultLike<LsToolDetails | undefined>,
  theme: Theme,
  isError: boolean,
): string {
  const path = shortenPath(args.path ?? ".");
  if (isError) {
    return `${theme.fg("error", `✗ ls ${path} — error`)} ${expandHint()}`;
  }

  const text = getTextContent(result);
  const count = text ? text.split("\n").filter((line) => line.trim()).length : 0;
  let info = theme.fg("success", "✓ ") + theme.fg("toolTitle", theme.bold("ls "));
  info += theme.fg("accent", path);
  info += theme.fg("dim", ` (${count} entries)`);
  if (result.details?.truncation?.truncated) {
    info += theme.fg("warning", ", truncated");
  }
  info += ` ${expandHint()}`;
  return info;
}

function partialText<TDetails>(
  summary: PartialSummary<TDetails>,
  result: ResultLike<TDetails>,
  theme: Theme,
): string {
  if (typeof summary === "string") return theme.fg("muted", summary);
  return summary(result, theme);
}

function fallbackExpandedResult<TDetails>(result: ResultLike<TDetails>, theme: Theme): Text {
  return new Text(theme.fg("toolOutput", getTextContent(result)), 0, 0);
}

function withCompactRenderResult<TParams extends TSchema, TDetails, TState>(
  definition: ToolDefinition<TParams, TDetails, TState>,
  opts: {
    readonly partial: PartialSummary<TDetails>;
    readonly compact: SummaryBuilder<Static<TParams>, TDetails>;
  },
): ToolDefinition<TParams, TDetails, TState> {
  const originalRenderResult = definition.renderResult;
  return {
    ...definition,
    renderResult(result, options, theme, context) {
      if (options.expanded) {
        return originalRenderResult
          ? originalRenderResult(result, options, theme, context)
          : fallbackExpandedResult(result, theme);
      }
      if (options.isPartial) {
        return new Text(partialText(opts.partial, result, theme), 0, 0);
      }
      if (originalRenderResult) {
        try {
          originalRenderResult(result, options, theme, { ...context, lastComponent: undefined });
        } catch {
          // Keep compact output usable if a side-effect cleanup render fails.
        }
      }
      return new Text(opts.compact(context.args, result, theme, context.isError), 0, 0);
    },
  };
}

function getToolSources(pi: ExtensionAPI): ReadonlyMap<string, string> | undefined {
  const maybePi = pi as ExtensionAPI & { getAllTools?: () => ToolInfoLike[] };
  try {
    const allTools = maybePi.getAllTools?.();
    if (!Array.isArray(allTools)) return undefined;
    const sources = new Map<string, string>();
    for (const tool of allTools) {
      if (typeof tool.name === "string" && typeof tool.sourceInfo?.source === "string") {
        sources.set(tool.name, tool.sourceInfo.source);
      }
    }
    return sources;
  } catch {
    return undefined;
  }
}

function shouldOverrideBuiltinTool(
  name: string,
  toolSources: ReadonlyMap<string, string> | undefined,
): boolean {
  const source = toolSources?.get(name);
  return source === "builtin";
}

function resolveBuiltinToolOptions(cwd: string): {
  readonly read: { readonly autoResizeImages?: boolean };
  readonly bash: { readonly commandPrefix?: string };
} {
  try {
    const settings = SettingsManager.create(cwd, process.env.PI_AGENT_DIR);
    return {
      read: { autoResizeImages: settings.getImageAutoResize() },
      bash: { commandPrefix: settings.getShellCommandPrefix() },
    };
  } catch {
    return { read: {}, bash: {} };
  }
}

function registerIfBuiltin<TParams extends TSchema, TDetails, TState>(
  pi: ExtensionAPI,
  toolSources: ReadonlyMap<string, string> | undefined,
  definition: ToolDefinition<TParams, TDetails, TState>,
): void {
  if (!shouldOverrideBuiltinTool(definition.name, toolSources)) return;
  pi.registerTool(definition);
}

export function registerCompactToolRenderers(
  pi: ExtensionAPI,
  config: BlackbytesConfig,
  ctx: ExtensionContext,
): void {
  const compactTools = getCompactToolsConfig(config);
  if (!compactTools.enabled) return;

  getToolExpansionUi(ctx).setToolsExpanded?.(compactTools.defaultExpanded);

  const cwd = ctx.cwd ?? process.cwd();
  const toolSources = getToolSources(pi);
  const builtinOptions = resolveBuiltinToolOptions(cwd);

  registerIfBuiltin(
    pi,
    toolSources,
    withCompactRenderResult(createReadToolDefinition(cwd, builtinOptions.read), {
      partial: "Reading...",
      compact: compactRead,
    }),
  );
  registerIfBuiltin(
    pi,
    toolSources,
    withCompactRenderResult(createBashToolDefinition(cwd, builtinOptions.bash), {
      partial: (result, theme) => {
        const lines = lineCount(getTextContent(result));
        return theme.fg("muted", `Running... (${lines} lines so far)`);
      },
      compact: compactBash,
    }),
  );
  registerIfBuiltin(
    pi,
    toolSources,
    withCompactRenderResult(createEditToolDefinition(cwd), {
      partial: "Editing...",
      compact: compactEdit,
    }),
  );
  registerIfBuiltin(
    pi,
    toolSources,
    withCompactRenderResult(createWriteToolDefinition(cwd), {
      partial: "Writing...",
      compact: compactWrite,
    }),
  );
  registerIfBuiltin(
    pi,
    toolSources,
    withCompactRenderResult(createFindToolDefinition(cwd), {
      partial: "Finding...",
      compact: compactFind,
    }),
  );
  registerIfBuiltin(
    pi,
    toolSources,
    withCompactRenderResult(createLsToolDefinition(cwd), {
      partial: "Listing...",
      compact: compactLs,
    }),
  );
}

export function registerCompactToolsCommand(pi: ExtensionAPI): void {
  pi.registerCommand("toggle-verbose", {
    description: "Toggle compact/verbose tool output",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const ui = getToolExpansionUi(ctx);
      const current = ui.getToolsExpanded?.() ?? false;
      ui.setToolsExpanded?.(!current);
      ui.notify?.(current ? "Tool output: compact mode" : "Tool output: expanded mode", "info");
    },
  });
}
