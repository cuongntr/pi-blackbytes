import { isAbsolute, normalize } from "node:path";
import type { Readable } from "node:stream";
import { z } from "zod";
import { THINKING_LEVELS } from "../config/model-settings.js";
import type { DelegateFailureKind } from "./types.js";

/** Private, unadopted transport. No SDK import, process launch, or resource loading. */
export const SDK_CHILD_PROTOCOL_VERSION = 1;
// Existing runner/progress stream budget; bounds individual frames, NOT total output or prompts.
export const SDK_CHILD_FRAME_BYTES = 8_192;
const safeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const identity = z.object({ provider: z.string().min(1), id: z.string().min(1) }).strict();
const absolutePath = z.string().refine((s) => isAbsolute(s) && normalize(s) === s);
export const launchEnvelopeSchema = z
  .object({
    version: z.literal(SDK_CHILD_PROTOCOL_VERSION),
    expectedSdkVersion: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/),
    model: identity,
    requestedThinking: z.enum(THINKING_LEVELS).optional(),
    cwd: absolutePath,
    agentDir: absolutePath,
    projectTrusted: z.boolean(),
    allowedTools: z
      .array(
        z
          .string()
          .min(1)
          .refine((s) => s.trim() === s && !s.startsWith("delegate_")),
      )
      .nonempty()
      .refine((names) => new Set(names).size === names.length),
    systemPrompt: z.string(),
    userPrompt: z.string(),
    remainingMs: safeInteger.refine((n) => n > 0),
  })
  .strict();
export type LaunchEnvelope = z.infer<typeof launchEnvelopeSchema>;

export type CodecFailureCode =
  | "invalid_length"
  | "truncated"
  | "overrun"
  | "invalid_utf8"
  | "invalid_json"
  | "invalid_envelope"
  | "deadline"
  | "malformed_jsonl";
/** Fixed codes only: never retain input, schema diagnostics, or thrown provider messages. */
export class SdkChildCodecError extends Error {
  constructor(readonly code: CodecFailureCode) {
    super(code);
    this.name = "SdkChildCodecError";
  }
}
function fail(code: CodecFailureCode): never {
  throw new SdkChildCodecError(code);
}
function json(bytes: Uint8Array): unknown {
  let text: string;
  try {
    // ignoreBOM=true preserves BOM so JSON.parse rejects it rather than silently stripping it.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return fail("invalid_utf8");
  }
  try {
    return JSON.parse(text);
  } catch {
    return fail("invalid_json");
  }
}
export function encodeLaunchEnvelope(value: LaunchEnvelope): Buffer {
  const parsed = launchEnvelopeSchema.safeParse(value);
  if (!parsed.success) return fail("invalid_envelope");
  const body = Buffer.from(JSON.stringify(parsed.data), "utf8");
  return Buffer.concat([Buffer.from(`${body.length}\n`, "ascii"), body]);
}

/** Canonical decimal safe-integer LF header, declared bytes, then mandatory EOF.
 * Callers must stop their source on any throw; readLaunchEnvelope does so for Node pipes.
 * No allocation based on an untrusted declaration and no fixed body/prompt size limit.
 */
export class LaunchEnvelopeDecoder {
  private header = "";
  private length: number | undefined;
  private received = 0;
  private chunks: Buffer[] = [];
  private stopped = false;
  constructor(
    private readonly deadline: number,
    private readonly now = Date.now,
  ) {
    if (!Number.isFinite(deadline)) fail("deadline");
  }
  private check(): void {
    if (this.stopped) fail("overrun");
    if (this.now() >= this.deadline) fail("deadline");
  }
  push(chunk: Uint8Array): void {
    try {
      this.check();
      let offset = 0;
      while (this.length === undefined && offset < chunk.length) {
        const byte = chunk[offset++];
        if (byte === 10) {
          if (!/^(0|[1-9]\d*)$/.test(this.header)) fail("invalid_length");
          const length = Number(this.header);
          if (!Number.isSafeInteger(length)) fail("invalid_length");
          this.length = length;
        } else {
          // Safe integers have at most 16 decimal digits; this is not a prompt limit.
          if (byte < 48 || byte > 57 || this.header.length === 16) fail("invalid_length");
          this.header += String.fromCharCode(byte);
        }
      }
      const bytes = chunk.subarray(offset);
      if (this.length !== undefined && bytes.length > this.length - this.received) fail("overrun");
      if (bytes.length) {
        this.chunks.push(Buffer.from(bytes));
        this.received += bytes.length;
      }
    } catch (error) {
      this.stopped = true;
      this.chunks = [];
      throw error;
    }
  }
  finish(): LaunchEnvelope {
    try {
      this.check();
      if (this.length === undefined || this.received !== this.length) fail("truncated");
      const result = launchEnvelopeSchema.safeParse(json(Buffer.concat(this.chunks)));
      if (!result.success) fail("invalid_envelope");
      // Synchronous parsing cannot be preempted; it must not grant late setup authority.
      this.check();
      return result.data;
    } finally {
      this.stopped = true;
      this.chunks = [];
    }
  }
}

