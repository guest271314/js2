// Chrome Native Messaging host, compiled to standalone WASI by js2wasm.
//
//   npx js2wasm examples/native-messaging/nm_js2wasm.ts --target wasi -o out
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
//              4-byte length prefix and the message body. Response writes are
//              capped at <=1 MiB frames for Chrome (#1753/#1767), using a
//              reusable scratch chunk for larger bodies.
//   - stderr : process.stderr.write writes raw bytes/strings to fd=2, keeping
//              debug output off the stdout protocol stream.
//
// This is a drop-in Chrome host modelled on the 3-symbol shape guest271314
// uses across runtimes (`nm_assemblyscript.ts`, `nm_javy.js`, `nm_qjs_wasi.js`):
//
//   getMessage()         — read the 4-byte LE header, then exactly N body bytes
//   sendMessage(message) — frame with the LE length prefix + write stdout
//   main()               — the port loop: const m = getMessage();
//                          sendMessageWithContinuations(m);
//
// <=1 MiB bodies are carried as a raw `Uint8Array` end-to-end and echoed back
// verbatim (the strict #930 round-trip echo). Larger request bodies can arrive
// as successive <=1 MiB frames up to a 64 MiB ceiling. Continuation handling is
// streamed: raw byte continuations are echoed one frame at a time, and the
// reported Chrome `Array(...nulls...)` workload is counted with a streaming
// parser before valid JSON array response chunks are emitted. The host never
// stages one oversized stdout payload or the full 64 MiB request in WasmGC
// arrays.

declare const process: {
  stdin: { read(buf: Uint8Array | ArrayBuffer, offset?: number): number };
  stdout: { write(chunk: Uint8Array | ArrayBuffer | string): void };
  stderr: { write(chunk: Uint8Array | string): void };
};

const MAX_NATIVE_MESSAGING_FRAME_BYTES = 1024 * 1024;
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
const MAX_RESPONSE_FRAME_BYTES = MAX_NATIVE_MESSAGING_FRAME_BYTES;
const MAX_REQUEST_FRAME_BYTES = MAX_NATIVE_MESSAGING_FRAME_BYTES;
const MAX_NULL_ARRAY_ELEMENTS_PER_FRAME = 209715;
const BYTE_OPEN_BRACKET = 91;
const BYTE_CLOSE_BRACKET = 93;
const BYTE_COMMA = 44;
const BYTE_N = 110;
const BYTE_U = 117;
const BYTE_L = 108;

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

function minI32(a: number, b: number): number {
  return a < b ? a : b;
}

function copyBytes(
  source: Uint8Array,
  sourceOffset: number,
  target: Uint8Array,
  targetOffset: number,
  count: number,
): void {
  let i = 0;
  while (i < count) {
    target[targetOffset + i] = source[sourceOffset + i];
    i = i + 1;
  }
}

function writeLength(len: number): void {
  process.stdout.write(new Uint8Array([len & 0xff, (len >> 8) & 0xff, (len >> 16) & 0xff, (len >> 24) & 0xff]));
}

function readFrameBody(declaredLen: number): Uint8Array {
  const body = new Uint8Array(declaredLen);
  if (!readExact(body, declaredLen)) return new Uint8Array(0);

  logFrameBodyRead(declaredLen);
  return body;
}

function logFrameBodyRead(declaredLen: number): void {
  // Debug telemetry goes to stderr (fd=2) so it never pollutes the stdout
  // protocol stream. Chrome ignores the host's stderr. The frame is the 4-byte
  // LE prefix plus the declared body, so total bytes consumed is 4 + declaredLen.
  process.stderr.write(`[host] received ${4 + declaredLen} chars, declared body length ${declaredLen}\n`);
}

function readFrameBodyInto(body: Uint8Array, declaredLen: number): boolean {
  if (!readExact(body, declaredLen)) return false;
  logFrameBodyRead(declaredLen);
  return true;
}

// getMessage() — read one Native Messaging request frame: the 4-byte LE length
// header plus exactly that many body bytes. Full-size frames may be followed by
// continuation frames; `sendMessageWithContinuations` handles that large
// logical-message path by streaming the continuation frames so the host never
// stores the whole 64 MiB request body in WasmGC-managed arrays. Returns a
// zero-length buffer on EOF / truncation / oversize so the port loop can stop.
function getMessage(): Uint8Array {
  const header = new Uint8Array(4);
  // 4-byte LE length prefix. EOF here = clean shutdown → empty body.
  if (!readExact(header, 4)) return new Uint8Array(0);
  const declaredLen = decodeLength(header);
  if (declaredLen === 0 || declaredLen > MAX_REQUEST_FRAME_BYTES) return new Uint8Array(0);

  const message = readFrameBody(declaredLen);
  if (message.length !== declaredLen) return new Uint8Array(0);
  return message;
}

