// Chrome Native Messaging host, compiled to standalone WASI by js2wasm.
//
//   npx js2wasm examples/native-messaging/nm_js2wasm.ts --target wasi -o out
//
// Chrome's Native Messaging protocol frames each message as a 4-byte
// little-endian length prefix followed by a UTF-8 **JSON** body, exchanged over
// the host process's stdin (fd=0) and stdout (fd=1). See:
//   https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
//
// Two hard protocol constraints drive the response shape:
//   1. Chrome deserializes EVERY host->extension message as JSON, so each frame
//      we write must be a complete, valid JSON value — not an arbitrary byte
//      slice. (A non-JSON frame is rejected with "The sender sent an invalid
//      JSON message; message ignored.")
//   2. A single host->extension message is capped at 1 MiB.
//
// So a large message — e.g. `port.postMessage(Array(209715*64))`, ~64 MiB of
// `[null,null,...]` — can neither be echoed in one frame nor split at raw byte
// boundaries (that yields invalid-JSON fragments). This host re-chunks a large
// JSON **array** into a sequence of <=1 MiB valid JSON arrays whose elements,
// concatenated by the receiver, reproduce the original array. A message that
// already fits in one frame is echoed verbatim. Chunks are written as
// `[` + `subarray` view + `]`, so no per-frame copy of the body is made.
//
// js2wasm support today:
//   - stdin  : process.stdin.read(buf, offset?) does one binary, incremental
//              fd=0 read into the caller's typed buffer at `offset`, returning
//              the byte count (#1653). A read-until loop assembles exactly N.
//   - stdout : process.stdout.write(bytes|str) writes raw bytes to fd=1 with NO
//              trailing newline (#1651) — the 4-byte LE prefix and body bytes.
//   - stderr : process.stderr.write writes to fd=2, off the protocol stream.

declare const process: {
  stdin: { read(buf: Uint8Array | ArrayBuffer, offset?: number): number };
  stdout: { write(chunk: Uint8Array | ArrayBuffer | string): void };
  stderr: { write(chunk: Uint8Array | string): void };
};

// Largest body Chrome accepts in one host->extension message.
const FRAME_CHUNK = 1024 * 1024;
const COMMA = 44; // ,
const OPEN_BRACKET = 91; // [
const CLOSE_BRACKET = 93; // ]

// Read exactly `n` bytes into the first `n` slots of `buf` via a read-until
// loop, handling short reads (fd_read may return fewer bytes than requested).
// Returns false on EOF (a read of <= 0 bytes before `n` were assembled).
/** @param {Uint8Array} buf @param {number} n @returns {boolean} */
function readExact(buf: Uint8Array, n: number): boolean {
  let got = 0;
  while (got < n) {
    const r = process.stdin.read(buf, got);
    if (r <= 0) return false; // EOF or error
    got = got + r;
  }
  return true;
}

// Decode the little-endian uint32 length Chrome wrote as the first 4 bytes.
/** @param {Uint8Array} header @returns {number} */
function decodeLength(header: Uint8Array): number {
  return header[0] + header[1] * 256 + header[2] * 65536 + header[3] * 16777216;
}

// Write a 4-byte little-endian frame length prefix to stdout (#1651).
/** @param {number} len */
function writeLength(len: number): void {
  process.stdout.write(new Uint8Array([len & 0xff, (len >> 8) & 0xff, (len >> 16) & 0xff, (len >> 24) & 0xff]));
}

// Debug telemetry to stderr (fd=2) so it never pollutes the stdout protocol
// stream. The frame is the 4-byte prefix plus the declared body.
/** @param {number} declaredLen */
function logFrameBodyRead(declaredLen: number): void {
  process.stderr.write(`[host] received ${4 + declaredLen} chars, declared body length ${declaredLen}\n`);
}

export function main(): void {
  // Long-lived port loop: read framed JSON messages off stdin until EOF and
  // echo each one back as valid JSON within Chrome's 1 MiB per-message cap.
  const header = new Uint8Array(4);
  while (true) {
    // 4-byte LE length prefix. EOF (or a zero-length frame) = clean shutdown.
    if (!readExact(header, 4)) break;
    const declaredLen = decodeLength(header);
    if (declaredLen === 0) break;
    logFrameBodyRead(declaredLen);

    const body = new Uint8Array(declaredLen);
    if (!readExact(body, declaredLen)) break;

    if (declaredLen <= FRAME_CHUNK) {
      // Already a single valid JSON message within the cap — echo verbatim.
      writeLength(declaredLen);
      process.stdout.write(body);
      continue;
    }

    // Large JSON array `[elem,elem,...,elem]`: emit a sequence of valid JSON
    // arrays `[elem,...]`, each <=1 MiB, split only at top-level commas so every
    // frame parses and the receiver can rebuild the original by concatenation.
    const maxRun = FRAME_CHUNK - 2; // leave room for the framing `[` and `]`
    let i = 1; // skip the leading `[`
    const end = declaredLen - 1; // index of the trailing `]`
    while (i < end) {
      let stop = i + maxRun;
      if (stop >= end) {
        stop = end;
      } else {
        // Back up to the last comma in [i, stop) so a frame never splits an
        // element; the run [i, stop) is then a whole number of elements.
        let c = stop;
        while (c > i && body[c - 1] !== COMMA) c = c - 1;
        if (c > i) stop = c - 1; // exclude the comma itself
      }
      // Frame body = `[` + body[i..stop) + `]` (a valid JSON array). Build it
      // with an element-wise copy into an exact-size buffer and write the whole
      // buffer once. We deliberately avoid `body.subarray(i, stop)`: under
      // wasmtime the native `array.copy` it lowers to runs ~14x slower than this
      // element loop for i8 GC arrays (#1863), while a whole-array stdout write
      // hits the fast path.
      const runLen = stop - i;
      const frame = new Uint8Array(runLen + 2);
      frame[0] = OPEN_BRACKET;
      let k = 0;
      while (k < runLen) {
        frame[k + 1] = body[i + k];
        k = k + 1;
      }
      frame[runLen + 1] = CLOSE_BRACKET;
      writeLength(runLen + 2);
      process.stdout.write(frame);
      i = stop;
      if (i < end && body[i] === COMMA) i = i + 1; // step over the separator
    }
  }
}
