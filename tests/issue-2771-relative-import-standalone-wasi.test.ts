// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2771 — a standalone WASI program whose ENTRY imports a local `./shared`
 * helper, with the `node:fs` fd-IO seam split ACROSS the two files, must compile
 * to a self-contained WASI command module importing ONLY `wasi_snapshot_preview1`
 * (no `env.*` host imports) and echo byte-exact under wasmtime.
 *
 * Two blockers were fixed (both required — neither alone suffices):
 *   (a) the single-source CLI `compile()` reads exactly ONE file and strips every
 *       import, so `import { readExact } from "./shared"` was unresolved and
 *       `readExact`/`writeAll` lowered to bogus `env.*` host imports the WASI gate
 *       rejects. The CLI now routes an entry with a RELATIVE import to the
 *       multi-file bundler `compileProject` (entryHasRelativeImports).
 *   (b) the multi-file bundler `compileMultiSource` resolved relative imports but
 *       NEVER ran node:fs / raw-WASI detection, so a `node:fs` `readSync`/
 *       `writeSync` (even in the ENTRY) lowered to zero fd IO (imports = []). It
 *       now unions `detectNodeFsImports`/`detectRawWasiImports` across every
 *       bundled file so those calls lower to `fd_read`/`fd_write` module-wide.
 *
 * The runtime case requires REAL wasmtime and is skipped when it is not on PATH;
 * the compile-only invariants always run.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileProject, entryHasRelativeImports } from "../src/index.js";

// wasmtime feature flags for the WasmGC + exception-handling binaries js2wasm emits.
const WASMTIME_FLAGS = ["-W", "gc=y,function-references=y,exceptions=y"];

function findWasmtime(): string | null {
  for (const cand of ["wasmtime", "/usr/local/bin/wasmtime"]) {
    try {
      execFileSync(cand, ["--version"], { stdio: "ignore" });
      return cand;
    } catch {
      /* try next */
    }
  }
  return null;
}
const wasmtimeBin = findWasmtime();

/** The (module) name of every import in a compiled WAT. */
function importModules(wat: string): Set<string> {
  const mods = new Set<string>();
  for (const line of wat.split("\n")) {
    const m = line.match(/\(import\s+"([^"]+)"/);
    if (m) mods.add(m[1]!);
  }
  return mods;
}

/** Frame a body as a 4-byte LE length prefix + the body bytes (Native Messaging). */
function frame(body: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + body.length);
  const n = body.length;
  out[0] = n & 0xff;
  out[1] = (n >> 8) & 0xff;
  out[2] = (n >> 16) & 0xff;
  out[3] = (n >> 24) & 0xff;
  out.set(body, 4);
  return out;
}

// The shared helper file — owns the node:fs fd-IO seam (read/write over fd 0/1).
const SHARED_SRC = `import { readSync, writeSync } from "node:fs";

export function readExact(buf: Uint8Array, n: number): boolean {
  let got = 0;
  while (got < n) {
    const r = readSync(0, buf, { offset: got, length: n - got });
    if (r <= 0) return false;
    got = got + r;
  }
  return true;
}

export function writeAll(out: Uint8Array): void {
  let n = 0;
  while (n < out.length) {
    const w = writeSync(1, out, n);
    if (w <= 0) return;
    n = n + w;
  }
}
`;

// The entry file — imports the local helper, does the framing, echoes verbatim.
const ENTRY_SRC = `import { readExact, writeAll } from "./shared";

export function main(): void {
  const header = new Uint8Array(4);
  while (true) {
    if (!readExact(header, 4)) break;
    const len = header[0] + header[1] * 256 + header[2] * 65536 + header[3] * 16777216;
    if (len === 0) break;
    const body = new Uint8Array(len);
    if (!readExact(body, len)) break;
    const out = new Uint8Array(4 + len);
    out[0] = len & 0xff;
    out[1] = (len >> 8) & 0xff;
    out[2] = (len >> 16) & 0xff;
    out[3] = (len >> 24) & 0xff;
    let i = 0;
    while (i < len) {
      out[4 + i] = body[i];
      i = i + 1;
    }
    writeAll(out);
  }
}

main();
`;

