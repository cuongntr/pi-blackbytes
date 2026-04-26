import { spawnSync } from "node:child_process";

/** Languages supported by ast-grep */
export const AST_GREP_LANGUAGES = [
  "bash",
  "c",
  "cpp",
  "csharp",
  "css",
  "elixir",
  "go",
  "haskell",
  "html",
  "java",
  "javascript",
  "json",
  "kotlin",
  "lua",
  "nix",
  "php",
  "python",
  "ruby",
  "rust",
  "scala",
  "solidity",
  "swift",
  "typescript",
  "tsx",
  "yaml",
] as const;

export type AstGrepLanguage = (typeof AST_GREP_LANGUAGES)[number];

export interface BinaryResult {
  found: true;
  bin: string;
}

export interface BinaryMissing {
  found: false;
  error: string;
}

/** Detect ast-grep binary (ast-grep or sg). */
export function detectBinary(): BinaryResult | BinaryMissing {
  for (const bin of ["ast-grep", "sg"]) {
    const result = spawnSync(bin, ["--version"], { encoding: "utf8" });
    if (result.status === 0 || result.stdout) {
      return { found: true, bin };
    }
  }
  return {
    found: false,
    error:
      "ast-grep binary not found. Install it with: cargo install ast-grep, or see https://ast-grep.github.io/guide/quick-start.html",
  };
}

export interface SpawnResult {
  ok: true;
  stdout: string;
  stderr: string;
  status: number;
}

export interface SpawnError {
  ok: false;
  error: string;
  stderr?: string;
}

/** Spawn an ast-grep command synchronously and return the output. */
export function runAstGrep(bin: string, args: string[]): SpawnResult | SpawnError {
  const result = spawnSync(bin, args, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });

  if (result.error) {
    return { ok: false, error: result.error.message };
  }

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const status = result.status ?? 0;

  // ast-grep exits with 1 when no matches are found. Treat that as a
  // successful empty result only when the CLI produced parseable/empty output
  // and no diagnostic stderr. Other non-zero statuses are real failures.
  if (status > 1 || (status === 1 && stderr.trim() && !stdout.trim())) {
    return {
      ok: false,
      error: stderr.trim() || stdout.trim() || `ast-grep exited with code ${status}`,
      stderr,
    };
  }

  return {
    ok: true,
    stdout,
    stderr,
    status,
  };
}
