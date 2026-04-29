import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import {
  SUB_AGENTS,
  type SubAgentMeta,
  getRegisteredSubAgents,
} from "../config/resource-metadata.js";
import { createLogger } from "../shared/logger.js";
import { type AgentSnapshot, getAgentSnapshot } from "../sub-agents/snapshot.js";

const logger = createLogger();

const SECRET_KEYS = ["api_key", "exa_api_key", "tavily_api_key"];
const INHERIT_MODEL_LABEL = "Inherit host model (no override)";
const CLEAR_REASONING_LABEL = "Use agent/default thinking (clear override)";
const REASONING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
const MAPPING_MODES = {
  PER_AGENT: "Choose model for each sub-agent",
  ONE_FOR_ALL: "Use one model for all sub-agents",
  CLEAR_ALL: "Clear all model overrides (inherit host model)",
} as const;
const LEGACY_SETUP_KEYS = [
  "anthropic_api_key",
  "openai_api_key",
  "default_model",
  "reasoning_effort",
];
const LEGACY_PROVIDER_PACKAGES = new Set(["anthropic", "openai", "copilot"]);

const GROUPED_THRESHOLD = 10;
const APPLY_REMAINING_PREFIX = "\u2B06 Apply ";
const SKIP_THINKING_REMAINING = "\u23ED Skip thinking for all remaining agents";
const REASONING_MODES = {
  SAME_FOR_ALL: "Same thinking level for all agents",
  PER_AGENT: "Configure thinking per agent",
  SKIP: "Skip (keep existing / use defaults)",
} as const;

type MappingMode = (typeof MAPPING_MODES)[keyof typeof MAPPING_MODES];

type FieldAction = { kind: "keep" } | { kind: "clear" } | { kind: "set"; value: string };

interface ModelSelectionResult {
  action: FieldAction;
  applyToRemaining?: boolean;
}

interface ThinkingSelectionResult {
  action: FieldAction;
  applyToRemaining?: boolean;
  skipRemaining?: boolean;
}

interface PiModelLike {
  readonly id: string;
  readonly provider: string;
  readonly name?: string;
  readonly reasoning?: boolean;
  readonly input?: readonly string[];
}

interface AgentDescriptor {
  readonly name: string;
  readonly description?: string;
  readonly source?: "builtin" | "yaml";
  readonly sourcePath?: string;
}

interface ModelChoice {
  readonly label: string;
  readonly action: FieldAction;
}

function resolveSettingsPath(): string {
  const agentDir = process.env.PI_AGENT_DIR;
  if (agentDir) {
    return path.join(agentDir, "settings.json");
  }
  return path.join(os.homedir(), ".pi", "agent", "settings.json");
}

