// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2735 — the WASI `process.stdin` fd-readiness reactor must have a NON-EOF
 * termination trigger.
 *
 * The #2632 reactor (`async-scheduler.ts buildRunLoopBodyWithFdReactor`) exits
 * only when its `pending` test — `(nextTimer != I64_MAX) | fd0_active` — becomes
 * false, and `fd0_active` was cleared in EXACTLY ONE place: the 0-byte `fd_read`
 * (stdin EOF) in `buildStdinDrainBody`. So the program could ONLY terminate via
 * stdin EOF. The real Native-Messaging case keeps the pipe OPEN for the lifetime
 * of the port and signals end-of-conversation IN BAND (a zero-length frame), so
 * stdin never reaches EOF and `_start` HANGS forever (0 CPU, blocked in
 * poll_oneoff).
 *
 * The fix adds an escape hatch: a `__wasiStdinStop()` intrinsic that clears
 * `__stdin_fd_active` (mirroring the EOF clear), wired to `process.stdin.destroy()`
 * and to `process.exit()` (which drops the subscription, then calls WASI
 * `proc_exit`). The existing `native-messaging-comparison` suite only ever fed
 * BOUNDED buffers that close stdin (EOF), so it never exercised the open-stdin
 * path — these cases close that gap by keeping stdin OPEN.
 *
 * The runtime cases require REAL wasmtime (the reactor runs in the event loop,
 * which the in-process fd shim does not drive) and are skipped when it is not on
 * PATH; the compile-only cases always run.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// wasmtime feature flags for the WasmGC + exception-handling binaries js2wasm
// emits (structs/arrays + the exception tag).
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

const NM_DIR = join(__dirname, "..", "examples", "native-messaging");

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

/** The (module) name of every import in a compiled WAT. */
function importModules(wat: string): Set<string> {
  const mods = new Set<string>();
  for (const line of wat.split("\n")) {
    const m = line.match(/\(import\s+"([^"]+)"/);
    if (m) mods.add(m[1]!);
  }
  return mods;
}

async function compileWasi(src: string, name: string): Promise<Awaited<ReturnType<typeof compile>>> {
  return compile(src, { fileName: `${name}.ts`, target: "wasi", skipSemanticDiagnostics: true });
}

interface RunResult {
  stdout: Uint8Array;
  exitCode: number | null;
  timedOut: boolean;
}

/**
 * Spawn a compiled WASI module under wasmtime, write `input` to its stdin, and
 * resolve when it exits (or the timeout fires). When `keepOpen` is true the
 * parent's stdin pipe is DELIBERATELY left open (never `.end()`-ed) so the child
 * never sees EOF — the whole point of #2735: the program must terminate via the
 * in-band escape hatch, not via stdin EOF. `timedOut: true` means it hung (the
 * pre-fix behavior).
 */
function runWasmtimeStdin(
  binPath: string,
  input: Uint8Array,
  opts: { keepOpen: boolean; timeoutMs: number },
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(wasmtimeBin!, [...WASMTIME_FLAGS, binPath], {
      stdio: ["pipe", "pipe", "ignore"], // drop fd 2 diagnostics
    });
    const out: number[] = [];
    child.stdout.on("data", (d: Buffer) => {
      for (const b of d) out.push(b);
    });
    // The child may exit before we finish with its stdin → swallow EPIPE.
    child.stdin.on("error", () => {});
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill("SIGKILL");
      resolve({ stdout: Uint8Array.from(out), exitCode: null, timedOut: true });
    }, opts.timeoutMs);
    child.on("exit", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ stdout: Uint8Array.from(out), exitCode: code, timedOut: false });
    });
    child.stdin.write(Buffer.from(input));
    if (!opts.keepOpen) child.stdin.end();
  });
}

