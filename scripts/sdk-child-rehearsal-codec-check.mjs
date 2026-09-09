// Pure check: node --import tsx scripts/sdk-child-rehearsal-codec-check.mjs
// Imports only the production codec (no SDK, adapter, launcher or session).
import assert from "node:assert/strict";
import { ChildEventDecoder, encodeChildEvent } from "../src/sub-agents/sdk-child-protocol.ts";
import { createSliceObserver } from "./sdk-child-rehearsal-review.mjs";
const terminal = { version: 1, type: "terminal", outcome: "failure", refusalLatched: false,
  failureKind: "provider_or_model_unavailable", code: "model_unavailable",
  settlement: { gateClosed: true, runsIdle: true, runtimeDisposed: false } };
const frame = encodeChildEvent(terminal);
const make = () => createSliceObserver({ Decoder: ChildEventDecoder, cell: "C04", variant: "missing-model", canaries: ["synthetic-private-canary"] });
const evidence = { ownedClosed: true, hashesUnchanged: true, locksAbsent: true, denied: 0,
  selected: 0, decoy: 0, tools: 0, newAssistant: 0, usageTokens: 0 };
for (let split = 1; split < frame.length; split++) {
  const o = make();
  o.bytes("protocol", frame.subarray(0, split), 1);
  o.bytes("protocol", frame.subarray(split), 2);
  o.eof(3); o.exit(1, null, 4); o.close(5);
  assert.equal(o.finish(evidence).exitCode, 1);
}
for (const malformed of [Buffer.from("{}\n"), Buffer.from([0xff, 10]), Buffer.concat([frame, frame]), Buffer.concat([frame, Buffer.from("x")])]) {
  const o = make(); assert.throws(() => o.bytes("protocol", malformed, 1));
  assert.throws(() => o.finish(evidence));
}
const partial = make(); partial.bytes("protocol", frame.subarray(0, -1), 1); assert.throws(() => partial.eof(2));
console.log(JSON.stringify({ sdkExecution: "NOT RUN", decoder: "production", fragmentSplits: frame.length - 1, corruptions: 5 }));
