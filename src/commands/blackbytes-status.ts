import { type EnabledSet, getEnabledSet } from "../config/enabled-set.js";
import { loadBlackbytesConfig } from "../config/loader.js";
import {
  getSystemPromptLogConfig,
  resolveSystemPromptLogPath,
} from "../shared/system-prompt-log.js";
import { type YamlDiagnostics, getYamlDiagnostics } from "../sub-agents/diagnostics.js";
import { getAgentSnapshot } from "../sub-agents/snapshot.js";
import type { AgentSnapshot } from "../sub-agents/snapshot.js";
import { getCompactToolsConfig } from "../tools/compact-tools/index.js";

const SECRET_KEYS = ["api_key", "exa_api_key", "tavily_api_key", "authorization"];

function redactValue(key: string, value: unknown): unknown {
  if (typeof value === "string" && SECRET_KEYS.some((k) => key.toLowerCase().includes(k))) {
    return "[REDACTED]";
  }
  return value;
}

function redactConfig(config: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      result[key] = redactConfig(value as Record<string, unknown>);
    } else {
      result[key] = redactValue(key, value);
    }
  }
  return result;
}

/**
 * Identify per-agent settings that are accepted by the schema but not yet
 * threaded into the nested Pi CLI. These are surfaced under a dedicated
 * "Reserved / Unsupported" section so users can see at a glance that the
 * value is preserved without effect.
 *
 * Currently `temperature` is the only such field: the installed Pi CLI does
 * not accept `--temperature` (see PI_CLI_COMPATIBILITY_EVIDENCE in
 * src/sub-agents/__tests__/runner.test.ts), and the runner therefore never
 * emits the flag.
 */
const RESERVED_AGENT_FIELDS = ["temperature"] as const;

function collectReservedAgentSettings(
  subAgents: unknown,
): Array<{ agent: string; field: string; value: unknown }> {
  if (!subAgents || typeof subAgents !== "object" || Array.isArray(subAgents)) {
    return [];
  }
  const out: Array<{ agent: string; field: string; value: unknown }> = [];
  for (const [agent, settings] of Object.entries(subAgents as Record<string, unknown>)) {
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) continue;
    const obj = settings as Record<string, unknown>;
    for (const field of RESERVED_AGENT_FIELDS) {
      if (field in obj && obj[field] !== undefined) {
        out.push({ agent, field, value: obj[field] });
      }
    }
  }
  return out;
}

function collectReservedFromSnapshot(
  snapshot: ReadonlyMap<string, AgentSnapshot>,
): Array<{ agent: string; field: string; value: unknown }> {
  const out: Array<{ agent: string; field: string; value: unknown }> = [];
  for (const [agent, snap] of snapshot) {
    for (const field of RESERVED_AGENT_FIELDS) {
      if (field in snap.reserved && snap.reserved[field] !== undefined) {
        out.push({ agent, field, value: snap.reserved[field] });
      }
    }
  }
  return out;
}

