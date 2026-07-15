import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  candidateIdForQualification,
  qualificationCatalogDigest,
  selectAnnotatedCandidate,
  validateAdjudicationRecord,
  validateBlindedAnnotationRecord,
  validateCandidateSelectionInput,
  validateQualificationEnvelope,
} from "../annotations.js";
import { canonicalDigest } from "../canonical-json.js";

const digest = (character: string): string => character.repeat(64);
const corpusId = digest("a");

function envelope(marker: string, startOrder: number, closureOrder: number) {
  const qualification = {
    schemaVersion: 1,
    corpusId,
    selectedRank: 7,
    qualifies: true,
    criteria: {
      parent: true,
      pressure: true,
      completedSegment: true,
      fiveSubsequentRequests: true,
    },
    reasonCodes: [],
    candidate: {
      branchLeafId: digest(marker),
      startEntryId: digest(marker),
      endEntryId: digest(marker),
      closureEntryId: digest(marker),
      startOrder,
      endOrder: closureOrder - 1,
      closureOrder,
      closureEvidence: ["user-accepted", "goal-transition", "verification-passed"],
      estimatedTokens: 2_048,
      subsequentRequestIds: ["8", "9", "b", "c", "d"].map(digest),
    },
    annotatorIds: [],
    adjudicationStatus: "not-needed",
  };
  return {
    schemaVersion: 1,
    qualificationDigest: canonicalDigest(qualification),
    qualification,
  };
}

function annotation(
  annotationId: string,
  annotatorId: string,
  annotatorKind: "owner" | "independent-human" | "consented-model",
  claims: readonly Record<string, unknown>[],
  catalog: readonly unknown[] = [earlyClose, earlyStart],
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    annotationId,
    catalogDigest: qualificationCatalogDigest(catalog),
    corpusId,
    selectedRank: 7,
    annotatorId,
    annotatorKind,
    decision: claims.length === 0 ? "no-qualifying-candidate" : "candidates-identified",
    claims,
    reasonCodes: claims.length === 0 ? ["ambiguous-closure"] : [],
  };
}

function claim(candidateId: string, code = "goal-transition"): Record<string, unknown> {
  return { candidateId, closureEvidence: [code] };
}

const firstAnnotationId = digest("e");
const secondAnnotationId = digest("f");
const ownerId = "1".repeat(64);
const secondAnnotatorId = "2".repeat(64);
const adjudicatorId = "3".repeat(64);
const earlyClose = envelope("4", 12, 15);
const earlyStart = envelope("5", 4, 20);
const lateStart = envelope("6", 8, 20);
const earlyCloseId = candidateIdForQualification(earlyClose.qualification);
const earlyStartId = candidateIdForQualification(earlyStart.qualification);
const lateStartId = candidateIdForQualification(lateStart.qualification);

function agreedAnnotations(
  claims: readonly Record<string, unknown>[],
  catalog: readonly unknown[] = [earlyClose, earlyStart],
) {
  return [
    annotation(firstAnnotationId, ownerId, "owner", claims, catalog),
    annotation(secondAnnotationId, secondAnnotatorId, "independent-human", claims, catalog),
  ];
}

function annotationDigests(values: readonly Record<string, unknown>[]): [string, string] {
  return values.map((value) => canonicalDigest(validateBlindedAnnotationRecord(value))).sort() as [
    string,
    string,
  ];
}

