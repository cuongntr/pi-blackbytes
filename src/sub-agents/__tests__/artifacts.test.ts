import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  MAX_ARTIFACT_BYTES,
  MIN_ARTIFACT_CHARS,
  buildMetadataHeader,
  captureArtifact,
  cleanupArtifacts,
  getArtifactStats,
  resolveArtifactDir,
} from "../artifacts.js";

const originalPiAgentDir = process.env.PI_AGENT_DIR;
let tempAgentDir: string;

beforeEach(async () => {
  tempAgentDir = await mkdtemp(join(tmpdir(), "pi-blackbytes-artifacts-"));
  process.env.PI_AGENT_DIR = tempAgentDir;
});

afterEach(() => {
  if (originalPiAgentDir === undefined) {
    delete process.env.PI_AGENT_DIR;
  } else {
    process.env.PI_AGENT_DIR = originalPiAgentDir;
  }
});

describe("resolveArtifactDir", () => {
  it("uses PI_AGENT_DIR and a UTC date segment", () => {
    const dir = resolveArtifactDir(new Date("2026-06-08T12:34:56Z"));
    assert.equal(dir, join(tempAgentDir, "blackbytes", "artifacts", "sub-agents", "2026-06-08"));
  });

  it("falls back to ~/.pi/agent when PI_AGENT_DIR is unset", () => {
    delete process.env.PI_AGENT_DIR;
    const dir = resolveArtifactDir(new Date("2026-06-08T00:00:00Z"));
    assert.ok(
      dir.endsWith(join(".pi", "agent", "blackbytes", "artifacts", "sub-agents", "2026-06-08")),
    );
  });
});

describe("buildMetadataHeader", () => {
  it("creates YAML front matter with redaction note", () => {
    const header = buildMetadataHeader({
      agent: "explore",
      startedAt: Date.parse("2026-06-08T01:02:03Z"),
      durationMs: 123,
      model: "gpt-test",
      failureKind: "timed_out",
      originalChars: 2000,
      redactedChars: 1990,
      truncated: false,
    });

    assert.ok(header.startsWith("---\n"));
    assert.ok(header.includes('agent: "explore"'));
    assert.ok(header.includes('startedAt: "2026-06-08T01:02:03.000Z"'));
    assert.ok(header.includes('failureKind: "timed_out"'));
    assert.ok(header.includes("redaction:"));
    assert.ok(header.endsWith("---\n\n"));
  });
});

