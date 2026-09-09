// Review/inventory only. No SDK imports, sessions, spawn, installs or execution path.
import { readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { digest, sha, runtimeInventory } from "./sdk-child-rehearsal-inventory.mjs";
import { MATRIX, LIMITS, requireRunnable } from "./sdk-child-rehearsal-matrix.mjs";
const repository = fileURLToPath(new URL("..", import.meta.url));
async function inventory(entry, adapter) {
  if (!adapter || !isAbsolute(adapter)) throw new Error("isolated_adapter_build_required");
  const files = { "isolated-adapter": await digest(adapter) };
  const sources = ["package.json", ...(await readdir(join(repository, "scripts"))).filter((name) => name.startsWith("sdk-child-rehearsal")).map((name) => `scripts/${name}`)];
  for (const dir of ["src/sub-agents", "src/sub-agents/__tests__"]) {
    for (const name of await readdir(join(repository, dir))) if (name.startsWith("sdk-")) sources.push(`${dir}/${name}`);
  }
  // Core launcher transitives are captured in the isolated adapter/installed child build hashes;
  // the source list is supplementary, not a replacement for those build hashes.
  for (const path of sources.sort()) files[path] = await digest(join(repository, path));
  const protocolSha256 = await digest(join(repository, "docs/plans/sdk-child-controlled-rehearsal-protocol.md"));
  const erratumSha256 = await digest(join(repository, "docs/plans/subagent-mechanism-hardening-change-002-model-identity-erratum.md"));
  const amendmentSha256 = await digest(join(repository, "docs/plans/sdk-child-synthetic-lock-amendment.md"));
  const runtime = await runtimeInventory(entry);
  return { execution: "NOT RUN", readiness: "BLOCKED", files, protocolSha256, erratumSha256, amendmentSha256,
    candidateSha256: sha(JSON.stringify({ files, protocolSha256, erratumSha256, amendmentSha256, runtimeSha256: runtime.sha256 })),
    runtime, matrix: MATRIX, limits: LIMITS,
    gaps: ["Independent parent R2 review pending", "No variant satisfies complete sentinel/receipt requirements; run disabled"] };
}
try {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === "--inventory") console.log(JSON.stringify(await inventory(args[0], args[1]), null, 2));
  else if (mode === "--matrix") console.log(JSON.stringify({ matrix: MATRIX, limits: LIMITS }, null, 2));
  else if (mode === "--run") {
    requireRunnable(args[2], args[3]);
    // Intentional second guard: matrix edits alone cannot enable execution.
    throw new Error("reviewed_execution_driver_not_ready");
  } else throw new Error("usage: --inventory ABSOLUTE_CHILD ABSOLUTE_ADAPTER | --matrix; --run is BLOCKED");
} catch {
  // Never echo exception messages containing paths, raw inputs, argv or credentials.
  console.error("rehearsal_BLOCKED_see_readiness_matrix");
  process.exitCode = 1;
}
