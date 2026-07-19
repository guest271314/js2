// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #745 S4.5 — known heterogeneous primitive unions on the `$AnyValue` carrier,
 * now the LANE DEFAULT for native-string lanes.
 *
 * As of the S4.5 default-flip (`create-context.ts`), `unionAnyRep` is derived
 * from the lane: ON for native-string lanes (standalone / wasi / fast /
 * strictNoHostImports / explicit `nativeStrings`), OFF for the JS-host lane
 * (until S5, hard-gated on #2141). The explicit `unionAnyRep` option still
 * overrides the lane default, and the `JS2WASM_UNION_ANYREP=0` env kill-switch
 * forces the legacy externref regime for A/B control (mirrors #2106).
 *
 * Guards:
 *   1. HOST lane stays default-OFF — explicit false === unset, even for
 *      union-bearing input (the S5 gate is still closed).
 *   2. STANDALONE lane is default-ON — unset === explicit true; explicit
 *      false differs (opt-out is live); the env kill-switch ≡ explicit false.
 *   3. Default-ON with union-FREE input is byte-identical to explicit-off:
 *      the `resolveWasmType` mapping only fires on heterogeneous primitive
 *      union types (see decision 4 for the revised neutrality invariant).
 *   4. Behaviour (S2 narrowing / S3 carrier-agnostic consumers / S4
 *      params-returns-any-boundary) is correct on the DEFAULT native lane —
 *      the run() helpers no longer pass the flag; one explicit-flag case per
 *      suite proves the option is still honored.
 *   5. A wasi-lane smoke confirms the flip reaches wasi and emits no
 *      env.__box_ / __unbox_ / __typeof_ host import.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { isHeterogeneousPrimitiveUnion } from "../src/checker/type-mapper.js";
import { ts } from "../src/ts-api.js";

const HET_UNION_SRC = `export function test(): number {
  let x: number | string = 5;
  let sum = 0;
  for (let i = 0; i < 3; i++) {
    if (i === 2) x = "done";
    if (typeof x === "number") sum += x + 1;
  }
  return sum === 12 ? 1 : 0;
}`;

const UNION_FREE_SRC = `export function test(): number {
  let a = 1;
  let s = "x";
  for (let i = 0; i < 5; i++) a += i;
  return a === 11 && s.length === 1 ? 1 : 0;
}`;

async function binaryOf(src: string, opts: object): Promise<Uint8Array> {
  const r = await compile(src, { fileName: "t.ts", ...opts });
  expect(r.success).toBe(true);
  return r.binary!;
}

describe("#745 S4.5 — host lane stays default-OFF (S5 gate still closed)", () => {
  it("union-bearing input, default (host) lane: explicit false === unset", async () => {
    const off = await binaryOf(HET_UNION_SRC, {});
    const explicit = await binaryOf(HET_UNION_SRC, { unionAnyRep: false });
    expect(Buffer.from(explicit).equals(Buffer.from(off))).toBe(true);
  });
});

describe("#745 S4.5 — standalone lane is default-ON (the flip)", () => {
  it("standalone lane: unset === explicit true (default-on proof)", async () => {
    const unset = await binaryOf(HET_UNION_SRC, { target: "standalone" });
    const on = await binaryOf(HET_UNION_SRC, {
      target: "standalone",
      unionAnyRep: true,
    });
    expect(Buffer.from(unset).equals(Buffer.from(on))).toBe(true);
  });

  it("standalone lane: explicit false !== unset on union-bearing input (opt-out is live)", async () => {
    const unset = await binaryOf(HET_UNION_SRC, { target: "standalone" });
    const off = await binaryOf(HET_UNION_SRC, {
      target: "standalone",
      unionAnyRep: false,
    });
    expect(Buffer.from(unset).equals(Buffer.from(off))).toBe(false);
  });

  it("env kill-switch: JS2WASM_UNION_ANYREP=0 ≡ explicit false", async () => {
    // The env var is read once per compile at ctx creation (no cross-compile
    // caching), so an in-process set/restore is safe for this A/B comparison.
    // Computed-member `delete` (not a `= undefined` write, which Node coerces
    // to the string "undefined") — mirrors tests/issue-2956.test.ts.
    const FLAG = "JS2WASM_UNION_ANYREP";
    const prev = process.env[FLAG];
    const restore = () => {
      if (prev === undefined) delete process.env[FLAG];
      else process.env[FLAG] = prev;
    };
    try {
      process.env[FLAG] = "0";
      const killed = await binaryOf(HET_UNION_SRC, { target: "standalone" });
      // Compile the explicit-false reference with the env restored so only the
      // kill-switch path is under test.
      restore();
      const off = await binaryOf(HET_UNION_SRC, {
        target: "standalone",
        unionAnyRep: false,
      });
      expect(Buffer.from(killed).equals(Buffer.from(off))).toBe(true);
    } finally {
      restore();
    }
  });
});

describe("#745 S4.5 — union-free input stays byte-identical under the flip", () => {
  // Revised neutrality invariant (decision 4): byte-identity to the legacy
  // regime holds for native-lane modules that are union-free AND never emit
  // `__any_unbox_bool`. Do NOT add an any-truthiness-using-but-union-free
  // fixture here — the tag-5 truthiness arm and honest tag-4 boolean boxing
  // are intended module-wide drift classes and would (correctly) break the
  // byte-identity these cases assert.
  it("default lane", async () => {
    const off = await binaryOf(UNION_FREE_SRC, {});
    const on = await binaryOf(UNION_FREE_SRC, { unionAnyRep: true });
    expect(Buffer.from(on).equals(Buffer.from(off))).toBe(true);
  });

  it("standalone lane: explicit false === unset (default-on is a no-op with no union)", async () => {
    const off = await binaryOf(UNION_FREE_SRC, {
      target: "standalone",
      unionAnyRep: false,
    });
    const unset = await binaryOf(UNION_FREE_SRC, { target: "standalone" });
    expect(Buffer.from(unset).equals(Buffer.from(off))).toBe(true);
  });

  it("nullable single-kind + literal-union input stays byte-identical (mapping must not fire)", async () => {
    const src = `type Mode = "a" | "b";
export function test(): number {
  let x: number | null = 5;
  let m: Mode = "a";
  m = "b";
  if (x !== null) return m === "b" ? x - 4 : 0;
  return 0;
}`;
    const off = await binaryOf(src, {
      target: "standalone",
      unionAnyRep: false,
    });
    const unset = await binaryOf(src, { target: "standalone" });
    expect(Buffer.from(unset).equals(Buffer.from(off))).toBe(true);
  });
});

describe("#745 S4.5 — wasi lane smoke (flip reaches wasi, no host box imports)", () => {
  it('HET_UNION_SRC under { target: "wasi" } compiles and emits no env.__box_/__unbox_/__typeof_ import', async () => {
    const r = await compile(HET_UNION_SRC, {
      fileName: "t.ts",
      target: "wasi",
    });
    expect(r.success).toBe(true);
    const mod = new WebAssembly.Module(r.binary!);
    const leaks = WebAssembly.Module.imports(mod).filter((imp) => /^__(box|unbox|typeof)_/.test(imp.name));
    expect(leaks).toEqual([]);
  });
});

describe("#745 S2 — default native lane, narrowed union behaviour", () => {
  // run() proves the DEFAULT (flag unset). One explicit-flag case below keeps
  // the option honored.
  async function run(src: string): Promise<unknown> {
    const r = await compile(src, { fileName: "t.ts", target: "standalone" });
    expect(r.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary!, {});
    return (instance.exports as { test?: () => unknown }).test?.();
  }

  it("number|string local: typeof-narrowed arithmetic after cross-kind write", async () => {
    expect(await run(HET_UNION_SRC)).toBe(1);
  });

  it("string|number local: narrowed .length read", async () => {
    expect(
      await run(`export function test(): number {
  let x: string | number = "hi";
  if (typeof x === "string") return x.length === 2 ? 1 : 0;
  return 0;
}`),
    ).toBe(1);
  });

  it("number|string|undefined local: undefined round-trip + narrowing", async () => {
    expect(
      await run(`export function test(): number {
  let x: number | string | undefined = undefined;
  let n = 0;
  if (x === undefined) n += 1;
  x = 3;
  if (typeof x === "number") n += x;
  x = "s";
  if (x !== undefined) n += 10;
  return n === 14 ? 1 : 0;
}`),
    ).toBe(1);
  });

  it("explicit unionAnyRep:true still honored (option overrides lane default)", async () => {
    const r = await compile(HET_UNION_SRC, {
      fileName: "t.ts",
      target: "standalone",
      unionAnyRep: true,
    });
    expect(r.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary!, {});
    expect((instance.exports as { test?: () => unknown }).test?.()).toBe(1);
  });

  it("standalone module on the default lane stays host-import-free", async () => {
    const r = await compile(HET_UNION_SRC, {
      fileName: "t.ts",
      target: "standalone",
    });
    expect(r.success).toBe(true);
    // instantiate with an EMPTY import object — any env/__box_* leak throws.
    await expect(WebAssembly.instantiate(r.binary!, {})).resolves.toBeDefined();
  });
});

describe("#745 S2 — isHeterogeneousPrimitiveUnion predicate", () => {
  function typeOfLocal(decl: string): ts.Type {
    const full = `${decl}\nexport const __keep = 1;`;
    const sf = ts.createSourceFile("t.ts", full, ts.ScriptTarget.Latest, true);
    const host = ts.createCompilerHost({ strict: true });
    const getSourceFile = host.getSourceFile.bind(host);
    host.getSourceFile = (name, ...rest) => (name === "t.ts" ? sf : getSourceFile(name, ...rest));
    const program = ts.createProgram(["t.ts"], { strict: true }, host);
    const checker = program.getTypeChecker();
    const file = program.getSourceFile("t.ts")!;
    // The `x` declaration may be preceded by helper declarations (enum E, …).
    const stmt = file.statements.find(
      (s): s is ts.VariableStatement =>
        ts.isVariableStatement(s) &&
        s.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && d.name.text === "x"),
    )!;
    const d = stmt.declarationList.declarations[0]!;
    return checker.getTypeAtLocation(d.name);
  }

  it("accepts heterogeneous primitive unions", { timeout: 120_000 }, () => {
    expect(isHeterogeneousPrimitiveUnion(typeOfLocal("let x: number | string;"))).toBe(true);
    expect(isHeterogeneousPrimitiveUnion(typeOfLocal("let x: string | boolean;"))).toBe(true);
    expect(isHeterogeneousPrimitiveUnion(typeOfLocal("let x: number | string | undefined;"))).toBe(true);
    expect(isHeterogeneousPrimitiveUnion(typeOfLocal("let x: number | string | null;"))).toBe(true);
  });

  it("rejects homogeneous / nullable / non-primitive shapes", { timeout: 120_000 }, () => {
    expect(isHeterogeneousPrimitiveUnion(typeOfLocal("let x: number | null;"))).toBe(false);
    expect(isHeterogeneousPrimitiveUnion(typeOfLocal('let x: "a" | "b";'))).toBe(false);
    expect(isHeterogeneousPrimitiveUnion(typeOfLocal("let x: 0 | 2;"))).toBe(false);
    expect(isHeterogeneousPrimitiveUnion(typeOfLocal("let x: boolean;"))).toBe(false);
    expect(isHeterogeneousPrimitiveUnion(typeOfLocal("let x: number | bigint;"))).toBe(false);
    expect(isHeterogeneousPrimitiveUnion(typeOfLocal("let x: number | symbol;"))).toBe(false);
    expect(isHeterogeneousPrimitiveUnion(typeOfLocal("let x: number | { a: number };"))).toBe(false);
    expect(isHeterogeneousPrimitiveUnion(typeOfLocal("let x: number | string[];"))).toBe(false);
    expect(isHeterogeneousPrimitiveUnion(typeOfLocal("enum E { A, B }\nlet x: E | string;"))).toBe(false);
    expect(isHeterogeneousPrimitiveUnion(typeOfLocal("let x: number;"))).toBe(false);
    expect(isHeterogeneousPrimitiveUnion(typeOfLocal("let x: any;"))).toBe(false);
  });
});

// ───────────────────────────── S3 ─────────────────────────────
// Carrier-agnostic consumers (strict-eq / truthiness / string concat) for
// `$AnyValue`-repped union locals — now on the DEFAULT native lane.
describe("#745 S3 — default native lane, carrier-agnostic consumers", () => {
  async function run(src: string): Promise<unknown> {
    const r = await compile(src, { fileName: "t.ts", target: "standalone" });
    expect(r.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary!, {});
    return (instance.exports as { test?: () => unknown }).test?.();
  }

  it("strict-eq: narrowed union local vs string literal (assignment narrowing)", async () => {
    expect(
      await run(`export function test(): number {
  let x: number | string = 5; x = "done"; return x === "done" ? 1 : 0;
}`),
    ).toBe(1);
  });

  it("strict-eq: UN-narrowed union local vs string / number literals", async () => {
    expect(
      await run(`export function test(): number {
  let x: number | string = 5;
  for (let i = 0; i < 2; i++) if (i === 1) x = "done";
  let n = 0;
  if (x === "done") n += 1;
  if (x !== 5) n += 2;
  return n === 3 ? 1 : 0;
}`),
    ).toBe(1);
  });

  it("strict-eq: union local vs union local (content equality)", async () => {
    expect(
      await run(`export function test(): number {
  let x: number | string = 5; let y: number | string = 5;
  let n = x === y ? 1 : 0;
  if (1) { x = "k"; y = "k"; }
  return n + (x === y ? 1 : 0) === 2 ? 1 : 0;
}`),
    ).toBe(1);
  });

  it("strict-eq: boolean|string union vs true (tag-4 box hint)", async () => {
    expect(
      await run(`export function test(): number {
  let x: boolean | string = true; let n = 0;
  if (x === true) n += 1;
  x = "y";
  if (x === "y") n += 2;
  return n === 3 ? 1 : 0;
}`),
    ).toBe(1);
  });

  it("truthiness: empty string falsy, non-empty truthy, 0 falsy (tag-5 arm)", async () => {
    expect(
      await run(`export function test(): number {
  let x: number | string = 0; let n = 0;
  if (x) n += 1;
  x = "a";
  if (x) n += 2;
  x = "";
  if (x) n += 4;
  return n === 2 ? 1 : 0;
}`),
    ).toBe(1);
  });

  it("concat: union local on both narrowing shapes ('' + num-narrowed, str + str-narrowed)", async () => {
    expect(
      await run(`export function test(): number {
  let x: number | string = 1;
  let s = "" + x;
  x = "b";
  s = s + x;
  return s === "1b" ? 1 : 0;
}`),
    ).toBe(1);
  });

  it("nullish comparisons keep working after the eq routing (regression guard)", async () => {
    expect(
      await run(`export function test(): number {
  let x: number | string | undefined = undefined; let n = 0;
  if (x === undefined) n += 1;
  x = 3;
  if (typeof x === "number") n += x;
  x = "s";
  if (x !== undefined) n += 10;
  return n === 14 ? 1 : 0;
}`),
    ).toBe(1);
  });

  it("explicit unionAnyRep:true still honored (option overrides lane default)", async () => {
    const r = await compile(
      `export function test(): number {
  let x: number | string = 5;
  for (let i = 0; i < 2; i++) if (i === 1) x = "done";
  return x === "done" ? 1 : 0;
}`,
      { fileName: "t.ts", target: "standalone", unionAnyRep: true },
    );
    expect(r.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary!, {});
    expect((instance.exports as { test?: () => unknown }).test?.()).toBe(1);
  });

  it("S3 consumers stay host-import-free (default lane)", async () => {
    const r = await compile(
      `export function test(): number {
  let x: number | string = 5;
  for (let i = 0; i < 2; i++) if (i === 1) x = "done";
  let s = "" + x;
  if (x === "done" && x && s === "done") return 1;
  return 0;
}`,
      { fileName: "t.ts", target: "standalone" },
    );
    expect(r.success).toBe(true);
    await expect(WebAssembly.instantiate(r.binary!, {})).resolves.toBeDefined();
  });
});

// ───────────────────────────── S4 ─────────────────────────────
// Union params/returns + union→any boundaries on the `$AnyValue` carrier —
// now on the DEFAULT native lane.
describe("#745 S4 — default native lane, union params/returns/any-boundary", () => {
  async function run(src: string): Promise<unknown> {
    const r = await compile(src, { fileName: "t.ts", target: "standalone" });
    expect(r.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary!, {});
    return (instance.exports as { test?: () => unknown }).test?.();
  }

  it("union PARAM: typeof-dispatch + as-cast string member read across two call sites", async () => {
    expect(
      await run(`function f(v: number | string): number { return typeof v === "number" ? v * 2 : (v as string).length; }
export function test(): number { let x: number | string = 21; const a = f(x); x = "abc"; const b = f(x); return a === 42 && b === 3 ? 1 : 0; }`),
    ).toBe(1);
  });

  it("union RETURN: mixed-kind ternary keeps honest runtime tags", async () => {
    expect(
      await run(`function g(k: number): number | string { return k > 0 ? 7 : "neg"; }
export function test(): number { const a = g(1); const b = g(-1); return (typeof a === "number" && a === 7 && b === "neg") ? 1 : 0; }`),
    ).toBe(1);
  });

  it("union → any assignment: typeof survives the boundary", async () => {
    expect(
      await run(`export function test(): number {
  let x: number | string = 9; let y: any = x; x = "z"; let w: any = x;
  return (typeof y === "number" && typeof w === "string") ? 1 : 0;
}`),
    ).toBe(1);
  });

  it("boolean|string union param round-trip (tag-4 brand preserved)", async () => {
    expect(
      await run(`function h(v: boolean | string): number { return v === true ? 1 : (v === "b" ? 2 : 0); }
export function test(): number { let x: boolean | string = true; const a = h(x); x = "b"; const b = h(x); return a === 1 && b === 2 ? 1 : 0; }`),
    ).toBe(1);
  });

  it("explicit unionAnyRep:true still honored (option overrides lane default)", async () => {
    const r = await compile(
      `function g(k: number): number | string { return k > 0 ? 7 : "neg"; }
export function test(): number { const a = g(1); const b = g(-1); return (typeof a === "number" && a === 7 && b === "neg") ? 1 : 0; }`,
      { fileName: "t.ts", target: "standalone", unionAnyRep: true },
    );
    expect(r.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary!, {});
    expect((instance.exports as { test?: () => unknown }).test?.()).toBe(1);
  });

  it("S4 paths stay host-import-free (default lane)", async () => {
    const r = await compile(
      `function g(k: number): number | string { return k > 0 ? k * 2 : "neg"; }
export function test(): number { const a = g(2); return typeof a === "number" && a === 4 ? 1 : 0; }`,
      { fileName: "t.ts", target: "standalone" },
    );
    expect(r.success).toBe(true);
    await expect(WebAssembly.instantiate(r.binary!, {})).resolves.toBeDefined();
  });
});
