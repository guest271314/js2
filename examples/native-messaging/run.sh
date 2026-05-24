#!/bin/sh
# Chrome launches the native messaging host by executing this script and then
# speaking the length-prefixed JSON protocol over the script's stdin/stdout.
# The wrapper hands stdin/stdout straight through to the WASI runtime, which
# forwards them to the compiled module's fd=0 / fd=1.
#
# Chrome requires an ABSOLUTE path to this script in the manifest, and the
# script in turn needs an absolute path to host.wasm — Chrome does not set a
# predictable working directory. We resolve paths relative to this script's
# own location so the example is copy-paste portable.
set -eu

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
WASM="$DIR/out/host.wasm"

if [ ! -f "$WASM" ]; then
  echo "host.wasm not found at $WASM — build it first:" >&2
  echo "  npx js2wasm $DIR/host.ts --target wasi -o $DIR/out" >&2
  exit 1
fi

# wasmtime is the default runtime. Swap in wasmer if you prefer:
#   exec wasmer run "$WASM"
# Neither runtime needs --dir/--mapdir here: this host only touches
# stdin/stdout/stderr, no filesystem.
exec wasmtime "$WASM"
