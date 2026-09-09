// Injectable originals only; importing this module does not patch or perform I/O.
import { openMode } from "./sdk-child-rehearsal-policy.mjs";
export function instrumentFs(fs, fsp, policy) {
  const reads = new Set(["readFile", "readdir", "opendir", "read", "readv"]);
  const metadata = new Set(["stat", "lstat", "fstat", "realpath", "readlink", "exists"]);
  const writes = new Set(["writeFile", "appendFile", "write", "writev", "mkdir", "truncate", "ftruncate", "unlink", "rm", "rmdir", "chmod", "fchmod", "chown", "fchown", "lchown", "utimes", "futimes", "lutimes", "fsync", "fdatasync"]);
  const two = new Map([["copyFile", "copy"], ["rename", "rename"], ["link", "link"], ["symlink", "symlink"]]);
  const handles = new WeakSet();
  function openCheck(path, flags) {
    const mode = openMode(flags);
    policy.check(path, mode.write ? "write" : "read");
  }
  function wrapHandle(handle, path, flags) {
    policy.opened(path, flags, handle);
    if (handles.has(handle)) throw new Error("fixture_handle_reused");
    handles.add(handle);
    for (const name of ["readFile", "read", "readv", "writeFile", "appendFile", "write", "writev", "stat", "truncate", "chmod", "chown", "utimes", "sync", "datasync", "close", "createReadStream", "createWriteStream", "readLines", "readableWebStream"]) {
      const fn = handle[name];
      if (typeof fn !== "function") continue;
      handle[name] = function (...args) {
        if (name === "close") return Promise.resolve(Reflect.apply(fn, this, args)).then((result) => { policy.closed(handle); return result; });
        if (/Stream|readLines/.test(name)) throw new Error("fixture_stream_path_uncovered");
        policy.check(handle, reads.has(name) ? "read" : name === "stat" ? "metadata" : "write");
        return Reflect.apply(fn, this, args);
      };
    }
    // Symbol.asyncDispose could bypass the close bookkeeping; conservatively route it too.
    if (Symbol.asyncDispose && typeof handle[Symbol.asyncDispose] === "function") handle[Symbol.asyncDispose] = handle.close;
    return handle;
  }
  for (const object of [fs, fsp]) {
    const promise = object === fsp;
    for (const name of Object.keys(object)) {
      if (typeof object[name] !== "function") continue;
      const fn = object[name];
      const base = name.replace(/Sync$/, "");
      if (base === "open") {
        object[name] = function (path, flags, ...args) {
          openCheck(path, flags);
          if (promise) return Reflect.apply(fn, this, [path, flags, ...args]).then((handle) => wrapHandle(handle, path, flags));
          if (name.endsWith("Sync")) {
            const fd = Reflect.apply(fn, this, [path, flags, ...args]);
            policy.opened(path, flags, fd); return fd;
          }
          const callback = args.pop();
          if (typeof callback !== "function") throw new Error("fixture_callback_required");
          return Reflect.apply(fn, this, [path, flags, ...args, (error, fd) => {
            if (error) return callback(error);
            try { policy.opened(path, flags, fd); } catch (failure) { return callback(failure); }
            callback(null, fd);
          }]);
        };
      } else if (base === "close") {
        object[name] = function (fd, ...args) {
          policy.check(fd, "close");
          if (name.endsWith("Sync")) { const result = Reflect.apply(fn, this, [fd, ...args]); policy.closed(fd); return result; }
          const callback = args.pop();
          if (typeof callback !== "function") throw new Error("fixture_callback_required");
          return Reflect.apply(fn, this, [fd, ...args, (error) => { if (!error) policy.closed(fd); callback(error); }]);
        };
      } else if (reads.has(base) || metadata.has(base) || writes.has(base) || two.has(base) || base === "access") {
        object[name] = function (path, ...args) {
          if (two.has(base)) policy.twoPath(two.get(base), path, args[0]);
          else if (base === "access") {
            // W_OK/X_OK are not harmless resolution metadata.
            if (typeof args[0] === "number" && args[0] !== 0 && args[0] !== 4) policy.check(path, "write");
            else policy.check(path, "metadata");
          } else policy.check(path, reads.has(base) ? "read" : metadata.has(base) ? "metadata" : "write");
          return Reflect.apply(fn, this, [path, ...args]);
        };
      } else {
        // Streams, watchers, glob and future APIs require dedicated reviewed wrappers.
        object[name] = () => { throw new Error("fixture_fs_api_uncovered"); };
      }
    }
  }
}
