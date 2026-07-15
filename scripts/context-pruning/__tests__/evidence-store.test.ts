import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";

import { canonicalJson } from "../canonical-json.js";
import {
  CORPUS_KEY_FILENAME,
  appendEvent,
  atomicManifestWrite,
  corpusKeyDigest,
  generateCorpusKey,
  hmacDigest,
  loadExistingEventIds,
  loadOrCreateCorpusKey,
  resolveEvidenceRoot,
  resolveRunRoot,
} from "../evidence-store.js";
import { ensurePrivateRunRoot, openSafeRun, preManifestRunPath } from "../path-safety.js";
import type { PreManifestRun, SafeRun } from "../path-safety.js";
import { EVIDENCE_ROOT_SEGMENTS, EvidenceStoreError } from "../types.js";
import type { EvalErrorCode, EvidenceEvent, RunManifest } from "../types.js";

let tempRoot: string;
let sequence = 0;

async function makeTempRoot(): Promise<string> {
  const dir = join(tmpdir(), `evstore-test-${randomBytes(8).toString("hex")}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

async function testDir(label: string): Promise<string> {
  sequence += 1;
  const dir = join(tempRoot, `${sequence}-${label}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function expectStoreError(code: EvalErrorCode): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    assert.ok(error instanceof EvidenceStoreError);
    assert.equal((error as EvidenceStoreError).code, code);
    return true;
  };
}

function makeManifest(runId: string, eventCount = 0): RunManifest {
  return {
    schemaVersion: 1,
    runId,
    createdAt: "2026-07-14T12:00:00.000Z",
    corpusKeyDigest: "a".repeat(64),
    eventCount,
  };
}

function makeEvent(eventId: string, type = "test"): EvidenceEvent {
  return {
    eventId,
    timestamp: "2026-07-14T12:00:00.000Z",
    type,
    data: { value: 1 },
  };
}

before(async () => {
  tempRoot = await makeTempRoot();
});

after(async () => {
  const { rm } = await import("node:fs/promises");
  await rm(tempRoot, { recursive: true, force: true });
});

describe("canonical run roots", () => {
  it("resolves exactly below the PI agent evidence root", () => {
    const agentDir = join(tempRoot, "agent-root");
    const evidenceRoot = resolve(agentDir, "blackbytes", "evaluations", "context-pruning");

    assert.equal(resolveEvidenceRoot(agentDir), evidenceRoot);
    assert.equal(resolveRunRoot(agentDir, "run-001"), join(evidenceRoot, "run-001"));
    assert.deepEqual(EVIDENCE_ROOT_SEGMENTS, ["blackbytes", "evaluations", "context-pruning"]);
  });

  it("rejects empty, traversal, separators, control text, and overlong IDs", () => {
    const invalid = [
      "",
      ".",
      "..",
      "../outside",
      "a/b",
      "a\\b",
      " leading",
      "trailing ",
      "line\nbreak",
      "nul\0byte",
      "a".repeat(129),
    ];

    for (const runId of invalid) {
      assert.throws(() => resolveRunRoot(tempRoot, runId), expectStoreError("E_EVAL_UNSAFE_PATH"));
    }
  });

  it("accepts bounded opaque ASCII IDs", () => {
    assert.equal(
      resolveRunRoot(tempRoot, "Run_2026.07-14"),
      join(resolveEvidenceRoot(tempRoot), "Run_2026.07-14"),
    );
  });

  it("creates and hardens every evidence directory to 0700", async () => {
    const agentDir = join(await testDir("private-tree"), "agent");
    const preRun = await ensurePrivateRunRoot(agentDir, "run-001");
    const runRoot = preManifestRunPath(preRun);
    const paths: string[] = [];
    let current = resolve(agentDir);
    for (const segment of EVIDENCE_ROOT_SEGMENTS) {
      current = join(current, segment);
      paths.push(current);
    }
    paths.push(runRoot);

    for (const dirPath of paths) {
      assert.equal((await stat(dirPath)).mode & 0o777, 0o700);
    }
  });
});

