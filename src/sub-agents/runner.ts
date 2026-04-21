import { spawn as nodeSpawn } from "node:child_process";
import type { SpawnOptions } from "node:child_process";
import type { DelegateResult, RunNestedPiOptions } from "./types.js";

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
    onUpdate,
  } = opts;

  const args: string[] = [
    "-p",
    userPrompt,
    "--system-prompt",
    systemPrompt,
    "--no-session",
    "--no-context-files",
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
    let timedOut = false;
    let cancelled = false;

    const child = spawnFn("pi", args, {
      cwd: cwd ?? process.cwd(),
      env: safeEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    // Manual timeout timer so we can clear it when done (avoids pending timer issues)
    const timeoutHandle = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    const finish = (result: DelegateResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      if (signal) {
        signal.removeEventListener("abort", callerAbortHandler);
      }
      resolve(result);
    };

    const callerAbortHandler = () => {
      if (settled) return;
      cancelled = true;
      child.kill("SIGTERM");
    };

    if (signal) {
      if (signal.aborted) {
        // Already aborted before we started
        clearTimeout(timeoutHandle);
        child.kill("SIGTERM");
        cancelled = true;
      } else {
        signal.addEventListener("abort", callerAbortHandler, { once: true });
      }
    }

    child.stdout!.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      onUpdate?.(text);
    });

    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("close", (_code) => {
      if (timedOut) {
        finish({
          success: false,
          content: "Nested Pi timed out",
          details: stderr || undefined,
        });
        return;
      }

      if (cancelled || (signal?.aborted ?? false)) {
        finish({
          success: false,
          content: "Nested Pi cancelled",
          details: stderr || undefined,
        });
        return;
      }

      if (_code === 0) {
        finish({ success: true, content: stdout });
      } else {
        finish({
          success: false,
          content: "Nested Pi failed",
          details: stderr || undefined,
        });
      }
    });

    child.on("error", (err) => {
      finish({
        success: false,
        content: "Nested Pi failed",
        details: err.message,
      });
    });
  });
}
