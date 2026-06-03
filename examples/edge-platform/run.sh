#!/usr/bin/env bash
# Reference platform scenario (#1255): compile a Node-oriented TypeScript
# program to standalone WebAssembly and run it on Wasmtime — no Node.js engine
# at deploy time.
#
# Usage: examples/edge-platform/run.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/../.." && pwd)"
out="$here/out"
src="$here/generate-artifacts.ts"

mkdir -p "$out"

echo "==> Compiling $src to WASI WebAssembly"
npx tsx "$repo_root/src/cli.ts" "$src" --target wasi -o "$out"

wasm="$out/generate-artifacts.wasm"
echo "==> Compiled $(wc -c < "$wasm") bytes: $wasm"

# The compiled module uses WasmGC + the standard reference-types / tail-call /
# exception-handling proposals. `--dir=.` maps the working directory into the
# WASI sandbox so writeFileSync can create files.
echo "==> Running on Wasmtime (no Node.js engine present)"
cd "$out"
rm -f manifest.json DEPLOY.md
wasmtime run \
  -W gc=y \
  -W function-references=y \
  -W tail-call=y \
  -W exceptions=y \
  --dir=. \
  "$wasm"

echo "==> Files produced by node:fs on the WASI host:"
echo "--- manifest.json ---"
cat manifest.json
echo "--- DEPLOY.md ---"
cat DEPLOY.md