describe("captureArtifact", () => {
  it("skips content below the minimum size after redaction", async () => {
    const result = await captureArtifact({
      agent: "explore",
      content: "x".repeat(MIN_ARTIFACT_CHARS - 1),
      startedAt: Date.now(),
      durationMs: 1,
      now: new Date("2026-06-08T01:02:03Z"),
    });

    assert.equal(result, undefined);
  });

  it("writes redacted content with a safe agent/date/time path", async () => {
    const result = await captureArtifact({
      agent: "Explore Agent/One",
      content: `${"x".repeat(MIN_ARTIFACT_CHARS)}\nAPI_KEY=supersecret123`,
      startedAt: Date.parse("2026-06-08T01:02:00Z"),
      durationMs: 42,
      model: "test-model",
      now: new Date("2026-06-08T01:02:03Z"),
    });

    assert.ok(result);
    assert.ok(result.path.endsWith(join("2026-06-08", "explore-agent-one-010203000.md")));

    const content = await readFile(result.path, "utf8");
    assert.ok(content.includes("API_KEY=[REDACTED]"));
    assert.ok(!content.includes("supersecret123"));
    assert.ok(content.includes('agent: "Explore Agent/One"'));
    assert.ok(content.includes('model: "test-model"'));
  });

  it("does not overwrite same-millisecond captures for the same agent", async () => {
    const now = new Date("2026-06-08T01:02:03.004Z");
    const first = await captureArtifact({
      agent: "explore",
      content: "a".repeat(MIN_ARTIFACT_CHARS),
      startedAt: now.getTime(),
      durationMs: 1,
      now,
    });
    const second = await captureArtifact({
      agent: "explore",
      content: "b".repeat(MIN_ARTIFACT_CHARS),
      startedAt: now.getTime(),
      durationMs: 2,
      now,
    });

    assert.ok(first);
    assert.ok(second);
    assert.notEqual(first.path, second.path);
    assert.ok(first.path.endsWith(join("2026-06-08", "explore-010203004.md")));
    assert.ok(second.path.endsWith(join("2026-06-08", "explore-010203004-2.md")));
    assert.match(await readFile(first.path, "utf8"), /aaa/);
    assert.match(await readFile(second.path, "utf8"), /bbb/);
  });

  it("enforces the 512 KiB artifact cap", async () => {
    const result = await captureArtifact({
      agent: "oracle",
      content: "z".repeat(MAX_ARTIFACT_BYTES * 2),
      startedAt: Date.now(),
      durationMs: 5,
      now: new Date("2026-06-08T02:03:04Z"),
    });

    assert.ok(result);
    assert.ok(result.bytes <= MAX_ARTIFACT_BYTES);
    assert.equal(result.truncated, true);

    const info = await stat(result.path);
    assert.ok(info.size <= MAX_ARTIFACT_BYTES);
    const content = await readFile(result.path, "utf8");
    assert.ok(content.includes("truncated: true"));
    assert.ok(content.includes("artifact truncated"));
  });

  it("enforces the artifact cap for multi-byte UTF-8 content", async () => {
    const result = await captureArtifact({
      agent: "oracle",
      content: "語".repeat(MAX_ARTIFACT_BYTES),
      startedAt: Date.now(),
      durationMs: 5,
      now: new Date("2026-06-08T02:03:05Z"),
    });

    assert.ok(result);
    assert.ok(result.bytes <= MAX_ARTIFACT_BYTES);
    assert.equal(result.truncated, true);
  });
});

describe("cleanupArtifacts", () => {
  it("removes artifacts older than the retention window", async () => {
    const oldDate = new Date("2026-06-01T00:00:00Z");
    const oldResult = await captureArtifact({
      agent: "explore",
      content: "old".repeat(MIN_ARTIFACT_CHARS),
      startedAt: oldDate.getTime(),
      durationMs: 1,
      now: oldDate,
    });
    assert.ok(oldResult);

    const staleMtime = new Date("2026-05-30T00:00:00Z");
    await utimes(oldResult.path, staleMtime, staleMtime);

    const currentResult = await captureArtifact({
      agent: "explore",
      content: "new".repeat(MIN_ARTIFACT_CHARS),
      startedAt: Date.parse("2026-06-08T00:00:00Z"),
      durationMs: 1,
      now: new Date("2026-06-08T00:00:00Z"),
    });
    assert.ok(currentResult);

    const removed = await cleanupArtifacts(new Date("2026-06-08T00:00:00Z"));

    assert.equal(removed, 1);
    await assert.rejects(readFile(oldResult.path, "utf8"));
    assert.ok(await readFile(currentResult.path, "utf8"));
  });

  it("treats missing directories as best-effort no-ops", async () => {
    process.env.PI_AGENT_DIR = join(tempAgentDir, "missing");
    const removed = await cleanupArtifacts(new Date("2026-06-08T00:00:00Z"));
    assert.equal(removed, 0);
  });

  it("ignores non-markdown files during cleanup", async () => {
    const artifactDir = resolveArtifactDir(new Date("2026-06-01T00:00:00Z"));
    await mkdir(artifactDir, { recursive: true });
    const notePath = join(artifactDir, "note.txt");
    await writeFile(notePath, "keep");
    const staleMtime = new Date("2026-05-30T00:00:00Z");
    await utimes(notePath, staleMtime, staleMtime);

    await cleanupArtifacts(new Date("2026-06-08T00:00:00Z"));
    assert.equal(await readFile(notePath, "utf8"), "keep");
  });
});

