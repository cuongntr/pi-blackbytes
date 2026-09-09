import test from "node:test";
import assert from "node:assert/strict";
import { constants } from "node:fs";
import { pathToFileURL } from "node:url";
import { createPolicy, openMode, moduleHooks, modelRuntimePolicy, instrumentModelRuntimePrototype } from "./sdk-child-rehearsal-policy.mjs";
import { instrumentFs } from "./sdk-child-rehearsal-fs.mjs";
import { MATRIX, requireRunnable, LIMITS } from "./sdk-child-rehearsal-matrix.mjs";
import { registerReviewedModuleHooks } from "./sdk-child-rehearsal-hooks.mjs";
import { sameRuntimeManifest } from "./sdk-child-rehearsal-inventory.mjs";
function fixture() {
  const paths = new Map(["/", "/fixture", "/fixture/agent-a", "/fixture/agent-a/auth.json", "/fixture/agent-a/trust.json", "/fixture/data", "/fixture/agent-b", "/runtime", "/runtime/code.js", "/outside"].map((path) => [path, path]));
  paths.set("/fixture/escape", "/outside");
  const original = {
    realpath(path) {
      if (paths.has(path)) return paths.get(path);
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    isSymlink: (path) => path === "/fixture/dangling",
  };
  return createPolicy({ cwd: "/fixture", root: "/fixture", readRoots: ["/runtime"], authFiles: ["/fixture/agent-a/auth.json"] }, original);
}
test("paths, URLs, Buffers and missing ancestors are canonical; symlink escape is refused", () => {
  const p = fixture();
  for (const value of ["data", Buffer.from("/fixture/data"), new URL("file:///fixture/data")]) assert.equal(p.check(value, "read"), "/fixture/data");
  assert.equal(p.check("new/deep/file", "write"), "/fixture/new/deep/file");
  for (const path of ["escape/file", "dangling/file", "/fixture-other/file", "/outside", "agent-b/settings.json", "data\0suffix"]) assert.throws(() => p.check(path, "read"));
  assert.throws(() => p.check(new URL("https://invalid.example"), "read"));
  assert.throws(() => p.check(Buffer.from([0xff]), "read"));
  assert.throws(() => p.check({}, "read"));
});
test("resolution metadata does not grant runtime writes or ancestor contents", () => {
  const p = fixture();
  assert.equal(p.check("/runtime/code.js", "read"), "/runtime/code.js");
  assert.equal(p.check("/", "metadata"), "/");
  assert.throws(() => p.check("/", "read"));
  assert.throws(() => p.check("/runtime/code.js", "write"));
});
test("flags include truncation, append, rdwr and defaults", () => {
  assert.deepEqual(openMode(), { read: true, write: false });
  for (const flag of ["r+", "w", "wx", "a", "as+", constants.O_TRUNC, constants.O_APPEND, constants.O_RDWR, constants.O_CREAT]) assert.equal(openMode(flag).write, true);
  assert.deepEqual(openMode(constants.O_WRONLY), { read: false, write: true });
  for (const flags of ["invalid", -1, NaN, null, 2 ** 32, constants.O_RDWR | constants.O_WRONLY]) assert.throws(() => openMode(flags));
});
test("standard descriptors have operation-specific authority", () => {
  const p = fixture();
  p.check(0, "read");
  for (const fd of [1, 2, 3]) { p.check(fd, "write"); p.check(fd, "close"); assert.throws(() => p.check(fd, "read")); }
  assert.throws(() => p.check(0, "write"));
  assert.throws(() => p.check(9, "write"));
});
test("tracked descriptors and FileHandles retain mode, canonical and credential checks", () => {
  const p = fixture();
  p.opened("/runtime/code.js", "r", 9);
  p.check(9, "read");
  assert.throws(() => p.check(9, "write"));
  p.closed(9);
  assert.throws(() => p.check(9, "read"));
  const h = { fd: 10 };
  p.opened("agent-a/auth.json", "r", h);
  p.check(h, "read");
  assert.throws(() => p.check(h, "write"));
  assert.equal(p.counts.syntheticAuthReads, 2);
  p.closed(h);
  assert.throws(() => p.check(h, "read"));
  assert.throws(() => p.opened("agent-a/auth.json", "r+", 11));
});
test("two-path operations distinguish copy and rename; link aliases refuse", () => {
  const p = fixture();
  p.twoPath("copy", "/runtime/code.js", "/fixture/copy");
  assert.throws(() => p.twoPath("copy", "/fixture/data", "/runtime/new"));
  assert.throws(() => p.twoPath("rename", "/runtime/code.js", "/fixture/new"));
  assert.throws(() => p.twoPath("symlink", "/runtime/code.js", "/fixture/new"));
  assert.throws(() => p.twoPath("link", "/fixture/data", "/fixture/new"));
});
test("synthetic auth reads only; credential/trust/session writes and command/network refuse", () => {
  const p = fixture();
  p.check("agent-a/auth.json", "read");
  for (const path of ["agent-a/auth.json", "agent-a/trust.json", "agent-a/sessions/new", ".npmrc", ".netrc", "credentials.json"]) assert.throws(() => p.check(path, "write"));
  assert.throws(() => p.check("/runtime/auth.json", "read"));
  assert.throws(() => p.network()); assert.throws(() => p.command());
  assert.equal(p.counts.network, 1); assert.equal(p.counts.command, 1);
});
test("fake sync/callback/promise opens and handles: refused paths never reach originals", async () => {
  const p = fixture(); let calls = 0;
  const fs = {
    openSync() { calls++; return 7; }, readSync() { calls++; }, writeSync() { calls++; }, closeSync() { calls++; },
    open(_path, _flags, cb) { calls++; cb(null, 8); },
    copyFileSync() { calls++; }, createReadStream() { calls++; },
  };
  const handle = { fd: 10, async readFile() { calls++; return "synthetic"; }, async writeFile() { calls++; }, async close() { calls++; } };
  const fsp = { async open() { calls++; return handle; } };
  instrumentFs(fs, fsp, p);
  assert.throws(() => fs.openSync("/outside", "w")); assert.equal(calls, 0);
  const fd = fs.openSync("data", "r"); fs.readSync(fd);
  assert.throws(() => fs.writeSync(fd));
  fs.closeSync(fd); assert.throws(() => fs.readSync(fd));
  await new Promise((resolve, reject) => fs.open("data", "r", (err, fd) => { if (err) reject(err); else { assert.equal(fd, 8); resolve(); } }));
  const h = await fsp.open("data", "r"); assert.equal(await h.readFile(), "synthetic");
  assert.throws(() => h.writeFile("x")); await h.close(); assert.throws(() => h.readFile());
  const before = calls; assert.throws(() => fs.copyFileSync("data", "/runtime/new")); assert.throws(() => fs.createReadStream("data")); assert.equal(calls, before);
});
test("synchronous resolved URL allowlist verifies hash before resolve/load returns", () => {
  let loads = 0; let hash = "reviewed";
  const hooks = moduleHooks({ files: [{ url: "file:///runtime/code.js", sha256: "reviewed" }], builtins: ["node:fs"] }, { realpath: (path) => path, fileURL: (path) => pathToFileURL(path).href, digest: () => hash });
  const load = () => { loads++; return {}; };
  hooks.resolve("public-package", {}, () => ({ url: "file:///runtime/code.js" }));
  hooks.load("file:///runtime/code.js", {}, load); assert.equal(loads, 1);
  for (const url of ["file:///runtime/absent.js", "data:text/javascript,0", "https://invalid.example", "node:unknown"]) assert.throws(() => hooks.load(url, {}, load));
  hash = "changed"; assert.throws(() => hooks.load("file:///runtime/code.js", {}, load)); assert.equal(loads, 1);
});
test("model counters distinguish factory offline refresh and prohibited admission/auth probes", () => {
  const p = modelRuntimePolicy(); p.call("refresh", [{ allowNetwork: false }]); p.call("getModels");
  assert.throws(() => p.call("getAuth")); assert.throws(() => p.call("checkAuth"));
  p.admission(); p.call("getModel"); p.call("getAvailableSnapshot"); p.call("hasConfiguredAuth");
  for (const method of ["refresh", "getAuth", "checkAuth", "unknown"]) assert.throws(() => p.call(method));
  assert.equal(p.counts.factory.refresh, 1); assert.equal(p.counts.admission.refresh, 1);
});
test("public synchronous hook registration uses injected register without loading modules", () => {
  let registered = false;
  const result = registerReviewedModuleHooks({ files: [], builtins: [] }, {}, (hooks) => {
    registered = true; assert.equal(typeof hooks.resolve, "function"); assert.equal(typeof hooks.load, "function"); return "fake-registration";
  });
  assert.equal(registered, true); assert.equal(result, "fake-registration");
});
test("before/after runtime equality never blesses a gapped closure", () => {
  assert.equal(sameRuntimeManifest({ sha256: "a", gaps: [] }, { sha256: "a", gaps: [] }), true);
  assert.equal(sameRuntimeManifest({ sha256: "a", gaps: [] }, { sha256: "b", gaps: [] }), false);
  assert.equal(sameRuntimeManifest({ sha256: "a", gaps: ["missing"] }, { sha256: "a", gaps: ["missing"] }), false);
});
test("matrix is deeply immutable, every uncovered variant blocks and budgets cannot expand", () => {
  assert.equal(MATRIX.length, 20);
  for (const cell of MATRIX) for (const variant of cell.variants) {
    assert.equal(variant.execution, "NOT RUN"); assert.ok(variant.gap);
    assert.throws(() => requireRunnable(cell.cell, variant.variant));
    assert.throws(() => { variant.runnable = true; });
  }
  assert.deepEqual([LIMITS.executeMs, LIMITS.drainMs, LIMITS.versionSuiteMs], [10000, 5000, 1200000]);
});

test("request auth permits only captured literal object and no credential overrides", () => {
  const model = { provider: "fixture-selected", id: "literal/slash:high" };
  const p = modelRuntimePolicy();
  assert.throws(() => p.call("refresh"));
  assert.throws(() => p.call("refresh", [{ allowNetwork: true }]));
  p.admission(model);
  assert.throws(() => p.call("getAuth", [model]));
  assert.throws(() => p.request({ ...model }));
  p.request(model);
  p.call("getAuth", [model]);
  p.call("getAuth", [model, { apiKey: undefined, env: undefined }]);
  for (const args of [[{ ...model }], [model.provider], [model, { apiKey: "synthetic" }],
    [model, { env: {} }], [model, { minOAuthValidityMs: 0 }], [model, null],
    [model, Object.create({ apiKey: undefined })], [model, {}, "extra"],
    [model, { get env() { throw new Error("accessor must not run"); } }]])
    assert.throws(() => p.call("getAuth", args), /fixture_credential_refused/);
  for (const method of ["refresh", "checkAuth", "login", "logout", "setRuntimeApiKey", "removeRuntimeApiKey"])
    assert.throws(() => p.call(method));
  model.id = "changed";
  assert.throws(() => p.call("getAuth", [model]));
  assert.equal(p.counts.request.getAuth, 12);
  assert.deepEqual(Object.keys(p.counts), ["factory", "admission", "request", "denied"]);
});

test("prototype instrumentation preserves real receiver, original arguments and return identity", () => {
  let calls = 0;
  const model = { provider: "fixture-selected", id: "literal/slash:high" };
  const overrides = { env: undefined };
  const result = Promise.resolve("synthetic");
  const prototype = Object.fromEntries(["getModel", "getModels", "getAvailableSnapshot", "hasConfiguredAuth",
    "refresh", "getAuth", "checkAuth", "login", "logout", "setRuntimeApiKey", "removeRuntimeApiKey"]
    .map((name) => [name, function (...args) {
      calls++; assert.equal(this, runtime);
      if (name === "getAuth") assert.deepEqual(args, [model, overrides]);
      return result;
    }]));
  const runtime = Object.create(prototype);
  const original = prototype.getAuth;
  const p = modelRuntimePolicy();
  const restore = instrumentModelRuntimePrototype(prototype, p);
  assert.throws(() => runtime.getAuth(model)); assert.equal(calls, 0);
  assert.equal(runtime.refresh({ allowNetwork: false }), result);
  p.admission(model); p.request(model);
  assert.equal(runtime.getAuth(model, overrides), result);
  assert.throws(() => runtime.login()); assert.equal(calls, 2);
  restore(); assert.equal(prototype.getAuth, original);
  assert.throws(() => instrumentModelRuntimePrototype({}, p), /api_BLOCKED/);
});

test("unresolved module requests stop without an alternative lookup or load", () => {
  let resolutions = 0;
  const hooks = moduleHooks({ files: [], builtins: [] }, {});
  assert.throws(() => hooks.resolve("optional-platform-package", {}, () => {
    resolutions++; throw Object.assign(new Error("not retained"), { code: "ERR_MODULE_NOT_FOUND" });
  }), /fixture_module_unresolved_refused/);
  assert.equal(resolutions, 1);
});

test("ordinary offline factory ADC metadata probe is swallowed but remains a safety stop", async () => {
  // Fake originals only. Source chain and hashes are recorded in the harness README.
  // The installed default auth context catches fs.access errors and returns false;
  // neither a scrubbed HOME nor allowNetwork:false removes the Vertex ADC probe.
  let accesses = 0;
  const filesystem = createPolicy({ cwd: "/fixture/checkout", root: "/fixture",
    readRoots: [], authFiles: ["/fixture/agent-a/auth.json"] }, {
    realpath(path) {
      if (["/", "/fixture", "/fixture/checkout", "/fixture/agent-a", "/fixture/agent-a/auth.json"].includes(path)) return path;
      throw Object.assign(new Error("absent synthetic path"), { code: "ENOENT" });
    },
    isSymlink: () => false,
  });
  const fsp = { async access() { accesses++; throw Object.assign(new Error("absent"), { code: "ENOENT" }); } };
  instrumentFs({}, fsp, filesystem);
  const runtimePolicy = modelRuntimePolicy();
  runtimePolicy.call("refresh", [{ allowNetwork: false }]);
  const fileExists = async (path) => {
    try { await fsp.access(path); return true; }
    catch { return false; }
  };
  // Factory refresh enters the provider resolver before checking project/location.
  // No credential file exists or is read; the metadata operation itself is denied.
  assert.equal(await fileExists("/fixture/agent-a/.config/gcloud/application_default_credentials.json"), false);
  assert.equal(accesses, 0);
  assert.equal(filesystem.counts.credential, 1);
  assert.equal(runtimePolicy.counts.factory.refresh, 1);
  assert.equal(runtimePolicy.counts.denied, 0);
  assert.equal(runtimePolicy.counts.factory.getAuth, 0);
  assert.equal(runtimePolicy.counts.factory.checkAuth, 0);
  // The public-method counter cannot certify zero forbidden activity on its own.
  assert.notEqual(filesystem.counts.credential + runtimePolicy.counts.denied, 0);
});

test("ordinary synthetic auth lock mkdir is a stop even if SDK swallows the error", () => {
  const p = fixture(); let calls = 0;
  const fs = { mkdirSync() { calls++; } };
  instrumentFs(fs, {}, p);
  try { fs.mkdirSync("/fixture/agent-a/auth.json.lock"); } catch { /* mirrors reload */ }
  assert.equal(calls, 0);
  assert.equal(p.counts.credential, 1);
});
