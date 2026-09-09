import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createSliceObserver, requireParentReview } from "./sdk-child-rehearsal-review.mjs";
const sha = (v) => createHash("sha256").update(v).digest("hex");
const output = sha("synthetic complete 🦊");
function authority() {
  const inventory = { candidateSha256: sha("candidate"), protocolSha256: sha("protocol"),
    erratumSha256: sha("erratum"), amendmentSha256: sha("amendment"),
    runtime: { gaps: [], files: [] }, fixture: { sha256: sha("fixture"), files: ["synthetic"] }, files: { adapter: sha("adapter") } };
  return { inventory, review: { ...inventory, inventorySha256: sha(JSON.stringify(inventory)),
    executor: "executor", reviewer: "parent", independentR2: true, executionAuthorized: true,
    disposition: "APPROVED", cases: ["C01:legacy-exact-tool-output", "C04:missing-model"] } };
}
test("review binds the complete exact inventory and three authority hashes", () => {
  const { inventory, review } = authority();
  assert.ok(requireParentReview(inventory, structuredClone(inventory), review, "C01", "legacy-exact-tool-output"));
  for (const field of ["candidateSha256", "protocolSha256", "erratumSha256", "amendmentSha256"])
    assert.throws(() => requireParentReview({ ...inventory, [field]: sha("changed") }, inventory, review, "C01", "legacy-exact-tool-output"));
  assert.throws(() => requireParentReview({ ...inventory, extra: true }, inventory, review, "C01", "legacy-exact-tool-output"));
});
test("review never authorizes another case, missing fixture, gaps, or executor self-review", () => {
  const { inventory, review } = authority();
  for (const changes of [{ disposition: "PENDING" }, { independentR2: false }, { executionAuthorized: false },
    { reviewer: "executor" }, { cases: [] }, { inventorySha256: sha("other") }])
    assert.throws(() => requireParentReview(inventory, inventory, { ...review, ...changes }, "C04", "missing-model"));
  for (const changes of [{ fixture: undefined }, { runtime: { gaps: ["missing"] } }, { files: {} }])
    assert.throws(() => requireParentReview({ ...inventory, ...changes }, inventory, review, "C04", "missing-model"));
  assert.throws(() => requireParentReview(inventory, inventory, review, "C04", "missing-provider"));
});
// Injected fake decoder only. Strict production codec checks run separately under
// the existing tsx test loader, without importing the SDK or launcher adapter.
class FakeDecoder {
  push(bytes, emit) { this.terminal = JSON.parse(Buffer.from(bytes)); emit(this.terminal); }
  finish() { return this.terminal; }
}
const success = { type: "terminal", outcome: "success", refusalLatched: false,
  settlement: { gateClosed: true, runsIdle: true, runtimeDisposed: true } };
const failure = { type: "terminal", outcome: "failure", failureKind: "provider_or_model_unavailable",
  settlement: { gateClosed: true, runsIdle: true, runtimeDisposed: false } };
const evidence = { ownedClosed: true, hashesUnchanged: true, locksAbsent: true, denied: 0,
  selected: 2, decoy: 0, tools: 1, newAssistant: 1, usageTokens: 4, recomposed: true,
  factorySessionRequestSame: true, outputSha256: output, shutdownTime: 1 };
function observer(negative = false, Decoder = FakeDecoder) {
  return createSliceObserver({ Decoder, cell: negative ? "C04" : "C01",
    variant: negative ? "missing-model" : "legacy-exact-tool-output", canaries: ["private-🦊-canary"], expectedOutputSha256: output });
}
function settle(o, negative = false, code = negative ? 1 : 0) {
  o.bytes("protocol", Buffer.from(JSON.stringify(negative ? failure : success)), 2);
  o.eof(3); o.exit(code, null, 4); o.close(5);
}
test("positive requires new assistant, tool, usage, exact hash and object/recomposition observations", () => {
  const o = observer(); settle(o);
  assert.equal(o.finish(evidence).outcome, "OBSERVED");
  assert.throws(() => o.finish(evidence));
  for (const changes of [{ newAssistant: 0 }, { usageTokens: 0 }, { tools: 0 }, { selected: 0 },
    { decoy: 1 }, { recomposed: false }, { factorySessionRequestSame: false }, { outputSha256: sha("wrong") },
    { shutdownTime: 3 }, { shutdownTime: -1 }, { denied: 1 }, { hashesUnchanged: false }, { ownedClosed: false }, { locksAbsent: false }]) {
    const o = observer(); settle(o); assert.throws(() => o.finish({ ...evidence, ...changes }));
  }
});
test("unavailable requires zero activity and NONZERO exit", () => {
  const zero = { ...evidence, selected: 0, tools: 0, newAssistant: 0, usageTokens: 0 };
  const o = observer(true); settle(o, true); assert.equal(o.finish(zero).exitCode, 1);
  for (const code of [0, null]) { const o = observer(true); settle(o, true, code); assert.throws(() => o.finish(zero)); }
  for (const key of ["selected", "tools", "newAssistant", "usageTokens"]) {
    const o = observer(true); settle(o, true); assert.throws(() => o.finish({ ...zero, [key]: 1 }));
  }
});
test("rolling byte canaries catch every multibyte split independently per channel", () => {
  const bytes = Buffer.from("private-🦊-canary");
  for (const channel of ["stdout", "stderr"]) for (let split = 1; split < bytes.length; split++) {
    const o = observer(); o.bytes(channel, bytes.subarray(0, split), 0);
    assert.throws(() => o.bytes(channel, bytes.subarray(split), 1));
    assert.throws(() => settle(o));
  }
});
test("terminal, EOF, exit and close are mandatory, monotonic and single-use", () => {
  for (const action of [(o) => o.eof(0), (o) => o.exit(0, null, 0), (o) => o.close(0), (o) => o.finish(evidence)])
    assert.throws(() => action(observer()));
  const o = observer(); o.bytes("protocol", Buffer.from(JSON.stringify(success)), 2);
  assert.throws(() => o.eof(1)); assert.throws(() => o.finish(evidence));
  const closed = observer(); settle(closed); assert.throws(() => closed.close(6));
});
test("decoder refusal stays latched even when caller catches", () => {
  class RefusingDecoder { push() { throw new Error("malformed"); } }
  const o = observer(false, RefusingDecoder);
  assert.throws(() => o.bytes("protocol", Buffer.from("bad"), 0));
  assert.throws(() => o.finish(evidence));
});
