---
id: 2641
title: "Native-string finalize-shift emits invalid Wasm for a class method using __str_concat/__str_fromCharCode under --target wasi (with deferred WASI helpers)"
status: done
completed: 2026-06-24
created: 2026-06-24
updated: 2026-06-24
priority: high
feasibility: hard
reasoning_effort: high
task_type: bug
area: codegen
language_feature: native-strings
goal: standalone
sprint: 65
related: [2632, 1677, 1903, 2039, 2563, 1690]
origin: "Surfaced by #2632 Phase 3 (process.stdin Readable): a string/Buffer-chunk Readable class blocks on this; CONFIRMED pre-existing on origin/main with zero Phase-3 code."
---
# #2641 — native-string finalize-shift × deferred WASI helpers × class-method body → invalid Wasm

## Problem

A class whose **method** builds a native string via the native-string helpers
(`__str_concat` / `__str_fromCharCode`) and stores the result into a field of a
**class-struct-typed** local/field, compiled with **`--target wasi`** (which
registers the deferred WASI helper set — timer min-heap / reactor / stdin
drain via `emitDeferredWasiHelpers`), emits **invalid Wasm**:

```
global.set expected (ref null <class struct>), found call of (ref null <string-tree>)
```

i.e. a `global.set` (or field/local set) targeting a class-struct ref type
receives a value typed as the native-string tree type — a type mismatch baked
into the emitted module. The identical class using `number[]` chunks instead of
string chunks compiles to **valid** Wasm, isolating the fault to the
native-string path, not the class/method machinery itself.

## CONFIRMED pre-existing (not introduced by #2632 Phase 3)

Reproduced on **clean `origin/main` with ZERO Phase-3 code** — a timer-driven,
Phase-2-only program. So this is a latent codegen bug that the #2632 Phase-3
faithful `process.stdin` library (string/Buffer chunks) is the first consumer to
trip. Phase 3 stopped here rather than auto-injecting a string-based prelude that
would emit invalid Wasm for many user programs.

## Suspected root cause (for architect confirmation)

> **ARCHITECT NOTE (2026-06-24): the suspicion below is REFUTED.** It is not a
> finalize-shift / deferred-WASI-helper index desync, and not WASI-specific. The
> real cause is a lexical-shadowing bug (a function-local that collides with a
> same-named module variable is never given a Wasm local). See
> `## Implementation Plan`. The original text is kept for history.

