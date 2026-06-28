// #2795 — host value→string rendering: `+`-concat applies ToString/ToPrimitive
// honouring a user `toString()` even at module-START time, and a boolean value
// crossing into an `any`/externref slot renders as `true`/`false` (not 1/0).
//
// Both bugs were surfaced by the #2787 differential corpus:
//   - classes/10-toString-impl.js : `"" + new Money(42)` printed "[object Object]"
//   - closures/10-mutual.js       : mutually-recursive predicate printed 1 not true
//
// The programs run their effects in TOP-LEVEL code (the wasm START function),
// before the host wires `setExports`. So the test mirrors that: it instantiates
// and lets the start function run with a console.log capture, WITHOUT relying on
// a post-instantiation export call.

import { describe, it, expect } from "vitest";

import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

/** Compile `src`, instantiate, and capture everything top-level `console.log` prints. */
async function runAndCaptureLog(src: string): Promise<string[]> {
  const result = await compile(src, { skipSemanticDiagnostics: true });
  if (!result.success) throw new Error(`compile failed: ${result.error}`);
  const lines: string[] = [];
  const origLog = console.log;
  // eslint-disable-next-line no-console
  console.log = (...args: unknown[]) => lines.push(args.map((a) => String(a)).join(" "));
  try {
    const imports = buildImports(result.imports, {}, result.stringPool);
    const { instance } = await instantiateWasm(result.binary, imports.env, imports.string_constants);
    imports.setExports?.(instance.exports as Record<string, () => unknown>);
  } finally {
    console.log = origLog;
  }
  return lines;
}

describe("#2795 — `+`-concat ToString honours a custom toString() at START time", () => {
  it("'' + new C() dispatches the instance toString() (not [object Object])", async () => {
    const src = `
      class Money {
        n: number;
        constructor(n: number) { this.n = n; }
        toString() { return "$" + this.n; }
      }
      console.log("" + new Money(42));
      console.log(\`val=\${new Money(7)}\`);
    `;
    expect(await runAndCaptureLog(src)).toEqual(["$42", "val=$7"]);
  });

  it("a toString-only object concat in a top-level-called function still dispatches in-wasm", async () => {
    const src = `
      class Tag {
        s: string;
        constructor(s: string) { this.s = s; }
        toString() { return "<" + this.s + ">"; }
      }
      function show() { console.log("tag=" + new Tag("x")); }
      show();
    `;
    expect(await runAndCaptureLog(src)).toEqual(["tag=<x>"]);
  });
});

describe("#2795 — boolean values render as true/false when boxed into any/externref", () => {
  it("a boolean literal stored in an `any` slot prints true/false", async () => {
    const src = `
      const a: any = true;
      const b: any = false;
      console.log(a);
      console.log(b);
    `;
    expect(await runAndCaptureLog(src)).toEqual(["true", "false"]);
  });

  it("a boolean-returning function passed into an `any` parameter prints true", async () => {
    const src = `
      function isPos(x: number): boolean { return x > 0; }
      function log(v: any) { console.log(v); }
      log(isPos(5));
      log(isPos(-1));
    `;
    expect(await runAndCaptureLog(src)).toEqual(["true", "false"]);
  });

  it("a mutually-recursive boolean predicate prints true/false, not 1/0", async () => {
    const src = `
      function isEven(n) { return n === 0 ? true : isOdd(n - 1); }
      function isOdd(n) { return n === 0 ? false : isEven(n - 1); }
      console.log(isEven(10));
      console.log(isOdd(7));
    `;
    expect(await runAndCaptureLog(src)).toEqual(["true", "true"]);
  });

  it("boolean literals inside an any[] render as true/false", async () => {
    const src = `
      const a: any[] = [true, false, true];
      for (const v of a) console.log(v);
    `;
    expect(await runAndCaptureLog(src)).toEqual(["true", "false", "true"]);
  });
});

describe("#2795 — regression guards (numeric / valueOf semantics unchanged)", () => {
  it("a numeric kernel still returns a number (no boolean brand leak)", async () => {
    const src = `
      function add(a: number, b: number): number { return a + b; }
      console.log(add(2, 3));
      console.log("x=" + (1 + 2));
    `;
    expect(await runAndCaptureLog(src)).toEqual(["5", "x=3"]);
  });

  it("ToPrimitive(default) still runs valueOf-first for an object carrying valueOf (#2022)", async () => {
    // Evaluated inside an exported function (post-setExports) so the host
    // valueOf-first ToPrimitive path — which my change deliberately leaves
    // untouched — is exercised.
    const src = `
      export function test(): number {
        const o = { toString() { return "P!"; }, valueOf() { return 7; } };
        const s = o + "";
        return s === "7" ? 1 : 2;
      }
    `;
    const result = await compile(src, { skipSemanticDiagnostics: true });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const imports = buildImports(result.imports, {}, result.stringPool);
    const { instance } = await instantiateWasm(result.binary, imports.env, imports.string_constants);
    imports.setExports?.(instance.exports as Record<string, () => unknown>);
    expect((instance.exports as { test: () => number }).test()).toBe(1);
  });
});