async function readSettingsFile(
  settingsPath: string,
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; reason: string }> {
  let raw: string;
  try {
    raw = await fsPromises.readFile(settingsPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { ok: true, data: {} };
    }
    return { ok: false, reason: `Cannot read settings file: ${code}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "Settings file contains malformed JSON" };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "Settings file root must be a JSON object" };
  }

  return { ok: true, data: parsed as Record<string, unknown> };
}

function resolveAtomicWriteTarget(filePath: string): string {
  try {
    if (fs.lstatSync(filePath).isSymbolicLink()) {
      return fs.realpathSync(filePath);
    }
  } catch {
    // Missing or broken symlink: fall back to writing the requested path.
  }
  return filePath;
}

function getTargetMode(filePath: string): number {
  try {
    return fs.statSync(filePath).mode & 0o777;
  } catch {
    // settings.json can contain credentials; use a private mode for new files.
    return 0o600;
  }
}

function atomicWriteJson(filePath: string, data: unknown): void {
  const json = JSON.stringify(data, null, 2);
  // Validate round-trip before writing
  JSON.parse(json);

  const targetPath = resolveAtomicWriteTarget(filePath);
  const tmpPath = `${targetPath}.tmp`;
  const mode = getTargetMode(targetPath);

  try {
    fs.rmSync(tmpPath, { force: true });
    fs.writeFileSync(tmpPath, json, { encoding: "utf8", mode });
    fs.chmodSync(tmpPath, mode);
    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // Ignore cleanup failures; the original write error is more useful.
    }
    throw err;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPiModelLike(value: unknown): value is PiModelLike {
  if (!isRecord(value)) return false;
  return typeof value.id === "string" && typeof value.provider === "string";
}

function cloneSubAgentSettings(value: unknown): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  if (!isRecord(value)) return out;
  for (const [agent, settings] of Object.entries(value)) {
    if (isRecord(settings)) {
      out[agent] = { ...settings };
    }
  }
  return out;
}

function mergeSubAgentSettings(
  original: unknown,
  editedObjects: Record<string, Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (isRecord(original)) {
    for (const [agent, settings] of Object.entries(original)) {
      if (!isRecord(settings)) {
        out[agent] = settings;
      }
    }
  }
  for (const [agent, settings] of Object.entries(editedObjects)) {
    out[agent] = settings;
  }
  return out;
}

function getStringField(
  settings: Record<string, unknown> | undefined,
  field: string,
): string | undefined {
  const value = settings?.[field];
  return typeof value === "string" ? value : undefined;
}

function findLegacySetupKeys(blackbytes: Record<string, unknown>): string[] {
  const keys = LEGACY_SETUP_KEYS.filter((key) => key in blackbytes);
  if (
    Array.isArray(blackbytes.packages) &&
    blackbytes.packages.some(
      (item) => typeof item === "string" && LEGACY_PROVIDER_PACKAGES.has(item),
    )
  ) {
    keys.push("packages");
  }
  return keys;
}

function removeLegacySetupConfig(
  blackbytes: Record<string, unknown>,
  legacyKeys: readonly string[],
): void {
  for (const key of legacyKeys) {
    if (key !== "packages") {
      delete blackbytes[key];
    }
  }

  if (!legacyKeys.includes("packages") || !Array.isArray(blackbytes.packages)) return;

  const remainingPackages = blackbytes.packages.filter(
    (item) => !(typeof item === "string" && LEGACY_PROVIDER_PACKAGES.has(item)),
  );
  if (remainingPackages.length > 0) {
    blackbytes.packages = remainingPackages;
  } else {
    delete blackbytes.packages;
  }
}

function canonicalModelRef(model: PiModelLike): string {
  return `${model.provider}/${model.id}`;
}

function formatModelLabel(model: PiModelLike, currentRef: string | undefined): string {
  const ref = canonicalModelRef(model);
  const displayName = model.name && model.name !== model.id ? ` — ${model.name}` : "";
  const badges: string[] = [];
  if (model.reasoning) badges.push("thinking");
  if (model.input?.includes("image")) badges.push("image");
  const badgeText = badges.length > 0 ? ` (${badges.join(", ")})` : "";
  const currentText = ref === currentRef ? " [current]" : "";
  return `${ref}${displayName}${badgeText}${currentText}`;
}

function dedupeModels(models: readonly PiModelLike[]): PiModelLike[] {
  const seen = new Set<string>();
  const out: PiModelLike[] = [];
  for (const model of models) {
    const ref = canonicalModelRef(model);
    if (seen.has(ref)) continue;
    seen.add(ref);
    out.push(model);
  }
  return out;
}

function collectConfiguredPiModels(ctx: ExtensionCommandContext): {
  models: PiModelLike[];
  currentRef?: string;
  warnings: string[];
} {
  const warnings: string[] = [];
  const ctxWithModels = ctx as ExtensionCommandContext & {
    model?: unknown;
    modelRegistry?: {
      refresh?: () => void;
      getAvailable?: () => unknown;
      getError?: () => unknown;
    };
  };
  const currentModel = isPiModelLike(ctxWithModels.model) ? ctxWithModels.model : undefined;
  const currentRef = currentModel ? canonicalModelRef(currentModel) : undefined;
  const registry = ctxWithModels.modelRegistry;

  if (registry?.refresh) {
    try {
      registry.refresh();
    } catch (err) {
      warnings.push(
        `Pi model registry refresh failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (registry?.getError) {
    try {
      const registryError = registry.getError();
      if (typeof registryError === "string" && registryError.length > 0) {
        warnings.push(`Pi models.json warning: ${registryError}`);
      }
    } catch {
      // Ignore diagnostic read failures; getAvailable() below is authoritative for setup.
    }
  }

  let availableModels: PiModelLike[] = [];
  if (registry?.getAvailable) {
    try {
      const raw = registry.getAvailable();
      if (Array.isArray(raw)) {
        availableModels = raw.filter(isPiModelLike);
      }
    } catch (err) {
      warnings.push(
        `Could not read Pi's available models: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const models = dedupeModels([...(currentModel ? [currentModel] : []), ...availableModels]);
  models.sort((a, b) => {
    const aRef = canonicalModelRef(a);
    const bRef = canonicalModelRef(b);
    if (aRef === currentRef) return -1;
    if (bRef === currentRef) return 1;
    const providerCmp = a.provider.localeCompare(b.provider);
    if (providerCmp !== 0) return providerCmp;
    return a.id.localeCompare(b.id);
  });

  return { models, currentRef, warnings };
}

function uniqueMetas(metas: readonly SubAgentMeta[]): SubAgentMeta[] {
  const seen = new Set<string>();
  const out: SubAgentMeta[] = [];
  for (const meta of metas) {
    if (seen.has(meta.name)) continue;
    seen.add(meta.name);
    out.push(meta);
  }
  return out;
}

function descriptorsFromSnapshot(snapshot: ReadonlyMap<string, AgentSnapshot>): AgentDescriptor[] {
  const metaByName = new Map<string, SubAgentMeta>();
  for (const meta of SUB_AGENTS) metaByName.set(meta.name, meta);
  for (const meta of getRegisteredSubAgents()) metaByName.set(meta.name, meta);

  return [...snapshot.values()].map((snap) => {
    const meta = metaByName.get(snap.name);
    return {
      name: snap.name,
      description: meta?.description,
      source: snap.source,
      sourcePath: snap.sourcePath,
    };
  });
}

function getKnownAgents(): AgentDescriptor[] {
  const snapshot = getAgentSnapshot();
  if (snapshot && snapshot.size > 0) {
    return descriptorsFromSnapshot(snapshot);
  }

  const registered = getRegisteredSubAgents();
  const metas = registered.length > 0 ? uniqueMetas(registered) : uniqueMetas(SUB_AGENTS);
  return metas.map((meta) => ({
    name: meta.name,
    description: meta.description,
  }));
}

function formatAgentForPrompt(agent: AgentDescriptor): string {
  const parts = [agent.name];
  if (agent.source === "yaml") parts.push("yaml");
  if (agent.description) parts.push(agent.description);
  return parts.join(" — ");
}

function resolveAssignedModelRef(
  action: FieldAction,
  existingModel: string | undefined,
): string | undefined {
  if (action.kind === "set") return action.value;
  if (action.kind === "keep") return existingModel;
  return undefined; // inherit host model
}

function modelSupportsReasoning(
  modelRef: string | undefined,
  models: readonly PiModelLike[],
): boolean {
  if (!modelRef) return true; // inherit host — assume potentially supported
  const model = models.find((m) => canonicalModelRef(m) === modelRef);
  return model ? (model.reasoning ?? false) : true;
}

function sortModelsWithRecent(
  models: readonly PiModelLike[],
  currentRef: string | undefined,
  recentRefs?: ReadonlySet<string>,
): PiModelLike[] {
  return [...models].sort((a, b) => {
    const aRef = canonicalModelRef(a);
    const bRef = canonicalModelRef(b);

    if (aRef === currentRef) return -1;
    if (bRef === currentRef) return 1;

    const aRecent = recentRefs?.has(aRef) ?? false;
    const bRecent = recentRefs?.has(bRef) ?? false;
    if (aRecent && !bRecent) return -1;
    if (!aRecent && bRecent) return 1;

    const providerCmp = a.provider.localeCompare(b.provider);
    if (providerCmp !== 0) return providerCmp;
    return a.id.localeCompare(b.id);
  });
}

function groupModelsByProvider(models: readonly PiModelLike[]): Map<string, PiModelLike[]> {
  const grouped = new Map<string, PiModelLike[]>();
  for (const model of models) {
    const list = grouped.get(model.provider) ?? [];
    list.push(model);
    grouped.set(model.provider, list);
  }
  return grouped;
}

function buildModelChoices(
  models: readonly PiModelLike[],
  currentRef: string | undefined,
  existingModel?: string,
  options?: {
    applyToRemainingRef?: string;
    recentRefs?: ReadonlySet<string>;
  },
): ModelChoice[] {
  const choices: ModelChoice[] = [];

  if (options?.applyToRemainingRef) {
    choices.push({
      label: `${APPLY_REMAINING_PREFIX}${options.applyToRemainingRef} to all remaining agents`,
      action: { kind: "set", value: options.applyToRemainingRef },
    });
  }

  if (existingModel) {
    choices.push({
      label: `Keep existing (${existingModel})`,
      action: { kind: "keep" },
    });
  }

  choices.push({ label: INHERIT_MODEL_LABEL, action: { kind: "clear" } });

  const sortedModels = options?.recentRefs
    ? sortModelsWithRecent(models, currentRef, options.recentRefs)
    : [...models];

  for (const model of sortedModels) {
    choices.push({
      label: formatModelLabel(model, currentRef),
      action: { kind: "set", value: canonicalModelRef(model) },
    });
  }

  return choices;
}

async function selectModelFlat(
  ctx: ExtensionCommandContext,
  title: string,
  models: readonly PiModelLike[],
  currentRef: string | undefined,
  options?: {
    existingModel?: string;
    applyToRemainingRef?: string;
    recentRefs?: ReadonlySet<string>;
  },
): Promise<ModelSelectionResult | undefined> {
  const choices = buildModelChoices(models, currentRef, options?.existingModel, {
    applyToRemainingRef: options?.applyToRemainingRef,
    recentRefs: options?.recentRefs,
  });
  const selectedLabel = await ctx.ui.select(
    title,
    choices.map((c) => c.label),
  );
  if (!selectedLabel) return undefined;
  const action = choices.find((c) => c.label === selectedLabel)?.action;
  if (!action) return undefined;
  return { action, applyToRemaining: selectedLabel.startsWith(APPLY_REMAINING_PREFIX) };
}

async function selectModelGrouped(
  ctx: ExtensionCommandContext,
  title: string,
  models: readonly PiModelLike[],
  currentRef: string | undefined,
  options?: {
    existingModel?: string;
    applyToRemainingRef?: string;
    recentRefs?: ReadonlySet<string>;
  },
): Promise<ModelSelectionResult | undefined> {
  const grouped = groupModelsByProvider(models);

  // Static choices shown at provider-selection level
  const staticChoices: ModelChoice[] = [];
  if (options?.applyToRemainingRef) {
    staticChoices.push({
      label: `${APPLY_REMAINING_PREFIX}${options.applyToRemainingRef} to all remaining agents`,
      action: { kind: "set", value: options.applyToRemainingRef },
    });
  }
  if (options?.existingModel) {
    staticChoices.push({
      label: `Keep existing (${options.existingModel})`,
      action: { kind: "keep" },
    });
  }
  staticChoices.push({ label: INHERIT_MODEL_LABEL, action: { kind: "clear" } });

  // Build provider labels with model counts and a reverse map for lookup
  const providerLabelToName = new Map<string, string>();
  for (const [provider, providerModels] of grouped) {
    const count = providerModels.length;
    const label = `${provider} (${count} model${count !== 1 ? "s" : ""})`;
    providerLabelToName.set(label, provider);
  }

  const step1Options = [...staticChoices.map((c) => c.label), ...providerLabelToName.keys()];

  while (true) {
    const step1 = await ctx.ui.select(`${title} (select provider)`, step1Options);
    if (!step1) return undefined; // hard cancel

    const staticMatch = staticChoices.find((c) => c.label === step1);
    if (staticMatch) {
      return {
        action: staticMatch.action,
        applyToRemaining: step1.startsWith(APPLY_REMAINING_PREFIX),
      };
    }

    // Provider selected — resolve label back to provider name
    const providerName = providerLabelToName.get(step1);
    if (!providerName) continue;
    const providerModels = grouped.get(providerName) ?? [];
    const sortedModels = sortModelsWithRecent(providerModels, currentRef, options?.recentRefs);
    const modelChoices: ModelChoice[] = sortedModels.map((m) => ({
      label: formatModelLabel(m, currentRef),
      action: { kind: "set", value: canonicalModelRef(m) },
    }));

    const step2 = await ctx.ui.select(
      title,
      modelChoices.map((c) => c.label),
    );
    if (!step2) continue; // cancel step 2 → loop back to provider selection

    const action = modelChoices.find((c) => c.label === step2)?.action;
    if (!action) continue;

    return { action, applyToRemaining: false };
  }
}

async function selectModel(
  ctx: ExtensionCommandContext,
  title: string,
  models: readonly PiModelLike[],
  currentRef: string | undefined,
  options?: {
    existingModel?: string;
    applyToRemainingRef?: string;
    recentRefs?: ReadonlySet<string>;
  },
): Promise<ModelSelectionResult | undefined> {
  if (models.length > GROUPED_THRESHOLD) {
    return selectModelGrouped(ctx, title, models, currentRef, options);
  }
  return selectModelFlat(ctx, title, models, currentRef, options);
}

async function selectThinking(
  ctx: ExtensionCommandContext,
  title: string,
  options?: {
    existingReasoning?: string;
    applyToRemainingLevel?: string;
    showSkipRemaining?: boolean;
  },
): Promise<ThinkingSelectionResult | undefined> {
  const choices: ModelChoice[] = [];

  if (options?.applyToRemainingLevel) {
    choices.push({
      label: `${APPLY_REMAINING_PREFIX}${options.applyToRemainingLevel} to all remaining agents`,
      action: { kind: "set", value: options.applyToRemainingLevel },
    });
  }

  if (options?.existingReasoning) {
    choices.push({
      label: `Keep existing (${options.existingReasoning})`,
      action: { kind: "keep" },
    });
  }

  choices.push({ label: CLEAR_REASONING_LABEL, action: { kind: "clear" } });

  for (const level of REASONING_LEVELS) {
    choices.push({ label: level, action: { kind: "set", value: level } });
  }

  if (options?.showSkipRemaining) {
    choices.push({ label: SKIP_THINKING_REMAINING, action: { kind: "keep" } });
  }

  const selectedLabel = await ctx.ui.select(
    title,
    choices.map((c) => c.label),
  );
  if (!selectedLabel) return undefined;

  if (selectedLabel === SKIP_THINKING_REMAINING) {
    return { action: { kind: "keep" }, skipRemaining: true };
  }

  const action = choices.find((c) => c.label === selectedLabel)?.action;
  if (!action) return undefined;

  return { action, applyToRemaining: selectedLabel.startsWith(APPLY_REMAINING_PREFIX) };
}

function buildSummaryText(
  agents: readonly AgentDescriptor[],
  modelActions: ReadonlyMap<string, FieldAction>,
  reasoningActions: ReadonlyMap<string, FieldAction>,
  existingSubAgents: Record<string, Record<string, unknown>>,
): string {
  const maxNameLen = Math.max(...agents.map((a) => a.name.length), 8);
  const lines: string[] = [];

  for (const agent of agents) {
    const modelAction = modelActions.get(agent.name);
    const reasoningAction = reasoningActions.get(agent.name);
    const existingModel = getStringField(existingSubAgents[agent.name], "model");
    const existingReasoning = getStringField(existingSubAgents[agent.name], "reasoningEffort");

    let modelDisplay: string;
    if (!modelAction || modelAction.kind === "clear") {
      modelDisplay = "(inherit host)";
    } else if (modelAction.kind === "keep") {
      modelDisplay = existingModel ?? "(inherit host)";
    } else {
      modelDisplay = modelAction.value;
    }

    let reasoningDisplay: string;
    if (!reasoningAction) {
      reasoningDisplay = existingReasoning ?? "(default)";
    } else if (reasoningAction.kind === "clear") {
      reasoningDisplay = "(default)";
    } else if (reasoningAction.kind === "keep") {
      reasoningDisplay = existingReasoning ?? "(keep)";
    } else {
      reasoningDisplay = reasoningAction.value;
    }

    const namePad = agent.name.padEnd(maxNameLen);
    lines.push(`  ${namePad} → ${modelDisplay.padEnd(35)} │ thinking: ${reasoningDisplay}`);
  }

  return lines.join("\n");
}

function ensureAgentSettings(
  subAgents: Record<string, Record<string, unknown>>,
  agent: string,
): Record<string, unknown> {
  subAgents[agent] ??= {};
  return subAgents[agent];
}

function pruneAgentSettings(
  subAgents: Record<string, Record<string, unknown>>,
  agent: string,
): void {
  if (Object.keys(subAgents[agent] ?? {}).length === 0) {
    delete subAgents[agent];
  }
}

function applyFieldAction(
  subAgents: Record<string, Record<string, unknown>>,
  agent: string,
  field: "model" | "reasoningEffort",
  action: FieldAction,
): void {
  if (action.kind === "keep") return;

  const settings = ensureAgentSettings(subAgents, agent);
  if (action.kind === "clear") {
    delete settings[field];
  } else {
    settings[field] = action.value;
  }
  pruneAgentSettings(subAgents, agent);
}

function clearModelOverridesForAll(subAgents: Record<string, Record<string, unknown>>): void {
  for (const agent of Object.keys(subAgents)) {
    delete subAgents[agent].model;
    pruneAgentSettings(subAgents, agent);
  }
}

function buildSettingsWithMappings(
  baseSettings: Record<string, unknown>,
  modelActions: ReadonlyMap<string, FieldAction>,
  reasoningActions: ReadonlyMap<string, FieldAction>,
  options: { readonly clearAllModelOverrides: boolean; readonly removeLegacySetupKeys: boolean },
): Record<string, unknown> {
  const baseBlackbytes = isRecord(baseSettings.blackbytes) ? baseSettings.blackbytes : {};
  const subAgents = cloneSubAgentSettings(baseBlackbytes.sub_agents);

  for (const [agent, action] of modelActions) {
    applyFieldAction(subAgents, agent, "model", action);
  }
  if (options.clearAllModelOverrides) {
    clearModelOverridesForAll(subAgents);
  }
  for (const [agent, action] of reasoningActions) {
    applyFieldAction(subAgents, agent, "reasoningEffort", action);
  }

  const newBlackbytes: Record<string, unknown> = {
    // Preserve all existing Blackbytes settings (websearch, context7, disabled tools, etc.).
    ...baseBlackbytes,
  };

  if (options.removeLegacySetupKeys) {
    removeLegacySetupConfig(newBlackbytes, findLegacySetupKeys(baseBlackbytes));
  }

  const mergedSubAgents = mergeSubAgentSettings(baseBlackbytes.sub_agents, subAgents);
  if (Object.keys(mergedSubAgents).length > 0) {
    newBlackbytes.sub_agents = mergedSubAgents;
  } else {
    delete newBlackbytes.sub_agents;
  }

  return {
    ...baseSettings,
    blackbytes: newBlackbytes,
  };
}

export function registerSetupModelsCommand(pi: ExtensionAPI): void {
  pi.registerCommand("setup-models", {
    description: "Map Blackbytes sub-agents to models already configured in Pi",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const notify = (msg: string, level: "info" | "warning" | "error" = "info") =>
        ctx.ui.notify(msg, level);

      notify("Blackbytes model mapping wizard: using models already configured in Pi.");

      const settingsPath = resolveSettingsPath();

      // --- Read existing settings ---
      const readResult = await readSettingsFile(settingsPath);
      if (!readResult.ok) {
        notify(`Setup aborted: ${readResult.reason}`, "error");
        logger.error("setup-models: failed to read settings", { reason: readResult.reason });
        return;
      }

      const existingSettings = readResult.data;
      const existingBlackbytes = isRecord(existingSettings.blackbytes)
        ? existingSettings.blackbytes
        : {};
      const subAgents = cloneSubAgentSettings(existingBlackbytes.sub_agents);
      const agents = getKnownAgents();

      if (agents.length === 0) {
        notify("Setup aborted: no Blackbytes sub-agents are registered in this session.", "error");
        return;
      }

      const { models, currentRef, warnings } = collectConfiguredPiModels(ctx);
      for (const warning of warnings) {
        notify(warning, "warning");
      }

      if (models.length === 0) {
        notify(
          "Pi has no available configured models. You can still clear existing Blackbytes model overrides, but configure models with Pi first (for example /model, /login, or ~/.pi/agent/models.json) before assigning new mappings.",
          "warning",
        );
      }

      if (Object.keys(subAgents).length > 0) {
        const proceed = await ctx.ui.confirm(
          "Update Blackbytes model mappings?",
          "Existing blackbytes.sub_agents settings were found. This wizard updates only per-agent model/reasoning fields and preserves other Blackbytes settings. Continue?",
        );
        if (!proceed) {
          notify("Setup cancelled — no changes made.", "info");
          return;
        }
      }

      const mappingModes =
        models.length > 0
          ? [MAPPING_MODES.PER_AGENT, MAPPING_MODES.ONE_FOR_ALL, MAPPING_MODES.CLEAR_ALL]
          : [MAPPING_MODES.CLEAR_ALL];
      const selectedMode = (await ctx.ui.select("Model mapping mode:", mappingModes)) as
        | MappingMode
        | undefined;

      if (!selectedMode) {
        notify("Setup cancelled — no changes made.", "info");
        return;
      }

      const modelActions = new Map<string, FieldAction>();
      const reasoningActions = new Map<string, FieldAction>();

      // ── CLEAR ALL ────────────────────────────────────────────────────────────
      if (selectedMode === MAPPING_MODES.CLEAR_ALL) {
        for (const agent of agents) {
          modelActions.set(agent.name, { kind: "clear" });
        }

        // ── ONE FOR ALL ───────────────────────────────────────────────────────
      } else if (selectedMode === MAPPING_MODES.ONE_FOR_ALL) {
        // a. Select model
        const modelResult = await selectModel(
          ctx,
          "Model to use for every Blackbytes sub-agent:",
          models,
          currentRef,
        );
        if (!modelResult) {
          notify("Setup cancelled — no changes made.", "info");
          return;
        }
        for (const agent of agents) {
          modelActions.set(agent.name, modelResult.action);
        }

        // b. Select reasoning mode
        const reasoningMode = await ctx.ui.select("Reasoning / thinking configuration:", [
          REASONING_MODES.SAME_FOR_ALL,
          REASONING_MODES.PER_AGENT,
          REASONING_MODES.SKIP,
        ]);
        if (!reasoningMode) {
          notify("Setup cancelled — no changes made.", "info");
          return;
        }

        if (reasoningMode === REASONING_MODES.SAME_FOR_ALL) {
          // c. One thinking level → apply to all agents with reasoning-capable models
          const thinkingResult = await selectThinking(ctx, "Thinking level for all agents:");
          if (!thinkingResult) {
            notify("Setup cancelled — no changes made.", "info");
            return;
          }
          for (const agent of agents) {
            const existingModel = getStringField(subAgents[agent.name], "model");
            const assignedModelRef = resolveAssignedModelRef(modelResult.action, existingModel);
            if (!modelSupportsReasoning(assignedModelRef, models)) {
              notify(
                `Skipping thinking level for ${agent.name}: assigned model does not support reasoning.`,
                "warning",
              );
              reasoningActions.set(agent.name, { kind: "clear" });
            } else {
              reasoningActions.set(agent.name, thinkingResult.action);
            }
          }
        } else if (reasoningMode === REASONING_MODES.PER_AGENT) {
          // d. Per-agent thinking with shortcuts
          let applyThinkingToRemaining: FieldAction | undefined;
          let skipThinkingForRemaining = false;
          let lastThinkingAction: FieldAction | undefined;

          for (let i = 0; i < agents.length; i++) {
            const agent = agents[i];
            const remaining = agents.length - i - 1;

            if (skipThinkingForRemaining) continue;

            if (applyThinkingToRemaining) {
              reasoningActions.set(agent.name, applyThinkingToRemaining);
              continue;
            }

            const existingModel = getStringField(subAgents[agent.name], "model");
            const modelAction = modelActions.get(agent.name);
            const assignedModelRef = modelAction
              ? resolveAssignedModelRef(modelAction, existingModel)
              : existingModel;

            if (!modelSupportsReasoning(assignedModelRef, models)) {
              notify(
                `Skipping thinking level for ${agent.name}: assigned model does not support reasoning.`,
                "warning",
              );
              reasoningActions.set(agent.name, { kind: "clear" });
              continue;
            }

            const existingReasoning = getStringField(subAgents[agent.name], "reasoningEffort");
            const thinkingResult = await selectThinking(
              ctx,
              `Thinking level for ${formatAgentForPrompt(agent)}:`,
              {
                existingReasoning,
                applyToRemainingLevel:
                  lastThinkingAction?.kind === "set" ? lastThinkingAction.value : undefined,
                showSkipRemaining: remaining > 0,
              },
            );

            if (!thinkingResult) {
              notify("Setup cancelled — no changes made.", "info");
              return;
            }

            if (thinkingResult.skipRemaining) {
              skipThinkingForRemaining = true;
              continue;
            }

            if (thinkingResult.applyToRemaining) {
              applyThinkingToRemaining = thinkingResult.action;
            }

            reasoningActions.set(agent.name, thinkingResult.action);
            lastThinkingAction = thinkingResult.action;
          }
        }
        // REASONING_MODES.SKIP → no reasoning actions

        // ── PER AGENT ─────────────────────────────────────────────────────────
      } else {
        let applyModelToRemaining: FieldAction | undefined;
        let applyThinkingToRemaining: FieldAction | undefined;
        let skipThinkingForRemaining = false;
        let lastModelRef: string | undefined;
        let lastThinkingAction: FieldAction | undefined;
        const recentModelRefs = new Set<string>();

        for (let i = 0; i < agents.length; i++) {
          const agent = agents[i];
          const remaining = agents.length - i - 1;

          // a. MODEL
          let modelAction: FieldAction;
          if (applyModelToRemaining) {
            modelAction = applyModelToRemaining;
          } else {
            const existingModel = getStringField(subAgents[agent.name], "model");
            const modelResult = await selectModel(
              ctx,
              `Model for ${formatAgentForPrompt(agent)}:`,
              models,
              currentRef,
              {
                existingModel,
                applyToRemainingRef:
                  lastModelRef !== undefined && remaining > 0 ? lastModelRef : undefined,
                recentRefs: recentModelRefs.size > 0 ? recentModelRefs : undefined,
              },
            );
            if (!modelResult) {
              notify("Setup cancelled — no changes made.", "info");
              return;
            }
            modelAction = modelResult.action;
            if (modelResult.applyToRemaining) {
              applyModelToRemaining = modelAction;
            }
          }

          modelActions.set(agent.name, modelAction);

          // Track recent model refs for smart ordering
          if (modelAction.kind === "set") {
            recentModelRefs.add(modelAction.value);
            lastModelRef = modelAction.value;
          } else if (modelAction.kind === "keep") {
            const existingModel = getStringField(subAgents[agent.name], "model");
            if (existingModel) {
              recentModelRefs.add(existingModel);
              lastModelRef = existingModel;
            }
          }

          // b. THINKING
          if (skipThinkingForRemaining) continue;

          if (applyThinkingToRemaining) {
            reasoningActions.set(agent.name, applyThinkingToRemaining);
            continue;
          }

          const existingModel = getStringField(subAgents[agent.name], "model");
          const assignedModelRef = resolveAssignedModelRef(modelAction, existingModel);

          if (!modelSupportsReasoning(assignedModelRef, models)) {
            notify(
              `Skipping thinking level for ${agent.name}: assigned model does not support reasoning.`,
              "warning",
            );
            reasoningActions.set(agent.name, { kind: "clear" });
            continue;
          }

          const existingReasoning = getStringField(subAgents[agent.name], "reasoningEffort");
          const thinkingResult = await selectThinking(
            ctx,
            `Thinking level for ${formatAgentForPrompt(agent)}:`,
            {
              existingReasoning,
              applyToRemainingLevel:
                lastThinkingAction?.kind === "set" ? lastThinkingAction.value : undefined,
              showSkipRemaining: remaining > 0,
            },
          );

          if (!thinkingResult) {
            notify("Setup cancelled — no changes made.", "info");
            return;
          }

          if (thinkingResult.skipRemaining) {
            skipThinkingForRemaining = true;
            continue;
          }

          if (thinkingResult.applyToRemaining) {
            applyThinkingToRemaining = thinkingResult.action;
          }

          reasoningActions.set(agent.name, thinkingResult.action);
          lastThinkingAction = thinkingResult.action;
        }
      }

      // ── SUMMARY ──────────────────────────────────────────────────────────────
      const summaryText = buildSummaryText(agents, modelActions, reasoningActions, subAgents);
      const confirmed = await ctx.ui.confirm("Save model mappings?", summaryText);
      if (!confirmed) {
        notify("Setup cancelled — no changes made.", "info");
        return;
      }

      // ── LEGACY CLEANUP ────────────────────────────────────────────────────────
      const legacySetupKeys = findLegacySetupKeys(existingBlackbytes);
      const shouldRemoveLegacyKeys =
        legacySetupKeys.length > 0
          ? await ctx.ui.confirm(
              "Remove legacy /setup-models keys?",
              `Older versions wrote provider/default-model keys that Blackbytes does not use: ${legacySetupKeys.join(", ")}. Remove them now?`,
            )
          : false;

      // Re-read immediately before writing so a long interactive setup does not
      // clobber unrelated settings changes made while the user was answering prompts.
      const latestReadResult = await readSettingsFile(settingsPath);
      if (!latestReadResult.ok) {
        notify(`Setup aborted before write: ${latestReadResult.reason}`, "error");
        logger.error("setup-models: failed to re-read settings before write", {
          reason: latestReadResult.reason,
        });
        return;
      }

      const newSettings = buildSettingsWithMappings(
        latestReadResult.data,
        modelActions,
        reasoningActions,
        {
          clearAllModelOverrides: selectedMode === MAPPING_MODES.CLEAR_ALL,
          removeLegacySetupKeys: shouldRemoveLegacyKeys,
        },
      );
      const newBlackbytes = newSettings.blackbytes as Record<string, unknown>;

      // --- Atomic write ---
      try {
        // Ensure directory exists
        const dir = path.dirname(settingsPath);
        fs.mkdirSync(dir, { recursive: true });

        atomicWriteJson(settingsPath, newSettings);

        logger.info("setup-models: model mappings written", {
          path: settingsPath,
          agents: agents.map((agent) => agent.name),
          keys: Object.keys(newBlackbytes).filter(
            (k) => !SECRET_KEYS.some((s) => k.toLowerCase().includes(s)),
          ),
        });

        notify(`Model mappings saved to ${settingsPath}`, "info");
        notify(
          "Run /reload or start a new Pi session so Blackbytes rebuilds its sub-agent snapshot.",
          "info",
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        notify(`Failed to write settings: ${message}`, "error");
        logger.error("setup-models: failed to write settings", { error: message });
      }
    },
  });
}
