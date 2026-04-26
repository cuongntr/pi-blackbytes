import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerCopilotHeader } from "../copilot-header.js";

function makeMockPi(): { pi: ExtensionAPI; calls: Array<[string, unknown]> } {
  const calls: Array<[string, unknown]> = [];
  const pi = {
    on: () => {},
    registerTool: () => {},
    registerProvider: (name: string, opts: unknown) => {
      calls.push([name, opts]);
    },
    registerCommand: () => {},
  } as unknown as ExtensionAPI;
  return { pi, calls };
}

describe("registerCopilotHeader", () => {
  it("registers header when config is enabled", () => {
    const { pi, calls } = makeMockPi();
    registerCopilotHeader(pi, { copilot_initiator_header: true });
    assert.equal(calls.length, 1, "registerProvider called once");
    assert.equal(calls[0][0], "github-copilot");
  });

  it("does not register when config is disabled", () => {
    const { pi, calls } = makeMockPi();
    registerCopilotHeader(pi, { copilot_initiator_header: false });
    assert.equal(calls.length, 0, "registerProvider not called");
  });

  it("registerProvider called with correct args", () => {
    const { pi, calls } = makeMockPi();
    registerCopilotHeader(pi, { copilot_initiator_header: true });
    const [name, opts] = calls[0];
    assert.equal(name, "github-copilot");
    assert.deepEqual(opts, { headers: { "X-Initiator": "agent" } });
  });
});
