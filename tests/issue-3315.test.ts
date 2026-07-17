/**
 * #3315 — extra call-argument / class-as-value corrupts sibling destructured
 * bindings in standalone (and host) methods.
 *
 * Root cause (three layers, all fixed together):
 *
 * 1. REP: a parameter array-pattern element WITHOUT a per-element default
 *    (`{ w: [x, y, z] = [4, 5, 6] }`) resolved its local from the
 *    checker-inferred `number` (a fiction derived from the pattern's own
 *    default) → f64 local → a runtime `undefined` element degraded to NaN and
 *    `y === undefined` constant-folded false. Fixed by widening such bindings
 *    to externref (`resolveBindingElementType`, #3315 rule) and skipping the
 *    checker-type unbox narrowing on their reads (`undefWidenedLocals`).
 *
 * 2. BOX: `[7, undefined, ]` lowers to an f64 vec carrying the UNDEF_F64_BITS
 *    signaling-NaN sentinel for `undefined` (the #1024 design). Boxing that
 *    f64 through a raw `__box_number` (generic coerceType arm, the
 *    destructure vec-conversion loop `boxToExternref`, and the host-boundary
 *    `__vec_get`) produced a NaN NUMBER — undefined identity lost. All three
 *    boxing sites now map sentinel-bits → real `undefined` (host
 *    `__get_undefined` / standalone tag-1 singleton) before boxing.
 *
 * 3. The 1-arg vs 2-arg call-shape sensitivity from the issue's A/B matrix
 *    was this same rep/box fragility flipping with compilation context; with
 *    the deterministic fix both shapes destructure identically and correctly.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { fileName: "test.ts", skipSemanticDiagnostics: true, target: "standalone" });
  expect(r.success, `standalone compile failed: ${r.errors?.[0]?.message}`).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary!, {});
  return (instance.exports as { test(): number }).test();
}

async function runHost(src: string): Promise<number> {
  const r = await compile(src, { fileName: "test.ts", skipSemanticDiagnostics: true });
  expect(r.success, `host compile failed: ${r.errors?.[0]?.message}`).toBe(true);
  const imports = buildImports(r.imports, undefined, r.stringPool, {}) as WebAssembly.Imports & {
    setExports?: (e: WebAssembly.Exports) => void;
  };
  const { instance } = await WebAssembly.instantiate(r.binary!, imports);
  imports.setExports?.(instance.exports);
  (instance.exports as { __module_init?: () => void }).__module_init?.();
  return (instance.exports as unknown as { test(): number }).test();
}

// The distilled #3315 shape: object-literal method with an array pattern
// (whole-pattern default, no per-element defaults) invoked with an explicit
// `undefined` element and a missing (OOB) element. Expected per spec:
// x = 7, y = undefined, z = undefined.
const DIRECT_COMPARE = `
let r: number = -1;
var obj = {
  method({ w: [x, y, z] = [4, 5, 6] }) {
    r = (x === 7 ? 100 : 0) + ((y === undefined) ? 10 : 0) + ((z === undefined) ? 1 : 0);
  }
};
export function test(): number {
  obj.method({ w: [7, undefined, ] });
  return r;
}
`;

// The harness-shaped variant: the bindings flow through any-typed helper
// params and the generic any-\`===\` (isSameValue), catching the
// $BoxedNumber-with-sentinel leak the inline compare alone would miss.
const ANY_PARAM_COMPARE = `
let __fail: number = 0;
let __assert_count: number = 1;
function isSameValue(a: any, b: any): number {
  if (a === b) { return 1; }
  if (a !== a && b !== b) { return 1; }
  return 0;
}
function assert_sameValue(actual: any, expected: any): void {
  __assert_count = __assert_count + 1;
  if (!isSameValue(actual, expected)) {
    if (!__fail) __fail = __assert_count;
  }
}
var obj = {
  method({ w: [x, y, z] = [4, 5, 6] }) {
    assert_sameValue(x, 7);
    assert_sameValue(y, undefined);
    assert_sameValue(z, undefined);
  }
};
export function test(): number {
  obj.method({ w: [7, undefined, ] });
  if (__fail) { return __fail; }
  return 1;
}
`;

// The issue's trigger axis: an unrelated class-as-VALUE second argument in
// the same method body must not perturb the sibling destructuring.
const CLASS_VALUE_ARG = `
let __fail: number = 0;
let __assert_count: number = 1;
class __DummyMatcher {
  tag: number = 1;
}
function isSameValue(a: any, b: any): number {
  if (a === b) { return 1; }
  if (a !== a && b !== b) { return 1; }
  return 0;
}
function assert_sameValue(actual: any, expected: any): void {
  __assert_count = __assert_count + 1;
  if (!isSameValue(actual, expected)) {
    if (!__fail) __fail = __assert_count;
  }
}
function assert_throws(ctor: any, fn: () => void): void {
  __assert_count = __assert_count + 1;
  try {
    fn();
  } catch (e) {
    return;
  }
  if (!__fail) __fail = __assert_count;
}
var obj = {
  method({ w: [x, y, z] = [4, 5, 6] }) {
    assert_sameValue(x, 7);
    assert_sameValue(y, undefined);
    assert_sameValue(z, undefined);
    assert_throws(__DummyMatcher, function() {
      (w as any);
    });
  }
};
export function test(): number {
  obj.method({ w: [7, undefined, ] });
  if (__fail) { return __fail; }
  return 1;
}
`;

// Defaults must still fire when the WHOLE pattern source is absent — the
// widened locals must not break the default-array path.
const DEFAULT_FIRES = `
let r: number = -1;
var obj = {
  method({ w: [x, y, z] = [4, 5, 6] }) {
    r = (x === 4 ? 100 : 0) + (y === 5 ? 10 : 0) + (z === 6 ? 1 : 0);
  }
};
export function test(): number {
  obj.method({} as any);
  return r;
}
`;

// Numeric arithmetic on widened bindings keeps JS ToNumber semantics
// (present numbers compute; undefined contaminates to NaN).
const ARITHMETIC = `
let r: number = -1;
var obj = {
  method({ w: [x, y] = [4, 5] }) {
    const sum = x + 1;
    const bad = (y as any) + 1;
    r = (sum === 8 ? 10 : 0) + ((bad !== bad) ? 1 : 0);
  }
};
export function test(): number {
  obj.method({ w: [7, undefined, ] });
  return r;
}
`;

describe("#3315 — sibling destructured bindings preserve undefined identity", () => {
  it("standalone: direct === undefined observes all three bindings", async () => {
    expect(await runStandalone(DIRECT_COMPARE)).toBe(111);
  });

  it("host: direct === undefined observes all three bindings", async () => {
    expect(await runHost(DIRECT_COMPARE)).toBe(111);
  });

  it("standalone: any-param isSameValue path (harness shape)", async () => {
    expect(await runStandalone(ANY_PARAM_COMPARE)).toBe(1);
  });

  it("host: any-param isSameValue path (harness shape)", async () => {
    expect(await runHost(ANY_PARAM_COMPARE)).toBe(1);
  });

  it("standalone: class-as-value 2nd argument does not corrupt siblings", async () => {
    expect(await runStandalone(CLASS_VALUE_ARG)).toBe(1);
  });

  it("host: class-as-value 2nd argument does not corrupt siblings", async () => {
    expect(await runHost(CLASS_VALUE_ARG)).toBe(1);
  });

  it("standalone: whole-pattern default still fires when w is absent", async () => {
    expect(await runStandalone(DEFAULT_FIRES)).toBe(111);
  });

  it("host: whole-pattern default still fires when w is absent", async () => {
    expect(await runHost(DEFAULT_FIRES)).toBe(111);
  });

  it("standalone: arithmetic on widened bindings keeps ToNumber semantics", async () => {
    expect(await runStandalone(ARITHMETIC)).toBe(11);
  });

  it("host: arithmetic on widened bindings keeps ToNumber semantics", async () => {
    expect(await runHost(ARITHMETIC)).toBe(11);
  });
});
