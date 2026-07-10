// #2671 (ES2015 builtin residual) — RegExp `lastIndex` is a value-preserving
// data slot (§22.2.7.2 RegExpBuiltinExec step 4: `lastIndex = ToLength(? Get(R,
// "lastIndex"))`).
//
// Root cause: the extern `RegExp` interface typed `lastIndex` as `number`, so the
// host import eagerly `ToNumber`'d any assigned value at WRITE time. Assigning an
// object (`r.lastIndex = {valueOf(){…}}`) therefore (a) coerced + discarded the
// object's identity (storing the number), and on the dynamic path (b) threw
// "Cannot convert object to primitive value" because an opaque WasmGC struct is
// unconvertible to V8. The spec instead stores the value verbatim and coerces
// only inside `exec` (writing back only when the regex is global/sticky).
//
// Fix: carry `RegExp.lastIndex` as `externref` in host mode (codegen/index.ts) so
// the raw value round-trips; on the host boundary (runtime.ts) wrap a struct on
// WRITE as a host-coercibility proxy (so native exec can `ToLength` it) and
// unwrap on READ (so an explicit read sees the SAME object the program stored).
// Primitive numbers pass through untouched, and the global/sticky numeric
// write-back path is unchanged.
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

describe("#2671 — RegExp lastIndex value-preserving slot", () => {
  // Mirrors built-ins/RegExp/prototype/exec/success-lastindex-access.js:
  // a non-global/non-sticky exec READS lastIndex (ToLength → valueOf once) but
  // does NOT write it back, so the originally-assigned object survives.
  it("preserves the assigned object identity across a non-global exec", async () => {
    const exp = await run(`
      let gets = 0;
      const counter = { valueOf: function() { gets++; return 0; } };
      const r = /./;
      r.lastIndex = counter as any;
      const result: any = r.exec('abc');
      const resultOk = result !== null && result.length === 1 && result[0] === 'a';
      const identityOk = (r.lastIndex as any) === counter;
      return resultOk && identityOk && gets === 1 ? 'ok' : 'resultOk=' + resultOk + ' identityOk=' + identityOk + ' gets=' + gets;
    `);
    expect(exp.test()).toBe("ok");
  });

  it("reads the assigned lastIndex valueOf exactly once, at exec time", async () => {
    const exp = await run(`
      let gets = 0;
      const counter = { valueOf: function() { gets++; return 0; } };
      const r = /./;
      r.lastIndex = counter as any;
      r.exec('abc');
      return gets;
    `);
    expect(exp.test()).toBe(1);
  });

  // Regression guard: the global numeric write-back path must be unchanged.
  // For /a/g over "aaa", exec advances lastIndex to the index after the match.
  it("still advances numeric lastIndex for a global regex (write-back path)", async () => {
    const exp = await run(`
      const r = /a/g;
      r.exec('aaa');
      return r.lastIndex;
    `);
    expect(exp.test()).toBe(1);
  });

  it("reads a freshly-constructed lastIndex as 0", async () => {
    const exp = await run(`
      const r = /x/;
      return r.lastIndex;
    `);
    expect(exp.test()).toBe(0);
  });

  it("round-trips a numeric lastIndex assignment (primitive passthrough)", async () => {
    const exp = await run(`
      const r = /x/g;
      r.lastIndex = 2;
      return r.lastIndex;
    `);
    expect(exp.test()).toBe(2);
  });

  // A sticky regex DOES consult lastIndex for the match start and writes back.
  it("honors numeric lastIndex as the start anchor for a sticky regex", async () => {
    const exp = await run(`
      const r = /b/y;
      r.lastIndex = 1;
      const m: any = r.exec('abc');
      return m !== null && m[0] === 'b' && r.lastIndex === 2 ? 'ok' : 'fail';
    `);
    expect(exp.test()).toBe("ok");
  });

  // Mirrors built-ins/RegExp/prototype/Symbol.replace/coerce-lastindex-err.js.
  // A lastIndex set with a throwing `valueOf` performed INSIDE a user-overridden
  // `exec` (invoked by RegExp.prototype[@@replace]'s empty-match advance) must
  // surface the abrupt completion. (#3084) The set stores the deferred coercion
  // shim VERBATIM per §22.2.6.11; V8's slow protocol path then performs the
  // spec's `ToLength(? Get(rx, "lastIndex"))` read in the empty-match advance
  // branch, which fires the shim's valueOf and propagates the throw out of
  // @@replace. (The former eager protocol-depth coercion at assignment time was
  // retired by #3084 — it fired valueOf even for NON-empty matches, violating
  // Symbol.match/g-match-no-coerce-lastindex.js.)
  it("propagates a throwing lastIndex valueOf set during @@replace (overridden exec)", async () => {
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

  // A lastIndex struct set OUTSIDE any protocol still defers (verbatim/identity),
  // so a numeric valueOf is NOT fired at assignment — the protocol-depth carve-out
  // only changes the inside-protocol case above.
  it("defers a lastIndex struct assignment outside any protocol (identity kept, no eager valueOf)", async () => {
    const exp = await run(`
      let gets = 0;
      const counter = { valueOf: function() { gets++; return 3; } };
      const r = /a/;
      r.lastIndex = counter as any;
      const same = (r.lastIndex as any) === counter;
      return same && gets === 0 ? 'ok' : 'same=' + same + ' gets=' + gets;
    `);
    expect(exp.test()).toBe("ok");
  });
});
