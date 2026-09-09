// Immutable obligations, not inferred coverage. No variant is executable in this WIP.
const obligations = [
  ["C01", "legacy-exact-tool-output", "BLOCK: ordinary SDK auth/settings read acquires non-receipt lock-directory writes; no permitted workaround or runtime evidence"],
  ["C02", "parent-true-saved-false,parent-false-saved-true", "Divergent trust fixtures and unchanged trust hashes absent"],
  ["C03", "selected-A-decoy-B,default-home", "Observed home/store access receipts absent"],
  ["C04", "missing-provider,missing-model,unavailable-snapshot,missing-configured-auth", "BLOCK: missing-provider reaches ordinary auth lock write before admission; other variants unimplemented; zero-call evidence absent"],
  ["C05", "session-start-run,resources-discover-run,handled-input-latched,later-success-latched,handled-without-assistant,handled-after-startup-refusal", "Completed nonthrowing stream and handled-prompt evidence absent"],
  ["C06", "startup-tuple,request-tuple,session-replacement,request-replacement,catalogue-loss,ownership-loss", "Public mutation/shim variants and per-request assertions absent"],
  ["C07", "late-add,late-remove,late-activation,delegate-tool", "Only old remove fixture exists; exact per-variant tool assertions absent"],
  ["C08", "literal-slash-colon,explicit-effort,suffix-effort,omitted-effort", "Per-version default/clamping measurements absent"],
  ["C09", "path-like-system,no-context,append-system,skill-template,extension-transform", "Ambient fixtures and byte-preserved prompt policy assertions absent"],
  ["C10", "version,capability,missing-entry,import-failure,setup-throw,resource-warning", "Reviewed public shims and negative nonzero exit assertions absent"],
  ["C11", "stdin-length,stdin-utf8,stdin-version,stdin-fragments,stdin-slow-body,stdin-slow-eof,fd3-corrupt,fd3-oversize,fd3-duplicate,fd3-missing,noisy-diagnostics", "Production decoder available in adapter; reviewed shim transport/rolling private canary observer not wired"],
  ["C12", "agent-end-queued,shutdown-throw", "Ordered settlement and no premature success receipts absent"],
  ["C13", "cancel-factory,cancel-auth,cancel-startup,cancel-prompt,cancel-queue,cancel-disposal", "Stage cancellation injection and monotonic deadline receipts absent"],
  ["C14", "cooperative-term,ignored-term", "Recorded group TERM/KILL timestamps and close/pipe assertions absent"],
  ["C15", "stalled-close,late-close", "Controllable observer seam absent; permanent retirement requires later adoption/WP-003"],
  ["C16", "descendant-pipe,descendant-outlives", "No fully recorded descendant spawn allowlist and cleanup proof"],
  ["C17", "new,resume,fork,import,reload", "Only old reload action exists; replacement/session-write assertions absent"],
  ["C18", "readonly-fallback,writer-no-retry", "Later adoption and permanent writer-retirement candidate required"],
  ["C19", "unicode-long-output,private-canary", "Rolling canary checks, bounded external receipts and artifact assertions absent"],
  ["C20", "windows-direct-child", "No approved pre-existing Windows environment"],
];
export const MATRIX = Object.freeze(obligations.map(([cell, names, gap]) => Object.freeze({
  cell, status: cell === "C20" || cell === "C18" ? "NOT RUN" : "BLOCKED",
  variants: Object.freeze(names.split(",").map((variant) => Object.freeze({
    variant, runnable: false, execution: "NOT RUN", gap,
  }))),
})));
export const LIMITS = Object.freeze({ executeMs: 10000, drainMs: 5000, versionSuiteMs: 1200000, receiptBytes: 8192, serial: true, retrySafetyFailure: false });
export function requireRunnable(cell, variant) {
  const item = MATRIX.find((item) => item.cell === cell)?.variants.find((item) => item.variant === variant);
  if (!item || !item.runnable) throw new Error("variant_blocked_no_execution_authority");
  return item;
}
