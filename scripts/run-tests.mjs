import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const srcDir = join(rootDir, "src");
const evalDir = join(rootDir, "scripts", "context-pruning");

/**
 * Recursively collect test files from a directory.
 *
 * Excludes files matching the opt-in naming convention (`*.opt-in.test.ts`)
 * and files inside directories named `__opt_in__`.
 *
 * @param {string} dir - Directory to scan.
 * @returns {string[]} Relative paths to discovered test files.
 */
function collectTestFiles(dir) {
  const files = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__opt_in__") continue;
      files.push(...collectTestFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      if (entry.name.endsWith(".opt-in.test.ts")) continue;
      files.push(relative(rootDir, fullPath));
    }
  }
  return files;
}

const testFiles = [
  ...collectTestFiles(srcDir),
  ...collectTestFiles(evalDir),
].sort();

if (testFiles.length === 0) {
  console.error("No test files found.");
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...testFiles], {
  cwd: rootDir,
  stdio: "inherit",
  env: { ...process.env, EVIDENCE_HERMETIC_TESTS: "1", NODE_ENV: "test" },
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