/** Absolute local deadline covers even a silent pipe or a sender withholding EOF.
 * Parent retains its execute-entry deadline; child remainingMs never renews parent authority.
 */
export function readLaunchEnvelope(source: Readable, deadline: number): Promise<LaunchEnvelope> {
  return new Promise((resolve, reject) => {
    if (!Number.isFinite(deadline)) {
      source.destroy();
      reject(new SdkChildCodecError("deadline"));
      return;
    }
    const decoder = new LaunchEnvelopeDecoder(deadline);
    let done = false;
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      clearTimeout(timer);
      source.off("data", onData).off("end", onEnd).off("error", onError).off("close", onClose);
    };
    const stop = (error: unknown) => {
      if (done) return;
      done = true;
      cleanup();
      source.destroy();
      reject(error instanceof SdkChildCodecError ? error : new SdkChildCodecError("truncated"));
    };
    const onData = (chunk: unknown) => {
      try {
        if (!(chunk instanceof Uint8Array)) fail("invalid_utf8");
        decoder.push(chunk);
      } catch (error) {
        stop(error);
      }
    };
    const onEnd = () => {
      try {
        const result = decoder.finish();
        done = true;
        cleanup();
        resolve(result);
      } catch (error) {
        stop(error);
      }
    };
    const onError = () => stop(new SdkChildCodecError("truncated"));
    const onClose = () => stop(new SdkChildCodecError("truncated"));
    const tick = () => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) stop(new SdkChildCodecError("deadline"));
      else timer = setTimeout(tick, Math.min(remaining, 2_147_483_647));
    };
    source.on("data", onData).once("end", onEnd).once("error", onError).once("close", onClose);
    tick();
    if (source.destroyed || source.readableEnded) onClose();
  });
}

const base = { version: z.literal(SDK_CHILD_PROTOCOL_VERSION) };
const settlement = z
  .object({ gateClosed: z.literal(true), runsIdle: z.boolean(), runtimeDisposed: z.boolean() })
  .strict();
const failureKind = z.enum([
  "failed",
  "timed_out",
  "cancelled",
  "spawn_error",
  "recursion_refused",
  "cli_usage_error",
  "invalid_tool_allowlist",
  "provider_or_model_unavailable",
  "malformed_jsonl",
  "killed",
]);
const failureCode = z.enum([
  "version_mismatch",
  "capability_missing",
  "setup",
  "protocol_initialization",
  "gate_closed",
  "wrapper_ownership",
  "replacement_refused",
  "tool_mismatch",
  "model_unavailable",
  "model_identity",
  "cancelled",
  "timed_out",
  "killed",
  "runtime",
  "resource_warning",
]);
const failureKindsByCode = {
  version_mismatch: "failed",
  capability_missing: "failed",
  setup: "failed",
  protocol_initialization: "failed",
  gate_closed: "failed",
  wrapper_ownership: "failed",
  replacement_refused: "failed",
  tool_mismatch: "invalid_tool_allowlist",
  model_unavailable: "provider_or_model_unavailable",
  model_identity: "provider_or_model_unavailable",
  cancelled: "cancelled",
  timed_out: "timed_out",
  killed: "killed",
  runtime: "failed",
  resource_warning: "failed",
} as const satisfies Record<z.infer<typeof failureCode>, DelegateFailureKind>;
const terminalSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      ...base,
      type: z.literal("terminal"),
      outcome: z.literal("success"),
      refusalLatched: z.literal(false),
      settlement: z
        .object({
          gateClosed: z.literal(true),
          runsIdle: z.literal(true),
          runtimeDisposed: z.literal(true),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("terminal"),
      outcome: z.literal("failure"),
      refusalLatched: z.boolean(),
      failureKind,
      code: failureCode,
      settlement,
    })
    .strict()
    .refine(
      (value) =>
        value.code !== "resource_warning" && value.failureKind === failureKindsByCode[value.code],
    ),
]);
/** Normalized fd-3 records only; no raw message snapshots, args, headers, or model objects.
 * Output-channel text is sensitive, byte-preserved. Other strings require redaction BEFORE encoding.
 */
