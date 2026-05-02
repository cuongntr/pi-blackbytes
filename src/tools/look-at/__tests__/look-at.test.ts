import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { executeLookAt } from "../tool.js";

let workDir: string;

// 1x1 transparent PNG (smallest valid PNG)
const PNG_1x1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "look-at-test-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("look_at tool", () => {
  it("rejects empty objective", async () => {
    const result = await executeLookAt({ path: "x.png", objective: "" });
    assert.match((result.content[0] as { text: string }).text, /requires both/);
    assert.equal((result.details as { summary: string }).summary, "missing args");
  });

  it("returns text + image content for a valid PNG", async () => {
    const file = join(workDir, "tiny.png");
    await writeFile(file, Buffer.from(PNG_1x1_BASE64, "base64"));
    const result = await executeLookAt({ path: file, objective: "describe the pixel" });
    assert.equal(result.content.length, 2);
    assert.equal(result.content[0].type, "text");
    assert.match((result.content[0] as { text: string }).text, /describe the pixel/);
    assert.equal(result.content[1].type, "image");
    const img = result.content[1] as { mimeType: string; data: string };
    assert.equal(img.mimeType, "image/png");
    assert.equal(typeof img.data, "string");
    assert.ok(img.data.length > 0);
  });

  it("rejects unsupported file extensions", async () => {
    const file = join(workDir, "foo.txt");
    await writeFile(file, "hello");
    const result = await executeLookAt({ path: file, objective: "x" });
    assert.match((result.content[0] as { text: string }).text, /unsupported image type/);
  });

  it("loads reference images alongside the primary", async () => {
    const primary = join(workDir, "p.png");
    const ref = join(workDir, "r.png");
    await writeFile(primary, Buffer.from(PNG_1x1_BASE64, "base64"));
    await writeFile(ref, Buffer.from(PNG_1x1_BASE64, "base64"));
    const result = await executeLookAt({
      path: primary,
      objective: "compare",
      referenceFiles: [ref],
    });
    // 1 text + 1 primary + 1 reference = 3 blocks
    assert.equal(result.content.length, 3);
    assert.equal(result.content[2].type, "image");
  });

  it("reports load errors for missing primary and continues without crash", async () => {
    const result = await executeLookAt({
      path: join(workDir, "missing.png"),
      objective: "x",
    });
    assert.match((result.content[0] as { text: string }).text, /Error loading primary image/);
  });
});
