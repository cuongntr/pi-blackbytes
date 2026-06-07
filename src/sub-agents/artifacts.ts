import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { redactSecrets } from "../shared/redact.js";
import type { DelegateFailureKind } from "./types.js";

export const MAX_ARTIFACT_BYTES = 512 * 1024;
export const MIN_ARTIFACT_CHARS = 1_024;
export const RETENTION_DAYS = 7;

export interface ArtifactMetadata {
  agent: string;
  startedAt: number;
  durationMs: number;
  model?: string;
  failureKind?: DelegateFailureKind;
  originalChars: number;
  redactedChars: number;
  truncated: boolean;
}

export interface CaptureArtifactOptions {
  agent: string;
  content: string;
  startedAt: number;
  durationMs: number;
  model?: string;
  failureKind?: DelegateFailureKind;
  now?: Date;
}

export interface CapturedArtifact {
  path: string;
  bytes: number;
  originalChars: number;
  redactedChars: number;
  truncated: boolean;
}

function getAgentDir(): string {
  return process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function formatDateSegment(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function formatTimeSegment(date: Date): string {
  const hours = date.getUTCHours().toString().padStart(2, "0");
  const minutes = date.getUTCMinutes().toString().padStart(2, "0");
  const seconds = date.getUTCSeconds().toString().padStart(2, "0");
  const milliseconds = date.getUTCMilliseconds().toString().padStart(3, "0");
  return `${hours}${minutes}${seconds}${milliseconds}`;
}

function sanitizePathSegment(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "agent";
}

function yamlScalar(value: string | number | boolean): string {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

export function resolveArtifactDir(now = new Date()): string {
  return join(getAgentDir(), "blackbytes", "artifacts", "sub-agents", formatDateSegment(now));
}

export function buildMetadataHeader(metadata: ArtifactMetadata): string {
  const entries: Array<[string, string | number | boolean | undefined]> = [
    ["agent", metadata.agent],
    ["startedAt", new Date(metadata.startedAt).toISOString()],
    ["durationMs", metadata.durationMs],
    ["model", metadata.model],
    ["failureKind", metadata.failureKind],
    ["originalChars", metadata.originalChars],
    ["redactedChars", metadata.redactedChars],
    ["truncated", metadata.truncated],
    ["redaction", "Secrets redacted by pi-blackbytes before persistence."],
  ];

  const body = entries
    .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
    .map(([key, value]) => `${key}: ${yamlScalar(value)}`)
    .join("\n");

  return `---\n${body}\n---\n\n`;
}

function boundArtifactText(header: string, content: string): { text: string; truncated: boolean } {
  const marker = "\n[... artifact truncated to 512 KiB ...]\n";
  const full = `${header}${content}`;
  if (Buffer.byteLength(full, "utf8") <= MAX_ARTIFACT_BYTES) {
    return { text: full, truncated: false };
  }

  const budget =
    MAX_ARTIFACT_BYTES - Buffer.byteLength(header, "utf8") - Buffer.byteLength(marker, "utf8");
  if (budget <= 0) return { text: header.slice(0, MAX_ARTIFACT_BYTES), truncated: true };

  let end = content.length;
  while (end > 0 && Buffer.byteLength(content.slice(0, end), "utf8") > budget) {
    end = Math.floor(end * 0.9);
  }
  while (end < content.length && Buffer.byteLength(content.slice(0, end + 1), "utf8") <= budget) {
    end++;
  }

  return { text: `${header}${content.slice(0, end)}${marker}`, truncated: true };
}

export async function captureArtifact(
  options: CaptureArtifactOptions,
): Promise<CapturedArtifact | undefined> {
  const redactedContent = redactSecrets(options.content);
  if (redactedContent.length < MIN_ARTIFACT_CHARS) return undefined;

  const now = options.now ?? new Date();
  const dir = resolveArtifactDir(now);
  const agent = sanitizePathSegment(options.agent);
  const baseName = `${agent}-${formatTimeSegment(now)}`;

  let header = buildMetadataHeader({
    agent: options.agent,
    startedAt: options.startedAt,
    durationMs: options.durationMs,
    model: options.model,
    failureKind: options.failureKind,
    originalChars: options.content.length,
    redactedChars: redactedContent.length,
    truncated: false,
  });
  let bounded = boundArtifactText(header, redactedContent);

  if (bounded.truncated) {
    header = buildMetadataHeader({
      agent: options.agent,
      startedAt: options.startedAt,
      durationMs: options.durationMs,
      model: options.model,
      failureKind: options.failureKind,
      originalChars: options.content.length,
      redactedChars: redactedContent.length,
      truncated: true,
    });
    bounded = boundArtifactText(header, redactedContent);
  }

  await mkdir(dir, { recursive: true, mode: 0o700 });
  let filePath = join(dir, `${baseName}.md`);
  for (let attempt = 0; attempt < 1000; attempt++) {
    filePath = join(dir, attempt === 0 ? `${baseName}.md` : `${baseName}-${attempt + 1}.md`);
    try {
      await writeFile(filePath, bounded.text, { mode: 0o600, flag: "wx" });
      break;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") {
        throw error;
      }
      if (attempt === 999) throw error;
    }
  }

  return {
    path: filePath,
    bytes: Buffer.byteLength(bounded.text, "utf8"),
    originalChars: options.content.length,
    redactedChars: redactedContent.length,
    truncated: bounded.truncated,
  };
}

export async function cleanupArtifacts(now = new Date()): Promise<number> {
  const baseDir = join(getAgentDir(), "blackbytes", "artifacts", "sub-agents");
  const cutoffMs = now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let removed = 0;

  try {
    const dateDirs = await readdir(baseDir, { withFileTypes: true });
    for (const dateDir of dateDirs) {
      if (!dateDir.isDirectory()) continue;
      const dirPath = join(baseDir, dateDir.name);
      const files = await readdir(dirPath, { withFileTypes: true });
      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith(".md")) continue;
        const filePath = join(dirPath, file.name);
        try {
          const info = await stat(filePath);
          if (info.mtimeMs < cutoffMs) {
            await rm(filePath, { force: true });
            removed++;
          }
        } catch {
          // Best-effort cleanup: ignore individual file failures.
        }
      }
    }
  } catch {
    return removed;
  }

  return removed;
}