describe("blinded annotation schemas", () => {
  it("accepts only the three frozen closure evidence codes", () => {
    for (const code of ["user-accepted", "goal-transition", "verification-passed"]) {
      const value = annotation(firstAnnotationId, ownerId, "owner", [claim(earlyCloseId, code)]);
      assert.deepEqual(validateBlindedAnnotationRecord(value).claims[0].closureEvidence, [code]);
    }
    assert.throws(
      () =>
        validateBlindedAnnotationRecord(
          annotation(firstAnnotationId, ownerId, "owner", [
            claim(earlyCloseId, "assistant-self-asserted"),
          ]),
        ),
      { code: "E_EVAL_SCHEMA" },
    );
  });

  it("rejects ambiguous or assistant-only closure as qualifying claims", () => {
    for (const reason of ["ambiguous-closure", "assistant-only-closure"]) {
      const value = {
        ...annotation(firstAnnotationId, ownerId, "owner", []),
        reasonCodes: [reason],
      };
      assert.equal(validateBlindedAnnotationRecord(value).decision, "no-qualifying-candidate");
    }
    assert.throws(
      () =>
        validateBlindedAnnotationRecord({
          ...annotation(firstAnnotationId, ownerId, "owner", [claim(earlyCloseId)]),
          reasonCodes: ["ambiguous-closure"],
        }),
      { code: "E_EVAL_SCHEMA" },
    );
  });

  it("rejects transcript, future outcome, cost, gold, and replay fields", () => {
    const base = annotation(firstAnnotationId, ownerId, "owner", [claim(earlyCloseId)]);
    for (const field of ["content", "futureOutcome", "cost", "gold", "replayResult"]) {
      assert.throws(() => validateBlindedAnnotationRecord({ ...base, [field]: "SECRET" }), {
        code: "E_EVAL_SCHEMA",
      });
    }
  });

  it("binds the catalog to canonical fully-qualified T-007A records", () => {
    assert.deepEqual(validateQualificationEnvelope(earlyClose), earlyClose);
    assert.throws(
      () => validateQualificationEnvelope({ ...earlyClose, qualificationDigest: digest("7") }),
      { code: "E_EVAL_INTEGRITY" },
    );
    const notQualified = {
      ...earlyClose,
      qualification: { ...earlyClose.qualification, qualifies: false },
    };
    notQualified.qualificationDigest = canonicalDigest(notQualified.qualification);
    assert.throws(() => validateQualificationEnvelope(notQualified), { code: "E_EVAL_SCHEMA" });

    for (const mutate of [
      (value: typeof earlyClose) => {
        value.qualification.candidate.estimatedTokens = 0;
      },
      (value: typeof earlyClose) => {
        value.qualification.candidate.subsequentRequestIds = [digest("8")];
      },
      (value: typeof earlyClose) => {
        (value.qualification as unknown as { annotatorIds: string[] }).annotatorIds = [ownerId];
      },
    ]) {
      const forged = structuredClone(earlyClose);
      mutate(forged);
      forged.qualificationDigest = canonicalDigest(forged.qualification);
      assert.throws(() => validateQualificationEnvelope(forged), { code: "E_EVAL_SCHEMA" });
    }
  });

  it("rejects content hidden in allowlisted reference fields", () => {
    const poisoned = structuredClone(earlyClose);
    poisoned.qualification.candidate.branchLeafId = "SECRET TRANSCRIPT";
    poisoned.qualificationDigest = canonicalDigest(poisoned.qualification);
    assert.throws(() => validateQualificationEnvelope(poisoned), { code: "E_EVAL_SCHEMA" });
  });

  it("binds annotation candidate IDs to the complete qualification digest", () => {
    const changed = structuredClone(earlyClose);
    changed.qualification.candidate.startOrder += 1;
    changed.qualificationDigest = canonicalDigest(changed.qualification);
    assert.notEqual(
      candidateIdForQualification(changed.qualification),
      candidateIdForQualification(earlyClose.qualification),
    );
  });
});

