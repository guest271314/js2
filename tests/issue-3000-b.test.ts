// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3000-B — IR class-member accessors (get/set).
//
// Phase 1a (#3000, PR #2597) taught the selector + AST→IR lowerer to accept
// `this.#x` private-field READ / WRITE. This slice claims + lowers get/set
// ACCESSORS over that (now-supported) slot:
//
//   - Selector (`src/ir/select.ts`): a flat-class INSTANCE get/set accessor is
//     no longer bucketed `class-method`. Each is claimed under the SAME
//     `${Class}_get_${prop}` / `${Class}_set_${prop}` funcMap key the legacy
//     `class-bodies.ts` pass registers (a getter and a setter of the same name
//     are two DISTINCT slots, not a collapsed one). Static accessors and
//     accessors on an `extends` subclass stay `class-method` (Phase E).
//   - AST→IR (`src/ir/from-ast.ts`): `lowerFunctionAstToIr` accepts accessor
//     nodes — a getter lowers like a no-arg method returning `fn.type`; a
//     setter like a one-arg VOID method. The setter body's lone `this.#x = v;`
//     is a void-tail property store, newly accepted by `isPhase1Tail` and
//     lowered through the SAME `lowerPropertyAssignment` the non-tail path uses
//     (select↔build parity).
//   - Integration (`src/ir/integration.ts`): the Phase B member walk builds
//     accessor declarations alongside methods, mapping to the legacy accessor
//     funcMap key and forcing a void return for setters.
//
// Non-vacuity: for a class whose fields PROJECT into an `IrClassShape`
// (numeric / boolean / object fields), the accessor bodies genuinely IR-emit
// and the runtime tests below exercise those IR-emitted bodies (compileSource
// defaults `experimentalIR` on). Classes with a `string` field do not yet get
// an `IrClassShape` (`valTypeToIrField` defers string fields — index.ts) so
// their members — accessors, methods AND the ctor alike — stay byte-inert on
// legacy; that shape-substrate gap blocks all of #3000 for string-field
// classes and is banked as a follow-up (see the issue's Implementation Notes).

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { planIrCompilation } from "../src/ir/select.js";
import { compileAndInstantiate } from "../src/runtime-instantiate.js";

function selection(source: string) {
  const sf = ts.createSourceFile("test.ts", source, ts.ScriptTarget.Latest, true);
  return planIrCompilation(sf, { experimentalIR: true, trackFallbacks: true });
}

// Numeric-only flat class — every field projects, so `buildIrClassShapes`
// produces a shape and the accessor bodies genuinely lower through IR.
const COUNTER = `
  class Counter {
    #n: number;
    constructor(start: number) { this.#n = start; }
    get value(): number { return this.#n; }
    set value(v: number) { this.#n = v; }
    bump(): number { return this.#n + 1; }
  }
`;

describe("#3000-B — IR accessor selection", () => {
  it("claims a flat-class instance getter and setter under distinct get_/set_ keys", () => {
    const sel = selection(COUNTER);
    const claimed = new Set(sel.classMembers ?? []);
    expect(claimed.has("Counter_get_value")).toBe(true);
    expect(claimed.has("Counter_set_value")).toBe(true);
  });

  it("get+set of the same name claim independently (not collapsed)", () => {
    const sel = selection(COUNTER);
    const reasons = new Map<string, string>();
    for (const fb of sel.fallbacks ?? []) reasons.set(fb.name, fb.reason);
    // Neither survives as a `class-method` fallback.
    expect(reasons.get("Counter_get_value")).toBeUndefined();
    expect(reasons.get("Counter_set_value")).toBeUndefined();
    expect(reasons.get("Counter_value")).toBeUndefined(); // no collapsed key
  });

  it("a getter-only accessor claims the getter and no phantom setter", () => {
    const sel = selection(`
      class Ro { #x: number; constructor(x: number) { this.#x = x; } get x(): number { return this.#x; } }
    `);
    const claimed = new Set(sel.classMembers ?? []);
    expect(claimed.has("Ro_get_x")).toBe(true);
    expect(claimed.has("Ro_set_x")).toBe(false);
  });

  it("defers a static accessor to class-method (no self-injection path yet)", () => {
    const sel = selection(`
      class S { static #c: number; static get count(): number { return S.#c; } }
    `);
    const claimed = new Set(sel.classMembers ?? []);
    expect(claimed.has("S_get_count")).toBe(false);
    const reasons = new Map<string, string>();
    for (const fb of sel.fallbacks ?? []) reasons.set(fb.name, fb.reason);
    expect(reasons.get("S_get_count")).toBe("class-method");
  });

  it("claims an accessor on an `extends`-of-local-class subclass (#3000-E landed Phase E)", () => {
    const sel = selection(`
      class Base { #n: number; constructor(n: number) { this.#n = n; } get n(): number { return this.#n; } }
      class Sub extends Base { #m: number; constructor(n: number, m: number) { super(n); this.#m = m; } get m(): number { return this.#m; } }
    `);
    const claimed = new Set(sel.classMembers ?? []);
    // #3000-E: the parent (`Base`) is a local user class, so the subclass getter
    // is now CLAIMED alongside the flat Base getter (was deferred pre-#3000-E).
    expect(claimed.has("Base_get_n")).toBe(true);
    expect(claimed.has("Sub_get_m")).toBe(true);
    const reasons = new Map<string, string>();
    for (const fb of sel.fallbacks ?? []) reasons.set(fb.name, fb.reason);
    expect(reasons.get("Sub_get_m")).toBeUndefined();
  });
});

describe("#3000-B — IR accessor emission has no post-claim demotion", () => {
  it("compiles the numeric accessor class with no post-claim error for the accessor slots", async () => {
    const src = `${COUNTER}\n export function test(): number { const c = new Counter(3); return c.bump(); }`;
    const r = await compile(src, { fileName: "test.ts", experimentalIR: true });
    expect(r.success).toBe(true);
    const bad = (r.irPostClaimErrors ?? []).filter(
      (e) => e.func === "Counter_get_value" || e.func === "Counter_set_value",
    );
    // A CLAIMED accessor that failed build/verify/lower/parity would surface
    // here; empty ⇒ both slots were patched with their IR-lowered bodies.
    expect(bad).toEqual([]);
  });
});

describe("#3000-B — IR accessor runtime behaviour", () => {
  it("get + set round-trip through the IR-emitted accessor bodies", async () => {
    // `test` reads via the getter, writes via the setter, reads again. The
    // accessor bodies are IR-emitted (numeric field ⇒ IrClassShape exists);
    // callers dispatch to those patched slots.
    const exports = await compileAndInstantiate(`
      ${COUNTER}
      export function readInit(): number { const c = new Counter(10); return c.value; }
      export function afterSet(): number { const c = new Counter(10); c.value = 25; return c.value; }
      export function viaBump(): number { const c = new Counter(41); return c.bump(); }
    `);
    expect((exports.readInit as () => number)()).toBe(10); // getter
    expect((exports.afterSet as () => number)()).toBe(25); // setter (void tail) then getter
    expect((exports.viaBump as () => number)()).toBe(42); // private read in a method, same slot
  });

  it("setter with a computed RHS (void-tail property store) works", async () => {
    const exports = await compileAndInstantiate(`
      class Acc {
        #total: number;
        constructor() { this.#total = 0; }
        get total(): number { return this.#total; }
        set total(v: number) { this.#total = v * 2 + 1; }
      }
      export function run(): number { const a = new Acc(); a.total = 20; return a.total; }
    `);
    expect((exports.run as () => number)()).toBe(41); // 20*2+1
  });
});
