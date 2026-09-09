// Import-safe review/receipt boundary. No SDK imports or execution authority creation.
import { createHash } from "node:crypto";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fail = () => { throw new Error("rehearsal_review_refused"); };
const digest = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const cases = new Set(["C01:legacy-exact-tool-output", "C04:missing-model"]);

// Compare complete serialized inventories, not merely a caller-supplied candidate field.
// The caller must obtain `review` from a separately parent-controlled source; a JSON
// boolean is not a signature or permission to manufacture the parent's disposition.
export function requireParentReview(current, reviewedInventory, review, cell, variant) {
  const key = `${cell}:${variant}`;
  if (!cases.has(key) || !current || !reviewedInventory || !review ||
      review.disposition !== "APPROVED" || review.independentR2 !== true ||
      review.executionAuthorized !== true || review.executor === review.reviewer ||
      typeof review.executor !== "string" || !review.executor.trim() ||
      typeof review.reviewer !== "string" || !review.reviewer.trim() ||
      !Array.isArray(review.cases) || !review.cases.includes(key)) fail();
  for (const field of ["candidateSha256", "protocolSha256", "erratumSha256", "amendmentSha256"])
    if (!digest(current[field]) || current[field] !== reviewedInventory[field] || current[field] !== review[field]) fail();
  if (!current.runtime || current.runtime.gaps?.length !== 0 ||
      !current.fixture || !digest(current.fixture.sha256) ||
      !Array.isArray(current.fixture.files) || !current.fixture.files.length ||
      !current.files || !Object.keys(current.files).length ||
      Object.values(current.files).some((value) => !digest(value))) fail();
  const inventorySha256 = hash(JSON.stringify(current));
  if (inventorySha256 !== hash(JSON.stringify(reviewedInventory)) || inventorySha256 !== review.inventorySha256) fail();
  return Object.freeze({ key, inventorySha256, candidateSha256: current.candidateSha256 });
}

// Feed the ACTUAL ChildEventDecoder exported by the isolated adapter. This observer
// supplements, never replaces, the production launcher's independent strict decoder.
export function createSliceObserver({ Decoder, cell, variant, canaries, expectedOutputSha256 }) {
  if (!cases.has(`${cell}:${variant}`) || typeof Decoder !== "function" ||
      !Array.isArray(canaries) || !canaries.length || canaries.some((v) => typeof v !== "string" || !v.length) ||
      (cell === "C01" && !digest(expectedOutputSha256))) fail();
  const decoder = new Decoder();
  const tails = new Map();
  const stages = [];
  let failed = false;
  let terminal;
  let eof = false;
  let exited = false;
  let closed = false;
  let exitCode;
  let signal;
  const block = () => { failed = true; fail(); };
  function stage(name, time) {
    if (failed || !Number.isFinite(time) || time < 0 || (stages.length && time < stages.at(-1).time)) block();
    stages.push({ name, time });
  }
  function scan(channel, bytes) {
    const buffer = Buffer.concat([tails.get(channel) ?? Buffer.alloc(0), Buffer.from(bytes)]);
    for (const canary of canaries) if (buffer.includes(Buffer.from(canary))) block();
    const keep = Math.max(...canaries.map((v) => Buffer.byteLength(v))) - 1;
    tails.set(channel, Buffer.from(buffer.subarray(Math.max(0, buffer.length - keep))));
  }
  return {
    bytes(channel, bytes, time) {
      if (failed || closed || !["stdout", "stderr", "protocol"].includes(channel)) block();
      scan(channel, bytes);
      if (channel !== "protocol") return;
      if (eof) block();
      try {
        decoder.push(bytes, (event) => {
          if (event.type === "terminal") { terminal = event; stage("terminal", time); }
        });
      } catch { block(); }
    },
    eof(time) {
      if (eof || !terminal) block();
      try { if (decoder.finish() !== terminal) block(); } catch { block(); }
      eof = true; stage("eof", time);
    },
    exit(code, exitSignal, time) {
      if (exited || closed || !terminal || (code !== null && !Number.isInteger(code)) ||
          (exitSignal !== null && typeof exitSignal !== "string")) block();
      exited = true; exitCode = code; signal = exitSignal; stage("exit", time);
    },
    close(time) {
      if (closed || !exited || !eof) block();
      closed = true; stage("close", time);
    },
    finish(evidence) {
      if (failed || !closed || !terminal || terminal.settlement?.gateClosed !== true ||
          terminal.settlement?.runsIdle !== true || signal !== null || !evidence ||
          evidence.ownedClosed !== true || evidence.hashesUnchanged !== true || evidence.locksAbsent !== true ||
          evidence.denied !== 0 || evidence.decoy !== 0 ||
          ![evidence.selected, evidence.tools, evidence.newAssistant, evidence.usageTokens].every((n) => Number.isSafeInteger(n) && n >= 0)) block();
      if (cell === "C01") {
        if (terminal.outcome !== "success" || terminal.refusalLatched !== false || exitCode !== 0 ||
            terminal.settlement?.gateClosed !== true || terminal.settlement?.runsIdle !== true ||
            terminal.settlement?.runtimeDisposed !== true || evidence.selected < 2 || evidence.tools !== 1 ||
            evidence.newAssistant < 1 || evidence.usageTokens < 1 || evidence.recomposed !== true ||
            evidence.factorySessionRequestSame !== true || evidence.outputSha256 !== expectedOutputSha256 ||
            !Number.isFinite(evidence.shutdownTime) || evidence.shutdownTime < 0 ||
            evidence.shutdownTime > stages.find((s) => s.name === "terminal").time) block();
      } else if (terminal.outcome !== "failure" || terminal.failureKind !== "provider_or_model_unavailable" ||
          terminal.settlement?.runtimeDisposed !== false || !Number.isInteger(exitCode) || exitCode === 0 || evidence.selected !== 0 || evidence.tools !== 0 ||
          evidence.newAssistant !== 0 || evidence.usageTokens !== 0) block();
      const receipt = { schema: 1, cell, variant, outcome: "OBSERVED", exitCode, stages,
        selected: evidence.selected, decoy: 0, tools: evidence.tools,
        outputSha256: cell === "C01" ? expectedOutputSha256 : null,
        ownedClosed: true, hashesUnchanged: true, locksAbsent: true };
      if (Buffer.byteLength(JSON.stringify(receipt)) > 8192) block();
      // Single-use: later calls cannot retroactively turn a failed observation green.
      failed = true;
      return receipt;
    },
  };
}
