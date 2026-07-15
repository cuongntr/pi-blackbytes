/** Disposable, evaluation-only continuation fixtures for objective task checks. */

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readdir, realpath, rmdir, unlink } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { canonicalDigest, canonicalJson } from "./canonical-json.js";
import {
  ensurePrivateDir,
  safeRunFileExists,
  safeRunPublishExclusiveFile,
  safeRunReadFile,
} from "./path-safety.js";
import type { SafeRun } from "./path-safety.js";
import { loadVerifiedRepositoryFixtureMaterial, validateRepositoryFixture } from "./snapshots.js";
import type { RepositoryFixture, VerifiedRepositoryFixtureMaterial } from "./snapshots.js";
import { EvidenceStoreError } from "./types.js";

const execFileAsync = promisify(execFile);
const DIGEST = /^[a-f0-9]{64}$/;
const DEFAULT_FIXTURE_ROOT = "sandbox-fixtures";
const RESULT_DIRECTORY = "sandbox-continuation-results";
const MAX_HIDDEN_CHECK_OUTPUT_BYTES = 1_048_576;

export type SandboxArm = "native" | "selective";
export type HiddenCheckStatus = "pass" | "fail" | "timeout" | "error";

/** The complete fixed capability budget supplied to each continuation arm. */
export interface ContinuationCaps {
  readonly allowedTools: readonly string[];
  readonly requestLimit: number;
}

/** A hidden check is always an executable plus argv: it is never evaluated through a shell. */
export interface HiddenCheckDefinition {
  readonly checkId: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
}

export interface HiddenCheckResult {
  /** Opaque digest of the hidden check; its identifier/command/args are never persisted. */
  readonly checkDigest: string;
  readonly status: HiddenCheckStatus;
  readonly exitCode: number | null;
  readonly outputDigest: string;
}

export interface ContinuationArmUsage {
  readonly requestsUsed: number;
  readonly toolsUsed: readonly string[];
}

/**
 * This adapter is intentionally provider-agnostic. It receives no original repository
 * path and reports only capability-accounting metadata, never a model response.
 */
export interface ContinuationArmAdapter {
  continue(input: {
    readonly arm: SandboxArm;
    readonly cwd: string;
    readonly caps: ContinuationCaps;
  }): Promise<ContinuationArmUsage>;
}

/**
 * Fixture decoding is injected because T-008 owns archive/patch encoding. The only
 * bytes it receives are freshly digest-verified private fixture artifacts.
 */
export interface FixtureCopyWorktreeAdapter {
  materialize(input: {
    readonly fixture: Exclude<RepositoryFixture, { readonly status: "unavailable" }>;
    readonly material: Exclude<
      VerifiedRepositoryFixtureMaterial,
      { readonly fixture: { readonly status: "unavailable" } }
    >;
    readonly destination: string;
  }): Promise<void>;
}

export interface SandboxContinuationInput {
  readonly safeRun: SafeRun;
  readonly snapshotDigest: string;
  readonly objectiveChecksDigest: string;
  readonly fixture: RepositoryFixture;
  /** Existing original repository path, used only for canonical identity refusal. */
  readonly originalRepositoryPath: string;
  readonly caps: ContinuationCaps;
  readonly hiddenChecks: readonly HiddenCheckDefinition[];
  readonly materializer: FixtureCopyWorktreeAdapter;
  readonly continuation: ContinuationArmAdapter;
}

export type SandboxContinuationResult =
  | {
      readonly schemaVersion: 1;
      readonly type: "sandbox-continuation-result-v1";
      readonly snapshotDigest: string;
      readonly fixtureStatus: "unavailable";
      readonly execution: "rubric-only";
      readonly reasonCode: "fixture-not-captured" | "fixture-integrity-failed";
      readonly resultDigest: string;
    }
  | {
      readonly schemaVersion: 1;
      readonly type: "sandbox-continuation-result-v1";
      readonly snapshotDigest: string;
      readonly fixtureStatus: "exact" | "reconstructed";
      readonly execution: "executed";
      readonly capsDigest: string;
      readonly hiddenChecksDigest: string;
      readonly arms: readonly {
        readonly arm: SandboxArm;
        readonly usage: ContinuationArmUsage;
        readonly checks: readonly HiddenCheckResult[];
      }[];
      readonly resultDigest: string;
    };

