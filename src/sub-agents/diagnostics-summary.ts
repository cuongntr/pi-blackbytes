import { getEnabledSet } from "../config/enabled-set.js";
import { redactSecrets } from "../shared/redact.js";
import { getDelegationLog } from "./delegation-log.js";
import { getYamlDiagnostics } from "./diagnostics.js";
import { getAgentSnapshot } from "./snapshot.js";
import type { AgentSnapshot } from "./snapshot.js";
import type { DelegateFailureKind } from "./types.js";

export interface AgentDiagnostic {
  readonly name: string;
  readonly enabled: boolean;
  readonly source: "builtin" | "yaml";
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly fallbackEligible: boolean;
  readonly fallbackModelCount: number;
}

export interface FailureGroup {
  readonly kind: DelegateFailureKind;
  readonly count: number;
  readonly recentHints: readonly string[]; // redacted, max 3
}

export interface DiagnosticsSummary {
  readonly agents: readonly AgentDiagnostic[];
  readonly yamlWarnings: readonly string[]; // redacted
  readonly recentFailures: readonly FailureGroup[];
  readonly totalDelegations: number;
  readonly successRate: number; // 0-1
}

const MAX_RECENT_HINTS = 3;

export function buildDiagnosticsSummary(): DiagnosticsSummary {
  const enabledSet = getEnabledSet();
  const snapshot = getAgentSnapshot();
  const delegationLog = getDelegationLog();
  const yamlDiag = getYamlDiagnostics();

  // Build per-agent diagnostics
  const agents: AgentDiagnostic[] = [];
  if (snapshot) {
    for (const snap of snapshot.values()) {
      agents.push({
        name: snap.name,
        enabled: enabledSet.subAgents.has(snap.name),
        source: snap.source,
        model: snap.model,
        timeoutMs: snap.timeoutMs,
        fallbackEligible: snap.fallbackEligible,
        fallbackModelCount: snap.fallbackModels?.length ?? 0,
      });
    }
  }

  // Build YAML warnings (redacted)
  const yamlWarnings: string[] = [];
  if (yamlDiag) {
    for (const skip of yamlDiag.skippedFiles) {
      const warning = `Skipped ${skip.file}: ${skip.reason}`;
      yamlWarnings.push(redactSecrets(warning));
    }
  }

  // Group failures by kind while retaining the newest redacted hints for each kind.
  // `errorHint` is redacted before it is written to the delegation log; keep it unchanged here.
  const failureMap = new Map<DelegateFailureKind, { count: number; hints: string[] }>();
  for (let i = delegationLog.length - 1; i >= 0; i--) {
    const entry = delegationLog[i]!;
    if (!entry.success && entry.failureKind) {
      const group = failureMap.get(entry.failureKind) ?? { count: 0, hints: [] };
      group.count++;
      if (entry.errorHint && group.hints.length < MAX_RECENT_HINTS) {
        group.hints.push(entry.errorHint);
      }
      failureMap.set(entry.failureKind, group);
    }
  }

  const recentFailures: FailureGroup[] = [...failureMap.entries()]
    .map(([kind, { count, hints }]) => ({
      kind,
      count,
      recentHints: hints,
    }))
    .sort((a, b) => b.count - a.count); // most frequent first

  // Compute success rate
  const totalDelegations = delegationLog.length;
  const successes = delegationLog.filter((e) => e.success).length;
  const successRate = totalDelegations > 0 ? successes / totalDelegations : 1;

  return {
    agents,
    yamlWarnings,
    recentFailures,
    totalDelegations,
    successRate,
  };
}
