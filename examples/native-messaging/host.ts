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
//              4-byte length prefix and the JSON body. console.log(str) also
//              writes runtime strings correctly now (#1618).
//   - stderr : console.error / console.warn write to fd=2 (#1493) — use these
//              for debug output so they never corrupt the stdout protocol stream
//
// This is a drop-in Chrome host: it reads each framed JSON message off stdin,
// builds a JSON response, and writes it back to stdout with the correct
// 4-byte little-endian length prefix, looping until stdin reaches EOF. Run it
// with the wrapper in run.sh under wasmtime/wasmer to exercise the
// read -> process -> respond loop end to end.

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

// Build a string from the declared body bytes, one byte per code unit (the
// Native Messaging JSON body is ASCII/UTF-8 framed by byte length).
function bodyToString(body: Uint8Array, length: number): string {
  let s = "";
  let i = 0;
  while (i < length) {
    s = s + String.fromCharCode(body[i]);
    i = i + 1;
  }
  return s;
}

// Write a framed Native Messaging response: the 4-byte little-endian length
// prefix followed by the JSON body, both on stdout (fd=1), no newline.
function writeMessage(body: string): void {
  const len = body.length;
  // Binary 4-byte LE length prefix via raw-byte stdout (#1651).
  process.stdout.write(new Uint8Array([len & 0xff, (len >> 8) & 0xff, (len >> 16) & 0xff, (len >> 24) & 0xff]));
  // JSON body — runtime string, written verbatim with no trailing newline.
  process.stdout.write(body);
}

export function main(): void {
  // Long-lived port loop: read framed messages off stdin until EOF. A short
  // read inside readExact is retried; a zero-byte read means the peer closed
  // stdin, so we break and exit.
  const header = new Uint8Array(4);
  while (true) {
    // 4-byte LE length prefix. EOF here = clean shutdown.
    if (!readExact(header, 4)) break;
    const declaredLen = decodeLength(header);

    // Read exactly the declared body bytes. A truncated body (EOF mid-frame)
    // also terminates the loop.
    const body = new Uint8Array(declaredLen);
    if (!readExact(body, declaredLen)) break;
    const bodyStr = bodyToString(body, declaredLen);

    // Debug telemetry goes to stderr (fd=2) so it never pollutes the stdout
    // protocol stream. Chrome ignores the host's stderr. The frame is the
    // 4-byte LE prefix plus the declared body, so the total bytes consumed is
    // 4 + declaredLen.
    console.error(`[host] received ${4 + declaredLen} chars, declared body length ${declaredLen}`);

    // Application logic: echo the received JSON body back inside a wrapper
    // object. Real hosts would parse `bodyStr`, dispatch on a command field,
    // and build a structured response.
    const response = `{"received":${bodyStr},"runtime":"js2wasm+wasi"}`;
    writeMessage(response);
  }
}
