import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  SPINNER_FRAMES,
  SPINNER_TICK_MS,
  formatCost,
  formatDuration,
  getSpinnerFrame,
  truncatePath,
} from "../format.js";

describe("formatDuration", () => {
  it("returns 0ms for non-finite or negative input", () => {
    assert.equal(formatDuration(Number.NaN), "0ms");
    assert.equal(formatDuration(-5), "0ms");
    assert.equal(formatDuration(Number.POSITIVE_INFINITY), "0ms");
  });

  it("returns <1ms for sub-millisecond durations", () => {
    assert.equal(formatDuration(0), "<1ms");
    assert.equal(formatDuration(0.4), "<1ms");
  });

  it("returns rounded ms for sub-second durations", () => {
    assert.equal(formatDuration(1), "1ms");
    assert.equal(formatDuration(47), "47ms");
    assert.equal(formatDuration(200), "200ms");
    assert.equal(formatDuration(999), "999ms");
  });

  it("returns one-decimal seconds for sub-minute durations", () => {
    assert.equal(formatDuration(1_000), "1.0s");
    assert.equal(formatDuration(3_200), "3.2s");
    assert.equal(formatDuration(59_900), "59.9s");
  });

  it("returns m+s for sub-hour durations", () => {
    assert.equal(formatDuration(60_000), "1m 0s");
    assert.equal(formatDuration(127_000), "2m 7s");
    assert.equal(formatDuration(3_599_000), "59m 59s");
  });

  it("buckets sub-second values that round to 1000ms into the seconds branch", () => {
    // Regression: 999.6 was rendering as "1000ms" because rounding spilled
    // past the bucket boundary before the next check ran.
    assert.equal(formatDuration(999.6), "1.0s");
    assert.equal(formatDuration(999.5), "1.0s");
    assert.equal(formatDuration(999.4), "999ms");
  });

  it("returns h+m for >= 1 hour durations", () => {
    assert.equal(formatDuration(3_600_000), "1h 0m");
    assert.equal(formatDuration(4_320_000), "1h 12m");
    assert.equal(formatDuration(25 * 3_600_000), "25h 0m");
  });
});

describe("getSpinnerFrame", () => {
  it("returns a valid frame for any timestamp", () => {
    for (let i = 0; i < 1000; i++) {
      const frame = getSpinnerFrame(i * 7); // arbitrary multiplier
      assert.ok(SPINNER_FRAMES.includes(frame as (typeof SPINNER_FRAMES)[number]));
    }
  });

  it("cycles through all frames within SPINNER_FRAMES.length * SPINNER_TICK_MS", () => {
    const seen = new Set<string>();
    for (let i = 0; i < SPINNER_FRAMES.length; i++) {
      seen.add(getSpinnerFrame(i * SPINNER_TICK_MS));
    }
    assert.equal(seen.size, SPINNER_FRAMES.length, "every frame should appear once");
  });

  it("returns the same frame for timestamps within the same tick window", () => {
    const t = 12_345 * SPINNER_TICK_MS;
    assert.equal(getSpinnerFrame(t), getSpinnerFrame(t + 1));
    assert.equal(getSpinnerFrame(t), getSpinnerFrame(t + SPINNER_TICK_MS - 1));
  });

  it("advances frame when crossing a tick boundary", () => {
    const t = 0;
    assert.notEqual(getSpinnerFrame(t), getSpinnerFrame(t + SPINNER_TICK_MS));
  });
  it("tolerates negative inputs without returning undefined", () => {
    // Regression: JS `%` on a negative numerator yields negative, and
    // SPINNER_FRAMES[-N] is undefined. The guard clamps now ≥ 0 so we always
    // return a real frame.
    for (let i = -10; i <= 0; i++) {
      const frame = getSpinnerFrame(i);
      assert.ok(
        SPINNER_FRAMES.includes(frame as (typeof SPINNER_FRAMES)[number]),
        `expected real frame for now=${i}, got ${frame}`,
      );
    }
  });
});

