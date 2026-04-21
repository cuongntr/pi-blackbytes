import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ALL_TOOL_NAMES } from "../../config/resource-metadata.js";
import {
  DELEGABLE_TOOL_NAMES,
  PI_DEFAULT_TOOLS,
  isDelegableTool,
  resolveToolStrategy,
  validateBuiltinToolNames,
  validateToolNames,
} from "../delegable-tools.js";

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

describe("DELEGABLE_TOOL_NAMES", () => {
  it("contains all extension-managed tools", () => {
    for (const name of ALL_TOOL_NAMES) {
      assert.ok(DELEGABLE_TOOL_NAMES.has(name), `missing extension tool: ${name}`);
    }
  });

  it("contains all Pi default tools", () => {
    for (const name of PI_DEFAULT_TOOLS) {
      assert.ok(DELEGABLE_TOOL_NAMES.has(name), `missing Pi default: ${name}`);
    }
  });

  it("does not contain delegate_* tools", () => {
    for (const name of DELEGABLE_TOOL_NAMES) {
      assert.ok(!name.startsWith("delegate_"), `delegate tool leaked: ${name}`);
    }
  });
});

describe("isDelegableTool", () => {
  it("returns true for extension tools", () => {
    assert.equal(isDelegableTool("grep"), true);
    assert.equal(isDelegableTool("ast_search"), true);
  });

  it("returns true for Pi defaults", () => {
    assert.equal(isDelegableTool("read"), true);
  });

  it("returns false for unknown tools", () => {
    assert.equal(isDelegableTool("nonexistent_tool"), false);
    assert.equal(isDelegableTool("delegate_explore"), false);
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("validateToolNames", () => {
  it("partitions known and unknown names", () => {
    const result = validateToolNames(["read", "grep", "fake_tool"]);
    assert.deepEqual(result.valid, ["read", "grep"]);
    assert.deepEqual(result.unknown, ["fake_tool"]);
  });

  it("rejects delegate_* as unknown", () => {
    const result = validateToolNames(["read", "delegate_explore"]);
    assert.deepEqual(result.valid, ["read"]);
    assert.deepEqual(result.unknown, ["delegate_explore"]);
  });

  it("returns all valid for a clean list", () => {
    const result = validateToolNames(["read", "grep", "glob"]);
    assert.deepEqual(result.valid, ["read", "grep", "glob"]);
    assert.deepEqual(result.unknown, []);
  });

  it("handles empty input", () => {
    const result = validateToolNames([]);
    assert.deepEqual(result.valid, []);
    assert.deepEqual(result.unknown, []);
  });
});

describe("validateBuiltinToolNames", () => {
  it("returns valid names for a clean list", () => {
    const result = validateBuiltinToolNames(["read", "grep", "glob", "ast_search"]);
    assert.deepEqual(result, ["read", "grep", "glob", "ast_search"]);
  });

  it("throws on unknown names", () => {
    assert.throws(
      () => validateBuiltinToolNames(["read", "nonexistent"]),
      /Unknown tool names in builtin allowlist: nonexistent/,
    );
  });

  it("throws on delegate_* names", () => {
    assert.throws(
      () => validateBuiltinToolNames(["read", "delegate_oracle"]),
      /Unknown tool names in builtin allowlist: delegate_oracle/,
    );
  });
});

// ---------------------------------------------------------------------------
// Resolution strategies
// ---------------------------------------------------------------------------

describe("resolveToolStrategy", () => {
  const enabledTools = new Set(["grep", "glob", "ast_search", "web_search"]);

  describe("allowlist", () => {
    it("returns the explicit list unchanged", () => {
      const result = resolveToolStrategy(
        { kind: "allowlist", tools: ["read", "grep", "glob"] },
        enabledTools,
      );
      assert.deepEqual(result, ["read", "grep", "glob"]);
    });

    it("returns empty for empty allowlist", () => {
      const result = resolveToolStrategy({ kind: "allowlist", tools: [] }, enabledTools);
      assert.deepEqual(result, []);
    });
  });

  describe("denylist", () => {
    it("returns enabled + Pi defaults minus denied tools", () => {
      const result = resolveToolStrategy({ kind: "denylist", tools: ["web_search"] }, enabledTools);
      assert.ok(result.includes("grep"));
      assert.ok(result.includes("read")); // Pi default included
      assert.ok(!result.includes("web_search")); // denied
    });

    it("excludes delegate_* even if in enabledTools", () => {
      const withDelegate = new Set([...enabledTools, "delegate_explore"]);
      const result = resolveToolStrategy({ kind: "denylist", tools: [] }, withDelegate);
      assert.ok(!result.includes("delegate_explore"));
    });

    it("returns all non-denied for empty denylist", () => {
      const result = resolveToolStrategy({ kind: "denylist", tools: [] }, enabledTools);
      // Should include all enabled tools + Pi defaults
      for (const t of enabledTools) {
        assert.ok(result.includes(t), `missing enabled tool: ${t}`);
      }
      for (const t of PI_DEFAULT_TOOLS) {
        assert.ok(result.includes(t), `missing Pi default: ${t}`);
      }
    });
  });

  describe("all-except-delegates", () => {
    it("returns enabled tools minus delegate_*", () => {
      const withDelegate = new Set([...enabledTools, "delegate_explore", "delegate_general"]);
      const result = resolveToolStrategy({ kind: "all-except-delegates" }, withDelegate);
      assert.ok(result.includes("grep"));
      assert.ok(result.includes("glob"));
      assert.ok(!result.includes("delegate_explore"));
      assert.ok(!result.includes("delegate_general"));
    });

    it("does not include Pi defaults", () => {
      const result = resolveToolStrategy({ kind: "all-except-delegates" }, enabledTools);
      assert.ok(!result.includes("read")); // Pi default NOT included
      assert.ok(result.includes("grep")); // extension tool included
    });

    it("returns all enabled when no delegates present", () => {
      const result = resolveToolStrategy({ kind: "all-except-delegates" }, enabledTools);
      assert.deepEqual([...result].sort(), [...enabledTools].sort());
    });
  });
});