The native-string **finalize-shift** family — `reconcileNativeStrFinalizeShift`
and relatives (#1677 / #1903 / #2039 / #2563) — rewrites/repoints indices when
native-string helpers are materialized late. Interaction with
`emitDeferredWasiHelpers` (which itself registers late helpers/types for the
timer-heap + reactor under `--target wasi`) appears to desync a type index or a
helper return-type so that a `*.set` against a class-struct ref ends up fed by a
string-tree-typed producer. This is the compiler's most fragile index-shift
area; a localized band-aid carries high regression risk — needs a root-cause,
not a patch.

## Acceptance

- A minimal repro in `.tmp/` (string-field class method → invalid Wasm) plus a
  valid control, with the exact validator error. **(done — see artifacts below)**
- Root cause identified. **(done — variable-scope collision, see plan)**
- Fix emits valid Wasm for the class method (+ constructor + generator method)
  with **zero test262 regression** (verify IN BATCH + `runTest262File`, per
  #1968 — isolated byte-diff is a false negative here).
- Unblocks #2632 Phase 3's faithful string/Buffer `process.stdin` `Readable`
  library (auto-injected prelude + `read([size])`).

## Out of scope

- The #2632 Phase-3 **substrate** (reactor↔stream wiring + intrinsics + byte
  `Readable`) — that is byte-neutral / zero-regression and lands independently.
- Async/event-loop semantics (already covered by #2632 P1/P2).

---

## Implementation Plan

### TL;DR — the suspected cause is REFUTED; the real bug is a variable-scope collision

This is **NOT** a native-string finalize-shift / `emitDeferredWasiHelpers` index
desync. The finalize-shift machinery is innocent. The deferred-WASI-helper set
is **not** the trigger. The real root cause is a **lexical-shadowing bug**: a
function-local `let`/`const` whose name matches a **module-level variable** is
never allocated a Wasm local, so every read/write of it falls through to the
**module global** of the same name. Under native strings the type mismatch
(string-tree value → class-struct global) surfaces as invalid Wasm; with
matching types it **silently corrupts the module variable** (a latent
miscompilation — see "Wider impact").

It reproduces on **every target** (`wasi`, `standalone`, AND default `gc`/JS-host
— so it is target-independent), and is fully independent of WASI deferred
helpers, timers, and the reactor.

### Root cause (verified by IR inspection + binary disassembly)

For the minimal repro (a class method's local `let s = ""` building a string via
`s += String.fromCharCode(b)`, with a module-level `const s = get()` typed as the
class struct), the emitted `R_build` contains:

```wat
;; s += ... lowered AGAINST the module global __mod_s (type ref null $R), not a local:
(global.set $__mod_s              ;; declared (mut (ref null $R))  ← class struct
  (call $__str_concat ...))       ;; returns ref $AnyString        ← string tree
```

→ `global.set expected (ref null <R>), found call of (ref null <AnyString>)`.

Instrumentation of `compileNativeStringCompoundAssignment` confirmed: in
`R_build`, `fctx.localMap` = `[this, __tmp_0, b]` — **`s` is absent**. The `+=`
site therefore resolves `s` to `ctx.moduleGlobals.get("s")` (the module global).
Both maps key `s`; precedence is "local first", but the local was never created,
so the module global wins.

Two independent defects together cause `s` to never get a local:

1. **`src/codegen/index.ts` — `walkStmtForLetConst` (~line 13600).**
   The let/const hoister skips allocating a local for any name that collides with
   a module global:
   ```ts
   if (fctx.localMap.has(name)) continue;
   if (ctx.moduleGlobals.has(name)) continue;   // ← BUG: suppresses lexical shadowing
   ```
   This `continue` has no rationale comment and predates #1690b (which fixed the
   *store-site* shadowing in `compileVariableStatement` but RELIES on the hoister
   having pre-allocated the shadowing local — a contract this line breaks). The
   hoister runs only for real function bodies (via `function-body.ts`
   `hoistLetConstWithTdz`), never for `__module_init`, so this skip serves no
   legitimate purpose — top-level `let s` becomes the module global through a
   different path regardless.

2. **`src/codegen/class-bodies.ts` — class method / constructor / generator-method
   body compilation does NOT hoist at all.** The non-generator instance/static
   method path (`} else if (member.body) { for (const stmt of member.body.statements) compileStatement(...) }`,
   ~line 2178), the constructor path (`for (const stmt of ctor.body.statements)`,
   ~line 1779 — and the duplicate at ~635), and the generator-method path
   (~line 2144) all compile statements **without** calling
   `hoistVarDeclarations` / `hoistLetConstWithTdz` first. Free functions DO
   (`function-body.ts` ~lines 1052-1053 / 1122-1125). So in a class method a
   `let s` is created lazily by `compileVariableStatement`, whose #1690b
   `hasLocalShadow = fctx.localMap.has(name)` check is `false` (no hoist ran),
   so the decl-init stores into the **module global** and never mints a local.

Both must be fixed: defect (2) is why **class methods/constructors** trip it
(the #2641 symptom); defect (1) is why **free functions** silently alias a
same-named module variable. Fixing only one is insufficient — verified: with the
method-hoist added but line 13600 left in place, the hoist itself skips `s`
(because `moduleGlobals.has("s")`), and the invalid Wasm persists.

### Wider impact (this is a correctness bug, not just an invalid-Wasm bug)

With **matching** types the bug produces no validation error but **silently
corrupts** the module variable. Verified repro (default `gc` target):
```ts
function f(): number { let s = 0; s = 41; s = s + 1; return s; }
let s = 100;
// f() returns 42 (correct), but module `s` is clobbered to 42 (should stay 100)
```
Before fix: module `s` prints `42`. After fix: prints `100`. So the fix closes a
real miscompilation, not only the WASI/native-string invalid-Wasm manifestation.

### Changes

**File: `src/codegen/index.ts`** — function `walkStmtForLetConst` (~line 13600)
- **Remove** the `if (ctx.moduleGlobals.has(name)) continue;` line so a
  function-body let/const always gets its own local (proper lexical shadowing).
- Keep the preceding `if (fctx.localMap.has(name)) continue;` (idempotency).
- Invariant to preserve: this walker is invoked ONLY for real function bodies
  (free functions via `function-body.ts`, and — after the change below — class
  methods/ctors). `__module_init` does **not** run it, so top-level `let`/`const`
  remain module globals. Confirm with the top-level negative control below.

**File: `src/codegen/class-bodies.ts`** — add the missing hoist to every method /
constructor body-statement loop, mirroring `function-body.ts`:
- Import `hoistVarDeclarations, hoistLetConstWithTdz` from `./index.js`.
- **Non-generator instance/static method** path (`} else if (member.body) {`,
  ~line 2178): before the `for (const stmt of member.body.statements)` loop, call
  `hoistVarDeclarations(ctx, fctx, member.body.statements)` then
  `hoistLetConstWithTdz(ctx, fctx, member.body.statements)`.
- **Constructor** path (~line 1779; check the ~635 site too): hoist
  `ctor.body.statements` once before its statement loop. NOTE: the ctor loop also
  handles `super(...)` inlining — hoist BEFORE the loop, do not perturb the
  super-call handling.
- **Generator-method** path (~line 2144): hoist `member.body.statements` before
  the yield-collection statement loop (it already pushes a body via
  `pushBody`/`popBody`; hoist into the same `fctx` before the loop, matching the
  free-function generator path in `function-body.ts` ~1052).
- **#1210 string-builder parity (recommended, not strictly required for
  correctness):** free functions also run `detectStringBuilders` →
  `fctx.pendingStringBuilders` before hoisting (function-body.ts ~1104-1108) so
  `let s=""; loop s+=…` uses the in-place buffer fast path. Without it, class
  methods still emit CORRECT (now-local) code via the generic `__str_concat`
  path — just without the builder optimization. Add the detector call for parity
  if low-risk; otherwise file a follow-up. Gate it exactly as function-body.ts
  does: `if (ctx.nativeStrings && ctx.anyStrTypeIdx >= 0)`.

No change needed in `compileVariableStatement` (variables.ts) — its #1690b
`hasLocalShadow` store-into-local logic already does the right thing **once the
local exists** (it does, after the two changes above). No change needed in the
read path (`compileIdentifier`) or the `+=` paths — they already check
`localMap` before `moduleGlobals`.

### Wasm IR pattern (after fix)

```wat
(local $s (ref null $AnyString))      ;; minted by the hoist
;; s += ...
(local.get $s)
(call $__str_concat ... )
(local.tee $s)                         ;; writes the LOCAL, not the module global
```

### Edge cases to cover in tests
- Class **method** local shadowing a module var typed as a class struct (the
  #2641 invalid-Wasm case). Targets: wasi, standalone, gc — all must be VALID.
- Class **constructor** local shadowing (verified to reproduce: `R_init`).
- **Generator method** local shadowing (covered by adding the hoist there).
- **Static method** local shadowing.
- **Matching-type** silent-aliasing case (free function `let s` vs module `let s`
  both `number`) — assert the module var is NOT clobbered (correctness, not just
  validity).
- **Negative control**: module-level `let a; let b; a = a + b;` with NO function
  shadowing — module globals must still read/write correctly (top-level path
  unaffected). Verified after the index.ts change.
- **TDZ**: a shadowing `let`/`const` accessed before its decl inside the method
  must still throw ReferenceError (the hoist sets up TDZ flags — verify the
  added `hoistLetConstWithTdz` call preserves this, same as free functions).
- Nested blocks / loops inside the method (the hoister already recurses through
  blocks/if/loops/try — see `walkStmtForLetConst` recursion).

### Verification (MANDATORY — per #1968, isolated byte-diff is a FALSE NEGATIVE here)
- This touches the shared per-process hoist/scope path; validate **IN BATCH** and
  via `runTest262File`, not single-file byte-diff (memory
  `project_1917_coercion_engine_byte_diff_gate`).
- Run the full equivalence suite + a representative test262 batch covering
  classes, methods, constructors, generators, and let/const scoping. Watch the
  `dev-self-merge` bucket analysis for any class/scope path regressions.
- Expected **net-positive or byte-neutral**: programs with no
  function-local↔module-global name collision are unaffected (the hoister still
  skips already-present names; the only behavioral delta is when a real collision
  exists, where it now does the spec-correct thing). Confirm no broad byte-diff
  on collision-free programs.

### Repro artifacts (architect-distilled, in `.tmp/` of the diagnosis worktree
`/workspace/.claude/worktrees/agent-aa962886b10e2f6e4/.tmp/`)
- `min2641.ts` — minimal class-method string×struct invalid-Wasm repro (+ the
  `_renamed`/`_numvar` controls).
- `ctorbug.ts` — constructor variant (`R_init` invalid Wasm).
- `corrupt.ts` — matching-type silent-aliasing correctness repro.
- `freefn.ts` — free-function manifestation (valid-but-aliasing).
- The oversized `lib-min.ts` (the #2632 Phase-3 string `Readable`) reduces to
  `min2641.ts`; both go INVALID→VALID with the two-part fix.

### Validated fix (architect prototype — confirmed, then reverted)
Applying BOTH changes was prototyped and confirmed:
`min2641.ts` → VALID on wasi/standalone/gc; `lib-min.ts` → VALID;
`corrupt.ts` module `s` → correctly `100`; top-level `let a/b` → correct.
Sampled class test files (`class-method-struct-new`, `abstract-classes`, etc.)
showed **identical** pass/fail counts with and without the change (the few
failures there are pre-existing environment harness issues — same on clean
`origin/main`), i.e. no regression introduced.

## Test Results (implementation, 2026-06-24)

Both parts of the fix landed:
- `src/codegen/index.ts` `walkStmtForLetConst`: removed the
  `moduleGlobals.has(name) continue` skip (defect 1).
- `src/codegen/class-bodies.ts`: added `hoistVarDeclarations` +
  `hoistLetConstWithTdz` (+ the `#1210` `detectStringBuilders` parity gate,
  `if (ctx.nativeStrings && ctx.anyStrTypeIdx >= 0)`) before the
  **constructor**, **non-generator method**, **generator-method**, **getter**,
  and **setter** body loops (defect 2). The ctor field-collection scan at ~635
  is field-discovery only — left untouched.

New `tests/issue-2641.test.ts` (10 cases, all pass): class method / ctor /
generator method / static method shadowing → VALID (wasi + gc); free-function
and class-method matching-type silent-aliasing → module var NOT clobbered;
two negative controls (top-level `let a/b`; collision-free local); TDZ
shadowing read-before-decl throws (caught → -1, does not fall through to the
module global).

Repro confirmed on clean `origin/main`: `min2641.ts` (method) + `ctorbug.ts`
(ctor) INVALID `global.set`; after fix all → VALID. Batch validation per #1968:
the class/generator/scope batch and the `tdz-reference-error` /
`class-*` suites show **identical** pass/fail counts vs clean `origin/main`
(the failures there are pre-existing harness import-object issues —
`string_constants` / `__unbox_number` — not codegen). `issue-1690b` var-shadow
suite (8/8) and the IR fallback gate (all deltas 0) stay green. Net: +10
passing tests, 0 new failures.