function isNullArrayMessage(message: Uint8Array): boolean {
  if (message.length < 2) return false;
  if (message[0] !== BYTE_OPEN_BRACKET) return false;
  if (message[message.length - 1] !== BYTE_CLOSE_BRACKET) return false;
  if (message.length === 2) return true;

  let cursor = 1;
  while (cursor < message.length - 1) {
    if (message[cursor] !== BYTE_N) return false;
    if (message[cursor + 1] !== BYTE_U) return false;
    if (message[cursor + 2] !== BYTE_L) return false;
    if (message[cursor + 3] !== BYTE_L) return false;
    cursor = cursor + 4;

    if (cursor === message.length - 1) return true;
    if (message[cursor] !== BYTE_COMMA) return false;
    cursor = cursor + 1;
  }

  return false;
}

function scanNullArrayBytes(message: Uint8Array, len: number, initialState: number, initialCount: number): number {
  let state = initialState;
  let count = initialCount;
  let cursor = 0;

  while (cursor < len) {
    const byte = message[cursor];

    if (state === 0) {
      if (byte === BYTE_OPEN_BRACKET) {
        state = 1;
      } else {
        return -1;
      }
    } else if (state === 1) {
      if (byte === BYTE_CLOSE_BRACKET) {
        state = 7;
      } else if (byte === BYTE_N) {
        state = 2;
      } else {
        return -1;
      }
    } else if (state === 2) {
      if (byte === BYTE_U) {
        state = 3;
      } else {
        return -1;
      }
    } else if (state === 3) {
      if (byte === BYTE_L) {
        state = 4;
      } else {
        return -1;
      }
    } else if (state === 4) {
      if (byte === BYTE_L) {
        count = count + 1;
        state = 5;
      } else {
        return -1;
      }
    } else if (state === 5) {
      if (byte === BYTE_COMMA) {
        state = 1;
      } else if (byte === BYTE_CLOSE_BRACKET) {
        state = 7;
      } else {
        return -1;
      }
    } else {
      return -1;
    }

    cursor = cursor + 1;
  }

  return count * 8 + state;
}

function nullArrayScanState(encoded: number): number {
  return encoded & 7;
}

function nullArrayScanCount(encoded: number): number {
  return (encoded - (encoded & 7)) / 8;
}

function canStreamNullArrayContinuation(first: Uint8Array): boolean {
  const encoded = scanNullArrayBytes(first, first.length, 0, 0);
  return encoded >= 0 && nullArrayScanState(encoded) !== 7;
}

function countNullArrayElements(message: Uint8Array): number {
  if (message.length === 2) return 0;
  let count = 0;
  let cursor = 1;
  while (cursor < message.length - 1) {
    count = count + 1;
    cursor = cursor + 5;
  }
  return count;
}

function fillNullArrayChunk(chunk: Uint8Array, elements: number): number {
  chunk[0] = BYTE_OPEN_BRACKET;
  let cursor = 1;
  let i = 0;
  while (i < elements) {
    if (i > 0) {
      chunk[cursor] = BYTE_COMMA;
      cursor = cursor + 1;
    }
    chunk[cursor] = BYTE_N;
    chunk[cursor + 1] = BYTE_U;
    chunk[cursor + 2] = BYTE_L;
    chunk[cursor + 3] = BYTE_L;
    cursor = cursor + 4;
    i = i + 1;
  }
  chunk[cursor] = BYTE_CLOSE_BRACKET;
  return cursor + 1;
}

function writeFrameFromScratch(scratch: Uint8Array, len: number): void {
  writeLength(len);
  if (len === scratch.length) {
    process.stdout.write(scratch);
    return;
  }

  const tail = new Uint8Array(len);
  copyBytes(scratch, 0, tail, 0, len);
  process.stdout.write(tail);
}

function sendNullArrayElementChunks(elements: number): void {
  let remaining = elements;
  const chunk = new Uint8Array(MAX_RESPONSE_FRAME_BYTES);

  if (remaining === 0) {
    const len = fillNullArrayChunk(chunk, 0);
    writeFrameFromScratch(chunk, len);
    return;
  }

  while (remaining > 0) {
    const elements = minI32(remaining, MAX_NULL_ARRAY_ELEMENTS_PER_FRAME);
    const len = fillNullArrayChunk(chunk, elements);
    writeFrameFromScratch(chunk, len);
    remaining = remaining - elements;
  }
}

function sendNullArrayChunks(message: Uint8Array): void {
  sendNullArrayElementChunks(countNullArrayElements(message));
}

