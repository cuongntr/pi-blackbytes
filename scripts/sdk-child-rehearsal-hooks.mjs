// Import-safe. Installation must precede SDK imports; no asynchronous loader thread.
import { registerHooks } from "node:module";
import { moduleHooks } from "./sdk-child-rehearsal-policy.mjs";
export function registerReviewedModuleHooks(manifest, originals, register = registerHooks) {
  if (typeof register !== "function" || !Array.isArray(manifest.files) || !Array.isArray(manifest.builtins))
    throw new Error("fixture_module_hooks_unavailable");
  return register(moduleHooks(manifest, originals));
}
