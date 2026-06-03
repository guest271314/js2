import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.ts";

// #846 — Destructuring a `null`/`undefined` value must throw TypeError, even
// for an EMPTY object binding pattern.
//
// Per ECMA-262 8.6.2 BindingInitialization, the production
//   `BindingPattern : ObjectBindingPattern`
// runs `Perform ? RequireObjectCoercible(value)` as STEP 1 — before the inner
// `ObjectBindingPattern : { }` rule (which returns unused). So `const {} = null`
// and `const {} = undefined` MUST throw, while `const {} = 5` must NOT (a number
// is object-coercible). Earlier codegen short-circuited empty object patterns
// and silently accepted null/undefined (test262 dstr-binding/obj-init-null +
// for-of/dstr/const-obj-init-*). The wasm path and JS reference must agree.
describe("#846 destructuring RequireObjectCoercible (empty object patterns)", () => {
  const cases: { name: string; body: string }[] = [
    { name: "let {} = null throws", body: `let o: any = null; let {} = o; r = 1;` },
    { name: "let {} = undefined throws", body: `let o: any = undefined; let {} = o; r = 1;` },
    { name: "const {} = null throws", body: `const o: any = null; const {} = o; r = 1;` },
    { name: "let {} = 5 is coercible (no throw)", body: `let o: any = 5; let {} = o; r = 1;` },
    { name: "let {} = 'str' is coercible (no throw)", body: `let o: any = "s"; let {} = o; r = 1;` },
    { name: "let {a} = null throws", body: `let o: any = null; let {a} = o; r = 1;` },
    { name: "for-of const {} of [null] throws", body: `for (const {} of [(null as any)]) {} r = 1;` },
    { name: "for-of const {} of [undefined] throws", body: `for (const {} of [(undefined as any)]) {} r = 1;` },
    { name: "for-of const {} of [5] coercible (no throw)", body: `for (const {} of [(5 as any)]) {} r = 1;` },
    // nested empty object pattern over an externref null value
    { name: "nested {w:{}} of {w:null} throws", body: `let o: any = { w: null }; let { w: {} } = o; r = 1;` },
  ];

  for (const { name, body } of cases) {
    it(name, async () => {
      await assertEquivalent(
        `export function test(): number {
          let r = 0;
          try { ${body} } catch (e) { r = (e instanceof TypeError) ? 2 : 3; }
          return r;
        }`,
        [{ fn: "test", args: [] }],
      );
    });
  }
});
