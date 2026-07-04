---
id: 2754
title: "Sound TS checker settings for .ts AND .js + codegen defensive-correctness where TS is deliberately unsound (#2698 track)"
status: done
created: 2026-06-27
updated: 2026-07-03
completed: 2026-06-28
assignee: "ttraenkler/sendev-2754"
priority: high
feasibility: medium
reasoning_effort: high
task_type: architecture
area: checker
language_feature: type-soundness
goal: platform
sprint: 69
es_edition: n/a
parent: 2698
related: [2698, 2748, 389]
origin: "Stakeholder directive (2026-06-27), #2698 checker track: generalize the #2748 strictNullChecks point-fix into a principled sound-settings policy for both .ts and .js, AND spec the codegen's defensive obligations where TS is INHERENTLY unsound (no flag reaches it)."
---

# #2754 — Sound TS settings (.ts + .js) + codegen correctness where TS is unsound

> **Scoping issue (architecture). Do NOT implement from this file alone.** It
> defines the policy, the empirical OOB finding, and the dev-sized slices.
> Companion **#2755** evaluates whether the _approach itself_ is sound.

## Why this exists (stakeholder framing — captured precisely)

**TS type-soundness ≠ js2wasm runtime-correctness.** The codegen lowers based on
the static TS type (it picks the Wasm value-representation — packed `f64`/`i32`
vs boxed `externref` — and constant-folds branches from the declared type). When
a TS type is _unsound_ (the runtime value does not match the declared type), the
codegen can **silently miscompile**.

**#2748 bug C is the proof.** The reporter transpiled `nm_deno.ts → nm_deno.js`
(types stripped). A `.js` fileName set `strict:false`, so `strictNullChecks` went
OFF, so `Deno.stdin.readSync(): number | null` collapsed to `number`. The EOF
guard `r === null` then **constant-folded to `false`** → a silent **infinite-loop
miscompile**. #2748 force-set `strictNullChecks:true` for `.js` as a _point fix_
(`src/checker/index.ts:680`); #2750 S1 then promoted single-file `.js` to the full
`strict` umbrella. #2754 **generalizes** that point fix.

