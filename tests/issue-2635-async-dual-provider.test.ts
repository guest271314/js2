// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2635 Phase 3 — same-binary ASYNC dual-provider compatibility proof.
//
// The Phase-1 proof (tests/issue-1772-edge-dual-provider.test.ts) showed one
// compiled `node:fs`-importing binary runs byte-identically under the pure-WASI
// `node-fs.wat` shim (wasmtime) AND the edge.js `node:fs` adapter (native Node).
// That is the SYNCHRONOUS tier.
//
// This is the ASYNC tier: one compiled `process.stdin` Readable program
// (`--target wasi`, so the #2632 async event-loop reactor + the four
// `__wasiStdin*` reactor intrinsics wire in automatically) runs byte-identically
// under TWO providers of the `wasi_snapshot_preview1` surface:
//   (a) pure WASI — real `wasmtime` driving native `poll_oneoff`/`fd_read` on
//       fd0 over the module's own exported memory (the proven #2632 arm), and
//   (b) native Node — `createNodeStdinWasiProvider` (edge.js), whose
//       fd_read/poll_oneoff are fed by Node's REAL `process.stdin` 'data'/'end'
//       events (the JS host's event loop), run via `run-edge-stdin.mjs` as a
//       child process with the bytes piped to its real fd0.
// Both arms consume the SAME binary and must produce BYTE-IDENTICAL output.
//
// Unlike the synchronous `node:fs` tier, the async provider seam is the
// `wasi_snapshot_preview1` import surface (the reactor is WASI-internal, NOT a
// swappable `node:fs` member). The edge.js arm uses MECHANISM 2 (pre-drain to
// EOF, then run `_start`) — the proven `setStdin(bytes)` + `_start()` path. The
// true incremental loop-borrow via asyncify is the deferred follow-up (P3-d).
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const EDGE_STDIN_RUNNER = join(REPO, "examples", "native-messaging", "run-edge-stdin.mjs");

// js2wasm emits a WasmGC module; enable the GC/function-references/exceptions
// proposals (mirrors the #2632 Phase-3 wasmtime arm flags).
const WASMTIME_FLAGS = ["run", "-W", "gc=y,function-references=y,exceptions=y"];

// ── Program 1: line-count. Reads every stdin byte via the reactor substrate,
// counts newlines + total bytes, prints a single ASCII summary at EOF. Pure
// `--target wasi` (owns + exports its memory; no node:fs). Deterministic and
// byte-clean — the count is sensitive to the raw 0x0a bytes flowing through
// fd_read on both arms.
const LINE_COUNT = `
declare function __wasiStdinReadByte(): number;
declare function __wasiStdinEof(): boolean;
declare function __wasiStdinSetReader(cb: () => void): void;
let lines = 0;
let bytes = 0;
let ended = false;
__wasiStdinSetReader(() => {
  let b = __wasiStdinReadByte();
  while (b >= 0) { bytes = bytes + 1; if (b === 10) { lines = lines + 1; } b = __wasiStdinReadByte(); }
  if (__wasiStdinEof() && !ended) { ended = true; console.log("lines=" + lines + " bytes=" + bytes); }
});
`;

// ── Program 2: byte-echo. Reads every stdin byte via the reactor substrate and
// writes each back via process.stdout.write (lowers to fd_write). Exercises the
// FULL byte range through fd_read on both arms — including the bytes that catch a
// UTF-8-collapsing provider (0x00, 0xff, 0x80, 0x0a). Both arms apply the SAME
// String.fromCharCode → UTF-8 transformation (it is the same binary), so the
// outputs stay byte-identical; the proof is provider-agreement, not raw fidelity.
const BYTE_ECHO = `
declare function __wasiStdinReadByte(): number;
declare function __wasiStdinEof(): boolean;
declare function __wasiStdinSetReader(cb: () => void): void;
__wasiStdinSetReader(() => {
  let b = __wasiStdinReadByte();
  while (b >= 0) { process.stdout.write(String.fromCharCode(b)); b = __wasiStdinReadByte(); }
});
`;

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

