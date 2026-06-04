// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1823 — `String.prototype.normalize(form)` evaluation order.
 *
 * Per §13.3 (MemberExpression Call) the receiver (`this`) is evaluated BEFORE
 * the argument list (§22.1.3.13). The codegen for `s.normalize(form)` with a
 * non-literal `form` previously compiled+dropped the argument FIRST, then the
 * receiver, reversing the observable order for side-effecting `s` / `form`.
 *
 * The fix compiles the receiver into a temp first, then the argument, then
 * reads the receiver back (normalize is identity for already-NFC ASCII).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

async function runReturnNumber(src: string): Promise<number> {
  const r: any = await compile(src, { fileName: "test.ts" });
  if (!r.success) {
    const msg = r.errors.map((e: any) => e.message).join("\n");
    throw new Error(`compile failed:\n${msg}`);
  }
  const imports: any = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await instantiateWasm(r.binary, imports.env, imports.string_constants);
  return ((instance.exports as any).test as () => number)();
}

describe("#1823 String#normalize(form) evaluation order", () => {
  it("evaluates the receiver before the form argument", async () => {
    // `tick` is bumped by each side-effecting producer. The receiver producer
    // records its tick into `recvAt`, the form producer into `formAt`. Spec
    // order ⇒ recvAt < formAt. The old (buggy) order produced recvAt > formAt.
    const src = `
      let tick: number = 0;
      let recvAt: number = 0;
      let formAt: number = 0;
      function recv(): string { tick = tick + 1; recvAt = tick; return "abc"; }
      function form(): string { tick = tick + 1; formAt = tick; return "NFC"; }
      recv().normalize(form());
      export function test(): number { return recvAt < formAt ? 1 : 0; }
    `;
    expect(await runReturnNumber(src)).toBe(1);
  });

  it("still evaluates the form argument for its side effects", async () => {
    const src = `
      let formEvaluated: boolean = false;
      function form(): string { formEvaluated = true; return "NFC"; }
      "abc".normalize(form());
      export function test(): number { return formEvaluated ? 1 : 0; }
    `;
    expect(await runReturnNumber(src)).toBe(1);
  });

  it("normalize returns the receiver string unchanged (identity for NFC ASCII)", async () => {
    const src = `
      export function test(): number {
        const s: string = "hello";
        const n: string = s.normalize("NFC");
        return n === "hello" ? 1 : 0;
      }
    `;
    expect(await runReturnNumber(src)).toBe(1);
  });

  it("normalize with a non-literal valid form returns the receiver unchanged", async () => {
    const src = `
      function form(): string { return "NFC"; }
      export function test(): number {
        const n: string = "world".normalize(form());
        return n === "world" ? 1 : 0;
      }
    `;
    expect(await runReturnNumber(src)).toBe(1);
  });
});
