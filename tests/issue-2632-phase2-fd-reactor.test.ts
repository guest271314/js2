// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2632 Phase 2 — WASI async runtime: the fd-readiness reactor.
 *
 * Phase 1 (#1980) built the scheduler + timers + microtasks; `__run_event_loop`
 * blocked to the nearest timer deadline via a SINGLE-clock `poll_oneoff`
 * (`__wasi_sleep_ms`). Phase 2 turns that into a real reactor that waits on
 * "fd0-readable OR the nearest timer" — a MULTI-subscription `poll_oneoff`
 * (fd0 FD_READ + a CLOCK deadline) — and drains fd0 into an internal stdin
 * buffer via a non-blocking `fd_read` (fd0 set non-blocking via
 * `fd_fdstat_set_flags`). This is the substrate Phase 3's `process.stdin`
 * Readable will pull from; it does NOT yet expose `process.stdin`.
 *
 * The internal-buffer access primitive exposed for testing is the
 * `__wasiStdinReadByte()` intrinsic (returns the next buffered byte 0..255, or
 * -1 when empty), which the reactor fills before/between firing due timers.
 *
 * These cases:
 *   1. assert the compile-time wiring (reactor helpers + imports present, and
 *      that a non-stdin program is byte-neutral),
 *   2. drive the reactor through the runtime `poll_oneoff` / `fd_read` polyfill
 *      (deterministic, no real OS poll), and
 *   3. run end-to-end under real wasmtime with piped stdin (ordering: the
 *      reactor wakes on stdin readiness before a later timer, and on the timer
 *      when stdin is idle).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildWasiPolyfill } from "../src/runtime.js";

// wasmtime feature flags required for the WasmGC + exception-handling binaries
// js2wasm emits (structs/arrays + the exception tag).
const WASMTIME_FLAGS = ["-W", "gc=y,function-references=y,exceptions=y"];

/** Resolve a usable `wasmtime` binary, or null when none is on PATH. */
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

let tmpDir: string;
beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "issue-2632-p2-"));
});
afterAll(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

async function compileWasi(src: string, name: string): Promise<Uint8Array> {
  const r = await compile(src, { fileName: `${name}.ts`, target: "wasi", skipSemanticDiagnostics: true });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  return r.binary!;
}

/** Compile under --target wasi, run under wasmtime with `stdin` piped in. */
function runWasmtime(binary: Uint8Array, name: string, stdin: string): string[] {
  const path = join(tmpDir, `${name}.wasm`);
  writeFileSync(path, binary);
  const out = execFileSync(wasmtimeBin!, [...WASMTIME_FLAGS, path], { input: stdin, encoding: "utf-8" });
  return out.split("\n").filter((l) => l.length > 0);
}

/**
 * Drive a compiled WASI module through the runtime polyfill with a preloaded
 * stdin source, capturing console.log lines. Exercises the multi-sub
 * poll_oneoff + non-blocking fd_read polyfill path without a real OS poll.
 */
async function runPolyfill(binary: Uint8Array, stdin: string): Promise<string[]> {
  const lines: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    const wasi = buildWasiPolyfill();
    wasi.setStdin(stdin);
    const { instance } = await WebAssembly.instantiate(binary, {
      wasi_snapshot_preview1: wasi as unknown as WebAssembly.ModuleImports,
      env: wasi.envImports,
    });
    wasi.setMemory(instance.exports.memory as WebAssembly.Memory);
    (instance.exports._start as () => void)();
  } finally {
    console.log = origLog;
  }
  return lines;
}

describe("#2632 Phase 2 — compile-time wiring", () => {
  it("a `__wasiStdinReadByte()` program emits the fd-reactor helpers + imports", async () => {
    const r = await compile(`setTimeout(() => { while (__wasiStdinReadByte() >= 0) {} }, 1);`, {
      target: "wasi",
      skipSemanticDiagnostics: true,
    });
    expect(r.success, r.success ? "" : r.errors?.[0]?.message).toBe(true);
    const wat = r.wat!;
    // Reactor + Phase-2 helpers.
    expect(wat).toContain("$__run_event_loop");
    expect(wat).toContain("$__rl_stdin_drain");
    expect(wat).toContain("$__rl_poll_fd0_or_clock");
    // WASI imports the reactor needs.
    expect(wat).toContain("fd_read");
    expect(wat).toContain("poll_oneoff");
    expect(wat).toContain("fd_fdstat_set_flags");
    // The whole module must be valid Wasm (guards against late-import index drift).
    expect(WebAssembly.validate(r.binary!)).toBe(true);
  });

  it("a timer-only program (no stdin) does NOT register the fd reactor", async () => {
    const r = await compile(`setTimeout(() => {}, 5);`, { target: "wasi", skipSemanticDiagnostics: true });
    expect(r.success).toBe(true);
    expect(r.wat!).toContain("$__run_event_loop");
    // No fd-reactor helpers / fd0 imports for a timer-only program.
    expect(r.wat!).not.toContain("$__rl_stdin_drain");
    expect(r.wat!).not.toContain("$__rl_poll_fd0_or_clock");
    expect(r.wat!).not.toContain("fd_fdstat_set_flags");
  });

  it("string concat inside the reactor callback still validates (late-import shift lockstep)", async () => {
    // `"n:" + b` pulls a late string-concat import while the timer callback is
    // compiled, BEFORE the timer's now-reader call is baked. The async-scheduler
    // func-index lockstep in flushLateImportShifts keeps `__rl_now_ns` correct.
    const r = await compile(
      `setTimeout(() => { let b = __wasiStdinReadByte(); while (b >= 0) { console.log("n:" + b); b = __wasiStdinReadByte(); } }, 5);`,
      { target: "wasi", skipSemanticDiagnostics: true },
    );
    expect(r.success, r.success ? "" : r.errors?.[0]?.message).toBe(true);
    expect(WebAssembly.validate(r.binary!)).toBe(true);
  });
});

