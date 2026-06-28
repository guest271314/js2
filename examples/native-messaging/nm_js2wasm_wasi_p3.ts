// Native Messaging host, expressed against the **WASI Preview 3 (0.3)** async
// `stream<u8>` surface — the P3 comparison instance for #2658.
//
// ┌─ STATUS: SOURCE-REFERENCE ────────────────────────────────────────────────┐
// │ This file COMPILES ONCE THE js2wasm P3 ASYNC PRODUCER LANDS — see #2658     │
// │ slices B2–B4 (the component-model-producer epic, deferred / gated on        │
// │ #2525). js2wasm cannot yet emit a P3 component (async-lifted `run`,          │
// │ `stream<u8>`/`future<T>` canonical-ABI lowering, `component-type` section).  │
// │ The B0 spike PROVES the runtime target works: the runnable P3 async proof    │
// │ is the hand-authored `p3-b0-spike/run-async.wat` + `run-p3-b0.sh`, and the   │
// │ stream-echo binary shape this file mirrors is `p3-b0-spike/stream-echo.wat`. │
// │ This is NOT a js2wasm-compiled P3 binary — none exists yet; do not treat it  │
// │ as runnable. It is the intended SOURCE of the P3 arm of the comparison.      │
// └────────────────────────────────────────────────────────────────────────────┘
//
// Contrast the siblings:
//   * `nm_js2wasm_wasi_p1.ts`    — WASI **Preview 1**: hand-marshals iovecs through linear
//                       memory in an explicit `fd_read`/`fd_write` loop. Runs
//                       today under wasmtime via `--target wasi`.
//   * `nm_js2wasm_node_fs.ts` — `node:fs` `readSync`/`writeSync(fd, …)`; runs under Node.
//   * `nm_js2wasm_wasi_p3.ts` — WASI **Preview 3**: the host drives the byte copy over a
//                       native `stream<u8>`; the guest just plumbs the stream and
//                       awaits. The async-lifted entry suspends/resumes via the
//                       component-model scheduler (the substrate #2646 wants —
//                       interactive incremental stdin with no asyncify, no
//                       pre-drain).
//
// Native Messaging protocol: each message is a 4-byte little-endian length prefix
// followed by a UTF-8 JSON body, exchanged over stdin/stdout. In P3, stdin and
// stdout are `stream<u8>` ends rather than fd 0 / fd 1. The simplest faithful
// echo is a whole-stream hand-off: take stdin's readable stream and hand it to
// stdout's writer; the host pumps every byte (prefix + body, opaque) straight
// through. We await the write future so the task stays alive until the host has
// drained the stream — resident memory stays flat regardless of message size.
//
// The P3 stdio surface mirrors wasi:cli@0.3.0-rc-2026-03-15 (the exact world id
// wasmtime 44 hosts):
//   stdin.read-via-stream:  () -> [stream<u8>, future<result<_, error-code>>]
//   stdout.write-via-stream: (stream<u8>) -> future<result<_, error-code>>
//   run: async () -> result

// ---- ambient P3 component-model surface (provided by the P3 producer) ---------
// These mirror the WASI 0.3 canonical-ABI handle types. Until the js2wasm P3
// backend lands they are reference declarations describing the imports the
// emitted component will bind to.

/** A component-model `stream<u8>` readable/writable end (an opaque handle). */
declare type StreamU8 = { readonly __brand: "stream<u8>" };

/** error-code from wasi:cli/types@0.3.0-rc. */
declare type WasiErrorCode = "io" | "illegal-byte-sequence" | "pipe";

/** A component-model `future<result<_, error-code>>` (an opaque handle). */
declare type WriteFuture = { readonly __brand: "future<result>" };

// The P3 backend binds these to the component imports
// `wasi:cli/stdin@0.3.0-rc-2026-03-15#read-via-stream` and
// `wasi:cli/stdout@0.3.0-rc-2026-03-15#write-via-stream` (see wit/cli.wit in the
// p3-b0-spike directory). They are ambient here so this source-reference
// type-checks standalone — the component-import binding is the producer's job.

/** stdin.read-via-stream: () -> [stream<u8>, future<result<_, error-code>>]. */
declare function readViaStream(): [StreamU8, WriteFuture];

/** stdout.write-via-stream: (stream<u8>) -> future<result<_, error-code>>. */
declare function writeViaStream(data: StreamU8): WriteFuture;

// ---- the P3 echo --------------------------------------------------------------
// `run` is the async-lifted `wasi:cli/run@0.3.0-rc-2026-03-15` command export.
// The whole-stream hand-off: read stdin's stream, give it to stdout, await the
// host pump. No 4-byte-prefix bookkeeping is needed at the syscall layer — a
// Native Messaging frame is an opaque byte run, and the host copies it through
// the stream byte-for-byte (prefix + body, including high/null bytes), so the
// receiver reconstructs framing from the raw bytes exactly as in `nm_js2wasm_wasi_p1.ts`.

export async function run(): Promise<void> {
  // Obtain the stdin readable stream. The paired read-future is left to the host
  // (dropping the stream's readable end resolves it to success on clean EOF).
  const [stdinStream] = readViaStream();

  // Hand the same readable stream straight to stdout — the host pumps stdin
  // bytes to stdout with no per-message guest copy.
  const writeDone: WriteFuture = writeViaStream(stdinStream);

  // Await the write future: the async-lifted `run` suspends here and is resumed
  // by the component-model scheduler when the host has drained the whole stream
  // (EOF) or hit an error. This is the suspend/resume point that gives #2646
  // interactive streaming "for free" — the host, not asyncify, drives it.
  await awaitFuture(writeDone);
}

/** Await a component-model `future<result>`. Under the P3 backend this lowers to
 *  `future.read` + the task suspending on the host scheduler (see the canonical
 *  await loop hand-authored in `p3-b0-spike/stream-echo.wat`). */
declare function awaitFuture(future: WriteFuture): Promise<void>;

// Invoke the async entry point. js2wasm's P3 backend lifts this top-level call
// into the component's async `wasi:cli/run@0.3.0-rc-2026-03-15` `run` export.
void run();
