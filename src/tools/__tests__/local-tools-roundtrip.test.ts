import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { _resetEnabledSet, initEnabledSet } from "../../config/enabled-set.js";
import { parseBlackbytesConfig } from "../../config/schema.js";
import { computeCID } from "../../utils/cid.js";
import { registerGlobTool } from "../glob/index.js";
import { registerGrepTool } from "../grep/index.js";
import { registerHashlineEditTool } from "../hashline-edit/index.js";

interface ToolResultLike {
  readonly isError?: boolean;
  readonly content: Array<{ type: string; text: string }>;
}

interface RegisteredTool {
  readonly name: string;
  readonly execute: (_toolCallId: string, params: unknown) => Promise<ToolResultLike>;
}

function makeConfig() {
  const result = parseBlackbytesConfig({});
  if (!result.ok) throw new Error(result.errors.join(", "));
  return result.value;
}

function makeMockPi() {
  const registered: RegisteredTool[] = [];
  return {
    pi: {
      registerTool(definition: RegisteredTool) {
        registered.push(definition);
      },
    },
    registered,
  };
}

function textOf(result: ToolResultLike): string {
  return result.content.map((part) => part.text).join("");
}

describe("bundled local tools — round trip", () => {
  let tmpRoot: string;

  beforeEach(() => {
    _resetEnabledSet();
    initEnabledSet(makeConfig());
    tmpRoot = mkdtempSync(join(tmpdir(), "pi-bb-local-tools-"));
    mkdirSync(join(tmpRoot, "src"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    _resetEnabledSet();
  });

  it("registers and exercises glob, grep, and hashline_edit against a temp project", async () => {
    const targetFile = join(tmpRoot, "src", "sample.ts");
    const firstLine = 'export const token = "MAGIC_TOKEN";';
    writeFileSync(targetFile, `${firstLine}\nexport const other = 1;\n`, "utf8");
    writeFileSync(join(tmpRoot, "README.md"), "# fixture\n", "utf8");

    const { pi, registered } = makeMockPi();
    const extensionApi = pi as unknown as Parameters<typeof registerGlobTool>[0];
    registerGlobTool(extensionApi);
    registerGrepTool(extensionApi);
    registerHashlineEditTool(extensionApi);

    const tools = new Map(registered.map((tool) => [tool.name, tool]));
    assert.deepEqual([...tools.keys()].sort(), ["glob", "grep", "hashline_edit"]);

    const globResult = await tools.get("glob")!.execute("glob-call", {
      pattern: "**/*.ts",
      path: tmpRoot,
    });
    assert.equal(globResult.isError, undefined);
    assert.match(textOf(globResult), /sample\.ts/);

    const grepResult = await tools.get("grep")!.execute("grep-call", {
      pattern: "MAGIC_TOKEN",
      path: tmpRoot,
      output_mode: "files_with_matches",
    });
    assert.equal(grepResult.isError, undefined);
    assert.match(textOf(grepResult), /sample\.ts/);

    const lineRef = `1#${computeCID(1, firstLine)}`;
    const editResult = await tools.get("hashline_edit")!.execute("edit-call", {
      filePath: targetFile,
      edits: [{ op: "replace", pos: lineRef, lines: 'export const token = "UPDATED";' }],
    });
    assert.equal(editResult.isError, undefined);
    assert.match(textOf(editResult), /File updated/);
    assert.equal(
      readFileSync(targetFile, "utf8"),
      'export const token = "UPDATED";\nexport const other = 1;\n',
    );
  });
});
