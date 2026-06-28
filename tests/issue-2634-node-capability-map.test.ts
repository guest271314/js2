// #2634 — @types/node → capability-map extraction for node:fs (Phase 2 of #1772).
//
// The hand-written approximate `node:fs` typings (#2631) are replaced by a
// capability map (`src/checker/node-capability-map.ts`) that drives the
// importable surface from the REAL `@types/node` signatures. This test asserts:
//   1. The real-Node forms now type-check (both readSync overloads, both
//      writeSync overloads — including the STRING form — and a DataView buffer).
//   2. Nonsensical mixes the old single collapsed signature wrongly accepted are
//      now rejected (faithful overloads, not an approximation).
//   3. An unsatisfiable member (openSync under --target wasi) yields the
//      deliberate "no provider" compile error, not a silent link failure.
//   4. The allowJs/.js host (the #1768/#2631 transpiled-host case) still has no
//      TS8017 with faithful OVERLOADS in the injected surface.
import { describe, expect, it } from "vitest";
import { analyzeSource } from "../src/checker/index.js";
import { compile } from "../src/index.js";
import { isMemberSatisfiable } from "../src/checker/node-capability-map.js";

/** Type-check `src` under Node emulation; return error-category diagnostics. */
function typeErrors(src: string, fileName = "x.ts"): ts2wasmDiag[] {
  const ast = analyzeSource(src, fileName, { emulateNode: true });
  return ast.diagnostics
    .filter((d) => d.category === 1)
    .map((d) => ({
      code: d.code,
      message: typeof d.messageText === "string" ? d.messageText : d.messageText.messageText,
    }));
}
interface ts2wasmDiag {
  code: number;
  message: string;
}

