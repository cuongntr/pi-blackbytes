import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SUB_AGENTS } from "../../config/resource-metadata.js";
import { declarationToMeta } from "../declaration.js";
import { exploreDeclaration } from "../explore.js";
import { generalDeclaration } from "../general.js";
import { librarianDeclaration } from "../librarian.js";
import { oracleDeclaration } from "../oracle.js";

const BUILTIN_DECLARATIONS = [
  exploreDeclaration,
  oracleDeclaration,
  librarianDeclaration,
  generalDeclaration,
];

describe("builtin sub-agent metadata consistency", () => {
  for (const decl of BUILTIN_DECLARATIONS) {
    it(`declarationToMeta matches SUB_AGENTS entry for "${decl.name}"`, () => {
      const meta = declarationToMeta(decl);
      const entry = SUB_AGENTS.find((a) => a.name === decl.name);
      assert.ok(entry, `SUB_AGENTS has no entry for "${decl.name}"`);
      assert.deepEqual(meta, entry);
    });
  }
});
