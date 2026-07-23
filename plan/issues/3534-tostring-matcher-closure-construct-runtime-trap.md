---
id: 3534
title: "codegen: mutually-recursive const-closure funcref-cell RTT desync — matcher-invoking Function.prototype.toString files trap (illegal cast) at construct site"
status: ready
sprint: current
created: 2026-07-22
updated: 2026-07-22
priority: medium
horizon: l
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen
language_feature: closures
goal: correctness
related: [3024, 3533, 2873]
---

# #3534 — matcher-invoking `Function.prototype.toString` files trap at runtime (construct-site funcref-cell RTT desync)

## Context / provenance

Follow-up to **#3024 slice** `issue-3024-toString-closure-funcref` (the boxed-capture
CALL-site fix in `calls-closures.ts`). That slice eliminated the 68-file
`built-ins/Function/prototype/toString/*` invalid-Wasm cluster (CE → valid on both
gc and standalone lanes; +11 host passes on files whose `assert.sameValue("" + fn,
expected)` matches and never invoke the native matcher).

## Problem

Files that DO invoke the native matcher (`assert.sameValue` fails → `catch` →
`assertNativeFunction` → `validateNativeFunctionSource` → inner `eat`/`test`/…)
now **validate but trap at runtime**:

```
RuntimeError: illegal cast in __closure_41() at source L25
  (via __closure_53@L214 ← __module_init@L16)
```

`__closure_53` = `assertNativeFunction` (`const actual = "" + fn`, then
`validateNativeFunctionSource(actual)`); `__closure_41` =
`validateNativeFunctionSource`; the illegal cast is at its ENTRY (L25), where it
constructs its cross-referencing inner closures (`eat` captures `test`'s box, etc.).

**Verified NOT caused by the #3024 call-site fix:** even dev-serve's "valid"
reference layout (`validateNativeFunctionSource` + a direct call) validates but
traps identically — dev-serve's "VALID" rows only checked `WebAssembly.compile`,
never RAN the matcher. So NO layout currently runs the matcher correctly.

## Root cause (hypothesis, to confirm)

The `nativeFunctionMatcher` module-level `const` closures are mutually recursive.
They are boxed into ref cells that store a **bare funcref** (no environment
struct); their lifted self carriers are no-capture funcref-WRAPPER structs
`(struct (field funcref))`. This is a **funcref-wrapper RTT-identity** problem
(cf. #2873 star-topology: sibling `(struct (field funcref))` wrappers do NOT
merge under WasmGC isorecursive canonicalization, so `ref.cast` to a non-root
wrapper traps). The desync spans multiple sites:

- **call site** — fixed in #3024 (`compileClosureCall`, funcref cell → rebuild
  self carrier via `struct.new`).
- **construct site** — `validateNativeFunctionSource` building `eat`/`test` that
  cross-reference each other's funcref cells (the trap here).
- **value-read site** — likely the same family as the 34-file
  `class C { c = fn }` cluster (dev-serve owns that): a module-global
  closure-VALUE read reported `externref` but emitted `global.get <ref>` with no
  `extern.convert_any`.

## Suggested direction (architect-worthy)

Unify the closure funcref-cell representation so `boxed.valType`, the ref-cell
field-0 type, and the lifted self-carrier type AGREE — likely by storing the
closure STRUCT (or externref-boxed closure) in the cell rather than a bare
funcref, so no per-site reconstruction (and no RTT-sibling cast) is needed. A
single spec should cover the call / construct / value-read sites and the #2873
wrapper-root discrimination.

## Repro

```
[assert.js, sta.js, nativeFunctionMatcher.js, bound-function.js]  → validates, traps
```
or minimal:
```js
// nativeFunctionMatcher.js + :
validateNativeFunctionSource("function f() { [native code] }");  // validates, traps (illegal cast)
```

## Acceptance criteria

- Matcher-invoking `Function.prototype.toString` files run without trapping
  (`illegal cast`), reaching a genuine oracle pass/fail.
- No regression on the closure byte-inert corpus or the standalone floor.

---

## Unified closure-value representation — design plan (sr-3024, 2026-07-22)

Owner-drafted per lead request (verify-first understanding beats a cold architect
re-derivation). Covers the whole **closure-value representation desync FAMILY**,
folding in the two sibling clusters.

### The family: one root, three sites

A *closure value* (an arrow/function-expression bound to a `const`/module global
and later read, called, or stored) has **no single canonical wasm
representation**. Different emit sites assume different types, and phase-ordering
(the binding is DECLARED before its closure type is known, then RETRO-narrowed)
breaks already-emitted reads. Three confirmed instances:

| # | site | symptom | mechanism |
|---|------|---------|-----------|
| **#3024** (LANDED, call) | `compileClosureCall` boxed-capture branch | `any.convert_extern` on a funcref → invalid Wasm | ref cell field-0 is `funcref`; `boxed.valType` stale-reads `externref`; self carrier is a no-capture funcref-WRAPPER `(struct (field funcref))` |
| **#3534** (construct) | `validateNativeFunctionSource` building cross-referencing inner closures | runtime `illegal cast` | funcref-WRAPPER RTT star-topology (#2873): sibling `(struct (field funcref))` wrappers do NOT merge under isorecursive canonicalization, so `ref.cast` to a non-root wrapper traps |
| **#3533** (value-read, dev-serve) | `class C { c = fn }` field init reads `$__mod_<name>` | `struct.set expected externref, found global.get of (ref null N)` → invalid Wasm | `$__mod_<name>` global DECLARED `externref` (type unknown at decl), then `__module_init` NARROWS it `externref → (ref null N)`, retroactively invalidating the already-emitted `global.get` |

