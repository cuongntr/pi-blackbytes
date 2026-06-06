/**
 * Session-scoped runtime state reset.
 *
 * Clears every in-memory singleton that {@link handleSessionStart} populates,
 * so a second startup in the same process (or recovery after a failed startup)
 * starts from a known-empty baseline. Persistent state (settings.json, JSONL
 * logs, beads database) is intentionally left untouched.
 *
 * This is production code, invoked at the top of `handleSessionStart()` BEFORE
 * config-derived enablement, YAML loading, or builtin registration so a
 * partially-initialized previous session cannot poison the next one.
 */

import { _resetEnabledSet } from "../config/enabled-set.js";
import { _resetSubAgentRegistry } from "../config/resource-metadata.js";
import { resetDelegationLog } from "../sub-agents/delegation-log.js";
import { _resetYamlDiagnostics } from "../sub-agents/diagnostics.js";
import { _resetAgentSnapshot } from "../sub-agents/snapshot.js";
import { _resetModelFamily } from "./model-capability.js";

/**
 * Resets all in-memory session-scoped runtime state. Idempotent; safe to call
 * even when nothing has been initialized yet.
 *
 * Cleared:
 *   - EnabledSet (tools / sub-agents / skills / disabledTools)
 *   - Per-agent runtime snapshot (model/reasoning/reserved/extra)
 *   - Sub-agent metadata registry (consumed by prompt feature flags)
 *   - Cached model family used by reasoning-effort mapping
 *
 * NOT cleared:
 *   - User config files on disk (settings.json, YAML sub-agent files)
 *   - Logger buffer / log files
 *   - Beads database, JSONL session logs
 */
export function resetSessionRuntimeState(): void {
  _resetEnabledSet();
  _resetAgentSnapshot();
  _resetSubAgentRegistry();
  _resetModelFamily();
  _resetYamlDiagnostics();
  resetDelegationLog();
}
