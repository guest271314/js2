// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2775 — Native Messaging 1 / 64 / 128 MiB scale matrix.
 *
 * The #2683 comparison harness (`native-messaging-comparison.test.ts`) pins the
 * SMALL-payload byte-identical echo across every variant. This file pins the
 * LARGE end of the protocol — 1 MiB, 64 MiB, and 128 MiB — for the variants that
 * are designed to scale, on EVERY CI run (no `it.skip`). It lives in its own file
 * so the multi-MiB buffers do not bloat the equivalence shards.
 *
 * The synchronous streaming variants run under an in-process raw-fd shim that
 * uses BULK `Uint8Array` copies (no per-byte JS loop), so a 128 MiB echo
 * completes in seconds with no external runtime — the matrix therefore runs in
 * every CI shard, not only where `wasmtime` happens to be installed.
 *
 *   - `nm_deno.ts`    / `nm_wasi_p1.ts`  — VERBATIM streamers: a frame of any size
 *     is echoed back byte-for-byte through a fixed window. Asserted byte-EXACT at
 *     1 / 64 / 128 MiB.
 *   - `nm_node_fs.ts` — re-chunks a body LARGER than the browser 1 MiB cap into a
 *     sequence of valid <=1 MiB JSON frames (its documented design). A single
 *     >1 MiB frame does NOT come back byte-identical, so it is asserted on
 *     ROUND-TRIP correctness instead: every emitted frame is <=1 MiB and a valid
 *     `[…]`, and concatenating the frame interiors reconstructs the original
 *     array body exactly. Tested at 1 / 64 / 128 MiB.
 *   - `nm_node_process.ts` — its async `process.stdin` reactor rebuilds each
 *     chunk one byte at a time in the compiler prelude
 *     (`src/process-stdin-prelude.ts` `drainBytes`), which is O(n^2) and SIGKILLs
 *     at multi-MiB sizes. The large cases are therefore GATED ON #2777 (the
 *     byte-buffer-accumulation fix); here it is exercised only at a small size it
 *     handles today, under real `wasmtime` when present (its event loop is not
 *     driven by the in-process fd shim). NOT silently skipped — a clear pointer is
 *     logged when `wasmtime` is unavailable.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const NM_DIR = join(__dirname, "..", "examples", "native-messaging");
const MiB = 1024 * 1024;
const SIZES: { label: string; bytes: number }[] = [
  { label: "1 MiB", bytes: 1 * MiB },
  { label: "64 MiB", bytes: 64 * MiB },
  { label: "128 MiB", bytes: 128 * MiB },
];
// The browser per-host->extension-message cap nm_node_fs re-chunks to stay under.
const FRAME_CAP = 1 * MiB;

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

// ---- compile cache -----------------------------------------------------------
const compileCache = new Map<string, Awaited<ReturnType<typeof compile>>>();
async function getCompiled(file: string): Promise<Awaited<ReturnType<typeof compile>>> {
  let r = compileCache.get(file);
  if (!r) {
    const src = await readFile(join(NM_DIR, file), "utf-8");
    r = await compile(src, { fileName: file, target: "wasi", skipSemanticDiagnostics: true });
    compileCache.set(file, r);
  }
  return r;
}

// ---- framing helpers ---------------------------------------------------------
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

/** Split a framed stream back into its body frames (4-byte LE prefix + body). */
function parseFrames(stream: Uint8Array): Uint8Array[] {
  const frames: Uint8Array[] = [];
  let p = 0;
  while (p + 4 <= stream.length) {
    const len = stream[p]! + stream[p + 1]! * 256 + stream[p + 2]! * 65536 + stream[p + 3]! * 16777216;
    p += 4;
    if (p + len > stream.length) break; // truncated tail — stop
    frames.push(stream.subarray(p, p + len));
    p += len;
  }
  return frames;
}

/**
 * Build a valid JSON-array body `[null,null,…,null]` of approximately `approx`
 * bytes, as a lean Buffer (no giant intermediate JS string). Used to exercise
 * nm_node_fs's >1 MiB re-chunk path with a realistic browser payload (the #389
 * reporter's `Array(n).fill(null)`).
 */
