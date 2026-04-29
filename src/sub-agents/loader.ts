import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "typebox";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { getEnabledSet } from "../config/enabled-set.js";
import { getLogger } from "../shared/logger.js";
import { type SubAgentDeclaration, defineSubAgent } from "./declaration.js";
import {
  type AgentMutability,
  EXTENSION_TOOL_NAMES,
  MUTATING_EXEC_TOOLS,
  PI_DEFAULT_TOOLS,
  READ_SEARCH_DOCS_TOOLS,
  validateToolNames,
} from "./delegable-tools.js";
import type { YamlDiagnostics, YamlLoadedDeclaration, YamlSkippedFile } from "./diagnostics.js";

// ---------------------------------------------------------------------------
// YAML schema
// ---------------------------------------------------------------------------

const YamlSubAgentSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .refine((n) => /^[a-z][a-z0-9_-]*$/.test(n), {
        message:
          "name must start with a lowercase letter and contain only lowercase letters, digits, hyphens, or underscores",
      }),
    description: z.string().min(1),
    system_prompt: z.string().min(1),
    allowed_tools: z.array(z.string()).optional(),
    denied_tools: z.array(z.string()).optional(),
    model: z.string().optional(),
    reasoning_effort: z.string().optional(),
    timeout_ms: z
      .number()
      .int("timeout_ms must be an integer")
      .positive("timeout_ms must be positive")
      .max(3_600_000, "timeout_ms must not exceed 3600000 (1 hour)")
      .optional(),
    /**
     * Optional explicit mutability override. When `allowed_tools` includes
     * mutating/exec tools (write/edit/bash/hashline_edit/ast_replace) the
     * loader auto-promotes the agent to `full-access`. Set this field to
     * `read-only` to force stripping of those tools, or to `full-access`
     * to opt in to write capability without listing a mutating tool.
     */
    mutability: z.enum(["read-only", "full-access"]).optional(),
    /**
     * How the system prompt is assembled. Mirrors `SubAgentDeclaration.promptMode`.
     * - `"static"` (default) — use `system_prompt` verbatim.
     * - `"append"` — reserved; not yet supported (throws at execution time).
     */
    prompt_mode: z.enum(["static", "append"]).optional(),
    /**
     * Optional fallback model chain for provider/model unavailability errors.
     * Mirrors `ModelOverrides.fallbackModels`. Folded into `staticOverrides` by the loader.
     */
    fallback_models: z
      .array(z.string().min(1, "fallback_models entries must be non-empty strings"))
      .max(5, "fallback_models must not exceed 5 entries")
      .refine((arr) => new Set(arr).size === arr.length, {
        message: "fallback_models must not contain duplicate entries",
      })
      .optional(),
  })
  .refine((d) => !(d.allowed_tools && d.denied_tools), {
    message: "allowed_tools and denied_tools are mutually exclusive",
  });

type YamlSubAgentInput = z.infer<typeof YamlSubAgentSchema>;

// ---------------------------------------------------------------------------
// Directory resolution
// ---------------------------------------------------------------------------

function resolveSubAgentDir(): string {
  const agentDir = process.env.PI_AGENT_DIR;
  if (agentDir) {
    return path.join(agentDir, "sub-agents");
  }
  return path.join(os.homedir(), ".pi", "agent", "sub-agents");
}

// ---------------------------------------------------------------------------
// Single-file parsing
// ---------------------------------------------------------------------------

function parseYamlFile(
  content: string,
): { ok: true; value: YamlSubAgentInput } | { ok: false; reason: string } {
  let raw: unknown;
  try {
    raw = parseYaml(content);
  } catch (err) {
    return { ok: false, reason: `YAML syntax error: ${(err as Error).message}` };
  }

  const result = YamlSubAgentSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => {
      const p = i.path.length > 0 ? `${i.path.join(".")}: ` : "";
      return `${p}${i.message}`;
    });
    return { ok: false, reason: `Schema validation failed: ${issues.join("; ")}` };
  }

  return { ok: true, value: result.data };
}

// ---------------------------------------------------------------------------
// Tool validation
// ---------------------------------------------------------------------------

