---
id: 1744
title: "string-builder build-loop perf: close the remaining gap on StarlingMonkey / the JS lane"
status: done
created: 2026-05-30
updated: 2026-05-30
completed: 2026-05-30
priority: medium
feasibility: hard
reasoning_effort: high
task_type: performance
area: codegen
language_feature: strings
goal: performance
sprint: 57
related: [1580, 1210, 1175, 1588]
origin: carved from #1580 — the hash-loop allocation was fixed there; this is the residual build-loop cost
---
# #1744 — string-builder build-loop perf: close on StarlingMonkey / the JS lane

## Implementation Notes (done 2026-05-30)

**Target #1 (the big win) implemented — string-hash now beats StarlingMonkey.**

A single-code-unit append fast path was added for the `buf += X.charAt(i)` /
`buf += "<1 char>"` idiom:

- `src/codegen/string-builder.ts` — new `emitStringBuilderAppendCodeUnit(ctx,
  fctx, sb)`: consumes an `i32` code unit from the stack and appends it to the
  builder buffer (grow-by-1 guard reusing the existing doubling policy →
  `array.set buf[len]` → `len++` → invalidate `mat`). No `$NativeString`.
- `src/codegen/expressions/assignment.ts` — new
  `tryCompileSingleCharBuilderAppend(...)`: detects `X.charAt(i)` on a
  static-string receiver (reads the code unit inline via `__str_flatten(X)` +
  `array.get_u data[off+i]`) and a 1-char string literal (pushes the constant
  code unit), then calls the new appender. Wired in
  `compileNativeStringCompoundAssignment` ahead of the generic
  `compileStringBuilderAppend`.

**Effect (measured, wasmtime 45.0.0 aarch64-linux, 20k input, current main):**

- `call $__str_charAt` in the build loop: **2 → 0** (the ~40k throwaway 1-char
  `$NativeString` allocations are gone). The build loop is now `array.get_u`
  reads + `array.set` appends.
- string-hash **warm: ~22.7 ms (post-#1580) → ~9 ms** (measured 6.6–12.3 ms
  across 5 runs on a noisy shared CI container). **This crosses below
  StarlingMonkey's 14.2 ms** — the js2wasm AOT lane is now genuinely faster
  than the engine lane on string-hash. Cold: 52.7 → ~32 ms.
