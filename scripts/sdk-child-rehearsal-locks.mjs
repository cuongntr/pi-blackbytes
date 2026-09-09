// Harness-only, synchronous lock lifecycle authority. Never imports an SDK.
// Captured originals and an owned, closed fixture are prerequisites, not a sandbox.
import { dirname, isAbsolute, resolve } from "node:path";

export function syntheticLockPaths(root, files) {
  if (typeof root !== "string" || !isAbsolute(root) || root === "/" || resolve(root) !== root || /[*\0\r\n]/.test(root) ||
      !Array.isArray(files) || !files.length || new Set(files).size !== files.length)
    throw new Error("synthetic_lock_manifest_refused");
  const allowed = new Set(["agent-a/auth.json", "agent-a/settings.json", "checkout/.pi/settings.json"].map((file) => resolve(root, file)));
  if (files.some((file) => !allowed.has(file))) throw new Error("synthetic_lock_manifest_refused");
  return files.map((file) => `${file}.lock`);
}

export function createSyntheticLockPolicy({ root, files, hashes, ownedClosed }, original) {
  const paths = syntheticLockPaths(root, files);
  files = Object.freeze([...files]);
  hashes = Object.freeze({ ...hashes });
  const owned = new Map();
  let rootIdentity;
  const counts = { mkdir: 0, mtime: 0, stat: 0, rmdir: 0, denied: 0 };
  const block = () => { counts.denied++; throw new Error("synthetic_lock_refused"); };
  const identity = (stat) => `${stat.dev}:${stat.ino}`;
  function plain(path, missing = false) {
    let cursor = path;
    for (;;) {
      let stat;
      try { stat = original.lstat(cursor); }
      catch (error) { if (!(missing && cursor === path && error?.code === "ENOENT")) return block(); }
      if (stat && (stat.isSymbolicLink() || original.realpath(cursor) !== cursor)) return block();
      if (cursor !== path && !stat?.isDirectory()) return block();
      if (cursor === "/") break;
      cursor = dirname(cursor);
    }
  }
  function unchanged() {
    if (ownedClosed() !== true) return block();
    plain(root);
    const rootStat = original.lstat(root);
    if (!rootStat.isDirectory() || (rootIdentity !== undefined && identity(rootStat) !== rootIdentity)) return block();
    for (const file of files) {
      plain(file);
      const stat = original.lstat(file);
      if (!stat.isFile() || stat.nlink !== 1 || !/^[a-f0-9]{64}$/.test(hashes[file] ?? "") || original.digest(file) !== hashes[file]) return block();
    }
  }
  unchanged();
  rootIdentity = identity(original.lstat(root));
  for (const path of paths) {
    plain(path, true);
    try { original.lstat(path); return block(); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
  const validTime = (value) => typeof value === "number" ? Number.isFinite(value) :
    value instanceof Date && Object.getPrototypeOf(value) === Date.prototype && Number.isFinite(Date.prototype.getTime.call(value));
  function performUnchecked(operation, path, args = []) {
    if (counts.denied) return block();
    if (!paths.includes(path) || !["mkdir", "mtime", "stat", "rmdir"].includes(operation) || !Array.isArray(args) ||
        (operation === "mtime" ? args.length !== 2 || args.some((value) => !validTime(value)) : args.length !== 0)) return block();
    unchanged();
    plain(path, operation === "mkdir");
    if (operation === "mkdir") {
      if (owned.has(path)) return block();
      try { original.lstat(path); return block(); }
      catch (error) { if (error?.code !== "ENOENT") throw error; }
    } else {
      const stat = original.lstat(path);
      if (!owned.has(path) || !stat.isDirectory() || identity(stat) !== owned.get(path) || original.readdir(path).length !== 0) return block();
    }
    const result = original[operation](path, ...args);
    counts[operation]++;
    if (operation === "mkdir") {
      plain(path);
      const stat = original.lstat(path);
      if (!stat.isDirectory() || original.readdir(path).length !== 0) return block();
      owned.set(path, identity(stat));
    }
    if (operation === "rmdir") owned.delete(path);
    unchanged();
    return result;
  }
  function perform(operation, path, args = []) {
    const before = counts.denied;
    try { return performUnchecked(operation, path, args); }
    catch {
      if (counts.denied === before) counts.denied++;
      throw new Error("synthetic_lock_refused");
    }
  }
  function proof() {
    unchanged();
    if (owned.size || counts.denied) return block();
    for (const path of paths) {
      plain(path, true);
      try { original.lstat(path); return block(); }
      catch (error) { if (error?.code !== "ENOENT") throw error; }
    }
    return { hashesUnchanged: true, locksAbsent: true, ownedClosed: true, counts: { ...counts } };
  }
  return { paths: Object.freeze([...paths]), perform, proof, counts };
}
