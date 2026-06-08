/**
 * Lightweight in-memory delegation log for ROI observability.
 *
 * Session-scoped — no persistence. Cleared on session restart via
 * {@link resetDelegationLog} which is called from `resetSessionRuntimeState()`.
 */

import { redactSecrets } from "../shared/redact.js";
import type { AttemptSummary } from "./fallback.js";
import type { DelegateFailureKind } from "./types.js";

export interface DelegationEntry {
  readonly agent: string;
  readonly startedAt: number; // Date.now()
  readonly durationMs: number;
  readonly success: boolean;
  readonly toolCallCount: number;
  readonly outputChars: number;
  /** Estimated cost if available from the progress reporter's usage tracking */
  readonly cost?: number;
  /** Failure classification when success is false */
  readonly failureKind?: DelegateFailureKind;
  /** Fallback attempt summaries when fallback was used */
  readonly fallbackAttempts?: readonly AttemptSummary[];
  /** Redacted error hint for diagnostics (max ~200 chars) */
  readonly errorHint?: string;
  readonly artifactPath?: string;
}

const MAX_ENTRIES = 100;
const MAX_ERROR_HINT_CHARS = 200;

const entries: DelegationEntry[] = [];

export function logDelegation(entry: DelegationEntry): void {
  const sanitizedEntry =
    entry.errorHint === undefined
      ? entry
      : { ...entry, errorHint: redactSecrets(entry.errorHint).slice(0, MAX_ERROR_HINT_CHARS) };
  entries.push(sanitizedEntry);
  // Evict oldest entries when cap exceeded
  while (entries.length > MAX_ENTRIES) {
    entries.shift();
  }
}

export function getDelegationLog(): readonly DelegationEntry[] {
  return [...entries];
}

export function resetDelegationLog(): void {
  entries.length = 0;
}

// Compact ROI aggregate intentionally omits failure details; structured failure
// diagnostics live in buildDiagnosticsSummary().
export function getDelegationSummary(): string {
  if (entries.length === 0) return "No delegations this session.";
  const byAgent = new Map<
    string,
    { count: number; totalMs: number; successes: number; totalCost: number }
  >();
  for (const e of entries) {
    const agg = byAgent.get(e.agent) ?? { count: 0, totalMs: 0, successes: 0, totalCost: 0 };
    agg.count++;
    agg.totalMs += e.durationMs;
    if (e.success) agg.successes++;
    agg.totalCost += e.cost ?? 0;
    byAgent.set(e.agent, agg);
  }
  const lines = [`Delegations this session: ${entries.length} total`];
  for (const [agent, agg] of [...byAgent.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const avgMs = Math.round(agg.totalMs / agg.count);
    const costStr = agg.totalCost > 0 ? `, $${agg.totalCost.toFixed(4)}` : "";
    lines.push(
      `  ${agent}: ${agg.count}x (${agg.successes}/${agg.count} ok, avg ${avgMs}ms${costStr})`,
    );
  }
  return lines.join("\n");
}
