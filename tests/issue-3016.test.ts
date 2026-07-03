// #3016 — standalone: a function-expression/arrow passed as an argument to
// `Function.prototype.call`/`apply` is a plain function-object VALUE, not a
// synchronously-invoked host callback. It must take the GC closure-struct path,
// NOT the `__make_callback` host bridge (which leaks an `env::` import and makes
// the standalone binary non-host-free).
//
// Shapes covered (from the residual sole-`__make_callback` standalone leak set):
//   - `get.call(() => {})`                        — arrow used as invalid `this`
//   - `Array.prototype.find.call(undefined, fn)`  — predicate forwarded via .call
//   - `Array.prototype.forEach.call(arr, cb)`     — HOF whose receiver DOES invoke
//     the callback: must still execute correctly through the closure-struct path
//
// The load-bearing property is: NO `env::` import (checked statically via
// `WebAssembly.Module.imports`, which does not execute the module). Genuine
// end-to-end execution of the real test262 files is validated in the standalone
// lane via the test262 runner (inject-throw discipline); here the forEach case
// additionally proves the callback still runs through `__call_fn_N`.
//
// The fix is standalone-gated (`ctx.standalone`), so the js-host/gc lane stays
// byte-identical (verified separately via sha256).
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function compileStandalone(src: string) {
  const r = await compile(src, { fileName: "test.ts", target: "standalone", skipSemanticDiagnostics: true });
  expect(r.success, r.errors?.[0]?.message).toBe(true);
  return r;
}

function envImports(binary: Uint8Array): string[] {
  const mod = new WebAssembly.Module(binary);
  return WebAssembly.Module.imports(mod)
    .filter((i) => i.module === "env")
    .map((i) => i.name);
}

describe("#3016 — .call/.apply func-expr arg is a value, not a host callback (standalone)", () => {
  it("arrow used as invalid `this` via .call() emits no env import", async () => {
    const r = await compileStandalone(`
      const desc: any = (Object as any).getOwnPropertyDescriptor(RegExp.prototype, "global");
      const get: any = desc.get;
      export function test(): void {
        get.call(() => {});
      }
    `);
    expect(envImports(r.binary)).not.toContain("__make_callback");
    expect(envImports(r.binary)).toEqual([]);
  });

  it("func-expr predicate forwarded via Array.prototype.find.call(undefined, fn) emits no env import", async () => {
    const r = await compileStandalone(`
      export function test(): void {
        (Array.prototype.find as any).call(undefined, function () {});
      }
    `);
    expect(envImports(r.binary)).toEqual([]);
  });

  it("apply with a func-expr arg emits no env import", async () => {
    const r = await compileStandalone(`
      export function test(): void {
        (Array.prototype.findIndex as any).apply(null, [function () {}]);
      }
    `);
    expect(envImports(r.binary)).toEqual([]);
  });

  it("Array.prototype.forEach.call(arr, cb) is host-free AND still invokes cb (closure-struct path)", async () => {
    const r = await compileStandalone(`
      export function test(): number {
        let sum = 0;
        Array.prototype.forEach.call([1, 2, 3], function (x: any) { sum += x; });
        return sum;
      }
    `);
    expect(envImports(r.binary)).toEqual([]);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    // The callback IS invoked by forEach (the receiver), via __call_fn_N — proves
    // the value is a working closure struct, not a dead host wrapper.
    expect((instance.exports.test as () => number)()).toBe(6);
  });
});
