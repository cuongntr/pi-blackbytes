import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { bootstrap } from "./bootstrap.js";

export default function (pi: ExtensionAPI): void {
  bootstrap(pi);
}
