// Node permission backstop for reviewed instrumentation, NOT a JavaScript sandbox.
// No SDK imports. The preflight queries capabilities; it never tries forbidden I/O.
import { syntheticLockPaths } from "./sdk-child-rehearsal-locks.mjs";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

export function permissionArgs({ readPaths, receiptPaths, lockFixture, profile = "sdk-provider" }) {
  if (!["sdk-provider", "launcher-parent"].includes(profile) ||
      !Array.isArray(readPaths) || !readPaths.length || !Array.isArray(receiptPaths))
    throw new Error("permission_profile_invalid");
  const lockPaths = lockFixture === undefined ? [] : syntheticLockPaths(lockFixture.root, lockFixture.files);
  const paths = [...readPaths, ...receiptPaths, ...lockPaths];
  // Caller supplies already canonical reviewed files/directories, never wildcard grants.
  if (paths.some((path) => typeof path !== "string" || !isAbsolute(path) || /[*\0\r\n]/.test(path)))
    throw new Error("permission_path_invalid");
  return ["--permission", ...new Set(readPaths.map((path) => `--allow-fs-read=${path}`)),
    ...new Set([...receiptPaths, ...lockPaths].map((path) => `--allow-fs-write=${path}`)),
    ...(profile === "launcher-parent" ? ["--allow-child-process"] : [])];
  // Worker/addon/WASI/inspector remain denied. Parent child permission is ONLY a
  // backstop: reviewed exact-spawn sentinel must additionally constrain it.
}

export function permissionPreflight() {
  if (process.version !== "v24.18.0") throw new Error("permission_node_version_unsupported");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bb-permission-preflight-")));
  const program = join(root, "probe.cjs");
  const receipt = join(root, "receipt.json");
  const denied = join(root, "not-granted");
  try {
    writeFileSync(receipt, "");
    writeFileSync(program, `const p = process.permission;
const [program, receipt, denied] = process.argv.slice(2);
const checks = [!!p, p?.has('fs.read', program), p?.has('fs.write', receipt),
 !p?.has('fs.write', program), !p?.has('fs.read', denied), !p?.has('fs.write', denied),
 ...['child', 'worker', 'addons', 'wasi', 'inspector'].map(scope => !p?.has(scope))];
process.stdout.write(JSON.stringify({schema:1, node:process.version, capability:checks.every(Boolean), checks:checks.length}));
process.exitCode = checks.every(Boolean) ? 0 : 1;
`);
    const result = spawnSync(process.execPath, [...permissionArgs({ readPaths: [program], receiptPaths: [receipt] }), program, program, receipt, denied], {
      cwd: root, env: {}, shell: false, encoding: "utf8", timeout: 5000, maxBuffer: 8192,
    });
    if (result.error || result.status !== 0 || result.signal || result.stderr)
      throw new Error("permission_capability_BLOCKED");
    const observation = JSON.parse(result.stdout);
    if (observation.capability !== true || observation.checks !== 11 || observation.node !== process.version)
      throw new Error("permission_capability_BLOCKED");
    return { ...observation, sdkExecution: "NOT RUN", forbiddenOperationsAttempted: 0 };
  } finally {
    rmSync(root, { recursive: true }); // Only this owned tiny trusted preflight; no SDK children.
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { console.log(JSON.stringify(permissionPreflight())); }
  catch { console.error("permission_preflight_BLOCKED"); process.exitCode = 1; }
}