function sendRawByteChunks(message: Uint8Array): void {
  let offset = 0;
  const chunk = new Uint8Array(MAX_RESPONSE_FRAME_BYTES);

  while (offset < message.length) {
    const len = minI32(MAX_RESPONSE_FRAME_BYTES, message.length - offset);
    copyBytes(message, offset, chunk, 0, len);
    writeFrameFromScratch(chunk, len);
    offset = offset + len;
  }
}

// sendMessage(message) — write a framed Native Messaging response: the 4-byte
// little-endian length prefix followed by the body bytes, both on stdout
// (fd=1), no trailing newline. Large responses are split into <=1 MiB frames
// and copy one output chunk at a time through a reusable buffer, avoiding one
// oversized response staging region (#1753/#1767).
function sendMessage(message: Uint8Array): void {
  const len = message.length;
  if (len > MAX_RESPONSE_FRAME_BYTES) {
    if (isNullArrayMessage(message)) {
      sendNullArrayChunks(message);
    } else {
      sendRawByteChunks(message);
    }
    return;
  }

  // Binary 4-byte LE length prefix via raw-byte stdout (#1651).
  writeLength(len);
  // Body — raw bytes, written verbatim with no trailing newline. The write
  // helper grows linear memory for large bodies (#389/#1723).
  process.stdout.write(message);
}

function sendRawContinuationChunks(first: Uint8Array, header: Uint8Array, initialDeclaredLen: number): void {
  sendMessage(first);

  let declaredLen = initialDeclaredLen;
  let totalLen = first.length;
  const chunk = new Uint8Array(MAX_REQUEST_FRAME_BYTES);

  while (true) {
    if (!readFrameBodyInto(chunk, declaredLen)) return;
    writeFrameFromScratch(chunk, declaredLen);
    totalLen = totalLen + declaredLen;

    if (declaredLen < MAX_REQUEST_FRAME_BYTES || totalLen >= MAX_MESSAGE_BYTES) break;
    if (!readExact(header, 4)) break;
    declaredLen = decodeLength(header);
    if (declaredLen === 0) break;
    if (declaredLen > MAX_REQUEST_FRAME_BYTES) return;
    if (totalLen + declaredLen > MAX_MESSAGE_BYTES) return;
  }
}

function sendNullArrayContinuationChunks(first: Uint8Array, header: Uint8Array, initialDeclaredLen: number): void {
  let encoded = scanNullArrayBytes(first, first.length, 0, 0);
  if (encoded < 0) return;

  let state = nullArrayScanState(encoded);
  let elements = nullArrayScanCount(encoded);
  let declaredLen = initialDeclaredLen;
  let totalLen = first.length;
  const chunk = new Uint8Array(MAX_REQUEST_FRAME_BYTES);

  while (true) {
    if (!readFrameBodyInto(chunk, declaredLen)) return;
    encoded = scanNullArrayBytes(chunk, declaredLen, state, elements);
    if (encoded < 0) return;
    state = nullArrayScanState(encoded);
    elements = nullArrayScanCount(encoded);
    totalLen = totalLen + declaredLen;

    if (declaredLen < MAX_REQUEST_FRAME_BYTES || totalLen >= MAX_MESSAGE_BYTES) break;
    if (!readExact(header, 4)) break;
    declaredLen = decodeLength(header);
    if (declaredLen === 0) break;
    if (declaredLen > MAX_REQUEST_FRAME_BYTES) return;
    if (totalLen + declaredLen > MAX_MESSAGE_BYTES) return;
  }

  if (state === 7) sendNullArrayElementChunks(elements);
}

function sendMessageWithContinuations(first: Uint8Array): void {
  if (first.length !== MAX_REQUEST_FRAME_BYTES) {
    sendMessage(first);
    return;
  }

  const header = new Uint8Array(4);
  if (!readExact(header, 4)) {
    sendMessage(first);
    return;
  }

  let declaredLen = decodeLength(header);
  if (declaredLen === 0) {
    sendMessage(first);
    return;
  }
  if (declaredLen > MAX_REQUEST_FRAME_BYTES || MAX_REQUEST_FRAME_BYTES + declaredLen > MAX_MESSAGE_BYTES) return;

  if (canStreamNullArrayContinuation(first)) {
    sendNullArrayContinuationChunks(first, header, declaredLen);
  } else {
    sendRawContinuationChunks(first, header, declaredLen);
  }
}

export function main(): void {
  // Long-lived port loop: read framed messages off stdin until EOF, echoing
  // each one back verbatim. getMessage() returns a zero-length body at EOF (or a
  // truncated frame), which terminates the loop.
  //
  // Normal-size messages are sent back byte-for-byte, with no wrapper and no
  // added bytes. Larger messages are chunked by sendMessage(); a real host would
  // instead decode `message`, dispatch on a command field, and frame structured
  // responses with the same bounded writer.
  while (true) {
    const message = getMessage();
    if (message.length === 0) break;
    sendMessageWithContinuations(message);
  }
}
