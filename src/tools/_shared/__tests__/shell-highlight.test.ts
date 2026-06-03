import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { highlightShellLine, tokenizeShellLine } from "../shell-highlight.js";

function theme(): any {
  return { fg: (token: string, text: string) => `«${token}:${text}»` };
}

describe("shell-highlight", () => {
  it("tokenizes while preserving whitespace", () => {
    assert.deepEqual(tokenizeShellLine("bun  run"), ["bun", " ", " ", "run"]);
  });

  it("styles commands flags paths vars operators and comments", () => {
    const out = highlightShellLine(
      "FOO=1 bun run test -- --grep x ./src && echo $HOME # ok",
      theme(),
    );
    assert.match(out, /syntaxVariable:FOO=1/);
    assert.match(out, /syntaxFunction:bun/);
    assert.match(out, /syntaxKeyword:--grep/);
    assert.match(out, /syntaxVariable:.\/src/);
    assert.match(out, /syntaxOperator:&&/);
    assert.match(out, /syntaxVariable:\$HOME/);
    assert.match(out, /syntaxComment:# ok/);
  });

  it("falls back on unterminated quotes", () => {
    assert.equal(highlightShellLine("echo 'nope", theme()), "echo 'nope");
  });
});
