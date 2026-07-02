// #2936 — late-import funcIdx-shift desync: a raw (finalize-regime) host
// import (`env.__make_callback`) followed by a deferred late-import batch
// (`addGeneratorImports`'s `__gen_*` suite) corrupted the native-string
// helpers' baked sibling calls: the batch flush only shifted refs >=
// importsBefore AND re-based `nativeStrHelperImportBase`, permanently
// cancelling the pending raw-import repair. `__str_flatten`'s baked
// `call __str_copy_tree` (index 0) then resolved to import #0
// (`__make_callback(i32, externref)`), producing an invalid module:
//   `__str_flatten call[1] expected type externref, found i32`.
//
// The trigger on main: `--target standalone` + native strings + an arrow
// (raw `__make_callback`) + a native-CANDIDATE generator that CAPTURES an
// outer local — candidate ⇒ the generator decl skips the `unionFound`
// trigger (so no interleaved union-finalize reconcile), capture ⇒
// `sourceNeedsGeneratorHostImports` still pulls the host gen-suite batch
// right after the raw import. This is the blocker class for #2933's
// no-yield native generators (~250-350 test262 flips), where the same
// window opens for every no-yield dstr-binding test.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const SRC = `
const greet = (n: string): string => "hi " + n;
export function test(): string {
  let n = 1;
  function* g() { yield n; }
  void g();
  return greet("x");
}
`;

describe("issue #2936 — raw-import + deferred-batch shift-regime mix", () => {
  it("standalone module with arrow + outer-capturing candidate generator validates", async () => {
    const r = await compile(SRC, {
      fileName: "issue-2936.ts",
      target: "standalone",
      skipSemanticDiagnostics: true,
    });
    expect(r.success).toBe(true);
    expect(r.binary).toBeDefined();
    // Pre-fix this produced an invalid module (`__str_flatten call[1] expected
    // externref, found i32`) — validation is the assertion, not instantiation
    // (the module intentionally still carries env.__gen_* host imports).
    expect(WebAssembly.validate(r.binary!)).toBe(true);
  });

  it("gc/host lane compiles and validates unchanged", async () => {
    const r = await compile(SRC, {
      fileName: "issue-2936.ts",
      skipSemanticDiagnostics: true,
    });
    expect(r.success).toBe(true);
    expect(WebAssembly.validate(r.binary!)).toBe(true);
  });
});
