import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

// #3172 — standalone ES2025 keyed-collection additions:
//   (a) Map/WeakMap getOrInsert + getOrInsertComputed (emplace) over the
//       shared $Map, with spec ordering (presence check before the callback,
//       canonical -0→+0 keys, throw propagation with no state change,
//       overwrite-after-callback) and the WeakMap CanBeHeldWeakly key gate;
//   (b) GetSetRecord (§24.2.1.2) + set-LIKE set-algebra arguments — the
//       #2162 native kernels stay the fast lane for real collections, while
//       a `{size, has, keys}` object drives the spec algorithm through
//       runtime `__setlike_*` kernels (keys() via the native iterator
//       substrate, has() via __apply_closure) in the spec's size-dependent
//       access patterns. GetSetRecord coercion throws: absent/NaN/BigInt/
//       non-numeric-string sizes → TypeError; object sizes run valueOf once.
//   (c) Receiver brand checks ride #3171's shared gate (receiver-brand.ts).

async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, { target: "standalone", skipSemanticDiagnostics: true } as never);
  if (!r.success) throw new Error("compile error: " + (r.errors?.[0]?.message ?? "unknown"));
  const io = r.importObject as WebAssembly.Imports & { __setExports?: (e: Record<string, unknown>) => void };
  const { instance } = await WebAssembly.instantiate(r.binary, io);
  io.__setExports?.(instance.exports as Record<string, unknown>);
  return (instance.exports as { test(): unknown }).test();
}

describe("#3172 Map.getOrInsert / getOrInsertComputed", () => {
  it("absent inserts + returns; present returns stored", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const m = new Map();
           const a = m.getOrInsert(1, 10) as number;
           const b = m.getOrInsert(1, 99) as number;
           return a + b + m.size;
         }`,
      ),
    ).toBe(21);
  });
  it("normalizes -0 key to +0", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const m = new Map();
           m.getOrInsert(-0, 5);
           return (m.has(0) ? 1 : 0) + (m.getOrInsert(0, 99) as number);
         }`,
      ),
    ).toBe(6);
  });
  it("computed: callback only when absent", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const m = new Map();
           let calls = 0;
           const v1 = m.getOrInsertComputed("k", function (k: any) { calls++; return 7; }) as number;
           const v2 = m.getOrInsertComputed("k", function (k: any) { calls++; return 8; }) as number;
           return v1 + v2 + calls;
         }`,
      ),
    ).toBe(15);
  });
  it("computed: callback throw propagates with no state change", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const m = new Map();
           try {
             m.getOrInsertComputed(1, function (): number { throw new TypeError("boom"); });
             return 0;
           } catch (e: any) {
             return (e instanceof TypeError ? 1 : 2) + (m.size === 0 ? 10 : 20);
           }
         }`,
      ),
    ).toBe(11);
  });
  it("computed: overwrites callback mutation", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const m = new Map();
           const v = m.getOrInsertComputed("a", function (): number { m.set("a", 1); return 2; }) as number;
           return v + (m.get("a") as number);
         }`,
      ),
    ).toBe(4);
  });
  it("computed: canonical -0 key passed to callback", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const m = new Map();
           let ok = 0;
           m.getOrInsertComputed(-0, function (k: any): number { ok = Object.is(k, 0) ? 1 : 0; return 3; });
           return ok;
         }`,
      ),
    ).toBe(1);
  });
  it("computed: non-callable callback → TypeError", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const m = new Map();
           try { m.getOrInsertComputed(1, 5 as any); return 0; }
           catch (e: any) { return e instanceof TypeError ? 1 : 2; }
         }`,
      ),
    ).toBe(1);
  });
});

describe("#3172 WeakMap.getOrInsert(Computed)", () => {
  it("object key emplace", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const wm = new WeakMap();
           const k = {};
           const a = wm.getOrInsert(k, 4) as number;
           const b = wm.getOrInsert(k, 9) as number;
           return a + b;
         }`,
      ),
    ).toBe(8);
  });
  it("primitive key → TypeError (CanBeHeldWeakly)", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const wm = new WeakMap();
           try { wm.getOrInsert(1 as any, 4); return 0; }
           catch (e: any) { return e instanceof TypeError ? 1 : 2; }
         }`,
      ),
    ).toBe(1);
  });
});

describe("#3172 getOrInsert reflective brand rows", () => {
  it("Map.prototype.getOrInsert.call({}) → TypeError", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           try { (Map.prototype as any).getOrInsert.call({}, 1, 1); return 0; }
           catch (e: any) { return e instanceof TypeError ? 1 : 2; }
         }`,
      ),
    ).toBe(1);
  });
  it("Map.prototype.getOrInsert.call(new Set()) → TypeError (cross-brand)", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           try { (Map.prototype as any).getOrInsert.call(new Set(), 1, 1); return 0; }
           catch (e: any) { return e instanceof TypeError ? 1 : 2; }
         }`,
      ),
    ).toBe(1);
  });
  it("typeof Map.prototype.getOrInsert === 'function' (proto value read)", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           return typeof (Map.prototype as any).getOrInsert === "function" ? 1 : 0;
         }`,
      ),
    ).toBe(1);
  });
});

