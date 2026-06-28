// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2807 — `nm_js2wasm_node_process` (async `process.stdin`) echoed ZERO bytes for a
 * framed body ≥ ~128 MiB under REAL wasmtime, while the in-process matrix shim
 * passed. Root cause: it builds the WHOLE response frame and writes it in ONE
 * `process.stdout.write`, and wasmtime (v46) REJECTS a single `fd_write` whose
 * iovec length is ≥ ~128 MiB (errno 48 / `nwritten = 0`); the WASI write helper
 * mapped that non-zero errno to "0 bytes" and the host exited 0 with no output.
 *
 * The fix chunks every WASI `fd_write` into pieces of at most
 * {@link WASI_FD_WRITE_MAX_CHUNK} (`__wasi_fd_write_all`). The #2775 matrix shim
 * bulk-copies each iovec in one JS slice, so it can't model wasmtime's cap and
 * MASKED this. This test drives `nm_js2wasm_node_process` through a reactor shim whose
 * `fd_write` FAITHFULLY rejects an oversized single iovec exactly the way
 * wasmtime does — so a regression to a single full-frame write fails HERE, on
 * every CI run, with no wasmtime binary required (the real-wasmtime guard lives
 * in `examples/native-messaging/scale-test.mjs` / the native-messaging-smoke job).
 *
 * It is sized at just over one chunk so the buffers stay ~64 MiB (matching the
 * existing matrix cost) while still crossing the chunk boundary that the fix
 * must split.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { WASI_FD_WRITE_MAX_CHUNK } from "../src/codegen/index.js";
import { readFileSync } from "node:fs";

const NM_DIR = join(__dirname, "..", "examples", "native-messaging");

// Model wasmtime's structural single-`fd_write` cap. The real value is ~128 MiB
// (0x07FFFFF9); we model it at one byte ABOVE the compiler's chunk size so the
// test stays ~64 MiB yet still proves the fix never emits a write larger than
// the chunk. A static guard below pins the chunk safely under the REAL cap too.
const MODELLED_CAP = WASI_FD_WRITE_MAX_CHUNK + 1;
const WASMTIME_REAL_CAP = 0x07ff_fff9; // first length wasmtime v46 rejects (errno 48)

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

/**
 * Reactor shim for `nm_js2wasm_node_process`, with a wasmtime-FAITHFUL capped `fd_write`:
 * a single iovec whose length exceeds {@link MODELLED_CAP} is rejected with errno
 * 48 and `nwritten` left at 0 (exactly wasmtime's behaviour), instead of being
 * bulk-copied. Tracks the largest single fd1 write seen so the test can assert
 * the helper chunked. (poll_oneoff / fd_read mirror the #2775 matrix shim.)
 */
async function runReactorShimCapped(
  binary: Uint8Array,
  stdin: Uint8Array,
): Promise<{ out: Uint8Array; maxWrite: number; rejected: number }> {
  let inPos = 0;
  const chunks: Uint8Array[] = [];
  let outLen = 0;
  let maxWrite = 0;
  let rejected = 0;
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
        if (n < len) break;
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
          if (len > maxWrite) maxWrite = len;
          if (len > MODELLED_CAP) {
            // wasmtime rejects the oversized single write: errno 48, nwritten
            // untouched (the helper breaks on a non-zero errno before reading it).
            rejected++;
            return 48;
          }
          chunks.push(mem.slice(buf, buf + len));
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
        const tag = v.getUint8(off + 8);
        const fd = tag === 1 ? v.getUint32(off + 16, true) : -1;
        subs.push({ type: tag, fd, userdata });
      }
      const fd0Readable = stdin.length - inPos > 0;
      const fd0Sub = subs.find((x) => x.type === 1 && x.fd === 0);
      const clockSub = subs.find((x) => x.type === 0);
      const fired: Sub[] = [];
      if (fd0Sub && fd0Readable) fired.push(fd0Sub);
      else if (clockSub) fired.push(clockSub);
      else if (fd0Sub) fired.push(fd0Sub);
      else if (subs.length > 0) fired.push(subs[0]!);
      let n = 0;
      for (const ev of fired) {
        const eoff = outPtr + n * 32;
        for (let i = 0; i < 32; i++) v.setUint8(eoff + i, 0);
        v.setBigUint64(eoff, ev.userdata, true);
        v.setUint16(eoff + 8, 0, true);
        v.setUint8(eoff + 10, ev.type);
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
  return { out, maxWrite, rejected };
}

describe("#2807 — nm_js2wasm_node_process echoes a >chunk frame under a wasmtime-faithful fd_write cap", () => {
  it(
    "chunks the write so no single fd_write exceeds the cap, and echoes byte-exact",
    { timeout: 180_000 },
    async () => {
      // The chunk size must sit safely below wasmtime's real ~128 MiB cap, or a
      // single chunk would itself be rejected by real wasmtime.
      expect(WASI_FD_WRITE_MAX_CHUNK).toBeLessThan(WASMTIME_REAL_CAP);

      const src = readFileSync(join(NM_DIR, "nm_js2wasm_node_process.ts"), "utf-8");
      const r = await compile(src, { fileName: "nm_js2wasm_node_process.ts", target: "wasi", skipSemanticDiagnostics: true });
      expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
      expect(WebAssembly.validate(r.binary!), "nm_js2wasm_node_process.ts must validate").toBe(true);

      // One chunk + a remainder: the OLD single-shot write would be one
      // (chunk + remainder) iovec — rejected by the modelled cap → zero output.
      const body = new Uint8Array(WASI_FD_WRITE_MAX_CHUNK + 8192).fill(0x61);
      const input = frame(body);

      const { out, maxWrite, rejected } = await runReactorShimCapped(r.binary!, input);

      expect(rejected, "no fd_write may exceed the cap (the #2807 single-shot regression)").toBe(0);
      expect(out.length, "must not emit zero bytes (the #2807 silent failure)").toBe(input.length);
      expect(Buffer.compare(Buffer.from(out), Buffer.from(input)), "echo must be byte-identical").toBe(0);
      expect(maxWrite, "every single fd_write stays within the chunk cap").toBeLessThanOrEqual(WASI_FD_WRITE_MAX_CHUNK);
    },
  );
});
