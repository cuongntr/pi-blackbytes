import test from "node:test";
import assert from "node:assert/strict";
import { permissionArgs } from "./sdk-child-rehearsal-permission.mjs";
test("SDK provider permission profile grants exact reviewed paths and denies nested execution", () => {
  const args = permissionArgs({ readPaths: ["/candidate/child.mjs", "/installed/sdk", "/fixture/agent-a"], receiptPaths: ["/receipts/counters.json"] });
  assert.deepEqual(args, ["--permission", "--allow-fs-read=/candidate/child.mjs", "--allow-fs-read=/installed/sdk", "--allow-fs-read=/fixture/agent-a", "--allow-fs-write=/receipts/counters.json"]);
  for (const flag of ["--allow-child-process", "--allow-worker", "--allow-addons", "--allow-wasi", "--allow-inspector"]) assert.ok(!args.includes(flag));
  assert.ok(permissionArgs({ readPaths: ["/candidate"], receiptPaths: [], profile: "launcher-parent" }).includes("--allow-child-process"));
});
test("permission policy rejects wildcard, relative and malformed grants", () => {
  for (const path of ["relative", "/fixture/*", "/fixture\0suffix", "/fixture\n"]) assert.throws(() => permissionArgs({ readPaths: [path], receiptPaths: [] }));
  for (const profile of ["lifecycle", "unknown"]) assert.throws(() => permissionArgs({ readPaths: ["/candidate"], receiptPaths: [], profile }));
});
