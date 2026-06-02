// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Issue #1525b — ToPrimitive residuals carved from #1525.
 *
 * Two independent root causes:
 *
 *   #2 (dominant ~142 fails): Object-method trampolines emitted invalid Wasm
 *      whenever a `String(obj)` / `obj + 1` site introduced a late import
 *      (e.g. `__typeof_string`, `__box_number`) AFTER the trampoline was
 *      registered. `pendingMethodTrampolines[i].methodFuncIdx` is a plain
 *      number not reachable from any Instr, so the three late-import shift
 *      sites (`shiftLateImportIndices`, `addUnionImports` inline shifter,
 *      `addStringImports` inline shifter) missed it. `finalizeMethodTrampolines`
 *      then resolved the stale index to the wrong (import) signature and
 *      emitted a double `f64.convert_i32_s` cascade.
 *
 *   #3 (~8-10 fails): Two `ref → f64` subpaths in
 *      `src/codegen/type-coercion.ts` (closure-typed valueOf call_ref, and
 *      standalone `${name}_valueOf` shorthand-method) silently emitted
 *      `drop + f64.const NaN` when valueOf returned an object ref, instead
 *      of routing through the host `__to_primitive` helper. Per ECMA-262
 *      §7.1.1.1 step 6 this must continue to toString and throw TypeError
 *      if both methods return non-primitives.
 *
 * Fix: register `pendingMethodTrampolines` with all three shift sites,
 * add a defensive guard at `finalizeMethodTrampolines`, and re-route both
 * ref-return subpaths through `emitToPrimitiveHostCall`.
 */
import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

async function runWasm(src: string): Promise<unknown> {
  const exports = await compileToWasm(src);
  const fn = exports.test as () => unknown;
  return fn();
}

describe("#1525b — ToPrimitive trampoline shift + step-6 TypeError", () => {
  // Fix #2: late imports shifted around a registered trampoline.
  it("String(obj) with user toString does not produce invalid Wasm", async () => {
    expect(
      await runWasm(`
        export function test(): any {
          const obj: any = {
            valueOf() { return 100; },
            toString() { return "stringified"; },
          };
          return String(obj);
        }
      `),
    ).toBe("stringified");
  });

  // Fix #2: a value-receiving (`obj + 1`) site that triggers `__box_number` /
  // `__unbox_number` import additions after the trampoline registration.
  it("obj+1 with user valueOf returning a primitive does not invalidate the trampoline", async () => {
    expect(
      await runWasm(`
        export function test(): any {
          const obj: any = {
            valueOf() { return 41; },
            toString() { return "noop"; },
          };
          return obj + 1;
        }
      `),
    ).toBe(42);
  });

  // Fix #3 subpath 1 (closure-typed valueOf): both valueOf AND toString return
  // objects → §7.1.1.1 step 6 TypeError must surface to the Wasm catch_all.
  it("TypeError when both valueOf and toString return objects (closure dispatch)", async () => {
    expect(
      await runWasm(`
        export function test(): any {
          const obj: any = {
            valueOf() { return ({} as any); },
            toString() { return ({} as any); },
          };
          try { return obj + 1; } catch (e) { return "TYPEERR"; }
        }
      `),
    ).toBe("TYPEERR");
  });

  // Fix #3 subpath 2 (standalone shorthand-method): valueOf returning a non-
  // primitive must still let toString primary handle it.
  it("valueOf returns object, toString returns string → string used", async () => {
    expect(
      await runWasm(`
        export function test(): any {
          const obj: any = {
            valueOf() { return ({} as any); },
            toString() { return "fallback"; },
          };
          // Hint "default" — toString runs after valueOf bottoms out.
          return obj + "";
        }
      `),
    ).toBe("fallback");
  });

  // Fix #2 cross-check: distinct user-method objects with different shapes
  // (so they don't structurally dedupe) and mixed value/string sites — none
  // of the trampolines should desync as late imports get added.
  it("distinct-shape user-method objects survive concurrent late imports", async () => {
    expect(
      await runWasm(`
        export function test(): any {
          const a: any = { valueOf() { return 10; }, tag: "a" };
          const c: any = { toString() { return "tail"; } };
          return a + 32 + " " + String(c);
        }
      `),
    ).toBe("42 tail");
  });
});