**The `$__mod_<name>` global is SHARED** (dev-serve, verified): read by BOTH
value-reads (want `externref`) AND `fn()` calls via `compileClosureCall` (want a
raw ref / funcref). So **no value-read-only fix exists** — any type/store change
at the global touches the call read. This is why #3533 is `blocked-on` this plan
and why the sites cannot be fixed in isolation at the value-read/call boundary.

### Root invariant to restore

The closure binding's wasm type must be **stable and knowable across decl →
`__module_init`(store/construct) → read/call phases**, with a representation ALL
consumers agree on. Two ways to get there:

### Option (a) — Uniform `externref` boxed representation (RECOMMENDED)

Keep every closure-VALUE binding (`$__mod_<name>` global, boxed ref cell)
**`externref` for its whole lifetime — never narrow**. On store, box the closure
struct with `extern.convert_any`. Consumers:
- **value-read** → the `externref` global.get is valid as-emitted; the retro-narrow
  that caused #3533 is simply removed. ✔
- **call** → route through the EXISTING externref arm of `compileClosureCall`
  (`localType?.kind === "externref"` / module-global externref branch,
  `any.convert_extern` + guarded `ref.cast` to the self struct). The value is a
  boxed **struct** (not a bare funcref), so the guarded ref.cast is valid — this
  **supersedes the #3024 funcref-cell stopgap** (a boxed struct never takes the
  new `struct.new` branch). ✔
- **construct** → inner closures cross-reference via `externref`, sidestepping the
  #2873 funcref-wrapper RTT star-topology entirely (no sibling-wrapper `ref.cast`).
  Likely resolves #3534 as a side effect. ✔ (verify)

**Blast radius / risk (HIGH — core closure representation):**
- Perf: extra `extern.convert_any`/`any.convert_extern` round-trips + guarded casts
  on closure-value reads/calls that previously used a precise ref. Measure on the
  playground benchmark sidebar; likely negligible (these are cold config/harness
  paths, not hot loops), but must be measured.
- Correctness regression surface: any site that RELIES on the narrowed precise
  ref type of `$__mod_<name>` (e.g. a direct `struct.get` on the closure struct
  without a guarded cast, or a `call_ref` that assumed the non-null precise self).
  These would need the externref→struct guarded cast inserted. **Measurement step
  REQUIRED before code:** harvest currently-PASSING closure-heavy tests
  (module-const arrows, mutual recursion, HOFs, callbacks-in-arrays, closures
  stored in class fields / objects) and confirm byte-inert OR quantify the delta.
- Standalone lane: `extern.convert_any`/`any.convert_extern` exist in both lanes;
  re-check the standalone floor (the payoff was framed as standalone flips).

### Option (b) — Precise stable struct representation

Forward-declare each closure binding's struct type at DECL time (before
`__module_init`), so the global is `(ref null $closureStruct)` from the start (no
retro-narrow), and make the funcref-wrapper RTT #2873-consistent (cast to the
wrapper ROOT via `getFuncRefWrapperRootTypeIdx`, discriminate on the funcref's
exact type — the landed #2873 pattern).

**Blast radius / risk (HIGHER):** requires (i) knowing the closure struct type at
decl — a type-index phase-ordering problem (the struct is minted during closure
compilation, AFTER the binding decl); (ii) the full #2873 root-discrimination at
every construct/call site; (iii) value-reads must then BOX the precise ref to
externref at each `externref`-typed sink (the inverse of today's bug). More
moving parts, more type-index-shift hazards (cf. `reference_subview_type_idx_stability`,
`project_type_index_shift_and_deadelim`), for a perf win on cold paths.

### Recommendation

**Option (a).** The desync is fundamentally that the binding is type-erased at
decl then retro-typed; keeping it type-erased (`externref`) for its lifetime is
the minimal, phase-order-safe invariant, reuses existing externref call/read
arms, and supersedes the #3024 stopgap cleanly. Option (b) chases a cold-path perf
win at materially higher type-index-shift risk. Take (a); revisit (b) only if
measurement shows a real hot-path regression.

### Decomposition (option a) — reviewable, full-CI-validated steps

1. **Measure-first (no src):** harvest the currently-PASSING closure-value corpus
   (module-const arrows, mutual recursion, HOFs, array/object/class-field-stored
   closures) + the #3024/#3533 repros; snapshot sha256 + pass set. Defines the
   byte-inert/blast-radius baseline.
2. **Stop the retro-narrow (#3533 core):** keep `$__mod_<name>` closure globals
   `externref`; box on store (`extern.convert_any`). Insert externref→struct
   guarded casts at any precise-ref consumer the measurement flags. Validate: #3533
   value-read CE→valid; #3024 still valid; corpus byte-inert or measured delta.
3. **Route calls through the externref arm:** ensure `compileClosureCall` on an
   externref closure global/cell takes the guarded-struct-cast path; remove the
   #3024 funcref-cell `struct.new` stopgap once it's provably dead (the cell is no
   longer funcref-typed).
4. **Construct site (#3534):** re-run the matcher oracle; if the boxed-externref
   inner-closure cross-references clear the illegal cast, done; else apply the
   #2873 wrapper-ROOT discrimination locally.
5. **Full-CI + standalone floor** each step; playground perf diff on step 2/3.

### Scope call

This touches **core closure representation** (highest-risk subsystem) across 3
sites + 2 sibling issues, needs a measurement gate, and is **multi-PR** — it
exceeds a clean single session. Recommendation to lead: I can OWN it as the
serialized step-list above (each step its own full-CI PR), but given the
core-representation risk a **design partner / architect review on step 2's
consumer-cast audit** would de-risk it. Not a one-shot. #3533 stays `blocked-on`
this until step 2 lands.