describe("private filesystem modes", () => {
  it("creates and hardens a run root directory to 0700", async () => {
    const agentDir = join(await testDir("private-dir"), "agent");
    const preRun = await ensurePrivateRunRoot(agentDir, "private-run");
    const runRoot = preManifestRunPath(preRun);
    assert.equal((await stat(runRoot)).mode & 0o777, 0o700);
  });

  it("creates and hardens a manifest file to 0600", async () => {
    const agentDir = join(await testDir("private-file"), "agent");
    const preRun = await ensurePrivateRunRoot(agentDir, "private-run");
    const manifest = makeManifest("private-run");
    await atomicManifestWrite(preRun, manifest);
    const runRoot = preManifestRunPath(preRun);
    const manifestPath = join(runRoot, "manifest.json");
    assert.equal((await stat(manifestPath)).mode & 0o777, 0o600);
  });
});

describe("private corpus keys and keyed digests", () => {
  const vectorKey = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

  it("generates independent 32-byte lowercase-hex keys", () => {
    const first = generateCorpusKey();
    const second = generateCorpusKey();
    assert.match(first, /^[0-9a-f]{64}$/);
    assert.match(second, /^[0-9a-f]{64}$/);
    assert.notEqual(first, second);
  });

  it("matches fixed SHA-256 and byte-decoded HMAC vectors", () => {
    assert.equal(
      corpusKeyDigest(vectorKey),
      "630dcd2966c4336691125448bbb25b4ff412a49c732db2c8abc1b8581bd710dd",
    );
    assert.equal(
      hmacDigest(vectorKey, Buffer.from("hello")),
      "53c40272a70c15ca4ee0af4df1f155fd6c41e00ce2307d8987ecd4bb36a7e990",
    );
  });

  it("rejects malformed keys without including their value in the error", () => {
    for (const key of ["", "ab", "G".repeat(64), "A".repeat(64), "0".repeat(66)]) {
      assert.throws(
        () => hmacDigest(key, Buffer.from("x")),
        (error: unknown) => {
          assert.ok(expectStoreError("E_EVAL_SCHEMA")(error));
          assert.ok(error instanceof Error);
          if (key.length > 0) {
            assert.equal(error.message.includes(key), false);
          }
          return true;
        },
      );
    }
  });

  it("persists and resumes the same private key", async () => {
    const agentDir = join(await testDir("key-resume"), "agent");
    const preRun = await ensurePrivateRunRoot(agentDir, "key-resume-run");
    const runRoot = preManifestRunPath(preRun);
    const first = await loadOrCreateCorpusKey(preRun);
    const second = await loadOrCreateCorpusKey(preRun);
    const keyPath = join(runRoot, CORPUS_KEY_FILENAME);

    assert.equal(second, first);
    assert.equal(await readFile(keyPath, "utf8"), first);
    assert.equal((await stat(keyPath)).mode & 0o777, 0o600);
    assert.equal(
      hmacDigest(first, Buffer.from("source")),
      hmacDigest(second, Buffer.from("source")),
    );
  });

  it("publishes one key across concurrent creators", async () => {
    const agentDir = join(await testDir("key-concurrent"), "agent");
    const preRun = await ensurePrivateRunRoot(agentDir, "key-concurrent-run");
    const runRoot = preManifestRunPath(preRun);
    const keys = await Promise.all(Array.from({ length: 12 }, () => loadOrCreateCorpusKey(preRun)));

    assert.equal(new Set(keys).size, 1);
    assert.equal(await readFile(join(runRoot, CORPUS_KEY_FILENAME), "utf8"), keys[0]);
  });

  it("hardens a resumed key and fails closed on corrupt key bytes", async () => {
    const agentDir = join(await testDir("key-loose"), "agent");
    const preRun = await ensurePrivateRunRoot(agentDir, "key-loose-run");
    const runRoot = preManifestRunPath(preRun);
    const loosePath = join(runRoot, CORPUS_KEY_FILENAME);
    await writeFile(loosePath, vectorKey, { mode: 0o644 });
    assert.equal(await loadOrCreateCorpusKey(preRun), vectorKey);
    assert.equal((await stat(loosePath)).mode & 0o777, 0o600);

    const corruptAgentDir = join(await testDir("key-corrupt"), "agent");
    const corruptPreRun = await ensurePrivateRunRoot(corruptAgentDir, "key-corrupt-run");
    const corruptRoot = preManifestRunPath(corruptPreRun);
    await writeFile(join(corruptRoot, CORPUS_KEY_FILENAME), "not-a-key", { mode: 0o600 });
    await assert.rejects(
      () => loadOrCreateCorpusKey(corruptPreRun),
      expectStoreError("E_EVAL_INTEGRITY"),
    );
  });
});