describe("independence, disagreement, and adjudication", () => {
  const catalog = [earlyClose, earlyStart];

  it("requires two distinct records: one owner and one independent annotator", () => {
    const one = annotation(firstAnnotationId, ownerId, "owner", [claim(earlyCloseId)]);
    assert.throws(() => selectAnnotatedCandidate(catalog, [one]), { code: "E_EVAL_SCHEMA" });
    assert.throws(
      () =>
        selectAnnotatedCandidate(catalog, [
          one,
          { ...one, annotatorId: secondAnnotatorId, annotatorKind: "independent-human" },
        ]),
      { code: "E_EVAL_SCHEMA" },
    );
    const twoOwners = [
      one,
      annotation(secondAnnotationId, secondAnnotatorId, "owner", [claim(earlyCloseId)]),
    ];
    assert.throws(() => selectAnnotatedCandidate(catalog, twoOwners), { code: "E_EVAL_SCHEMA" });
  });

  it("cannot upgrade closure evidence beyond T-007A structural evidence", () => {
    const limited = structuredClone(earlyClose);
    limited.qualification.candidate.closureEvidence = ["goal-transition"];
    limited.qualificationDigest = canonicalDigest(limited.qualification);
    const limitedId = candidateIdForQualification(limited.qualification);
    const disagreeing = [
      annotation(
        firstAnnotationId,
        ownerId,
        "owner",
        [claim(limitedId, "verification-passed")],
        [limited],
      ),
      annotation(
        secondAnnotationId,
        secondAnnotatorId,
        "independent-human",
        [claim(limitedId, "goal-transition")],
        [limited],
      ),
    ];
    assert.throws(() => selectAnnotatedCandidate([limited], disagreeing), {
      code: "E_EVAL_INTEGRITY",
    });
  });

  it("preserves disagreement digests and blocks selection until resolved", () => {
    const annotations = [
      annotation(firstAnnotationId, ownerId, "owner", [claim(earlyCloseId)]),
      annotation(secondAnnotationId, secondAnnotatorId, "independent-human", [claim(earlyStartId)]),
    ];
    const result = selectAnnotatedCandidate(catalog, annotations);
    assert.equal(result.status, "blocked");
    assert.deepEqual(result.annotationDigests, annotationDigests(annotations));
    assert.equal("qualification" in result, false);
  });

  it("keeps unresolved adjudication blocked and permits an owner adjudicator", () => {
    const annotations = [
      annotation(firstAnnotationId, ownerId, "owner", [claim(earlyCloseId)]),
      annotation(secondAnnotationId, secondAnnotatorId, "independent-human", [claim(earlyStartId)]),
    ];
    const adjudication = {
      schemaVersion: 1,
      adjudicationId: digest("7"),
      corpusId,
      selectedRank: 7,
      adjudicatorId: ownerId,
      annotationDigests: annotationDigests(annotations),
      status: "unresolved",
      resolvedClaims: [],
      reasonCodes: [],
    };
    assert.equal(selectAnnotatedCandidate(catalog, annotations, adjudication).status, "blocked");
  });

  it("binds resolved adjudication and merges final qualification metadata", () => {
    const annotations = [
      annotation(firstAnnotationId, ownerId, "owner", [claim(earlyCloseId)]),
      annotation(secondAnnotationId, secondAnnotatorId, "independent-human", [claim(earlyStartId)]),
    ];
    const adjudication = {
      schemaVersion: 1,
      adjudicationId: digest("7"),
      corpusId,
      selectedRank: 7,
      adjudicatorId,
      annotationDigests: annotationDigests(annotations),
      status: "resolved",
      resolvedClaims: [claim(earlyCloseId, "user-accepted")],
      reasonCodes: [],
    };
    assert.equal(validateAdjudicationRecord(adjudication).status, "resolved");
    const result = selectAnnotatedCandidate(catalog, annotations, adjudication);
    assert.equal(result.status, "selected");
    assert.equal(result.qualification?.candidate?.branchLeafId, digest("4"));
    assert.deepEqual(result.qualification?.candidate?.closureEvidence, ["user-accepted"]);
    assert.deepEqual(result.qualification?.annotatorIds, [ownerId, secondAnnotatorId].sort());
    assert.equal(result.qualification?.adjudicationStatus, "resolved");
    assert.ok(result.adjudicationDigest);

    assert.throws(
      () =>
        selectAnnotatedCandidate(catalog, annotations, {
          ...adjudication,
          annotationDigests: [digest("8"), digest("9")],
        }),
      { code: "E_EVAL_INTEGRITY" },
    );
  });
});

describe("deterministic candidate selection", () => {
  it("uses earliest close, then earliest start, independent of input order", () => {
    const catalog = [lateStart, earlyStart, earlyClose];
    const claims = [claim(lateStartId), claim(earlyStartId), claim(earlyCloseId)];
    const annotations = agreedAnnotations(claims, catalog);
    const first = selectAnnotatedCandidate(catalog, annotations);
    const second = selectAnnotatedCandidate([...catalog].reverse(), [...annotations].reverse());
    assert.equal(first.qualification?.candidate?.branchLeafId, digest("4"));
    assert.deepEqual(second, first);

    const sameCloseAnnotations = agreedAnnotations(
      [claim(lateStartId), claim(earlyStartId)],
      [lateStart, earlyStart],
    );
    assert.equal(
      selectAnnotatedCandidate([lateStart, earlyStart], sameCloseAnnotations).qualification
        ?.candidate?.branchLeafId,
      digest("5"),
    );
  });

  it("returns none only for the exact catalog both annotators reviewed", () => {
    const annotations = agreedAnnotations([], [earlyClose]);
    const result = selectAnnotatedCandidate([earlyClose], annotations);
    assert.equal(result.status, "none");
    assert.throws(() => selectAnnotatedCandidate([earlyClose, earlyStart], annotations), {
      code: "E_EVAL_INTEGRITY",
    });
  });

  it("rejects claims outside the structural eligibility catalog", () => {
    assert.throws(
      () =>
        selectAnnotatedCandidate(
          [earlyClose],
          agreedAnnotations([claim(earlyStartId)], [earlyClose]),
        ),
      { code: "E_EVAL_INTEGRITY" },
    );
  });

  it("selection input rejects every non-allowlisted access-boundary field", () => {
    const base = {
      candidates: [earlyClose],
      annotations: agreedAnnotations([claim(earlyCloseId)], [earlyClose]),
    };
    assert.deepEqual(validateCandidateSelectionInput(base), base);
    for (const field of ["transcript", "futureOutcomes", "replay", "cost", "gold", "gates"]) {
      assert.throws(() => validateCandidateSelectionInput({ ...base, [field]: "SECRET" }), {
        code: "E_EVAL_SCHEMA",
      });
    }
  });
});
