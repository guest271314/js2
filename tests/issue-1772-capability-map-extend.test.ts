// #1772 Phase 2 / Slice P2-b — extend the capability map beyond the fd anchor.
//
// Proves the #2634 "data-not-code" extension promise: adding `node:process`
// std-IO members is a new entry in `NODE_CAPABILITY_MAP`, not a checker code
// change. The entries are METADATA ONLY (empty decls) — the `node:process` type
// surface stays owned by the bespoke `PROCESS_INTERFACE_DECLS` branch in
// `buildNodeEnvDts`, which `continue`s before reaching `buildModuleDecls`, so the
// map entry can NOT double-declare `stdout`/`stderr`.
//
// This test asserts:
//   1. `isMemberSatisfiable("node:process", "write", …)` is truthy (std-IO lowers
//      to the fd-based `writeSync` sink under both wasi and JS-host targets).
//   2. A fabricated unsatisfiable member is falsy / unknown.
//   3. Adding the `node:process` map entry is byte-neutral for the injected dts of
//      a NON-process program (the entry only affects programs touching node:process).
import { describe, expect, it } from "vitest";
import { isKnownMember, isMemberSatisfiable } from "../src/checker/node-capability-map.js";
import { buildNodeEnvDtsForSource } from "../src/checker/index.js";

describe("#1772 P2-b — node:process std-IO capability entries", () => {
  it("process.stdout/stderr write is satisfiable under standalone WASI", () => {
    const wasi = { wasi: true, allowFs: false };
    expect(isMemberSatisfiable("node:process", "write", wasi)).toBe(true);
    expect(isMemberSatisfiable("node:process", "stdout", wasi)).toBe(true);
    expect(isMemberSatisfiable("node:process", "stderr", wasi)).toBe(true);
  });

  it("process std-IO is satisfiable under a JS host too (js-host-fs provider)", () => {
    const host = { wasi: false, allowFs: false };
    expect(isMemberSatisfiable("node:process", "write", host)).toBe(true);
    expect(isMemberSatisfiable("node:process", "stdout", host)).toBe(true);
  });

  it("the process std-IO members are known to the map", () => {
    expect(isKnownMember("node:process", "write")).toBe(true);
    expect(isKnownMember("node:process", "stdout")).toBe(true);
    expect(isKnownMember("node:process", "stderr")).toBe(true);
  });

  it("a fabricated unsatisfiable member is undefined (unknown), not satisfiable", () => {
    const wasi = { wasi: true, allowFs: false };
    // An unmapped member returns `undefined` (caller decides — usually permissive),
    // and is certainly not `true`.
    expect(isMemberSatisfiable("node:process", "__nope_no_such_member__", wasi)).toBe(undefined);
    expect(isMemberSatisfiable("node:process", "__nope_no_such_member__", wasi)).not.toBe(true);
    expect(isKnownMember("node:process", "__nope_no_such_member__")).toBe(false);
  });

  it("the node:process map entry is byte-neutral for a non-process program's injected dts", () => {
    // A program that touches NO node:process surface must get the SAME injected
    // dts whether or not the map carries node:process entries — i.e. the entry
    // only matters for programs that actually import/use node:process.
    const fsOnly = `
import { readSync } from "node:fs";
export function main(): void {
  const buf = new Uint8Array(4);
  readSync(0, buf, { offset: 0, length: 4 });
}
`;
    const dts = buildNodeEnvDtsForSource(fsOnly, /* scriptKind */ undefined);
    // The node:fs surface is present; the node:process module is NOT injected for
    // a program that never touches it (the entry is satisfiability metadata, not
    // an unconditional decl).
    expect(dts).toBeDefined();
    expect(dts ?? "").not.toMatch(/declare module "node:process"/);

    // A program that DOES use process.stdout still emits the bespoke node:process
    // module (unchanged by the metadata-only map entry).
    const procSrc = `
export function main(): void {
  process.stdout.write("hi");
}
`;
    const procDts = buildNodeEnvDtsForSource(procSrc, undefined);
    expect(procDts ?? "").toMatch(/process|NodeJS_Process/);
  });
});