describe("getArtifactStats", () => {
  it("reports the resolved base directory even when the artifact dir is missing", async () => {
    // Point PI_AGENT_DIR at a fresh empty tmpdir; no subdirs exist yet.
    process.env.PI_AGENT_DIR = await mkdtemp(join(tmpdir(), "pi-blackbytes-stats-empty-"));

    const stats = await getArtifactStats();
    assert.equal(stats.status, "unavailable");
    assert.equal(stats.reason, "directory missing");
    if (stats.status === "unavailable") {
      assert.ok(stats.directory.endsWith(join("blackbytes", "artifacts", "sub-agents")));
    }
  });

  it("reports an empty directory as count=0 with no mostRecent", async () => {
    // Create the artifacts base dir but no date subdirs.
    const baseDir = join(tempAgentDir, "blackbytes", "artifacts", "sub-agents");
    await mkdir(baseDir, { recursive: true });

    const stats = await getArtifactStats();
    assert.equal(stats.status, "ok");
    if (stats.status === "ok") {
      assert.equal(stats.count, 0);
      assert.equal(stats.mostRecent, null);
      assert.equal(stats.directory, baseDir);
    }
  });

  it("counts .md artifacts across date subdirs and reports the most recent by mtime", async () => {
    // Capture three artifacts in two different date subdirs, then back-date
    // two of them so we know which one is the most recent.
    const older = await captureArtifact({
      agent: "explore",
      content: "old".repeat(MIN_ARTIFACT_CHARS),
      startedAt: Date.parse("2026-06-06T00:00:00Z"),
      durationMs: 1,
      now: new Date("2026-06-06T00:00:00Z"),
    });
    assert.ok(older);
    const staleMtime = new Date("2026-06-06T00:00:00Z");
    await utimes(older.path, staleMtime, staleMtime);

    const medium = await captureArtifact({
      agent: "explore",
      content: "mid".repeat(MIN_ARTIFACT_CHARS),
      startedAt: Date.parse("2026-06-07T00:00:00Z"),
      durationMs: 1,
      now: new Date("2026-06-07T00:00:00Z"),
    });
    assert.ok(medium);
    await utimes(medium.path, new Date("2026-06-07T00:00:00Z"), new Date("2026-06-07T00:00:00Z"));

    const newest = await captureArtifact({
      agent: "oracle",
      content: "new".repeat(MIN_ARTIFACT_CHARS),
      startedAt: Date.parse("2026-06-08T00:00:00Z"),
      durationMs: 1,
      now: new Date("2026-06-08T00:00:00Z"),
    });
    assert.ok(newest);

    // Drop a non-md file in one of the date dirs to confirm it's ignored.
    const notePath = join(resolveArtifactDir(new Date("2026-06-08T00:00:00Z")), "note.txt");
    await writeFile(notePath, "ignore me");

    const stats = await getArtifactStats();
    assert.equal(stats.status, "ok");
    if (stats.status === "ok") {
      assert.equal(stats.count, 3);
      assert.ok(stats.mostRecent);
      assert.equal(stats.mostRecent!.relativePath.startsWith("2026-06-08/"), true);
      assert.equal(stats.mostRecent!.name, newest.path.split("/").pop());
      assert.ok(stats.mostRecent!.timestamp >= staleMtime.getTime());
    }
  });

  it("reports a read-error result when PI_AGENT_DIR is not a directory", async () => {
    // Create a regular file at the path the helper would scan, so readdir
    // fails with ENOTDIR.
    const blocker = join(tempAgentDir, "blackbytes");
    await mkdir(blocker, { recursive: true });
    await writeFile(join(blocker, "artifacts"), "not a directory");

    const stats = await getArtifactStats();
    assert.equal(stats.status, "unavailable");
    if (stats.status === "unavailable") {
      assert.equal(stats.reason, "read error");
    }
  });
});
