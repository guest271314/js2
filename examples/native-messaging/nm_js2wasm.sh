#!/usr/bin/env -S wasmtime -W all-proposals=y /absolute/path/to/js2/examples/native-messaging/out/host.wasm
# Chrome launches the native messaging host by executing this script and then
# speaking the length-prefixed JSON protocol over the script's stdin/stdout.
# The wrapper hands stdin/stdout straight through to the WASI runtime, which
# forwards them to the compiled module's fd=0 / fd=1.
#
# Chrome requires an ABSOLUTE path to this script in the manifest, and the
# script in turn needs an absolute path to host.wasm — Chrome does not set a
# predictable working directory. We resolve paths relative to this script's
# own location so the example is copy-paste portable.

