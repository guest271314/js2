;; #2658 B0 spike — minimal native WASI Preview 3 (0.3) ASYNC command component.
;;
;; This is the RUNNABLE P3 proof: a hand-authored component that exports
;; `wasi:cli/run@0.3.0-rc-2026-03-15` as an ASYNC-lifted `run`, exercising the
;; component-model async canonical ABI (async lift + callback + `task.return`).
;; It does NOT touch streams — it proves the P3 async *runtime target* works on
;; this box before the stream/future producer machinery (the deferred B2/B3
;; epic) is built. See ./README.md and ../../../plan/issues/2658-*.md.
;;
;; Build + run (see run-p3-b0.sh):
;;   jco parse run-async.wat -o run-async.wasm
;;   wasmtime run -W component-model-async=y -S p3=y run-async.wasm   # -> exit 0
;;
;; The world id is the EXACT version wasmtime 44 hosts: 0.3.0-rc-2026-03-15
;; (NOT the final 0.3.0). `run: async func() -> result`.
(component
  ;; The async-lifted core `run`:
  ;;   * calls `task.return` with the result (`ok` = discriminant 0), then
  ;;   * returns the async status code 0 = EXIT (task complete, no waiting).
  ;; `cb` is the callback the host scheduler would resume on a wait event; here
  ;; the task completes synchronously so it is never invoked.
  (core module $m
    (import "" "task-return" (func $tr (param i32)))
    (func (export "run") (result i32)
      (call $tr (i32.const 0))   ;; task.return(ok)
      (i32.const 0))             ;; async status: 0 = EXIT (done)
    (func (export "cb") (param i32 i32 i32) (result i32) (i32.const 0)))

  ;; `task.return` for `result` (unit ok/err) takes the discriminant as one i32.
  (core func $tr (canon task.return (result (result))))
  (core instance $i
    (instantiate $m (with "" (instance (export "task-return" (func $tr))))))
  (alias core export $i "cb" (core func $cb))

  ;; Async lift WITH a callback. (memory is unnecessary for the unit result.)
  (func $run (result (result))
    (canon lift (core func $i "run") async (callback $cb)))
  (instance $runinst (export "run" (func $run)))
  (export "wasi:cli/run@0.3.0-rc-2026-03-15" (instance $runinst)))
