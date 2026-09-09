import test from "node:test";
import assert from "node:assert/strict";
import { createSyntheticLockPolicy, syntheticLockPaths } from "./sdk-child-rehearsal-locks.mjs";
import { permissionArgs } from "./sdk-child-rehearsal-permission.mjs";
import { createPolicy, moduleHooks } from "./sdk-child-rehearsal-policy.mjs";

const hash = "a".repeat(64);
function fixture() {
  const files = ["/fixture/agent-a/auth.json", "/fixture/agent-a/settings.json", "/fixture/checkout/.pi/settings.json"];
  const nodes = new Map(["/", "/fixture", "/fixture/agent-a", "/fixture/checkout", "/fixture/checkout/.pi"].map((path) => [path, { dir: true }]));
  for (const file of files) nodes.set(file, { dir: false });
  let ino = 0;
  let closed = true;
  let digest = hash;
  const calls = [];
  const original = {
    lstat(path) {
      const node = nodes.get(path);
      if (!node) throw Object.assign(new Error("absent"), { code: "ENOENT" });
      return { dev: 1, ino: node.ino ?? 1, nlink: node.nlink ?? 1, isDirectory: () => node.dir, isFile: () => !node.dir, isSymbolicLink: () => !!node.link };
    },
    realpath: (path) => nodes.get(path)?.target ?? path,
    digest: () => digest,
    readdir: (path) => nodes.get(path)?.children ?? [],
    mkdir(path) { calls.push("mkdir"); nodes.set(path, { dir: true, ino: ++ino }); },
    mtime() { calls.push("mtime"); },
    stat(path) { calls.push("stat"); return original.lstat(path); },
    rmdir(path) { calls.push("rmdir"); nodes.delete(path); },
  };
  const config = { root: "/fixture", files, hashes: Object.fromEntries(files.map((file) => [file, hash])), ownedClosed: () => closed };
  return { files, nodes, calls, original, config, changeHash: () => { digest = "b".repeat(64); }, openOwnership: () => { closed = false; } };
}

test("exact empty owned synthetic locks support lifecycle, immutable hashes and cleanup proof", () => {
  const f = fixture();
  const p = createSyntheticLockPolicy(f.config, f.original);
  for (const path of p.paths) {
    p.perform("mkdir", path);
    assert.equal(p.perform("stat", path).isDirectory(), true);
    p.perform("mtime", path, [new Date(1000), 2]);
    p.perform("rmdir", path);
  }
  assert.deepEqual(p.proof(), { hashesUnchanged: true, locksAbsent: true, ownedClosed: true,
    counts: { mkdir: 3, mtime: 3, stat: 3, rmdir: 3, denied: 0 } });
});

test("credential writes, other locks, descendants and recursive or content operations never reach originals", () => {
  for (const [op, path, args] of [
    ["write", "/fixture/agent-a/auth.json"], ["write", "/fixture/agent-a/settings.json"],
    ["mkdir", "/fixture/agent-a/other.json.lock"], ["mkdir", "/real/auth.json.lock"],
    ["mkdir", "/fixture/agent-a/auth.json.lock/child"], ["mkdir", "/fixture/agent-a/auth.json.lock", [{ recursive: true }]],
    ["unlink", "/fixture/agent-a/auth.json.lock"], ["rename", "/fixture/agent-a/auth.json.lock"],
    ["mtime", "/fixture/agent-a/auth.json.lock", [NaN, 2]],
    ["mtime", "/fixture/agent-a/auth.json.lock", [new Date(NaN), 2]],
  ]) {
    const f = fixture(); const p = createSyntheticLockPolicy(f.config, f.original);
    assert.throws(() => p.perform(op, path, args));
    assert.equal(f.calls.length, 0); assert.equal(p.counts.denied, 1);
    assert.throws(() => p.proof());
  }
});