describe("#2632 Phase 2 — fd reactor via the runtime poll_oneoff/fd_read polyfill", () => {
  // Timer callback drains the internal stdin buffer one byte at a time, logging
  // a literal per byte. The reactor must have filled the buffer (fd0 readable →
  // fd_read) before the timer fires.
  const echoProgram = `
    setTimeout(() => {
      let b = __wasiStdinReadByte();
      while (b >= 0) { console.log("byte"); b = __wasiStdinReadByte(); }
      console.log("end");
    }, 5);
  `;

  it("drains 2 bytes of preloaded stdin into the buffer before the timer fires", async () => {
    const bin = await compileWasi(echoProgram, "poly-echo-2");
    const lines = await runPolyfill(bin, "Hi");
    expect(lines).toEqual(["byte", "byte", "end"]);
  });

  it("empty stdin → EOF immediately, no bytes buffered", async () => {
    const bin = await compileWasi(echoProgram, "poly-echo-0");
    const lines = await runPolyfill(bin, "");
    expect(lines).toEqual(["end"]);
  });

  it("drains all 3 bytes for a 3-byte stdin", async () => {
    const bin = await compileWasi(echoProgram, "poly-echo-3");
    const lines = await runPolyfill(bin, "ABC");
    expect(lines).toEqual(["byte", "byte", "byte", "end"]);
  });

  it("wakes on stdin readiness before a much-later timer; wakes on the timer when idle", async () => {
    // A fast interval drains stdin; on the first byte it logs "stdin" and stops.
    // A 60ms timer logs "timeout". The reactor's multi-sub poll lets fd0
    // readiness win over the far timer when stdin is present.
    const program = `
      let seen = 0;
      let id = setInterval(() => {
        let b = __wasiStdinReadByte();
        if (b >= 0) { console.log("stdin"); seen = 1; clearInterval(id); }
      }, 1);
      setTimeout(() => { console.log("timeout"); if (seen === 0) { clearInterval(id); } }, 60);
    `;
    const bin = await compileWasi(program, "poly-order");
    expect(await runPolyfill(bin, "x")).toEqual(["stdin", "timeout"]);
    expect(await runPolyfill(bin, "")).toEqual(["timeout"]);
  });
});

describe.skipIf(!wasmtimeBin)("#2632 Phase 2 — fd reactor end-to-end under real wasmtime", () => {
  const echoProgram = `
    setTimeout(() => {
      let b = __wasiStdinReadByte();
      while (b >= 0) { console.log("byte"); b = __wasiStdinReadByte(); }
      console.log("end");
    }, 5);
  `;

  it("non-blocking fd_read drains piped stdin into the buffer for the timer to consume", async () => {
    const bin = await compileWasi(echoProgram, "wt-echo");
    expect(runWasmtime(bin, "wt-echo", "Hi")).toEqual(["byte", "byte", "end"]);
    expect(runWasmtime(bin, "wt-echo", "")).toEqual(["end"]);
    expect(runWasmtime(bin, "wt-echo", "ABC")).toEqual(["byte", "byte", "byte", "end"]);
  });

  it("reactor wakes on stdin readiness before a far timer, and on the timer when idle", async () => {
    const program = `
      let seen = 0;
      let id = setInterval(() => {
        let b = __wasiStdinReadByte();
        if (b >= 0) { console.log("stdin"); seen = 1; clearInterval(id); }
      }, 1);
      setTimeout(() => { console.log("timeout"); if (seen === 0) { clearInterval(id); } }, 60);
    `;
    const bin = await compileWasi(program, "wt-order");
    expect(runWasmtime(bin, "wt-order", "x")).toEqual(["stdin", "timeout"]);
    expect(runWasmtime(bin, "wt-order", "")).toEqual(["timeout"]);
  });
});