async function compileStdin(src: string): Promise<Uint8Array> {
  const r = await compile(src, {
    fileName: "stdin.ts",
    target: "wasi",
    skipSemanticDiagnostics: true,
  });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  return r.binary!;
}

/** Arm (a): pure-WASI under wasmtime, bytes piped to fd0. Raw output bytes. */
function runWasmtime(wasmPath: string, input: Uint8Array): Buffer {
  return execFileSync(wasmtimeBin!, [...WASMTIME_FLAGS, wasmPath], {
    input: Buffer.from(input),
    maxBuffer: 4 * 1024 * 1024,
  });
}

/** Arm (b): native Node via edge.js, bytes piped to the runner's real fd0. */
function runEdge(wasmPath: string, input: Uint8Array): Buffer {
  return execFileSync(process.execPath, [EDGE_STDIN_RUNNER, wasmPath], {
    input: Buffer.from(input),
    maxBuffer: 4 * 1024 * 1024,
  });
}

describe("#2635 — process.stdin same-binary async dual-provider compatibility", () => {
  let tmp: string;
  let lineCountBin: Uint8Array;
  let byteEchoBin: Uint8Array;

  beforeAll(async () => {
    lineCountBin = await compileStdin(LINE_COUNT);
    byteEchoBin = await compileStdin(BYTE_ECHO);
    tmp = mkdtempSync(join(tmpdir(), "edge-async-dual-"));
  });

  afterAll(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  // Arm (b) alone: the edge.js async provider drives the same binary off real
  // fd0 and produces the expected line-count. (Always runs — no wasmtime needed.)
  it("provider (b): edge.js async provider line-counts off real Node stdin", () => {
    const wasmPath = join(tmp, "lc_edge.wasm");
    writeFileSync(wasmPath, lineCountBin);
    const out = runEdge(wasmPath, Buffer.from("Hello\nWorld\nThird line no newline"));
    expect(out.toString("utf-8")).toBe("lines=2 bytes=33\n");
  });

  it("provider (b): edge.js async provider on empty stdin emits only the EOF summary", () => {
    const wasmPath = join(tmp, "lc_edge_empty.wasm");
    writeFileSync(wasmPath, lineCountBin);
    const out = runEdge(wasmPath, new Uint8Array(0));
    expect(out.toString("utf-8")).toBe("lines=0 bytes=0\n");
  });

  // The #2635 acceptance: SAME binary, BOTH providers, byte-identical output.
  describe.skipIf(!wasmtimeBin)("same-binary byte-identical proof (wasmtime vs edge.js)", () => {
    // Frames containing high/null bytes so a UTF-8-collapsing provider on the
    // fd_read path would diverge: 0x00, 0xff, 0x80, 0x0a embedded.
    const FRAMES: Array<{ name: string; input: Uint8Array }> = [
      { name: "ascii lines", input: Buffer.from("alpha\nbeta\ngamma\n") },
      { name: "no trailing newline", input: Buffer.from("one\ntwo\nthree") },
      {
        name: "high/null bytes",
        input: Uint8Array.from([0x00, 0xff, 0x80, 0x0a, 0x41, 0x0a, 0x7f]),
      },
      { name: "empty", input: new Uint8Array(0) },
    ];

    it("line-count: both providers agree byte-for-byte on every frame", () => {
      const wasmPath = join(tmp, "lc_dual.wasm");
      writeFileSync(wasmPath, lineCountBin);
      for (const { name, input } of FRAMES) {
        const wt = runWasmtime(wasmPath, input);
        const edge = runEdge(wasmPath, input);
        expect(Array.from(edge), `line-count edge≠wasmtime for "${name}"`).toEqual(Array.from(wt));
      }
    });

    it("byte-echo: both providers agree byte-for-byte on every frame (incl. high/null bytes)", () => {
      const wasmPath = join(tmp, "echo_dual.wasm");
      writeFileSync(wasmPath, byteEchoBin);
      for (const { name, input } of FRAMES) {
        const wt = runWasmtime(wasmPath, input);
        const edge = runEdge(wasmPath, input);
        expect(Array.from(edge), `byte-echo edge≠wasmtime for "${name}"`).toEqual(Array.from(wt));
      }
    });
  });
});
