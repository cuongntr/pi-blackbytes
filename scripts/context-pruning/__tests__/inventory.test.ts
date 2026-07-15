/**
 * Hermetic generated-fixture coverage for the metadata-only streaming inventory.
 */

import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";

import { generateCorpusKey, hmacDigest } from "../evidence-store.js";
import { inventoryCorpus, inventorySource } from "../inventory.js";
import type { InventoryRecord } from "../types.js";

let tempRoot: string;
const CANARY = "inventory-secret-canary-4f8c";
const LOCAL_ID = "local-session-id-canary-9a17";

before(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), `${CANARY}-`));
});

after(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

function entry(type: string, id: string, parentId: string | undefined, extra: object = {}): object {
  return {
    type,
    id,
    parentId: parentId ?? null,
    timestamp: "2026-07-15T00:00:00Z",
    ...extra,
  };
}

async function generatedCurrentAndLegacyFixture(): Promise<{ path: string; content: string }> {
  const path = join(tempRoot, `${CANARY}-${LOCAL_ID}.jsonl`);
  const lines = [
    JSON.stringify({
      type: "session",
      id: LOCAL_ID,
      version: 74,
      cwd: `/private/${CANARY}`,
      parentSession: "fork-id-is-private",
    }),
    JSON.stringify(
      entry("message", "root", undefined, { message: { role: "user", content: CANARY } }),
    ),
    JSON.stringify(
      entry("message", "assistant-complete", "root", {
        message: {
          role: "assistant",
          provider: "provider-private",
          model: "model-private",
          content: CANARY,
          usage: {
            input: 1,
            output: 2,
            cacheRead: 3,
            cacheWrite: 4,
            totalTokens: 5,
            contextPercent: 75,
            cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
            diagnostics: { detail: CANARY },
          },
          toolCalls: [{ name: CANARY, arguments: { secret: CANARY } }],
        },
      }),
    ),
    JSON.stringify(entry(`${CANARY}-unknown-type`, "other-branch", "root", { data: CANARY })),
    JSON.stringify(
      entry("thinking_level_change", "thinking", "other-branch", { thinkingLevel: CANARY }),
    ),
    JSON.stringify(entry("model_change", "model", "thinking", { model: CANARY })),
    JSON.stringify(entry("compaction", "compact", "model", { summary: CANARY })),
    JSON.stringify(entry("branch_summary", "summary", "compact", { summary: CANARY })),
    JSON.stringify(
      entry("custom", "custom", "summary", { customType: CANARY, data: { secret: CANARY } }),
    ),
    JSON.stringify(entry("label", "label", "custom", { label: CANARY })),
    JSON.stringify(entry("session_info", "info", "label", { cwd: CANARY, data: CANARY })),
    JSON.stringify(entry("custom_message", "legacy", "info", { content: CANARY })),
    JSON.stringify(
      entry("message", "assistant-zero", "legacy", {
        message: {
          role: "assistant",
          provider: "provider-private",
          model: "model-private",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        },
      }),
    ),
    JSON.stringify(
      entry("message", "assistant-incomplete", "assistant-zero", {
        message: {
          role: "assistant",
          provider: "provider-private",
          model: "model-private",
          usage: {
            input: 3,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 9,
            cost: { input: 2, cacheRead: 0, cacheWrite: 0, total: 2 },
          },
        },
      }),
    ),
    JSON.stringify(
      entry("message", "tool-result", "assistant-incomplete", {
        message: {
          role: "toolResult",
          content: CANARY,
          toolName: CANARY,
          result: { secret: CANARY },
        },
      }),
    ),
    JSON.stringify(
      entry("message", "unknown-role", "tool-result", {
        message: { role: CANARY, content: CANARY },
      }),
    ),
    '{"type":',
  ];
  const content = `${lines.join("\n")}\n`;
  await writeFile(path, content);
  return { path, content };
}

describe("streaming metadata-only inventory", () => {
  it("retains only the privacy allowlist for current and legacy-ish entries", async () => {
    const fixture = await generatedCurrentAndLegacyFixture();
    const key = generateCorpusKey();
    const logs: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    console.error = (...args: unknown[]) => logs.push(args.map(String).join(" "));

    let record: InventoryRecord;
    try {
      record = await inventorySource(fixture.path, key, {
        resolveContextWindow: (provider, model) =>
          provider === "provider-private" && model === "model-private" ? 100 : undefined,
      });
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }

    assert.equal(record.parseStatus, "partial");
    assert.equal(record.parentStatus, "fork");
    assert.equal(record.sessionVersion, 74);
    assert.equal(record.entryCounts.session, 1);
    assert.equal(record.entryCounts.message, 6);
    assert.equal(record.entryCounts.thinking_level_change, 1);
    assert.equal(record.entryCounts.model_change, 1);
    assert.equal(record.entryCounts.compaction, 1);
    assert.equal(record.entryCounts.branch_summary, 1);
    assert.equal(record.entryCounts.custom, 1);
    assert.equal(record.entryCounts.label, 1);
    assert.equal(record.entryCounts.session_info, 1);
    assert.equal(record.entryCounts.custom_message, 1);
    assert.equal(record.entryCounts.unknown, 1);
    assert.equal(record.entryCounts.malformed, 1);
    assert.equal(record.compactionCount, 1);
    assert.equal(record.branchCount, 2);
    assert.deepEqual(record.roleCounts, { user: 1, assistant: 3, toolResult: 1, unknown: 1 });
    assert.equal(record.requestCount, 3);
    assert.equal(record.usageCompleteness, 2 / 3);
    assert.deepEqual(record.usageTotals, {
      input: 4,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
      totalTokens: 14,
      cost: { input: 2.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 3 },
    });
    assert.equal(record.maxContextRatio, 0.75);
    assert.ok(record.exclusionReasons.includes("unknown-entry-type"));
    assert.ok(record.exclusionReasons.includes("malformed-jsonl"));
    assert.ok(record.exclusionReasons.includes("incomplete-usage"));
    assert.equal(record.sourceDigest, hmacDigest(key, Buffer.from(fixture.content)));
    assert.equal(
      record.repositoryId,
      hmacDigest(key, Buffer.from(dirname(await realpath(fixture.path)), "utf8")),
    );
    assert.equal(Object.isFrozen(record), true);
    assert.equal(Object.isFrozen(record.usageTotals.cost), true);

    const serialized = JSON.stringify(record);
    for (const forbidden of [
      CANARY,
      LOCAL_ID,
      fixture.path,
      dirname(fixture.path),
      "provider-private",
      "model-private",
    ]) {
      assert.equal(serialized.includes(forbidden), false, `inventory leaked ${forbidden}`);
      assert.equal(logs.join("\n").includes(forbidden), false, `logs leaked ${forbidden}`);
    }
    assert.equal(Object.hasOwn(record.entryCounts, `${CANARY}-unknown-type`), false);
    assert.deepEqual(Object.keys(record.entryCounts).sort(), [
      "branch_summary",
      "compaction",
      "custom",
      "custom_message",
      "label",
      "malformed",
      "message",
      "model_change",
      "session",
      "session_info",
      "thinking_level_change",
      "unknown",
    ]);
  });

  it("keeps raw-byte digests for readable partial files and isolates unreadable sources", async () => {
    const key = generateCorpusKey();
    const validPath = join(tempRoot, "good-no-canary.jsonl");
    const noHeaderPath = join(tempRoot, "no-header.jsonl");
    const missingPath = join(tempRoot, `${CANARY}-unreadable.jsonl`);
    await writeFile(
      validPath,
      `${JSON.stringify({ type: "session", id: "safe-header", version: 1 })}\n${JSON.stringify(entry("message", "one", undefined))}\n`,
    );
    await writeFile(noHeaderPath, `${JSON.stringify(entry("message", "one", undefined))}\n`);

    const first = await inventorySource(noHeaderPath, key);
    const second = await inventorySource(noHeaderPath, key);
    assert.equal(first.parseStatus, "partial");
    assert.equal(first.parentStatus, "unknown");
    assert.ok(first.exclusionReasons.includes("missing-header"));
    assert.equal(first.sourceDigest, second.sourceDigest);
    assert.equal(first.sourceDigest, hmacDigest(key, await readFile(noHeaderPath)));

    const corpus = await inventoryCorpus([missingPath, validPath], key);
    assert.equal(corpus.length, 2);
    assert.equal(corpus[0]?.parseStatus, "unreadable");
    assert.equal(corpus[0]?.repositoryId, undefined);
    assert.deepEqual(corpus[0]?.exclusionReasons, [
      "canonical-path-unavailable",
      "missing-header",
      "unreadable-source",
    ]);
    assert.equal(corpus[1]?.parseStatus, "valid");
    assert.equal(corpus[1]?.branchCount, 1);
    assert.equal(corpus[1]?.exclusionReasons.includes("invalid-structural-id"), false);
    const serialized = JSON.stringify(corpus);
    assert.equal(serialized.includes(CANARY), false);
    assert.equal(serialized.includes(missingPath), false);
  });

  it("uses a supplied frozen context-window map only when contextPercent is unavailable", async () => {
    const key = generateCorpusKey();
    const path = join(tempRoot, "context-window.jsonl");
    const usage = {
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
      totalTokens: 9,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    await writeFile(
      path,
      [
        JSON.stringify({ type: "session", id: "header", version: 1 }),
        JSON.stringify(
          entry("message", "assistant", undefined, {
            message: { role: "assistant", provider: "provider", model: "model", usage },
          }),
        ),
      ].join("\n"),
    );

    const record = await inventorySource(path, key, {
      modelContextWindows: new Map([["provider", new Map([["model", 100]])]]),
    });
    assert.equal(record.maxContextRatio, 0.09);
  });

  it("marks duplicate headers and invalid or duplicate structural IDs with fixed coarse codes", async () => {
    const key = generateCorpusKey();
    const path = join(tempRoot, "structural-invalid.jsonl");
    const lines = [
      JSON.stringify({ type: "session", id: "first-header", version: 1 }),
      JSON.stringify({ type: "session", id: "second-header", version: 1 }),
      JSON.stringify(entry("message", "same-entry", undefined)),
      JSON.stringify(entry("message", "same-entry", undefined)),
      JSON.stringify(entry("message", "invalid-parent", "")),
    ];
    await writeFile(path, `${lines.join("\n")}\n`);

    const record = await inventorySource(path, key);
    assert.equal(record.parseStatus, "partial");
    assert.equal(record.parentStatus, "unknown");
    assert.ok(record.exclusionReasons.includes("duplicate-header"));
    assert.ok(record.exclusionReasons.includes("duplicate-structural-id"));
    assert.ok(record.exclusionReasons.includes("invalid-structural-id"));
    assert.equal(record.branchCount, 1);
  });

  it("discards parsed aggregates when source integrity changes during the scan", async () => {
    const key = generateCorpusKey();
    const path = join(tempRoot, "mutated-during-scan.jsonl");
    const usage = {
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
      totalTokens: 10,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    await writeFile(
      path,
      [
        JSON.stringify({ type: "session", id: "header", version: 1 }),
        JSON.stringify(
          entry("message", "assistant", undefined, {
            message: { role: "assistant", provider: "provider", model: "model", usage },
          }),
        ),
      ].join("\n"),
    );

    let mutated = false;
    const record = await inventorySource(path, key, {
      resolveContextWindow: () => {
        if (!mutated) {
          mutated = true;
          appendFileSync(path, `\n${JSON.stringify({ type: CANARY, data: CANARY })}\n`);
        }
        return 100;
      },
    });

    assert.equal(record.parseStatus, "partial");
    assert.ok(record.exclusionReasons.includes("source-integrity-failed"));
    assert.equal(record.requestCount, 0);
    assert.equal(record.branchCount, 0);
    assert.equal(record.entryCounts.message, 0);
    assert.equal(JSON.stringify(record).includes(CANARY), false);
  });

  it("fails partial instead of emitting non-finite usage aggregates", async () => {
    const key = generateCorpusKey();
    const path = join(tempRoot, "usage-overflow.jsonl");
    const usage = {
      input: Number.MAX_VALUE,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    await writeFile(
      path,
      [
        JSON.stringify({ type: "session", id: "header", version: 1 }),
        JSON.stringify(
          entry("message", "first", undefined, { message: { role: "assistant", usage } }),
        ),
        JSON.stringify(
          entry("message", "second", "first", { message: { role: "assistant", usage } }),
        ),
      ].join("\n"),
    );

    const record = await inventorySource(path, key);
    assert.equal(record.parseStatus, "partial");
    assert.equal(record.usageCompleteness, 0.5);
    assert.equal(record.usageTotals.input, Number.MAX_VALUE);
    assert.equal(Number.isFinite(record.usageTotals.input), true);
    assert.ok(record.exclusionReasons.includes("incomplete-usage"));
  });

  it("does not use whole-file reads, splits, or parsed-entry accumulation", async () => {
    const source = await readFile(new URL("../inventory.ts", import.meta.url), "utf8");
    assert.doesNotMatch(source, /\breadFile\s*\(/);
    assert.doesNotMatch(source, /\.split\s*\(/);
    assert.doesNotMatch(source, /parsedEntries|entries\s*:\s*\[/);
    assert.match(source, /createReadStream/);
    assert.match(source, /createInterface/);
    assert.match(source, /O_NOFOLLOW/);
    assert.match(source, /createHmac/);
  });
});
