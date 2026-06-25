#!/usr/bin/env bash
# #2658 B0 spike — build + run the native WASI Preview 3 (0.3) demonstrations.
#
# Two artifacts:
#   1. run-async.wat   — minimal P3 ASYNC command (RUNS under wasmtime 44).
#   2. stream-echo.wat — P3 stream<u8> stdin->stdout echo (parses; gated at the
#                        wasmtime decode step by the future<T> encoding skew —
#                        see README.md / plan/issues/2658-*.md "B0 Spike Findings").
#
# Prereqs on this box: wasmtime 44, and jco (bundled via componentize-js — this
# script resolves it the same way scripts/wasi-p2-component.mjs does).
#
# Usage:  bash examples/native-messaging/p3-b0-spike/run-p3-b0.sh
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"

# Resolve the vendored jco CLI (no standalone wasm-tools on this box).
JCO="$(node -e "import('file://$REPO/scripts/wasi-p2-component.mjs').then(m=>{const j=m.resolveJco();if(!j){process.exit(3)}process.stdout.write(j.cli)})")"
if [ -z "${JCO:-}" ]; then
  echo "FATAL: could not resolve @bytecodealliance/jco — run 'pnpm install'." >&2
  exit 3
fi

ASYNC_FLAGS="-W component-model-async=y -W component-model-async-builtins=y -W component-model-async-stackful=y"

echo "== 1. minimal P3 async command (run-async.wat) =="
node "$JCO" parse "$HERE/run-async.wat" -o "$HERE/run-async.wasm" || { echo "parse FAILED"; exit 1; }
echo "   parsed -> run-async.wasm"
# shellcheck disable=SC2086
if printf 'x' | wasmtime run -W component-model-async=y -S p3=y "$HERE/run-async.wasm"; then
  echo "   ✅ RAN under wasmtime 44 (exit 0) — P3 async canonical ABI works here."
else
  echo "   ❌ did not run (unexpected — was proven 2026-06-26)."
fi

echo
echo "== 2. P3 stream<u8> echo (stream-echo.wat) =="
if node "$JCO" parse "$HERE/stream-echo.wat" -o "$HERE/stream-echo.wasm" 2>/dev/null; then
  echo "   parsed with jco -> stream-echo.wasm (wasm-tools accepts the future<T> encoding)"
else
  echo "   ❌ jco parse failed (unexpected)."
fi
echo "   attempting to run under wasmtime 44 (expected: future<T> decode gap)..."
# shellcheck disable=SC2086
if printf 'hello P3\n' | wasmtime run $ASYNC_FLAGS -S p3=y "$HERE/stream-echo.wasm" 2>"$HERE/.stream-echo.err"; then
  echo "   ✅ stream echo RAN — the future<T> encoding skew has been resolved!"
else
  echo "   ⚠️  blocked at wasmtime decode (the documented B3 prerequisite):"
  sed 's/^/      /' "$HERE/.stream-echo.err" | head -4
  rm -f "$HERE/.stream-echo.err"
fi
