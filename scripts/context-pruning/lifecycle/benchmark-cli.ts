#!/usr/bin/env node
/** Explicit opt-in handoff for the real T-021 lifecycle performance matrix. */

import { EvidenceStoreError } from "../types.js";
import { requireT021RealBenchmarkExecutor } from "./benchmark.js";

function fail(error: EvidenceStoreError): never {
  process.stderr.write(
    `${JSON.stringify({ code: error.code, message: error.message, recordId: error.recordId })}\n`,
  );
  process.exit(1);
}

const args = process.argv.slice(2);
if (!args.includes("--opt-in")) {
  fail(
    new EvidenceStoreError(
      "E_EVAL_INCOMPLETE",
      "Lifecycle performance evidence is opt-in; T-021 must pass --opt-in with frozen fixtures and pins",
    ),
  );
}

try {
  requireT021RealBenchmarkExecutor();
} catch (error: unknown) {
  if (error instanceof EvidenceStoreError) fail(error);
  fail(new EvidenceStoreError("E_EVAL_INTEGRITY", "Lifecycle benchmark handoff failed"));
}