describe("#3172 set-algebra with set-LIKE arguments", () => {
  it("union drives keys() only", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const s1 = new Set([1, 2]);
           const s2 = { size: 2, has: (x: any) => false, keys: function () { return [2, 3].values(); } };
           const combined = s1.union(s2 as any);
           return combined.size + (combined.has(3) ? 10 : 0);
         }`,
      ),
    ).toBe(13);
  });
  it("union normalizes a -0 element from keys() to +0", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const sl = { size: 1, has: () => false, keys: function () { return [-0].values(); } };
           const s1 = new Set([1]);
           const c = s1.union(sl as any);
           return (c.has(0) ? 1 : 0) + c.size * 10;
         }`,
      ),
    ).toBe(21);
  });
  it("intersection uses has() when thisSize <= argSize", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const s1 = new Set([1, 2, 3]);
           const sl = { size: 5, has: (x: number) => x === 2, keys: function (): any { throw new Error("no keys"); } };
           const c = s1.intersection(sl as any);
           return c.size + (c.has(2) ? 10 : 0);
         }`,
      ),
    ).toBe(11);
  });
  it("difference uses keys() when thisSize > argSize", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const s1 = new Set([1, 2, 3]);
           const sl = { size: 1, has: (): boolean => { throw new Error("no has"); }, keys: function () { return [2].values(); } };
           const c = s1.difference(sl as any);
           return c.size + (c.has(2) ? 100 : 0);
         }`,
      ),
    ).toBe(2);
  });
  it("symmetricDifference toggles via keys()", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const s1 = new Set([1, 2]);
           const sl = { size: 2, has: () => false, keys: function () { return [2, 3].values(); } };
           const c = s1.symmetricDifference(sl as any);
           return c.size + (c.has(1) ? 10 : 0) + (c.has(3) ? 100 : 0) + (c.has(2) ? 1000 : 0);
         }`,
      ),
    ).toBe(112);
  });
  it("isSubsetOf uses has() only", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const s1 = new Set([1, 2]);
           const yes = { size: 5, has: () => true, keys: function (): any { throw new Error("no keys"); } };
           const no = { size: 5, has: (x: number) => x !== 2, keys: function (): any { throw new Error("no keys"); } };
           return (s1.isSubsetOf(yes as any) ? 1 : 0) + (s1.isSubsetOf(no as any) ? 10 : 0);
         }`,
      ),
    ).toBe(1);
  });
  it("isSupersetOf uses keys() only", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const s1 = new Set([1, 2, 3]);
           const sub = { size: 2, has: () => true, keys: function () { return [1, 2].values(); } };
           const notsub = { size: 2, has: () => true, keys: function () { return [1, 9].values(); } };
           return (s1.isSupersetOf(sub as any) ? 1 : 0) + (s1.isSupersetOf(notsub as any) ? 10 : 0);
         }`,
      ),
    ).toBe(1);
  });
  it("isDisjointFrom uses has() when thisSize <= argSize", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const s1 = new Set([1, 2]);
           const dj = { size: 5, has: () => false, keys: function (): any { throw new Error("nk"); } };
           const ndj = { size: 5, has: (x: number) => x === 1, keys: function (): any { throw new Error("nk"); } };
           return (s1.isDisjointFrom(dj as any) ? 1 : 0) + (s1.isDisjointFrom(ndj as any) ? 10 : 0);
         }`,
      ),
    ).toBe(1);
  });
});