function jsonArrayBody(approx: number): Buffer {
  // bodyLen = 2 (`[` `]`) + 4 (`null`) + 5 (`,null`) * (m - 1)
  const m = Math.max(1, Math.floor((approx - 6) / 5) + 1);
  const total = 2 + 4 + 5 * (m - 1);
  const buf = Buffer.alloc(total);
  let p = 0;
  buf[p++] = 0x5b; // [
  buf.write("null", p, "ascii");
  p += 4;
  for (let i = 1; i < m; i++) {
    buf.write(",null", p, "ascii");
    p += 5;
  }
  buf[p++] = 0x5d; // ]
  return buf;
}

// ---- in-process raw-fd shim (bulk copies) ------------------------------------
/**
 * Drive a synchronous standalone-WASI module: fd 0 is fed `stdin`, fd 1 is
 * captured, fd 2 (diagnostics) dropped. Uses bulk `Uint8Array` copies so a
 * 128 MiB echo runs in seconds. Re-reads the memory view on every syscall so a
 * mid-run `memory.grow` (detaching the old buffer) is handled.
 */
async function runFdShim(binary: Uint8Array, stdin: Uint8Array): Promise<Uint8Array> {
  let inPos = 0;
  const chunks: Uint8Array[] = [];
  let outLen = 0;
  const ref: { mem?: WebAssembly.Memory } = {};
  const wasi = {
    fd_read(_fd: number, iovs: number, iovsLen: number, nread: number): number {
      const v = new DataView(ref.mem!.buffer);
      const mem = new Uint8Array(ref.mem!.buffer);
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const buf = v.getUint32(iovs + i * 8, true);
        const len = v.getUint32(iovs + i * 8 + 4, true);
        const n = Math.min(len, stdin.length - inPos);
        if (n > 0) {
          mem.set(stdin.subarray(inPos, inPos + n), buf);
          inPos += n;
          total += n;
        }
      }
      v.setUint32(nread, total, true);
      return 0;
    },
    fd_write(fd: number, iovs: number, iovsLen: number, nwritten: number): number {
      const v = new DataView(ref.mem!.buffer);
      const mem = new Uint8Array(ref.mem!.buffer);
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const buf = v.getUint32(iovs + i * 8, true);
        const len = v.getUint32(iovs + i * 8 + 4, true);
        if (fd === 1 && len > 0) {
          chunks.push(mem.slice(buf, buf + len)); // copy out of (possibly-reused) memory
          outLen += len;
        }
        total += len;
      }
      v.setUint32(nwritten, total, true);
      return 0;
    },
    proc_exit(): void {},
    random_get(): number {
      return 0;
    },
    clock_time_get(): number {
      return 0;
    },
  };
  const { instance } = await WebAssembly.instantiate(binary, {
    wasi_snapshot_preview1: wasi as unknown as WebAssembly.ModuleImports,
    env: {},
  });
  ref.mem = instance.exports.memory as WebAssembly.Memory;
  const start = (instance.exports._start ?? instance.exports.main) as () => void;
  start();
  const out = new Uint8Array(outLen);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

// =============================================================================
describe("#2775 — verbatim streamers echo 1/64/128 MiB byte-for-byte", () => {
  for (const file of ["nm_deno.ts", "nm_wasi_p1.ts"]) {
    describe(file, () => {
      for (const { label, bytes } of SIZES) {
        it(`echoes a ${label} frame byte-identically`, { timeout: 180_000 }, async () => {
          const r = await getCompiled(file);
          expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
          expect(WebAssembly.validate(r.binary!), `${file} must validate`).toBe(true);
          const input = frame(new Uint8Array(bytes).fill(0x61));
          const out = await runFdShim(r.binary!, input);
          expect(out.length, `${file} ${label} echo length`).toBe(input.length);
          expect(Buffer.compare(Buffer.from(out), Buffer.from(input)), `${file} ${label} must be byte-identical`).toBe(
            0,
          );
        });
      }
    });
  }
});