interface PreparedFixture {
  readonly arm: SandboxArm;
  readonly root: string;
  readonly rootRealpath: string;
  readonly dev: number;
  readonly ino: number;
}

const preparedFixtures = new WeakMap<object, PreparedFixture>();

function fail(
  code: "E_EVAL_SCHEMA" | "E_EVAL_INTEGRITY" | "E_EVAL_UNSAFE_PATH",
  message: string,
): never {
  throw new EvidenceStoreError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return canonicalJson(Object.keys(value).sort()) === canonicalJson([...expected].sort());
}

function digest(value: unknown, field: string): string {
  if (typeof value !== "string" || !DIGEST.test(value))
    fail("E_EVAL_SCHEMA", `${field} must be a SHA-256 digest`);
  return value;
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0"))
    fail("E_EVAL_SCHEMA", `${field} must be a non-empty string without NUL`);
  return value;
}

function positive(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    fail("E_EVAL_SCHEMA", `${field} must be a positive safe integer`);
  return value as number;
}

function isInside(child: string, parent: string): boolean {
  const path = relative(parent, child);
  return path.length > 0 && !path.startsWith("..") && !path.includes("../");
}

function hashBytes(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hiddenCheckDefinitionDigest(checks: readonly HiddenCheckDefinition[]): string {
  return canonicalDigest({ domain: "pi-blackbytes:context-pruning:hidden-checks:v1", checks });
}

export function continuationCapsDigest(caps: ContinuationCaps): string {
  return canonicalDigest({ domain: "pi-blackbytes:context-pruning:continuation-caps:v1", caps });
}

export function validateContinuationCaps(value: unknown): ContinuationCaps {
  if (!isRecord(value) || !exactKeys(value, ["allowedTools", "requestLimit"]))
    fail("E_EVAL_SCHEMA", "continuation caps must use the exact schema");
  if (!Array.isArray(value.allowedTools) || value.allowedTools.length === 0)
    fail("E_EVAL_SCHEMA", "allowedTools must be a non-empty array");
  const allowedTools = value.allowedTools.map((tool) => nonEmpty(tool, "allowedTools item"));
  if (new Set(allowedTools).size !== allowedTools.length)
    fail("E_EVAL_SCHEMA", "allowedTools must be unique");
  return Object.freeze({
    allowedTools: Object.freeze(allowedTools),
    requestLimit: positive(value.requestLimit, "requestLimit"),
  });
}

export function validateHiddenCheckDefinitions(value: unknown): readonly HiddenCheckDefinition[] {
  if (!Array.isArray(value) || value.length === 0)
    fail("E_EVAL_SCHEMA", "hidden checks must be a non-empty array");
  const ids = new Set<string>();
  const checks = value.map((item) => {
    if (!isRecord(item) || !exactKeys(item, ["args", "checkId", "command", "timeoutMs"]))
      fail("E_EVAL_SCHEMA", "hidden check must use the exact schema");
    const checkId = nonEmpty(item.checkId, "checkId");
    const command = nonEmpty(item.command, "command");
    if (!Array.isArray(item.args)) fail("E_EVAL_SCHEMA", "hidden check args must be an array");
    if (ids.has(checkId)) fail("E_EVAL_SCHEMA", "hidden check IDs must be unique");
    ids.add(checkId);
    return Object.freeze({
      checkId,
      command,
      args: Object.freeze(item.args.map((arg) => nonEmpty(arg, "hidden check arg"))),
      timeoutMs: positive(item.timeoutMs, "hidden check timeoutMs"),
    });
  });
  return Object.freeze(checks);
}

async function canonicalOriginalRepository(
  path: string,
): Promise<{ readonly realpath: string; readonly dev: number; readonly ino: number }> {
  const unresolved = resolve(nonEmpty(path, "originalRepositoryPath"));
  let stats: import("node:fs").Stats;
  try {
    stats = await lstat(unresolved);
  } catch {
    return fail("E_EVAL_UNSAFE_PATH", "original repository path is inaccessible");
  }
  if (stats.isSymbolicLink() || !stats.isDirectory())
    return fail("E_EVAL_UNSAFE_PATH", "original repository path must be a real directory");
  const canonical = await realpath(unresolved);
  // Parent-directory aliases (for example macOS /var -> /private/var) are
  // normalized here; the final component itself was lstat above and cannot be a link.
  return Object.freeze({ realpath: canonical, dev: stats.dev, ino: stats.ino });
}

/** Reject links, specials, hardlinked files, and mount/device crossings in a disposable tree. */
async function inspectFixtureTree(
  root: string,
): Promise<{ readonly dev: number; readonly ino: number }> {
  const rootStats = await lstat(root);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory())
    return fail("E_EVAL_UNSAFE_PATH", "disposable fixture root is not a real directory");
  const rootRealpath = await realpath(root);
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      const stats = await lstat(path);
      if (stats.isSymbolicLink() || stats.dev !== rootStats.dev)
        fail("E_EVAL_UNSAFE_PATH", "disposable fixture contains an unsafe path");
      if (stats.isDirectory()) await walk(path);
      else if (!stats.isFile() || stats.nlink !== 1)
        fail("E_EVAL_UNSAFE_PATH", "disposable fixture contains a special or hardlinked file");
    }
  };
  await walk(root);
  return Object.freeze({ dev: rootStats.dev, ino: rootStats.ino });
}

