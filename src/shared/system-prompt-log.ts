import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BlackbytesConfig } from "../config/schema.js";
import { getLogger } from "./logger.js";

export interface SystemPromptLogConfig {
  readonly enabled: boolean;
  readonly path?: string;
  readonly capture_agent_start: boolean;
  readonly capture_provider_system: boolean;
  readonly include_nested: boolean;
  readonly dedupe: boolean;
}

export interface ProviderSystemExtraction {
  readonly providerShape: string;
  readonly prompt: string;
}

interface SystemPromptLogEntry {
  readonly ts: string;
  readonly source: "agent_start" | "before_provider_request";
  readonly sessionId?: string;
  readonly sessionFile?: string;
  readonly cwd?: string;
  readonly model?: string;
  readonly nestedDepth: number;
  readonly chars: number;
  readonly sha256: string;
  readonly providerShape?: string;
  readonly prompt: string;
}

const DEFAULT_LOG_PATH = path.join(
  os.homedir(),
  ".pi",
  "logs",
  "pi-blackbytes-system-prompts.jsonl",
);

const DEFAULT_CONFIG: SystemPromptLogConfig = {
  enabled: false,
  capture_agent_start: true,
  capture_provider_system: false,
  include_nested: false,
  dedupe: true,
};

const seenEntries = new Set<string>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function nestedDepth(): number {
  const parsed = Number.parseInt(process.env.PI_NESTED_DEPTH ?? "0", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function expandHome(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

export function resolveSystemPromptLogPath(
  configuredPath: string | undefined,
  cwd: string,
): string {
  if (!configuredPath) return DEFAULT_LOG_PATH;
  const expanded = expandHome(configuredPath);
  return path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
}

export function getSystemPromptLogConfig(config: BlackbytesConfig): SystemPromptLogConfig {
  const raw: Partial<SystemPromptLogConfig> = config.system_prompt_log ?? {};
  return {
    enabled: raw.enabled ?? DEFAULT_CONFIG.enabled,
    path: raw.path,
    capture_agent_start: raw.capture_agent_start ?? DEFAULT_CONFIG.capture_agent_start,
    capture_provider_system: raw.capture_provider_system ?? DEFAULT_CONFIG.capture_provider_system,
    include_nested: raw.include_nested ?? DEFAULT_CONFIG.include_nested,
    dedupe: raw.dedupe ?? DEFAULT_CONFIG.dedupe,
  };
}

function shouldSkip(config: SystemPromptLogConfig): boolean {
  return !config.enabled || (!config.include_nested && nestedDepth() > 0);
}

function modelLabel(ctx: ExtensionContext): string | undefined {
  const model = ctx.model as { provider?: unknown; id?: unknown } | undefined;
  if (!model || typeof model.id !== "string") return undefined;
  return typeof model.provider === "string" ? `${model.provider}/${model.id}` : model.id;
}

function baseEntry(
  source: SystemPromptLogEntry["source"],
  prompt: string,
  ctx: ExtensionContext,
  providerShape?: string,
): SystemPromptLogEntry {
  const digest = sha256(prompt);
  return {
    ts: new Date().toISOString(),
    source,
    sessionId: ctx.sessionManager?.getSessionId?.(),
    sessionFile: ctx.sessionManager?.getSessionFile?.(),
    cwd: ctx.cwd,
    model: modelLabel(ctx),
    nestedDepth: nestedDepth(),
    chars: prompt.length,
    sha256: digest,
    providerShape,
    prompt,
  };
}

async function appendEntry(
  logConfig: SystemPromptLogConfig,
  cwd: string,
  entry: SystemPromptLogEntry,
): Promise<void> {
  const logPath = resolveSystemPromptLogPath(logConfig.path, cwd);
  const dedupeKey = `${entry.source}:${entry.sessionId ?? ""}:${entry.providerShape ?? ""}:${entry.sha256}`;
  if (logConfig.dedupe && seenEntries.has(dedupeKey)) return;

  try {
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    const handle = await fs.open(logPath, "a", 0o600);
    try {
      await handle.appendFile(`${JSON.stringify(entry)}\n`, "utf8");
    } finally {
      await handle.close();
    }
    try {
      await fs.chmod(logPath, 0o600);
    } catch {
      // Best-effort only. Some filesystems do not support chmod.
    }
    if (logConfig.dedupe) seenEntries.add(dedupeKey);
  } catch (err) {
    getLogger().warn("System prompt logging failed", {
      path: logPath,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function collectText(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectText(item, out);
    return;
  }

  if (!isRecord(value)) return;

  if (typeof value.text === "string") {
    out.push(value.text);
  }

  if (typeof value.content === "string") {
    out.push(value.content);
  } else if (value.content !== undefined) {
    collectText(value.content, out);
  }

  if (value.parts !== undefined) {
    collectText(value.parts, out);
  }
}

function textFrom(value: unknown): string | undefined {
  const parts: string[] = [];
  collectText(value, parts);
  const text = parts.filter((part) => part.length > 0).join("\n\n");
  return text.length > 0 ? text : undefined;
}

function extractRoleMessages(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const parts: string[] = [];
  for (const message of value) {
    if (!isRecord(message)) continue;
    const role = message.role;
    if (role !== "system" && role !== "developer") continue;
    const text = textFrom(message.content);
    if (text) parts.push(text);
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function pushExtraction(
  out: ProviderSystemExtraction[],
  providerShape: string,
  value: unknown,
): void {
  const prompt = textFrom(value);
  if (prompt) out.push({ providerShape, prompt });
}

export function extractProviderSystemPrompts(payload: unknown): ProviderSystemExtraction[] {
  if (!isRecord(payload)) return [];

  const extractions: ProviderSystemExtraction[] = [];

  if (payload.system !== undefined) {
    pushExtraction(extractions, "payload.system", payload.system);
  }

  const messagesPrompt = extractRoleMessages(payload.messages);
  if (messagesPrompt) {
    extractions.push({
      providerShape: "payload.messages[role=system|developer]",
      prompt: messagesPrompt,
    });
  }

  const inputPrompt = extractRoleMessages(payload.input);
  if (inputPrompt) {
    extractions.push({
      providerShape: "payload.input[role=system|developer]",
      prompt: inputPrompt,
    });
  }

  if (isRecord(payload.config) && payload.config.systemInstruction !== undefined) {
    pushExtraction(
      extractions,
      "payload.config.systemInstruction",
      payload.config.systemInstruction,
    );
  }

  if (payload.systemInstruction !== undefined) {
    pushExtraction(extractions, "payload.systemInstruction", payload.systemInstruction);
  }

  return extractions;
}

export async function captureAgentStartSystemPrompt(
  config: BlackbytesConfig,
  ctx: ExtensionContext,
): Promise<void> {
  const logConfig = getSystemPromptLogConfig(config);
  if (shouldSkip(logConfig) || !logConfig.capture_agent_start) return;

  const prompt = ctx.getSystemPrompt();
  if (!prompt) return;

  await appendEntry(logConfig, ctx.cwd, baseEntry("agent_start", prompt, ctx));
}

export async function captureProviderSystemPrompts(
  config: BlackbytesConfig,
  payload: unknown,
  ctx: ExtensionContext,
): Promise<void> {
  const logConfig = getSystemPromptLogConfig(config);
  if (shouldSkip(logConfig) || !logConfig.capture_provider_system) return;

  const extractions = extractProviderSystemPrompts(payload);
  for (const extraction of extractions) {
    await appendEntry(
      logConfig,
      ctx.cwd,
      baseEntry("before_provider_request", extraction.prompt, ctx, extraction.providerShape),
    );
  }
}

/** Testing helper: clear in-memory dedupe state. */
export function _resetSystemPromptLogDedupe(): void {
  seenEntries.clear();
}
