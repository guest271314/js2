import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

// #2040/#1888 — tag-5 field-4 equality (RESHAPED: string arm landed, the
// both-tags-5 numeric/object classifier DEFERRED).
//
// The tag-5 (string) box's `externval` (field 4 of $AnyValue) is overloaded: it
// holds genuine strings, `$BoxedNumber`s (the #1888 −794 "box-the-externref"
// contract for numbers that pass through externref), and non-string GC objects.
// The tag-5 arm of both __any_eq and __any_strict_eq now routes to the GUARDED
// native string-content compare (`ref.test $AnyString`-gated), which banks #2579
// boxed-string `===` + #2583 `Array.prototype.{indexOf,…}.call(arrayLike)` and is
// `0` for non-string tag-5 pairs (main's legacy answer).
//
// A broader CLASSIFIER (a #2040 numeric `f64.eq` arm for two boxed-NUMBERS, and a
// #2585 `ref.eq` proto-identity arm for two boxed OBJECTS) was tried in #1888 but
// EJECTED from the merge_group on the standalone-highwater floor (−162): changing
// tag-5 boxed-VALUE equality for numbers/objects flips a comparison the
// destructuring / generator-iterator lowering implicitly relied on (it counted on
// the legacy always-false tag-5 non-string eq), regressing the class/dstr cluster.
// Those two arms are DEFERRED to the value-rep substrate (#2580 M2 / #35); the
// cases they would fix are `it.skip`ped below with that reference. The cross-tag
// String⇄Number coercion (`tag5ToNumber`) is a separate, dstr-safe #2040 fix and
// stays — `23===23.0`, NaN, ±0 below still pass via that path.

async function runStandalone(src: string, opts?: { tag5ValueEqClassifier?: boolean }): Promise<unknown> {
  const r = await compile(src, { target: "standalone", ...(opts ?? {}) } as never);
  if (!r.success) throw new Error("compile error: " + (r.errors?.[0]?.message ?? "unknown"));
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { main(): unknown }).main();
}

// (#2141 S2 / #2626) The classifier arms are now IN-TREE behind the
// `tag5ValueEqClassifier` CompileOption. The S2
// root-cause work (2026-07-04) disproved the "dstr lowering relies on
// always-false tag-5 eq" theory: the −162 eject was the classifier UNMASKING
// latent failures — the eager-buffer generator-expression fixture ran its
// body at creation (`iterations` already 1), and the legacy comparator's
// fake-NaN self-inequality made `isSameValue` vacuously TRUE over lie-boxed
// operands. With the #3032 lazy-first-resume fix the dstr canary stays green
// with the classifier force-enabled.
//
// (#2040 A1 DEFAULT-FLIP, 2026-07-16) The remaining #3032 waves landed
// (W3 TDZ-native-threading PR #3115, #3302 capturing expressions PR #3126,
// W4 method generators PR #3136), so the classifier is now DEFAULT-ON —
// `CLASSIFIER_ON` below is redundant but kept to document which cases need
// the classifier arms; the "default" cases at the bottom assert the flip.
const CLASSIFIER_ON = { tag5ValueEqClassifier: true };

