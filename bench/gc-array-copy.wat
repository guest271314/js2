(module
  ;; Minimal repro (#1895): copy N bytes three ways, measure each.
  ;;   1) native array.copy on an i8 WasmGC array
  ;;   2) element loop (array.get_u / array.set)
  ;;   3) linear memory.copy (the baseline #1886 moves toward)
  ;;
  ;; Two ways to drive it:
  ;;   - Node/V8: call alloc(N) once, then time each bench_*(rounds) (see run-node.mjs).
  ;;   - wasmtime CLI: call a self-contained run_*(N, rounds) (alloc + loop) so a
  ;;     single --invoke does everything, e.g.:
  ;;       time wasmtime -W all-proposals=y --invoke 'run_arraycopy 16777216 1' gc-array-copy.wasm
  ;; N <= 32 MiB so src+dst also fit in the 64 MiB linear memory.
  (type $bytes (array (mut i8)))

  ;; 64 MiB linear memory (1024 * 64 KiB) — holds src [0,N) and dst [N,2N).
  (memory (export "mem") 1024)

  (global $src (mut (ref null $bytes)) (ref.null $bytes))
  (global $dst (mut (ref null $bytes)) (ref.null $bytes))
  (global $n   (mut i32) (i32.const 0))

  (func $alloc (export "alloc") (param $size i32)
    (global.set $n   (local.get $size))
    (global.set $src (array.new_default $bytes (local.get $size)))
    (global.set $dst (array.new_default $bytes (local.get $size))))

  ;; R rounds of native array.copy(dst[0..], src[0..], n)
  (func $bench_arraycopy (export "bench_arraycopy") (param $rounds i32)
    (loop $r
      (array.copy $bytes $bytes
        (ref.as_non_null (global.get $dst)) (i32.const 0)
        (ref.as_non_null (global.get $src)) (i32.const 0)
        (global.get $n))
      (local.set $rounds (i32.sub (local.get $rounds) (i32.const 1)))
      (br_if $r (local.get $rounds))))

  ;; R rounds of element-by-element GC copy
  (func $bench_elemloop (export "bench_elemloop") (param $rounds i32)
    (local $i i32)
    (loop $r
      (local.set $i (i32.const 0))
      (block $done
        (loop $c
          (br_if $done (i32.ge_u (local.get $i) (global.get $n)))
          (array.set $bytes (ref.as_non_null (global.get $dst)) (local.get $i)
            (array.get_u $bytes (ref.as_non_null (global.get $src)) (local.get $i)))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $c)))
      (local.set $rounds (i32.sub (local.get $rounds) (i32.const 1)))
      (br_if $r (local.get $rounds))))

  ;; R rounds of linear memory.copy: src=[0,N) -> dst=[N,2N) (non-overlapping)
  (func $bench_memcopy (export "bench_memcopy") (param $rounds i32)
    (loop $r
      (memory.copy (global.get $n) (i32.const 0) (global.get $n))
      (local.set $rounds (i32.sub (local.get $rounds) (i32.const 1)))
      (br_if $r (local.get $rounds))))

  ;; Self-contained drivers for `wasmtime --invoke` (alloc + R rounds in one call).
  (func (export "run_arraycopy") (param $size i32) (param $rounds i32)
    (call $alloc (local.get $size)) (call $bench_arraycopy (local.get $rounds)))
  (func (export "run_elemloop") (param $size i32) (param $rounds i32)
    (call $alloc (local.get $size)) (call $bench_elemloop (local.get $rounds)))
  (func (export "run_memcopy") (param $size i32) (param $rounds i32)
    (call $alloc (local.get $size)) (call $bench_memcopy (local.get $rounds)))
)
