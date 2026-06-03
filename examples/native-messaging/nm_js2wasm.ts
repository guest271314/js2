// Chrome Native Messaging host, compiled to standalone WASI by js2wasm.
//
//   npx js2wasm examples/native-messaging/nm_js2wasm.ts --target wasi -o out
//
// Chrome's Native Messaging protocol frames each message as a 4-byte
// little-endian length prefix followed by a UTF-8 body, exchanged over the
// host process's stdin (fd=0) and stdout (fd=1). See:
//   https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
//
// Chrome caps a single host→extension message at 1 MiB, so a large echo is
// streamed back as a sequence of <=1 MiB frames whose bodies concatenate to the
// original request — a strict byte round-trip (#389/#930). Crucially the body
// is streamed through a SINGLE reused 1 MiB buffer, so resident memory stays
// flat regardless of message size or count: the host never allocates the whole
// body, and there is no per-message allocation to accumulate in the GC heap.
//
// js2wasm support today:
//   - stdin  : process.stdin.read(buf, offset?) does one binary, incremental
//              fd=0 read into the caller's typed buffer at `offset`, returning
//              the byte count (#1653) — the standard Node API. A read-until
//              loop assembles exactly N bytes from possibly-short reads.
//   - stdout : process.stdout.write(bytes|str) writes raw bytes / a string to
//              fd=1 with NO trailing newline (#1651) — used for the binary
//              4-byte length prefix and each body chunk.
//   - stderr : process.stderr.write writes raw bytes/strings to fd=2, keeping
//              debug output off the stdout protocol stream.

declare const process: {
  stdin: { read(buf: Uint8Array | ArrayBuffer, offset?: number): number };
  stdout: { write(chunk: Uint8Array | ArrayBuffer | string): void };
  stderr: { write(chunk: Uint8Array | string): void };
};

// Largest body Chrome accepts in one host→extension message, and the size of
// the single scratch buffer every chunk is streamed through.
const FRAME_CHUNK = 1024 * 1024;

// Read exactly `n` bytes into the first `n` slots of `buf` via a read-until
// loop, handling short reads (fd_read may return fewer bytes than requested).
// Returns false on EOF (a read of <= 0 bytes before `n` were assembled) so the
// caller can cleanly terminate the port loop.
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

// Decode the little-endian uint32 length that Chrome wrote as the first 4
// bytes of the frame.
/** @param {Uint8Array} header @returns {number} */
function decodeLength(header: Uint8Array): number {
  return header[0] + header[1] * 256 + header[2] * 65536 + header[3] * 16777216;
}

// Write a 4-byte little-endian frame length prefix to stdout (#1651).
/** @param {number} len */
function writeLength(len: number): void {
  process.stdout.write(new Uint8Array([len & 0xff, (len >> 8) & 0xff, (len >> 16) & 0xff, (len >> 24) & 0xff]));
}

// Debug telemetry goes to stderr (fd=2) so it never pollutes the stdout
// protocol stream. Chrome ignores the host's stderr. The frame is the 4-byte
// LE prefix plus the declared body, so total bytes consumed is 4 + declaredLen.
/** @param {number} declaredLen */
function logFrameBodyRead(declaredLen: number): void {
  process.stderr.write(`[host] received ${4 + declaredLen} chars, declared body length ${declaredLen}\n`);
}

export function main(): void {
  // Long-lived port loop: read framed messages off stdin until EOF and echo
  // each one back byte-for-byte. A large body is streamed straight back in
  // <=1 MiB frames through the reused `chunk` buffer, so the bytes round-trip
  // exactly with no wrapper and no added bytes (#930), the response honours
  // Chrome's 1 MiB host→extension cap, and resident memory never scales with
  // the message size (#389). A real host would instead decode each chunk,
  // dispatch on a command field, and frame structured responses the same way.
  const header = new Uint8Array(4);
  const chunk = new Uint8Array(FRAME_CHUNK); // allocated once, reused for every frame
  while (true) {
    // 4-byte LE length prefix. EOF (or a zero-length frame) = clean shutdown.
    if (!readExact(header, 4)) break;
    const declaredLen = decodeLength(header);
    if (declaredLen === 0) break;
    logFrameBodyRead(declaredLen);

    let remaining = declaredLen;
    let truncated = false;
    while (remaining > 0) {
      if (remaining >= FRAME_CHUNK) {
        // Full 1 MiB frame straight through the reused buffer — no allocation.
        if (!readExact(chunk, FRAME_CHUNK)) {
          truncated = true;
          break;
        }
        writeLength(FRAME_CHUNK);
        process.stdout.write(chunk);
        remaining = remaining - FRAME_CHUNK;
      } else {
        // Final partial frame: an exact-size buffer avoids reading past this
        // message into the next one (a reused larger buffer could over-read).
        const tail = new Uint8Array(remaining);
        if (!readExact(tail, remaining)) {
          truncated = true;
          break;
        }
        writeLength(remaining);
        process.stdout.write(tail);
        remaining = 0;
      }
    }
    if (truncated) break; // EOF mid-frame → stop
  }
}
