import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
// We import via dynamic import to avoid top-level console.log at import time.
// Instead, we test bootstrap directly.
import { bootstrap } from "../bootstrap.js";

const EXPECTED_EVENTS = [
  "session_start",
  "before_agent_start",
  "model_select",
  "before_provider_request",
  "tool_result",
  "session_shutdown",
];

describe("bootstrap", () => {
  it("should not throw when called with a mock pi object", () => {
    const subscribedEvents: string[] = [];
    const mockPi = {
      on(event: string, _handler: (...args: any[]) => void) {
        subscribedEvents.push(event);
      },
      registerTool(_def: any) {},
      registerProvider(_name: string, _opts: any) {},
      registerCommand(_name: string, _handler: any) {},
    };

    assert.doesNotThrow(() => bootstrap(mockPi as unknown as ExtensionAPI));
    assert.deepEqual(subscribedEvents, EXPECTED_EVENTS);
  });

  it("handler errors should not propagate (wrapped in try/catch)", async () => {
    let capturedHandler: ((...args: any[]) => void) | undefined;
    const mockPi = {
      on(event: string, handler: (...args: any[]) => void) {
        if (event === "session_start") {
          capturedHandler = handler;
        }
      },
      registerTool(_def: any) {},
      registerProvider(_name: string, _opts: any) {},
      registerCommand(_name: string, _handler: any) {},
    };

    bootstrap(mockPi as unknown as ExtensionAPI);
    assert.ok(capturedHandler, "session_start handler should be registered");

    // Calling the handler should not throw even if the underlying async handler rejects.
    // The wrap() function schedules rejection handling via .catch(), so the call itself
    // is synchronous and safe.
    assert.doesNotThrow(() => capturedHandler!());

    // Give microtasks a chance to settle.
    await new Promise((r) => setTimeout(r, 10));
  });
});