function buildSnapshotSection(snapshot: ReadonlyMap<string, AgentSnapshot>): string[] {
  const lines: string[] = [
    "### Sub-Agent Snapshot",
    "_Resolved at session_start; immutable for the life of this session._",
    "",
  ];
  if (snapshot.size === 0) {
    lines.push("_No sub-agents registered._");
    return lines;
  }
  for (const snap of snapshot.values()) {
    const origin =
      snap.source === "yaml" && snap.sourcePath ? `yaml (${snap.sourcePath})` : snap.source;
    lines.push(`- **${snap.name}** — source: ${origin}`);
    if (snap.model) lines.push(`  - model: \`${snap.model}\``);
    if (snap.reasoningEffort) lines.push(`  - reasoningEffort: \`${snap.reasoningEffort}\``);
    if (snap.timeoutMs !== undefined) lines.push(`  - timeoutMs: ${snap.timeoutMs}`);
    // Fallback chain (only show when configured)
    if (snap.fallbackModels && snap.fallbackModels.length > 0) {
      const chain = snap.fallbackModels.map((m) => `\`${m}\``).join(" → ");
      const eligibility = snap.fallbackEligible
        ? ""
        : " _(ineligible — mutating/full-access tool policy)_";
      lines.push(`  - fallbackModels: ${chain}${eligibility}`);
    }
    // Allowed tools summary
    const ts = snap.allowedToolsSummary;
    if (ts.mode === "exact") {
      const toolList = ts.tools.map((t) => `\`${t}\``).join(", ");
      lines.push(`  - allowedTools (${ts.tools.length}): ${toolList}`);
    } else {
      const { read, mutate, pi_builtin, extension } = ts.categories;
      lines.push(
        `  - allowedTools (${ts.total}): ${read} read/search/docs, ${mutate} mutating, ${pi_builtin} pi-builtin (extension: ${extension})`,
      );
    }
    const reservedKeys = Object.keys(snap.reserved);
    if (reservedKeys.length > 0) {
      lines.push(`  - reserved: ${reservedKeys.map((k) => `\`${k}\``).join(", ")}`);
    }
    const extraKeys = Object.keys(snap.extra);
    if (extraKeys.length > 0) {
      lines.push(`  - extra: ${extraKeys.map((k) => `\`${k}\``).join(", ")}`);
    }
  }
  lines.push("");
  lines.push(
    "_If you edit settings.json or YAML files now, changes will take effect on the next session_start._",
  );
  return lines;
}

function buildYamlDiagnosticsSection(diag: YamlDiagnostics | undefined): string[] {
  if (!diag) {
    return ["### YAML Sub-Agents", "_No YAML diagnostics available (session_start has not run)._"];
  }
  const lines: string[] = ["### YAML Sub-Agents"];
  const dirStatus = diag.directoryExists ? "exists" : "not found";
  lines.push(`- directory: \`${diag.directory}\` (${dirStatus})`);
  lines.push(`- scanned: ${diag.scannedFiles.length} files`);

  if (diag.loadedDeclarations.length === 0) {
    lines.push("- loaded: 0");
  } else {
    const names = diag.loadedDeclarations.map((d) => `\`${d.name}\``).join(", ");
    lines.push(`- loaded: ${diag.loadedDeclarations.length} (${names})`);
  }

  if (diag.skippedFiles.length === 0) {
    lines.push("- skipped: 0");
  } else {
    lines.push(`- skipped: ${diag.skippedFiles.length}`);
    for (const skip of diag.skippedFiles) {
      let line = `  - \`${skip.file}\` — ${skip.reason}`;
      if (skip.conflictWith) {
        const cw = skip.conflictWith;
        if (cw.source === "builtin") {
          line += " (winning source: builtin)";
        } else {
          line += ` (winning source: yaml \`${cw.file}\`)`;
        }
      }
      lines.push(line);
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Section builder — collects all status sections into a keyed map so the
// interactive picker (and full-output path) can reuse the same data.
// ---------------------------------------------------------------------------

interface StatusSections {
  overview: string[];
  enabledTools: string[];
  enabledSubAgents: string[];
  enabledSkills: string[];
  systemPromptLog: string[];
  compactTools: string[];
  reserved: string[];
  snapshot: string[];
  yaml: string[];
  config: string[];
}

async function buildStatusSections(): Promise<StatusSections> {
  const config = await loadBlackbytesConfig();
  const redacted = redactConfig(config as unknown as Record<string, unknown>);

  let enabledSet: EnabledSet | undefined;
  try {
    enabledSet = getEnabledSet();
  } catch {
    // Not initialized
  }

  const snapshot = getAgentSnapshot();
  const reserved = snapshot
    ? collectReservedFromSnapshot(snapshot)
    : collectReservedAgentSettings((config as unknown as Record<string, unknown>).sub_agents);

  const reservedLines =
    reserved.length === 0
      ? ["### Reserved / Unsupported Settings", "_None._"]
      : [
          "### Reserved / Unsupported Settings",
          "_The following per-agent fields are accepted by the schema and preserved",
          "in your config, but are NOT yet supported by the nested Pi CLI and have",
          "no runtime effect today. They are documented here so that no setting is",
          "silently ignored:_",
          "",
          ...reserved.map(
            (r) =>
              `- \`sub_agents.${r.agent}.${r.field}\` = ${JSON.stringify(r.value)} _(reserved — not passed to nested Pi)_`,
          ),
        ];

  const snapshotLines = snapshot
    ? buildSnapshotSection(snapshot)
    : ["### Sub-Agent Snapshot", "_Not initialized yet (session_start has not run)._"];

  const yamlLines = buildYamlDiagnosticsSection(getYamlDiagnostics());
  const systemPromptLog = getSystemPromptLogConfig(config);
  const systemPromptLogPath = resolveSystemPromptLogPath(systemPromptLog.path, process.cwd());
  const systemPromptLogLines = [
    "### System Prompt Log",
    `- enabled: ${systemPromptLog.enabled}`,
    `- path: \`${systemPromptLogPath}\``,
    `- capture_agent_start: ${systemPromptLog.capture_agent_start}`,
    `- capture_provider_system: ${systemPromptLog.capture_provider_system}`,
    `- include_nested: ${systemPromptLog.include_nested}`,
    `- dedupe: ${systemPromptLog.dedupe}`,
  ];
  const compactTools = getCompactToolsConfig(config);
  const compactToolsLines = [
    "### Compact Tool Output",
    `- enabled: ${compactTools.enabled}`,
    `- default_expanded: ${compactTools.defaultExpanded}`,
    "- command: `/toggle-verbose`",
  ];

  const toolCount = enabledSet ? enabledSet.tools.size : 0;
  const agentCount = enabledSet ? enabledSet.subAgents.size : 0;
  const skillCount = enabledSet ? enabledSet.skills.size : 0;

  const overviewLines = [
    "## Blackbytes Status",
    "",
    `Tools: **${toolCount}** enabled | Agents: **${agentCount}** enabled | Skills: **${skillCount}** enabled`,
  ];

  return {
    overview: overviewLines,
    enabledTools: [
      "### Enabled Tools",
      ...(enabledSet ? [...enabledSet.tools].map((t) => `- ${t}`) : ["_Not initialized._"]),
    ],
    enabledSubAgents: [
      "### Enabled Sub-Agents",
      ...(enabledSet ? [...enabledSet.subAgents].map((a) => `- ${a}`) : ["_Not initialized._"]),
    ],
    enabledSkills: [
      "### Enabled Skills",
      ...(enabledSet ? [...enabledSet.skills].map((s) => `- ${s}`) : ["_Not initialized._"]),
    ],
    systemPromptLog: systemPromptLogLines,
    compactTools: compactToolsLines,
    reserved: reservedLines,
    snapshot: snapshotLines,
    yaml: yamlLines,
    config: ["### Config", "```json", JSON.stringify(redacted, null, 2), "```"],
  };
}

function buildFullOutput(sections: StatusSections): string {
  return [
    ...sections.overview,
    "",
    ...sections.enabledTools,
    "",
    ...sections.enabledSubAgents,
    "",
    ...sections.enabledSkills,
    "",
    ...sections.systemPromptLog,
    "",
    ...sections.compactTools,
    "",
    ...sections.reserved,
    "",
    ...sections.snapshot,
    "",
    ...sections.yaml,
    "",
    ...sections.config,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Section menu labels → section keys
// ---------------------------------------------------------------------------

const SECTION_MENU: Array<{ label: string; key: keyof StatusSections }> = [
  { label: "Enabled Tools", key: "enabledTools" },
  { label: "Enabled Sub-Agents", key: "enabledSubAgents" },
  { label: "Enabled Skills", key: "enabledSkills" },
  { label: "Sub-Agent Snapshot", key: "snapshot" },
  { label: "YAML Diagnostics", key: "yaml" },
  { label: "System Prompt Log", key: "systemPromptLog" },
  { label: "Compact Tool Output", key: "compactTools" },
  { label: "Reserved / Unsupported Settings", key: "reserved" },
  { label: "Full Config (JSON)", key: "config" },
];

const SHOW_ALL_LABEL = "Show All";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface StatusInteractiveCtx {
  ui: {
    select(title: string, options: string[]): Promise<string | undefined>;
  };
}

export async function handleBlackbytesStatus(ctx?: StatusInteractiveCtx): Promise<string> {
  let enabledSet: EnabledSet | undefined;
  try {
    enabledSet = getEnabledSet();
  } catch {
    return "Blackbytes not initialized. Run a session first.";
  }

  // Suppress unused-variable lint — enabledSet is validated above to confirm
  // initialization; the actual data is read inside buildStatusSections().
  void enabledSet;

  const sections = await buildStatusSections();

  if (!ctx) {
    return buildFullOutput(sections);
  }

  // Interactive mode: show overview + section picker
  const menuOptions = [...SECTION_MENU.map((item) => item.label), SHOW_ALL_LABEL];

  const selected = await ctx.ui.select(`Blackbytes Status — ${sections.overview[2]}`, menuOptions);

  if (!selected || selected === SHOW_ALL_LABEL) {
    return buildFullOutput(sections);
  }

  const menuItem = SECTION_MENU.find((item) => item.label === selected);
  if (!menuItem) {
    return buildFullOutput(sections);
  }

  const sectionLines = sections[menuItem.key];
  return [...sections.overview, "", ...sectionLines].join("\n");
}
