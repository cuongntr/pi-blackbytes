import { homedir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";

export type AgentHomeSource = "PI_CODING_AGENT_DIR" | "PI_AGENT_DIR" | "default";

export interface AgentHome {
  readonly path: string;
  readonly source: AgentHomeSource;
  readonly conflict: boolean;
  /** Fixed, path-free diagnostic; never contains either environment value. */
  readonly diagnostic?: string;
}

export interface AgentHomeInputs {
  readonly env: Readonly<Partial<Pick<NodeJS.ProcessEnv, "PI_CODING_AGENT_DIR" | "PI_AGENT_DIR">>>;
  readonly startupCwd: string;
  readonly userHome: string;
}

export const AGENT_HOME_CONFLICT_DIAGNOSTIC =
  "Agent-home aliases disagree; PI_CODING_AGENT_DIR takes precedence over PI_AGENT_DIR.";

function validPath(value: string, source: string): void {
  // Drive-relative Windows paths can consult ambient per-drive cwd in path.resolve.
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    (sep === "\\" && /^[a-z]:($|[^\\/])/i.test(value))
  ) {
    throw new Error(`Invalid agent-home path (${source}).`);
  }
}

/** Pure lexical resolution: no stat, realpath, credential lookup, or directory creation. */
export function resolveAgentHome({ env, startupCwd, userHome }: AgentHomeInputs): AgentHome {
  validPath(startupCwd, "startup cwd");
  if (!isAbsolute(startupCwd)) throw new Error("Invalid agent-home startup cwd: must be absolute.");

  const normalize = (value: string, source: AgentHomeSource): string => {
    validPath(value, source);
    if (value.startsWith("~/") || (sep === "\\" && value.startsWith("~\\"))) {
      validPath(userHome, "user home");
      if (!isAbsolute(userHome)) throw new Error("Invalid agent-home user home: must be absolute.");
      return resolve(`${userHome}${sep}${value.slice(2)}`);
    }
    return resolve(startupCwd, value);
  };
  // Only the empty string is unset: whitespace can be a valid directory name.
  const official = env.PI_CODING_AGENT_DIR;
  const legacy = env.PI_AGENT_DIR;
  const officialPath =
    official !== undefined && official !== ""
      ? normalize(official, "PI_CODING_AGENT_DIR")
      : undefined;
  const legacyPath =
    legacy !== undefined && legacy !== "" ? normalize(legacy, "PI_AGENT_DIR") : undefined;
  const source: AgentHomeSource =
    officialPath !== undefined
      ? "PI_CODING_AGENT_DIR"
      : legacyPath !== undefined
        ? "PI_AGENT_DIR"
        : "default";
  const conflict =
    officialPath !== undefined && legacyPath !== undefined && officialPath !== legacyPath;
  return Object.freeze({
    path: officialPath ?? legacyPath ?? normalize("~/.pi/agent", "default"),
    source,
    conflict,
    ...(conflict ? { diagnostic: AGENT_HOME_CONFLICT_DIAGNOSTIC } : {}),
  });
}

// Capture on first extension import, before session startup. Pi reloads extension
// modules; retain only the cwd on the process-wide symbol, never env or home values.
const startupCwdKey = Symbol.for("pi-blackbytes.agent-home.startup-cwd");
const processState = globalThis as typeof globalThis & { [startupCwdKey]?: string };
if (processState[startupCwdKey] === undefined) {
  Object.defineProperty(processState, startupCwdKey, { value: process.cwd() });
}
const startupCwd = processState[startupCwdKey] as string;

/** Pre-session resolution uses the same captured cwd as session initialization. */
export function resolveStartupAgentHome(): AgentHome {
  return resolveAgentHome({ env: process.env, startupCwd, userHome: homedir() });
}