describe("#2735 — stdin reactor non-EOF termination", () => {
  let tmpDir: string;
  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "issue-2735-"));
  });
  afterAll(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  async function buildToDisk(src: string, name: string): Promise<string> {
    const r = await compileWasi(src, name);
    expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
    expect(WebAssembly.validate(r.binary!), `${name} binary must validate`).toBe(true);
    const path = join(tmpDir, `${name}.wasm`);
    writeFileSync(path, r.binary!);
    return path;
  }

  const requestBody = new TextEncoder().encode('["hello",null,42]');
  const requestFrame = frame(requestBody);
  const shutdownFrame = frame(new Uint8Array(0)); // zero-length = in-band clean shutdown

  // ── Compile-only invariants (always run, no runtime needed) ──────────────

  it("nm_js2wasm_node_process.ts still lowers to a standalone module importing only wasi_snapshot_preview1", async () => {
    // The destroy() → __wasiStdinStop() lowering must NOT leak an `env.*` host
    // import (a regression of the #2696 zero-env-leak guarantee).
    const src = readFileSync(join(NM_DIR, "nm_js2wasm_node_process.ts"), "utf-8");
    const r = await compileWasi(src, "nm_js2wasm_node_process_imports");
    expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
    expect(WebAssembly.validate(r.binary!)).toBe(true);
    expect([...importModules(r.wat!)]).toEqual(["wasi_snapshot_preview1"]);
    // The reactor IS wired (it uses process.stdin) ...
    expect(r.wat!.includes("__run_event_loop")).toBe(true);
  });

  it("a process.exit-only program does NOT force the stdin reactor", async () => {
    // __wasiStdinStop must only be emitted before proc_exit when the reactor is
    // already active — a program that never touches stdin stays reactor-free.
    const r = await compileWasi("process.exit(3);\n", "exit_only");
    expect(r.success).toBe(true);
    expect(r.wat!.includes("__run_event_loop"), "no event loop for a stdin-free program").toBe(false);
    expect(r.wat!.includes("__rl_stdin_drain"), "no stdin reactor for a stdin-free program").toBe(false);
  });

  // ── Runtime behavior under real wasmtime (the actual hang repro) ──────────

  const maybe = wasmtimeBin ? describe : describe.skip;
  maybe("under wasmtime (stdin kept OPEN — the real Native-Messaging case)", () => {
    it(
      "exits cleanly on an in-band zero-length shutdown frame and echoes the data frame byte-exact",
      { timeout: 30_000 },
      async () => {
        const binPath = await buildToDisk(
          readFileSync(join(NM_DIR, "nm_js2wasm_node_process.ts"), "utf-8"),
          "nm_open_shutdown",
        );
        const input = new Uint8Array([...requestFrame, ...shutdownFrame]);
        const res = await runWasmtimeStdin(binPath, input, { keepOpen: true, timeoutMs: 15_000 });
        // The pre-fix reactor would block forever here (timedOut: true).
        expect(res.timedOut, "open-stdin program HUNG — no non-EOF termination trigger").toBe(false);
        expect(res.exitCode).toBe(0);
        expect(Array.from(res.stdout), "must echo only the data frame, byte-exact").toEqual(Array.from(requestFrame));
      },
    );

    it("process.exit() with stdin held open exits cleanly", { timeout: 30_000 }, async () => {
      // A program whose data callback calls process.exit(0): proc_exit tears the
      // instance down (after dropping the fd0 subscription) even though stdin is
      // still open.
      const binPath = await buildToDisk(
        `process.stdin.on("data", (chunk: string) => { process.exit(0); });\n`,
        "exit_open_stdin",
      );
      const res = await runWasmtimeStdin(binPath, Uint8Array.of(9), { keepOpen: true, timeoutMs: 15_000 });
      expect(res.timedOut, "process.exit() did not terminate with stdin open").toBe(false);
      expect(res.exitCode).toBe(0);
    });
  });

  maybe("under wasmtime (stdin CLOSED — EOF path stays green)", () => {
    it("EOF-closed stdin still echoes the frame and exits", { timeout: 30_000 }, async () => {
      const binPath = await buildToDisk(
        readFileSync(join(NM_DIR, "nm_js2wasm_node_process.ts"), "utf-8"),
        "nm_eof_close",
      );
      // Same input, but the parent CLOSES stdin → the reactor's existing EOF
      // trigger fires. This must remain unaffected by the new escape hatch.
      const input = new Uint8Array([...requestFrame, ...shutdownFrame]);
      const res = await runWasmtimeStdin(binPath, input, { keepOpen: false, timeoutMs: 15_000 });
      expect(res.timedOut, "EOF-closed program HUNG").toBe(false);
      expect(Array.from(res.stdout)).toEqual(Array.from(requestFrame));
    });

    it("a bounded buffer with no shutdown frame still exits on EOF", { timeout: 30_000 }, async () => {
      const binPath = await buildToDisk(
        readFileSync(join(NM_DIR, "nm_js2wasm_node_process.ts"), "utf-8"),
        "nm_eof_plain",
      );
      const res = await runWasmtimeStdin(binPath, requestFrame, { keepOpen: false, timeoutMs: 15_000 });
      expect(res.timedOut).toBe(false);
      expect(Array.from(res.stdout)).toEqual(Array.from(requestFrame));
    });
  });
});
