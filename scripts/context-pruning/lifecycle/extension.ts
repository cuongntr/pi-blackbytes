/** Evaluation-only no-op context observer. T-010B owns eventual registration. */

import type { ContextEvent } from "@earendil-works/pi-coding-agent";

import type { ProvenanceEvaluation } from "./provenance.js";

export interface ShadowContextResult {
  readonly messages: ContextEvent["messages"];
}

export type ShadowContextMessages = readonly ContextEvent["messages"][number][];
export type ShadowContextComputation = (messages: ShadowContextMessages) => ProvenanceEvaluation;
export type ShadowEvidenceSink = (evaluation: ProvenanceEvaluation) => void;

/**
 * Observe Pi's exact message array without changing it. Computation and sink are
 * deliberately constrained to content-free provenance evaluation values.
 */
export function createShadowContextHandler(
  compute: ShadowContextComputation,
  sink: ShadowEvidenceSink,
): (event: ContextEvent) => ShadowContextResult {
  return (event) => {
    sink(compute(event.messages));
    return { messages: event.messages };
  };
}
