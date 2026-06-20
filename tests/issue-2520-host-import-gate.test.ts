import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

// #2520 — the lib-file ambient-`declare function` scan only registers a global
// as a host import when the user source genuinely references it (resolved to an
// ambient declaration, not a local variable or property of the same name). So
// touching one lib global (Uint8Array) no longer drags in the whole ambient
// global-function surface, and a local variable that shares a global's name
// doesn't pull that global in.
async function hostImportWarnings(src: string): Promise<string> {
  const r = await compile(src, { fileName: "g.ts", target: "wasi" });
  return (r.errors ?? []).map((e) => e.message).join("\n");
}

describe("#2520 — lib-scan ambient-global referenced-names gate", () => {
  it("does not register unreferenced ambient globals (no env.alert/fetch/scroll flood)", async () => {
    // Uses Uint8Array (triggers the lib scan) but references none of these.
    const warns = await hostImportWarnings(`export function f(): number { const a = new Uint8Array(4); return a[0]; }`);
    for (const g of ["env.alert", "env.fetch", "env.scroll", "env.matchMedia", "env.postMessage", "env.eval"]) {
      expect(warns).not.toContain(`"${g}"`);
    }
  });

  it("does not pull in a DOM global that only collides with a local variable name", async () => {
    // `let stop` is a local — must NOT register the DOM window.stop global.
    const warns = await hostImportWarnings(
      `export function f(): number { const a = new Uint8Array(2); let stop = 1; return a[stop]; }`,
    );
    expect(warns).not.toContain('"env.stop"');
  });

  it("does not register a builtin constructor object for plain `new`/type uses", async () => {
    // `new Uint8Array(...)` + a `Uint8Array` type annotation hit native fast
    // paths and need no host constructor object (global_Uint8Array).
    const warns = await hostImportWarnings(
      `export function f(buf: Uint8Array): number { const a = new Uint8Array(2); return a[0] + buf[0]; }`,
    );
    expect(warns).not.toContain('"env.global_Uint8Array"');
  });

  it("still registers the builtin constructor object for an identity/value use", async () => {
    // `x.constructor === Uint8Array` genuinely needs the reified constructor.
    const warns = await hostImportWarnings(
      `export function f(x: any): boolean { const a = new Uint8Array(1); return x.constructor === Uint8Array && a[0] === 0; }`,
    );
    expect(warns).toContain('"env.global_Uint8Array"');
  });
});