describe("#3172 GetSetRecord size coercion", () => {
  const throwsFor = (sizeExpr: string) =>
    `export function test(): number {
       const s1 = new Set([1]);
       try { s1.union({ size: ${sizeExpr}, has: () => false, keys: () => [].values() } as any); return 0; }
       catch (e: any) { return e instanceof TypeError ? 1 : 2; }
     }`;
  it("NaN size → TypeError", async () => {
    expect(await runStandalone(throwsFor("NaN"))).toBe(1);
  });
  it("non-numeric string size → TypeError", async () => {
    expect(await runStandalone(throwsFor("'string'"))).toBe(1);
  });
  it("missing size → TypeError", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const s1 = new Set([1]);
           try { s1.union({ has: () => false, keys: () => [].values() } as any); return 0; }
           catch (e: any) { return e instanceof TypeError ? 1 : 2; }
         }`,
      ),
    ).toBe(1);
  });
  it("object size runs valueOf exactly once", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           let calls = 0;
           const s1 = new Set([1]);
           const sl = { size: { valueOf: function () { calls++; return 1; } }, has: () => false, keys: function () { return [5].values(); } };
           const c = s1.union(sl as any);
           return calls + c.size * 10;
         }`,
      ),
    ).toBe(21);
  });
});

describe("#3172 GetSetRecord IsCallable gate (steps 8/10)", () => {
  it("has: undefined → TypeError (even when the algorithm would not call has)", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const s1 = new Set([1, 2]);
           const s2 = { size: 2, has: undefined, keys: function () { return [2].values(); } };
           try { s1.union(s2 as any); return 0; }
           catch (e: any) { return e instanceof TypeError ? 1 : 2; }
         }`,
      ),
    ).toBe(1);
  });
  it("keys: non-callable object → TypeError", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const s1 = new Set([1, 2]);
           const s2 = { size: 2, has: () => true, keys: {} };
           try { s1.isSubsetOf(s2 as any); return 0; }
           catch (e: any) { return e instanceof TypeError ? 1 : 2; }
         }`,
      ),
    ).toBe(1);
  });
});

describe("#3172 Map argument is set-like per spec (keys projection)", () => {
  it("union with a real Map combines the Map's KEYS", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const s = new Set([1]);
           const m = new Map();
           m.set(7, "v" as any);
           const c = s.union(m as any);
           return (c.has(7) ? 1 : 0) + (c.has("v" as any) ? 100 : 0) + c.size * 10;
         }`,
      ),
    ).toBe(21);
  });
});

describe("#3172 value-erased reflective form (require-internal-slot harness shape)", () => {
  it("const union = Set.prototype.union; union.call(nonSet) → TypeError", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const union = (Set.prototype as any).union;
           let n = 0;
           const realSet = new Set([]);
           try { union.call(undefined, realSet); } catch (e: any) { if (e instanceof TypeError) n++; }
           try { union.call({}, realSet); } catch (e: any) { if (e instanceof TypeError) n++; }
           try { union.call(new Map(), realSet); } catch (e: any) { if (e instanceof TypeError) n++; }
           return n;
         }`,
      ),
    ).toBe(3);
  });
});

describe("#3172 fast lane + brand rows unregressed", () => {
  it("real-Set operands keep the native kernels", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const a = new Set([1, 2]);
           const b = new Set([2, 3]);
           return a.union(b).size + (a.intersection(b).has(2) ? 10 : 0) + (a.isSubsetOf(new Set([1, 2, 9])) ? 100 : 0);
         }`,
      ),
    ).toBe(113);
  });
  it("non-object argument still throws TypeError", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const a = new Set([1]);
           try { a.union(1 as any); return 0; }
           catch (e: any) { return e instanceof TypeError ? 1 : 2; }
         }`,
      ),
    ).toBe(1);
  });
  it("Set.prototype.union.call(setLike) → TypeError (receiver brand, #3171 gate)", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const sl = { size: 2, has: () => false, keys: function () { return [2].values(); } };
           try { (Set.prototype as any).union.call(sl, new Set()); return 0; }
           catch (e: any) { return e instanceof TypeError ? 1 : 2; }
         }`,
      ),
    ).toBe(1);
  });
  it("Set.prototype.union.call(new Map()) → TypeError (cross-brand)", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           try { (Set.prototype as any).union.call(new Map(), new Set()); return 0; }
           catch (e: any) { return e instanceof TypeError ? 1 : 2; }
         }`,
      ),
    ).toBe(1);
  });
  it("Set.prototype.union.call(realSet, realSet) works", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const a = new Set([1]);
           const b = new Set([2]);
           const c: Set<number> = (Set.prototype as any).union.call(a, b);
           return c.size;
         }`,
      ),
    ).toBe(2);
  });
});