export const childEventSchema = z.union([
  z.object({ ...base, type: z.literal("session") }).strict(),
  z.discriminatedUnion("stage", [
    z.object({ ...base, type: z.literal("status"), stage: z.literal("version") }).strict(),
    z.object({ ...base, type: z.literal("status"), stage: z.literal("admitted") }).strict(),
    z
      .object({
        ...base,
        type: z.literal("status"),
        stage: z.literal("warning"),
        code: z.literal("resource_warning"),
      })
      .strict(),
  ]),
  z.object({ ...base, type: z.literal("model"), model: identity }).strict(),
  z
    .object({
      ...base,
      type: z.literal("progress"),
      event: z.enum([
        "agent_start",
        "agent_end",
        "turn_start",
        "turn_end",
        "message_start",
        "message_end",
      ]),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("delta"),
      channel: z.enum(["output", "text", "thinking"]),
      text: z.string(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("tool"),
      phase: z.enum(["call", "start", "update", "end"]),
      name: z.string().min(1),
      callId: z.string().min(1),
      summary: z.string().max(50).optional(),
      isError: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("usage"),
      input: safeInteger,
      output: safeInteger,
      total: safeInteger,
      cost: z.number().finite().nonnegative(),
    })
    .strict(),
  terminalSchema,
]);
export type ChildEvent = z.infer<typeof childEventSchema>;
export type ChildTerminal = z.infer<typeof terminalSchema>;

export function encodeChildEvent(event: ChildEvent): Buffer {
  const result = childEventSchema.safeParse(event);
  if (!result.success) fail("malformed_jsonl");
  const bytes = Buffer.from(`${JSON.stringify(result.data)}\n`, "utf8");
  if (bytes.length > SDK_CHILD_FRAME_BYTES) fail("malformed_jsonl");
  return bytes;
}
/** Chunk supported text without imposing a total output cap or splitting surrogate pairs. */
export function* chunkChildDelta(
  channel: "output" | "text" | "thinking",
  text: string,
): Generator<Buffer> {
  // Worst JSON escape is six bytes per UTF-16 unit, with room for the fixed frame fields.
  const units = Math.floor((SDK_CHILD_FRAME_BYTES - 128) / 6);
  let chunk = "";
  for (const point of text) {
    if (chunk.length + point.length > units) {
      yield encodeChildEvent({ version: 1, type: "delta", channel, text: chunk });
      chunk = "";
    }
    chunk += point;
  }
  if (chunk) yield encodeChildEvent({ version: 1, type: "delta", channel, text: chunk });
}

/** Bounded JSONL tail; exactly one launcher terminal, no subsequent records, mandatory final LF.
 * Stream records to a bounded consumer: never collect the entire event history here.
 */
export class ChildEventDecoder {
  private tail: number[] = [];
  private terminal: ChildTerminal | undefined;
  private stopped = false;
  push(bytes: Uint8Array, emit: (event: ChildEvent) => void): void {
    try {
      if (this.stopped) fail("malformed_jsonl");
      for (const byte of bytes) {
        if (this.terminal || this.tail.length + 1 > SDK_CHILD_FRAME_BYTES) fail("malformed_jsonl");
        if (byte !== 10) {
          this.tail.push(byte);
          continue;
        }
        let event: ChildEvent;
        try {
          const result = childEventSchema.safeParse(json(Uint8Array.from(this.tail)));
          if (!result.success) fail("malformed_jsonl");
          event = result.data;
        } catch {
          fail("malformed_jsonl");
        }
        this.tail = [];
        if (event.type === "terminal") this.terminal = event;
        emit(event);
      }
    } catch (error) {
      this.stopped = true;
      this.tail = [];
      this.terminal = undefined;
      throw error;
    }
  }
  finish(): ChildTerminal {
    if (this.stopped || this.tail.length || !this.terminal) {
      this.stopped = true;
      fail("malformed_jsonl");
    }
    this.stopped = true;
    return this.terminal;
  }
}

/** Parent-observed evidence, NOT a child assertion and NOT proof of task verification.
 * false is a permanent writer retirement signal even if close arrives later.
 */
export const managedSettlementSchema = z.discriminatedUnion("reaped", [
  z
    .object({
      reaped: z.literal(true),
      childCloseObserved: z.literal(true),
      protocolEof: z.boolean(),
      protocolValid: z.boolean(),
      exitCode: z.number().int().nullable(),
      signal: z.string().nullable(),
      terminal: terminalSchema.optional(),
    })
    .strict(),
  z
    .object({
      reaped: z.literal(false),
      childCloseObserved: z.literal(false),
      reason: z.enum(["cancelled", "timed_out", "killed"]),
      writerRetired: z.literal(true),
    })
    .strict(),
]);
export type ManagedSettlement = z.infer<typeof managedSettlementSchema>;
export function isManagedProcessSuccess(evidence: ManagedSettlement): boolean {
  const parsed = managedSettlementSchema.safeParse(evidence);
  if (!parsed.success) return false;
  const value = parsed.data;
  return (
    value.reaped &&
    value.protocolEof &&
    value.protocolValid &&
    value.exitCode === 0 &&
    value.signal === null &&
    value.terminal?.outcome === "success"
  );
}
