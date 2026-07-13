---
id: 3225
title: "standalone Array write-path sparse-array trap-safety (fill/reverse/copyWithin backing-grow)"
status: done
created: 2026-07-13
updated: 2026-07-13
completed: 2026-07-13
assignee: opus-writepath
priority: high
feasibility: hard
task_type: bug
area: codegen
es_edition: multi
language_feature: array-methods
goal: builtin-methods
sprint: 71
horizon: m
umbrella: 3185
parent: 3201
related: [3201, 3185, 3169]
loc-budget-allow:
  - src/codegen/array-methods.ts
origin: "2026-07-13 write-path tail of the #3201 sparse-array trap family (read family #2968→#2990 done)"
---

# #3225 — standalone Array write-path sparse-array trap-safety

The distinct, bigger tail of the #3201 sparse-array trap family. The **read**
family (indexOf/lastIndexOf/slice/concat/pop/splice/sort/includes) landed in
#2968→#2990 by CLAMPING copies/reads down to the physical WasmGC backing. The
**in-place WRITE/move** methods — `fill`, `reverse`, `copyWithin` — cannot
clamp: they must land a write at every index up to the LOGICAL `.length`, so
on a sparse array (logical `.length` set beyond the backing via the
`a.length = N` setter) they index `data[i]` past `array.len(data)` and TRAP
("array element access out of bounds"), an uncatchable Wasm abort (#3185 §4
trap-first mandate).

## Mechanism (distinct from the read family — GROW, not clamp)

A vec is `struct { 0: length i32, 1: data (ref $arr) }`. Index-writes and
`push` already grow the backing to the needed capacity
(`array.new_default` + `array.copy` + `struct.set` field 1); sparse arrays
arise only via the `a.length = N` setter, which bumps field 0 without growing
the backing.

New shared helper **`emitEnsureBackingCapacity(vecLocal, dataLocal, …,
neededLenLocal)`** (in `array-methods.ts`) reuses that canonical grow shape: when
`array.len(data) < needed` it reallocates the backing to `needed`, copies the
in-backing prefix, writes it back into the vec, and re-points the caller's
`dataLocal`. Grow-only (never shrinks); a dense receiver is a runtime no-op.

Applied at three sites, **`ctx.standalone`/`ctx.wasi`-gated** so the host/gc
lane emits byte-identical code (the grow branch isn't emitted there at all):

- **fill** — grow to the clamped `end` (§23.3.3.7 fill writes its range
  unconditionally, no HasProperty guard ⇒ grow-then-write is spec-exact).
- **reverse** — grow to the logical length (`j + 1`) so the two-pointer swap
  reaches both ends.
- **copyWithin** — grow to the logical length (target/start/end are all clamped
  to `len`, so `target+count ≤ len` and `start+count ≤ len`).

The freshly-allocated tail is default-initialised (0/null): `fill` overwrites
its range; `reverse`/`copyWithin` move those defaults. The residual
undefined-vs-null hole fidelity for externref sparse arrays matches the read
family's precedent and the #2106 conflation — out of scope here; the trap-first
mandate is to eliminate the abort.

**Out of scope** (documented follow-ups): huge sparse-index WRITES
(`arr[2**32-2] = v` — the index-write path, whose i32 length field can't even
hold the index; the dominant remaining trap cause per #3201), and flat/flatMap
(feature gap #2717, refuse-not-trap).

## Acceptance criteria

1. `fill` / `reverse` / `copyWithin` on a sparse array → no Wasm trap
   (standalone). ✓
2. Dense arrays byte-identical on host/gc (gate); dense standalone unaffected
   (never-taken branch). ✓
3. Dedicated tests + zero standalone-floor regression. ✓
   (`tests/issue-3201-writepath.test.ts` 11/11; the array-capacity /
   fast-arrays / array-oob pre-existing fails are present identically on clean
   `origin/main`.)

## Result

Native WasmGC backing-grow makes the standalone write-path family trap-safe.
`emitEnsureBackingCapacity` is the write-side mirror of the read family's
`emitBackingClampedCopyLen`.
