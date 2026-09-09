// Tiny trusted disposable Node permission proof only: zero SDK imports/sessions.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, readFileSync, readdirSync, lstatSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { permissionArgs } from "./sdk-child-rehearsal-permission.mjs";
const digest = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
export function lockPermissionPreflight() {
  if (process.version !== "v24.18.0") throw new Error("lock_permission_node_version_unsupported");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bb-synthetic-lock-proof-")));
  const home = join(root, "agent-a");
  mkdirSync(home);
  const files = [join(home, "auth.json"), join(home, "settings.json")];
  const program = join(root, "probe.cjs");
  // Initial explicitly synthetic preparation only; never copied from any source.
  for (const file of files) writeFileSync(file, "{}\n", { flag: "wx", mode: 0o600 });
  const before = files.map(digest);
  const identities = [root, home, ...files].map((path) => { const stat = lstatSync(path); return `${stat.dev}:${stat.ino}`; });
  writeFileSync(program, `const fs = require('node:fs');
const files = process.argv.slice(2);
const checks = [];
for (const file of files) {
  const lock = file + '.lock';
  checks.push(process.permission.has('fs.write', lock), !process.permission.has('fs.write', file),
    !process.permission.has('fs.write', require('node:path').dirname(file)),
    !process.permission.has('fs.write', lock + '/unexpected'));
  if (!checks.every(Boolean)) process.exit(1);
  fs.mkdirSync(lock);
  checks.push(fs.statSync(lock).isDirectory());
  fs.utimesSync(lock, 1, 2);
  checks.push(fs.statSync(lock).mtimeMs === 2000);
  fs.rmdirSync(lock);
}
checks.push(...['child','worker','addons','wasi','inspector'].map(scope => !process.permission.has(scope)));
process.stdout.write(JSON.stringify({ checks: checks.length, passed: checks.every(Boolean) }));
process.exitCode = checks.every(Boolean) ? 0 : 1;
`, { flag: "wx", mode: 0o600 });
  const args = permissionArgs({ readPaths: [program, ...files, ...files.map((file) => `${file}.lock`)], receiptPaths: [], lockFixture: { root, files } });
  const result = spawnSync(process.execPath, [...args, program, ...files], { cwd: root, env: {}, shell: false, encoding: "utf8", timeout: 5000, maxBuffer: 8192 });
  // No uncertain-process or unexpected-content recursive cleanup. Retain on failure.
  if (result.error || result.status !== 0 || result.signal || result.stderr) throw new Error("lock_permission_BLOCKED_fixture_retained");
  const observation = JSON.parse(result.stdout);
  if (!observation.passed || observation.checks !== 17 ||
      realpathSync(root) !== root || lstatSync(root).isSymbolicLink() || realpathSync(home) !== home || lstatSync(home).isSymbolicLink() ||
      JSON.stringify(readdirSync(root).sort()) !== JSON.stringify(["agent-a", "probe.cjs"]) ||
      JSON.stringify(readdirSync(home).sort()) !== JSON.stringify(["auth.json", "settings.json"])) throw new Error("lock_cleanup_BLOCKED_fixture_retained");
  for (const file of [...files, program]) {
    if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink() || lstatSync(file).nlink !== 1 || realpathSync(file) !== file)
      throw new Error("lock_cleanup_BLOCKED_fixture_retained");
  }
  if ([root, home, ...files].some((path, i) => { const stat = lstatSync(path); return `${stat.dev}:${stat.ino}` !== identities[i]; }))
    throw new Error("lock_cleanup_BLOCKED_fixture_retained");
  const after = files.map(digest);
  if (after.some((hash, i) => hash !== before[i])) throw new Error("lock_cleanup_BLOCKED_fixture_retained");
  for (const file of [...files, program]) unlinkSync(file);
  rmdirSync(home); rmdirSync(root);
  return { ...observation, node: process.version, root, files: files.map((path, i) => ({ path, lock: `${path}.lock`, beforeSha256: before[i], afterSha256: after[i] })),
    exactLockWriteGrants: true, hashesUnchanged: true, locksAbsent: true, directChildClosed: true,
    fixtureRemoved: true, forbiddenOperationsAttempted: 0, sdkExecution: "NOT RUN" };
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { console.log(JSON.stringify(lockPermissionPreflight())); }
  catch { console.error("lock_permission_preflight_BLOCKED_fixture_retained"); process.exitCode = 1; }
}