describe("#2634 — node:fs capability map (real @types/node forms)", () => {
  // ── Fidelity gap #1: collapsed overloads ──────────────────────────────────
  it("type-checks BOTH real readSync overloads (positional + options)", () => {
    const src = `
import { readSync } from "node:fs";
const buf = new Uint8Array(10);
const a: number = readSync(0, buf, 0, 10, null);           // positional
const b: number = readSync(0, buf, { offset: 0, length: 10 }); // options
const c: number = readSync(0, buf);                        // options omitted
`;
    expect(typeErrors(src)).toEqual([]);
  });

  it("type-checks BOTH real writeSync overloads — buffer AND the STRING form", () => {
    const src = `
import { writeSync } from "node:fs";
const buf = new Uint8Array(10);
const a: number = writeSync(1, buf, 0);          // buffer + offset
const b: number = writeSync(1, buf);             // buffer only
const c: number = writeSync(1, "hello");         // STRING form (gap #1)
const d: number = writeSync(1, "hello", 0, "utf8"); // string + position + encoding
`;
    expect(typeErrors(src)).toEqual([]);
  });

  // ── Fidelity gap #2: buffer type too narrow ───────────────────────────────
  it("accepts a DataView buffer (NodeJS.ArrayBufferView, not just Uint8Array)", () => {
    const src = `
import { readSync, writeSync } from "node:fs";
const dv = new DataView(new ArrayBuffer(16));
const a: number = readSync(0, dv, 0, 16, null);
const b: number = writeSync(1, dv, 0);
`;
    expect(typeErrors(src)).toEqual([]);
  });

  it("accepts other TypedArray buffers (Float64Array, Int32Array)", () => {
    const src = `
import { readSync } from "node:fs";
const f = new Float64Array(4);
const i = new Int32Array(4);
const a: number = readSync(0, f, 0, 4, null);
const b: number = readSync(0, i, { length: 4 });
`;
    expect(typeErrors(src)).toEqual([]);
  });

  // ── Faithful overloads REJECT nonsensical mixes the old approx accepted ────
  it("rejects a nonsensical mix the old collapsed signature wrongly accepted", () => {
    // The old single signature `(fd, buffer, offsetOrOptions?, length?, position?)`
    // accepted an options object FOLLOWED by positional length/position — which
    // matches NO real Node overload. Faithful overloads reject it.
    const src = `
import { readSync } from "node:fs";
const buf = new Uint8Array(10);
readSync(0, buf, { offset: 0 }, 10, null);
`;
    const errs = typeErrors(src);
    expect(errs.length).toBeGreaterThan(0);
  });

  it("rejects a non-buffer, non-string second arg to writeSync", () => {
    const src = `
import { writeSync } from "node:fs";
writeSync(1, 12345);
`;
    expect(typeErrors(src).length).toBeGreaterThan(0);
  });

  // ── Capability map: satisfiable vs deliberate-error ───────────────────────
  it("classifies fd-based members satisfiable, path-based unsatisfiable under wasi", () => {
    const wasi = { wasi: true, allowFs: false };
    const host = { wasi: false, allowFs: false };
    const hostFs = { wasi: false, allowFs: true };
    // fd-based: linkable everywhere.
    expect(isMemberSatisfiable("node:fs", "readSync", wasi)).toBe(true);
    expect(isMemberSatisfiable("node:fs", "writeSync", wasi)).toBe(true);
    expect(isMemberSatisfiable("node:fs", "readSync", host)).toBe(true);
    // path-based: NOT satisfiable under standalone wasi (no filesystem)…
    expect(isMemberSatisfiable("node:fs", "openSync", wasi)).toBe(false);
    expect(isMemberSatisfiable("node:fs", "readFileSync", wasi)).toBe(false);
    // …but satisfiable with --allow-fs (JS host).
    expect(isMemberSatisfiable("node:fs", "openSync", hostFs)).toBe(true);
    // unknown member: undefined (caller stays permissive).
    expect(isMemberSatisfiable("node:fs", "totallyMadeUp", wasi)).toBeUndefined();
  });

  it("an unsatisfiable member (openSync under --target wasi) raises a deliberate compile error", async () => {
    const src = `
import { openSync } from "node:fs";
export function main(): void {
  const fd = openSync("/etc/hostname", "r");
}
`;
    const result = await compile(src, { fileName: "x.ts", target: "wasi", link: ["node:fs"] });
    expect(result.success).toBe(false);
    const msgs = (result.errors ?? []).map((e) => e.message).join("\n");
    // Precise, deliberate — names the member and the target, not an opaque crash.
    expect(msgs).toMatch(/openSync/);
    // #1772 P2-a — the capability-map-driven gate in `tryCompileNodeFsCall` now
    // owns this rejection (it consumes the call before the legacy
    // `PATH_BASED_FS_FNS` gate), so the message is the map gate's precise text.
    expect(msgs).toMatch(/(un)?available under `?--target wasi`?|no filesystem|filesystem provider|#2631/);
  });

  // ── allowJs / TS8017: faithful OVERLOADS must not trip the transpiled host ─
  it("no TS8017 with overloaded node:fs surface when the import site is a .js host", () => {
    const src = `import { readSync, writeSync } from "node:fs";
const buf = new Uint8Array(10);
readSync(0, buf, 0, 10, null);
readSync(0, buf, { offset: 0, length: 10 });
writeSync(1, buf, 0);
writeSync(1, "hello");
`;
    // .js file ⇒ allowJs/checkJs. Bodiless overloads in a NON-declaration file
    // trip TS8017; here they live in the injected .d.ts-typed surface, so the
    // import site stays clean.
    const errs = typeErrors(src, "host.js");
    expect(errs.filter((e) => e.code === 8017)).toEqual([]);
  });

  it("readSync/writeSync still lower + round-trip under wasi (no codegen regression)", async () => {
    const src = `
import { readSync, writeSync } from "node:fs";
export function main(): void {
  const buf = new Uint8Array(4);
  const r = readSync(0, buf, { offset: 0, length: 4 });
  let n = 0;
  while (n < r) { const w = writeSync(1, buf, n); if (w <= 0) break; n = n + w; }
}
`;
    const result = await compile(src, { fileName: "x.ts", target: "wasi", link: ["node:fs"] });
    expect(result.success).toBe(true);
    const wat = result.wat ?? "";
    expect(wat).toContain('(import "node:fs" "readSync"');
    expect(wat).toContain('(import "node:fs" "writeSync"');
  });
});
