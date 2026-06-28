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
 * The synchronous streaming variants run under an in-process raw-fd shim
 * ({@link runFdShim}) and the async `process.stdin` variant under an in-process
 * reactor shim ({@link runReactorShim}); both use BULK `Uint8Array` copies (no
 * per-byte JS loop), so a 128 MiB echo completes in seconds with no external
 * runtime — the matrix therefore runs in every CI shard, not only where
 * `wasmtime` happens to be installed.
 *
 *   - `nm_js2wasm_deno.ts`    / `nm_js2wasm_wasi_p1.ts`  — VERBATIM streamers: a frame of any size
 *     is echoed back byte-for-byte through a fixed window. Asserted byte-EXACT at
 *     1 / 64 / 128 MiB.
 *   - `nm_js2wasm_node_fs.ts` — re-chunks a body LARGER than the browser 1 MiB cap into a
 *     sequence of valid <=1 MiB JSON frames (its documented design). A single
 *     >1 MiB frame does NOT come back byte-identical, so it is asserted on
 *     ROUND-TRIP correctness instead: every emitted frame is <=1 MiB and a valid
 *     `[…]`, and concatenating the frame interiors reconstructs the original
 *     array body exactly. Tested at 1 / 64 / 128 MiB.
 *   - `nm_js2wasm_node_process.ts` — async `process.stdin` reactor. #2777 replaced the
 *     prelude's per-byte chunk build (and the example's growing-cons-rope
 *     `buffered`) with amortized-growth BYTE buffers, making the read side O(n);
 *     it now echoes 1 / 64 / 128 MiB byte-EXACT under the in-process reactor shim
 *     on EVERY CI run, matching the other three variants (previously the large
 *     cases were gated on #2777 because the O(n^2) read SIGKILLed at multi-MiB).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile, compileProject, entryHasRelativeImports } from "../src/index.js";

const NM_DIR = join(__dirname, "..", "examples", "native-messaging");
const MiB = 1024 * 1024;
const SIZES: { label: string; bytes: number }[] = [
  { label: "1 MiB", bytes: 1 * MiB },
  { label: "64 MiB", bytes: 64 * MiB },
  { label: "128 MiB", bytes: 128 * MiB },
];
// The browser per-host->extension-message cap nm_js2wasm_node_fs re-chunks to stay under.
const FRAME_CAP = 1 * MiB;

// ---- compile cache -----------------------------------------------------------
const compileCache = new Map<string, Awaited<ReturnType<typeof compile>>>();
async function getCompiled(file: string): Promise<Awaited<ReturnType<typeof compile>>> {
  let r = compileCache.get(file);
  if (!r) {
    const path = join(NM_DIR, file);
    const src = await readFile(path, "utf-8");
    // Mirror the CLI's routing (#2771): nm_js2wasm_deno / nm_js2wasm_node_fs statically import the
    // shared `./nm_js2wasm_sync_framing` core (#2778), so they must go through the
    // multi-file bundler; the others stay on the single-source path.
    r = entryHasRelativeImports(src)
      ? await compileProject(path, { target: "wasi", skipSemanticDiagnostics: true })
      : await compile(src, { fileName: file, target: "wasi", skipSemanticDiagnostics: true });
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
 * nm_js2wasm_node_fs's >1 MiB re-chunk path with a realistic browser payload (the #389
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

// ---- in-process async-reactor shim (bulk copies) -----------------------------
/**
 * Drive the `nm_js2wasm_node_process` ASYNC `process.stdin` reactor in-process — the
 * event-loop analogue of {@link runFdShim} for the synchronous variants. The
 * compiled module's `_start` runs a synchronous run loop that calls
 * `poll_oneoff` (fd0 FD_READ + clock subscriptions), then `__rl_stdin_drain`
 * (`fd_read`), then the Readable pump, until fd0 hits EOF (a 0-byte read) or the
 * program calls `process.stdin.destroy()`. We supply:
 *   - `poll_oneoff` — report the fd0 FD_READ event ready while stdin remains,
 *     else the clock event (mirrors `buildWasiPolyfill`'s poll shim, but inlined
 *     here so we can also capture raw fd1 bytes).
 *   - `fd_read` — feed fd0 from `stdin` (≤ remaining), 0 bytes = EOF.
 *   - `fd_write` — capture fd1 raw bytes via bulk `Uint8Array` copies.
 *   - `fd_fdstat_set_flags` / `clock_time_get` / `proc_exit` — no-ops.
 * Re-reads the memory view on every syscall so a mid-run `memory.grow` (which
 * detaches the old buffer) is handled. With the #2777 O(n) byte-buffer
 * accumulation it runs a 128 MiB echo in seconds with no external runtime, so
 * the matrix runs in every CI shard — not only where `wasmtime` is installed.
 */
async function runReactorShim(binary: Uint8Array, stdin: Uint8Array): Promise<Uint8Array> {
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
        if (len === 0) continue;
        const n = Math.min(len, stdin.length - inPos);
        if (n <= 0) break;
        mem.set(stdin.subarray(inPos, inPos + n), buf);
        inPos += n;
        total += n;
        if (n < len) break; // partial fill = drained
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
    poll_oneoff(inPtr: number, outPtr: number, nsubs: number, neventsOut: number): number {
      const v = new DataView(ref.mem!.buffer);
      type Sub = { type: number; fd: number; userdata: bigint };
      const subs: Sub[] = [];
      for (let s = 0; s < nsubs; s++) {
        const off = inPtr + s * 48;
        const userdata = v.getBigUint64(off, true);
        const tag = v.getUint8(off + 8); // 0=CLOCK, 1=FD_READ
        const fd = tag === 1 ? v.getUint32(off + 16, true) : -1;
        subs.push({ type: tag, fd, userdata });
      }
      const fd0Readable = stdin.length - inPos > 0;
      const fd0Sub = subs.find((x) => x.type === 1 && x.fd === 0);
      const clockSub = subs.find((x) => x.type === 0);
      const fired: Sub[] = [];
      if (fd0Sub && fd0Readable) fired.push(fd0Sub);
      else if (clockSub) fired.push(clockSub);
      else if (fd0Sub)
        fired.push(fd0Sub); // not readable → 0-byte (EOF) read ends the sub
      else if (subs.length > 0) fired.push(subs[0]!);
      let n = 0;
      for (const ev of fired) {
        const eoff = outPtr + n * 32;
        for (let i = 0; i < 32; i++) v.setUint8(eoff + i, 0);
        v.setBigUint64(eoff, ev.userdata, true);
        v.setUint16(eoff + 8, 0, true); // errno
        v.setUint8(eoff + 10, ev.type); // type
        n++;
      }
      v.setUint32(neventsOut, n, true);
      return 0;
    },
    fd_fdstat_set_flags(): number {
      return 0;
    },
    clock_time_get(): number {
      return 0;
    },
    proc_exit(): void {},
    random_get(): number {
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
  for (const file of ["nm_js2wasm_deno.ts", "nm_js2wasm_wasi_p1.ts"]) {
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

describe("#2775 — nm_js2wasm_node_fs re-chunk round-trips 1/64/128 MiB correctly", () => {
  for (const { label, bytes } of SIZES) {
    it(`reassembles a ~${label} array body from valid <=1 MiB frames`, { timeout: 180_000 }, async () => {
      const r = await getCompiled("nm_js2wasm_node_fs.ts");
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

describe("#2777 — nm_js2wasm_node_process echoes 1/64/128 MiB byte-for-byte (async reactor)", () => {
  // nm_js2wasm_node_process is reactor-driven (async `process.stdin`), so it is driven by
  // the in-process {@link runReactorShim} (poll_oneoff/fd_read/fd_write) rather
  // than the synchronous {@link runFdShim}. Before #2777 its read side was O(n^2)
  // — the prelude built each chunk byte-by-byte and the example re-flattened its
  // growing cons-rope `buffered` on every charCodeAt/substring — so it SIGKILLed
  // at multi-MiB and the large sizes were gated. The #2777 byte-buffer
  // accumulation makes it O(n), so it now runs the FULL 1/64/128 MiB sweep on
  // EVERY CI run, byte-identical, matching the other three streaming variants.
  for (const { label, bytes } of SIZES) {
    it(`echoes a ${label} frame byte-identically`, { timeout: 180_000 }, async () => {
      const r = await getCompiled("nm_js2wasm_node_process.ts");
      expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
      expect(WebAssembly.validate(r.binary!), "nm_js2wasm_node_process.ts must validate").toBe(true);
      const input = frame(new Uint8Array(bytes).fill(0x61));
      const out = await runReactorShim(r.binary!, input);
      expect(out.length, `nm_js2wasm_node_process ${label} echo length`).toBe(input.length);
      expect(
        Buffer.compare(Buffer.from(out), Buffer.from(input)),
        `nm_js2wasm_node_process ${label} must be byte-identical`,
      ).toBe(0);
    });
  }
});
