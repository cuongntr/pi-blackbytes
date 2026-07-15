import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CanonicalJsonError, canonicalDigest, canonicalJson, sha256 } from "../canonical-json.js";

describe("canonicalJson", () => {
  it("should serialize null", () => {
    assert.equal(canonicalJson(null), "null");
  });

  it("should serialize true", () => {
    assert.equal(canonicalJson(true), "true");
  });

  it("should serialize false", () => {
    assert.equal(canonicalJson(false), "false");
  });

  it("should serialize strings", () => {
    assert.equal(canonicalJson("hello"), '"hello"');
  });

  it("should escape special characters in strings", () => {
    assert.equal(canonicalJson('he"llo'), '"he\\"llo"');
  });

  it("should serialize finite numbers", () => {
    assert.equal(canonicalJson(42), "42");
  });

  it("should serialize negative numbers", () => {
    assert.equal(canonicalJson(-42), "-42");
  });

  it("should serialize floating point numbers", () => {
    assert.equal(canonicalJson(3.14), "3.14");
  });

  it("should normalize negative zero to JSON zero", () => {
    assert.equal(canonicalJson(-0), "0");
    assert.equal(canonicalDigest(-0), canonicalDigest(0));
  });

  it("should reject NaN", () => {
    assert.throws(() => canonicalJson(Number.NaN), CanonicalJsonError);
  });

  it("should reject Infinity", () => {
    assert.throws(() => canonicalJson(Number.POSITIVE_INFINITY), CanonicalJsonError);
  });

  it("should reject -Infinity", () => {
    assert.throws(() => canonicalJson(Number.NEGATIVE_INFINITY), CanonicalJsonError);
  });

  it("should serialize empty object", () => {
    assert.equal(canonicalJson({}), "{}");
  });

  it("should sort object keys lexicographically", () => {
    const input = { z: 1, a: 2, m: 3 };
    assert.equal(canonicalJson(input), '{"a":2,"m":3,"z":1}');
  });

  it("should serialize nested objects with sorted keys", () => {
    const input = { b: { y: 1, x: 2 }, a: 3 };
    assert.equal(canonicalJson(input), '{"a":3,"b":{"x":2,"y":1}}');
  });

  it("should serialize empty array", () => {
    assert.equal(canonicalJson([]), "[]");
  });

  it("should preserve array order", () => {
    assert.equal(canonicalJson([3, 1, 2]), "[3,1,2]");
  });

  it("should serialize nested arrays", () => {
    assert.equal(canonicalJson([1, [2, 3]]), "[1,[2,3]]");
  });

  it("should serialize mixed objects and arrays", () => {
    const input = { items: [{ id: 2 }, { id: 1 }] };
    assert.equal(canonicalJson(input), '{"items":[{"id":2},{"id":1}]}');
  });

  it("should serialize repeated non-cyclic references", () => {
    const shared = { value: 1 };
    assert.equal(
      canonicalJson({ first: shared, second: shared }),
      '{"first":{"value":1},"second":{"value":1}}',
    );
  });

  it("should reject cyclic objects", () => {
    const obj: Record<string, unknown> = {};
    obj.self = obj;
    assert.throws(() => canonicalJson(obj), CanonicalJsonError);
  });

  it("should reject cyclic arrays", () => {
    const arr: unknown[] = [];
    arr.push(arr);
    assert.throws(() => canonicalJson(arr), CanonicalJsonError);
  });

  it("should reject Date, Map, Set, RegExp, and class instances", () => {
    class Example {
      readonly value = 1;
    }

    for (const value of [new Date(0), new Map(), new Set(), /x/, new Example()]) {
      assert.throws(
        () => canonicalJson(value),
        (error: unknown) => error instanceof CanonicalJsonError && error.code === "E_EVAL_SCHEMA",
      );
    }
  });

  it("should accept null-prototype JSON objects", () => {
    const value = Object.assign(Object.create(null) as Record<string, unknown>, { b: 2, a: 1 });
    assert.equal(canonicalJson(value), '{"a":1,"b":2}');
  });

  it("should reject undefined", () => {
    assert.throws(() => canonicalJson(undefined), CanonicalJsonError);
  });

  it("should reject functions", () => {
    assert.throws(() => canonicalJson(() => {}), CanonicalJsonError);
  });

  it("should reject symbols", () => {
    assert.throws(() => canonicalJson(Symbol("test")), CanonicalJsonError);
  });

  it("should produce stable output for same content", () => {
    const a = { b: 1, a: 2 };
    const b = { a: 2, b: 1 };
    assert.equal(canonicalJson(a), canonicalJson(b));
  });

  it("should produce different output for different content", () => {
    assert.notEqual(canonicalJson({ a: 1 }), canonicalJson({ a: 2 }));
  });

  it("should handle deeply nested structures", () => {
    const input = {
      level1: {
        level2: {
          level3: [1, 2, 3],
        },
      },
    };
    const result = canonicalJson(input);
    assert.ok(result.includes("level1"));
    assert.ok(result.includes("level2"));
    assert.ok(result.includes("level3"));
  });

  it("should handle empty string keys", () => {
    assert.equal(canonicalJson({ "": 1 }), '{"":1}');
  });
});

describe("sha256", () => {
  it("should produce a 64-character hex string", () => {
    const digest = sha256("hello");
    assert.equal(digest.length, 64);
    assert.match(digest, /^[0-9a-f]{64}$/);
  });

  it("should be deterministic", () => {
    assert.equal(sha256("hello"), sha256("hello"));
  });

  it("should produce different digests for different inputs", () => {
    assert.notEqual(sha256("hello"), sha256("world"));
  });

  it("should match known SHA-256 value", () => {
    // SHA-256 of empty string
    assert.equal(sha256(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});

describe("canonicalDigest", () => {
  it("should produce a 64-character hex string", () => {
    const digest = canonicalDigest({ a: 1 });
    assert.equal(digest.length, 64);
    assert.match(digest, /^[0-9a-f]{64}$/);
  });

  it("should be deterministic for same content", () => {
    const a = canonicalDigest({ b: 1, a: 2 });
    const b = canonicalDigest({ a: 2, b: 1 });
    assert.equal(a, b);
  });

  it("should differ for different content", () => {
    const a = canonicalDigest({ a: 1 });
    const b = canonicalDigest({ a: 2 });
    assert.notEqual(a, b);
  });

  it("should reject non-finite numbers", () => {
    assert.throws(() => canonicalDigest({ value: Number.NaN }), CanonicalJsonError);
  });
});