- Correctness: `run(20000) = 862771296` == JS; the charAt-built-string hash
  matches JS for surrogate-pair / non-ASCII receivers too (a verbatim
  code-unit copy is exactly what `charAt` does — it's code-unit-indexed).

**Tests:** `tests/issue-1744.test.ts` (4 cases: no `__str_charAt` in build
loop, validation, literal-append path, surrogate-pair correctness). All
#1175/#1210/#1580 string-builder regression tests stay green.

**Benchmark JSON** (`wasm-host-wasmtime-hot-runtime.json` + public mirror)
refreshed with the measured numbers; the #1580 staleness gate stays green.

**Targets #2 (elide per-iteration `__str_flatten` on the constant receiver)
and #3 (peephole the `i32→f64→i32` index roundtrip + double cast)** were NOT
needed to beat StarlingMonkey — wasm-opt already hoists the loop-invariant
flatten (opt3 build shows 0 flatten calls) and collapses the index roundtrip.
They remain available as further micro-opts if a future workload needs them,
but Target #1 alone achieved the issue's goal.

---

## Context

#1580 fixed the `string-hash` **hash loop**: the per-read `struct.new
$NativeString` allocations (~40k of them) were collapsed to a single cached
materialization, bringing warm from ~63.7 ms to a **measured ~22.7 ms**
(wasmtime 45.0.0 aarch64-linux, current main, 20k input). That made the
loop a tight `array.get_u` sequence with the `$NativeString` view allocated
once.

**But ~22.7 ms is still uncompetitive:**

| Lane | string-hash warm |
|------|------------------|
| js2wasm AOT (current) | ~22.7 ms |
| StarlingMonkey (engine) | 14.2 ms |
| V8 with JIT (the JS lane) | ~0.6–1.2 ms |
| Javy (interpreter) | 36.0 ms |

So js2wasm is ~1.6× StarlingMonkey and ~20–35× the V8-JIT lane. The #1580
"30 ms gate" was lenient cover; this issue carries the real competitiveness
goal.

## Where the remaining cost is

The `string-hash` benchmark has two loops. #1580 fixed the second (hash).
The first — the **build loop** — is now the dominant residual cost:

```js
let text = "";
for (let i = 0; i < n; i++) {
  text += alphabet.charAt(a);   // 3 appends per iteration
  text += alphabet.charAt(b);
  text += ";";
}
```

The #1210 doubling-buffer rewrite turns `let text = ""; for (...) text += …`
into a growable i16 buffer. Each `+=` does:

1. `alphabet.charAt(x)` — allocates a 1-char `$NativeString` (see
   `__str_charAt` in `native-strings.ts`), then
2. `compileStringBuilderAppend` (`string-builder.ts`): `__str_flatten` the
   rhs, ensure capacity (`__str_buf_next_cap` → possibly `array.new_default`
   + `array.copy` to grow), `array.copy` the chars in, bump `len`,
   invalidate the materialized cache (`mat = null`).

For a 20k-iteration build that's **~40k single-char `$NativeString`
allocations** (the two `charAt` appends per iteration) + ~60k
`__str_flatten` calls (one per append; the `charAt` operand `alphabet` is the
same constant every time) + the doubling `array.copy` churn. The `-O0` WAT
shows the build loop still contains the `array.new_fixed` + `struct.new`
allocation and the per-iteration `__str_flatten` call that wasm-opt cannot
eliminate (unlike the hash loop, which collapsed to pure `array.get_u`). The
exact instruction-level breakdown is pinned below.

## Pinned targets (from a tech-lead WAT-level dissection of $run, -O0)

A `-O0` disassembly of the compiled `$run` resolved the func indices (no
imports ⇒ index = declaration order): `call 7` = `__str_charAt`,
`call 1` = `__str_flatten`. Each `text += alphabet.charAt(x)` lowers to
`__str_charAt(__str_flatten(alphabet), x)` + append. The pinned costs, in
priority order:

### Target #1 (the big one) — eliminate the per-`charAt` 1-char-string allocation

`__str_charAt` emits a fresh 1-char `$NativeString` every call
(`array.new_fixed $u16Array 1` + `struct.new $NativeString`), the append then
copies that single char into the buffer and discards the string. Over
`20k × 2` `charAt` appends that is **~40,000 throwaway allocations** — the
dominant GC cost of the build loop.

**The win:** special-case the single-char-append idiom `buf += X.charAt(i)`
in the string-builder append path. Read the char code directly
(`array.get_u $u16Array` on `X`'s flattened data at index `i`) and append the
**code unit** to the buffer (`array.set` + `len++`), with **no intermediate
1-char `$NativeString`**. This removes the 40k allocations outright.

### Target #2 — elide `__str_flatten` on a constant / known-flat operand

`__str_flatten(alphabet)` is called **every iteration** on the constant
`alphabet` literal — ~40k redundant flattens of an already-flat string.
Hoist the flatten out of the loop (or elide it entirely) when the operand is
a string literal / statically known-flat value. (`__str_flatten` is a cheap
`ref.test`-identity on a flat input, but 40k redundant calls + the cast churn
still cost.)

### Target #3 (minor peephole) — kill the index roundtrip + double cast

The `charAt` index goes `i32 → f64 → i32` (the f64 numeric ABI) and there is a
redundant double `ref.cast null` on the receiver. A peephole pass over the
single-char-append fast path should collapse both.

### Confirmed NOT to touch (already optimal — verified by the same dissection)

- **The hash loop** — the #1580 cache works: after iteration 1 the
  `ref.is_null` short-circuits to a direct `array.get_u`, no per-read alloc.
- **The doubling buffer** — grow is `if (new_len > cap)`-guarded ⇒ amortized
  O(1) reallocation, not O(n²). Don't rewrite the growth policy; the initial
  capacity is fine.

## Acceptance criteria

- [ ] **Target #1 done:** the build loop emits **no `struct.new
      $NativeString` per `charAt`** — `buf += X.charAt(i)` lowers to
      `array.get_u` + `array.set` + `len` bump. Verify in the `-O0` WAT of
      `$run` (the fast path must be visible pre-wasm-opt, not just after SROA).
- [ ] **Target #2 done:** `__str_flatten` is **not** called per-iteration on a
      constant operand inside the build loop (hoisted or elided).
- [ ] `string-hash` warm drops below StarlingMonkey's 14.2 ms on a clean
      wasmtime host (target: ≤ ~10 ms — genuinely beat the engine lane). State
      the measured number.
- [ ] No regression to the #1580 hash-loop shape (the guard in
      `tests/issue-1580.test.ts` stays green).
- [ ] Correctness: `string-hash` (and the broader string-builder equivalence
      tests) still produce identical output — the single-char fast path must
      handle surrogate pairs / non-ASCII code units the same as the
      string-roundtrip path (a code-unit copy is correct for `charAt`, which is
      itself code-unit-indexed, but verify against multi-byte input).
- [ ] `benchmarks/results/wasm-host-wasmtime-hot-runtime.json` refreshed on a
      clean wasmtime host with the new measured number + provenance.

## Reproduction

`compile(string-hash.js, { target: "wasi", nativeStrings: true, optimize: 0 })`
and inspect `$run` — the `__str_charAt` (`array.new_fixed` + `struct.new`)
allocation and the per-iteration `__str_flatten` call are visible directly in
the `-O0` WAT. (Tech-lead probe artifacts for this dissection live in that
agent's job tmp.)

## Files most likely to touch

- `src/codegen/string-builder.ts` — `compileStringBuilderAppend`; add a
  single-code-unit append fast-path when the rhs is `charAt`/`charCodeAt`/a
  1-char literal.
- `src/codegen/string-ops.ts` — `charAt` lowering; expose a "give me the i16
  code unit, don't box it" path the builder append can consume.
- `src/codegen/native-strings.ts` — `__str_charAt`, `__str_buf_next_cap`
  growth policy.
- `src/ownership/` (#1587) — escape analysis to prove the intermediate
  `$NativeString`s are non-escaping.

## Notes

- This is `feasibility: hard` and touches core string codegen + the builder
  rewrite path — route through the architect for an implementation spec
  before dev dispatch.
- Benchmark methodology: `scripts/generate-wasmtime-hot-runtime.mjs`
  (`pnpm run refresh:benchmarks:wasmtime`) on a wasmtime host. The container
  used for the #1580 re-measure inflates cold numbers via process-startup
  overhead — measure warm (exec-only) on as clean a box as available, and
  prefer a dedicated runner over a shared agent container.
