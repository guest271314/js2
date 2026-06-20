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
});
