---
id: 1901
title: "Standalone __extern_get string-key read on a closed-struct/$Vec-backed externref returns 0 (untyped-param object reads)"
status: done
created: 2026-06-05
updated: 2026-06-05
completed: 2026-06-05
priority: high
feasibility: medium
task_type: bugfix
area: codegen+runtime
language_feature: object-member-access
goal: standalone-mode
sprint: 61
---
# #1901 — closed-struct → externref string-key member read returns 0 (the post-S2 plateau-breaker)

## Symptom (dev-iter harvest 2026-06-05 + sd-s2 recon)

Under `--target standalone` / `--target wasi`, reading a **string** property off an
`externref` whose underlying value is a **compiled closed-struct object literal**
(or a `$Vec`) returns `0` / produces **invalid Wasm**:

```ts
function g(o: any): number { return o.x; }
export function test(): number { return g({ x: 9 }); }   // → 0 (want 9); module is invalid
```

Pervasive: **every untyped-param object argument** (`function f(o:any){return o.x}`
called with an object literal). ~1,072 direct standalone fails (dev-iter session
tracker "#130"), unifying with the ToPrimitive-on-objects cluster ("#124", ~1,228)
— same root → **≈2,300+ DIRECT pass-per-fix**. This is the dominant post-S2
standalone plateau cause.

## Root cause (sd-s2 recon, verified against 996815a05)

Two compounding defects at the closed-struct → `externref` boundary:

1. **The native object runtime is never emitted for a closed-struct-only program.**
   `ensureObjectRuntime(ctx)` (object-runtime.ts) — which registers the native
   `__extern_get` / `__extern_set` / `$Object` type — is **not** triggered by the
   closed-struct→`any` member-read path (it's only triggered by open-object /
   computed-key literal construction). So `o.x` on an `any` whose value is a closed
   struct calls `ensureLateImport(ctx, "__extern_get", …)`, which under standalone
   routes to the *native* helper **only if it was registered** — but it wasn't, so
   the `env::__extern_get` import is left **unbound → the module fails validation**
   (`valid=false`).

2. **Even when the runtime IS emitted, `__extern_get` can't read a closed struct.**
   Its native arm does `any.convert_extern` → `ref.test $Object` → walk the
   `$Object` open-hash-map. A closed-struct object literal is a **distinct closed
   struct type**, NOT a `$Object`, so the `ref.test $Object` fails and the read
   returns the undefined sentinel (0 in a numeric context).

### Recon evidence (compile-level, `target:wasi`)

