import { spawn as nodeSpawn } from "node:child_process";
import type { SpawnOptions } from "node:child_process";
import type { DelegateResult, PiSessionEvent, RunNestedPiOptions } from "./types.js";

export type { RunNestedPiOptions, DelegateResult };

// Spawn function type for dependency injection in tests
export type SpawnFn = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ReturnType<typeof nodeSpawn>;

const SAFE_ENV_VARS = [
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "TERM",
  "PI_AGENT_DIR",
  "NODE_ENV",
] as const;

const MAX_STREAM_CHARS = 8_192;
const MAX_DISPLAY_DETAIL_CHARS = 6_144;
const DEFAULT_KILL_GRACE_MS = 100;
const TRUNCATION_MARKER = "\n[... truncated ...]\n";

function appendBounded(current: string, chunk: string, maxChars = MAX_STREAM_CHARS): string {
  const combined = current + chunk;
  if (combined.length <= maxChars) return combined;

  const keepChars = maxChars - TRUNCATION_MARKER.length;
  const headChars = Math.floor(keepChars / 2);
  const tailChars = keepChars - headChars;
  return combined.slice(0, headChars) + TRUNCATION_MARKER + combined.slice(-tailChars);
}

function truncateMiddle(text: string, maxChars = MAX_DISPLAY_DETAIL_CHARS): string {
  if (text.length <= maxChars) return text;

  const keepChars = maxChars - TRUNCATION_MARKER.length;
  const headChars = Math.floor(keepChars / 2);
  const tailChars = keepChars - headChars;
  return text.slice(0, headChars) + TRUNCATION_MARKER + text.slice(-tailChars);
}

export function redactDelegateText(text: string): string {
  return text
    .replace(
      /(\b[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|KEY)[A-Z0-9_]*\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s'",}]+)/gi,
      "$1[REDACTED]",
    )
    .replace(
      /((?:"[^"]*(?:api[_-]?key|token|secret|password|credential|key)[^"]*"|'[^']*(?:api[_-]?key|token|secret|password|credential|key)[^']*'|\b[A-Za-z0-9_-]*(?:api[_-]?key|token|secret|password|credential|key)[A-Za-z0-9_-]*\b)\s*:\s*)(?:"[^"]*"|'[^']*'|[^\s,}]+)/gi,
      "$1[REDACTED]",
    )
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\-/=]+/gi, "$1[REDACTED]");
}

function classifyFailure(
  details: string | undefined,
  fallback: NonNullable<DelegateResult["failureKind"]>,
) {
  const text = details ?? "";
  if (/unknown tool|invalid tool|tool.*not found/i.test(text)) return "invalid_tool_allowlist";
  if (/rate limit|model.*(not found|unavailable)|provider|api key|authentication/i.test(text)) {
    return "provider_or_model_unavailable";
  }
  if (/unknown option|usage:/i.test(text)) return "cli_usage_error";
  return fallback;
}

export function formatDelegateFailure(result: DelegateResult): string {
  const details = result.details ? truncateMiddle(redactDelegateText(result.details)) : undefined;
  const kind = result.failureKind ? ` (${result.failureKind})` : "";
  if (!details) return `Error: ${result.content}${kind}`;
  return `Error: ${result.content}${kind}\nDetails:\n${details}`;
}

function buildSafeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of SAFE_ENV_VARS) {
    const val = process.env[key];
    if (val !== undefined) {
      env[key] = val;
    }
  }
  // Always set depth to 1 for the child
  env.PI_NESTED_DEPTH = "1";
  return env;
}

