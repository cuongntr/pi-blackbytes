import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { ToolResultStats } from "../_shared/stats-render.js";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB hard cap per image
const MAX_REFERENCE_FILES = 3;

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
};

export interface LookAtParams {
  path: string;
  objective: string;
  context?: string;
  referenceFiles?: string[];
}

export type LookAtToolResult = AgentToolResult<ToolResultStats>;

function detectMime(path: string): string | null {
  const ext = extname(path).toLowerCase();
  return MIME_BY_EXT[ext] ?? null;
}

function resolvePath(p: string, cwd: string): string {
  return isAbsolute(p) ? p : resolve(cwd, p);
}

async function loadImage(
  path: string,
  cwd: string,
): Promise<
  | { kind: "ok"; mime: string; base64: string; size: number; abs: string }
  | { kind: "err"; message: string }
> {
  const abs = resolvePath(path, cwd);
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(abs);
  } catch (err) {
    return { kind: "err", message: `not found: ${abs} (${(err as Error).message})` };
  }
  if (!info.isFile()) {
    return { kind: "err", message: `not a regular file: ${abs}` };
  }
  if (info.size > MAX_IMAGE_BYTES) {
    return {
      kind: "err",
      message: `image too large (${info.size} bytes > ${MAX_IMAGE_BYTES})`,
    };
  }
  const mime = detectMime(abs);
  if (!mime) {
    return {
      kind: "err",
      message: `unsupported image type: ${extname(abs) || "(no extension)"} — accepted: ${Object.keys(MIME_BY_EXT).join(", ")}`,
    };
  }
  const buf = await readFile(abs);
  return {
    kind: "ok",
    mime,
    base64: buf.toString("base64"),
    size: buf.byteLength,
    abs,
  };
}

export interface LookAtOptions {
  cwd?: () => string;
}

export async function executeLookAt(
  params: LookAtParams,
  options: LookAtOptions = {},
): Promise<LookAtToolResult> {
  const cwd = (options.cwd ?? (() => process.cwd()))();
  const objective = (params.objective ?? "").trim();
  if (!params.path || objective.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: "Error: look_at requires both `path` and `objective`.",
        },
      ],
      details: { summary: "missing args" },
    };
  }

  const refs = (params.referenceFiles ?? []).slice(0, MAX_REFERENCE_FILES);

  const primary = await loadImage(params.path, cwd);
  if (primary.kind === "err") {
    return {
      content: [{ type: "text", text: `Error loading primary image: ${primary.message}` }],
      details: { summary: "load error" },
    };
  }

  const referenceResults = await Promise.all(refs.map((p) => loadImage(p, cwd)));
  const referenceFailures = referenceResults
    .map((r, i) => (r.kind === "err" ? `  - ${refs[i]}: ${r.message}` : ""))
    .filter((s) => s.length > 0);

  const okReferences = referenceResults.filter(
    (r): r is Extract<typeof r, { kind: "ok" }> => r.kind === "ok",
  );

  const headerLines: string[] = [];
  headerLines.push(`Objective: ${objective}`);
  if (params.context && params.context.trim().length > 0) {
    headerLines.push("");
    headerLines.push(`Context: ${params.context.trim()}`);
  }
  headerLines.push("");
  headerLines.push(`Primary image: ${primary.abs} (${primary.mime}, ${primary.size} bytes)`);
  if (okReferences.length > 0) {
    headerLines.push("Reference images:");
    for (const r of okReferences) {
      headerLines.push(`  - ${r.abs} (${r.mime}, ${r.size} bytes)`);
    }
  }
  if (referenceFailures.length > 0) {
    headerLines.push("Reference load failures (skipped):");
    headerLines.push(...referenceFailures);
  }

  const content: AgentToolResult<ToolResultStats>["content"] = [
    { type: "text", text: headerLines.join("\n") },
    { type: "image", data: primary.base64, mimeType: primary.mime },
  ];
  for (const r of okReferences) {
    content.push({ type: "image", data: r.base64, mimeType: r.mime });
  }

  const summaryParts = [
    `1+${okReferences.length} image${okReferences.length === 0 ? "" : "s"}`,
    `${primary.size} bytes primary`,
  ];
  return {
    content,
    details: { summary: summaryParts.join(" · ") },
  };
}