describe("atomic canonical manifests", () => {
  it("writes canonical JSON at 0600", async () => {
    const agentDir = join(await testDir("manifest-write"), "agent");
    const preRun = await ensurePrivateRunRoot(agentDir, "manifest-write-run");
    const runRoot = preManifestRunPath(preRun);
    const manifest = makeManifest("manifest-write-run", 2);
    await atomicManifestWrite(preRun, manifest);
    const manifestPath = join(runRoot, "manifest.json");

    assert.equal(await readFile(manifestPath, "utf8"), canonicalJson(manifest));
    assert.equal((await stat(manifestPath)).mode & 0o777, 0o600);
  });

  it("preserves old bytes and removes only its own temp on injected failure", async () => {
    const agentDir = join(await testDir("manifest-failure"), "agent");
    const preRun = await ensurePrivateRunRoot(agentDir, "manifest-failure-run");
    const runRoot = preManifestRunPath(preRun);
    const manifestPath = join(runRoot, "manifest.json");
    const unrelatedTemp = join(runRoot, ".manifest.tmp.foreign");
    await atomicManifestWrite(preRun, makeManifest("old", 1));
    const oldBytes = await readFile(manifestPath);
    await writeFile(unrelatedTemp, "unrelated", { mode: 0o600 });

    await assert.rejects(
      () =>
        atomicManifestWrite(preRun, makeManifest("new", 2), {
          beforeRename: () => {
            throw new Error("injected interruption");
          },
        }),
      /injected interruption/,
    );

    assert.deepEqual(await readFile(manifestPath), oldBytes);
    assert.equal(await readFile(unrelatedTemp, "utf8"), "unrelated");
    const ownTemps = (await readdir(runRoot)).filter(
      (name) => name.startsWith(".manifest.tmp.") && name !== ".manifest.tmp.foreign",
    );
    assert.deepEqual(ownTemps, []);
  });

  it("serializes same-process manifest replacements", async () => {
    const agentDir = join(await testDir("manifest-queue"), "agent");
    const preRun = await ensurePrivateRunRoot(agentDir, "manifest-queue-run");
    const runRoot = preManifestRunPath(preRun);
    await Promise.all([
      atomicManifestWrite(preRun, makeManifest("first", 1)),
      atomicManifestWrite(preRun, makeManifest("second", 2)),
    ]);
    const parsed = JSON.parse(
      await readFile(join(runRoot, "manifest.json"), "utf8"),
    ) as RunManifest;
    assert.equal(parsed.runId, "second");
  });

  it("rejects raw corpus-key fields in a runtime manifest", async () => {
    const agentDir = join(await testDir("manifest-secret"), "agent");
    const preRun = await ensurePrivateRunRoot(agentDir, "manifest-secret-run");
    const runRoot = preManifestRunPath(preRun);
    const key = generateCorpusKey();
    const unsafe = { ...makeManifest("unsafe"), corpusKey: key } as RunManifest;

    await assert.rejects(
      () => atomicManifestWrite(preRun, unsafe),
      expectStoreError("E_EVAL_PRIVACY"),
    );
    await assert.rejects(() => readFile(join(runRoot, "manifest.json")), { code: "ENOENT" });
  });
});

