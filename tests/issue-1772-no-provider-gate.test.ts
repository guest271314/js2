// #1772 Phase 2 / Slice P2-a — wire the "no provider" codegen gate.
//
// `src/checker/node-capability-map.ts` (#2634) provides `isMemberSatisfiable`,
// but until this slice it was DEAD CODE — nothing in `src/codegen/` consulted it,
// so a path-based `node:fs` member (`readFileSync(path)`) under `--target wasi`
// produced only the generic #1035 error / a silent link failure, not the precise
// "no provider, pass --allow-fs" guidance the capability map promises.
//
// This test asserts the gate (now wired into `tryCompileNodeFsCall`):
//   1. A `--target wasi` program importing a path-based member (`readFileSync`)
//      from `node:fs` fails to compile, and the error names the member + `--allow-fs`.
//   2. A `readSync`/`writeSync` program (fd-based, satisfiable) still compiles green.
//   3. A NON-wasi compile of the same `readFileSync` program is NOT gated
//      (path-based members resolve through the real `node:fs` under a JS host).
//   4. A same-named LOCAL function (`function readFileSync(){}`) — not imported
//      from `node:fs` — is NOT gated.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

describe("#1772 P2-a — node:fs no-provider codegen gate", () => {
  it("rejects a path-based node:fs member under --target wasi with a precise error", async () => {
    const src = `
import { readFileSync } from "node:fs";
export function main(): void {
  const data = readFileSync("/etc/hostname");
}
`;
    const result = await compile(src, {
      fileName: "x.ts",
      target: "wasi",
      link: ["node:fs"],
    });
    expect(result.success).toBe(false);
    const msgs = (result.errors ?? []).map((e) => e.message).join("\n");
    // Names the member …
    expect(msgs).toMatch(/readFileSync/);
    // … and points at the actionable `--allow-fs` escape hatch.
    expect(msgs).toMatch(/--allow-fs/);
    // … and is target-precise.
    expect(msgs).toMatch(/--target wasi/);
  });

  it("the gate also fires WITHOUT --link node:fs (it keys off --target wasi)", async () => {
    const src = `
import { readFileSync } from "node:fs";
export function main(): void {
  const data = readFileSync("/etc/hostname");
}
`;
    // No `link`: the gate must still fire (it sits after the !ctx.wasi
    // guard but before the internal !ctx.linkNodeShims short-circuit).
    const result = await compile(src, { fileName: "x.ts", target: "wasi" });
    expect(result.success).toBe(false);
    const msgs = (result.errors ?? []).map((e) => e.message).join("\n");
    expect(msgs).toMatch(/readFileSync/);
    expect(msgs).toMatch(/--allow-fs/);
  });

  it("a satisfiable fd-based program (readSync/writeSync) still compiles green under --target wasi", async () => {
    const src = `
import { readSync, writeSync } from "node:fs";
export function main(): void {
  const buf = new Uint8Array(4);
  const r = readSync(0, buf, { offset: 0, length: 4 });
  let n = 0;
  while (n < r) { const w = writeSync(1, buf, n); if (w <= 0) break; n = n + w; }
}
`;
    const result = await compile(src, {
      fileName: "x.ts",
      target: "wasi",
      link: ["node:fs"],
    });
    expect(result.success).toBe(true);
  });

  it("a NON-wasi compile of the same readFileSync program is NOT gated", async () => {
    const src = `
import { readFileSync } from "node:fs";
export function main(): void {
  const data = readFileSync("/etc/hostname");
}
`;
    // Under a JS host (no --target wasi), the gate must be a no-op — path-based
    // members resolve through the real `node:fs`. Whatever the outcome, the
    // capability-map "no provider under --target wasi" error must NOT appear.
    const result = await compile(src, { fileName: "x.ts" });
    const msgs = (result.errors ?? []).map((e) => e.message).join("\n");
    expect(msgs).not.toMatch(/needs a filesystem provider, unavailable under `--target wasi`/);
  });

  it("a same-named LOCAL function (not imported from node:fs) is NOT gated", async () => {
    const src = `
function readFileSync(p: string): number { return p.length; }
export function main(): number {
  return readFileSync("/etc/hostname");
}
`;
    const result = await compile(src, {
      fileName: "x.ts",
      target: "wasi",
      link: ["node:fs"],
    });
    // The local function is unrelated to node:fs; the gate keys off the
    // node:fs import set, so it must not fire here.
    const msgs = (result.errors ?? []).map((e) => e.message).join("\n");
    expect(msgs).not.toMatch(/needs a filesystem provider/);
    expect(result.success).toBe(true);
  });
});
