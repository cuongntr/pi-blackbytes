// Pure policy: all filesystem knowledge is supplied by fake or captured originals.
// This is instrumentation policy, not a JS/native sandbox or a TOCTOU guarantee.
import { constants } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const inside = (path, root) => {
  const part = relative(root, path);
  return part === "" || (part !== ".." && !part.startsWith("../") && !isAbsolute(part));
};
const deny = (kind) => { throw new Error(`fixture_${kind}_refused`); };
export function openMode(flags = "r") {
  if (typeof flags === "number" && Number.isSafeInteger(flags) && flags >= 0 && flags <= 0x7fffffff) {
    const access = flags & (constants.O_WRONLY | constants.O_RDWR);
    if (access === (constants.O_WRONLY | constants.O_RDWR)) deny("filesystem");
    return { read: access !== constants.O_WRONLY,
      write: access !== 0 || !!(flags & (constants.O_CREAT | constants.O_TRUNC | constants.O_APPEND)) };
  }
  if (typeof flags !== "string" || !/^(r|rs|sr|w|wx|xw|a|ax|xa|as|sa)\+?$/.test(flags)) deny("filesystem");
  return { read: flags.startsWith("r") || flags.startsWith("sr") || flags.includes("+"),
    write: !["r", "rs", "sr"].includes(flags) };
}
export function createPolicy(config, original) {
  const descriptors = new Map();
  const handles = new WeakMap();
  const counts = { filesystem: 0, credential: 0, network: 0, command: 0, syntheticAuthReads: 0 };
  const block = (kind) => { counts[kind]++; return deny(kind); };
  function canonical(input) {
    let path = input;
    try {
      if (path instanceof URL) path = fileURLToPath(path);
      if (Buffer.isBuffer(path)) path = new TextDecoder("utf-8", { fatal: true }).decode(path);
    } catch { return block("filesystem"); }
    if (typeof path !== "string" || path.includes("\0")) return block("filesystem");
    path = resolve(config.cwd, path);
    let ancestor = path;
    for (;;) {
      try { return resolve(original.realpath(ancestor), relative(ancestor, path)); }
      catch (error) {
        // Only a missing ancestor may be reconstructed. Never swallow EACCES/ELOOP.
        if (error?.code !== "ENOENT") return block("filesystem");
        // Dangling symlinks are not missing plain path components.
        if (original.isSymlink(ancestor)) return block("filesystem");
        const parent = dirname(ancestor);
        if (parent === ancestor) return block("filesystem");
        ancestor = parent;
      }
    }
  }
  const root = canonical(config.root);
  const readRoots = config.readRoots.map(canonical);
  const auth = new Set(config.authFiles.map(canonical));
  const protectedPath = (path) => /(?:^|\/)(?:auth(?:\.json)?|credentials?(?:\.[^/]*)?|\.npmrc|\.netrc|\.ssh|\.aws|\.config\/gcloud)(?:$|[/.])/.test(path);
  function checkPath(input, operation) {
    const path = canonical(input);
    const write = operation === "write";
    if (!["read", "write", "metadata"].includes(operation)) return block("filesystem");
    if (inside(path, resolve(root, "agent-b"))) return block("filesystem");
    // Lock lifecycle has separate exact operation authority; generic FS access never grants it.
    if (/(?:^|\/)(?:auth|settings)\.json\.lock(?:$|\/)/.test(path)) return block("credential");
    if (write && /(?:^|\/)settings\.json(?:$|\/)/.test(path)) return block("credential");
    if (protectedPath(path)) {
      if (write || !auth.has(path) || !inside(path, root)) return block("credential");
      if (operation === "read") counts.syntheticAuthReads++;
    }
    if (/(?:^|\/)(?:trust\.json|sessions)(?:$|[/.])/.test(path) && write) return block("credential");
    if (inside(path, root)) return path;
    if (!write && readRoots.some((base) => inside(path, base))) return path;
    if (operation === "metadata" && readRoots.some((base) => inside(base, path))) return path;
    return block("filesystem");
  }
  function check(input, operation) {
    const fd = typeof input === "number" ? input : handles.get(input);
    if (fd !== undefined) {
      if (fd <= 3) {
        if ((fd === 0 && operation === "read") || ([1, 2, 3].includes(fd) && operation === "write") || ([0, 1, 2, 3].includes(fd) && operation === "close")) return;
        return block("filesystem");
      }
      const tracked = descriptors.get(fd);
      if (!tracked) return block("filesystem");
      if (operation === "close") return tracked.path;
      if (operation !== "metadata" && !tracked.mode[operation]) return block("filesystem");
      // Recheck canonical path and credential policy on every operation.
      return checkPath(tracked.path, operation);
    }
    if (typeof input === "object" && !(input instanceof URL) && !Buffer.isBuffer(input)) return block("filesystem");
    return checkPath(input, operation);
  }
  function opened(path, flags, fdOrHandle) {
    const mode = openMode(flags);
    const full = checkPath(path, mode.write ? "write" : "read");
    const fd = typeof fdOrHandle === "number" ? fdOrHandle : fdOrHandle.fd;
    if (!Number.isSafeInteger(fd) || fd <= 3 || descriptors.has(fd)) return block("filesystem");
    descriptors.set(fd, { path: full, mode });
    if (typeof fdOrHandle === "object") handles.set(fdOrHandle, fd);
  }
  function closed(input) {
    const fd = typeof input === "number" ? input : handles.get(input);
    descriptors.delete(fd);
    if (typeof input === "object") handles.delete(input);
  }
  function twoPath(operation, from, to) {
    if (!["copy", "rename", "link", "symlink"].includes(operation)) return block("filesystem");
    // Hard/symbolic links can mutate read-only targets through aliases: conservatively refuse.
    if (["link", "symlink"].includes(operation)) return block("filesystem");
    check(from, operation === "copy" ? "read" : "write");
    check(to, "write");
  }
  return { canonical, check, opened, closed, twoPath, counts,
    network: () => block("network"), command: () => block("command") };
}

