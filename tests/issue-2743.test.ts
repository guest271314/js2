import { describe, it, expect } from "vitest";
import { existsSync } from "fs";
import { runTest262File } from "./test262-runner.js";

/**
 * #2743 (c) — unmapped `arguments` for a non-simple parameter list.
 *
 * Per FunctionDeclarationInstantiation (ECMA-262 §10.2.11 step 22.a), the
 * arguments object is *unmapped* when the function is strict OR its parameter
 * list is non-simple (IsSimpleParameterList = false: any rest element,
 * defaulted parameter, or destructuring binding pattern). Before this fix
 * `emitArgumentsObject` was invoked with `unmapped = isStrictFunction(...)`
 * only, so a sloppy function with a non-simple parameter list got a *mapped*
 * arguments object:
 *
 *   - `function dflt(a, b = 0) { arguments[0] = 2; value = a; }` — the mapped
 *     write-back made `a === 2` (test asserts `value === 1`); likewise for the
 *     destructuring case `function dstr(a, [b]) { ... }`.
 *   - `function rest(a, ...b) { arguments[0] = 2; ... }` — the mapped
 *     write-back emitted a `local.set` the rest-param local shape can't satisfy,
 *     producing an "invalid Wasm binary" at instantiation (compile_error).
 *
 * The fix adds `isSimpleParameterList` and ORs `|| !isSimpleParameterList(...)`
 * into the `unmapped` decision at every `emitArgumentsObject` call site, so a
 * non-simple parameter list installs no `mappedArgsInfo` (no write-back, no bad
 * `local.set`) and the indices reflect the call arguments.
 *
 * Out of scope (tracked separately): mapped/* exotic descriptors (#1726),
 * arguments `[[Prototype]]`/`.constructor`/`@@iterator` ordinary-Object
 * semantics (#2743 groups (a)/(b), follow-up PR).
 */

const TEST262 = "/workspace/test262";
const ROOT = `${TEST262}/test/language/arguments-object`;

// Non-simple parameter lists → unmapped arguments object (the (c) group).
const unmappedNonSimple = [
  "unmapped/via-params-rest.js", // rest param; previously compile_error (invalid Wasm)
  "unmapped/via-params-dflt.js", // default param; previously fail (mapped write-back)
  "unmapped/via-params-dstr.js", // destructuring param; previously fail
];

// Guard: pre-existing unmapped/strict behaviour must stay green.
const stillGreen = ["unmapped/via-strict.js"];

const maybe = existsSync(TEST262) ? describe : describe.skip;

maybe("#2743 (c) unmapped arguments for non-simple parameter lists", () => {
  for (const rel of [...unmappedNonSimple, ...stillGreen]) {
    it(rel, async () => {
      const r = await runTest262File(`${ROOT}/${rel}`, "language");
      expect(r.status, `reason: ${(r as any).reason ?? (r as any).error ?? ""}`).toBe("pass");
    });
  }
});