describe("append-only canonical JSONL events", () => {
  it("appends canonical records at 0600 and retains failures", async () => {
    const agentDir = join(await testDir("events-basic"), "agent");
    const preRun = await ensurePrivateRunRoot(agentDir, "events-basic-run");
    const runRoot = preManifestRunPath(preRun);
    const key = await loadOrCreateCorpusKey(preRun);
    const keyDigest = corpusKeyDigest(key);
    await atomicManifestWrite(preRun, {
      ...makeManifest("events-basic-run", 0),
      corpusKeyDigest: keyDigest,
    });
    const safeRun = await openSafeRun(agentDir, "events-basic-run");
    const eventsPath = "events.jsonl";
    const failed: EvidenceEvent = {
      ...makeEvent("failure", "operation"),
      failed: true,
      error: "controlled failure",
    };
    await appendEvent(safeRun, eventsPath, makeEvent("first"));
    await appendEvent(safeRun, eventsPath, failed);

    const lines = (await readFile(join(runRoot, eventsPath), "utf8")).trimEnd().split("\n");
    assert.equal(lines[0], canonicalJson(makeEvent("first")));
    assert.equal(lines[1], canonicalJson(failed));
    assert.equal((await stat(join(runRoot, eventsPath))).mode & 0o777, 0o600);
    assert.deepEqual(
      await loadExistingEventIds(safeRun, eventsPath),
      new Set(["first", "failure"]),
    );
  });

  it("is idempotent only for an identical canonical event", async () => {
    const agentDir = join(await testDir("events-idempotent"), "agent");
    const preRun = await ensurePrivateRunRoot(agentDir, "events-idempotent-run");
    const runRoot = preManifestRunPath(preRun);
    const key = await loadOrCreateCorpusKey(preRun);
    const keyDigest = corpusKeyDigest(key);
    await atomicManifestWrite(preRun, {
      ...makeManifest("events-idempotent-run", 0),
      corpusKeyDigest: keyDigest,
    });
    const safeRun = await openSafeRun(agentDir, "events-idempotent-run");
    const eventsPath = "events.jsonl";
    const event = makeEvent("same");
    await appendEvent(safeRun, eventsPath, event);
    await appendEvent(safeRun, eventsPath, event);
    assert.equal(
      (await readFile(join(runRoot, eventsPath), "utf8")).trimEnd().split("\n").length,
      1,
    );

    await assert.rejects(
      () => appendEvent(safeRun, eventsPath, { ...event, type: "different" }),
      expectStoreError("E_EVAL_INTEGRITY"),
    );
  });

  it("serializes concurrent duplicate and distinct appends", async () => {
    const agentDir = join(await testDir("events-concurrent"), "agent");
    const preRun = await ensurePrivateRunRoot(agentDir, "events-concurrent-run");
    const runRoot = preManifestRunPath(preRun);
    const key = await loadOrCreateCorpusKey(preRun);
    const keyDigest = corpusKeyDigest(key);
    await atomicManifestWrite(preRun, {
      ...makeManifest("events-concurrent-run", 0),
      corpusKeyDigest: keyDigest,
    });
    const safeRun = await openSafeRun(agentDir, "events-concurrent-run");
    const eventsPath = "events.jsonl";
    const duplicate = makeEvent("duplicate");
    await Promise.all([
      appendEvent(safeRun, eventsPath, duplicate),
      appendEvent(safeRun, eventsPath, duplicate),
      appendEvent(safeRun, eventsPath, makeEvent("second")),
      appendEvent(safeRun, eventsPath, makeEvent("third")),
    ]);

    const ids = await loadExistingEventIds(safeRun, eventsPath);
    assert.deepEqual(ids, new Set(["duplicate", "second", "third"]));
    assert.equal(
      (await readFile(join(runRoot, eventsPath), "utf8")).trimEnd().split("\n").length,
      3,
    );
  });

  it("hardens an existing events file on resume", async () => {
    const agentDir = join(await testDir("events-mode"), "agent");
    const preRun = await ensurePrivateRunRoot(agentDir, "events-mode-run");
    const runRoot = preManifestRunPath(preRun);
    const key = await loadOrCreateCorpusKey(preRun);
    const keyDigest = corpusKeyDigest(key);
    await atomicManifestWrite(preRun, {
      ...makeManifest("events-mode-run", 0),
      corpusKeyDigest: keyDigest,
    });
    const safeRun = await openSafeRun(agentDir, "events-mode-run");
    const eventsPath = "events.jsonl";
    await writeFile(join(runRoot, eventsPath), `${canonicalJson(makeEvent("old"))}\n`, {
      mode: 0o644,
    });
    await appendEvent(safeRun, eventsPath, makeEvent("new"));
    assert.equal((await stat(join(runRoot, eventsPath))).mode & 0o777, 0o600);
  });

  it("adds one separator after a valid final line without newline", async () => {
    const agentDir = join(await testDir("events-separator"), "agent");
    const preRun = await ensurePrivateRunRoot(agentDir, "events-separator-run");
    const runRoot = preManifestRunPath(preRun);
    const key = await loadOrCreateCorpusKey(preRun);
    const keyDigest = corpusKeyDigest(key);
    await atomicManifestWrite(preRun, {
      ...makeManifest("events-separator-run", 0),
      corpusKeyDigest: keyDigest,
    });
    const safeRun = await openSafeRun(agentDir, "events-separator-run");
    const eventsPath = "events.jsonl";
    await writeFile(join(runRoot, eventsPath), canonicalJson(makeEvent("old")), { mode: 0o600 });
    await appendEvent(safeRun, eventsPath, makeEvent("new"));

    const content = await readFile(join(runRoot, eventsPath), "utf8");
    assert.equal(
      content,
      `${canonicalJson(makeEvent("old"))}\n${canonicalJson(makeEvent("new"))}\n`,
    );
  });

  it("fails closed on malformed middle and truncated trailing lines", async () => {
    for (const [label, content] of [
      ["middle", `${canonicalJson(makeEvent("old"))}\nnot-json\n`],
      ["trailing", `${canonicalJson(makeEvent("old"))}\n{"eventId":`],
    ] as const) {
      const agentDir = join(await testDir(`events-corrupt-${label}`), "agent");
      const preRun = await ensurePrivateRunRoot(agentDir, `events-corrupt-${label}-run`);
      const runRoot = preManifestRunPath(preRun);
      const key = await loadOrCreateCorpusKey(preRun);
      const keyDigest = corpusKeyDigest(key);
      await atomicManifestWrite(preRun, {
        ...makeManifest(`events-corrupt-${label}-run`, 0),
        corpusKeyDigest: keyDigest,
      });
      const safeRun = await openSafeRun(agentDir, `events-corrupt-${label}-run`);
      const eventsPath = "events.jsonl";
      await writeFile(join(runRoot, eventsPath), content, { mode: 0o600 });
      const before = await readFile(join(runRoot, eventsPath));

      await assert.rejects(
        () => appendEvent(safeRun, eventsPath, makeEvent("new")),
        expectStoreError("E_EVAL_INTEGRITY"),
      );
      assert.deepEqual(await readFile(join(runRoot, eventsPath)), before);
    }
  });

  it("fails closed on invalid UTF-8 without rewriting the log", async () => {
    const agentDir = join(await testDir("events-invalid-utf8"), "agent");
    const preRun = await ensurePrivateRunRoot(agentDir, "events-invalid-utf8-run");
    const runRoot = preManifestRunPath(preRun);
    const key = await loadOrCreateCorpusKey(preRun);
    const keyDigest = corpusKeyDigest(key);
    await atomicManifestWrite(preRun, {
      ...makeManifest("events-invalid-utf8-run", 0),
      corpusKeyDigest: keyDigest,
    });
    const safeRun = await openSafeRun(agentDir, "events-invalid-utf8-run");
    const eventsPath = "events.jsonl";
    const line = canonicalJson({ ...makeEvent("old"), data: { value: "x" } });
    const bytes = Buffer.from(`${line}\n`);
    const stringValueOffset = bytes.indexOf(Buffer.from('"x"'));
    assert.notEqual(stringValueOffset, -1);
    bytes[stringValueOffset + 1] = 0xff;
    await writeFile(join(runRoot, eventsPath), bytes, { mode: 0o600 });
    const before = await readFile(join(runRoot, eventsPath));

    await assert.rejects(
      () => loadExistingEventIds(safeRun, eventsPath),
      expectStoreError("E_EVAL_INTEGRITY"),
    );
    assert.deepEqual(await readFile(join(runRoot, eventsPath)), before);
  });

  it("fails closed on non-canonical and pre-existing duplicate records", async () => {
    const agentDir = join(await testDir("events-noncanonical"), "agent");
    const preRun = await ensurePrivateRunRoot(agentDir, "events-noncanonical-run");
    const runRoot = preManifestRunPath(preRun);
    const key = await loadOrCreateCorpusKey(preRun);
    const keyDigest = corpusKeyDigest(key);
    await atomicManifestWrite(preRun, {
      ...makeManifest("events-noncanonical-run", 0),
      corpusKeyDigest: keyDigest,
    });
    const safeRun = await openSafeRun(agentDir, "events-noncanonical-run");
    const eventsPath = "events.jsonl";
    await writeFile(
      join(runRoot, eventsPath),
      `${JSON.stringify(makeEvent("old"), null, 0).replace('"data":', '"type":"test","data":')}\n`,
      { mode: 0o600 },
    );
    await assert.rejects(
      () => loadExistingEventIds(safeRun, eventsPath),
      expectStoreError("E_EVAL_INTEGRITY"),
    );

    const dupAgentDir = join(await testDir("events-existing-duplicate"), "agent");
    const dupPreRun = await ensurePrivateRunRoot(dupAgentDir, "events-existing-duplicate-run");
    const dupRoot = preManifestRunPath(dupPreRun);
    const dupKey = await loadOrCreateCorpusKey(dupPreRun);
    const dupKeyDigest = corpusKeyDigest(dupKey);
    await atomicManifestWrite(dupPreRun, {
      ...makeManifest("events-existing-duplicate-run", 0),
      corpusKeyDigest: dupKeyDigest,
    });
    const dupSafeRun = await openSafeRun(dupAgentDir, "events-existing-duplicate-run");
    const dupEventsPath = "events.jsonl";
    const line = canonicalJson(makeEvent("duplicate"));
    await writeFile(join(dupRoot, dupEventsPath), `${line}\n${line}\n`, { mode: 0o600 });
    await assert.rejects(
      () => appendEvent(dupSafeRun, dupEventsPath, makeEvent("new")),
      expectStoreError("E_EVAL_INTEGRITY"),
    );
  });

  it("rejects empty IDs and raw corpus-key fields before writing", async () => {
    const agentDir = join(await testDir("events-schema"), "agent");
    const preRun = await ensurePrivateRunRoot(agentDir, "events-schema-run");
    const runRoot = preManifestRunPath(preRun);
    const key = await loadOrCreateCorpusKey(preRun);
    const keyDigest = corpusKeyDigest(key);
    await atomicManifestWrite(preRun, {
      ...makeManifest("events-schema-run", 0),
      corpusKeyDigest: keyDigest,
    });
    const safeRun = await openSafeRun(agentDir, "events-schema-run");
    const eventsPath = "events.jsonl";
    await assert.rejects(
      () => appendEvent(safeRun, eventsPath, makeEvent("   ")),
      expectStoreError("E_EVAL_SCHEMA"),
    );

    const invalidEvents = [
      { ...makeEvent("bad-timestamp"), timestamp: 123 },
      { ...makeEvent("bad-type"), type: null },
      { ...makeEvent("bad-data-null"), data: null },
      { ...makeEvent("bad-data-array"), data: [] },
      { ...makeEvent("bad-failed"), failed: "yes" },
      { ...makeEvent("bad-error"), error: 500 },
    ] as unknown as EvidenceEvent[];
    for (const invalidEvent of invalidEvents) {
      await assert.rejects(
        () => appendEvent(safeRun, eventsPath, invalidEvent),
        expectStoreError("E_EVAL_SCHEMA"),
      );
    }

    await assert.rejects(
      () =>
        appendEvent(safeRun, eventsPath, {
          ...makeEvent("secret"),
          data: { corpusKey: generateCorpusKey() },
        }),
      expectStoreError("E_EVAL_PRIVACY"),
    );
    await assert.rejects(() => readFile(join(runRoot, eventsPath)), { code: "ENOENT" });
  });

  it("returns an empty ID set for an absent file", async () => {
    const agentDir = join(await testDir("events-absent"), "agent");
    const preRun = await ensurePrivateRunRoot(agentDir, "events-absent-run");
    const runRoot = preManifestRunPath(preRun);
    const key = await loadOrCreateCorpusKey(preRun);
    const keyDigest = corpusKeyDigest(key);
    await atomicManifestWrite(preRun, {
      ...makeManifest("events-absent-run", 0),
      corpusKeyDigest: keyDigest,
    });
    const safeRun = await openSafeRun(agentDir, "events-absent-run");
    assert.deepEqual(await loadExistingEventIds(safeRun, "nonexistent.jsonl"), new Set());
  });
});

describe("isolation", () => {
  it("uses explicit roots and exposes no provider or session dependency", async () => {
    const agentDir = join(await testDir("isolated"), "explicit-agent");
    const preRun = await ensurePrivateRunRoot(agentDir, "isolated-run");
    const runRoot = preManifestRunPath(preRun);
    const key = await loadOrCreateCorpusKey(preRun);
    const manifest = makeManifest("isolated-run");
    await atomicManifestWrite(preRun, {
      ...manifest,
      corpusKeyDigest: corpusKeyDigest(key),
    });

    const manifestText = await readFile(join(runRoot, "manifest.json"), "utf8");
    assert.equal(manifestText.includes(key), false);
    assert.equal(manifestText.includes("session"), false);
  });
});
