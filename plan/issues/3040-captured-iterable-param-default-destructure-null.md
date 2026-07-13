---
id: 3040
title: "array-destructured parameter with a CAPTURED custom-iterable default throws 'Cannot destructure null' (blocks #2664 un-hold)"
status: done
assignee: ttraenkler/dev-3040
completed: 2026-07-06
sprint: 71
created: 2026-07-05
updated: 2026-07-13
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen
language_feature: destructuring, parameter-defaults, iterators, closures, async-generator
goal: spec-completeness
related: [3038, 3039, 3023, 2664]
model: fable
architect_spec: done
loc-budget-allow:
  - src/codegen/closures.ts
  - src/codegen/literals.ts
---

# #3040 — array-destructured param with a CAPTURED custom-iterable default → "Cannot destructure null"

Split out (PARKED) from the #2664 (#3023) un-hold work. This is the **third,
distinct** bug behind #2664's `merge_group` regressions (the first two —
#3038 nested-fn reader-by-ref, #3039 boxed transitive-capture accessor write —
are fixed and landing standalone). It is **NOT** a boxed-capture-accessor bug
and **NOT** async-CPS versioning.

## Symptom / blast radius (blocks the last 2 of #2664's regressions)

The 2 remaining `merge_group` regressions under the #2664 stack are
`language/expressions/async-generator/dstr/{dflt,named-dflt}-ary-init-iter-close.js`.
They use `async function*([x] = iter) { ... }` where `iter` is an outer `var`
holding a custom iterable. Under #2664 the body runs (it's vacuous on main) and
throws **"Cannot destructure 'null' or 'undefined'"**.

## Root cause is NOT async, NOT generator — it is CAPTURED-iterable-as-param-default

Minimal repros (host lane, `setExports` wired — `.tmp/probe-*paramdefault*.mts`):

| # | shape | result |
|---|-------|--------|
| 1 | `function f([x] = [7])` (sync fn, inline **array** default), omitted | **7 ✓** |
| 3 | `function* g([x] = [7])` (sync gen, inline array default), omitted | **7 ✓** |
| 5 | `function f({x} = {x:7})` (object-destructure, inline default), omitted | **7 ✓** |
| 8 | `async function* g([x] = [7])` (async gen, inline array default), omitted | **7 ✓** |
| 10 | `async function* g([x] = [7])`, arg **provided** `[9]` | **9 ✓** |
| 9 | `async function* g([x] = iter)` (async gen, **captured custom iterable**), omitted | **THROW null ✗** |
| 12 | `function* g([x] = iter)` (**sync** gen, captured custom iterable), omitted | **THROW null ✗** |
| 13 | `async function f([x] = iter)` (async **fn**, captured custom iterable), omitted | **THROW null ✗** |
| 11 | `async function* g([x] = {inline custom iterable})` (async gen, **inline** custom iterable), omitted | **0 ✗ (silently wrong)** |

Reading the matrix:
- Sync fn / sync gen / async fn / async gen ALL work with an inline **array**
  default → the param-default-application + array-destructure machinery is fine.
