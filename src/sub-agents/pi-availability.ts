import { spawn } from "node:child_process";
import { redactSecrets } from "../shared/redact.js";

export type PiAvailability = "available" | "unavailable" | "unknown";

export interface PiAvailabilityResult {
  status: PiAvailability;
  hint?: string; // redacted, max ~100 chars
}

export type PiAvailabilityProbe = () => Promise<{ available: boolean; error?: string }>;

let cachedResult: PiAvailabilityResult | undefined;
let inflightProbe: Promise<PiAvailabilityResult> | undefined;

/**
 * Check if the pi CLI is available for sub-agent delegation.
 * Uses cached results when available; concurrent callers share one in-flight probe.
 *
 * @param probeFn - Optional test seam for dependency injection. Defaults to real spawn.
 */
export async function checkPiAvailability(
  probeFn: PiAvailabilityProbe = defaultProbe,
): Promise<PiAvailabilityResult> {
  if (cachedResult) return cachedResult;

  inflightProbe ??= runPiAvailabilityProbe(probeFn).finally(() => {
    inflightProbe = undefined;
  });
  return inflightProbe;
}

async function runPiAvailabilityProbe(probeFn: PiAvailabilityProbe): Promise<PiAvailabilityResult> {
  try {
    const result = await probeFn();
    cachedResult = {
      status: result.available ? "available" : "unavailable",
      hint: result.error ? redactSecrets(result.error).slice(0, 100) : undefined,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    cachedResult = {
      status: "unavailable",
      hint: redactSecrets(message).slice(0, 100),
    };
  }
  return cachedResult;
}

/**
 * Return cached result without probing. Returns "unknown" if no probe has run.
 */
export function getCachedPiAvailability(): PiAvailabilityResult {
  return cachedResult ?? { status: "unknown" };
}

/**
 * Test-only reset hook.
 */
export function _resetPiAvailability(): void {
  cachedResult = undefined;
  inflightProbe = undefined;
}

/**
 * Default probe: attempt to spawn `pi --version` with a 2s timeout.
 */
async function defaultProbe(): Promise<{ available: boolean; error?: string }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("pi", ["--version"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({ available: false, error: err instanceof Error ? err.message : String(err) });
      return;
    }

    let settled = false;
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ available: false, error: "pi --version timed out (2s)" });
    }, 2000);
    const finish = (result: { available: boolean; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };

    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      if (code === 0) {
        finish({ available: true });
      } else {
        finish({ available: false, error: stderr || `pi --version exited with code ${code}` });
      }
    });

    child.on("error", (err) => {
      finish({ available: false, error: err.message });
    });
  });
}
