#!/usr/bin/env bash
# Real-wasmtime smoke test for the Native Messaging host (#1530 / #1618 / #1651).
#
# The JS WASI polyfill (buildWasiPolyfill) zero-inits linear memory, so it
# masked an off-by-one in the integer-print helper that appended an
# uninitialized byte after each number — only REAL wasmtime, with reused bump
# memory, exposed it (a stray 'i' in the stderr debug line). This script
# compiles the shipped example and drives it under wasmtime, asserting:
#   1. stdout is the EXACT Native Messaging response frame (4-byte LE length
#      prefix + JSON body, no trailing newline);
#   2. stderr is the clean debug line with NO stray bytes (the off-by-one guard).
#
# Run from anywhere; paths are resolved relative to this script.
set -euo pipefail

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$DIR/../.." && pwd)
OUT_DIR=$(mktemp -d)
trap 'rm -rf "$OUT_DIR"' EXIT

echo "== Compiling examples/native-messaging/nm_js2wasm_node_fs.ts --target wasi =="
CLI="$OUT_DIR/js2wasm-cli.mjs"
# #2631 — the host now uses node:fs readSync/writeSync via the linkable `node:fs`
# shim, so compile with --link node:fs and build node-fs.wasm to preload.
SHIM="$OUT_DIR/node-fs.wasm"
(
  cd "$REPO_ROOT"
  node scripts/build-standalone-cli.mjs --outfile "$CLI"
  node "$CLI" examples/native-messaging/nm_js2wasm_node_fs.ts --target wasi --link node:fs -o "$OUT_DIR" --quiet
  node scripts/build-node-fs-shim.mjs "$SHIM"
)
WASM="$OUT_DIR/nm_js2wasm_node_fs.wasm"
[ -f "$WASM" ] || { echo "FAIL: $WASM was not produced" >&2; exit 1; }
[ -f "$SHIM" ] || { echo "FAIL: $SHIM was not produced" >&2; exit 1; }

# Framed input: 4-byte LE length prefix (0x0d = 13) + the 13-byte body.
# Total stdin = 17 bytes → the host's stderr should report
# "received 17 chars, declared body length 13".
FRAME='\x0d\x00\x00\x00{"ping":true}'

# IMPORTANT: enable ONLY the proposals this module uses. Do NOT use
# `-W all-proposals=y` — that turns on stack-switching, which wasmtime 44
# rejects ("wasm_stack_switching feature is not supported").
WASMTIME_FLAGS="-W gc=y,function-references=y,tail-call=y,exceptions=y"

STDOUT_FILE="$OUT_DIR/stdout.bin"
STDERR_FILE="$OUT_DIR/stderr.txt"

echo "== Running under wasmtime ($(wasmtime --version)) =="
# `--preload node:fs=<file>` registers the shim under the import module name
# `node:fs`; wasmtime resolves the user module's imports against it and provides
# wasi_snapshot_preview1 to the shim (#2631).
# shellcheck disable=SC2086
printf "$FRAME" | wasmtime $WASMTIME_FLAGS --preload "node:fs=$SHIM" "$WASM" >"$STDOUT_FILE" 2>"$STDERR_FILE"

# ---- Expected stdout frame -------------------------------------------------
# Strict echo: the response body is the received body verbatim, byte-for-byte.
# So the expected stdout body equals the input body and its length (13) is the
# LE prefix — a true round-trip with no added bytes.
EXPECTED_BODY='{"ping":true}'
BODY_LEN=${#EXPECTED_BODY}            # 13 → prefix 0x0d 0x00 0x00 0x00 (computed, not hardcoded)
EXPECTED_STDOUT_FILE="$OUT_DIR/expected_stdout.bin"
{
  # 4-byte little-endian uint32 length prefix.
  printf "$(printf '\\x%02x\\x%02x\\x%02x\\x%02x' \
    $(( BODY_LEN & 0xff )) \
    $(( (BODY_LEN >> 8) & 0xff )) \
    $(( (BODY_LEN >> 16) & 0xff )) \
    $(( (BODY_LEN >> 24) & 0xff )) )"
  printf '%s' "$EXPECTED_BODY"
} >"$EXPECTED_STDOUT_FILE"

if ! cmp -s "$STDOUT_FILE" "$EXPECTED_STDOUT_FILE"; then
  echo "FAIL: stdout frame mismatch" >&2
  echo "--- expected (hex) ---" >&2
  xxd "$EXPECTED_STDOUT_FILE" >&2 || od -An -tx1 "$EXPECTED_STDOUT_FILE" >&2
  echo "--- actual (hex) ---" >&2
  xxd "$STDOUT_FILE" >&2 || od -An -tx1 "$STDOUT_FILE" >&2
  exit 1
fi
echo "OK: stdout is the exact $((4 + BODY_LEN))-byte frame (prefix=$BODY_LEN + body)."

# ---- Expected stderr (off-by-one regression guard) -------------------------
# Must be exactly the debug line + newline — NO stray byte after the integers.
EXPECTED_STDERR='[host] received 17 chars, declared body length 13'
ACTUAL_STDERR=$(cat "$STDERR_FILE")
if [ "$ACTUAL_STDERR" != "$EXPECTED_STDERR" ]; then
  echo "FAIL: stderr has unexpected content (stray byte? off-by-one regression)" >&2
  echo "--- expected ---" >&2
  printf '%s\n' "$EXPECTED_STDERR" | xxd >&2 || printf '%s\n' "$EXPECTED_STDERR" | od -An -tx1 >&2
  echo "--- actual ---" >&2
  printf '%s' "$ACTUAL_STDERR" | xxd >&2 || printf '%s' "$ACTUAL_STDERR" | od -An -tx1 >&2
  exit 1
fi
echo "OK: stderr is the clean debug line, no stray bytes."

echo "PASS: Native Messaging host round-trips byte-exactly under real wasmtime."
