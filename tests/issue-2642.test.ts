/**
 * Issue #2642 — stale cached `__wasi_write_string` funcIdx across a late-import
 * boundary, in WASI `console.log`.
 *
 * Root cause: `compileConsoleCallWasi` (and the sibling `emitWasiValueToStdout`)
 * cached `__wasi_write_string`'s function index ONCE at the top, then reused it
 * for the separator / template-part / trailing-newline / placeholder writes.
 * Compiling an inline-concat argument whose value is `string | null` /
 * `string | undefined` (an externref union) inserts the `__extern_toString`
 * late import via `ensureLateImport` + `flushLateImportShifts`, which shifts
 * EVERY function index by +1. The trailing newline then emitted the STALE index
 * → it resolved to a different function (`__regex_escape`) → invalid Wasm
 * (`call expected (ref null N), found i32.const`) under --target wasi.
 *
 * Fix: re-read the helper index by NAME from `ctx.funcMap` at every emission
 * site that runs AFTER a `compileExpression` / `ensure*Helper` call, instead of
 * caching it across the union-concat argument's compilation. Same family as
 * #1461 / #2193 — name-based repoint.
 *
 * These are VALIDITY tests: the #2642 bug produced a `call`-type mismatch that
 * `WebAssembly.compile` rejects. The shared index-shift path means batch /
 * test262 validation is also required (done in CI); per #1968 an isolated
 * byte-diff would be a FALSE NEGATIVE for this index-shift family, so the guard
 * is "the module validates", confirmed below to FAIL pre-fix and PASS post-fix.
 * A runtime-output check is included only for the negative control, which has
 * no extern import (so no host string-marshalling shim is needed).
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";

/** Compile to a wasi binary and assert WebAssembly accepts it. */
async function expectValidWasi(src: string): Promise<Uint8Array> {
  const r = await compile(src, { fileName: "x.ts", target: "wasi" });
  expect(r.success).toBe(true);
  expect(r.binary && r.binary.length > 0).toBe(true);
  // WebAssembly.compile surfaces the precise validation error (validate() only
  // returns a boolean). The #2642 bug produced
  // `call expected (ref null N), found i32.const` right here.
  await expect(WebAssembly.compile(r.binary)).resolves.toBeDefined();
  return r.binary;
}

/** Run a compiled WASI module with NO extern imports, capturing fd bytes. */
function runWasiCaptureFd(binary: Uint8Array, fd: number): Uint8Array {
  const ref: { mem: WebAssembly.Memory | undefined } = { mem: undefined };
  const memView = () => new DataView(ref.mem!.buffer);
  const captured: number[] = [];
  const wasi = {
    fd_read: () => 0,
    fd_write(wfd: number, iovs: number, iovsLen: number, nwritten: number): number {
      const view = memView();
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const ptr = view.getUint32(iovs + i * 8, true);
        const len = view.getUint32(iovs + i * 8 + 4, true);
        if (wfd === fd) for (const b of new Uint8Array(ref.mem!.buffer, ptr, len)) captured.push(b);
        total += len;
      }
      view.setUint32(nwritten, total, true);
      return 0;
    },
    proc_exit: () => {},
    random_get: () => 0,
    clock_time_get: () => 0,
  };
  const inst = new WebAssembly.Instance(new WebAssembly.Module(binary), {
    wasi_snapshot_preview1: wasi,
    env: {},
  });
  ref.mem = inst.exports.memory as WebAssembly.Memory;
  (inst.exports.main as () => void)();
  return Uint8Array.from(captured);
}

describe("#2642 stale __wasi_write_string funcIdx across late-import boundary", () => {
  // ── The bug: each of these inserts a late import while compiling the concat
  //    argument, shifting indices; the trailing-newline (and separator) write
  //    used the stale index → invalid Wasm. Post-fix they validate. ──

  it("string|null concat argument in console.log → VALID wasi", async () => {
    await expectValidWasi(`
function rd(): string | null { return "x"; }
export function main(): void { const x = rd(); if (x !== null) { console.log("r:" + x); } }
`);
  });

  it("string|undefined concat argument in console.log → VALID wasi", async () => {
    await expectValidWasi(`
function rd(): string | undefined { return "y"; }
export function main(): void { const x = rd(); if (x !== undefined) { console.log("r:" + x); } }
`);
  });

  it("union-concat as the FIRST of multiple console.log args → VALID wasi", async () => {
    // The space-separator write AND the trailing-newline write both follow the
    // late-import shift here, so both must re-read the helper index.
    await expectValidWasi(`
function rd(): string | null { return "z"; }
export function main(): void { const x = rd(); if (x !== null) { console.log("r:" + x, "end"); } }
`);
  });

  it("union-concat followed by a SECOND console.log call → VALID wasi", async () => {
    await expectValidWasi(`
function rd(): string | null { return "x"; }
export function main(): void {
  const x = rd();
  if (x !== null) {
    console.log("a:" + x);
    console.log("done");
  }
}
`);
  });

  it("union-concat in console.warn (stderr helper variant) → VALID wasi", async () => {
    // The stderr path uses __wasi_write_string_stderr — the same caching bug
    // applied to that helper's index too.
    await expectValidWasi(`
function rd(): string | null { return "x"; }
export function main(): void { const x = rd(); if (x !== null) { console.warn("w:" + x); } }
`);
  });

  // ── Negative control: a plain-string console.log inserts NO late import, so
  //    the fix is byte-neutral for it (#1968). Run it end-to-end (no extern
  //    imports needed) and assert exact output. ──
  it("negative control: plain-string console.log emits correctly under wasi", async () => {
    const binary = await expectValidWasi(`export function main(): void { console.log("hello world"); }`);
    const out = new TextDecoder().decode(runWasiCaptureFd(binary, 1));
    expect(out).toBe("hello world\n");
  });

  it("negative control: multi-arg plain-string console.log emits with separators", async () => {
    const binary = await expectValidWasi(`export function main(): void { console.log("a", "b", "c"); }`);
    const out = new TextDecoder().decode(runWasiCaptureFd(binary, 1));
    expect(out).toBe("a b c\n");
  });
});
