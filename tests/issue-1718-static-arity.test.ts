/**
 * #1718 — Iterator sequencing static helpers (Iterator.from/zip/zipKeyed/concat)
 * must carry spec-correct `length`/`name`/property descriptors (§17).
 *
 * The polyfill in `_installIteratorHelperPolyfills` previously installed these
 * via raw `Object.defineProperty`, so a TS optional param (`options?`) inflated
 * the function `.length` to 2 (spec mandates 1 for zip/zipKeyed, 1 for from,
 * 0 for the variadic concat). It also left the function's own `length`/`name`
 * as the default writable descriptor. This regressed the test262
 * `built-ins/Iterator/{zip,zipKeyed}/length.js` `verifyProperty` checks.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { buildImports } from "../src/runtime.ts";

beforeAll(() => {
  // Installs the ES2025 Iterator helper polyfills on globalThis.Iterator.
  buildImports([], undefined, []);
});

const I = (globalThis as any).Iterator;

describe("#1718 static helper arity + descriptors", () => {
  it.each([
    ["from", 1],
    ["zip", 1],
    ["zipKeyed", 1],
    ["concat", 0],
  ])("Iterator.%s has spec length %i", (name, len) => {
    expect(typeof I[name]).toBe("function");
    expect(I[name].length).toBe(len);
  });

  it.each(["from", "zip", "zipKeyed", "concat"])(
    "Iterator.%s length is non-writable/non-enumerable/configurable",
    (name) => {
      const d = Object.getOwnPropertyDescriptor(I[name], "length")!;
      expect(d.writable).toBe(false);
      expect(d.enumerable).toBe(false);
      expect(d.configurable).toBe(true);
    },
  );

  it.each(["from", "zip", "zipKeyed", "concat"])("Iterator.%s name matches and is non-writable", (name) => {
    expect(I[name].name).toBe(name);
    const d = Object.getOwnPropertyDescriptor(I[name], "name")!;
    expect(d.writable).toBe(false);
    expect(d.enumerable).toBe(false);
    expect(d.configurable).toBe(true);
  });

  it.each(["from", "zip", "zipKeyed", "concat"])(
    "Iterator.%s property is writable/non-enumerable/configurable (§17 default)",
    (name) => {
      const d = Object.getOwnPropertyDescriptor(I, name)!;
      expect(d.writable).toBe(true);
      expect(d.enumerable).toBe(false);
      expect(d.configurable).toBe(true);
    },
  );

  it("runtime behaviour preserved: concat flattens iterables in order", () => {
    let sum = 0;
    for (const x of I.concat([1, 2], [3])) sum += x;
    expect(sum).toBe(6);
  });

  it("runtime behaviour preserved: zip pairs shortest", () => {
    let sum = 0;
    for (const pair of I.zip([
      [1, 2],
      [3, 4],
    ]))
      sum += pair[0] + pair[1];
    expect(sum).toBe(10);
  });
});

describe("#1718 zip/zipKeyed GetOptionsObject validation", () => {
  // ES2025 GetOptionsObject: options must be undefined or an Object; any other
  // value throws TypeError (test262 Iterator/{zip,zipKeyed}/options.js).
  const invalid = [null, true, "", Symbol(), 0, 0n];

  it.each(invalid)("Iterator.zipKeyed({}, %o) throws TypeError", (bad) => {
    expect(() => I.zipKeyed({}, bad)).toThrow(TypeError);
  });

  it.each(invalid)("Iterator.zip([], %o) throws TypeError", (bad) => {
    expect(() => I.zip([], bad)).toThrow(TypeError);
  });

  it("accepts undefined and object options", () => {
    expect(() => I.zipKeyed({})).not.toThrow();
    expect(() => I.zipKeyed({}, undefined)).not.toThrow();
    expect(() => I.zipKeyed({}, {})).not.toThrow();
  });
});