describe("#2040/#2585 unified tag-5 field-4 equality classifier (standalone)", () => {
  // ── #2040 numeric branch ──────────────────────────────────────────────
  it("23 === 23.0 across any boxes is true", async () => {
    expect(
      await runStandalone(`export function main(): number { const a:any=23; const b:any=23.0; return (a===b)?1:0; }`),
    ).toBe(1);
  });

  // (#2141 S2) Flag-gated: the both-tags-5 numeric `f64.eq` classifier arm,
  // now in-tree behind `tag5ValueEqClassifier` (see header note).
  it("a !== a after a numeric op is false (a is a number, ===itself) — classifier ON", async () => {
    // 1/a forces `a` through the boxed-number tag-5 path; a!==a must be false.
    expect(
      await runStandalone(
        `function f(a:any){const _=1/a;return a!==a;} export function main(): number { return f(5)?1:0; }`,
        CLASSIFIER_ON,
      ),
    ).toBe(0);
  });

  it("boxed-number === boxed-number (post-op) is true — classifier ON", async () => {
    expect(
      await runStandalone(
        `function f(a:any,b:any){const x=a+0;const y=b+0;return x===y;} export function main(): number { return f(7,7)?1:0; }`,
        CLASSIFIER_ON,
      ),
    ).toBe(1);
  });

  it("(1/a) === (1/b) for equal a,b is true", async () => {
    expect(
      await runStandalone(
        `function f(a:any,b:any){return (1/a)===(1/b);} export function main(): number { return f(2,2)?1:0; }`,
      ),
    ).toBe(1);
  });

  // ── NaN contract (−788 preserved): NaN === NaN stays false ────────────
  it("NaN === NaN via any boxes is false (f64.eq self-false)", async () => {
    expect(
      await runStandalone(`export function main(): number { const a:any=NaN; const b:any=NaN; return (a===b)?1:0; }`),
    ).toBe(0);
  });

  it("NaN !== NaN is true", async () => {
    expect(await runStandalone(`export function main(): number { const a:any=NaN; return (a!==a)?1:0; }`)).toBe(1);
  });

  it("+0 === -0 is true", async () => {
    expect(
      await runStandalone(`export function main(): number { const a:any=0; const b:any=-0; return (a===b)?1:0; }`),
    ).toBe(1);
  });

  it("1 === 2 via any boxes is false", async () => {
    expect(
      await runStandalone(`export function main(): number { const a:any=1; const b:any=2; return (a===b)?1:0; }`),
    ).toBe(0);
  });

  // ── #2585 object proto-identity (ref.eq branch) — flag-gated (#2141 S2) ──
  it("getPrototypeOf(Object.create(p)) === p is true — classifier ON", async () => {
    expect(
      await runStandalone(
        `export function main(): number { const p:any={x:1}; const o=Object.create(p); return (Object.getPrototypeOf(o)===p)?1:0; }`,
        CLASSIFIER_ON,
      ),
    ).toBe(1);
  });

  it("same object via two reads === is true — classifier ON", async () => {
    expect(
      await runStandalone(
        `export function main(): number { const o:any={x:1}; const p:any=o; return (o===p)?1:0; }`,
        CLASSIFIER_ON,
      ),
    ).toBe(1);
  });

  it("two distinct objects === is false", async () => {
    expect(
      await runStandalone(
        `export function main(): number { const o:any={x:1}; const p:any={x:1}; return (o===p)?1:0; }`,
      ),
    ).toBe(0);
  });

  // ── loose-eq numeric (cross-tag arm tolerates boxed-number field-4) ───
  it("23 == 23.0 via any boxes is true (loose)", async () => {
    expect(
      await runStandalone(`export function main(): number { const a:any=23; const b:any=23.0; return (a==b)?1:0; }`),
    ).toBe(1);
  });

  // ── #2040 A1 default-flip: classifier semantics WITHOUT the option ─────
  it("DEFAULT: boxed-number self-eq is honest (a!==a false after 1/a)", async () => {
    expect(
      await runStandalone(
        `function f(a:any){const _=1/a;return a!==a;} export function main(): number { return f(5)?1:0; }`,
      ),
    ).toBe(0);
  });

  it("DEFAULT: object identity === via tag-5 boxes is true", async () => {
    expect(
      await runStandalone(
        `export function main(): number { const p:any={x:1}; const o=Object.create(p); return (Object.getPrototypeOf(o)===p)?1:0; }`,
      ),
    ).toBe(1);
  });

  it("OPT-OUT: tag5ValueEqClassifier:false is still honored (emits the legacy arm)", async () => {
    // The RESULT of this shape is identical either way on current main (the
    // operand is honestly boxed, so both regimes answer through the same
    // non-tag-5 path) — what this locks is the SEAM: the option must still
    // reach the emitter, so opting out produces a different `__any_*_eq`
    // helper body (legacy string-only arm) than the default (classifier
    // arms). Byte-compare the two modules to prove the flag is plumbed.
    const src = `function f(a:any){const _=1/a;return a!==a;} export function main(): number { return f(5)?1:0; }`;
    const on = await compile(src, { target: "standalone" } as never);
    const off = await compile(src, { target: "standalone", tag5ValueEqClassifier: false } as never);
    if (!on.success || !off.success) throw new Error("compile error in opt-out seam probe");
    expect(Buffer.compare(Buffer.from(on.binary), Buffer.from(off.binary))).not.toBe(0);
    // And the opt-out module still runs with the (shape-identical) result.
    const { instance } = await WebAssembly.instantiate(off.binary, {});
    expect((instance.exports as { main(): unknown }).main()).toBe(0);
  });

  it("HOST-LANE: the flip is byte-inert outside standalone/wasi", async () => {
    // The emit gate (any-helpers.ts tag5ValueEqThen) only builds the
    // classifier arms under standalone/wasi — a JS-host compile must be
    // byte-identical whether the option is on or off.
    const src = `function f(a:any){const _=1/a;return a!==a;} export function main(): number { return f(5)?1:0; }`;
    const on = await compile(src, { tag5ValueEqClassifier: true } as never);
    const off = await compile(src, { tag5ValueEqClassifier: false } as never);
    if (!on.success || !off.success) throw new Error("compile error in host-lane identity probe");
    expect(Buffer.compare(Buffer.from(on.binary), Buffer.from(off.binary))).toBe(0);
  });
});
