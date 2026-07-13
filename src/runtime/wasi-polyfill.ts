// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Extracted verbatim from src/runtime.ts (#3103) — WASI polyfill.
// Pure move, host-side only; emits zero Wasm. No logic change.

/**
 * Build a WASI polyfill for running WASI-compiled modules in JS environments.
 * Routes fd_write(fd=1) to console.log, fd_write(fd=2) to console.error,
 * and proc_exit to process.exit (Node) or throw (browser).
 *
 * Usage:
 *   const wasi = buildWasiPolyfill();
 *   const { instance } = await WebAssembly.instantiate(binary, {
 *     wasi_snapshot_preview1: wasi,
 *     env: wasi.envImports,
 *   });
 *   wasi.setMemory(instance.exports.memory as WebAssembly.Memory);
 *   (instance.exports._start as Function)();
 *
 * #1482: The polyfill now exposes `envImports.__wasi_env_get_str` for the
 * `process.env.X` fast path under `--target wasi`, plus `environ_sizes_get`
 * and `environ_get` shims (memory-writing) for true WASI hosts. The defaults
 * read from Node's `process.env`; pass `{ env: {...} }` to override.
 */
export function buildWasiPolyfill(options?: { env?: Record<string, string | undefined> }): {
  fd_write: (fd: number, iovs: number, iovs_len: number, nwritten: number) => number;
  fd_read: (fd: number, iovs: number, iovs_len: number, nread: number) => number;
  proc_exit: (code: number) => void;
  poll_oneoff: (in_ptr: number, out_ptr: number, nsubs: number, nevents_out: number) => number;
  fd_fdstat_set_flags: (fd: number, flags: number) => number;
  environ_sizes_get: (countPtr: number, bufSizePtr: number) => number;
  environ_get: (envPtrsPtr: number, envBufPtr: number) => number;
  clock_time_get: (clockid: number, precision: bigint, out_ptr: number) => number;
  setMemory: (mem: WebAssembly.Memory) => void;
  setStdin: (data: Uint8Array | string) => void;
  envImports: Record<string, Function>;
} {
  let memory: WebAssembly.Memory | undefined;
  // Partial line buffer per fd for data not ending in newline
  const lineBuffers: Record<number, string> = {};
  // (#1483) Monotonic baseline so CLOCK_MONOTONIC values start near zero and
  // never go backwards within a single instance lifetime.
  const monotonicStartNs = (() => {
    const perf = typeof performance !== "undefined" && typeof performance.now === "function" ? performance : undefined;
    return perf ? BigInt(Math.round(perf.now() * 1_000_000)) : BigInt(Date.now()) * 1_000_000n;
  })();
  // Buffered stdin bytes; consumed by fd_read until EOF (length 0).
  // Tests/harnesses can preload bytes via setStdin().
  let stdinBuf: Uint8Array = new Uint8Array(0);
  let stdinPos = 0;

  // #1482: source of environment data. Caller-supplied dict wins; otherwise
  // default to Node's `process.env` (browser → empty dict).
  const envSource: Record<string, string | undefined> =
    options?.env ??
    (typeof process !== "undefined" && process.env ? (process.env as Record<string, string | undefined>) : {});

  const polyfill = {
    setMemory(mem: WebAssembly.Memory) {
      memory = mem;
    },

    /** Preload stdin bytes for the next sequence of fd_read calls. */
    setStdin(data: Uint8Array | string) {
      stdinBuf = typeof data === "string" ? new TextEncoder().encode(data) : data;
      stdinPos = 0;
    },

    /**
     * Minimal fd_read for fd=0 (stdin). Reads from the preloaded buffer
     * (see setStdin); returns 0 bytes (EOF) once exhausted. fd != 0 yields
     * EBADF-like behavior by writing nread=0 and returning 0.
     */
    fd_read(fd: number, iovs: number, iovs_len: number, nread: number): number {
      if (!memory) return -1;
      const view = new DataView(memory.buffer);
      let totalRead = 0;

      if (fd === 0) {
        for (let i = 0; i < iovs_len; i++) {
          const ptr = view.getUint32(iovs + i * 8, true);
          const len = view.getUint32(iovs + i * 8 + 4, true);
          if (len === 0) continue;
          const remaining = stdinBuf.length - stdinPos;
          if (remaining <= 0) break;
          const take = Math.min(len, remaining);
          const dest = new Uint8Array(memory.buffer, ptr, take);
          dest.set(stdinBuf.subarray(stdinPos, stdinPos + take));
          stdinPos += take;
          totalRead += take;
          if (take < len) break; // partial fill = drained
        }
      }

      view.setUint32(nread, totalRead, true);
      return 0; // __WASI_ERRNO_SUCCESS
    },

    fd_write(fd: number, iovs: number, iovs_len: number, nwritten: number): number {
      if (!memory) return -1; // EBADF-ish: memory not set

      const view = new DataView(memory.buffer);
      let totalWritten = 0;

      for (let i = 0; i < iovs_len; i++) {
        const ptr = view.getUint32(iovs + i * 8, true);
        const len = view.getUint32(iovs + i * 8 + 4, true);
        const bytes = new Uint8Array(memory.buffer, ptr, len);
        const text = new TextDecoder().decode(bytes);

        // Buffer partial lines; flush on newline
        const buf = (lineBuffers[fd] || "") + text;
        const lines = buf.split("\n");
        // Last element is the incomplete line (or "" if text ended with \n)
        lineBuffers[fd] = lines.pop()!;
        const writer = fd === 2 ? console.error : console.log;
        for (const line of lines) {
          writer(line);
        }

        totalWritten += len;
      }

      // Write total bytes written
      view.setUint32(nwritten, totalWritten, true);
      return 0; // __WASI_ERRNO_SUCCESS
    },

    proc_exit(code: number): void {
      if (typeof process !== "undefined" && typeof process.exit === "function") {
        process.exit(code);
      }
      throw new Error(`WASI proc_exit(${code})`);
    },

    // #1484 / #2632 — poll_oneoff shim for vitest-driven tests.
    //
    // Real wasmtime semantics: read `nsubs` subscription_t (48 bytes each) from
    // `in_ptr`, suspend until the earliest event fires, then write the firing
    // event_t (32 bytes each) records to `out_ptr` and the count to
    // `nevents_out`. Returns 0 (__WASI_ERRNO_SUCCESS).
    //
    // We support two shapes:
    //   - Phase 1 single CLOCK subscription (`__wasi_sleep_ms`): acknowledge it
    //     synchronously (no real sleep — tests run instantly), report 1 clock
    //     event fired.
    //   - #2632 Phase 2 multi-sub (fd0 FD_READ + optional CLOCK): if fd0 has
    //     buffered/preloaded stdin remaining, report the FD_READ event as fired
    //     (the reactor then fd_reads it); otherwise report the CLOCK event
    //     (timer due / timeout). This lets vitest exercise the fd-readiness
    //     reactor without a real OS poll.
    poll_oneoff(in_ptr: number, out_ptr: number, nsubs: number, nevents_out: number): number {
      if (!memory) return -1;
      const view = new DataView(memory.buffer);

      // Decode subscriptions: tag (u8) @ off+8 → 0=CLOCK, 1=FD_READ; for
      // FD_READ the fd (u32) is @ off+16.
      type Sub = { type: number; fd: number; userdata: bigint };
      const subs: Sub[] = [];
      for (let s = 0; s < nsubs; s++) {
        const off = in_ptr + s * 48;
        const userdata = view.getBigUint64(off, true);
        const tag = view.getUint8(off + 8);
        const fd = tag === 1 ? view.getUint32(off + 16, true) : -1;
        subs.push({ type: tag, fd, userdata });
      }

      // Does fd0 have stdin remaining to read? (preloaded via setStdin / unread)
      const fd0Readable = stdinBuf.length - stdinPos > 0;
      const fd0Sub = subs.find((x) => x.type === 1 && x.fd === 0);
      const clockSub = subs.find((x) => x.type === 0);

      // Pick the firing event(s): FD_READ wins when fd0 is readable; else the
      // clock fires (timeout elapses instantly in the polyfill).
      const fired: Sub[] = [];
      if (fd0Sub && fd0Readable) {
        fired.push(fd0Sub);
      } else if (clockSub) {
        fired.push(clockSub);
      } else if (fd0Sub) {
        // No clock and fd0 not readable — report fd0 anyway so the reactor's
        // 0-byte (EOF) read path ends the subscription instead of hanging.
        fired.push(fd0Sub);
      } else if (subs.length > 0) {
        fired.push(subs[0]!);
      }

      // Write event_t records: [0..7] userdata, [8..9] errno=0, [10] type.
      let n = 0;
      for (const ev of fired) {
        const eoff = out_ptr + n * 32;
        for (let i = 0; i < 32; i++) view.setUint8(eoff + i, 0);
        view.setBigUint64(eoff, ev.userdata, true);
        view.setUint16(eoff + 8, 0, true); // errno
        view.setUint8(eoff + 10, ev.type); // type: 0=CLOCK, 1=FD_READ
        n++;
      }
      view.setUint32(nevents_out, n, true);
      return 0;
    },

    /**
     * #2632 Phase 2 — fd_fdstat_set_flags(fd, flags) -> errno. The reactor calls
     * this to put fd 0 in non-blocking mode. The polyfill's fd_read is already
     * non-blocking (returns immediately), so this is a no-op acknowledgement.
     */
    fd_fdstat_set_flags(_fd: number, _flags: number): number {
      return 0;
    },

    // #1482: WASI environ_sizes_get — report `[count, total_buf_bytes]`. The
    // buffer layout we report (when environ_get fires) is `KEY=VALUE\0`
    // repeated, UTF-8 encoded. We compute it from `envSource` on each call;
    // the cost is negligible for typical env sizes and avoids stale results
    // when callers mutate the source between invocations.
    environ_sizes_get(countPtr: number, bufSizePtr: number): number {
      if (!memory) return -1;
      const entries = Object.entries(envSource).filter(([, v]) => v !== undefined) as [string, string][];
      const enc = new TextEncoder();
      let bufBytes = 0;
      for (const [k, v] of entries) {
        bufBytes += enc.encode(`${k}=${v}`).length + 1; // +1 for NUL terminator
      }
      const view = new DataView(memory.buffer);
      view.setUint32(countPtr, entries.length, true);
      view.setUint32(bufSizePtr, bufBytes, true);
      return 0;
    },

    // #1482: WASI environ_get — write the env pointer table at `envPtrsPtr`
    // and the `KEY=VALUE\0...` buffer at `envBufPtr`. Iteration order MUST
    // match what environ_sizes_get reported, otherwise the guest's allocator
    // will mis-size the buffer.
    environ_get(envPtrsPtr: number, envBufPtr: number): number {
      if (!memory) return -1;
      const entries = Object.entries(envSource).filter(([, v]) => v !== undefined) as [string, string][];
      const view = new DataView(memory.buffer);
      const mem = new Uint8Array(memory.buffer);
      const enc = new TextEncoder();
      let cursor = envBufPtr;
      for (let i = 0; i < entries.length; i++) {
        const [k, v] = entries[i]!;
        view.setUint32(envPtrsPtr + i * 4, cursor, true);
        const bytes = enc.encode(`${k}=${v}`);
        mem.set(bytes, cursor);
        cursor += bytes.length;
        mem[cursor++] = 0; // NUL terminator
      }
      return 0;
    },

    /**
     * #1482: env-namespace host imports for compiled modules that use
     * `process.env.X` under `--target wasi`. Wire as `{ env: wasi.envImports }`
     * alongside `wasi_snapshot_preview1: wasi` when instantiating.
     *
     * `__wasi_env_get_str(key)` is the JS-polyfill fast path — it returns
     * the value (or `undefined`) directly as a JS string, sidestepping the
     * memory marshalling of `environ_get`. The Wasm side type signature is
     * `(externref) -> externref`.
     */
    envImports: {
      __wasi_env_get_str(key: unknown): string | undefined {
        if (typeof key !== "string") return undefined;
        const v = envSource[key];
        return v === undefined ? undefined : v;
      },
    } as Record<string, Function>,

    /**
     * (#1483) clock_time_get(clockid, precision, out_ptr) -> errno
     *
     * Writes the current time in nanoseconds as a little-endian u64 to
     * out_ptr in the module's linear memory. Supports:
     *   - CLOCK_REALTIME   (0) → Date.now() (wall-clock ms → ns)
     *   - CLOCK_MONOTONIC  (1) → performance.now() (sub-ms, monotonic)
     *
     * `precision` is advisory — we always report ns granularity from
     * whichever JS clock is available.
     */
    clock_time_get(clockid: number, _precision: bigint, out_ptr: number): number {
      if (!memory) return 28; // EINVAL — memory not set
      let nowNs: bigint;
      if (clockid === 1) {
        // CLOCK_MONOTONIC — sub-ms via performance.now if available.
        const perf =
          typeof performance !== "undefined" && typeof performance.now === "function" ? performance : undefined;
        nowNs = perf ? BigInt(Math.round(perf.now() * 1_000_000)) : BigInt(Date.now()) * 1_000_000n;
        nowNs -= monotonicStartNs;
        if (nowNs < 0n) nowNs = 0n;
      } else {
        // CLOCK_REALTIME (0) and unknown clock ids fall through to wall-clock ms.
        nowNs = BigInt(Date.now()) * 1_000_000n;
      }
      const view = new DataView(memory.buffer);
      view.setBigUint64(out_ptr, nowNs, true);
      return 0;
    },
  };

  return polyfill;
}
