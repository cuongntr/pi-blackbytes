/**
 * Seat mode detection.
 *
 * When Pi runs as a seat inside a paseo-room (any non-empty `PASEO_ROOM_ROLE`),
 * Blackbytes must not create a second orchestration path: no `delegate_*`
 * tools, no nested `pi` spawns, no system-prompt override, and no file I/O
 * outside the seat's own Pi directory. Every role is treated identically.
 *
 * This is checked in code at each relevant site (registration, runner,
 * artifacts, prompt injection, availability probe), never via prompt text.
 */

export const SEAT_ROLE_ENV = "PASEO_ROOM_ROLE";

/** The seat role, or undefined when not running as a seat. */
export function getSeatRole(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env[SEAT_ROLE_ENV];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function isSeatMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return getSeatRole(env) !== undefined;
}

/** Human-readable list of what seat mode disables, for `/blackbytes-status`. */
export const SEAT_MODE_DISABLED_FEATURES: readonly string[] = Object.freeze([
  "delegate_* sub-agent tools (builtin and YAML)",
  "nested `pi` spawns (delegation runner, chain executor, availability probe)",
  "system prompt augmentation (Bytes identity, delegation guidance, <available_resources>)",
  "sub-agent artifact capture and cleanup",
  "logging outside <agent dir>/logs",
]);