describe("#2775 — nm_node_fs re-chunk round-trips 1/64/128 MiB correctly", () => {
  for (const { label, bytes } of SIZES) {
    it(`reassembles a ~${label} array body from valid <=1 MiB frames`, { timeout: 180_000 }, async () => {
      const r = await getCompiled("nm_node_fs.ts");
      expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
      const body = jsonArrayBody(bytes);
      const out = await runFdShim(r.binary!, frame(body));
      const frames = parseFrames(out);
      expect(frames.length, `${label}: expected at least one response frame`).toBeGreaterThanOrEqual(1);

      // Every emitted frame must be a valid `[…]` JSON array within the 1 MiB cap.
      for (const f of frames) {
        expect(f.length, `${label}: frame must be <= 1 MiB (browser cap)`).toBeLessThanOrEqual(FRAME_CAP);
        expect(f[0], `${label}: frame must open with '['`).toBe(0x5b);
        expect(f[f.length - 1], `${label}: frame must close with ']'`).toBe(0x5d);
      }

      // Concatenating the frame interiors (with a comma between consecutive
      // frames) reconstructs the original array interior byte-for-byte — the
      // receiver's reassembly semantics.
      const parts: Buffer[] = [];
      for (let i = 0; i < frames.length; i++) {
        if (i > 0) parts.push(Buffer.from([0x2c])); // ,
        parts.push(Buffer.from(frames[i]!.subarray(1, frames[i]!.length - 1)));
      }
      const recon = Buffer.concat([Buffer.from([0x5b]), Buffer.concat(parts), Buffer.from([0x5d])]);
      expect(recon.length, `${label}: reconstructed body length`).toBe(body.length);
      expect(Buffer.compare(recon, body), `${label}: reassembled array must equal the input`).toBe(0);
    });
  }
});

describe("#2775 — nm_node_process small-size echo (large sizes gated on #2777)", () => {
  let tmpDir: string;
  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nm-matrix-np-"));
  });
  afterAll(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  // nm_node_process is reactor-driven (async process.stdin) — its event loop is
  // NOT driven by the in-process fd shim, so it needs real wasmtime. Its read
  // side is O(n^2) in the compiler stdin prelude (`src/process-stdin-prelude.ts`
  // `drainBytes` builds each chunk one byte at a time), so it is only fast at
  // SMALL frames — even 64 KiB already takes minutes. The 1/64/128 MiB cases are
  // therefore GATED ON #2777 (byte-buffer accumulation fix); do NOT add them here
  // until #2777 lands. We exercise a small 2 KiB frame, with a hard subprocess
  // timeout so a perf regression can never hang the suite.
  it(
    "echoes a small (2 KiB) frame byte-for-byte under wasmtime (large sizes -> #2777)",
    { timeout: 60_000 },
    async () => {
      const r = await getCompiled("nm_node_process.ts");
      expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
      if (!wasmtimeBin) {
        // Not a silent skip: surface why this arm did not execute and where the
        // large-size gap is tracked.
        console.log(
          "[nm-matrix] nm_node_process needs real wasmtime (reactor-driven); not on PATH — " +
            "small-size echo not executed here. Large 1/64/128 MiB cases are gated on #2777 " +
            "(src/process-stdin-prelude.ts drainBytes O(n^2)).",
        );
        return;
      }
      const input = frame(new Uint8Array(2 * 1024).fill(0x63));
      const path = join(tmpDir, "nm_node_process-2k.wasm");
      writeFileSync(path, r.binary!);
      const out = execFileSync(wasmtimeBin, [...WASMTIME_FLAGS, path], {
        input: Buffer.from(input),
        stdio: ["pipe", "pipe", "ignore"],
        maxBuffer: 1 << 24,
        timeout: 30_000, // hard cap — kill wasmtime rather than let O(n^2) hang the suite
      });
      expect(Buffer.compare(Buffer.from(out), Buffer.from(input)), "nm_node_process 2 KiB echo byte-identical").toBe(0);
    },
  );
});