// Public synchronous registerHooks callback. Resolved URLs, not specifiers, authorize loads.
export function moduleHooks(manifest, original) {
  const files = new Map(manifest.files.map((file) => [file.url, file.sha256]));
  const builtins = new Set(manifest.builtins);
  function verify(url) {
    if (url.startsWith("node:") && builtins.has(url)) return;
    if (!url.startsWith("file:") || !files.has(url)) deny("module");
    const path = fileURLToPath(url);
    if (original.fileURL(original.realpath(path)) !== url || original.digest(path) !== files.get(url)) deny("module");
  }
  return {
    resolve(specifier, context, nextResolve) {
      // Optional/platform dependencies absent from this reviewed installation have
      // no URL authority. An actual request is a stop, not a fallback/install cue.
      let result;
      try { result = nextResolve(specifier, context); }
      catch { deny("module_unresolved"); }
      verify(result.url);
      return result;
    },
    load(url, context, nextLoad) {
      verify(url);
      return nextLoad(url, context);
    },
  };
}

// Import-safe public ModelRuntime policy. Before-factory integration remains stopped
// pending the ordinary-storage lock-write blocker and independent parent review.
export function modelRuntimePolicy() {
  let phase = "factory";
  let admitted;
  const methods = ["getModel", "getModels", "getAvailableSnapshot", "hasConfiguredAuth", "refresh", "getAuth", "checkAuth"];
  const counts = Object.fromEntries(["factory", "admission", "request"].map((phase) =>
    [phase, Object.fromEntries(methods.map((method) => [method, 0]))]));
  counts.denied = 0;
  const block = () => { counts.denied++; deny("credential"); };
  const tuple = (model) => model?.provider === "fixture-selected" && model?.id === "literal/slash:high";
  return {
    counts,
    admission(model) {
      if (phase !== "factory" || (model !== undefined && !tuple(model))) return block();
      admitted = model;
      phase = "admission";
    },
    request(model) {
      if (phase !== "admission" || !admitted || model !== admitted || !tuple(model)) return block();
      phase = "request";
    },
    call(method, args = []) {
      if (!methods.includes(method)) return block();
      counts[phase][method]++;
      if (methods.slice(0, 4).includes(method)) return;
      if (phase === "factory" && method === "refresh" && args[0]?.allowNetwork === false) return;
      if (phase === "request" && method === "getAuth" && args[0] === admitted && tuple(admitted)) {
        // Public prepareRequest supplies undefined apiKey/env fields. Permit those
        // exact empty data fields, but no values, accessors, inherited overrides,
        // OAuth options, environment credentials or provider-string overload.
        const overrides = args[1];
        if (args.length <= 2 && (overrides === undefined ||
            (overrides !== null && Object.getPrototypeOf(overrides) === Object.prototype &&
             Reflect.ownKeys(overrides).every((key) => ["apiKey", "env"].includes(key) &&
               Object.getOwnPropertyDescriptor(overrides, key)?.value === undefined &&
               Object.hasOwn(Object.getOwnPropertyDescriptor(overrides, key), "value"))))) return;
      }
      return block();
    },
  };
}

// Patch the supplied actual public prototype in place, never manufacture/copy a
// runtime. Not called by the stopped preload. Originals retain this/args/results.
export function instrumentModelRuntimePrototype(prototype, policy) {
  const methods = ["getModel", "getModels", "getAvailableSnapshot", "hasConfiguredAuth",
    "refresh", "getAuth", "checkAuth", "login", "logout", "setRuntimeApiKey", "removeRuntimeApiKey"];
  const descriptors = methods.map((name) => [name, Object.getOwnPropertyDescriptor(prototype, name)]);
  if (descriptors.some(([, descriptor]) => typeof descriptor?.value !== "function" || !descriptor.configurable))
    throw new Error("fixture_model_runtime_api_BLOCKED");
  for (const [name, descriptor] of descriptors) Object.defineProperty(prototype, name, {
    ...descriptor, value: function (...args) {
      policy.call(name, args);
      return Reflect.apply(descriptor.value, this, args);
    },
  });
  return () => { for (const [name, descriptor] of descriptors) Object.defineProperty(prototype, name, descriptor); };
}
