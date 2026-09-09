import assert from "node:assert/strict";
import { resolve } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { describe, it } from "node:test";
import {
  type ChildEvent,
  ChildEventDecoder,
  type ChildTerminal,
  type LaunchEnvelope,
  LaunchEnvelopeDecoder,
  SDK_CHILD_FRAME_BYTES,
  SdkChildCodecError,
  childEventSchema,
  chunkChildDelta,
  encodeChildEvent,
  encodeLaunchEnvelope,
  isManagedProcessSuccess,
  launchEnvelopeSchema,
  managedSettlementSchema,
  readLaunchEnvelope,
} from "../sdk-child-protocol.js";

const envelope: LaunchEnvelope = {
  version: 1,
  expectedSdkVersion: "0.83.0",
  model: { provider: "fake", id: "literal/slash:high" },
  cwd: resolve("synthetic-checkout"),
  agentDir: resolve("synthetic-home"),
  projectTrusted: false,
  allowedTools: ["fixture_read"],
  systemPrompt: "./literal-text-not-a-file\nΩ😀",
  userPrompt: "synthetic only",
  remainingMs: 1000,
};
const terminal: ChildTerminal = {
  version: 1,
  type: "terminal",
  outcome: "success",
  refusalLatched: false,
  settlement: { gateClosed: true, runsIdle: true, runtimeDisposed: true },
};
function code(expected: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof SdkChildCodecError && error.code === expected && error.message === expected;
}
function decode(bytes: Uint8Array): LaunchEnvelope {
  const decoder = new LaunchEnvelopeDecoder(100, () => 0);
  decoder.push(bytes);
  return decoder.finish();
}
function framed(body: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from(`${body.length}\n`), body]);
}