| program | emits | valid | result |
| --- | --- | --- | --- |
| `g({x:9}).x` (closed-struct→any) | `env::__extern_get` | **false** | 0 / invalid |
| `const o:any={x:9}; o.x` | `env::__extern_get` | **false** | 0 / invalid |
| `first([10,20])` (array→any, idx read) | `__extern_get` (native) | true | works (via `__extern_get_idx`) |
| open-object computed-key `o[k]=9; o.x` | `__extern_get`+`__extern_set` (native) | true | works (via `$Object`) |
| `({valueOf(){return 7}}) + 0` (#124 sibling) | — | — | **NaN** (ToPrimitive can't read valueOf off the boxed closed struct) |

So the array path (`__extern_get_idx`) and the open-object path (`$Object`) both
already work standalone; the gap is exactly the **closed-struct object literal
coerced to externref, then read by string key**, plus its ToPrimitive sibling
(#124: `valueOf`/`toString` read off the same boxed closed struct).

## Fix shapes (decide in impl)

- **(A) Box closed-struct → `$Object` at the externref boundary.** When a closed
  struct is coerced to `externref` (the `extern.convert_any` site in
  type-coercion.ts) under standalone, first materialise a `$Object` carrying the
  same fields (so any downstream `__extern_get`/`__extern_method_call`/ToPrimitive
  reads it natively). Forces `ensureObjectRuntime`; uniform — one boundary fix
  feeds every reader (get, method-call, ToPrimitive). Cost: an alloc + field copy
  per coercion.
- **(B) Teach `__extern_get`/`__extern_method_call` to read struct/$Vec-backed
  externrefs.** Add a `ref.test`-chain arm over the registered closed-struct types
  (mirroring the `$Vec` arm pattern from #6407's spec) that does `struct.get fieldIdx`
  by a compile-time key→field-index map. No per-coercion alloc, but needs a
  per-struct-type field-name table threaded to the runtime, and must also force
  `ensureObjectRuntime`. Larger runtime surface; closer to zero-copy.

Recon leans (A) for uniformity (one fix covers get + method-call + ToPrimitive, the
#124 unification) — confirm during impl. Either way **must trigger
`ensureObjectRuntime` on the closed-struct→externref coercion** so defect 1 is
fixed regardless of which read path runs.

### Chosen fix (sd-s2 2026-06-05): (A-narrowed) route any-context object literal to `$Object` at construction

The closed-struct literal **knows at compile time** when it flows into an
`any`/`externref`/`object` contextual type (the untyped-param-arg case is exactly
this). So rather than box at the `extern.convert_any` coercion (which would need a
struct→`$Object` field-copy helper), route the literal to the `$Object` path **at
construction** when its contextual type is non-specific:

- **Site**: `compileObjectLiteral` (literals.ts:573). Today only an **empty** `{}`
  in an any-context routes to `__new_plain_object` (:614-632). Extend that to a
  **non-empty named-prop** literal in an any-context: emit `__new_plain_object`
  then, per `PropertyAssignment`/`ShorthandPropertyAssignment`, compile the value,
  coerce to externref, and `__extern_set(obj, "<key>", value)`. This is the
  `$Object` the existing native `__extern_get` / `__extern_method_call` / ToPrimitive
  all already read — zero new read-path code, and `__new_plain_object` forces
  `ensureObjectRuntime` (fixes defect 1).
- **Reuse/extend** `compileObjectLiteralAsExternref` (literals.ts:164) — it already
  builds `__new_plain_object` + handles spread via `__object_assign`; today it
  *skips* named props (:224-227). Add the named-prop `__extern_set` loop there and
  call it from the any-context branch.
- **any-context detection**: mirror the existing `isAnyContext` check
  (`getContextualType` → Any | Unknown | NonPrimitive, or no contextual type). Do
  NOT divert when a concrete struct type is expected (typed param, typed var, dstr
  slot) — those keep the closed-struct path (fast, correct for typed reads). Narrow
  precisely so we don't regress the typed-object fast path.
- **Nested**: a nested object value (`{x:{y:5}}`) recurses — the inner literal's
  contextual type (the outer prop's value type) decides its own routing; when the
  outer is any-context the inner value is compiled to externref and `__extern_set`
  stores it, so `o.x.y` reads the inner `$Object` natively.
- **#124 sibling** falls out for free: a `{valueOf(){…}}` in any-context becomes an
  `$Object` with the method stored, so ToPrimitive's native `__extern_get("valueOf")`
  + `__apply_closure` (S2) finds and calls it.

This is narrower + lower-risk than boxing-at-coercion: it touches only the
object-literal construction path under an any-context, leaves the typed-struct fast
path untouched, and rides entirely on already-native readers. gc/host mode: the same
any-context branch already routes empty `{}` to `__new_plain_object` there too, so
non-empty just extends an existing host-mode behavior — byte-changes only the
any-context non-empty-literal case (which was the broken one).

## Acceptance

- `g({x:9}).x` → 9 under `target:wasi`, module `valid=true`, zero `env::` leaks.
- Nested (`g({x:{y:5}}).x.y`), `const o:any={x:9}; o.x`, and the untyped-param-arg
  family all read correctly.
- #124 sibling: `({valueOf(){return 7}}) + 0` → 7 (ToPrimitive reads valueOf off the
  boxed object).
- gc/host mode byte-unchanged.
- Regression guard: existing open-object + array→any reads stay green; equivalence
  + the standalone regression gate (#1897) clean.

## Owner / lane

sd-s2 — object-runtime.ts core lane. Serializes with sd-1888 S5c on
object-runtime.ts at the merge queue; build in parallel, rebase at merge.

## Implementation notes (sd-s2, delivered 2026-06-05)

Shipped option **(iii)** construction-time `$Object` routing in
`src/codegen/literals.ts`:

1. **`compileObjectLiteral`** — new branch (after the empty-`{}` any-context
   branch) routes a **non-empty** object literal whose every property is a
   data prop / shorthand / spread (no accessors, methods, or computed/symbol
   keys) and whose contextual type is any/unknown/`object`/absent through
   `compileObjectLiteralAsExternref`. The any-context test **mirrors the
   existing empty-`{}` check verbatim** (R2 guard: a concrete struct type keeps
   the closed-struct fast path, byte-identical).
2. **`compileObjectLiteralAsExternref`** — extended its per-prop loop to build
   named data props onto the `$Object` via native `__extern_set(obj, "<key>",
   value)` (was previously spread-only; named props were silently dropped).

**Scope correction during impl (important — differs from the original
acceptance):**

- **Gated to `ctx.standalone` only.** Recon proved the open-object runtime
  (`ensureObjectRuntime` / `__new_plain_object` / `__extern_get`) is emitted as
  native defined functions **exclusively** under `ctx.standalone` —
  `late-imports.ts:308` deliberately excludes `ctx.wasi` (#1472 Phase B note:
  "WASI is intentionally NOT routed here yet"). Under wasi the `$Object`
  builder declines (`ensureLateImport` → undefined), so the branch must not
  fire there. **Verified wasi is byte-identical to main** with the gate. The
  `target:wasi` half of the original acceptance is therefore a **tracked
  follow-on** (extend the object runtime to wasi — needs the wasi `__str_flatten`
  type-mismatch in `__extern_get`'s body fixed first; that defect is
  **pre-existing on main**, present whenever a closed-struct-only wasi program
  emits `__extern_get`, and is NOT caused by this change).
- **#124 ToPrimitive sibling does NOT "fall out for free"** (contra the design
  note). Recon proved that even a closure-valued `{valueOf: () => 7}` data prop
  — which **does** route to `$Object` here — still returns `NaN`: ToPrimitive's
  `(o as number)` coercion does not LOCATE + `__apply_closure` the stored
  valueOf/toString off the `$Object`. That dispatch is a separate lever
  (depends on S6b method-as-value wrapping) and is a **tracked follow-on**. The
  construction half is pinned (`{valueOf(){…}}` literal compiles valid +
  leak-free).

**Delivered & validated under `--target standalone`:**

- `g({x:9}).x` → **9** (was 0 + invalid Wasm on main), `valid=true`, zero
  `env::` object-import leaks. Nested `g({x:{y:5}}).x.y` → 5, multi-prop,
  `const o:any={x:9};o.x`, absent-prop → 0 (no trap) all correct.
- R2 regression guard green: typed `interface Point` literal still builds a
  closed struct (`p.x*p.x+p.y*p.y` → 25).
- gc/host + wasi codegen **byte-identical to main** (gate off in both).
- Suites green: `tests/issue-1901.test.ts` (7), `issue-1472` (object runtime),
  `issue-1239`/`issue-1433` (accessor/disposal routing), `issue-1806`
  (ToPrimitive). The 4 `object-mutability`/`object-literal-getters-setters`
  equivalence failures are **pre-existing on main** (confirmed by swapping
  main's `literals.ts`), unrelated to this change.

### Follow-ons carved out of #1901

1. **wasi object-runtime extension** — route `OBJECT_RUNTIME_HELPER_NAMES`
   through `ensureObjectRuntime` under `ctx.wasi` too (lift the
   `late-imports.ts:308` `ctx.standalone`-only gate), after fixing the
   pre-existing `__str_flatten` type-5 mismatch inside `__extern_get`'s emitted
   body under native-strings. Unblocks the `target:wasi` half here + the wider
   wasi object corner.
2. **#124 ToPrimitive-off-`$Object` dispatch** — `(o as number)` /
   `String(o)` must find a stored `valueOf`/`toString` (method shorthand OR
   closure-valued data prop) on the `$Object` and invoke it via
   `__apply_closure`. Depends on S6b method-as-value wrapping.
