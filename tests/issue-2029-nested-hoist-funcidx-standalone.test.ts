// #2029 (function-index sub-bucket) — a FAILED nested-function hoist must not
// strand the module-level runtime helpers it pulled in as a side effect, or a
// later any-receiver method dispatch bakes a stale funcIdx → the
// "function index out of range" emit crash.
//
// Root cause (traced on the `built-ins/Array/prototype/toLocaleString/
// user-provided-tolocalestring-grow.js` repro, `call 136` into a 129-func
// module): under `--target standalone`, the function-hoist pre-pass compiles a
// nested `function` declaration. When that body contains a standalone-unsupported
// op (e.g. `[].toLocaleString()` → `__extern_toLocaleString` reportError) AND has
// already pulled in the object runtime (`ensureObjectRuntime` registers
// `__extern_method_call` / `__apply_closure` / the `__proxy_*` dispatchers + their
// string/number/union deps), the hoist rolled back by truncating
// `ctx.mod.functions` back to its pre-compile length — removing those VALID,
// content-addressed helpers from the table while leaving their `ctx.funcMap`
// entries (and the `objectRuntimeTypes` / `ensureProxyRuntime` `funcMap.has`
// guards) intact. A later any-receiver method call (`o.resize(n)` → the reserved
// `__call_m_resize_1` closed-struct dispatcher) then found the guards already
// satisfied, SKIPPED re-registering the runtime, and `fillClosedMethodDispatch`
// baked the now-stale helper funcIdx (136) past the shrunken table.
//
// Fix (`nested-declarations.ts`): on a failed hoist, DO NOT truncate
// `ctx.mod.functions`. Keep every pushed func (the side-effect helpers are valid
// and possibly needed later) and neutralise ONLY the failed user function's own
// entry to a valid `unreachable` stub, dropping its funcMap name so
// `compileStatement` re-compiles it at its real textual position. funcMap and the
// table stay in lockstep, so no dispatcher bakes a stale index.
//
// Acceptance: the shapes below COMPILE standalone with no "function index out of
// range" / "Binary emit error"; gc/host mode is unaffected.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function compileStandalone(src: string) {
  return (await compile(src, { target: "standalone", skipSemanticDiagnostics: true })) as any;
}

function noEmitCrash(r: any): void {
  // The defining failure of this sub-bucket is the encoder RangeError surfaced as
  // a compile error whose message contains "index out of range" / "Binary emit
  // error". A clean located refusal (reportError) is acceptable — NOT an emit
  // crash. Assert specifically that no emit-crash message is present.
  const msgs: string[] = (r.errors ?? []).map((e: any) => e.message);
  expect(msgs.some((m) => /index out of range|Binary emit error/.test(m))).toBe(false);
}

describe("#2029 — failed nested-hoist must not strand object-runtime helpers (standalone funcIdx)", () => {
  it("nested fn whose hoist fails (object-runtime side effect) + any-receiver method dispatch compiles", async () => {
    // `inner` pulls in the object runtime via `['',''].toLocaleString()` (a
    // standalone-unsupported op → its hoist fails and rolls back). The later
    // any-receiver `o.resize(2)` reserves the `__call_m_resize_1` dispatcher whose
    // fill must resolve against the still-registered object-runtime helpers.
    const r = await compileStandalone(
      `export function test(): number {
         function inner(list: any): string {
           const comma = ['', ''].toLocaleString();
           return list[0] + comma;
         }
         const o: any = { resize(n: number) { return n + 1; } };
         const r = o.resize(2) as number;
         if (r < 0) { inner([1]); }
         return r;
       }`,
    );
    // Pre-fix: `Binary emit error: ... function index out of range — 136`.
    noEmitCrash(r);
    expect(r.success).toBe(true);
  });

  it("the test262 toLocaleString grow shape compiles standalone (was: `call 136` emit crash)", async () => {
    // Mirrors `built-ins/Array/prototype/toLocaleString/
    // user-provided-tolocalestring-grow.js` — a `listToString` helper (array
    // toLocaleString inside) whose hoist fails, alongside `rab.resize(...)` (the
    // any-receiver method call that reserves `__call_m_resize_1`).
    const r = await compileStandalone(
      `export function test(): number {
         function listToString(list: any): string {
           const comma = ['', ''].toLocaleString();
           const len = list.length;
           let result = '';
           for (let i = 0; i < len - 1; i++) { result += list[i] + comma; }
           if (len > 0) { result += list[len - 1]; }
           return result;
         }
         const rab: any = { resize(n: number) { return n; } };
         rab.resize(6);
         if (rab.resize(0) < 0) { listToString([0, 0]); }
         return 1;
       }`,
    );
    noEmitCrash(r);
    expect(r.success).toBe(true);
  });

  it("gc/host mode is unaffected (no regression) — same shape compiles", async () => {
    // The fix path is reached in every mode (the truncation lived in the
    // mode-agnostic hoist), but the object-runtime helpers + closed-method
    // dispatcher are standalone-only, so gc/host never hit the stale-index crash.
    // Assert the shape still compiles cleanly in the default (gc/host) target.
    const r = (await compile(
      `export function test(): number {
         function inner(list: any): string { return ('' + list[0]); }
         const o: any = { resize(n: number) { return n + 1; } };
         const r = o.resize(2) as number;
         if (r < 0) { inner([1]); }
         return r;
       }`,
      { skipSemanticDiagnostics: true },
    )) as any;
    noEmitCrash(r);
    expect(r.success).toBe(true);
  });
});
