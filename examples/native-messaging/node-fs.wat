(module
  ;; A provider of the `node:fs` import interface (fd-based readSync / writeSync)
  ;; implemented over WASI fd_read / fd_write. (#2631)
  ;;
  ;; The user module declares `import { readSync, writeSync } from "node:fs"`,
  ;; which lowers to wasm imports `(import "node:fs" "readSync" …)` /
  ;; `(import "node:fs" "writeSync" …)`. The module declares WHAT host API it
  ;; needs (`node:fs`), not HOW it's satisfied — this `.wat` is ONE provider of
  ;; that interface; a native WASI host or the real `node:fs` module (under a JS
  ;; host) are others. The shim therefore EXPORTS `readSync` / `writeSync` so the
  ;; linker binds module=`node:fs`, name=`readSync`.
  ;;
  ;; These are the faithful *synchronous* Node primitives the Native Messaging
  ;; host needs: `fs.readSync(fd, buf, …)` / `fs.writeSync(fd, buf, …)` are
  ;; fd-based (integer fd 0/1/2), NOT path-based — they map 1:1 to fd_read /
  ;; fd_write with no path_open, no preopens, NO filesystem. (Only the
  ;; path-based `fs` family — readFileSync(path) — needs a filesystem.)
  (import "wasi_snapshot_preview1" "fd_write"
    (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_read"
    (func $fd_read (param i32 i32 i32 i32) (result i32)))

  ;; The shim owns + exports the single shared linear memory.
  ;; min 3 pages matches the user module's reservation; grows on demand.
  (memory (export "memory") 3)

  ;; writeSync(fd, ptr, len) -> bytes written. Builds an iovec at [0] pointing
  ;; at the CALLER's bytes (same memory) and issues fd_write to `fd`. The js2wasm
  ;; pointer ABI passes (fd, ptr, len); the JS-host real `node:fs.writeSync`
  ;; takes (fd, buffer, …) — the compiler bridges its GC buffer to (ptr, len).
  (func (export "writeSync") (param $fd i32) (param $ptr i32) (param $len i32) (result i32)
    (i32.store (i32.const 0) (local.get $ptr))
    (i32.store (i32.const 4) (local.get $len))
    (drop (call $fd_write (local.get $fd) (i32.const 0) (i32.const 1) (i32.const 8)))
    (i32.load (i32.const 8)))

  ;; readSync(fd, ptr, len) -> bytes read. iovec points at the caller's
  ;; destination; issues fd_read from `fd`.
  (func (export "readSync") (param $fd i32) (param $ptr i32) (param $len i32) (result i32)
    (i32.store (i32.const 0) (local.get $ptr))
    (i32.store (i32.const 4) (local.get $len))
    (drop (call $fd_read (local.get $fd) (i32.const 0) (i32.const 1) (i32.const 8)))
    (i32.load (i32.const 8))))
