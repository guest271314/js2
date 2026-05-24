// Chrome Native Messaging host, compiled to standalone WASI by js2wasm.
//
//   npx js2wasm examples/native-messaging/host.ts --target wasi -o out
//
// Chrome's Native Messaging protocol frames each message as a 4-byte
// little-endian length prefix followed by a UTF-8 JSON body, exchanged over
// the host process's stdin (fd=0) and stdout (fd=1). See:
//   https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
//
// js2wasm support today (see README.md → "What works / what doesn't"):
//   - stdin  : readStdin() drains fd=0 to EOF and returns it as a string (#1481)
//   - stdout : console.log writes a UTF-8 string + newline to fd=1 (#1480/#1493)
//   - stderr : console.error / console.warn write to fd=2 (#1493) — use these
//              for debug output so they never corrupt the stdout protocol stream
//
// IMPORTANT — read the README before wiring this into Chrome. The compiler
// cannot yet emit the *binary* 4-byte length prefix on stdout (there is no
// raw-byte stdout API; console.log UTF-8-encodes and appends a newline). This
// host therefore demonstrates the *message-processing core* — reading the JSON
// body off stdin and producing a JSON response — but is NOT yet a drop-in
// Chrome host until raw-byte framing lands (tracked as a follow-up issue,
// see README). Run it with the wrapper in run.sh under wasmtime/wasmer to see
// the read → process → respond loop end to end.

declare function readStdin(): string;

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
  console.log(`{"received":${body},"runtime":"js2wasm+wasi"}`);
}