function assertUsage(value: ContinuationArmUsage, caps: ContinuationCaps): ContinuationArmUsage {
  const usage = validateUsage(value);
  if (usage.requestsUsed > caps.requestLimit)
    fail("E_EVAL_INTEGRITY", "continuation request limit was exceeded");
  if (usage.toolsUsed.some((tool) => !caps.allowedTools.includes(tool)))
    fail("E_EVAL_INTEGRITY", "continuation used a tool outside the fixed allowlist");
  return usage;
}

function validateUsage(value: unknown): ContinuationArmUsage {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["requestsUsed", "toolsUsed"]) ||
    !Number.isSafeInteger(value.requestsUsed) ||
    (value.requestsUsed as number) < 0 ||
    !Array.isArray(value.toolsUsed) ||
    value.toolsUsed.some((tool) => typeof tool !== "string" || tool.length === 0)
  )
    fail("E_EVAL_SCHEMA", "continuation usage metadata is invalid");
  return Object.freeze({
    requestsUsed: value.requestsUsed as number,
    toolsUsed: Object.freeze([...value.toolsUsed] as string[]),
  });
}

async function runHiddenCheck(
  check: HiddenCheckDefinition,
  cwd: string,
): Promise<HiddenCheckResult> {
  const checkDigest = canonicalDigest(check);
  let status: HiddenCheckStatus = "pass";
  let exitCode: number | null = 0;
  let output = Buffer.alloc(0);
  try {
    const completed = await execFileAsync(check.command, [...check.args], {
      cwd,
      shell: false,
      timeout: check.timeoutMs,
      maxBuffer: MAX_HIDDEN_CHECK_OUTPUT_BYTES,
      windowsHide: true,
    });
    output = Buffer.concat([Buffer.from(completed.stdout), Buffer.from(completed.stderr)]);
  } catch (error: unknown) {
    const detail = error as {
      killed?: boolean;
      code?: number | string | null;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    output = Buffer.concat([Buffer.from(detail.stdout ?? ""), Buffer.from(detail.stderr ?? "")]);
    status =
      detail.killed === true ? "timeout" : typeof detail.code === "number" ? "fail" : "error";
    exitCode = typeof detail.code === "number" ? detail.code : null;
  }
  return Object.freeze({
    checkDigest,
    status,
    exitCode,
    outputDigest: hashBytes(output),
  });
}

async function prepareArm(
  input: SandboxContinuationInput,
  material: Exclude<
    VerifiedRepositoryFixtureMaterial,
    { readonly fixture: { readonly status: "unavailable" } }
  >,
  fixtureRoot: string,
  fixtureRootRealpath: string,
  original: { readonly realpath: string; readonly dev: number; readonly ino: number },
  arm: SandboxArm,
): Promise<object> {
  const name = `${input.snapshotDigest.slice(0, 16)}-${arm}-${randomUUID()}`;
  const destination = await ensurePrivateDir(input.safeRun, `${DEFAULT_FIXTURE_ROOT}/${name}`);
  if (!isInside(destination, fixtureRoot) || basename(destination) !== name)
    fail("E_EVAL_UNSAFE_PATH", "disposable fixture escaped the dedicated SafeRun fixture root");
  await input.materializer.materialize({ fixture: material.fixture, material, destination });
  const identity = await inspectFixtureTree(destination);
  const destinationRealpath = await realpath(destination);
  if (
    !isInside(destinationRealpath, fixtureRootRealpath) ||
    destinationRealpath === original.realpath
  )
    fail(
      "E_EVAL_UNSAFE_PATH",
      "disposable fixture aliases the original repository or escaped its root",
    );
  if (identity.dev === original.dev && identity.ino === original.ino)
    fail("E_EVAL_UNSAFE_PATH", "disposable fixture has the original repository identity");
  const handle = Object.freeze({});
  preparedFixtures.set(
    handle,
    Object.freeze({ arm, root: destination, rootRealpath: destinationRealpath, ...identity }),
  );
  return handle;
}

function fixtureFromHandle(handle: object): PreparedFixture {
  const fixture = preparedFixtures.get(handle);
  if (fixture === undefined) fail("E_EVAL_INTEGRITY", "unknown disposable fixture handle");
  return fixture;
}

function isExecutableMaterial(
  material: VerifiedRepositoryFixtureMaterial,
): material is Exclude<
  VerifiedRepositoryFixtureMaterial,
  { readonly fixture: { readonly status: "unavailable" } }
> {
  return material.fixture.status === "exact" || material.fixture.status === "reconstructed";
}

/**
 * Delete only a registered disposable tree. A root replacement, alias, symlink,
 * hardlink, or device change fails closed before a path below that root is removed.
 */
export async function cleanupDisposableFixture(handle: object): Promise<void> {
  const fixture = fixtureFromHandle(handle);
  let current: import("node:fs").Stats;
  try {
    current = await lstat(fixture.root);
  } catch (error: unknown) {
    if (isRecord(error) && error.code === "ENOENT") return;
    throw error;
  }
  if (
    current.isSymbolicLink() ||
    !current.isDirectory() ||
    current.dev !== fixture.dev ||
    current.ino !== fixture.ino
  )
    fail("E_EVAL_INTEGRITY", "disposable fixture identity changed before cleanup");
  if ((await realpath(fixture.root)) !== fixture.rootRealpath)
    fail("E_EVAL_INTEGRITY", "disposable fixture path changed before cleanup");
  const remove = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      const stats = await lstat(path);
      if (stats.isSymbolicLink() || stats.dev !== fixture.dev)
        fail("E_EVAL_INTEGRITY", "disposable fixture became unsafe before cleanup");
      if (stats.isDirectory()) await remove(path);
      else if (stats.isFile() && stats.nlink === 1) await unlink(path);
      else fail("E_EVAL_INTEGRITY", "disposable fixture contains unsafe cleanup target");
    }
    await rmdir(directory);
  };
  await remove(fixture.root);
}