describe("private SDK child envelope codec (no SDK sessions)", () => {
  it("counts UTF-8 bytes and preserves literal identity, prompts and false trust", () => {
    const bytes = encodeLaunchEnvelope(envelope);
    assert.deepEqual(decode(bytes), envelope);
    const newline = bytes.indexOf(10);
    assert.equal(Number(bytes.subarray(0, newline).toString()), bytes.length - newline - 1);
    assert.notEqual(bytes.length - newline - 1, bytes.subarray(newline + 1).toString().length);
  });
  it("accepts every split and individual byte fragmentation", () => {
    const bytes = encodeLaunchEnvelope(envelope);
    for (let split = 0; split <= bytes.length; split++) {
      const decoder = new LaunchEnvelopeDecoder(100, () => 0);
      decoder.push(bytes.subarray(0, split));
      decoder.push(bytes.subarray(split));
      assert.deepEqual(decoder.finish(), envelope);
    }
    const decoder = new LaunchEnvelopeDecoder(100, () => 0);
    for (const byte of bytes) decoder.push(Uint8Array.of(byte));
    assert.deepEqual(decoder.finish(), envelope);
  });
  it("does not add a prompt-size cap", () => {
    const large = { ...envelope, userPrompt: "😀".repeat(300_000) };
    assert.deepEqual(decode(encodeLaunchEnvelope(large)), large);
  });
  for (const header of [
    "",
    "-1",
    "+1",
    "01",
    "1.0",
    "1e2",
    " 1",
    "1\r",
    "9007199254740992",
    "9".repeat(100),
  ]) {
    it(`rejects noncanonical/unsafe length ${JSON.stringify(header.slice(0, 20))}`, () => {
      assert.throws(() => decode(Buffer.from(`${header}\n`)), code("invalid_length"));
    });
  }
  it("accepts safe maximum declaration without allocating it; zero is invalid JSON", () => {
    assert.throws(() => decode(Buffer.from("9007199254740991\n")), code("truncated"));
    assert.throws(() => decode(Buffer.from("0\n")), code("invalid_json"));
  });
  it("requires exact length and EOF, rejects extra documents and invalid UTF-8", () => {
    const bytes = encodeLaunchEnvelope(envelope);
    assert.throws(() => decode(bytes.subarray(0, -1)), code("truncated"));
    assert.throws(() => decode(Buffer.concat([bytes, Buffer.from(" ")])), code("overrun"));
    assert.throws(() => decode(framed(Buffer.from("{}{}"))), code("invalid_json"));
    for (const invalid of [
      [0xc0, 0xaf],
      [0xed, 0xa0, 0x80],
      [0xf0, 0x9f],
    ]) {
      assert.throws(() => decode(framed(Uint8Array.from(invalid))), code("invalid_utf8"));
    }
    assert.throws(() => decode(framed(Buffer.from("\ufeff{}"))), code("invalid_json"));
  });
  it("rejects invalid/extra fields without leaking their contents", () => {
    for (const value of [
      { ...envelope, version: 2 },
      { ...envelope, projectTrusted: "false" },
      { ...envelope, remainingMs: 0 },
      { ...envelope, cwd: "relative" },
      { ...envelope, allowedTools: [] },
      { ...envelope, allowedTools: ["delegate_general"] },
      { ...envelope, allowedTools: ["read", "read"] },
      { ...envelope, model: { ...envelope.model, headers: "synthetic-private-marker" } },
      { ...envelope, unrecognized: "synthetic-private-marker" },
    ]) {
      assert.equal(launchEnvelopeSchema.safeParse(value).success, false);
      assert.throws(
        () => decode(framed(Buffer.from(JSON.stringify(value)))),
        code("invalid_envelope"),
      );
    }
  });
  it("latches rejection and checks deadline at push and EOF", () => {
    let now = 0;
    const decoder = new LaunchEnvelopeDecoder(1, () => now);
    decoder.push(encodeLaunchEnvelope(envelope));
    now = 1;
    assert.throws(() => decoder.finish(), code("deadline"));
    assert.throws(() => decoder.push(Buffer.alloc(0)), code("overrun"));
    assert.throws(
      () => new LaunchEnvelopeDecoder(0, () => 0).push(Buffer.alloc(0)),
      code("deadline"),
    );
  });
  it("rejects parsing that completes after its deadline", () => {
    let checks = 0;
    const decoder = new LaunchEnvelopeDecoder(1, () => (checks++ < 2 ? 0 : 1));
    decoder.push(encodeLaunchEnvelope(envelope));
    assert.throws(() => decoder.finish(), code("deadline"));
  });
  it("reads a binary pipe, rejects overrun and destroys its source immediately", async () => {
    assert.deepEqual(
      await readLaunchEnvelope(Readable.from([encodeLaunchEnvelope(envelope)]), Date.now() + 1000),
      envelope,
    );
    const source = new PassThrough();
    const pending = readLaunchEnvelope(source, Date.now() + 1000);
    source.write(Buffer.concat([encodeLaunchEnvelope(envelope), Buffer.from("extra")]));
    await assert.rejects(pending, code("overrun"));
    assert.equal(source.destroyed, true);
  });
  it("stops silent and withheld-EOF pipes at deadline", async () => {
    for (const write of [false, true]) {
      const source = new PassThrough();
      const pending = readLaunchEnvelope(source, Date.now() + 20);
      if (write) source.write(encodeLaunchEnvelope(envelope));
      await assert.rejects(pending, code("deadline"));
      assert.equal(source.destroyed, true);
    }
  });
  it("rejects premature close and decoded string streams", async () => {
    const source = new PassThrough();
    const pending = readLaunchEnvelope(source, Date.now() + 1000);
    source.destroy();
    await assert.rejects(pending, code("truncated"));
    await assert.rejects(
      readLaunchEnvelope(Readable.from(["0\n"]), Date.now() + 1000),
      code("invalid_utf8"),
    );
  });
});

