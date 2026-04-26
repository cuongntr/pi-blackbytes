import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SUB_AGENT_RUNTIME_OVERLAY_FOOTER,
  SUB_AGENT_RUNTIME_OVERLAY_HEADER,
  SUB_AGENT_RUNTIME_OVERLAY_MAX_CHARS,
  buildSubAgentRuntimeOverlay,
} from "../runtime-overlay.js";

describe("buildSubAgentRuntimeOverlay", () => {
  const fixedNow = new Date("2026-04-26T00:00:00Z");

  it("renders header, footer, current date and finalized tools", () => {
    const out = buildSubAgentRuntimeOverlay({
      agentName: "librarian",
      cwd: "/repo/foo",
      finalizedTools: ["read", "grep", "web_search"],
      now: fixedNow,
    });

    assert.ok(out.includes(SUB_AGENT_RUNTIME_OVERLAY_HEADER));
    assert.match(out, /`librarian`/);
    assert.match(out, /2026-04-26/);
    assert.match(out, /Current year is \*\*2026\*\*/);
    assert.match(out, /Working directory: `\/repo\/foo`/);
    // Tools rendered alphabetically with backticks.
    assert.match(out, /`grep`, `read`, `web_search`/);
    assert.ok(out.endsWith(SUB_AGENT_RUNTIME_OVERLAY_FOOTER));
  });

  it("falls back to (host process cwd) when cwd is omitted", () => {
    const out = buildSubAgentRuntimeOverlay({
      agentName: "explore",
      finalizedTools: ["read"],
      now: fixedNow,
    });
    assert.match(out, /\(host process cwd\)/);
  });

  it("renders _(none)_ when finalized tool list is empty", () => {
    const out = buildSubAgentRuntimeOverlay({
      agentName: "oracle",
      finalizedTools: [],
      now: fixedNow,
    });
    assert.match(out, /Final tool allowlist: _\(none\)_/);
  });

  it("includes optional agent-specific sections in order", () => {
    const out = buildSubAgentRuntimeOverlay({
      agentName: "librarian",
      finalizedTools: ["read"],
      now: fixedNow,
      sections: [
        { heading: "### Citation Policy", body: "Use permalinks." },
        { heading: "### Failure Recovery", body: "Fall back to web search." },
      ],
    });
    const cite = out.indexOf("### Citation Policy");
    const fail = out.indexOf("### Failure Recovery");
    assert.ok(cite > 0 && fail > 0 && cite < fail);
    assert.match(out, /Use permalinks\./);
    assert.match(out, /Fall back to web search\./);
  });

  it("redacts obvious secrets in caller-provided section bodies", () => {
    const out = buildSubAgentRuntimeOverlay({
      agentName: "librarian",
      finalizedTools: ["read"],
      now: fixedNow,
      sections: [
        {
          heading: "### Notes",
          body: "OPENAI_API_KEY=sk-secret-token-xyz and Authorization: Bearer abc.def.ghi",
        },
      ],
    });
    assert.match(out, /\[REDACTED\]/);
    assert.doesNotMatch(out, /sk-secret-token-xyz/);
  });

  it("does not mention sub-agent delegation in the overlay", () => {
    const out = buildSubAgentRuntimeOverlay({
      agentName: "explore",
      finalizedTools: ["read"],
      now: fixedNow,
    });
    assert.doesNotMatch(out, /delegate_/);
    assert.doesNotMatch(out, /sub-agent.*spawn/i);
  });

  it("respects the hard cap on rendered length", () => {
    const huge = "x".repeat(SUB_AGENT_RUNTIME_OVERLAY_MAX_CHARS * 2);
    const out = buildSubAgentRuntimeOverlay({
      agentName: "general",
      finalizedTools: ["read"],
      now: fixedNow,
      sections: [{ heading: "### Notes", body: huge }],
    });
    assert.ok(
      out.length <= SUB_AGENT_RUNTIME_OVERLAY_MAX_CHARS,
      `overlay exceeded cap: ${out.length} > ${SUB_AGENT_RUNTIME_OVERLAY_MAX_CHARS}`,
    );
    assert.match(out, /overlay truncated/);
    assert.ok(out.endsWith(SUB_AGENT_RUNTIME_OVERLAY_FOOTER));
  });

  it("uses today's date when `now` is not provided", () => {
    const out = buildSubAgentRuntimeOverlay({
      agentName: "librarian",
      finalizedTools: ["read"],
    });
    const todayIso = new Date().toISOString().slice(0, 10);
    const todayYear = new Date().getUTCFullYear();
    assert.match(out, new RegExp(todayIso));
    assert.match(out, new RegExp(`Current year is \\*\\*${todayYear}\\*\\*`));
  });
});