function unsignedResult(
  result: SandboxContinuationResult,
): Omit<SandboxContinuationResult, "resultDigest"> {
  const { resultDigest: _ignored, ...unsigned } = result;
  return unsigned;
}

export function validateSandboxContinuationResult(value: unknown): SandboxContinuationResult {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.type !== "sandbox-continuation-result-v1"
  )
    fail("E_EVAL_SCHEMA", "sandbox continuation result has an invalid header");
  const snapshotDigest = digest(value.snapshotDigest, "snapshotDigest");
  const resultDigest = digest(value.resultDigest, "resultDigest");
  if (value.fixtureStatus === "unavailable") {
    if (
      !exactKeys(value, [
        "execution",
        "fixtureStatus",
        "reasonCode",
        "resultDigest",
        "schemaVersion",
        "snapshotDigest",
        "type",
      ]) ||
      value.execution !== "rubric-only" ||
      (value.reasonCode !== "fixture-not-captured" &&
        value.reasonCode !== "fixture-integrity-failed")
    )
      fail("E_EVAL_SCHEMA", "rubric-only continuation result is invalid");
    const result = {
      schemaVersion: 1 as const,
      type: "sandbox-continuation-result-v1" as const,
      snapshotDigest,
      fixtureStatus: "unavailable" as const,
      execution: "rubric-only" as const,
      reasonCode: value.reasonCode as "fixture-not-captured" | "fixture-integrity-failed",
      resultDigest,
    };
    if (canonicalDigest(unsignedResult(result)) !== resultDigest)
      fail("E_EVAL_INTEGRITY", "sandbox continuation result digest mismatch");
    return Object.freeze(result);
  }
  if (
    (value.fixtureStatus !== "exact" && value.fixtureStatus !== "reconstructed") ||
    value.execution !== "executed" ||
    !exactKeys(value, [
      "arms",
      "capsDigest",
      "execution",
      "fixtureStatus",
      "hiddenChecksDigest",
      "resultDigest",
      "schemaVersion",
      "snapshotDigest",
      "type",
    ]) ||
    !Array.isArray(value.arms) ||
    value.arms.length !== 2
  )
    fail("E_EVAL_SCHEMA", "executed continuation result is invalid");
  const arms = value.arms.map((item) => {
    if (
      !isRecord(item) ||
      !exactKeys(item, ["arm", "checks", "usage"]) ||
      (item.arm !== "native" && item.arm !== "selective") ||
      !Array.isArray(item.checks) ||
      !isRecord(item.usage)
    )
      fail("E_EVAL_SCHEMA", "continuation arm result is invalid");
    const usage = validateUsage(item.usage);
    const checks = item.checks.map((check) => {
      if (
        !isRecord(check) ||
        !exactKeys(check, ["checkDigest", "exitCode", "outputDigest", "status"]) ||
        !["pass", "fail", "timeout", "error"].includes(check.status as string) ||
        (check.exitCode !== null && !Number.isSafeInteger(check.exitCode))
      )
        fail("E_EVAL_SCHEMA", "hidden check result is invalid");
      return Object.freeze({
        checkDigest: digest(check.checkDigest, "checkDigest"),
        status: check.status as HiddenCheckStatus,
        exitCode: check.exitCode as number | null,
        outputDigest: digest(check.outputDigest, "outputDigest"),
      });
    });
    return Object.freeze({ arm: item.arm as SandboxArm, usage, checks: Object.freeze(checks) });
  });
  if (new Set(arms.map((arm) => arm.arm)).size !== 2)
    fail("E_EVAL_SCHEMA", "continuation arms must be separate");
  const result = {
    schemaVersion: 1 as const,
    type: "sandbox-continuation-result-v1" as const,
    snapshotDigest,
    fixtureStatus: value.fixtureStatus as "exact" | "reconstructed",
    execution: "executed" as const,
    capsDigest: digest(value.capsDigest, "capsDigest"),
    hiddenChecksDigest: digest(value.hiddenChecksDigest, "hiddenChecksDigest"),
    arms: Object.freeze(arms),
    resultDigest,
  };
  if (canonicalDigest(unsignedResult(result)) !== resultDigest)
    fail("E_EVAL_INTEGRITY", "sandbox continuation result digest mismatch");
  return Object.freeze(result);
}

