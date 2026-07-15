/**
 * Canonical JSON serialization and SHA-256 digest utilities.
 *
 * Canonical JSON guarantees:
 * - Deterministic object-key ordering (sorted lexicographically).
 * - Arrays retain insertion order.
 * - Non-finite numbers (NaN, Infinity, -Infinity) are rejected.
 * - Cyclic references are rejected.
 * - Unsupported JavaScript types (undefined, function, symbol, bigint) are rejected.
 *
 * All rejections throw a structured `CanonicalJsonError` with code `E_EVAL_SCHEMA`.
 *
 * @module
 */

import { createHash } from "node:crypto";
import type { EvidenceError } from "./types.js";

// ── Error type ──────────────────────────────────────────────────────────────

/**
 * Error thrown by canonical JSON serialization for unsupported or invalid values.
 */
export class CanonicalJsonError extends Error implements EvidenceError {
  readonly code = "E_EVAL_SCHEMA" as const;

  /**
   * @param message - Human-readable description including the value path.
   * @param recordId - Optional identifier for the affected record.
   */
  constructor(
    message: string,
    public readonly recordId?: string,
  ) {
    super(message);
    this.name = "CanonicalJsonError";
  }
}

// ── Internal serializer ─────────────────────────────────────────────────────

function serialize(value: unknown, ancestors: WeakSet<object>, path: string): string {
  // Primitives
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";

  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new CanonicalJsonError(`Non-finite number at ${path}: ${value}`);
    }
    return Object.is(value, -0) ? "0" : String(value);
  }

  // Arrays
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw new CanonicalJsonError(`Cyclic array reference at ${path}`);
    }
    ancestors.add(value);
    try {
      const items = value.map((item, i) => serialize(item, ancestors, `${path}[${i}]`));
      return `[${items.join(",")}]`;
    } finally {
      ancestors.delete(value);
    }
  }

  // Only plain objects and null-prototype dictionaries are valid JSON containers.
  if (typeof value === "object" && value !== null) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CanonicalJsonError(`Unsupported object type at ${path}`);
    }
    if (ancestors.has(value)) {
      throw new CanonicalJsonError(`Cyclic object reference at ${path}`);
    }
    ancestors.add(value);
    try {
      const keys = Object.keys(value).sort();
      const pairs = keys.map((key) => {
        const sk = JSON.stringify(key);
        const sv = serialize((value as Record<string, unknown>)[key], ancestors, `${path}.${key}`);
        return `${sk}:${sv}`;
      });
      return `{${pairs.join(",")}}`;
    } finally {
      ancestors.delete(value);
    }
  }

  // Unsupported types: undefined, function, symbol, bigint
  throw new CanonicalJsonError(`Unsupported JSON value type at ${path}: ${typeof value}`);
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Serialize a value to canonical JSON string.
 *
 * Object keys are sorted lexicographically. Arrays retain order.
 * Non-finite numbers, cyclic references, and unsupported types throw.
 *
 * @param value - The value to serialize.
 * @returns Canonical JSON string.
 * @throws {CanonicalJsonError} On unsupported or invalid input.
 */
export function canonicalJson(value: unknown): string {
  const ancestors = new WeakSet<object>();
  return serialize(value, ancestors, "$");
}

/**
 * Compute the SHA-256 hex digest of a UTF-8 string.
 *
 * @param input - UTF-8 string to hash.
 * @returns Lowercase hex-encoded SHA-256 digest (64 characters).
 */
export function sha256(input: string): string {
  return createHash("sha256").update(input, "utf-8").digest("hex");
}

/**
 * Compute the canonical JSON digest of a value in one step.
 *
 * Equivalent to `sha256(canonicalJson(value))`.
 *
 * @param value - The value to serialize and hash.
 * @returns Lowercase hex-encoded SHA-256 digest.
 * @throws {CanonicalJsonError} On unsupported or invalid input.
 */
export function canonicalDigest(value: unknown): string {
  return sha256(canonicalJson(value));
}
