import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { createLogger } from "../shared/logger.js";

const logger = createLogger();

const SECRET_KEYS = ["api_key", "exa_api_key", "tavily_api_key"];

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

function atomicWriteJson(filePath: string, data: unknown): void {
  const json = JSON.stringify(data, null, 2);
  // Validate round-trip before writing
  JSON.parse(json);
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, json, "utf8");
  fs.renameSync(tmpPath, filePath);
}

export function registerSetupModelsCommand(pi: ExtensionAPI): void {
  pi.registerCommand("setup-models", {
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const notify = (msg: string, level: "info" | "warning" | "error" = "info") =>
        ctx.ui.notify(msg, level);

      notify("Welcome to the Blackbytes setup wizard!");

      const settingsPath = resolveSettingsPath();

      // --- Read existing settings ---
      const readResult = await readSettingsFile(settingsPath);
      if (!readResult.ok) {
        notify(`Setup aborted: ${readResult.reason}`, "error");
        logger.error("setup-models: failed to read settings", { reason: readResult.reason });
        return;
      }

      const existingSettings = readResult.data;
      const existingBlackbytes = (existingSettings.blackbytes ?? {}) as Record<string, unknown>;

      // If there's existing blackbytes config, confirm overwrite
      const hasExistingKeys = Object.keys(existingBlackbytes).length > 0;
      if (hasExistingKeys) {
        const overwrite = await ctx.ui.confirm(
          "Confirm",
          "Existing blackbytes configuration found. This wizard will overwrite it. Continue?",
        );
        if (!overwrite) {
          notify("Setup cancelled — no changes made.", "info");
          return;
        }
      }

      // --- Provider selection ---
      const PROVIDER_OPTIONS = [
        { label: "Anthropic", value: "anthropic" },
        { label: "OpenAI", value: "openai" },
        { label: "GitHub Copilot", value: "copilot" },
        { label: "Anthropic + OpenAI", value: "anthropic_openai" },
        { label: "All providers", value: "all" },
      ] as const;
      const selectedProviderLabel = await ctx.ui.select(
        "Which AI provider(s) do you want to configure?",
        PROVIDER_OPTIONS.map((o) => o.label),
      );
      const providerChoice =
        PROVIDER_OPTIONS.find((o) => o.label === selectedProviderLabel)?.value ?? "none";

      const providers = new Set<string>();
      if (
        providerChoice === "anthropic" ||
        providerChoice === "anthropic_openai" ||
        providerChoice === "all"
      ) {
        providers.add("anthropic");
      }
      if (
        providerChoice === "openai" ||
        providerChoice === "anthropic_openai" ||
        providerChoice === "all"
      ) {
        providers.add("openai");
      }
      if (providerChoice === "copilot" || providerChoice === "all") {
        providers.add("copilot");
      }

      // Collect packages array (for extension config if needed) — deduped
      const packages = new Set<string>(
        Array.isArray(existingBlackbytes.packages) ? (existingBlackbytes.packages as string[]) : [],
      );

      // --- Collect API keys ---
      const providerKeys: Record<string, string> = {};

      if (providers.has("anthropic")) {
        const key = await ctx.ui.input("Anthropic API key:", "sk-ant-...");
        const trimmed = (key ?? "").trim();
        if (trimmed) {
          providerKeys.anthropic_api_key = trimmed;
        }
        packages.add("anthropic");
      }

      if (providers.has("openai")) {
        const key = await ctx.ui.input("OpenAI API key:", "sk-...");
        const trimmed = (key ?? "").trim();
        if (trimmed) {
          providerKeys.openai_api_key = trimmed;
        }
        packages.add("openai");
      }

      if (providers.has("copilot")) {
        // Copilot uses OAuth — no API key needed
        packages.add("copilot");
        notify("GitHub Copilot uses OAuth — no API key required.", "info");
      }

      // --- Websearch ---
      const WS_OPTIONS = [
        { label: "Exa", value: "exa" },
        { label: "Tavily", value: "tavily" },
        { label: "None", value: "none" },
      ] as const;
      const selectedWsLabel = await ctx.ui.select(
        "Websearch provider:",
        WS_OPTIONS.map((o) => o.label),
      );
      const wsProvider = WS_OPTIONS.find((o) => o.label === selectedWsLabel)?.value ?? "none";

      const websearchConfig: Record<string, unknown> | undefined =
        wsProvider === "none" ? undefined : { provider: wsProvider };

      if (wsProvider === "exa") {
        const key = await ctx.ui.input("Exa API key:", "exa-...");
        const trimmed = (key ?? "").trim();
        if (trimmed && websearchConfig) {
          websearchConfig.exa_api_key = trimmed;
        }
      } else if (wsProvider === "tavily") {
        const key = await ctx.ui.input("Tavily API key:", "tvly-...");
        const trimmed = (key ?? "").trim();
        if (trimmed && websearchConfig) {
          websearchConfig.tavily_api_key = trimmed;
        }
      }

      // --- Context7 ---
      const useContext7 = await ctx.ui.confirm(
        "Context7",
        "Configure Context7 (optional documentation lookup)?",
      );

      let context7Config: { api_key?: string } | undefined;
      if (useContext7) {
        const key = await ctx.ui.input(
          "Context7 API key (optional, press Enter to skip):",
          "ctx7-...",
        );
        const trimmed = (key ?? "").trim();
        context7Config = trimmed ? { api_key: trimmed } : {};
      }

      // --- Default model ---
      const defaultModelRaw = await ctx.ui.input(
        "Default model (e.g. claude-opus-4-5, gpt-4o):",
        "claude-opus-4-5",
      );
      const defaultModel = (defaultModelRaw ?? "").trim();

      // --- Reasoning settings ---
      const REASONING_OPTIONS = [
        { label: "Low", value: "low" },
        { label: "Medium", value: "medium" },
        { label: "High", value: "high" },
      ] as const;
      const selectedReasoningLabel = await ctx.ui.select(
        "Default reasoning effort:",
        REASONING_OPTIONS.map((o) => o.label),
      );
      const reasoningEffort =
        REASONING_OPTIONS.find((o) => o.label === selectedReasoningLabel)?.value ?? "medium";

      // --- Build new blackbytes block ---
      const newBlackbytes: Record<string, unknown> = {
        // Preserve passthrough keys from existing config (unknown keys)
        ...existingBlackbytes,
        // Overwrite known keys
        ...(Object.keys(providerKeys).length > 0 ? providerKeys : {}),
      };

      if (websearchConfig !== undefined) {
        newBlackbytes.websearch = websearchConfig;
      }

      if (context7Config !== undefined) {
        newBlackbytes.context7 = context7Config;
      }

      if (defaultModel) {
        newBlackbytes.default_model = defaultModel;
        newBlackbytes.sub_agents = {
          ...(typeof newBlackbytes.sub_agents === "object" && newBlackbytes.sub_agents !== null
            ? (newBlackbytes.sub_agents as Record<string, unknown>)
            : {}),
        };
      }

      newBlackbytes.reasoning_effort = reasoningEffort;

      if (packages.size > 0) {
        // Deduped array
        newBlackbytes.packages = [...packages];
      }

      // --- Merge with existing non-blackbytes settings ---
      const newSettings: Record<string, unknown> = {
        ...existingSettings,
        blackbytes: newBlackbytes,
      };

      // --- Atomic write ---
      try {
        // Ensure directory exists
        const dir = path.dirname(settingsPath);
        fs.mkdirSync(dir, { recursive: true });

        atomicWriteJson(settingsPath, newSettings);

        logger.info("setup-models: settings written", {
          path: settingsPath,
          // Never log secret values
          keys: Object.keys(newBlackbytes).filter(
            (k) => !SECRET_KEYS.some((s) => k.toLowerCase().includes(s)),
          ),
        });

        notify(`Settings saved to ${settingsPath}`, "info");
        notify("Setup complete! Restart Pi to apply the new configuration.", "info");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        notify(`Failed to write settings: ${message}`, "error");
        logger.error("setup-models: failed to write settings", { error: message });
      }
    },
  });
}
