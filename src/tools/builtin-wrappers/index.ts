import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BlackbytesUiConfig } from "../../config/schema.js";
import { registerBashWrapper } from "./bash.js";

export function registerBuiltinWrappers(
  pi: ExtensionAPI,
  opts: { readonly cwd: string; readonly ui: BlackbytesUiConfig },
): void {
  registerBashWrapper(pi, opts);
}