test("preexisting locks, symlinks, trapped realpaths and hard-linked synthetic data fail closed", () => {
  for (const mutate of [
    (f) => f.nodes.set(`${f.files[0]}.lock`, { dir: true }),
    (f) => { f.nodes.get("/fixture/agent-a").link = true; },
    (f) => { f.nodes.get("/fixture/agent-a").target = "/real"; },
    (f) => { f.nodes.get(f.files[0]).nlink = 2; },
  ]) {
    const f = fixture(); mutate(f);
    assert.throws(() => createSyntheticLockPolicy(f.config, f.original)); assert.equal(f.calls.length, 0);
  }
});

test("replaced lock, unexpected lock children, changed hashes or lost ownership stop release", () => {
  for (const mutate of [
    (f, path) => { f.nodes.get(path).ino = 999; },
    (f, path) => { f.nodes.get(path).children = ["unexpected"]; },
    (f, path) => { f.nodes.get(path).link = true; },
    (f, path) => { f.nodes.get(path).target = "/real/auth.json.lock"; },
    (f) => { f.nodes.get("/fixture").ino = 999; },
    (f) => f.changeHash(), (f) => f.openOwnership(),
  ]) {
    const f = fixture(); const p = createSyntheticLockPolicy(f.config, f.original); const path = p.paths[0];
    p.perform("mkdir", path); mutate(f, path);
    assert.throws(() => p.perform("rmdir", path)); assert.deepEqual(f.calls, ["mkdir"]);
    assert.equal(p.counts.denied, 1);
  }
});

test("permission profile adds only exact enumerated lock paths, never file or home write grants", () => {
  const f = fixture();
  const args = permissionArgs({ readPaths: f.files, receiptPaths: [], lockFixture: f.config });
  assert.deepEqual(args.filter((arg) => arg.startsWith("--allow-fs-write=")), f.files.map((file) => `--allow-fs-write=${file}.lock`));
  for (const file of ["/real/auth.json", "/fixture/agent-b/auth.json", "/fixture/agent-a/*", "/fixture/agent-a/../agent-a/auth.json"])
    assert.throws(() => syntheticLockPaths("/fixture", [file]));
  assert.throws(() => syntheticLockPaths("/fixture", [f.files[0], f.files[0]]));
});

test("general filesystem policy cannot bypass lifecycle or mutate settings", () => {
  const p = createPolicy({ cwd: "/fixture", root: "/fixture", readRoots: [], authFiles: ["/fixture/agent-a/auth.json"] }, { realpath: (path) => path, isSymlink: () => false });
  for (const path of ["/fixture/agent-a/auth.json", "/fixture/agent-a/settings.json", "/fixture/checkout/.pi/settings.json"])
    assert.throws(() => p.check(path, "write"));
  for (const op of ["read", "write", "metadata"]) for (const tail of ["", "/unexpected"])
    assert.throws(() => p.check(`/fixture/agent-a/settings.json.lock${tail}`, op));
});

test("unused sensitive inventory entries give no module authority and never trigger secret digest", () => {
  let reads = 0;
  const url = "file:///installed/auth.json";
  const hooks = moduleHooks({ files: [], builtins: [], deniedSensitiveFiles: [{ url, disposition: "DENY_IF_REQUESTED" }] }, { digest() { reads++; } });
  assert.throws(() => hooks.resolve("./auth.json", {}, () => ({ url })));
  assert.throws(() => hooks.load(url, {}, () => { throw new Error("must not reach"); }));
  assert.equal(reads, 0);
});

test("swallowed original filesystem errors retain a permanent denial and cannot certify cleanup", () => {
  const f = fixture(); const p = createSyntheticLockPolicy(f.config, f.original);
  const path = p.paths[0];
  f.original.mkdir = () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); };
  try { p.perform("mkdir", path); } catch {}
  assert.equal(p.counts.denied, 1);
  assert.throws(() => p.perform("mkdir", path));
  assert.throws(() => p.proof());
  assert.equal(f.calls.length, 0);
});
