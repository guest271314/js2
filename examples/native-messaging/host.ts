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
//   - stdin  : readStdin() drains fd=0 to EOF and returns it as a string (#1481)
//   - stdout : process.stdout.write(bytes|str) writes raw bytes / a string to
//              fd=1 with NO trailing newline (#1651) — used for the binary
//              4-byte length prefix and the JSON body. console.log(str) also
//              writes runtime strings correctly now (#1618).
//   - stderr : console.error / console.warn write to fd=2 (#1493) — use these
//              for debug output so they never corrupt the stdout protocol stream
//
// This is a drop-in Chrome host: it reads the framed JSON message off stdin,
// builds a JSON response, and writes it back to stdout with the correct
// 4-byte little-endian length prefix. Run it with the wrapper in run.sh under
// wasmtime/wasmer to exercise the read -> process -> respond loop end to end.

declare function readStdin(): string;
declare const process: {
  stdout: { write(chunk: Uint8Array | string): void };
  stderr: { write(chunk: Uint8Array | string): void };
};

// Strip Chrome's 4-byte little-endian length prefix from a framed message,
// returning just the JSON body. readStdin() hands us the whole stdin buffer
// (prefix + body) as a single string; we skip the first 4 code units.
function stripLengthPrefix(framed: string): string {
  // The 4 prefix bytes are read as 4 string code units by readStdin().
  return framed.substring(4);
}

// Decode the little-endian uint32 length that Chrome wrote as the first 4
// bytes, so a host can validate the frame size against the body it received.
function decodeLength(framed: string): number {
  const b0 = framed.charCodeAt(0) & 0xff;
  const b1 = framed.charCodeAt(1) & 0xff;
  const b2 = framed.charCodeAt(2) & 0xff;
  const b3 = framed.charCodeAt(3) & 0xff;
  return b0 + b1 * 256 + b2 * 65536 + b3 * 16777216;
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
  // Read the whole framed message from stdin (Chrome sends one per launch in
  // the simplest "stdio" wiring; a long-lived port would loop here).
  const framed = readStdin();
  const declaredLen = decodeLength(framed);
  const body = stripLengthPrefix(framed);

  // Debug telemetry goes to stderr (fd=2) so it never pollutes the stdout
  // protocol stream. Chrome ignores the host's stderr.
  console.error(`[host] received ${framed.length} chars, declared body length ${declaredLen}`);

  // Application logic: echo the received JSON body back inside a wrapper
  // object. Real hosts would parse `body`, dispatch on a command field, and
  // build a structured response.
  const response = `{"received":${body},"runtime":"js2wasm+wasi"}`;
  writeMessage(response);
}