function validateYamlTools(input: YamlSubAgentInput): { ok: true } | { ok: false; reason: string } {
  const toolNames = input.allowed_tools ?? input.denied_tools;
  if (!toolNames || toolNames.length === 0) return { ok: true };

  const { unknown } = validateToolNames(toolNames);
  if (unknown.length > 0) {
    const field = input.allowed_tools ? "allowed_tools" : "denied_tools";
    return {
      ok: false,
      reason: `Unknown tool names in ${field}: ${unknown.join(", ")}`,
    };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Declaration conversion
// ---------------------------------------------------------------------------

type YamlAgentParams = { prompt: string };

const YAML_AGENT_PARAMETERS = Type.Object({
  prompt: Type.String({ description: "The task or question for this agent" }),
});

function toDeclaration(
  input: YamlSubAgentInput,
  sourcePath?: string,
): SubAgentDeclaration<YamlAgentParams> {
  const toolStrategy = input.allowed_tools
    ? { kind: "allowlist" as const, tools: input.allowed_tools }
    : input.denied_tools
      ? { kind: "denylist" as const, tools: input.denied_tools }
      : undefined;

  // YAML default-mode base set: read/search/docs only. Mutating tools are
  // never granted unless `allowed_tools` explicitly opts in.
  const yamlSafeBaseTools = (): readonly string[] => {
    const enabled = getEnabledSet().tools;
    const base = new Set<string>();
    for (const name of READ_SEARCH_DOCS_TOOLS) base.add(name);
    for (const name of PI_DEFAULT_TOOLS) base.add(name);
    // Filter extension tools by enabledSet so globally disabled extension
    // tools never enter the candidate list. Pi built-ins remain (the
    // finalizer still applies the global denylist on top).
    return [...base].filter((t) => enabled.has(t) || !EXTENSION_TOOL_NAMES.has(t));
  };

  const allowedTools: SubAgentDeclaration<YamlAgentParams>["allowedTools"] = toolStrategy
    ? toolStrategy.kind === "allowlist"
      ? toolStrategy.tools
      : () => {
          const denied = new Set(toolStrategy.tools);
          return yamlSafeBaseTools().filter((t) => !denied.has(t));
        }
    : () => yamlSafeBaseTools();

  const staticOverrides =
    input.model || input.reasoning_effort || input.timeout_ms || input.fallback_models
      ? {
          model: input.model,
          reasoningEffort: input.reasoning_effort,
          timeoutMs: input.timeout_ms,
          fallbackModels: input.fallback_models,
        }
      : undefined;

  // Auto-detect mutability for allowlist mode unless explicitly set.
  const declaredMutability: AgentMutability =
    input.mutability ??
    (input.allowed_tools?.some((t) => MUTATING_EXEC_TOOLS.has(t)) ? "full-access" : "read-only");

  return defineSubAgent<YamlAgentParams>({
    name: input.name,
    toolName: `delegate_${input.name}`,
    description: input.description,
    parameters: YAML_AGENT_PARAMETERS,
    systemPrompt: input.system_prompt,
    allowedTools,
    mutability: declaredMutability,
    finalizeMode: "lenient",
    source: "yaml",
    sourcePath,
    promptMode: input.prompt_mode,
    buildUserPrompt(params: YamlAgentParams) {
      return params.prompt;
    },
    staticOverrides,
  });
}

// ---------------------------------------------------------------------------
// Public loader
// ---------------------------------------------------------------------------

export interface LoadYamlDeclarationsResult {
  declarations: SubAgentDeclaration[];
  diagnostics: YamlDiagnostics;
}

/**
 * Loads YAML sub-agent declarations from `$PI_AGENT_DIR/sub-agents/*.yaml`.
 * Invalid files are logged as warnings and skipped.
 * Duplicate names (against `reservedNames` builtins or earlier YAML files)
 * are skipped with diagnostics rather than throwing.
 * Returns successfully validated declarations plus full load diagnostics.
 */
export async function loadYamlDeclarations(
  reservedNames: readonly string[] = [],
): Promise<LoadYamlDeclarationsResult> {
  const logger = getLogger();
  const dir = resolveSubAgentDir();

  const scannedFiles: string[] = [];
  const loadedDeclarations: YamlLoadedDeclaration[] = [];
  const skippedFiles: YamlSkippedFile[] = [];

  let entries: string[];
  try {
    const allEntries = await fs.readdir(dir);
    entries = allEntries.filter((e) => e.endsWith(".yaml") || e.endsWith(".yml")).sort();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      logger.debug("No sub-agents directory found, skipping YAML loading", { dir });
      return {
        declarations: [],
        diagnostics: {
          directory: dir,
          directoryExists: false,
          scannedFiles: [],
          loadedDeclarations: [],
          skippedFiles: [],
        },
      };
    }
    logger.warn("Failed to read sub-agents directory", { dir, code });
    return {
      declarations: [],
      diagnostics: {
        directory: dir,
        directoryExists: false,
        scannedFiles: [],
        loadedDeclarations: [],
        skippedFiles: [{ file: "<directory>", reason: `Failed to read directory: ${code}` }],
      },
    };
  }

  scannedFiles.push(...entries);

  if (entries.length === 0) {
    logger.debug("No YAML sub-agent files found", { dir });
    return {
      declarations: [],
      diagnostics: {
        directory: dir,
        directoryExists: true,
        scannedFiles: [],
        loadedDeclarations: [],
        skippedFiles: [],
      },
    };
  }

  const declarations: SubAgentDeclaration[] = [];
  // name -> basename of the file that accepted the declaration
  const acceptedNamesByFile = new Map<string, string>();
  const reservedSet = new Set(reservedNames);

  for (const entry of entries) {
    const filePath = path.join(dir, entry);

    let content: string;
    try {
      content = await fs.readFile(filePath, "utf8");
    } catch (err) {
      logger.warn("Failed to read YAML sub-agent file", {
        file: entry,
        error: (err as Error).message,
      });
      skippedFiles.push({ file: entry, reason: `Failed to read file: ${(err as Error).message}` });
      continue;
    }

    const parseResult = parseYamlFile(content);
    if (!parseResult.ok) {
      logger.warn("Skipping invalid YAML sub-agent file", {
        file: entry,
        reason: parseResult.reason,
      });
      skippedFiles.push({ file: entry, reason: parseResult.reason });
      continue;
    }

    const toolResult = validateYamlTools(parseResult.value);
    if (!toolResult.ok) {
      logger.warn("Skipping YAML sub-agent with invalid tools", {
        file: entry,
        reason: toolResult.reason,
      });
      skippedFiles.push({ file: entry, reason: toolResult.reason });
      continue;
    }

    const agentName = parseResult.value.name;

    // Check conflict with builtin names
    if (reservedSet.has(agentName)) {
      const reason = `Name conflicts with builtin sub-agent "${agentName}"`;
      logger.warn("Skipping YAML sub-agent due to name conflict with builtin", {
        file: entry,
        name: agentName,
      });
      skippedFiles.push({
        file: entry,
        reason,
        conflictWith: { source: "builtin", name: agentName },
      });
      continue;
    }

    // Check conflict with earlier YAML files
    const earlierFile = acceptedNamesByFile.get(agentName);
    if (earlierFile !== undefined) {
      const reason = `Name conflicts with earlier YAML file ${earlierFile}`;
      logger.warn("Skipping YAML sub-agent due to name conflict with earlier YAML file", {
        file: entry,
        name: agentName,
        earlierFile,
      });
      skippedFiles.push({
        file: entry,
        reason,
        conflictWith: { source: "yaml", name: agentName, file: earlierFile },
      });
      continue;
    }

    declarations.push(toDeclaration(parseResult.value, filePath));
    acceptedNamesByFile.set(agentName, entry);
    loadedDeclarations.push({ name: agentName, file: entry });
    logger.info("Loaded YAML sub-agent declaration", {
      name: agentName,
      file: entry,
    });
  }

  return {
    declarations,
    diagnostics: {
      directory: dir,
      directoryExists: true,
      scannedFiles,
      loadedDeclarations,
      skippedFiles,
    },
  };
}