describe("bounded fd-3 normalized events and settlement", () => {
  it("streams fragmented events and requires launcher terminal, not raw agent_end", () => {
    const events: ChildEvent[] = [
      { version: 1, type: "session" },
      { version: 1, type: "status", stage: "admitted" },
      { version: 1, type: "model", model: envelope.model },
      { version: 1, type: "progress", event: "agent_end" },
      {
        version: 1,
        type: "tool",
        phase: "start",
        name: "fixture_read",
        callId: "1",
        summary: "synthetic",
      },
      { version: 1, type: "usage", input: 1, output: 2, total: 3, cost: 0 },
      terminal,
    ];
    const decoded: ChildEvent[] = [];
    const decoder = new ChildEventDecoder();
    for (const byte of Buffer.concat(events.map(encodeChildEvent))) {
      decoder.push(Uint8Array.of(byte), (event) => decoded.push(event));
    }
    assert.deepEqual(decoder.finish(), terminal);
    assert.deepEqual(decoded, events);
    const progressOnly = new ChildEventDecoder();
    progressOnly.push(encodeChildEvent(events[3]), () => {});
    assert.throws(() => progressOnly.finish(), code("malformed_jsonl"));
  });
  it("preserves emitter exceptions on valid input and permanently stops decoding", () => {
    for (const event of [{ version: 1, type: "session" } as const, terminal]) {
      for (const original of [
        new Error("consumer failure"),
        new SdkChildCodecError("deadline"),
        null,
      ]) {
        const decoder = new ChildEventDecoder();
        let calls = 0;
        assert.throws(
          () =>
            decoder.push(
              Buffer.concat([encodeChildEvent(event), encodeChildEvent(terminal)]),
              () => {
                calls++;
                throw original;
              },
            ),
          (error: unknown) => error === original,
        );
        assert.equal(calls, 1);
        assert.throws(() => decoder.finish(), code("malformed_jsonl"));
        assert.throws(
          () => decoder.push(encodeChildEvent(terminal), () => calls++),
          code("malformed_jsonl"),
        );
        assert.equal(calls, 1);
      }
    }
  });
  it("discriminates status stages and permits only resource warnings with a code", () => {
    const statuses: ChildEvent[] = [
      { version: 1, type: "status", stage: "version" },
      { version: 1, type: "status", stage: "admitted" },
      { version: 1, type: "status", stage: "warning", code: "resource_warning" },
    ];
    for (const status of statuses) {
      const decoder = new ChildEventDecoder();
      const decoded: ChildEvent[] = [];
      decoder.push(encodeChildEvent(status), (event) => decoded.push(event));
      decoder.push(encodeChildEvent(terminal), () => {});
      assert.deepEqual(decoded, [status]);
      assert.deepEqual(decoder.finish(), terminal);
    }
    for (const fields of [
      { stage: "warning" },
      { stage: "warning", code: "runtime" },
      { stage: "warning", code: "version_mismatch" },
      { stage: "version", code: "resource_warning" },
      { stage: "version", code: "version_mismatch" },
      { stage: "admitted", code: "resource_warning" },
      { stage: "admitted", code: "runtime" },
    ]) {
      const value = { version: 1, type: "status", ...fields };
      assert.equal(childEventSchema.safeParse(value).success, false);
      const decoder = new ChildEventDecoder();
      assert.throws(
        () => decoder.push(Buffer.from(`${JSON.stringify(value)}\n`), () => assert.fail("emitted")),
        code("malformed_jsonl"),
      );
    }
  });
  it("rejects corrupt, oversized, partial, duplicate terminal and post-terminal records", () => {
    for (const bytes of [
      Buffer.from("\n"),
      Buffer.from("{}\n"),
      Buffer.from([0xff, 10]),
      Buffer.from("x".repeat(SDK_CHILD_FRAME_BYTES + 1)),
      Buffer.concat([encodeChildEvent(terminal), encodeChildEvent(terminal)]),
      Buffer.concat([encodeChildEvent(terminal), Buffer.from("\n")]),
      encodeChildEvent(terminal).subarray(0, -1),
      Buffer.from('{"version":2,"type":"session"}\n'),
      Buffer.from('{"version":1,"type":"session","raw":"private"}\n'),
    ]) {
      const decoder = new ChildEventDecoder();
      assert.throws(() => {
        decoder.push(bytes, () => {});
        decoder.finish();
      }, code("malformed_jsonl"));
      assert.throws(() => decoder.finish(), code("malformed_jsonl"));
    }
  });
  it("bounds escaped/multibyte frames, preserves unlimited chunked content", () => {
    const text = '\u0000\\"😀Ω\n'.repeat(10_000);
    const decoder = new ChildEventDecoder();
    let actual = "";
    let count = 0;
    for (const bytes of chunkChildDelta("output", text)) {
      count++;
      assert.ok(bytes.length <= SDK_CHILD_FRAME_BYTES);
      decoder.push(bytes, (event) => {
        if (event.type === "delta") actual += event.text;
      });
    }
    assert.ok(count > 1);
    assert.equal(actual, text);
    decoder.push(encodeChildEvent(terminal), () => {});
    decoder.finish();
    assert.throws(
      () => encodeChildEvent({ version: 1, type: "delta", channel: "text", text }),
      code("malformed_jsonl"),
    );
  });
  it("success requires disposal, idle runs, closed gate, no latch and parent close/EOF/exit", () => {
    const evidence = {
      reaped: true as const,
      childCloseObserved: true as const,
      protocolEof: true,
      protocolValid: true,
      exitCode: 0,
      signal: null,
      terminal,
    };
    assert.equal(isManagedProcessSuccess(evidence), true);
    for (const delta of [
      { protocolEof: false },
      { protocolValid: false },
      { exitCode: 1 },
      { signal: "SIGTERM" },
      { terminal: undefined },
    ]) {
      assert.equal(isManagedProcessSuccess({ ...evidence, ...delta }), false);
    }
    for (const settlement of [
      { gateClosed: false, runsIdle: true, runtimeDisposed: true },
      { gateClosed: true, runsIdle: false, runtimeDisposed: true },
      { gateClosed: true, runsIdle: true, runtimeDisposed: false },
    ]) {
      assert.equal(
        managedSettlementSchema.safeParse({ ...evidence, terminal: { ...terminal, settlement } })
          .success,
        false,
      );
    }
    assert.equal(
      managedSettlementSchema.safeParse({
        ...evidence,
        terminal: { ...terminal, refusalLatched: true },
      }).success,
      false,
    );
    const unreaped = {
      reaped: false as const,
      childCloseObserved: false as const,
      reason: "timed_out" as const,
      writerRetired: true as const,
    };
    assert.equal(isManagedProcessSuccess(unreaped), false);
    assert.equal(
      managedSettlementSchema.safeParse({ ...unreaped, writerRetired: false }).success,
      false,
    );
  });
  it("validates failure code/taxonomy pairs and rejects warning-only failure", () => {
    for (const [failureKind, failureCode] of [
      ["failed", "version_mismatch"],
      ["failed", "wrapper_ownership"],
      ["provider_or_model_unavailable", "model_identity"],
      ["invalid_tool_allowlist", "tool_mismatch"],
      ["cancelled", "cancelled"],
      ["timed_out", "timed_out"],
      ["killed", "killed"],
    ] as const) {
      const event: ChildTerminal = {
        version: 1,
        type: "terminal",
        outcome: "failure",
        failureKind,
        code: failureCode,
        refusalLatched: true,
        settlement: { gateClosed: true, runsIdle: true, runtimeDisposed: true },
      };
      assert.ok(encodeChildEvent(event).length > 0);
      assert.throws(
        () =>
          encodeChildEvent({
            ...event,
            failureKind: failureKind === "failed" ? "cancelled" : "failed",
          }),
        code("malformed_jsonl"),
      );
    }
    assert.throws(
      () =>
        encodeChildEvent({
          version: 1,
          type: "terminal",
          outcome: "failure",
          failureKind: "failed",
          code: "resource_warning",
          refusalLatched: false,
          settlement: { gateClosed: true, runsIdle: true, runtimeDisposed: true },
        }),
      code("malformed_jsonl"),
    );
  });
  it("allows a failed initialization terminal with honest incomplete cleanup", () => {
    const event: ChildTerminal = {
      version: 1,
      type: "terminal",
      outcome: "failure",
      failureKind: "failed",
      code: "capability_missing",
      refusalLatched: true,
      settlement: { gateClosed: true, runsIdle: false, runtimeDisposed: false },
    };
    const decoder = new ChildEventDecoder();
    decoder.push(encodeChildEvent(event), () => {});
    assert.deepEqual(decoder.finish(), event);
  });
});
