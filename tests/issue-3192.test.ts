import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

// #3192 — bloat S2: route the RegExp standalone brand check through the shared
// `emitReceiverBrandCheck` preamble (receiver-brand.ts, #3171).
//
// This is a REFACTOR (zero behaviour change). `recoverRegExpStructFromExternref`
// (regexp-standalone.ts) previously hand-rolled the §22.2.6 brand gate
// (`any.convert_extern` + `ref.test $NativeRegExp` + `i32.eqz` + `if` throw via
// native-proto's `emitBrandCheckTypeError` + `ref.cast`); it now delegates the
// whole gate to the parameterized `emitReceiverBrandCheck` (struct-only spec).
// These tests lock the observable contract that must stay byte-identical:
//   - a reflective RegExp method/getter on a NON-RegExp `this` throws a catchable
//     TypeError (never a `ref.cast` trap);
//   - the §22.2.6 proto-identity carve-out (`this === RegExp.prototype`) still
//     short-circuits BEFORE the brand throw (flags → "", source → "(?:)");
//   - a genuine RegExp receiver still dispatches natively through `.call`.
//
// DataView's brand gate was evaluated as the other half of S2 but is
// deliberately left on S1's shared throw template (`buildThrowJsErrorInstrs`,
// via `dvTypeErrorThrow`) per the issue's judgment gate: the DataView accessors
// build the throw template BEFORE the body (funcIdx-capture ordering) and weave
// the brand test with the detached-buffer + bounds checks, reusing the single
// `$__dv_window` test result — a shape `emitReceiverBrandCheck` (stack receiver,
// inline throw, own `ref.test`) cannot express without weakening its API. The
// DataView cases below assert that its brand behaviour is unchanged.

async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, { target: "standalone", skipSemanticDiagnostics: true } as never);
  if (!r.success) throw new Error("compile error: " + (r.errors?.[0]?.message ?? "unknown"));
  const io = r.importObject as WebAssembly.Imports & { __setExports?: (e: Record<string, unknown>) => void };
  const { instance } = await WebAssembly.instantiate(r.binary, io);
  io.__setExports?.(instance.exports as Record<string, unknown>);
  return (instance.exports as { test(): unknown }).test();
}

describe("#3192 RegExp reflective brand check → shared receiver-brand preamble", () => {
  it("flags getter on a plain object throws a catchable TypeError", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const d = Object.getOwnPropertyDescriptor(RegExp.prototype, 'flags') as any;
           try { d.get.call({}); return 0; }
           catch (e: any) { return e instanceof TypeError ? 1 : 2; }
         }`,
      ),
    ).toBe(1);
  });

  it("global getter on a primitive (number) throws a catchable TypeError", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const d = Object.getOwnPropertyDescriptor(RegExp.prototype, 'global') as any;
           try { d.get.call(5); return 0; }
           catch (e: any) { return e instanceof TypeError ? 1 : 2; }
         }`,
      ),
    ).toBe(1);
  });

  it("proto-identity carve-out short-circuits before the brand throw (flags → '', source → '(?:)')", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const fd = Object.getOwnPropertyDescriptor(RegExp.prototype, 'flags') as any;
           const sd = Object.getOwnPropertyDescriptor(RegExp.prototype, 'source') as any;
           const flags = fd.get.call(RegExp.prototype);
           const source = sd.get.call(RegExp.prototype);
           return flags === '' && source === '(?:)' ? 1 : 9;
         }`,
      ),
    ).toBe(1);
  });

  it("genuine RegExp receiver still dispatches natively through .call (test / exec)", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const re = /ab+c/;
           const ok = RegExp.prototype.test.call(re, 'xabbc') ? 1 : 0;
           const re2 = /(\\d+)/;
           const m = RegExp.prototype.exec.call(re2, 'n42') as any;
           const cap = m && m[1] === '42' ? 1 : 0;
           return ok + cap;
         }`,
      ),
    ).toBe(2);
  });
});

describe("#3192 DataView brand behaviour unchanged (stays on S1's shared throw template)", () => {
  it("reflective accessor on a non-DataView throws a catchable TypeError", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const g = DataView.prototype.getInt8;
           try { (g as any).call({}, 0); return 0; }
           catch (e: any) { return e instanceof TypeError ? 1 : 2; }
         }`,
      ),
    ).toBe(1);
  });

  it("genuine DataView still reads/writes natively", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const b = new ArrayBuffer(8);
           const dv = new DataView(b);
           dv.setInt8(0, 42);
           return dv.getInt8(0);
         }`,
      ),
    ).toBe(42);
  });
});
