// Native Messaging host, compiled to standalone WASI by js2wasm — the
// **`node:process` async-stream** variant.
//
//   npx js2wasm examples/native-messaging/nm_node_process.ts --target wasi -o out
//
// This is the faithful Node `process.stdin` / `process.stdout` expression of the
// host. Where the sibling `nm_js2wasm.ts` uses the SYNCHRONOUS `node:fs`
// `readSync`/`writeSync(fd, …)` primitives, and `nm_wasi.ts` speaks RAW
// `wasi_snapshot_preview1` syscalls over linear memory, THIS variant uses the
// real Node **streaming** stdio surface:
//
//   - `process.stdin`  is an async **Readable** stream (#2632): you subscribe to
//     `'data'` chunks and an `'end'` event — there is NO synchronous, blocking
//     `read` that fills a caller buffer. js2wasm injects a faithful Readable
//     source-prelude (`src/process-stdin-prelude.ts`) so the public Node API
//     compiles under `--target wasi`; each `'data'` chunk is delivered as a
//     **string** whose char codes are the raw incoming bytes (one char per byte,
//     built via `String.fromCharCode`).
//   - `process.stdout.write(bytes)` writes to fd 1 (#1651). We hand it a
//     **`Uint8Array`** so the framed response goes out as RAW bytes — a string
//     argument would be UTF-8 re-encoded, which would corrupt the binary 4-byte
//     length prefix (its bytes are not all ASCII) and any high body byte. The
//     `Uint8Array` overload bypasses string encoding and writes the bytes verbatim.
//
// Because the read side is event-driven, the framed protocol is parsed
// incrementally: buffer incoming `'data'` chunks, and whenever the buffer holds a
// complete frame (the 4-byte little-endian length prefix plus that many body
// bytes), echo the whole frame — prefix + body — straight back as one
// `process.stdout.write`, then advance past it. A `'data'` chunk can carry a
// partial frame, exactly one frame, or several; the incremental parser handles
// all three. The leftover tail (a partial next frame) stays buffered until the
// following chunk completes it.
//
// Native Messaging protocol: each message is a 4-byte little-endian length prefix
// followed by a UTF-8 JSON body, exchanged over stdin (fd 0) / stdout (fd 1). See
//   https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
//
// This variant echoes a framed message verbatim, byte-for-byte. NOTE: `process`
// is referenced as the Node **global** (not `import process from "node:process"`).
// The prelude injection that backs `process.stdin` deliberately leaves a
// user-declared/-imported `process` binding alone, so the faithful global surface
// is what compiles to the async Readable here.

// The buffered, not-yet-echoed input. Each char's code is a raw input byte
// (0–255), so `charCodeAt` recovers the byte and `length` counts bytes.
let buffered: string = "";
// Set once a zero-length frame (clean shutdown) is seen, matching the sibling
// variants which treat a declared length of 0 as end-of-stream.
let stopped: boolean = false;

// Decode the little-endian uint32 the browser wrote as the first 4 buffered bytes.
function decodeLength(s: string): number {
  return s.charCodeAt(0) + s.charCodeAt(1) * 256 + s.charCodeAt(2) * 65536 + s.charCodeAt(3) * 16777216;
}

// Echo every complete frame currently in `buffered`, advancing past each. A frame
// is the 4-byte LE prefix + `len` body bytes; we re-emit prefix + body as raw
// bytes in ONE `process.stdout.write` (atomic framing — a streaming receiver must
// never see a prefix split from its body).
function drain(): void {
  while (!stopped) {
    if (buffered.length < 4) return; // need the full length prefix first
    const len = decodeLength(buffered);
    if (len === 0) {
      stopped = true; // zero-length frame = clean shutdown
      return;
    }
    const frameLen = 4 + len;
    if (buffered.length < frameLen) return; // body not fully arrived yet

    // Re-frame prefix + body into one raw-byte buffer. The prefix is rebuilt from
    // the decoded length (identical bytes); the body bytes are copied out of the
    // buffered chunk via their char codes.
    const out = new Uint8Array(frameLen);
    out[0] = len & 0xff;
    out[1] = (len >> 8) & 0xff;
    out[2] = (len >> 16) & 0xff;
    out[3] = (len >> 24) & 0xff;
    let i = 0;
    while (i < len) {
      out[4 + i] = buffered.charCodeAt(4 + i) & 0xff;
      i = i + 1;
    }
    process.stdout.write(out);

    // Drop the echoed frame; keep any trailing partial frame for the next chunk.
    buffered = buffered.substring(frameLen);
  }
}

// NOTE: `main` is intentionally NOT exported. An exported no-arg `main` becomes
// the WASI `_start` target AND is *also* invoked by the top-level `main()` call
// captured in module-init — running it twice. A synchronous host masks that (the
// second run hits EOF immediately), but this async host registers its stdin
// listeners in `main`, so a double-run would subscribe — and thus echo — every
// frame twice. Keeping `main` non-exported makes `_start` wrap module-init, which
// calls `main()` exactly once (the `main()`-calls-itself convention).
function main(): void {
  // Long-lived port loop, async-stream style: accumulate stdin chunks and echo
  // each complete framed message as it arrives, until EOF (or a zero-length
  // frame). The reactor injected for `process.stdin` drives the `'data'`/`'end'`
  // callbacks after `_start` returns.
  process.stdin.on("data", (chunk: string) => {
    if (stopped) return;
    buffered = buffered + chunk;
    drain();
  });
  process.stdin.on("end", () => {
    // EOF: anything left in `buffered` is an incomplete frame and is dropped,
    // matching the sibling variants which stop on a short/truncated read.
  });
}

// Invoke the entry point. js2wasm compiles the top-level call into the module's
// `_start`; the injected fd0 reactor then pumps stdin until EOF.
main();
