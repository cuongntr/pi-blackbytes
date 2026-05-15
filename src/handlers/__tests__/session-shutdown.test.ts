import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { ExtensionContext, SessionShutdownEvent } from "@earendil-works/pi-coding-agent";
import { _resetEnabledSet, initEnabledSet } from "../../config/enabled-set.js";
import { parseBlackbytesConfig } from "../../config/schema.js";
import { handleSessionShutdown } from "../index.js";

function makeConfig(overrides: Record<string, unknown> = {}) {
  const result = parseBlackbytesConfig(overrides);
  if (!result.ok) throw new Error(result.errors.join(", "));
  return result.value;
}

describe("handleSessionShutdown", () => {
  beforeEach(() => {
    _resetEnabledSet();
    initEnabledSet(makeConfig());
  });

  it("flushes pending writes on shutdown without throwing", async () => {
    const shutdownEvent = { type: "session_shutdown" } as SessionShutdownEvent;
    await assert.doesNotReject(
      handleSessionShutdown(shutdownEvent, {} as unknown as ExtensionContext),
      "flush should not throw",
    );
  });

  it("second shutdown call also resolves without error", async () => {
    const shutdownEvent = { type: "session_shutdown" } as SessionShutdownEvent;
    const ctx = {} as unknown as ExtensionContext;
    await assert.doesNotReject(
      Promise.all([
        handleSessionShutdown(shutdownEvent, ctx),
        handleSessionShutdown(shutdownEvent, ctx),
      ]),
      "concurrent shutdowns should not throw",
    );
  });
});