async function persistResult(safeRun: SafeRun, result: SandboxContinuationResult): Promise<void> {
  const checked = validateSandboxContinuationResult(result);
  await ensurePrivateDir(safeRun, RESULT_DIRECTORY);
  const path = `${RESULT_DIRECTORY}/${checked.resultDigest}.json`;
  const serialized = canonicalJson(checked);
  if (!(await safeRunPublishExclusiveFile(safeRun, path, serialized))) {
    if ((await safeRunReadFile(safeRun, path)).toString("utf8") !== serialized)
      fail("E_EVAL_INTEGRITY", "continuation result digest was reused with different content");
  }
}

/** Materialize, continue, check, persist, then clean two isolated fixture arms. */
export async function runSandboxContinuation(
  input: SandboxContinuationInput,
): Promise<SandboxContinuationResult> {
  const fixture = validateRepositoryFixture(input.fixture);
  const snapshotDigest = digest(input.snapshotDigest, "snapshotDigest");
  const checks = validateHiddenCheckDefinitions(input.hiddenChecks);
  if (
    hiddenCheckDefinitionDigest(checks) !==
    digest(input.objectiveChecksDigest, "objectiveChecksDigest")
  )
    fail("E_EVAL_INTEGRITY", "hidden check definition does not match the frozen snapshot digest");
  if (fixture.status === "unavailable") {
    const unsigned = {
      schemaVersion: 1 as const,
      type: "sandbox-continuation-result-v1" as const,
      snapshotDigest,
      fixtureStatus: "unavailable" as const,
      execution: "rubric-only" as const,
      reasonCode: fixture.reasonCode as "fixture-not-captured" | "fixture-integrity-failed",
    };
    const result = Object.freeze({ ...unsigned, resultDigest: canonicalDigest(unsigned) });
    await persistResult(input.safeRun, result);
    return result;
  }
  const caps = validateContinuationCaps(input.caps);
  const original = await canonicalOriginalRepository(input.originalRepositoryPath);
  const fixtureRoot = await ensurePrivateDir(input.safeRun, DEFAULT_FIXTURE_ROOT);
  const fixtureRootRealpath = await realpath(fixtureRoot);
  const material = await loadVerifiedRepositoryFixtureMaterial(input.safeRun, fixture);
  if (!isExecutableMaterial(material))
    fail("E_EVAL_INTEGRITY", "executable fixture unexpectedly unavailable");
  const native = await prepareArm(
    input,
    material,
    fixtureRoot,
    fixtureRootRealpath,
    original,
    "native",
  );
  let selective: object | undefined;
  try {
    selective = await prepareArm(
      input,
      material,
      fixtureRoot,
      fixtureRootRealpath,
      original,
      "selective",
    );
    const arms = await Promise.all(
      [native, selective].map(async (handle) => {
        const prepared = fixtureFromHandle(handle);
        const usage = assertUsage(
          await input.continuation.continue({ arm: prepared.arm, cwd: prepared.root, caps }),
          caps,
        );
        const checksResult = Object.freeze(
          await Promise.all(checks.map((check) => runHiddenCheck(check, prepared.root))),
        );
        return Object.freeze({ arm: prepared.arm, usage, checks: checksResult });
      }),
    );
    const unsigned = {
      schemaVersion: 1 as const,
      type: "sandbox-continuation-result-v1" as const,
      snapshotDigest,
      fixtureStatus: fixture.status,
      execution: "executed" as const,
      capsDigest: continuationCapsDigest(caps),
      hiddenChecksDigest: hiddenCheckDefinitionDigest(checks),
      arms: Object.freeze(arms.sort((left, right) => left.arm.localeCompare(right.arm))),
    };
    const result = Object.freeze({
      ...unsigned,
      resultDigest: canonicalDigest(unsigned),
    }) as SandboxContinuationResult;
    await persistResult(input.safeRun, result);
    await cleanupDisposableFixture(native);
    await cleanupDisposableFixture(selective);
    return result;
  } catch (error: unknown) {
    // A materialization/identity failure is fail-closed; no partially unverified tree is deleted.
    if (selective !== undefined) await cleanupDisposableFixture(selective).catch(() => {});
    await cleanupDisposableFixture(native).catch(() => {});
    throw error;
  }
}

/** Content-free probe used by tests and later readers to verify result persistence. */
export async function sandboxContinuationResultExists(
  safeRun: SafeRun,
  resultDigest: string,
): Promise<boolean> {
  return safeRunFileExists(
    safeRun,
    `${RESULT_DIRECTORY}/${digest(resultDigest, "resultDigest")}.json`,
  );
}
