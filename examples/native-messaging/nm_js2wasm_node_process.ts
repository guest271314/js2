// Native Messaging host, compiled to standalone WASI by js2wasm — the
// **`node:process` async-stream** variant.
//
//   npx js2wasm examples/native-messaging/nm_js2wasm_node_process.ts --target wasi -o out
//
// This is the faithful Node `process.stdin` / `process.stdout` expression of the
// host. Where the sibling `nm_js2wasm_node_fs.ts` uses the SYNCHRONOUS `node:fs`
// `readSync`/`writeSync(fd, …)` primitives, and `nm_js2wasm_wasi_p1.ts` speaks RAW
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
// bytes), echo it back, then advance past it. A `'data'` chunk can carry a
// partial frame, exactly one frame, or several; the incremental parser handles
// all three. The leftover tail (a partial next frame) stays buffered until the
// following chunk completes it.
//
// On the WRITE side the echo is re-chunked to the 1 MiB browser cap (#2808): a
// body within the cap is echoed verbatim — prefix + body — as one
// `process.stdout.write`; a body LARGER than the cap is split into a sequence of
// valid <=1 MiB JSON frames (`[run]` for an array body, `"run"` for a string
// body) whose interiors, concatenated by the receiver, reproduce the original
// body. This matches the sibling `nm_js2wasm_node_fs` re-chunker, keeps every
// host->extension message within the real Chrome 1 MiB cap, and bounds resident
// memory on the write side. See the FRAME_CAP / `rechunk*` helpers below.
//
// Native Messaging protocol: each message is a 4-byte little-endian length prefix
// followed by a UTF-8 JSON body, exchanged over stdin (fd 0) / stdout (fd 1). See
//   https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
//
// This variant echoes a framed message back, re-chunked to the 1 MiB browser cap
// (verbatim when it already fits). NOTE: `process`
// is referenced as the Node **global** (not `import process from "node:process"`).
// The prelude injection that backs `process.stdin` deliberately leaves a
// user-declared/-imported `process` binding alone, so the faithful global surface
// is what compiles to the async Readable here.
//
// Clean shutdown WITHOUT stdin EOF (#2735): a real Native-Messaging port keeps
// stdin OPEN for the lifetime of the connection and signals end-of-conversation
// IN BAND — here, with a zero-length frame (a 4-byte prefix declaring length 0).
// The fd0 reactor that drives the async `'data'` callbacks only terminates on
// stdin EOF, so an open-stdin peer would make `_start` block forever. On the
// shutdown frame we therefore call `process.stdin.destroy()`, which drops the
// reactor's fd0 subscription so the run loop falls through and the program exits
// cleanly. (`process.exit(0)` is the alternative — it routes to WASI `proc_exit`
// after the same subscription drop.) Feeding the host a bounded buffer that hits
// EOF still exits via the `'end'` path, exactly as before.

// The buffered, not-yet-echoed input, held as a raw BYTE buffer (#2777). An
// earlier version kept this as a growing STRING (`buffered = buffered + chunk`)
// and recovered bytes with `buffered.charCodeAt(i)` / `buffered.substring(...)`.
// js2wasm native strings are cons-ropes, so every `charCodeAt`/`substring` over
// the growing buffer re-flattened the WHOLE buffer — O(n) per access, O(n^2) for
// a multi-MiB frame (which SIGKILLed this host). A `Uint8Array` gives O(1)
// indexed reads, so parsing is linear. `tail - head` is the live byte count;
// `head` advances past echoed frames and both reset to 0 once fully drained.
let buf: Uint8Array = new Uint8Array(1024);
let head: number = 0;
let tail: number = 0;
// Set once a zero-length frame (clean shutdown) is seen, matching the sibling
// variants which treat a declared length of 0 as end-of-stream.
let stopped: boolean = false;

// Browser per-host->extension-message cap: 1 MiB (#2808). A real Chrome Native-
// Messaging host may send AT MOST 1 MiB per host->extension message, so a body
// larger than this isn't even valid on that surface. Like the sibling
// `nm_js2wasm_node_fs.ts` re-chunker, a >1 MiB response body is split on the
// WRITE side into a sequence of valid <=1 MiB JSON frames whose interiors,
// concatenated by the receiver, reproduce the original body; a body that already
// fits is echoed verbatim. This also BOUNDS resident memory on the write side
// (per-frame 1 MiB out buffers instead of one full-size frame) and brings this
// async host in line with `nm_js2wasm_deno` / `nm_js2wasm_wasi_p1` (64 KiB
// window) and `nm_js2wasm_node_fs` (1 MiB re-chunk) — it was the lone variant
// that built the WHOLE frame and wrote it in ONE process.stdout.write, the
// shape that hit wasmtime's single-fd_write cap in #2807.
const FRAME_CAP: number = 1024 * 1024;
const COMMA: number = 44; // ,
const OPEN_BRACKET: number = 91; // [
const CLOSE_BRACKET: number = 93; // ]
const DQUOTE: number = 34; // "

