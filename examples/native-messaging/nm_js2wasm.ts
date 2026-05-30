// Chrome Native Messaging host, compiled to standalone WASI by js2wasm.
//
//   npx js2wasm examples/native-messaging/host.ts --target wasi -o out
//
// Chrome's Native Messaging protocol frames each message as a 4-byte
// little-endian length prefix followed by a UTF-8 JSON body, exchanged over
// the host process's stdin (fd=0) and stdout (fd=1). See:
//   https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
//
// js2wasm support today:
//   - stdin  : process.stdin.read(buf, offset?) does one binary, incremental
//              fd=0 read into the caller's typed buffer at `offset`, returning
//              the byte count (#1653) — the standard Node API. A read-until
//              loop assembles exactly N bytes from possibly-short reads, so a
//              continuous `while (true)` port loop can read the 4-byte LE
//              header then exactly the declared body length.
//   - stdout : process.stdout.write(bytes|str) writes raw bytes / a string to
//              fd=1 with NO trailing newline (#1651) — used for the binary
//              4-byte length prefix and the message body. Large raw-byte
//              writes (>= 1 MiB) grow linear memory as needed (#389/#1723) so a
//              megabyte-scale body round-trips byte-exactly.
//   - stderr : process.stderr.write writes to fd=2 (no `console` in ECMA-262) —
//              use it for debug output so it never corrupts the stdout stream
//
// This is a drop-in Chrome host modelled on the 3-symbol shape guest271314
// uses across runtimes (`nm_assemblyscript.ts`, `nm_javy.js`, `nm_qjs_wasi.js`):
//
//   getMessage()         — read the 4-byte LE header, then exactly N body bytes
//   sendMessage(message) — frame with the LE length prefix + write stdout
//   main()               — the port loop: const m = getMessage(); sendMessage(m);
//
// The body is carried as a raw `Uint8Array` end-to-end and echoed back verbatim
// (the strict #930 round-trip echo) — it is NOT decoded to a JS string, so the
// bytes are preserved exactly regardless of size or content (#389). A real host
// would decode `message` with a UTF-8 reader, dispatch on a command field, and
// frame a fresh response with sendMessage(). Carrying bytes (not a string) is
// also forward-compatible with Chromium's in-progress Uint8Array Native
// Messaging support — the protocol body is fundamentally a byte buffer.

declare const process: {
  stdin: { read(buf: Uint8Array, offset?: number): number };
  stdout: { write(chunk: Uint8Array | string): void };
  stderr: { write(chunk: Uint8Array | string): void };
};

// Read exactly `n` bytes into the first `n` slots of `buf` via a read-until
// loop, handling short reads (fd_read may return fewer bytes than requested).
// Returns false on EOF (a read of <= 0 bytes before `n` were assembled) so the
// caller can cleanly terminate the port loop.
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
function decodeLength(header: Uint8Array): number {
  return header[0] + header[1] * 256 + header[2] * 65536 + header[3] * 16777216;
}

// getMessage() — read one framed Native Messaging message: the 4-byte LE length
// header, then exactly that many body bytes. Returns the raw body `Uint8Array`,
// or a zero-length buffer on EOF (peer closed stdin) so the port loop can stop.
// The body is kept as raw bytes — never stringified — so it round-trips
// byte-exactly at any size (#389).
function getMessage(): Uint8Array {
  const header = new Uint8Array(4);
  // 4-byte LE length prefix. EOF here = clean shutdown → empty body.
  if (!readExact(header, 4)) return new Uint8Array(0);
  const declaredLen = decodeLength(header);

  // Read exactly the declared body bytes. A truncated body (EOF mid-frame)
  // also terminates the loop, signalled as an empty body.
  const body = new Uint8Array(declaredLen);
  if (!readExact(body, declaredLen)) return new Uint8Array(0);

  // Debug telemetry goes to stderr (fd=2) so it never pollutes the stdout
  // protocol stream. Chrome ignores the host's stderr. The frame is the 4-byte
  // LE prefix plus the declared body, so total bytes consumed is 4 + declaredLen.
  process.stderr.write(`[host] received ${4 + declaredLen} chars, declared body length ${declaredLen}\n`);
  return body;
}

// sendMessage(message) — write a framed Native Messaging response: the 4-byte
// little-endian length prefix followed by the body bytes, both on stdout (fd=1),
// no trailing newline. The body is written as raw bytes so it is byte-exact for
// any payload, including a megabyte-scale message (#389).
function sendMessage(message: Uint8Array): void {
  const len = message.length;
  // Binary 4-byte LE length prefix via raw-byte stdout (#1651).
  process.stdout.write(new Uint8Array([len & 0xff, (len >> 8) & 0xff, (len >> 16) & 0xff, (len >> 24) & 0xff]));
  // Body — raw bytes, written verbatim with no trailing newline. The write
  // helper grows linear memory for large bodies (#389/#1723).
  process.stdout.write(message);
}

export function main(): void {
  // Long-lived port loop: read framed messages off stdin until EOF, echoing
  // each one back verbatim. getMessage() returns a zero-length body at EOF (or a
  // truncated frame), which terminates the loop.
  //
  // Strict echo: the received body is sent back byte-for-byte, with no wrapper
  // and no added bytes. This makes the demo a true round-trip proof — what
  // Chrome sends in is exactly what comes back out, so the stdin->stdout
  // fidelity of the WASI build is directly observable. A real host would instead
  // decode `message`, dispatch on a command field, and frame a structured
  // response with sendMessage().
  while (true) {
    const message = getMessage();
    if (message.length === 0) break;
    sendMessage(message);
  }
}
