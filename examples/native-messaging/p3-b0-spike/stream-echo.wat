;; #2658 B0 spike — native WASI Preview 3 (0.3) async stream<u8> stdin->stdout ECHO.
;;
;; Authored against the AUTHORITATIVE wasi:cli@0.3.0-rc-2026-03-15 stdio WIT
;; (fetched from wasmtime v44.0.0 crates/wasi/src/p3/wit/deps/cli.wit):
;;
;;   stdin.read-via-stream:  func() -> tuple<stream<u8>, future<result<_, error-code>>>
;;   stdout.write-via-stream: func(data: stream<u8>) -> future<result<_, error-code>>
;;   run: async func() -> result
;;
;; The P3 echo is a host-driven stream HAND-OFF: read-via-stream() yields the
;; stdin readable stream; hand that same stream to write-via-stream(); the HOST
;; pumps stdin->stdout; the guest awaits the returned future<result>. The guest
;; barely touches the bytes (contrast nm_js2wasm_wasi_p1.ts, which hand-marshals iovecs).
;;
;; STATUS — parses with `jco parse`, but does NOT yet run under wasmtime 44:
;;   wasmtime rejects the `future<T>`-typed import at DECODE time:
;;     "failed to parse WebAssembly module / instance not valid to be used as import"
;;   under EVERY component-model-async feature-flag combination.
;;   Bisected: bare `stream<u8>` and `tuple<stream<u8>, u32>` decode fine; adding
;;   a `future<...>` member breaks the decode. Root cause = a component-model-async
;;   `future`/`stream` TYPE-ENCODING skew between jco 1.16.1's bundled wasm-tools
;;   (encodes it) and wasmtime 44's decoder (rejects it) — NOT a feature flag and
;;   NOT a js2wasm issue. Closing this skew (newer wasm-tools / encoding that
;;   matches wasmtime 44) is the named prerequisite for B3. See ./README.md and
;;   ../../../plan/issues/2658-*.md "B0 Spike Findings".
;;
;; This file is therefore the BINARY-SHAPE REFERENCE for the js2wasm P3 producer
;; (B2/B3), paired with the runnable run-async.wat for the proven async-command
;; half of the ABI.
(component
  (type $ec (enum "io" "illegal-byte-sequence" "pipe"))
  (type $rd-ret (tuple (stream u8) (future (result (error $ec)))))
  (type $wr-ret (future (result (error $ec))))

  (import "wasi:cli/stdin@0.3.0-rc-2026-03-15" (instance $stdin
    (export "read-via-stream" (func $rvs (result $rd-ret)))))
  (import "wasi:cli/stdout@0.3.0-rc-2026-03-15" (instance $stdout
    (export "write-via-stream" (func $wvs (param "data" (stream u8)) (result $wr-ret)))))
  (alias export $stdin "read-via-stream" (func $read-hl))
  (alias export $stdout "write-via-stream" (func $write-hl))

  ;; libc: memory + bump cabi_realloc, instantiated FIRST to break the
  ;; lower/lift memory cycle (no shim/fixup table needed — the memory does not
  ;; live in the instance that imports the lowered host funcs).
  (core module $libc
    (memory (export "memory") 1)
    (global $bump (mut i32) (i32.const 1024))
    (func (export "realloc") (param i32 i32 i32 i32) (result i32)
      (local $p i32)
      (local.set $p (global.get $bump))
      (global.set $bump (i32.add (global.get $bump) (local.get 3)))
      (local.get $p)))
  (core instance $libci (instantiate $libc))
  (alias core export $libci "memory" (core memory $mem))
  (alias core export $libci "realloc" (core func $realloc))

  ;; Lowered host imports (return-area / handles in libc memory).
  (core func $read-low  (canon lower (func $read-hl)  (memory $mem) (realloc $realloc)))
  (core func $write-low (canon lower (func $write-hl) (memory $mem) (realloc $realloc)))
  ;; Async built-ins to await the host-side write pump.
  (core func $task-return (canon task.return (result (result))))
  (core func $ws-new (canon waitable-set.new))
  (core func $ws-wait (canon waitable-set.wait (memory $mem)))
  (core func $w-join (canon waitable.join))
  (core func $fread (canon future.read $wr-ret (memory $mem)))

  (core module $main
    (import "libc" "memory" (memory 1))
    (import "h" "read" (func $read (param i32)))             ;; -> retptr [stream@0, future@4]
    (import "h" "write" (func $write (param i32) (result i32))) ;; stream handle -> future handle
    (import "h" "task-return" (func $tr (param i32)))
    (import "h" "ws-new" (func $wsnew (result i32)))
    (import "h" "ws-wait" (func $wswait (param i32 i32) (result i32)))
    (import "h" "w-join" (func $wjoin (param i32 i32)))
    (import "h" "fread" (func $fr (param i32 i32) (result i32)))
    (func (export "run")
      (local $s i32) (local $wfut i32) (local $ws i32) (local $st i32)
      (call $read (i32.const 0))                  ;; read-via-stream() -> [s, rfut]
      (local.set $s (i32.load (i32.const 0)))      ;; stdin readable stream handle
      (local.set $wfut (call $write (local.get $s))) ;; hand it to stdout; future<result>
      (local.set $ws (call $wsnew))
      (call $wjoin (local.get $wfut) (local.get $ws))
      (local.set $st (call $fr (local.get $wfut) (i32.const 16))) ;; drive completion
      (block $done
        (br_if $done (i32.eqz (i32.and (local.get $st) (i32.const 0xf)))) ;; already complete
        (drop (call $wswait (local.get $ws) (i32.const 8))))             ;; else block until done
      (call $tr (i32.const 0))))   ;; task.return(ok)

  (core instance $maini (instantiate $main
    (with "libc" (instance $libci))
    (with "h" (instance
      (export "read" (func $read-low))
      (export "write" (func $write-low))
      (export "task-return" (func $task-return))
      (export "ws-new" (func $ws-new))
      (export "ws-wait" (func $ws-wait))
      (export "w-join" (func $w-join))
      (export "fread" (func $fread))))))

  ;; Async lift WITHOUT a callback (stackful) — the core run() blocks on
  ;; waitable-set.wait while the host pumps the stream.
  (func $run-lifted (result (result))
    (canon lift (core func $maini "run") async (memory $mem)))
  (instance $ri (export "run" (func $run-lifted)))
  (export "wasi:cli/run@0.3.0-rc-2026-03-15" (instance $ri)))
