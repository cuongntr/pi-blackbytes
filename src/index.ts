import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { bootstrap } from "./bootstrap.js";

console.log("pi-blackbytes v0.1.0 loaded");

export default function (pi: ExtensionAPI): void {
  bootstrap(pi);
}
