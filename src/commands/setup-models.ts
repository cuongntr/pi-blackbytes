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

type MappingMode = (typeof MAPPING_MODES)[keyof typeof MAPPING_MODES];

type FieldAction = { kind: "keep" } | { kind: "clear" } | { kind: "set"; value: string };

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

function buildModelChoices(
  models: readonly PiModelLike[],
  currentRef: string | undefined,
  existingModel?: string,
): ModelChoice[] {
  const choices: ModelChoice[] = [];
  if (existingModel) {
    choices.push({
      label: `Keep existing (${existingModel})`,
      action: { kind: "keep" },
    });
  }
  choices.push({ label: INHERIT_MODEL_LABEL, action: { kind: "clear" } });
  for (const model of models) {
    choices.push({
      label: formatModelLabel(model, currentRef),
      action: { kind: "set", value: canonicalModelRef(model) },
    });
  }
  return choices;
}

function buildReasoningChoices(existingReasoning?: string): ModelChoice[] {
  const choices: ModelChoice[] = [];
  if (existingReasoning) {
    choices.push({
      label: `Keep existing (${existingReasoning})`,
      action: { kind: "keep" },
    });
  }
  choices.push({ label: CLEAR_REASONING_LABEL, action: { kind: "clear" } });
  for (const level of REASONING_LEVELS) {
    choices.push({ label: level, action: { kind: "set", value: level } });
  }
  return choices;
}

async function selectAction(
  ctx: ExtensionCommandContext,
  title: string,
  choices: readonly ModelChoice[],
): Promise<FieldAction | undefined> {
  const selectedLabel = await ctx.ui.select(
    title,
    choices.map((choice) => choice.label),
  );
  if (!selectedLabel) return undefined;
  return choices.find((choice) => choice.label === selectedLabel)?.action;
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

      if (selectedMode === MAPPING_MODES.CLEAR_ALL) {
        for (const agent of agents) {
          modelActions.set(agent.name, { kind: "clear" });
        }
      } else if (selectedMode === MAPPING_MODES.ONE_FOR_ALL) {
        const action = await selectAction(
          ctx,
          "Model to use for every Blackbytes sub-agent:",
          buildModelChoices(models, currentRef),
        );
        if (!action) {
          notify("Setup cancelled — no changes made.", "info");
          return;
        }
        for (const agent of agents) {
          modelActions.set(agent.name, action);
        }
      } else {
        for (const agent of agents) {
          const existingModel = getStringField(subAgents[agent.name], "model");
          const action = await selectAction(
            ctx,
            `Model for ${formatAgentForPrompt(agent)}:`,
            buildModelChoices(models, currentRef, existingModel),
          );
          if (!action) {
            notify("Setup cancelled — no changes made.", "info");
            return;
          }
          modelActions.set(agent.name, action);
        }
      }

      const reasoningActions = new Map<string, FieldAction>();
      const configureReasoning = await ctx.ui.confirm(
        "Reasoning / thinking",
        "Also configure per-sub-agent thinking levels? Choose No to preserve existing settings and declaration defaults (for example Oracle's high reasoning).",
      );

      if (configureReasoning) {
        for (const agent of agents) {
          const existingReasoning = getStringField(subAgents[agent.name], "reasoningEffort");
          const action = await selectAction(
            ctx,
            `Thinking level for ${formatAgentForPrompt(agent)}:`,
            buildReasoningChoices(existingReasoning),
          );
          if (!action) {
            notify("Setup cancelled — no changes made.", "info");
            return;
          }
          reasoningActions.set(agent.name, action);
        }
      }

      const legacySetupKeys = findLegacySetupKeys(existingBlackbytes);
      const removeLegacySetupKeys =
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
          removeLegacySetupKeys,
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