describe("truncatePath", () => {
  it("returns unchanged when within budget", () => {
    assert.equal(truncatePath("src/index.ts", 50), "src/index.ts");
    assert.equal(truncatePath("a.ts", 4), "a.ts");
  });

  it("keeps the filename and as many parents as fit", () => {
    // budget 22 — "…/sub-agents/render.ts" is 21 chars, fits.
    assert.equal(
      truncatePath("/Users/x/Work/proj/src/sub-agents/render.ts", 22),
      "…/sub-agents/render.ts",
    );
  });

  it("falls back to fewer parents when needed", () => {
    // budget 15 — "…/dir/render.ts" is exactly 15 chars, fits.
    assert.equal(truncatePath("/very/deep/nested/dir/render.ts", 15), "…/dir/render.ts");
    // budget 11 — only "…/render.ts" (11) fits.
    assert.equal(truncatePath("/very/deep/nested/dir/render.ts", 11), "…/render.ts");
  });

  it("truncates basename from the left when even basename overflows", () => {
    // budget 8 — basename `verylongfilename.ts` is 19 chars, must shrink.
    // Tail-preserve: keep last 7 chars + `…` prefix.
    const out = truncatePath("/a/b/verylongfilename.ts", 8);
    assert.equal(out.length, 8);
    assert.ok(out.startsWith("…"));
    assert.ok(out.endsWith(".ts"), "extension should remain visible");
  });

  it("handles paths without leading slash", () => {
    assert.equal(truncatePath("src/sub-agents/render.ts", 11), "…/render.ts");
  });

  it("handles single-segment paths (just filename)", () => {
    const out = truncatePath("averylongbasename.ts", 10);
    assert.equal(out.length, 10);
    assert.ok(out.startsWith("…"));
  });

  it("degrades gracefully for tiny budgets", () => {
    // max < 2 — just slice the tail. No ellipsis fits.
    assert.equal(truncatePath("src/file.ts", 1), "s");
    assert.equal(truncatePath("src/file.ts", 0), "");
  });
});

describe("formatCost", () => {
  it("returns $0 for zero, negative, or non-finite", () => {
    assert.equal(formatCost(0), "$0");
    assert.equal(formatCost(-1), "$0");
    assert.equal(formatCost(Number.NaN), "$0");
  });

  it("uses <$0.001 for rounds-to-zero values", () => {
    assert.equal(formatCost(0.0001), "<$0.001");
    assert.equal(formatCost(0.0009), "<$0.001");
  });

  it("uses 3 decimal places for sub-dollar values", () => {
    assert.equal(formatCost(0.001), "$0.001");
    assert.equal(formatCost(0.004), "$0.004");
    assert.equal(formatCost(0.42), "$0.420");
    assert.equal(formatCost(0.999), "$0.999");
  });

  it("uses 2 decimal places for dollar values under $100", () => {
    assert.equal(formatCost(1), "$1.00");
    assert.equal(formatCost(1.234), "$1.23");
    assert.equal(formatCost(42.05), "$42.05");
    assert.equal(formatCost(99.99), "$99.99");
  });

  it("drops decimals for >= $100", () => {
    assert.equal(formatCost(100), "$100");
    assert.equal(formatCost(1234.56), "$1235");
  });

  it("buckets boundary values into the next tier instead of rolling over the display", () => {
    // Regression: 99.999 was rendering as "$100.00" because .toFixed(2)
    // rounded up past the tier boundary. Similar for 0.9999 → "$1.000".
    assert.equal(formatCost(99.999), "$100");
    assert.equal(formatCost(99.995), "$100");
    assert.equal(formatCost(99.994), "$99.99");
    assert.equal(formatCost(0.9999), "$1.00");
    assert.equal(formatCost(0.9995), "$1.00");
    assert.equal(formatCost(0.9994), "$0.999");
  });
});