> **UPDATE 2026-06-28 — the live transpiled-`.js` symptom CHANGED and was a
> DIFFERENT root cause (now fixed; see "Implementation notes" at the bottom).**
> With `strictNullChecks` already on (#2748/#2750), the reporter's bundled
> type-stripped `nm_deno.js` / `nm_node_fs.js` no longer hang — they **emit ZERO
> bytes and exit 0** (read/echo nothing). That is NOT the `number|null` collapse
> (bug C). After #2778 extracted the shared `nm_sync_framing` core, the hosts
> inject their `readSync`/`writeSync` as **function references** across the
> `runNmHost(read, write, …)` seam. Stripping the types makes those params `any`,
> so `read(tmp)` reaches the inline dynamic-dispatch path — whose dispatch arms are
> built from the funcref-wrapper closure types registered _so far_. A top-level
> `function denoRead(){}` registers its wrapper only **lazily at the value site**
> (`main`), compiled AFTER the body that invokes the param, so the dispatch saw
> **zero candidates** and lowered `read(tmp)` to a literal `ref.null.extern` — the
> function value was never invoked. Fixed by pre-registering function-value
> funcref wrappers before body codegen.

**But this is TWO-pronged, not "turn on every strict flag."** TS is _deliberately_
unsound in places no strict flag reaches (`a[OOB]` typed `T`, `as any`, JSON-as-T,
bivariant method params, …). Those holes are the codegen's problem, not the
checker's. So:

- **Prong 1 (type-level):** make the checker's option matrix sound where a flag
  keeps type-directed codegen accurate — for **both** `.ts` and `.js`.
- **Prong 2 (codegen-level):** where TS is inherently unsound and no flag closes
  the hole (or it is intentionally left off), the codegen must still be **JS-
  runtime-correct** — trap-free and value-correct vs the JS semantics.

## Current checker state (read before editing — `src/checker/index.ts`)

There are **three** `ts.CompilerOptions` blocks, and they are **inconsistent**:

| Block                          | Location              | `strict`                      | `strictNullChecks`          | `noImplicitAny` |
| ------------------------------ | --------------------- | ----------------------------- | --------------------------- | --------------- |
| `analyzeSource` (single-file)  | `index.ts:676-687`    | `!isJs` (→ **OFF for `.js`**) | **pinned `true`** (#2748 C) | `false`         |
| `analyzeMultipleFiles` block A | `index.ts:~977-989`   | `true` (always)               | (implied by strict)         | `false`         |
| `analyzeMultipleFiles` block B | `index.ts:~1069-1083` | `true` (always)               | (implied by strict)         | `false`         |

**The inconsistency is itself a latent bug:** a single-file `.js` gets _only_
`strictNullChecks` pinned (the rest of `strict` is off → `strictFunctionTypes`,
`strictPropertyInitialization`, etc. are OFF), while the same `.js` compiled in
the multi-file path gets the **full** `strict` umbrella. `noImplicitAny` is forced
`false` everywhere (intentional — see Prong 1 boundary). The `strict` umbrella in
TS enables: `strictNullChecks`, `strictFunctionTypes`, `strictBindCallApply`,
`strictPropertyInitialization`, `noImplicitThis`, `useUnknownInCatchVariables`,
`alwaysStrict`, `noImplicitAny`. It does **NOT** enable `exactOptionalPropertyTypes`
or `noUncheckedIndexedAccess` — those are separate opt-ins, currently OFF
everywhere.

## Implementation Plan

### Prong 1 — per-flag `.ts` / `.js` decision matrix

Boundary rule: **a flag that keeps type-directed codegen accurate → ON for both;
a flag that _rejects valid untyped JS_ (`noImplicitAny`) cannot apply to `.js`** —
rejecting input is not the checker's job there; producing a correct
dynamic/`any`/externref lowering is.

| Flag                           | In `strict`? | Touches representation / folding?                                                                                                                      | `.ts`                                 | `.js`                              | Rationale / cost                                                                                                                                                                                                                                                                             |
| ------------------------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `strictNullChecks`             | yes          | **YES** — `T\|null`/`T\|undefined` collapse changes value-rep (f64 vs externref) and folds null/undefined guards (#2748 C)                             | **ON**                                | **ON** (already pinned)            | Soundness-critical. Keep pinned.                                                                                                                                                                                                                                                             |
| `strictFunctionTypes`          | yes          | param bivariance → can pick wrong calling-convention / struct shape for a callback                                                                     | **ON**                                | **ON** (new for single-file `.js`) | Sound, cheap. Already on for `.ts` + multi-file `.js`.                                                                                                                                                                                                                                       |
| `strictBindCallApply`          | yes          | `call`/`apply`/`bind` arg typing                                                                                                                       | **ON**                                | **ON**                             | Sound, cheap.                                                                                                                                                                                                                                                                                |
| `strictPropertyInitialization` | yes          | uninitialized class field reads `undefined` → rep of field (`T` vs `T\|undefined`)                                                                     | **ON**                                | **ON**                             | Representation-relevant; requires `strictNullChecks` (satisfied).                                                                                                                                                                                                                            |
| `noImplicitThis`               | yes          | `this` typing                                                                                                                                          | **ON**                                | **ON**                             | Sound, cheap.                                                                                                                                                                                                                                                                                |
| `useUnknownInCatchVariables`   | yes          | `catch (e)` → `unknown` vs `any`                                                                                                                       | **ON**                                | **ON**                             | Sound, cheap, low blast radius.                                                                                                                                                                                                                                                              |
| `alwaysStrict`                 | yes          | emits `"use strict"` parse mode                                                                                                                        | **ON**                                | **ON**                             | We already parse strict-mode; cheap.                                                                                                                                                                                                                                                         |
| `noImplicitAny`                | yes          | **REJECTS untyped JS**                                                                                                                                 | **ON** (debatable; currently `false`) | **OFF**                            | **BOUNDARY.** Untyped `.js` legitimately has implicit `any`; rejecting it breaks the dynamic path's whole purpose. Keep `false` for `.js`. For `.ts`, currently `false` — flipping ON is a _separate_ lint-strictness decision (out of scope here; would surface many test262 `.ts` errors). |
| `exactOptionalPropertyTypes`   | NO (opt-in)  | `{x?: T}` vs `{x: T\|undefined}` — whether `undefined` is a legal value of an optional prop; interacts with packed optional-field rep (see Prong 2 #6) | **candidate ON**                      | **candidate ON**                   | Soundness _improvement_; medium cost (surfaces new errors on the `.ts` corpus). Measure first (slice S4).                                                                                                                                                                                    |
| `noUncheckedIndexedAccess`     | NO (opt-in)  | **THE big one** — makes every `a[i]` typed `T\|undefined` → forces a nullable/externref rep → closes the OOB hole (Prong 2 #1) at the type level       | **desired, LARGE**                    | **desired, LARGE**                 | **Deferred-big.** Re-representing every indexed read is a broad-blast epic (slice S5).                                                                                                                                                                                                       |

**Minimal sound fix for the documented inconsistency (slice S1):** make single-file
`analyzeSource` match the multi-file blocks — pin the sound sub-flags for `.js`
(`strictFunctionTypes`, `strictBindCallApply`, `strictPropertyInitialization`,
`useUnknownInCatchVariables`) while **keeping `noImplicitAny:false`**. Cheapest:
set `strict: true` for `.js` too and _then_ override `noImplicitAny:false`
(strict already implies `strictNullChecks`, so the #2748 pin becomes redundant but
keep it explicit as a guard + comment pointing here).

### Prong 2 — unsoundness-hole catalog + codegen obligations

For each hole: **(a)** the flag that closes it (if any) + cost, **(b)** the
codegen's obligation to be JS-runtime-correct where no flag exists / it is off.

#### 1. Out-of-bounds index access — `const a: number[] = [1,4,5]; a[4]` (typed `number`, runtime `undefined`)

**EMPIRICALLY DETERMINED on current main** (probe: bounds-checked read path
`emitBoundsCheckedArrayGet`, `array-methods.ts:386`; call sites
`property-access.ts:6303` and `:6352`). **Our lowering neither traps nor reads
garbage** — the read is bounds-checked (`i32.lt_u` against `array.len`) and the
OOB else-branch emits `defaultValueInstrs(elementType)` (`type-coercion.ts:2802`):

| Source                                | Our OOB result                                        | JS expects  | Correct?                                |
| ------------------------------------- | ----------------------------------------------------- | ----------- | --------------------------------------- |
| `number[]` `a[4]` (raw)               | **sNaN sentinel** `0x7FF00000DEADC0DE` → prints `NaN` | `undefined` | **WRONG** (NaN ≠ undefined)             |
| `number[]` `a[4] === undefined`       | `false`                                               | `true`      | **WRONG**                               |
| `number[]` `a[4] + 1`                 | `NaN`                                                 | `NaN`       | coincidentally **OK** (sNaN propagates) |
| `boolean[]` `a[5]`                    | `false` (`0`)                                         | `undefined` | **WRONG**                               |
| `any[]`/`string[]` `a[9]` (externref) | **`null`** (`ref.null.extern`)                        | `undefined` | **WRONG** (`null` ≠ `undefined`)        |
| `number[]` `a[-1] + 100`              | `NaN`                                                 | `NaN`       | coincidentally **OK**                   |

**Concrete answer to the stakeholder's question:** _neither trap nor garbage_ —
we return a **deterministic type-default sentinel** (sNaN for `number`, `0`/`false`
for `boolean`, `ref.null.extern` for `externref` elements). It is observably wrong
vs JS `undefined` in every context **except** arithmetic on a `number` element
(where the sNaN happens to propagate like `undefined`-coerced-to-`NaN`).

**Why true correctness is hard:** a `number[]` is stored as a **packed `f64`
array** — the element slot _cannot structurally hold `undefined`_. Returning JS
`undefined` requires either (a) boxing the element type to `externref`
(perf-prohibitive — defeats packed typed arrays), or (b) `noUncheckedIndexedAccess`
making the type `number | undefined` so the **rep is already nullable/boxed** and
the codegen knows to emit/branch on `undefined`. That is the deep tension feeding
**#2755** (is "trust the type" the right model at all?).

**Codegen obligations:**

- **Cheap partial (slice S2):** for **externref-element** plain reads (`any[]`,
  `string[]`), pass `useUndefinedSentinel=true` at `property-access.ts:6303` and
  `:6352` so OOB returns **`undefined`** (`__get_undefined`) instead of `null`.
  The machinery already exists (#1396) and is wired for destructuring callers; this
  extends it to plain reads. Number/boolean arrays are untouched (no `ref.test` on
  packed elements → byte-neutral there).
- **Full close (slice S5, deferred-big):** `noUncheckedIndexedAccess` → `T|undefined`
  rep for indexed reads. Broad blast radius.

#### 2. `as` / `as any` type assertions (unchecked by design — no flag closes this)

Codegen trusts the asserted type to choose the representation. `(x as number)`
where `x` is an `externref` actually holding a string → a blind unbox-to-`f64`
reads a garbage bit-pattern or traps. **Obligation:** at any
`externref → primitive` narrowing driven by an assertion, `ref.test` the brand
before unboxing and fall back to JS coercion (`__to_number`/`__to_string`) on
mismatch, never a blind reinterpret. (Slice S3.)

#### 3. `any` widening

`any` is already on the **externref/dynamic path** (boxed), so it is generally
runtime-correct — host coercions apply. Lowest-risk hole. **Obligation:** keep
`any` on externref; never let an `any`-narrowing select a packed rep without a
brand check.

#### 4. Function-parameter bivariance (without `strictFunctionTypes`)

A `(x: Dog) => void` passed where `(x: Animal) => void` is expected; if the
codegen picks the calling convention / struct shape from the param type, a field
access on the wrong shape traps. `strictFunctionTypes` ON (Prong 1) closes the
**method-position** case; TS keeps **method** params bivariant intentionally.
**Obligation:** dynamic dispatch / structural field reads must `ref.test` before
`struct.get`.

#### 5. `Object.keys(o): string[]`

Sound at runtime (keys _are_ strings) — **not** a miscompile risk. Catalogued for
completeness; no action.

#### 6. Optional vs `undefined` / `exactOptionalPropertyTypes`

`{x?: number}` read of an absent prop is `undefined` at runtime. A packed-`f64`
struct field with no presence bit reads the sentinel, not `undefined` — same class
as #1. `exactOptionalPropertyTypes` tightens the _type_ but the **representation
gap** remains for packed optional fields. **Obligation:** optional struct fields
whose type is not already nullable need an `externref` rep or a presence flag.
(Slice S4 measures the flag; the rep gap may defer with S5.)

#### 7. Excess-property / structural-typing escapes

An object literal with extra props assigned through a wider type — the extra props
exist at runtime but the type does not see them. A dynamic read of an unmodeled
prop must route through the **dynamic externref read dispatch** (not a compile-time
"no such field" error). Largely handled today (#2748 A's dynamic-read path);
**obligation:** verify the unmodeled-prop read does not fall into a packed/struct
fast path that assumes the static shape is complete.

#### 8. `// @ts-ignore`, declaration merging, `JSON.parse(...) as T`

The type is asserted; the runtime value is arbitrary. No flag closes these. Same
obligation as #2 (`as`): do **not** trust the declared type for an unchecked
unbox — `ref.test`/brand-check at the externref→primitive boundary.

### Blast-radius validation plan (mirror #2748)

1. **Byte-neutral on the `.ts` corpus.** test262 + equivalence fixtures compile as
   `test.ts` (`.ts`-named) → any Prong-1 flag flip that targets only the `.js`
   path **must** be byte-identical on the `.ts` corpus. Gate: `npm test --
tests/equivalence.test.ts` (0 diff) + a sampled `compile()` binary-hash
   before/after on a handful of `.ts` fixtures.
2. **Green on real npm `.js`.** Compile + run a real type-stripped module set —
   the nm_deno repro (`.ts` AND esbuild/tsc `.js`), plus a `lodash-es` module and
   `react-scheduler` (the #2698-track dogfood). Clean compile + correct run.
3. **Per-flag isolation.** Flip one flag on a branch; run (1) + (2); confirm no
   regression before stacking the next.
4. **`noUncheckedIndexedAccess` (S5), if attempted, needs FULL `local-ci` /
   `merge_group`, never a scoped sweep** — it re-represents every indexed read
   (broad-impact change; see `project_broad_impact_validate_full_ci`).
5. Each behavioral slice (S2/S3) ships a **regression test** under `tests/` (the
   OOB→undefined cases; the assertion-unbox brand-check cases).

### Decomposition into dev-sized slices (roles + ordering + honest cost)

| Slice  | Role                   | Scope                                                                                                                                                                                                                           | Cost                            | Order                |
| ------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | -------------------- |
| **S1** | dev                    | Unify the three checker option blocks: pin the sound sub-flags for single-file `.js` (`strict:true` + explicit `noImplicitAny:false`; keep `strictNullChecks:true` guard + comment → this issue). Byte-neutral on `.ts` corpus. | small (point-fix, #2748-shaped) | 1st                  |
| **S2** | dev                    | Plain externref-element OOB read returns `undefined` not `null` (`useUndefinedSentinel=true` at `property-access.ts:6303`/`:6352` for externref element). Regression test. Number/boolean unaffected.                           | small                           | 2nd (parallel to S1) |
| **S3** | senior-dev             | `as`/assertion + `@ts-ignore`/JSON-as-T unchecked-unbox guard: audit `externref→primitive` narrowing sites, `ref.test` + JS-coercion fallback.                                                                                  | medium                          | 3rd                  |
| **S4** | senior-dev             | Evaluate `exactOptionalPropertyTypes` ON: measure new-error surface on the `.ts` corpus; fix packed-optional-field rep gap (#6) where cheap.                                                                                    | medium                          | 4th                  |
| **S5** | senior-dev / architect | `noUncheckedIndexedAccess` → `T\|undefined` indexed-read rep. Full representation review. Likely a **separate epic**; honest cost = large; **defer**.                                                                           | large                           | last / deferred      |
| **S6** | research               | **#2755** — meta-evaluation of whether the _approach_ is sound (separate file).                                                                                                                                                 | n/a                             | parallel             |

## Acceptance criteria

- The per-flag `.ts`/`.js` matrix (Prong 1) is implemented at least through **S1**
  (no more single-file/multi-file `.js` inconsistency), byte-neutral on the `.ts`
  corpus, green on the real-`.js` dogfood set.
- The OOB index-access behavior is **documented and corrected for externref
  elements** (S2): `any[]`/`string[]` OOB → `undefined`. Packed-array OOB and the
  full `noUncheckedIndexedAccess` close are explicitly **deferred** (S5) with the
  rationale captured above.
- The unsoundness-hole catalog (Prong 2) is recorded with a codegen obligation per
  hole; S3 lands the assertion-unbox brand-check.
- Findings feed **#2755**'s verdict (esp. the OOB result: "trust the type" is
  _already_ insufficient for index access today).

## Implementation notes (2026-06-28 — transpiled-`.js` zero-output fix)

This PR fixes the **concrete live bug** the reporter hit (loopdive/js2#389): a
`bun build` / esbuild **type-stripped + bundled** `.js` of the SYNCHRONOUS
Native-Messaging hosts (`nm_deno.ts`, `nm_node_fs.ts`) compiled clean to a pure
WASI module, instantiated, and **echoed nothing (exit 0)** — while the direct
`.ts` path round-trips byte-exact. (The broader Prong-1 matrix S1 already landed
in #2750; the Prong-2 catalog slices S3–S6 remain as documented/deferred.)

### Root cause (empirically pinned — NOT bug C, NOT bug B)

- The `.ts` path lowers `read(tmp)` (where `read: NmRead`) to a **direct
  `call_ref`** from the static funcref type — works.
- The bundled type-stripped `.js` makes the seam params (`read`/`write`/`log`)
  `any`. `read(tmp)` then reaches `tryEmitInlineDynamicCall` (`#1063`), whose
  `ref.test`/`call_ref` dispatch arms are built from the funcref-wrapper closure
  types in `ctx.closureInfoByTypeIdx` **registered so far**.
- A top-level `function denoRead(){}` only registers its wrapper **lazily** at the
  value site that passes it (`main` → `runNmHost(denoRead, …)`), which is compiled
  _after_ `readFillExact`/`runVerbatim`. So at `read(tmp)`'s compile time there were
  **zero candidates** → the call lowered to a literal `ref.null.extern`. `r` was
  therefore always `null` → `if (r === null) return false` fired on the first read
  → the host echoed nothing. (Instrumentation confirmed `closureInfoByTypeIdx`
  empty at the call site; a runtime trace showed **zero** `fd_read`/`fd_write`
  calls — `denoRead` was never invoked, ruling out a buffer no-op / bug B.)

### Fix

`src/codegen/expressions/calls.ts` — `ensureFuncValueWrappersRegistered(ctx, sf)`,
called once (flag-guarded) from `tryEmitInlineDynamicCall`. It scans the source
file for **no-capture `function` declarations referenced as a value** (anything
other than a direct call/`new` callee) and pre-registers their funcref-wrapper
closure types via `getOrCreateFuncRefWrapperTypes` (signature-cached, so the lazy
value-site `emitFuncRefAsClosure` shares the same type; the trampoline is still
emitted lazily there). This makes the candidate visible to the dynamic dispatch
regardless of compile order. Captured functions are left to the lazy path (their
runtime value is a custom capture-struct subtype, not the bare wrapper).

Scoped to the `any`-typed dynamic-call path, so it is a no-op for typed `.ts`
calls (verified byte-neutral against the closure/dynamic-dispatch suites).

### Verification

- `printf <frame> | wasmtime … x.js.wasm` on the reporter's exact
  `esbuild --bundle` output: **byte-exact echo** (was empty on baseline).
- Both hosts round-trip a 1 MiB + multi-frame stream byte-exact, matching the
  `.ts` path (`nm_node_fs` re-chunks a >1 MiB body identically to `.ts`).
- New CI test `tests/issue-2754-transpiled-nm-roundtrip.test.ts` (in-process
  esbuild bundle + fd shim — runs every CI run, no `bun`/`wasmtime` needed).
- The stale #2748 runtime tests were updated to **bundle** (post-#2778 they used
  a transform-only strip that left `./nm_sync_framing` dangling); they pass again.
- `.devcontainer/Dockerfile` gains a pinned arch-aware `bun` block so devs can
  replay the reporter's `bun build` flow locally.
