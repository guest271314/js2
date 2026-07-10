// #3084 — RegExp @@match/@@replace/@@split must NOT eagerly coerce a
// `lastIndex` assigned during the protocol (inside a user-overridden `exec`).
//
// §22.2.6.8 (@@match), §22.2.6.11 (@@replace), §22.2.6.14 (@@split) store an
// assigned `lastIndex` VERBATIM (plain data property write). The property is
// only READ as `ToLength(? Get(rx, "lastIndex"))` in the EMPTY-match advance
// branch (e.g. §22.2.6.8 step 8.g.iv.5). So for a NON-empty match the stored
// object's `valueOf` must never fire; for an empty match it must fire (and a
// throw propagates as the program's own error).
//
// The bug: the host-side `RegExp.lastIndex` set handler in `src/runtime.ts`
// eagerly coerced a WasmGC-struct assignment whenever a regex protocol was on
// the stack (`_regexProtocolDepth > 0`), firing `valueOf` unconditionally at
// assignment time — spec-incorrect for the non-empty-match case
// (test262: Symbol.match/g-match-no-coerce-lastindex.js, currently masked on
// the default baseline by the #3051/#2777 accessor-result marshaling gap).
//
// The fix: always store the deferred `_makeLastIndexShim`. Measured (P1/P3
// below + pure-V8 control): V8's slow (modified-RegExp) protocol path performs
// the spec's ToLength read of the JS-visible property in the empty-match
// branch, which fires the shim's Symbol.toPrimitive → the struct's compiled
// valueOf — so the empty-match throw of tests/issue-2671-regexp.test.ts:108
// still propagates without the eager hack.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function run(body: string): Promise<any> {
  const src = `export function test(): any { ${body} }`;
  const result: any = await compile(src, { fileName: "test.ts", skipSemanticDiagnostics: true } as any);
  expect(result.binary?.length).toBeGreaterThan(0);
  const importObject: any = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  importObject.__setExports?.(instance.exports);
  return wrapExports(instance.exports, { signatures: result.exportSignatures });
}

describe("#3084 — no eager lastIndex coercion during RegExp protocol calls", () => {
  // Mirrors Symbol.match/g-match-no-coerce-lastindex.js (data-property variant:
  // the real test sets lastIndex inside `get 0()`, which is masked until #2777;
  // setting it inside `exec` itself exercises the identical protocol-depth set).
  it("@@match with a NON-empty match never fires the assigned lastIndex valueOf", async () => {
    const exp = await run(`
      const r = /./g;
      let state = 0;
      (r as any).exec = function(): any {
        if (state > 0) { return null; }
        state = 1;
        r.lastIndex = { valueOf: function(): number { throw new Error('SHOULD-NOT-FIRE'); } } as any;
        return { length: 1, 0: 'a non-empty string', index: 0 };
      };
      let out = 'no-throw';
      try { (r as any)[Symbol.match](''); } catch (e: any) { out = 'threw:' + e.message; }
      return out;
    `);
    expect(exp.test()).toBe("no-throw");
  });

  // Empty-match advance: the spec's ToLength(Get(rx, "lastIndex")) read fires
  // the deferred shim exactly once (§22.2.6.8 step 8.g.iv.5).
  it("@@match with an EMPTY match fires the assigned lastIndex valueOf exactly once", async () => {
    const exp = await run(`
      const r = /./g;
      let calls = 0;
      let n = 0;
      (r as any).exec = function(): any {
        if (n > 0) { return null; }
        n = 1;
        r.lastIndex = { valueOf: function(): number { calls++; return 0; } } as any;
        return { length: 1, 0: '', index: 0 };
      };
      (r as any)[Symbol.match]('');
      return calls;
    `);
    expect(exp.test()).toBe(1);
  });

  // The #2671:108 companion — a THROWING valueOf set during @@replace with an
  // empty match must still propagate (now via the shim's deferred ToLength read
  // instead of the retired eager assignment-time coercion).
  it("@@replace empty-match advance still propagates a throwing lastIndex valueOf", async () => {
    const exp = await run(`
      const r = /./g;
      let execWasCalled = false;
      const coercibleIndex = { valueOf: function(): number { throw new Error('T262'); } };
      const result: any = { length: 1, 0: '', index: 0 };
      (r as any).exec = function(): any {
        if (execWasCalled) { return null; }
        r.lastIndex = coercibleIndex as any;
        execWasCalled = true;
        return result;
      };
      let threw = 'no';
      try { (r as any)[Symbol.replace]('', ''); } catch (e: any) { threw = 'yes'; }
      return threw;
    `);
    expect(exp.test()).toBe("yes");
  });

  // Non-empty @@replace: the assigned object must survive un-coerced (verbatim
  // store + no read), and the replace result must be correct.
  it("@@replace with a NON-empty match neither fires nor loses the assigned lastIndex object", async () => {
    const exp = await run(`
      const r = /./g;
      let gets = 0;
      const marker = { valueOf: function(): number { gets++; return 0; } };
      let n = 0;
      (r as any).exec = function(): any {
        if (n > 0) { return null; }
        n = 1;
        r.lastIndex = marker as any;
        return { length: 1, 0: 'abc', index: 0 };
      };
      const out: any = (r as any)[Symbol.replace]('abc', 'X');
      const identityOk = (r.lastIndex as any) === marker;
      return out === 'X' && identityOk && gets === 0 ? 'ok' : 'out=' + out + ' identityOk=' + identityOk + ' gets=' + gets;
    `);
    expect(exp.test()).toBe("ok");
  });
});