export async function runNestedPi(
  opts: RunNestedPiOptions,
  spawnFn: SpawnFn = nodeSpawn,
): Promise<DelegateResult> {
  // Recursion guard
  const currentDepth = Number.parseInt(process.env.PI_NESTED_DEPTH ?? "0", 10);
  if (currentDepth >= 1) {
    return {
      success: false,
      content: "Nested Pi invocation refused: recursion depth limit reached (PI_NESTED_DEPTH >= 1)",
      failureKind: "recursion_refused",
    };
  }

  const {
    systemPrompt,
    userPrompt,
    model,
    reasoningEffort,
    allowedTools,
    cwd,
    signal,
    timeoutMs = 300_000,
    killGraceMs = DEFAULT_KILL_GRACE_MS,
    onUpdate,
  } = opts;

  if (signal?.aborted) {
    return {
      success: false,
      content: "Nested Pi cancelled",
      failureKind: "cancelled",
    };
  }
  const args: string[] = [
    "-p",
    userPrompt,
    "--system-prompt",
    systemPrompt,
    "--no-session",
    "--no-context-files",
    "--mode",
    "json",
  ];

  if (model) {
    args.push("--model", model);
  }

  if (allowedTools.length > 0) {
    args.push("--tools", allowedTools.join(","));
  }

  const safeEnv = buildSafeEnv();
  if (reasoningEffort) {
    args.push("--thinking", reasoningEffort);
  }

  return new Promise<DelegateResult>((resolve) => {
    let settled = false;
    let terminationReason: "timed_out" | "cancelled" | undefined;
    let terminationRequested = false;
    let killGraceHandle: ReturnType<typeof setTimeout> | undefined;
    let child: ReturnType<SpawnFn>;

    let stdout = "";
    let stderr = "";

    const makeTerminationResult = (reason: "timed_out" | "cancelled"): DelegateResult => ({
      success: false,
      content: reason === "timed_out" ? "Nested Pi timed out" : "Nested Pi cancelled",
      details: stderr || undefined,
      failureKind: reason,
    });

    const requestTermination = (reason: "timed_out" | "cancelled") => {
      terminationReason ??= reason;
      if (terminationRequested) return;
      terminationRequested = true;
      child.kill("SIGTERM");
      killGraceHandle = setTimeout(() => {
        if (settled) return;
        child.kill("SIGKILL");
        finish(makeTerminationResult(terminationReason ?? reason));
      }, killGraceMs);
    };

    // Manual timeout timer so we can clear it when done (avoids pending timer issues)
    const timeoutHandle = setTimeout(() => {
      if (settled) return;
      requestTermination("timed_out");
    }, timeoutMs);

    const finish = (result: DelegateResult) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (killGraceHandle) clearTimeout(killGraceHandle);
      if (signal) {
        signal.removeEventListener("abort", callerAbortHandler);
      }
      resolve(result);
    };

    const callerAbortHandler = () => {
      if (settled) return;
      requestTermination("cancelled");
    };

    if (signal) {
      signal.addEventListener("abort", callerAbortHandler, { once: true });
    }

    try {
      child = spawnFn("pi", args, {
        cwd: cwd ?? process.cwd(),
        env: safeEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      finish({
        success: false,
        content: "Nested Pi failed",
        details: err instanceof Error ? err.message : String(err),
        failureKind: "spawn_error",
      });
      return;
    }

    if (!child.stdout || !child.stderr) {
      finish({
        success: false,
        content: "Nested Pi failed",
        details: "Nested Pi process did not expose stdout/stderr streams",
        failureKind: "spawn_error",
      });
      return;
    }

    if (signal?.aborted) {
      requestTermination("cancelled");
    }

    let lineBuffer = "";
    let finalAssistantText = "";

    const handleLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) return;
      // Skip non-JSON banner/warning lines that pi-blackbytes or upstream
      // print before/around the JSONL stream.
      if (!trimmed.startsWith("{")) return;
      let event: PiSessionEvent;
      try {
        event = JSON.parse(trimmed) as PiSessionEvent;
      } catch {
        return;
      }
      if (!event || typeof event !== "object" || typeof event.type !== "string") return;

      // Capture the final assistant text from agent_end.messages so we can
      // return clean content (without JSONL noise) to the calling LLM.
      if (event.type === "agent_end") {
        const messages = event.messages;
        if (Array.isArray(messages)) {
          for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i] as { role?: unknown; content?: unknown } | undefined;
            if (!msg || msg.role !== "assistant") continue;
            if (Array.isArray(msg.content)) {
              const text = msg.content
                .filter(
                  (c): c is { type: "text"; text: string } =>
                    !!c &&
                    typeof c === "object" &&
                    (c as { type?: unknown }).type === "text" &&
                    typeof (c as { text?: unknown }).text === "string",
                )
                .map((c) => c.text)
                .join("");
              if (text) finalAssistantText = text;
            }
            break;
          }
        }
      }

      try {
        onUpdate?.(event);
      } catch {
        // Swallow callback errors so a buggy progress reporter cannot break
        // the nested Pi run. The reporter is responsible for its own safety.
      }
    };

    child.stdout!.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout = appendBounded(stdout, text);
      lineBuffer += text;
      let idx = lineBuffer.indexOf("\n");
      while (idx !== -1) {
        const line = lineBuffer.slice(0, idx);
        lineBuffer = lineBuffer.slice(idx + 1);
        handleLine(line);
        idx = lineBuffer.indexOf("\n");
      }
    });

    child.stderr!.on("data", (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk.toString());
    });

    child.on("close", (_code) => {
      if (terminationReason) {
        finish(makeTerminationResult(terminationReason));
        return;
      }

      // Flush any trailing buffered line that didn't end in newline.
      if (lineBuffer.length > 0) {
        handleLine(lineBuffer);
        lineBuffer = "";
      }

      if (_code === 0) {
        finish({ success: true, content: finalAssistantText || stdout });
      } else {
        finish({
          success: false,
          content: "Nested Pi failed",
          details: stderr || undefined,
          failureKind: classifyFailure(stderr, "failed"),
        });
      }
    });

    child.on("error", (err) => {
      finish({
        success: false,
        content: "Nested Pi failed",
        details: err.message,
        failureKind: "spawn_error",
      });
    });
  });
}
