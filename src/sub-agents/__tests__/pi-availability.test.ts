import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  _resetPiAvailability,
  checkPiAvailability,
  getCachedPiAvailability,
} from "../pi-availability.js";

afterEach(() => {
  _resetPiAvailability();
});

describe("checkPiAvailability", () => {
  it("returns 'available' when probe succeeds", async () => {
    const mockProbe = async () => ({ available: true });
    const result = await checkPiAvailability(mockProbe);
    assert.equal(result.status, "available");
    assert.equal(result.hint, undefined);
  });

  it("returns 'unavailable' with redacted hint when probe fails", async () => {
    const mockProbe = async () => ({ available: false, error: "API_KEY=secret123 not found" });
    const result = await checkPiAvailability(mockProbe);
    assert.equal(result.status, "unavailable");
    assert.ok(result.hint);
    assert.ok(result.hint.includes("[REDACTED]"));
    assert.ok(!result.hint.includes("secret123"));
  });

  it("caches result on subsequent calls", async () => {
    let probeCount = 0;
    const mockProbe = async () => {
      probeCount++;
      return { available: true };
    };

    await checkPiAvailability(mockProbe);
    await checkPiAvailability(mockProbe);
    await checkPiAvailability(mockProbe);

    assert.equal(probeCount, 1, "probe should only run once");
  });

  it("shares one in-flight probe across concurrent calls", async () => {
    let probeCount = 0;
    let release!: () => void;
    const waitForRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mockProbe = async () => {
      probeCount++;
      await waitForRelease;
      return { available: true };
    };

    const first = checkPiAvailability(mockProbe);
    const second = checkPiAvailability(mockProbe);
    await Promise.resolve();

    assert.equal(probeCount, 1, "concurrent callers should share the same probe");
    release();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(firstResult.status, "available");
    assert.equal(secondResult.status, "available");
  });

  it("handles probe errors gracefully", async () => {
    const mockProbe = async () => {
      throw new Error("spawn pi ENOENT");
    };
    const result = await checkPiAvailability(mockProbe);
    assert.equal(result.status, "unavailable");
    assert.ok(result.hint);
    assert.ok(result.hint.includes("ENOENT"));
  });
});

describe("getCachedPiAvailability", () => {
  it("returns 'unknown' when no probe has run", () => {
    const result = getCachedPiAvailability();
    assert.equal(result.status, "unknown");
  });

  it("returns cached result after probe", async () => {
    const mockProbe = async () => ({ available: true });
    await checkPiAvailability(mockProbe);

    const cached = getCachedPiAvailability();
    assert.equal(cached.status, "available");
  });
});
