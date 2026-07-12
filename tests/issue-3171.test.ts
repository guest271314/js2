import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

// #3171 — standalone Map/Set/WeakMap/WeakSet receiver brand-check protocol.
//
// Spec §24.1.3.*/§24.2.4.*/§24.3.3.*/§24.4.3.* step 1/2: a prototype method
// invoked with a `this` lacking the right internal slot ([[MapData]] /
// [[SetData]] / [[WeakMapData]] / [[WeakSetData]]) throws a TypeError. Two
// layers land here:
//
//   1. The #2604 Set-only reflective `.call` dispatch is generalized to ALL
//      FOUR collections and ALL their prototype methods (data methods +
//      keys/values/entries + forEach) — collections-brand.ts, routing through
//      the shared `emitReceiverBrandCheck` preamble (receiver-brand.ts).
//   2. A trailing immutable COLLECTION_KIND tag on the shared `$Map` backing
//      struct (stamped by `__map_new` at every construction site) separates
//      the four brands, so wrong-brand-but-collection receivers
//      (`Map.prototype.get.call(new Set())`) also throw.
//
// The thrown error is a real catchable TypeError instance (ref.test →
// branch → throw; never a trapping ref.cast).

async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, { target: "standalone", skipSemanticDiagnostics: true } as never);
  if (!r.success) throw new Error("compile error: " + (r.errors?.[0]?.message ?? "unknown"));
  const io = r.importObject as WebAssembly.Imports & { __setExports?: (e: Record<string, unknown>) => void };
  const { instance } = await WebAssembly.instantiate(r.binary, io);
  io.__setExports?.(instance.exports as Record<string, unknown>);
  return (instance.exports as { test(): unknown }).test();
}

// 1 = TypeError thrown; 0 = no throw; 2 = wrong error type.
const throwsFor = (cls: string, method: string, recv: string, args = "") =>
  `export function test(): number {
     try { ${cls}.prototype.${method}.call(${recv} as any${args}); return 0; }
     catch (e: any) { return e instanceof TypeError ? 1 : 2; }
   }`;

describe("#3171 wrong-shape receivers throw TypeError (this-not-object / no-internal-slot rows)", () => {
  const rows: [cls: string, method: string, recv: string, args: string][] = [
    ["Map", "get", "{}", ", 1"],
    ["Map", "get", "[]", ", 1"],
    ["Map", "get", "null", ", 1"],
    ["Map", "get", "undefined", ", 1"],
    ["Map", "get", "''", ", 1"],
    ["Map", "get", "0", ", 1"],
    ["Map", "get", "false", ", 1"],
    ["Map", "set", "{}", ", 1, 2"],
    ["Map", "has", "undefined", ", 1"],
    ["Map", "delete", "1", ", 1"],
    ["Map", "keys", "{}", ""],
    ["Map", "values", "[]", ""],
    ["Map", "entries", "[]", ""],
    ["Map", "forEach", "null", ", function() {}"],
    ["Set", "entries", "Set.prototype", ""],
    ["Set", "entries", "{}", ""],
    ["Set", "values", "{}", ""],
    ["Set", "forEach", "{}", ", function() {}"],
    ["WeakMap", "get", "{}", ", {}"],
    ["WeakMap", "set", "0", ", {}, 1"],
    ["WeakMap", "has", "''", ", {}"],
    ["WeakMap", "delete", "null", ", {}"],
    ["WeakSet", "add", "{}", ", {}"],
    ["WeakSet", "has", "[]", ", {}"],
    ["WeakSet", "delete", "null", ", {}"],
  ];
  for (const [cls, method, recv, args] of rows) {
    it(`${cls}.prototype.${method}.call(${recv}) → TypeError`, async () => {
      expect(await runStandalone(throwsFor(cls, method, recv, args))).toBe(1);
    });
  }
});

describe("#3171 cross-collection receivers throw (COLLECTION_KIND tag)", () => {
  const rows: [cls: string, method: string, recv: string, args: string][] = [
    ["Map", "get", "new Set()", ", 1"],
    ["Map", "get", "new WeakMap()", ", 1"],
    ["Map", "entries", "new Set()", ""],
    ["Set", "add", "new Map()", ", 1"],
    ["Set", "has", "new WeakSet()", ", 1"],
    ["Set", "entries", "new Map()", ""],
    ["WeakMap", "set", "new Map()", ", {}, 1"],
    ["WeakSet", "add", "new Set()", ", {}"],
  ];
  for (const [cls, method, recv, args] of rows) {
    it(`${cls}.prototype.${method}.call(${recv}) → TypeError`, async () => {
      expect(await runStandalone(throwsFor(cls, method, recv, args))).toBe(1);
    });
  }
});

