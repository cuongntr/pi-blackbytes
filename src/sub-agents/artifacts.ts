import type { Dirent } from "node:fs";
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

export interface ArtifactStatsRecent {
  /** Filename of the most recent artifact (e.g. "explore-010203000.md"). */
  readonly name: string;
  /** POSIX-style path relative to the artifact base directory. */
  readonly relativePath: string;
  /** mtime of the most recent artifact, in ms since epoch. */
  readonly timestamp: number;
}

export type ArtifactStats =
  | {
      readonly status: "ok";
      /** Resolved artifact base directory. */
      readonly directory: string;
      /** Total `.md` artifact count across every date subdir. */
      readonly count: number;
      /** Most recent artifact (by mtime) or `null` when the directory is empty. */
      readonly mostRecent: ArtifactStatsRecent | null;
    }
  | {
      readonly status: "unavailable";
      /** Resolved artifact base directory (always computable). */
      readonly directory: string;
      /** Reason the stats could not be read (e.g. "directory missing", "read error"). */
      readonly reason: string;
    };

/**
 * Best-effort summary of the artifact directory for diagnostics surfaces such
 * as `/blackbytes-status`. Always returns the resolved base directory even
 * when the directory does not exist or is unreadable, so the status can show
 * the path users would inspect manually.
 *
 * - No content reads: only stat/readdir metadata.
 * - Tolerates per-date-dir read failures (e.g. a single broken date dir is
 *   skipped rather than failing the whole scan).
 * - Secret-bearing paths are not expected (filenames are sanitized to
 *   `[a-z0-9_-]+` in `captureArtifact`), so no redaction is applied.
 */
export async function getArtifactStats(): Promise<ArtifactStats> {
  const baseDir = join(getAgentDir(), "blackbytes", "artifacts", "sub-agents");

  let dateDirs: Dirent[];
  try {
    dateDirs = await readdir(baseDir, { withFileTypes: true });
  } catch (error) {
    const message =
      error instanceof Error && "code" in error && error.code === "ENOENT"
        ? "directory missing"
        : "read error";
    return { status: "unavailable", directory: baseDir, reason: message };
  }

  let count = 0;
  let newest: ArtifactStatsRecent | null = null;

  for (const dateDir of dateDirs) {
    if (!dateDir.isDirectory()) continue;
    const dirPath = join(baseDir, dateDir.name);
    let files: Dirent[];
    try {
      files = await readdir(dirPath, { withFileTypes: true });
    } catch {
      // Per-date-dir failure: skip but keep going.
      continue;
    }
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".md")) continue;
      count += 1;
      const filePath = join(dirPath, file.name);
      let info: Awaited<ReturnType<typeof stat>>;
      try {
        info = await stat(filePath);
      } catch {
        continue;
      }
      if (!newest || info.mtimeMs > newest.timestamp) {
        newest = {
          timestamp: info.mtimeMs,
          name: file.name,
          relativePath: `${dateDir.name}/${file.name}`,
        };
      }
    }
  }

  return { status: "ok", directory: baseDir, count, mostRecent: newest };
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
