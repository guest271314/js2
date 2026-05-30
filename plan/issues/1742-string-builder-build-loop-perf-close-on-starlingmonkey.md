---
id: 1742
title: "string-builder build-loop perf: close the remaining gap on StarlingMonkey / the JS lane"
status: ready
created: 2026-05-30
priority: medium
feasibility: hard
reasoning_effort: high
task_type: performance
area: codegen
language_feature: strings
goal: performance
sprint: Backlog
related: [1580, 1210, 1175, 1588]
origin: carved from #1580 — the hash-loop allocation was fixed there; this is the residual build-loop cost
---
# #1742 — string-builder build-loop perf: close on StarlingMonkey / the JS lane

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

For a 20k-iteration build that's ~60k single-char `$NativeString`
allocations + ~60k `__str_flatten` calls + the doubling `array.copy` churn.
The opt3 WAT confirms the build loop still contains `array.copy` /
`array.new_default` / `struct.new` that wasm-opt cannot fully eliminate
(unlike the hash loop, which collapsed to pure `array.get_u`).

## Likely high-value levers (for the architect / dev)

1. **`s.charAt(i)` → direct i16 append without a `$NativeString` box.**
   When the result of `charAt`/`charCodeAt` flows straight into a `+=` on a
   string-builder, we can append the single code unit to the buffer with one
   `array.set` + `len++`, skipping the 1-char `$NativeString` allocation and
   the `__str_flatten` round-trip entirely. This is the biggest win — it
   removes ~60k allocations + ~60k flatten calls from the hot build loop.
2. **Literal append fast-path.** `text += ";"` appends a known 1-char ASCII
   literal — emit a direct `array.set` of the constant code unit, no
   `$NativeString` materialization of the literal at all.
3. **Amortized growth audit.** Confirm `__str_buf_next_cap` is true geometric
   doubling and the `array.copy` on grow is not happening more than
   O(log n) times; check whether the initial capacity (16) forces early
   regrowth for a 40k-char result.
4. **Escape analysis (#747 / #1587 ownership lattice).** The intermediate
   1-char `$NativeString`s from `charAt` never escape; the ownership analysis
   could mark them stack/scratch and let codegen skip the heap allocation.

## Acceptance criteria

- [ ] `string-hash` warm drops meaningfully below StarlingMonkey's 14.2 ms on
      a clean wasmtime host (target: ≤ ~10 ms, i.e. genuinely beat the engine
      lane, not just the lenient 30 ms gate). State the measured number.
- [ ] The build loop no longer allocates a `$NativeString` per `charAt` /
      per literal append (verify in the opt3 WAT: no `struct.new
      $NativeString` inside the build loop; appends are `array.set` + `len`
      bump).
- [ ] No regression to the #1580 hash-loop shape (the guard in
      `tests/issue-1580.test.ts` stays green).
- [ ] `benchmarks/results/wasm-host-wasmtime-hot-runtime.json` refreshed on a
      clean wasmtime host with the new measured number + provenance.

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