// Emit ONE re-chunked JSON frame: 4-byte LE length prefix + `open` + the run
// `buf[srcStart..srcStart+runLen)` + `close`, built whole and written in ONE
// process.stdout.write (atomic framing — a streaming receiver must never see a
// prefix split from its body; #2526). `open`/`close` are `[`/`]` for an array
// body or `"`/`"` for a string body. The 4-byte prefix declares the JSON body
// length (`open` + run + `close`), which stays <= FRAME_CAP because the caller
// keeps `runLen <= FRAME_CAP - 2`.
function emitRun(srcStart: number, runLen: number, open: number, close: number): void {
  const bodyLen = runLen + 2; // delimiter + run + delimiter
  const out = new Uint8Array(4 + bodyLen);
  out[0] = bodyLen & 0xff;
  out[1] = (bodyLen >> 8) & 0xff;
  out[2] = (bodyLen >> 16) & 0xff;
  out[3] = (bodyLen >> 24) & 0xff;
  out[4] = open;
  let k = 0;
  while (k < runLen) {
    out[5 + k] = buf[srcStart + k];
    k = k + 1;
  }
  out[4 + runLen + 1] = close;
  process.stdout.write(out);
}

// Re-chunk a large JSON ARRAY body `[elem,...,elem]` into valid <=FRAME_CAP
// `[run]` frames, split at COMMA boundaries so each frame is itself a valid JSON
// array; the receiver concatenates the interiors (re-inserting one comma between
// frames) to reproduce the original array. `ip0` is the first interior byte
// (after the leading `[`), `interiorLen` the interior byte count (body length
// minus the outer `[` and `]`). Mirrors the final-batch drain of the shared
// `nm_js2wasm_sync_framing` core's re-chunker (which streams the same split);
// the whole body is already buffered here, so the split is a pure in-memory walk.
function rechunkArray(ip0: number, interiorLen: number): void {
  const maxRun = FRAME_CAP - 2; // leave room for the framing `[` / `]`
  let startPos = 0;
  while (startPos < interiorLen) {
    let stop = startPos + maxRun;
    if (stop >= interiorLen) {
      stop = interiorLen; // final frame ends exactly at the interior end
    } else {
      // Back up to the last comma within [startPos, startPos+maxRun) so each
      // frame holds whole elements; exclude that comma (it's the separator).
      let c = stop;
      while (c > startPos && buf[ip0 + c - 1] !== COMMA) c = c - 1;
      if (c > startPos) stop = c - 1;
      // else: no comma in the window — a single element exceeds the cap; emit
      // maxRun raw (degenerate, only for elements > ~FRAME_CAP bytes), matching
      // the shared core.
    }
    emitRun(ip0 + startPos, stop - startPos, OPEN_BRACKET, CLOSE_BRACKET);
    startPos = stop;
    if (startPos < interiorLen && buf[ip0 + startPos] === COMMA) startPos = startPos + 1;
  }
}

// Re-chunk a large JSON STRING body `"chars..."` into valid <=FRAME_CAP `"run"`
// frames; the receiver concatenates the interiors to reproduce the original
// string. A fixed `maxRun` split keeps each frame within the cap (no comma
// boundaries to honor, unlike the array path). `ip0` is the first interior byte
// (after the leading `"`), `interiorLen` = body length minus the two `"`. (The
// fixed-run split must not bisect a `\`-escape; for the reported workload the
// body is plain printable characters, so a fixed split is valid — same caveat as
// the shared core's emitStringRun.)
function rechunkString(ip0: number, interiorLen: number): void {
  const maxRun = FRAME_CAP - 2; // leave room for the two framing `"`
  let startPos = 0;
  while (startPos < interiorLen) {
    let runLen = maxRun;
    if (interiorLen - startPos < runLen) runLen = interiorLen - startPos;
    emitRun(ip0 + startPos, runLen, DQUOTE, DQUOTE);
    startPos = startPos + runLen;
  }
}

