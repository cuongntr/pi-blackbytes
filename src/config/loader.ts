import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createLogger } from "../shared/logger.js";
import { type BlackbytesConfig, parseBlackbytesConfig } from "./schema.js";

const logger = createLogger();

// In-memory cache to avoid re-reading + parsing settings.json on every tool result
// and provider request. TTL-based invalidation keeps config reasonably fresh
// without the I/O cost.
const CONFIG_CACHE_TTL_MS = 5_000;
let cachedConfig: BlackbytesConfig | undefined;
let cachedConfigAt = 0;
let cachedConfigPath: string | undefined;
function resolveSettingsPath(): string {
  const agentDir = process.env.PI_AGENT_DIR;
  if (agentDir) {
    return path.join(agentDir, "settings.json");
  }
  return path.join(os.homedir(), ".pi", "agent", "settings.json");
}

function getDefaults(): BlackbytesConfig {
  const result = parseBlackbytesConfig({});
  if (result.ok) return result.value;
  // parseBlackbytesConfig({}) should always succeed with all-defaults schema
  return {} as BlackbytesConfig;
}

function cacheResult(config: BlackbytesConfig, settingsPath: string): BlackbytesConfig {
  cachedConfig = config;
  cachedConfigAt = Date.now();
  cachedConfigPath = settingsPath;
  return config;
}

export async function loadBlackbytesConfig(): Promise<BlackbytesConfig> {
  const settingsPath = resolveSettingsPath();

  // Serve from cache if still within TTL (disabled in test mode for isolation).
  // The cache is keyed by settings path so callers that swap PI_AGENT_DIR don't
  // observe stale config from a different agent directory.
  if (
    cachedConfig &&
    cachedConfigPath === settingsPath &&
    process.env.NODE_ENV !== "test" &&
    Date.now() - cachedConfigAt < CONFIG_CACHE_TTL_MS
  ) {
    return cachedConfig;
  }
  let raw: string;
  try {
    raw = await fs.readFile(settingsPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      logger.warn("Settings file not found, using defaults", { path: settingsPath });
    } else {
      logger.warn("Failed to read settings file, using defaults", { path: settingsPath, code });
    }
    return cacheResult(getDefaults(), settingsPath);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.warn("Malformed JSON in settings file, using defaults", { path: settingsPath });
    return cacheResult(getDefaults(), settingsPath);
  }

  if (typeof parsed !== "object" || parsed === null || !("blackbytes" in parsed)) {
    logger.warn("Missing 'blackbytes' key in settings, using defaults", { path: settingsPath });
    return cacheResult(getDefaults(), settingsPath);
  }

  const blackbytesRaw = (parsed as Record<string, unknown>).blackbytes;
  const result = parseBlackbytesConfig(blackbytesRaw);

  if (!result.ok) {
    logger.warn("Invalid blackbytes config, using defaults", { errors: result.errors });
    return cacheResult(getDefaults(), settingsPath);
  }

  logger.info("Loaded blackbytes config", { path: settingsPath });
  return cacheResult(result.value, settingsPath);
}

/** Clear the in-memory config cache (useful for testing). */
export function clearConfigCache(): void {
  cachedConfig = undefined;
  cachedConfigAt = 0;
  cachedConfigPath = undefined;
}
