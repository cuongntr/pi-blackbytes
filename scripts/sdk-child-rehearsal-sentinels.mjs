// Explicit preload is fail-closed until parent-reviewed integration is complete.
// Do NOT enable by removing this throw: see sdk-child-rehearsal-README.md.
// Pure implementations are separately importable for no-I/O fake-original tests.
// Missing: complete stream/native loading coverage, public ModelRuntime wrapping,
// parent import containment, immutable manifest/config validation and stop receipts.
throw new Error("fixture_sentinels_BLOCKED_incomplete_coverage");