// Append a `'data'` chunk's raw bytes into `buf` — O(chunk). The prelude (#2777)
// delivers each chunk as a FLAT string, so `chunk.charCodeAt(k)` is O(1). Grows
// the backing array with amortized doubling, reclaiming the consumed prefix
// (`head > 0`) first so a long-lived stream does not grow without bound.
function append(chunk: string): void {
  const n = chunk.length;
  if (tail + n > buf.length) {
    if (head > 0) {
      const m = tail - head;
      let i = 0;
      while (i < m) {
        buf[i] = buf[head + i];
        i = i + 1;
      }
      head = 0;
      tail = m;
    }
    if (tail + n > buf.length) {
      let cap = buf.length;
      while (cap < tail + n) {
        cap = cap * 2;
      }
      const nb = new Uint8Array(cap);
      let j = 0;
      while (j < tail) {
        nb[j] = buf[j];
        j = j + 1;
      }
      buf = nb;
    }
  }
  let k = 0;
  while (k < n) {
    buf[tail] = chunk.charCodeAt(k) & 0xff;
    tail = tail + 1;
    k = k + 1;
  }
}

// Decode the little-endian uint32 the browser wrote as the first 4 buffered
// bytes (at the current `head`).
function decodeLength(): number {
  return buf[head] + buf[head + 1] * 256 + buf[head + 2] * 65536 + buf[head + 3] * 16777216;
}

// Echo every complete frame currently buffered, advancing `head` past each. A
// frame is the 4-byte LE prefix + `len` body bytes; we re-emit prefix + body as
// raw bytes in ONE `process.stdout.write` (atomic framing — a streaming receiver
// must never see a prefix split from its body).
function drain(): void {
  while (!stopped) {
    if (tail - head < 4) return; // need the full length prefix first
    const len = decodeLength();
    if (len === 0) {
      stopped = true; // zero-length frame = clean shutdown
      // #2735: in-band shutdown. The peer (a long-lived Native-Messaging port)
      // keeps stdin OPEN — it signals "done" with a zero-length frame rather
      // than by closing the pipe, so stdin never reaches EOF. `.destroy()`
      // drops the fd0 reactor subscription so `_start` returns cleanly; without
      // it the reactor's only exit is stdin EOF and the program HANGS forever.
      process.stdin.destroy();
      return;
    }
    const frameLen = 4 + len;
    if (tail - head < frameLen) return; // body not fully arrived yet

    if (len <= FRAME_CAP) {
      // Body already within the 1 MiB browser cap — echo the frame VERBATIM
      // (prefix + body) in ONE write. Re-frame prefix + body into one raw-byte
      // buffer: the prefix is rebuilt from the decoded length (identical bytes);
      // the body bytes are a straight O(1) typed-array copy out of `buf`.
      const out = new Uint8Array(frameLen);
      out[0] = len & 0xff;
      out[1] = (len >> 8) & 0xff;
      out[2] = (len >> 16) & 0xff;
      out[3] = (len >> 24) & 0xff;
      let i = 0;
      while (i < len) {
        out[4 + i] = buf[head + 4 + i];
        i = i + 1;
      }
      process.stdout.write(out);
    } else {
      // Body exceeds the 1 MiB browser cap — RE-CHUNK into valid <=1 MiB JSON
      // frames (#2808), matching the `nm_js2wasm_node_fs` re-chunker. Peek the
      // first body byte to pick the shape: `"` → a JSON string split into `"run"`
      // frames; otherwise a JSON array split into `[run]` frames at comma
      // boundaries. The interior excludes the outer `[`/`]` (or the two `"`):
      // it starts at `head + 5` and is `len - 2` bytes long.
      const ip0 = head + 5;
      const interiorLen = len - 2;
      if (buf[head + 4] === DQUOTE) {
        rechunkString(ip0, interiorLen);
      } else {
        rechunkArray(ip0, interiorLen);
      }
    }

    // Drop the echoed frame; keep any trailing partial frame for the next chunk.
    head = head + frameLen;
    if (head >= tail) {
      head = 0;
      tail = 0;
    }
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
    append(chunk);
    drain();
  });
  process.stdin.on("end", () => {
    // EOF: anything left buffered is an incomplete frame and is dropped,
    // matching the sibling variants which stop on a short/truncated read.
  });
}

// Invoke the entry point. js2wasm compiles the top-level call into the module's
// `_start`; the injected fd0 reactor then pumps stdin until EOF.
main();
