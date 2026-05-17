import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type ToolResultEvent, processToolResult } from "../tool-result.js";

const cfg = { hashline_edit: true };
const cfgOff = { hashline_edit: false };

describe("processToolResult — read branch", () => {
  it("happy path: prepends LINE#ID anchors to text content", () => {
    const event: ToolResultEvent = {
      toolName: "read",
      content: [{ type: "text", text: "hello\nworld" }],
    };
    const result = processToolResult(event, cfg);
    assert.ok(result !== null);
    const text = result!.content![0].text!;
    const lines = text.split("\n");
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^1#[A-Z]{2}\|hello$/);
    assert.match(lines[1], /^2#[A-Z]{2}\|world$/);
  });

  it("isError: returns null (preserved verbatim)", () => {
    const event: ToolResultEvent = {
      toolName: "read",
      isError: true,
      content: [{ type: "text", text: "err" }],
    };
    assert.equal(processToolResult(event, cfg), null);
  });

  it("non-text blocks are skipped (unchanged)", () => {
    const event: ToolResultEvent = {
      toolName: "read",
      content: [{ type: "image" }],
    };
    assert.equal(processToolResult(event, cfg), null);
  });

  it("hashline_edit=false: returns null", () => {
    const event: ToolResultEvent = {
      toolName: "read",
      content: [{ type: "text", text: "hi" }],
    };
    assert.equal(processToolResult(event, cfgOff), null);
  });

  it("malformed input (null content): returns null safely", () => {
    const event: ToolResultEvent = {
      toolName: "read",
      content: undefined,
    };
    assert.equal(processToolResult(event, cfg), null);
  });
});

describe("processToolResult — write branch", () => {
  it("does not modify write tool results (pass-through)", () => {
    const event: ToolResultEvent = {
      toolName: "write",
      content: [{ type: "text", text: "Successfully wrote 45 bytes to src/index.ts" }],
    };
    assert.equal(processToolResult(event, cfg), null);
  });

  it("does not modify write tool errors", () => {
    const event: ToolResultEvent = {
      toolName: "write",
      isError: true,
      content: [{ type: "text", text: "oops" }],
    };
    assert.equal(processToolResult(event, cfg), null);
  });
});
