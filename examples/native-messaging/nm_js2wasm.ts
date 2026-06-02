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
// as successive <=1 MiB frames and are reassembled up to a 64 MiB ceiling.
// Larger responses are written as a sequence of <=1 MiB response frames so the
// host never stages one oversized stdout payload. The reported Chrome workload
// is a JSON `Array(...nulls...)`; for that shape, large responses are emitted
// as valid JSON array chunks so the browser can deliver each frame to
// `port.onMessage`. Other large byte bodies are split as raw byte chunks for
// the harness / future Uint8Array Native Messaging consumers.

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

function copyBytesToBuffer(
  source: Uint8Array,
  sourceOffset: number,
  target: ArrayBuffer,
  targetOffset: number,
  count: number,
): void {
  const targetView = new DataView(target);
  let i = 0;
  while (i < count) {
    targetView.setUint8(targetOffset + i, source[sourceOffset + i]);
    i = i + 1;
  }
}

function copyBufferToBuffer(
  source: ArrayBuffer,
  sourceOffset: number,
  target: ArrayBuffer,
  targetOffset: number,
  count: number,
): void {
  const sourceView = new DataView(source);
  const targetView = new DataView(target);
  let i = 0;
  while (i < count) {
    targetView.setUint8(targetOffset + i, sourceView.getUint8(sourceOffset + i));
    i = i + 1;
  }
}

function writeLength(len: number): void {
  process.stdout.write(new Uint8Array([len & 0xff, (len >> 8) & 0xff, (len >> 16) & 0xff, (len >> 24) & 0xff]));
}

function readFrameBody(declaredLen: number): Uint8Array {
  const body = new Uint8Array(declaredLen);
  if (!readExact(body, declaredLen)) return new Uint8Array(0);

  // Debug telemetry goes to stderr (fd=2) so it never pollutes the stdout
  // protocol stream. Chrome ignores the host's stderr. The frame is the 4-byte
  // LE prefix plus the declared body, so total bytes consumed is 4 + declaredLen.
  process.stderr.write(`[host] received ${4 + declaredLen} chars, declared body length ${declaredLen}\n`);
  return body;
}

// getMessage() — read one Native Messaging request frame: the 4-byte LE length
// header plus exactly that many body bytes. Full-size frames may be followed by
// continuation frames; `sendMessageWithContinuations` handles that large
// logical-message path with ArrayBuffer storage so a 64 MiB request does not
// become an 8x f64 Uint8Array allocation. Returns a zero-length buffer on EOF /
// truncation / oversize so the port loop can stop.
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

function isNullArrayBufferMessage(message: ArrayBuffer, len: number): boolean {
  if (len < 2) return false;
  const view = new DataView(message);
  if (view.getUint8(0) !== BYTE_OPEN_BRACKET) return false;
  if (view.getUint8(len - 1) !== BYTE_CLOSE_BRACKET) return false;
  if (len === 2) return true;

  let cursor = 1;
  while (cursor < len - 1) {
    if (view.getUint8(cursor) !== BYTE_N) return false;
    if (view.getUint8(cursor + 1) !== BYTE_U) return false;
    if (view.getUint8(cursor + 2) !== BYTE_L) return false;
    if (view.getUint8(cursor + 3) !== BYTE_L) return false;
    cursor = cursor + 4;

    if (cursor === len - 1) return true;
    if (view.getUint8(cursor) !== BYTE_COMMA) return false;
    cursor = cursor + 1;
  }

  return false;
}

function countNullArrayBufferElements(message: ArrayBuffer, len: number): number {
  if (len === 2) return 0;
  let count = 0;
  let cursor = 1;
  while (cursor < len - 1) {
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

function sendRawBufferChunks(message: ArrayBuffer, totalLen: number): void {
  let offset = 0;

  while (offset < totalLen) {
    const len = minI32(MAX_RESPONSE_FRAME_BYTES, totalLen - offset);
    const chunk = new ArrayBuffer(len);
    copyBufferToBuffer(message, offset, chunk, 0, len);
    writeLength(len);
    process.stdout.write(chunk);
    offset = offset + len;
  }
}

function sendBufferMessage(message: ArrayBuffer, totalLen: number): void {
  if (totalLen > MAX_RESPONSE_FRAME_BYTES) {
    if (isNullArrayBufferMessage(message, totalLen)) {
      sendNullArrayElementChunks(countNullArrayBufferElements(message, totalLen));
    } else {
      sendRawBufferChunks(message, totalLen);
    }
    return;
  }

  writeLength(totalLen);
  const body = new ArrayBuffer(totalLen);
  copyBufferToBuffer(message, 0, body, 0, totalLen);
  process.stdout.write(body);
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

  let capacity = MAX_REQUEST_FRAME_BYTES + declaredLen;
  let message = new ArrayBuffer(capacity);
  copyBytesToBuffer(first, 0, message, 0, first.length);
  let totalLen = first.length;

  while (true) {
    const chunk = readFrameBody(declaredLen);
    if (chunk.length !== declaredLen) return;

    const neededLen = totalLen + declaredLen;
    if (neededLen > capacity) {
      let nextCapacity = capacity * 2;
      if (nextCapacity < neededLen) nextCapacity = neededLen;
      if (nextCapacity > MAX_MESSAGE_BYTES) nextCapacity = MAX_MESSAGE_BYTES;
      const next = new ArrayBuffer(nextCapacity);
      copyBufferToBuffer(message, 0, next, 0, totalLen);
      message = next;
      capacity = nextCapacity;
    }

    copyBytesToBuffer(chunk, 0, message, totalLen, declaredLen);
    totalLen = neededLen;

    if (declaredLen < MAX_REQUEST_FRAME_BYTES || totalLen >= MAX_MESSAGE_BYTES) break;
    if (!readExact(header, 4)) break;
    declaredLen = decodeLength(header);
    if (declaredLen === 0) break;
    if (declaredLen > MAX_REQUEST_FRAME_BYTES) return;
    if (totalLen + declaredLen > MAX_MESSAGE_BYTES) return;
  }

  sendBufferMessage(message, totalLen);
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
