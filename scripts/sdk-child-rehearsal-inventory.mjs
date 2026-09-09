// Metadata/file hashing only. Never import an SDK, execute a package, or install.
import { createHash } from "node:crypto";
import { readFile, realpath, readdir, lstat } from "node:fs/promises";
import { dirname, join, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { builtinModules } from "node:module";
import { inside } from "./sdk-child-rehearsal-policy.mjs";
export const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const digest = async (path) => sha(await readFile(path));
async function packageAt(entry) {
  let root = dirname(fileURLToPath(entry));
  for (;;) {
    try {
      const data = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
      if (data.name) return { root: await realpath(root), data };
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    const parent = dirname(root);
    if (parent === root) throw new Error("package_inventory_failed");
    root = parent;
  }
}
async function dependency(name, from) {
  if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)) throw new Error("dependency_name_refused");
  let ancestor = from;
  for (;;) {
    const root = join(ancestor, "node_modules", name);
    try {
      const data = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
      if (data.name !== name) throw new Error("dependency_identity_refused");
      return { root: await realpath(root), data };
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    const parent = dirname(ancestor);
    if (parent === ancestor) return undefined;
    ancestor = parent;
  }
}
export async function runtimeInventory(entry) {
  if (!isAbsolute(entry) || !process.execArgv.includes("--experimental-import-meta-resolve"))
    throw new Error("absolute_entry_and_parent_url_resolver_flag_required");
  entry = await realpath(entry);
  const publicRoot = async (name, parent) => pathToFileURL(await realpath(fileURLToPath(import.meta.resolve(name, parent)))).href;
  const sdkRoot = await publicRoot("@earendil-works/pi-coding-agent", pathToFileURL(entry).href);
  const aiRoot = await publicRoot("@earendil-works/pi-ai", sdkRoot);
  const agentCoreRoot = await publicRoot("@earendil-works/pi-agent-core", sdkRoot);
  const queue = await Promise.all([sdkRoot, aiRoot, agentCoreRoot].map(packageAt));
  const packages = new Map();
  const files = new Map();
  const gaps = [];
  const deniedUnresolvedEdges = [];
  const deniedSensitiveFiles = [];
  async function walk(dir, root) {
    for (const item of (await readdir(dir)).sort()) {
      if (item === "node_modules" || item === ".git") continue;
      // No credential contents are hashed or echoed, even in a malformed package.
      if (/^(?:\.env(?:\..*)?|\.npmrc|\.netrc|auth\.json|credentials(?:\..*)?)$/i.test(item)) {
        deniedSensitiveFiles.push({ url: pathToFileURL(join(dir, item)).href, disposition: "DENY_IF_REQUESTED" }); continue;
      }
      const path = join(dir, item);
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) { gaps.push("package_symlink_requires_explicit_review"); continue; }
      const canonical = await realpath(path);
      if (!inside(canonical, root)) throw new Error("package_escape_refused");
      if (stat.isDirectory()) await walk(canonical, root);
      else if (stat.isFile()) files.set(pathToFileURL(canonical).href, await digest(canonical));
      else gaps.push("nonregular_package_file");
    }
  }
  while (queue.length) {
    const pkg = queue.shift();
    if (packages.has(pkg.root)) continue;
    packages.set(pkg.root, { root: pkg.root, name: pkg.data.name, version: pkg.data.version });
    await walk(pkg.root, pkg.root);
    // Includes present optional/peer packages; missing entries are explicit, never installed.
    const names = new Set([...Object.keys(pkg.data.dependencies ?? {}), ...Object.keys(pkg.data.optionalDependencies ?? {}), ...Object.keys(pkg.data.peerDependencies ?? {})]);
    for (const name of [...names].sort()) {
      const found = await dependency(name, pkg.root);
      if (found) queue.push(found);
      else if (Object.hasOwn(pkg.data.optionalDependencies ?? {}, name) || pkg.data.peerDependenciesMeta?.[name]?.optional === true)
        deniedUnresolvedEdges.push({ parent: pathToFileURL(pkg.root).href, specifier: name, disposition: "DENY_IF_REQUESTED" });
      else gaps.push(`missing_dependency:${pkg.data.name}:${name}`);
    }
  }
  files.set(pathToFileURL(entry).href, await digest(entry));
  const manifest = {
    schema: 1, entry, sdkRoot, aiRoot, agentCoreRoot,
    packages: [...packages.values()].sort((a, b) => a.root.localeCompare(b.root, "en")),
    files: [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([url, sha256]) => ({ url, sha256 })),
    builtins: [...new Set(builtinModules.filter((name) => !name.startsWith("_")).map((name) => name.startsWith("node:") ? name : `node:${name}`))].sort(),
    deniedSensitiveFiles: deniedSensitiveFiles.sort((a, b) => a.url.localeCompare(b.url, "en")),
    deniedUnresolvedEdges: deniedUnresolvedEdges.sort((a, b) => `${a.parent}:${a.specifier}`.localeCompare(`${b.parent}:${b.specifier}`, "en")),
    gaps: [...new Set(gaps)].sort(),
  };
  return { ...manifest, sha256: sha(JSON.stringify(manifest)), readiness: "BLOCKED", execution: "NOT RUN" };
}
export function sameRuntimeManifest(before, after) {
  return before.sha256 === after.sha256 && before.gaps.length === 0 && after.gaps.length === 0;
}
