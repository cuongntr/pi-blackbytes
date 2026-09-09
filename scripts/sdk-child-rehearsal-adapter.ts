// Isolated Bun build only (--target node --packages external). Never a package entry.
// Execution remains blocked by the matrix; this adapter is a review candidate, not authority.
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { launchManagedSdkChild, type ManagedLaunchOptions } from "../src/sub-agents/sdk-launcher.js";
export { ChildEventDecoder } from "../src/sub-agents/sdk-child-protocol.js";

export interface ReviewedPreload {
  entry: string;
  preload: string;
  config: string;
}
/** Only augments the production argv with an explicit preload/config; cannot override
 * deadline, envelope, process executable, environment, signal handling or stdio.
 * Caller must verify immutable hashes AND instrument the parent before importing SDK VERSION.
 */
export function preloadSpawn(reviewed: ReviewedPreload): typeof spawn {
  const { entry, preload, config } = Object.freeze({ ...reviewed });
  if (![entry, preload, config].every(isAbsolute)) throw new Error("absolute_reviewed_paths_required");
  return ((command: string, args: readonly string[], options: Parameters<typeof spawn>[2]) => {
    if (command !== process.execPath || args.length !== 3 ||
      args[0] !== "--experimental-import-meta-resolve" || args[1] !== entry ||
      !Number.isFinite(Number(args[2])) || options?.shell !== false ||
      JSON.stringify(options.stdio) !== '["pipe","pipe","pipe","pipe"]')
      throw new Error("unreviewed_spawn_shape");
    return spawn(command, [args[0], "--import", preload, ...args.slice(1), config], options);
  }) as typeof spawn;
}
export function launchReviewedChild(options: ManagedLaunchOptions, reviewed: ReviewedPreload) {
  return launchManagedSdkChild(options, {
    spawn: preloadSpawn(reviewed),
    entry: reviewed.entry,
    access,
    nestedDepth: () => Number(process.env.PI_NESTED_DEPTH ?? 0),
    expectedVersion: async () => {
      const root = import.meta.resolve("@earendil-works/pi-coding-agent", pathToFileURL(reviewed.entry).href);
      return (await import(root)).VERSION as string;
    },
    signalChild(child, signal) {
      try {
        if (process.platform === "linux" && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch { /* Production drain, not signal delivery, proves direct-child settlement. */ }
    },
  });
}
