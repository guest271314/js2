// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2643 Slice A — WASI Preview-2 interop via the jco Preview-1→Preview-2 adapter.
 *
 * The #2632 async event-loop reactor (timers, microtasks, the fd0-readiness
 * reactor, and the Phase-3 `process.stdin` Readable) is implemented against WASI
 * **Preview 1** `poll_oneoff`. This suite proves the issue's user-facing
 * acceptance bullet — "the `process.stdin` Readable runs under a Preview-2 host
 * with identical behaviour" — with **zero codegen change**: the same Phase-3
 * programs compile to a `--target wasi` Preview-1 core module, are adapted to a
 * Preview-2 **component** by the official `@bytecodealliance/jco` adapter
 * (`wasm-tools component new` under the hood), and run under wasmtime 44's
 * component model, where `poll_oneoff`/`fd_read`/`clock_time_get` are satisfied
 * by the host's real `wasi:io/poll` + `wasi:clocks` + `wasi:io/streams`.
 *
 * The assertion is **byte-identical streaming output** to the Preview-1 wasmtime
 * arm for the same piped stdin. This is the ecosystem-standard way a Preview-1
 * producer targets WASI 0.2; the native `wasi:io/poll` lowering (Slice B2–B4) is
 * a deferred component-model epic (see the issue's Implementation Plan) and is
 * NOT exercised here.
 *
 * Gated on:
 *   - `findWasmtime()` (wasmtime present), exactly like the Phase-2/Phase-3 tests;
 *   - the jco Preview-1→Preview-2 adapter being installed (`resolveJco()`).
 * Skips cleanly when either is absent.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
// @ts-expect-error — plain .mjs helper, no type declarations.
import { adaptToPreview2Component, resolveJco } from "../scripts/wasi-p2-component.mjs";

// GC + function-references + exceptions are required for our WasmGC core module;
// component-model=y is required for the adapted Preview-2 component.
const GC_FLAGS = "gc=y,function-references=y,exceptions=y";
const P1_FLAGS = ["-W", GC_FLAGS];
const P2_FLAGS = ["run", "-W", `component-model=y,${GC_FLAGS}`];

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
const jco = resolveJco();
const canRun = Boolean(wasmtimeBin) && Boolean(jco);

let tmpDir: string;
beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "issue-2643-p2-"));
});
afterAll(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

async function compileWasi(src: string, name: string): Promise<Uint8Array> {
  const r = await compile(src, { fileName: `${name}.ts`, target: "wasi", skipSemanticDiagnostics: true });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  expect(WebAssembly.validate(r.binary!), "binary must validate").toBe(true);
  return r.binary!;
}

/** Run the Preview-1 core module directly under wasmtime, returning raw stdout. */
function runPreview1(binary: Uint8Array, name: string, stdin: string): string {
  const path = join(tmpDir, `${name}.core.wasm`);
  writeFileSync(path, binary);
  return execFileSync(wasmtimeBin!, [...P1_FLAGS, path], { input: stdin, encoding: "utf-8" });
}

/**
 * Adapt the Preview-1 core module to a Preview-2 component (command adapter,
 * since the module is `_start`-driven) and run it under wasmtime's component
 * model, returning raw stdout.
 */
function runPreview2(binary: Uint8Array, name: string, stdin: string): string {
  const corePath = join(tmpDir, `${name}.core.wasm`);
  const compPath = join(tmpDir, `${name}.component.wasm`);
  writeFileSync(corePath, binary);
  adaptToPreview2Component(corePath, compPath, { shape: "command", jco });
  return execFileSync(wasmtimeBin!, [...P2_FLAGS, compPath], { input: stdin, encoding: "utf-8" });
}

// The same Phase-3 prelude programs proven on Preview 1 in
// `tests/issue-2632-phase3-stdin-prelude.test.ts`.
const dataProgram = `
  process.stdin.on("data", (chunk: string) => { console.log("d:" + chunk); });
  process.stdin.on("end", () => { console.log("end"); });
`;
const readProgram = `
  const s = process.stdin;
  s.pause();
  function emit(chunk: string): void { console.log("r:" + chunk); }
  s.on("readable", () => {
    let x = s.read(3);
    while (x !== null) { emit(x); x = s.read(3); }
  });
  s.on("end", () => { console.log("eof"); });
`;

describe("#2643 Slice A — jco adapter resolution", () => {
  it("locates the Preview-1→Preview-2 command adapter programmatically", () => {
    // When deps are installed this must resolve; if not, the e2e suite skips.
    if (!jco) return;
    expect(jco.cli).toMatch(/jco[\\/]src[\\/]jco\.js$/);
    expect(jco.adapterCommand).toMatch(/wasi_snapshot_preview1\.command\.wasm$/);
  });
});

describe.skipIf(!canRun)(
  "#2643 Slice A — process.stdin Readable: Preview-1 core vs Preview-2 component (byte-identical)",
  () => {
    it("flowing 'data'/'end' is byte-identical across hosts", async () => {
      const bin = await compileWasi(dataProgram, "p2-data");
      for (const input of ["Hi", "Hello, world", ""]) {
        const p1 = runPreview1(bin, "p2-data", input);
        const p2 = runPreview2(bin, "p2-data", input);
        expect(p2, `input=${JSON.stringify(input)}`).toBe(p1);
      }
      // Sanity: the Preview-1 arm itself produces the expected stream.
      expect(runPreview1(bin, "p2-data", "Hi")).toBe("d:Hi\nend\n");
      expect(runPreview1(bin, "p2-data", "")).toBe("end\n");
    });

    it("paused read(size) is byte-identical across hosts", async () => {
      const bin = await compileWasi(readProgram, "p2-read");
      for (const input of ["ABCDEFG", "ABCDE", ""]) {
        const p1 = runPreview1(bin, "p2-read", input);
        const p2 = runPreview2(bin, "p2-read", input);
        expect(p2, `input=${JSON.stringify(input)}`).toBe(p1);
      }
      // Sanity: the Preview-1 arm reads all bytes then ends.
      expect(runPreview1(bin, "p2-read", "ABCDEFG")).toBe("r:ABC\nr:DEF\nr:G\neof\n");
    });
  },
);