- The failure is triggered by a **custom iterable** default (an object with
  `[Symbol.iterator]`, requiring the iterator protocol to destructure), and is
  **independent of async / generator** (sync-gen #12 and async-fn #13 throw too).
- **Captured** custom-iterable default (#9/#12/#13) → the captured `iter` reads
  as **null** in the param-default-destructure code → "Cannot destructure null".
- **Inline** custom-iterable default (#11) → no throw but **silently wrong** (0),
  i.e. the iterator protocol is not driven for a custom-iterable param default;
  it falls through to a default/zero.

So there are two coupled defects in the **parameter-default initializer** path:
1. **Capture threading**: a variable captured as (part of) a param default is
   not threaded into the param-default-initializer code — it resolves to null.
   (This is param-position capture, likely adjacent to
   `promoteAccessorCapturesToGlobals`' `extraNodes`/paramInits handling and the
   nested-fn capture prepend — the SAME family as #3038/#3039/#2029, but the
   param-default slot, not the body.)
2. **Iterator-protocol destructure in param position**: array-destructuring a
   **custom iterable** (vs a plain array literal) as a param default does not
   invoke `[Symbol.iterator]().next()` — it produces the type default (0/null)
   instead of iterating. Plain array-literal defaults hit a fast/array path that
   masks this.

## Why PARKED (senior-dev STOP-AND-DOCUMENT)

Per the lead's 30-min depth box: this is **silently-wrong-code depth**, not a
small precisely-verifiable fix. It spans (a) capture threading in param-default
initializers and (b) iterator-protocol destructuring in parameter position,
across sync-gen / async-gen / async-fn. Param-default handling is broad-impact
(every defaulted destructured param), so a fix needs full `merge_group`
validation and careful design — it is NOT a scoped tweak. The 2 failing files are
'vacuous-pass → real-fail' (like the #3038 cluster), so a **clean fix is
preferred over a vacuity excuse** (lead's note), but it is a fresh sub-project.

## Acceptance

- All 4 THROW/wrong rows above (#9, #11, #12, #13) return their expected value.
- `async-generator/dstr/{dflt,named-dflt}-ary-init-iter-close.js` pass under the
  #2664 stack (the last 2 of #2664's `merge_group` regressions), so #2664 fully
  un-holds with its genuine +68.
- Full `merge_group` green (param-default is broad-impact — no regressions in
  destructuring-param / default-param / iterator suites).

## Notes for the implementer

- Start from the matrix above; reproduce #9/#11/#12/#13 in `.tmp/`.
- Locate the parameter-default-initializer lowering (where `= <expr>` is emitted
  for a destructured param) and (a) confirm how it resolves a captured name in
  the default expr (the null), (b) confirm whether it routes array-destructure of
  the default through the iterator-protocol path or an array fast path.
- Cross-check against the non-default array-destructure param path (which works)
  and the body-position iterator destructure (which works) to see what the
  param-default path skips.

## Implementation Plan (arch, 2026-07-05)

Both defects located in source. Land as two commits (independent), validate the
matrix after each, then the combined `merge_group`.

### Defect 1 — captured name in a param default is not threaded (the `null` throw)

**Exact site:** `src/codegen/statements/nested-declarations.ts:315-318`. The
nested-function capture analysis builds `referencedNames` **only from the body**:

```
const referencedNames = new Set<string>();
for (const s of stmt.body.statements) {
  collectReferencedIdentifiers(s, referencedNames, ownLocals);
}
```

Parameter **default initializers are never scanned**, so a name referenced ONLY
in a default (`function*([x] = iter)` where `iter` is unused in the body) never
enters `referencedNames` → never enters `captures` (nested-declarations.ts:359)
→ is not threaded as a leading capture param → `emitDefaultParamInit`
(nested-declarations.ts:942) reads it as a null/absent local → "Cannot
destructure null".

**Fix:** after the body scan, also scan each parameter's default initializer
(and binding-pattern nested defaults) into `referencedNames` — and into
`writtenInBody` only if the default writes (rare; a default rarely assigns an
outer var). Precedent already in this file: the eager-call-box path scans
`stmt.parameters` for callee names (nested-declarations.ts:918-921), and the
class-method path scans param-defaults via `promoteAccessorCapturesToGlobals(ctx,
fctx, member.body, paramInits)` (nested-declarations.ts:128-133). Mirror that:

```
for (const p of stmt.parameters) {
  if (p.initializer) collectReferencedIdentifiers(p.initializer, referencedNames, ownLocals);
  // also nested defaults inside a binding pattern element:
  //   function f([x = outer] = iter)  → scan the pattern's element initializers
}
```

Use `ownLocals` as the shadow set (a param default can reference an EARLIER
param, which is a local, not a capture — `collectReferencedIdentifiers` already
honors the shadow set). Make sure the scan also covers **nested defaults inside
the binding pattern** (`[x = outer]`), not just the top-level `= iter`.

**Cross-check the generator/async lifting variants.** #3040's matrix throws for
sync-gen (#12), async-fn (#13), async-gen (#9). Confirm all three flow through
this same `nested-declarations.ts` capture analysis (the generator path builds
the buffer body at nested-declarations.ts:705-719 but reuses the SAME `captures`
computed at 359). If a variant computes captures elsewhere, apply the same
param-default scan there. Grep for other `collectReferencedIdentifiers(... body
...)`-only sites that feed a capture set (closures.ts arrow path, literals.ts
method path) and audit whether their param-defaults are scanned — out of scope
to fix unless the matrix needs it, but note any gap.

### Defect 2 — custom-iterable param default not driven through the iterator protocol (silent 0)

**Symptom:** inline custom-iterable default (#11) returns 0, not the destructured
value — the iterator protocol (`[Symbol.iterator]().next()`) is never driven; the
typed-vec fast path reads a non-vec value and yields the type default.

**Exact site:** `src/codegen/destructuring-params.ts:1184`
(`destructureParamArray`). The externref arm (line 1226+) DOES drive the iterator
protocol (`__array_from_iter` — see the comment at 1230-1236) and guards
null/undefined (`emitExternrefDestructureGuard`, line 1228). But when the param's
**static** type is a typed vec/tuple (`paramType.kind === "ref"` — the common
case when the binding pattern element types are `number`/inferred), the function
does **not** enter the externref arm; it falls to the typed-vec path (below line
1221), which reads the vec backing store by index and never calls
`[Symbol.iterator]`. A custom-iterable default value stored into that slot is not
a real vec → reads defaults (0).

**Root of the fast-path mismatch:** `emitDefaultParamInit`
(`nested-declarations.ts:942` → `statements/nested-declarations.ts:1797`
`emitDefaultParamInit`, and `param.initializer` compiled at ~line 1832) compiles
the default to the param's **static** type. For an inline **array literal** `[7]`
the default is a typed vec matching `paramType` → the typed-vec destructure path
is correct and fast (why #1/#3/#8 pass). For a **custom iterable** the value is an
object with `[Symbol.iterator]` — semantically it must be iterated, but the static
`paramType` is still the typed vec, so the wrong path is taken.

**Fix (design — this is the silently-wrong-code knob):** when a destructured
param has a default whose (static or value) shape is a **custom iterable** (an
object type carrying `[Symbol.iterator]`, i.e. NOT an array/tuple literal and NOT
a real `Array<T>`/vec), the param-default + destructure must route through the
**iterator-protocol drive** rather than the typed-vec fast path. Options, in
order of preference:

1. **Detect at the default-init site** (`emitDefaultParamInit`,
   nested-declarations.ts:1797+): if `param.initializer` is a custom-iterable
   expression (checker type has a `[Symbol.iterator]` member but is not an array
   /tuple), materialize the default as an **externref** and force
   `destructureParamArray` down the externref arm (which drives
   `__array_from_iter`). This mirrors the note at destructuring-params.ts:1204-1219
   (the `arrayDstrNeedsIdentity` + `arrayIteratorOverrideGlobalIdx` branch already
   routes a real array through the host GetIterator read-drive when the
   `@@iterator` override brand is set) — generalise that trigger from "override
   brand set" to "value is a custom iterable".
2. Or thread an `opts` flag into `destructureParamArray` that forces the
   iterator-protocol drive for this param, set when the default is a custom
   iterable.

Prefer (1) — it keeps the fast path byte-identical for the common
array-literal/typed-vec default (no regression to #1/#3/#8) and only diverts the
custom-iterable case. **Confirm the body-position destructure of a custom iterable
already works** (dev says it does) and reuse that exact drive (`__array_from_iter`
/ the `compileArrayDestructuring` iterator path) so param position matches body
position.

### Coupling / ordering

Defects 1 and 2 are independent but BOTH must land for #9/#11/#12/#13 to pass:
#9/#12/#13 (captured) need Defect 1 (else `iter` is null before we even try to
iterate); #11 (inline) needs Defect 2 (the value is present but not iterated).
Land Defect 1 first (it's the smaller, well-precedented scan fix), retest the
matrix (#9/#12/#13 should stop throwing but may still return 0 → that's Defect 2),
then Defect 2.

### Edge cases

- **Default fires only when arg is `undefined`** (§ param default semantics) —
  the iterator drive must be inside the "arg omitted/undefined" arm, not run
  unconditionally (would iterate `iter` even when a real arg is provided — #10
  passes today, must stay correct).
- **IteratorClose on partial destructure**: `[x] = iter` where `iter` yields more
  than consumed must call `iter.return()` per §8.5.2 — the externref/
  `__array_from_iter` arm's existing IteratorClose handling covers this; verify the
  two target files `async-generator/dstr/{dflt,named-dflt}-ary-init-iter-close.js`
  (they specifically assert `iter.return()` is called).
- **Empty pattern `[] = iter`**: must NOT drive the iterator body
  (destructuring-params.ts:1244 `isPatternEmptyOnly` short-circuit) — preserve it.
- **Nested pattern defaults** (`[[y] = inner] = iter`): both defects compound;
  the Defect-1 scan must reach `inner`, and the Defect-2 drive must recurse.

### Verification plan

1. `.tmp/` — reproduce the 4 failing matrix rows #9/#11/#12/#13 (the dev's
   `.tmp/probe-*paramdefault*.mts` shapes, host lane with `setExports` wired);
   assert each returns its expected value after both fixes.
2. The 2 gate files under the #2664 stack:
   `language/expressions/async-generator/dstr/{dflt,named-dflt}-ary-init-iter-close.js`
   — must pass so **#2664 fully un-holds with its genuine +68** (this is the
   acceptance hinge; confirm by re-running the #2664 stack once #3040 lands).
3. Regression sweep: `language/{statements,expressions}/*/dstr/*` default-param +
   destructuring-param + iterator-close suites; the passing inline-array rows
   (#1/#3/#5/#8/#10) must stay green (Defect-2 fast path preserved).
4. Full `merge_group` — param-default handling is broad-impact (every defaulted
   destructured param); no scoped sweep suffices. Standalone floor green.

## Implementation Notes (dev-3040, 2026-07-06 — executed on Opus, Fable rate-limited)

### What actually shipped (2 sites, not the spec's 2 "defects")

The bug is **one** root cause — capture-analysis scans only the function BODY,
never the parameter DEFAULT initializers — replicated across **three** distinct
lowering sites. The spec's "Defect 2" (custom-iterable defaults skip the iterator
protocol via a typed-vec fast path) **does not reproduce**: instrumenting
`destructureParamArray` shows the param is compiled as `externref` and enters the
externref arm, which DOES drive `__array_from_iter_n`. The matrix's inline row
`#11` fails only because a computed `[Symbol.iterator]` **inside** an object
literal is not seen by the destructure iterator-drive (a separate, pre-existing
substrate bug that also fails in body position — `for-of` over the same object
works, member-read `obj[Symbol.iterator]` returns undefined). That is out of
scope; the real test262 iter-close files use the `iter[Symbol.iterator] = fn`
shape, which iterates correctly once the capture is threaded.

Shipped fixes (both scan each parameter subtree with `ownLocals` as the shadow
set, so binding names / earlier params stay local while free default references
become captures):

- **`src/codegen/closures.ts`** (arrow / function-EXPRESSION lowering) — adds a
  param scan to `referencedNames` (before the transitive-capture loop) and to
  `writtenInClosure`. This covers the async-generator / generator / function
  EXPRESSION variants of the `ary-init-iter-close` cluster, **including the two
  #2664 gate files** `expressions/async-generator/dstr/{dflt,named-dflt}-ary-init-iter-close.js`.
- **`src/codegen/literals.ts`** (object-literal plain methods) — passes the
  param-default initializers as the `extraNodes` arg to
  `promoteAccessorCapturesToGlobals` (global promotion), mirroring the
  class-method / getter-setter paths (#1161) which already did this. Object
  methods promote captures to globals, so there is no transitive-threading hazard.

### Validation (all runner-verified against current main)

- **#2664 gate files: both PASS** (`doneCallCount === 1`, `callCount === 1`,
  IteratorClose driven). **#2664 is unblocked** — un-hold is the lead's call.
- Full 92-file `*ary-init-iter-close.js` cluster: **90/92 pass** (the 2 fails are
  the DECLARATION-path statement variants — see deferred note).
- `*/dstr/dflt-*.js` sweep (651 files): **+31 pass, ZERO regressions**
  (422→453; fresh-process chunked to avoid the batch-runner state leak).
- `*/object/dstr/*.js` sweep (561 files): **+16 pass, ZERO regressions**
  (384→400; the object-method `-err` families are IMPROVEMENTS, confirming global
  promotion is regression-free).
- `npx tsc --noEmit` clean; 51 pre-existing param-default/destructuring/generator/
  async unit tests green; new `tests/issue-3040.test.ts` (6 tests) green.

### Deferred: declaration path (statements/nested-declarations.ts) — STOP-AND-DOCUMENT

A parallel fix in `emitNestedFunctionDeclaration` (scan param defaults into
`referencedNames` + the Phase-0 hoist capture check) was **implemented, validated,
and reverted** because it introduces a real regression the spec's mechanism does
not cover:

- Threading a default-only capture into a plain function DECLARATION shifts it to
  the **has-captures** lowering (leading capture params). Unlike the closures
  lowering, the declaration/call-site path has **no transitive-capture threading**
  (closures.ts:~1879 does; nested-declarations has none). So a declaration `f`
  that captures via a param default, when called from **another closure** —
  `assert.throws(Test262Error, function () { f(); })`, the standard test262
  error-test shape — either mis-indexes (`local index out of range` at the caller)
  or fails to thread the capture (default silently not applied → the expected
  throw is lost). Measured: **18 `statements/*/dstr/dflt-*-err.js` regressions**
  (iterator/getter-throwing families).
- A secondary hoist mismatch (Phase-0 pre-reserved the function as capture-free
  via a body-only scan, then `compileNestedFunctionDeclaration` saw the
  param-default capture and took the `reuseReservedEntry` deferred early-return →
  empty body, dropping a throwing default) is fixable by scanning params in the
  Phase-0 check too, but the transitive-threading regression remains.

The correct declaration-path fix is to route param-default captures through
**global promotion** (the object-method mechanism) rather than the has-captures
param-threading, OR to add transitive-capture threading to the declaration
lowering. Both are a deeper redesign than this issue's mechanism and are left as a
follow-up. This affects only the plain function/generator DECLARATION statement
variants (`statements/{function,generators,async-generator}/dstr/dflt-ary-init-iter-close.js`)
and declaration-form captured-iterable param defaults; the #2664 gate (all
EXPRESSION form) is fully covered by the shipped fix. Follow-up filed as a note
for the PO/architect; not blocking #2664.
