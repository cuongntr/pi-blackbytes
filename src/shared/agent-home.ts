/**
 * Agent-home (Pi config directory) resolution.
 *
 * Pi 1.x reads `PI_CODING_AGENT_DIR` (see `ENV_AGENT_DIR` in Pi's config.js).
 * Older Blackbytes releases only honoured `PI_AGENT_DIR`. This module resolves
 * both, with the official variable taking precedence, and falls back to
 * `~/.pi/agent`. It is pure lexical resolution: no stat, realpath, or directory
 * creation ever happens here.
 */

import { homedir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";

export type AgentHomeSource = "PI_CODING_AGENT_DIR" | "PI_AGENT_DIR" | "default";

export interface AgentHome {
  readonly path: string;
  readonly source: AgentHomeSource;
  /** True when both env vars are set and resolve to different directories. */
  readonly conflict: boolean;
  /** Fixed, path-free diagnostic; never contains either environment value. */
  readonly diagnostic?: string;
}

export interface AgentHomeInputs {
  readonly env: Readonly<Partial<Pick<NodeJS.ProcessEnv, "PI_CODING_AGENT_DIR" | "PI_AGENT_DIR">>>;
  readonly cwd: string;
  readonly userHome: string;
}

export const AGENT_HOME_CONFLICT_DIAGNOSTIC =
  "Agent-home aliases disagree; PI_CODING_AGENT_DIR takes precedence over PI_AGENT_DIR.";

function expandTilde(value: string, userHome: string): string {
  if (value === "~") return userHome;
  if (value.startsWith("~/") || (sep === "\\" && value.startsWith("~\\"))) {
    return resolve(userHome, value.slice(2));
  }
  return value;
}

/** Pure lexical resolution of the agent home from explicit inputs. */
export function resolveAgentHome({ env, cwd, userHome }: AgentHomeInputs): AgentHome {
  const normalize = (value: string): string => {
    const expanded = expandTilde(value, userHome);
    return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
  };

  // Only the empty string counts as unset: whitespace can be a valid directory name.
  const official = env.PI_CODING_AGENT_DIR;
  const legacy = env.PI_AGENT_DIR;
  const officialPath = official !== undefined && official !== "" ? normalize(official) : undefined;
  const legacyPath = legacy !== undefined && legacy !== "" ? normalize(legacy) : undefined;

  const source: AgentHomeSource =
    officialPath !== undefined
      ? "PI_CODING_AGENT_DIR"
      : legacyPath !== undefined
        ? "PI_AGENT_DIR"
        : "default";
  const conflict =
    officialPath !== undefined && legacyPath !== undefined && officialPath !== legacyPath;

  return Object.freeze({
    path: officialPath ?? legacyPath ?? resolve(userHome, ".pi", "agent"),
    source,
    conflict,
    ...(conflict ? { diagnostic: AGENT_HOME_CONFLICT_DIAGNOSTIC } : {}),
  });
}

/**
 * Resolve the agent home from the live process environment.
 *
 * Deliberately not cached: tests and some hosts mutate the environment between
 * sessions, and the resolution is cheap.
 */
export function getAgentHome(): AgentHome {
  return resolveAgentHome({ env: process.env, cwd: process.cwd(), userHome: homedir() });
}

/** Convenience: the resolved agent home directory path. */
export function getAgentHomePath(): string {
  return getAgentHome().path;
}