describe("#3171 instance-form reflective calls brand-check too", () => {
  it("m.get.call({}) → TypeError", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const m = new Map();
           try { m.get.call({} as any, 1); return 0; }
           catch (e: any) { return e instanceof TypeError ? 1 : 2; }
         }`,
      ),
    ).toBe(1);
  });
  it("ws.add.call(new Set(), {}) → TypeError", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const ws = new WeakSet();
           try { ws.add.call(new Set() as any, {}); return 0; }
           catch (e: any) { return e instanceof TypeError ? 1 : 2; }
         }`,
      ),
    ).toBe(1);
  });
});

describe("#3171 valid receivers still dispatch natively through .call", () => {
  it("Map.prototype.get.call(realMap, k)", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const m = new Map();
           m.set(1, 42);
           return Map.prototype.get.call(m, 1) as number;
         }`,
      ),
    ).toBe(42);
  });
  it("Set.prototype.has.call(realSet, v)", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const s = new Set([7]);
           return Set.prototype.has.call(s, 7) ? 1 : 0;
         }`,
      ),
    ).toBe(1);
  });
  it("WeakMap.prototype.get.call(realWeakMap, k)", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const k = {};
           const wm = new WeakMap();
           wm.set(k, 9);
           return WeakMap.prototype.get.call(wm, k) as number;
         }`,
      ),
    ).toBe(9);
  });
  it("Set.prototype.forEach.call(realSet, cb) drives the native loop", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const s = new Set([1, 2, 3]);
           let sum = 0;
           Set.prototype.forEach.call(s, function (v: number) { sum += v; });
           return sum;
         }`,
      ),
    ).toBe(6);
  });
  it("Map.prototype.set.call chains (returns the map)", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const m = new Map();
           Map.prototype.set.call(m, "a", 5);
           return m.get("a") as number;
         }`,
      ),
    ).toBe(5);
  });
});

describe("#3171 size accessor getter through gOPD brand-checks its receiver", () => {
  it("gOPD(Map.prototype,'size').get.call(map) works; .call(new Set()) throws", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const descriptor = Object.getOwnPropertyDescriptor(Map.prototype, 'size');
           const map = new Map();
           map.set(1, 2);
           if ((descriptor as any).get.call(map) !== 1) return 3;
           try { (descriptor as any).get.call(new Set()); return 0; }
           catch (e: any) { return e instanceof TypeError ? 1 : 2; }
         }`,
      ),
    ).toBe(1);
  });
  it("gOPD(Map.prototype,'size').get.call({}) throws", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const descriptor = Object.getOwnPropertyDescriptor(Map.prototype, 'size');
           try { (descriptor as any).get.call({}); return 0; }
           catch (e: any) { return e instanceof TypeError ? 1 : 2; }
         }`,
      ),
    ).toBe(1);
  });
  it("gOPD(Map.prototype,'size').get.call(false) throws (this-not-object)", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const descriptor = Object.getOwnPropertyDescriptor(Map.prototype, 'size');
           try { (descriptor as any).get.call(false); return 0; }
           catch (e: any) { return e instanceof TypeError ? 1 : 2; }
         }`,
      ),
    ).toBe(1);
  });
  it("gOPD(Set.prototype,'size').get.call(set) returns the size", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const descriptor = Object.getOwnPropertyDescriptor(Set.prototype, 'size');
           const s = new Set([1, 2, 3]);
           return (descriptor as any).get.call(s);
         }`,
      ),
    ).toBe(3);
  });
  it("direct m.size / s.size unregressed", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const m = new Map();
           m.set(1, 2);
           const s = new Set([1, 2]);
           return m.size + s.size;
         }`,
      ),
    ).toBe(3);
  });
});

describe("#3171 construction sites stamp the right COLLECTION_KIND (no collateral)", () => {
  it("direct map/set/weak ops unregressed", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const m = new Map();
           m.set("a", 1);
           const s = new Set([1, 2, 2]);
           const wm = new WeakMap();
           const k = {};
           wm.set(k, 5);
           const ws = new WeakSet();
           ws.add(k);
           return (m.get("a") as number) + s.size + (wm.get(k) as number) + (ws.has(k) ? 1 : 0);
         }`,
      ),
    ).toBe(9);
  });
  it("set-algebra result is Set-branded (usable as a Set receiver)", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const a = new Set([1, 2]);
           const u = a.union(new Set([3]));
           return (Set.prototype.has.call(u, 3) ? 1 : 0) + u.size;
         }`,
      ),
    ).toBe(4);
  });
  it("Map.groupBy result is Map-branded (rejects Set methods)", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const g = Map.groupBy([1, 2, 3], (x: number) => (x % 2 === 0 ? "e" : "o"));
           try { Set.prototype.has.call(g as any, "o"); return 0; }
           catch (e: any) { return e instanceof TypeError ? 1 : 2; }
         }`,
      ),
    ).toBe(1);
  });
});