interface RunResult {
  stdout: Uint8Array;
  exitCode: number | null;
  timedOut: boolean;
}

function runWasmtimeStdin(binPath: string, input: Uint8Array, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(wasmtimeBin!, [...WASMTIME_FLAGS, binPath], {
      stdio: ["pipe", "pipe", "ignore"], // drop fd 2 diagnostics
    });
    const out: number[] = [];
    child.stdout.on("data", (d: Buffer) => {
      for (const b of d) out.push(b);
    });
    child.stdin.on("error", () => {});
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill("SIGKILL");
      resolve({ stdout: Uint8Array.from(out), exitCode: null, timedOut: true });
    }, timeoutMs);
    child.on("exit", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ stdout: Uint8Array.from(out), exitCode: code, timedOut: false });
    });
    child.stdin.write(Buffer.from(input));
    child.stdin.end(); // single frame then EOF
  });
}

describe("#2771 — relative-import bundling for standalone WASI", () => {
  let tmpDir: string;
  let entryPath: string;
  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "issue-2771-"));
    writeFileSync(join(tmpDir, "shared.ts"), SHARED_SRC);
    entryPath = join(tmpDir, "entry.ts");
    writeFileSync(entryPath, ENTRY_SRC);
  });
  afterAll(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── routing predicate ────────────────────────────────────────────────────
  it("entryHasRelativeImports distinguishes relative from node:/bare imports", () => {
    expect(entryHasRelativeImports(ENTRY_SRC)).toBe(true);
    expect(entryHasRelativeImports(SHARED_SRC)).toBe(false); // only node:fs
    expect(entryHasRelativeImports(`import { x } from "lodash";`)).toBe(false);
    expect(entryHasRelativeImports(`export { y } from "./m";`)).toBe(true);
    expect(entryHasRelativeImports(`const m = require("../shared");`)).toBe(true);
    expect(entryHasRelativeImports(`export function f() { return 1; }`)).toBe(false);
  });

  // ── compile-only invariants (always run, no runtime needed) ───────────────
  it("a two-file standalone entry (node:fs IO in a shared helper) imports ONLY wasi_snapshot_preview1", async () => {
    const r = await compileProject(entryPath, { target: "wasi", emitWat: true });
    expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
    expect(WebAssembly.validate(r.binary!), "binary must validate").toBe(true);
    // The crux: NO `env.*` host import — only the WASI core module.
    expect([...importModules(r.wat!)]).toEqual(["wasi_snapshot_preview1"]);
    // And the fd syscalls the shared helper's readSync/writeSync lower to ARE present.
    expect(r.wat!.includes("fd_read"), "shared-helper readSync must lower to fd_read").toBe(true);
    expect(r.wat!.includes("fd_write"), "shared-helper writeSync must lower to fd_write").toBe(true);
  });

  // ── runtime behavior under real wasmtime (byte-exact echo) ─────────────────
  const maybe = wasmtimeBin ? it : it.skip;
  maybe("echoes a framed message byte-exact under wasmtime (fd_read/fd_write work)", { timeout: 30_000 }, async () => {
    const r = await compileProject(entryPath, { target: "wasi" });
    expect(r.success).toBe(true);
    const binPath = join(tmpDir, "entry.wasm");
    writeFileSync(binPath, r.binary!);

    const body = new TextEncoder().encode('{"hello":"world","n":42}');
    const input = frame(body);
    const res = await runWasmtimeStdin(binPath, input, 20_000);
    expect(res.timedOut, "must not hang").toBe(false);
    // Echo: the program writes back the same 4-byte prefix + body it read.
    expect(Buffer.from(res.stdout).equals(Buffer.from(input))).toBe(true);
  });
});
