---
id: 2580
title: "`.length` on an any/dynamically-mutated receiver returns numeric 0, not undefined (runtime property-presence)"
status: in-progress
assignee: ttraenkler/sd-value-rep-m3
sprint: 65
created: 2026-06-21
priority: medium
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen, runtime, value-rep
language_feature: property access, length, dynamic objects
goal: test262-conformance
related: [2573, 983d]
---

# #2580 — `.length` on an `any`/dynamic receiver → runtime property-presence (substrate)

## Problem

`.length` on an **`any`-typed / dynamically-mutated** receiver returns numeric
`0` where the value is actually a plain object whose `length` is an absent
property (→ `undefined`, §10.1.8 OrdinaryGet). #2573 attempted a
**statically-typed** plain-object slice (a fail-safe static gate
`isPlainObjectWithoutLength` in `property-access.ts`) but that PR (#1868) was
**abandoned**: it moved 0 test262 rows AND ejected from the merge_group on a
hidden `.length` regression the targeted array-like pre-checks missed — the
`.length` path is too central to risk for zero conformance gain. The static gate
deliberately EXCLUDES `any`/`unknown` (at that static type a plain object and an
array are indistinguishable, and arrays dominate, so the numeric vec-field-0 /
`__extern_length` lowering is kept — excluding `any` is exactly what keeps
`any[].length` arithmetic safe), so it structurally cannot move the cluster.

The test262 `built-ins/Array/prototype/S15.4.4.*_A2_T*` cluster (the #983d
generic-Array-method-on-plain-object residual, 8 fails) is precisely the excluded
case:

```js
var obj = {};
obj.join = Array.prototype.join;
if (obj.length !== undefined) throw ...;   // obj is `any`; obj.length === 0, fails
```

## Why this is substrate, not a point-fix

Making `any`/dynamic-receiver `.length` correct requires a **runtime**
property-presence check at the read site: `ref.test $Object` → if it's a plain
`$Object`, `__extern_get(obj, "length")` (returns `undefined` when absent);
else (array / $ObjVec / string) read the numeric length. To express *both*
outcomes from one expression, `.length` on an `any` receiver must return a
**uniform externref** (the numeric array length **boxed** too). That is a
return-type change on the hot `any[].length` path — `for (;i<a.length;)` loops
and `a.length`-arithmetic are everywhere — so it carries broad regression risk
and is a value-representation decision (coordinate the value-rep lane:
`project_standalone_any_string_value_read_substrate`). #2573's #1868 ejection
already demonstrated how easily a `.length` change regresses a hidden case.

It also interacts with the #983d generic-array-method-on-plain-object machinery
(task #20, reverted as net-negative) and a standalone ToPrimitive throw, so a
correct `.length` alone would not flip the whole cluster.

## Fix direction (substrate)

- Decide the representation: either (a) `.length` on `any` returns a uniform
  boxed externref (numeric arrays boxed; plain objects `__extern_get`-undefined),
  validated against `any[].length` arithmetic across the FULL gate; OR (b)
  represent `var obj = {}` (dynamically mutated) as a dynamic `$Object` so the
  existing `$Object`-aware `.length` path applies.
- Validate via the FULL gate (merge_group / local-ci) — broad-reach, not a
  scoped sweep (the `.length` path is read everywhere; the #1868 eject is the
  cautionary example).
- Coordinate with #983d retry (task #20) for the generic-method cluster.

## Acceptance

- `var obj = {}; obj.length === undefined` (the `any`-receiver case) — typeof
  `"undefined"`.
- `S15.4.4.*_A2_T*` length-assertions flip to pass (with the #983d method-dispatch
  piece).
- ZERO regression in `any[].length` / array / string / arguments / typedarray /
  bound-fn `.length` arithmetic across the full gate.

## Cross-links

- #2573 (the static plain-object slice — PR #1868 abandoned: 0-row + hidden `.length` eject)
- #983d (generic Array method on plain object — task #20, reverted; the cluster needs both)
- value-rep / `project_standalone_any_string_value_read_substrate`

---

# Scoping doc — the value-rep dynamic-read substrate (2026-06-21, sd-1838)

> Filed under #2580 (the substrate's narrowest symptom is `.length`, but the
> lever is broader). This is a SCOPING artifact for a planning/next-phase
> decision — **not** an implementation plan. It sizes the payoff, proposes the
> representation, and stages an incremental, full-gate-validated migration.

## 0. Why this doc exists

The sprint-64 sparse-array tail (#2001 S2/S3/S4) and the open-object work
(#2580/#2573/#983d) **all converged on the same wall**: the compiler's
**dense/typed WasmGC representation cannot model a *dynamic read*** — reading a
property (indexed or named) from a receiver whose true shape is only known at
runtime. Each slice was individually spec-correct but conformance-flat or
net-negative because the rows it targeted need the dynamic-read substrate, not a
point-fix:

- **#2001 S2 (HOF visit-skip)** — ejected −6. The reachable test262 hole-HOF
  surface is "inherited accessor on `Array.prototype`" — HasProperty walks the
  **prototype chain**, which the dense vec can't model.
- **#2001 S3 (index-grow `$Hole` fill)** — 0 rows. The reachable form
  `var a=[1]; a[5]=9` lowers the assignment *target* to an **f64 vec** (numeric
  inference), so the externref hole-fill never fires; and test262 detects
  sparseness via `in`/`hasOwnProperty`/`delete`, not `join`.
- **#2001 S4 (dstr-past-length)** — 0 rows. The target family already passes;
  the failures are orthogonal (prototype-chain iterator, async iteration).
- **#2573 (#1868)** — abandoned, 0 rows + a hidden `.length` eject. The static
  plain-object gate **structurally excludes `any`**, which is exactly the
  cluster.
- **#983d (#1844)** — −200 net. The over-broad `__extern_method_call` fallback
  intercepted every unresolved `obj.method()`.

The common root: **a value whose static type is `any`/`unknown` (or a plain
object dynamically given array-like shape) has no compile-time-known field
layout, so indexed/`.length`/method reads must be resolved at RUNTIME against the
actual heap value — but the current codegen commits to a typed vec / numeric
field-0 / static dispatch at compile time.** Fixing one symptom (e.g. `.length`)
in isolation either moves 0 rows (the cluster needs the *whole* dynamic read) or
regresses the hot typed path.

## 1. What it unblocks — enumerated, with baseline row counts

Measured against the host test262 baseline (`.test262-cache/test262-current.jsonl`,
26m-old at measure time; **15,237** total host failures):

| Cluster | Failing rows | What it needs from the substrate |
|---|---|---|
| **`built-ins/Array/prototype/S15.4.4.*` — generic array method on an Array-LIKE object** | **~993** | `Array.prototype.{reduce,reduceRight,filter,every,some,forEach,map,indexOf,lastIndexOf,splice,slice,sort}.call({length:N, 0:…, 1:…}, cb)` — read `obj.length` + `obj[i]` from an arbitrary runtime object, HasProperty-skip absent indices. **This is the bulk of the lever.** |
| — of which: inherited/accessor/sparse element-retrieval (`-c-i-`/`-b-i-`) | 350 | prototype-chain HasProperty + accessor `Get` (the #2001 S2 ejection family) |
| — of which: `-2-N` "applied to Array-like, `length` own/inherited data prop" + `-5-N` length-coercion | ~640 ("other") | runtime `obj.length` read (own OR inherited) + ToLength coercion |
| **`any`/dynamic-receiver `.length` → undefined** (#2580 core) | ~12 (`S15.4.4.*_A2_T*` + `var obj={}; obj.length`) | runtime property-presence: plain-object `.length` is absent → `undefined` |
| **`Object.prototype.{hasOwnProperty,propertyIsEnumerable}` on dynamic objects** | 17 | runtime own-property presence on `$Object` |
| **`delete arr[i]` Array sparseness** | 11 | `delete` writes a hole the dynamic read honours (`in`/HOF skip) |
| **acorn dogfood** (#1712/#2582 family — dynamic struct read identity) | (non-test262, unblocks the tokenizer loop) | canonical struct rep on dynamic read paths |

**Rough reachable payoff: ~1,000 test262 host rows** concentrated in
`Array.prototype.*` generic-method-on-arraylike, plus the open-object/`delete`
tails. Caveat: not all ~993 flip from the substrate alone — a subset also needs
the #983d method-dispatch piece and a standalone-ToPrimitive fix (§4). A
conservative **first-wave estimate is the 350 `-c-i-`/`-b-i-` element-retrieval +
the ~640 `-2-/-5-` length/this-coercion rows that are *purely* runtime-read
gated**; the prototype-chain-accessor subset (the hardest) is a later wave. Even
the conservative slice dwarfs any single point-fix this session moved.

## 2. The core problem, precisely

Three runtime-read operations the dense/typed rep can't express:

1. **Indexed read `recv[i]` on an `any`/array-like receiver** — needs
   "does the object have own/inherited property `i`?" (HasProperty) then
   `Get(recv, i)`. The typed vec commits to `array.get` on a typed backing
   array, which (a) traps/0-fills for array-like *objects* (no vec), and (b)
   can't see prototype-chain entries.
2. **`recv.length` on an `any`/array-like receiver** — needs runtime
   property-presence: a plain object → `undefined`; an array/arguments/string →
   numeric. The current path commits to vec-field-0 / `__extern_length` (numeric
   0 for a plain object).
3. **`recv.method(...)` dispatch on an `any` receiver** — needs runtime
   resolution of `method` against the actual object (own/inherited/Array.proto
   generic), not a static funcMap lookup. (#983d's domain — the over-broad
   fallback regressed; the substrate gives it a *typed* dispatch surface.)

All three share one requirement: **a canonical runtime object representation that
carries (or can answer) property-presence + value for a dynamically-shaped
receiver**, and a **read site that branches on the runtime kind** (`ref.test
$Object` / `$Vec` / string / boxed-primitive) rather than committing to a typed
layout at compile time.

## 3. Proposed substrate (representation decision)

**Canonical dynamic-read protocol on the existing `#1852` boxed-family.** The
GC dynamic residue already dispatches an anyref-domain typed-struct family by
`ref.test`/`br_on_cast` (`$box_number`/`$box_boolean`/`$BigInt`/NativeString/
`$Object`/`$Vec`). Extend it with **two runtime read primitives**, Wasm-native
(no new host import; standalone-parity), that every `any`/array-like read site
calls:

- **`__dyn_has(recv: anyref, key) -> i32`** — HasProperty including the prototype
  chain. For `$Object`: walk own fields + the proto link. For `$Vec`: `idx <
  length && slot !== $Hole`. For array-like `$Object` with a numeric `length`
  field: `idx < length` (own/inherited). For string: `idx < len`.
- **`__dyn_get(recv: anyref, key) -> externref`** — `Get`: returns the value as a
  **uniform externref** (numeric boxed), or the spec `undefined` (externref) when
  absent. `.length` is just `__dyn_get(recv, "length")`.

**Representation choice for `.length` / indexed reads on a *statically-`any`*
receiver: uniform externref** (option (a) in the existing problem section) —
`recv.length` and `recv[i]` on an `any` receiver return a boxed externref, with
the numeric length/element boxed too. The **typed** path is UNCHANGED:
`a.length` where `a` is statically `number[]`/`string[]`/`Array<T>` stays the
numeric vec-field-0 read (no boxing, byte-identical). The branch is on the
**static receiver type**, gated exactly like the #1852 typed-mainline-unboxed
invariant: only `any`/`unknown`/dynamic-shaped receivers pay the runtime cost.

**Why uniform-externref, not "represent `var obj={}` as `$Object`" (option b):**
option (b) requires deciding the dynamic-object representation at *allocation*
time (every object literal), a far larger blast radius; option (a) is a
*read-site* change scoped to `any`-typed reads, which is where the cluster lives
and where the migration can be gated and incremental.

## 4. Blast radius + the −794-class risk

The hot path is `a.length` in `for (;i<a.length;)` loops and `.length`
arithmetic — read *everywhere*. The #1868 (#2573) ejection and the #1844 (#983d)
−200 are the cautionary precedents: any change that perturbs the **typed**
`.length`/method path regresses hundreds of rows. **The migration's prime
directive: the statically-typed read path stays byte-identical; only
statically-`any`/dynamic reads change.** Each step MUST be full-gate validated
(merge_group / local-ci), NEVER a scoped sweep — per
`project_broad_impact_validate_full_ci` (this session's three ejects all passed
scoped sweeps then failed the full gate).

## 5. Incremental, gated migration (NOT a #1844 big-bang)

Each slice is independently landable, full-gate-validated, and gated on the
static receiver type so typed reads are byte-identical:

- **M0 — `__dyn_has`/`__dyn_get` primitives (no call sites yet).** Add the two
  Wasm-native helpers + their `$Object`/`$Vec`/string/boxed arms + standalone
  parity. Dead-elim-pruned when unreferenced ⇒ **0 rows, 0 regression** (pure
  scaffolding; validates the helpers compile + the boxed-family dispatch is
  sound). Lands first, de-risks everything after.
- **M1 — `any`-receiver `.length` → `__dyn_get(recv,"length")`** (the #2580
  core). Gate strictly on a *statically-`any`/unknown* receiver; typed
  `.length` untouched. ~12 rows + de-risks the read-site branch. **This is the
  smallest real-row slice and the canary for the hot-path regression risk** —
  if M1 ejects on a hidden typed-`.length` case, the gating is wrong and we stop
  before the big slices.
- **M2 — generic `Array.prototype.X.call(arrayLike, cb)` over `__dyn_has`/
  `__dyn_get`.** Route the array-method-on-arraylike path (the ~640 `-2-/-5-`
  length/this-coercion rows) through the runtime read instead of the typed vec.
  Coordinates with #983d's method-dispatch (task #20) — the generic-method
  *resolution* + the *read* land together here.
- **M3 — prototype-chain HasProperty for indexed reads** (the 350 `-c-i-`/`-b-i-`
  element-retrieval rows + the #2001 S2 visit-skip, now correctly gated on
  `__dyn_has` so an inherited `Array.prototype[N]` accessor is "present"). This
  retroactively un-blocks #2001 S2 (re-land the visit-skip *driven by
  `__dyn_has`*, not own-only). Hardest, last.
- **M4 — `delete arr[i]` + `in`/`hasOwnProperty` honour the dynamic read** (the
  11 delete-Array + 17 Object-presence rows). Retroactively gives #2001 S3 its
  payoff (`3 in a` correct after a grow/delete).

Order rationale: M0 (scaffold, 0-risk) → M1 (smallest-row canary for the
hot-path risk) → M2 (biggest row block) → M3 (hardest, prototype chain) → M4
(tail). Stop-the-line if M1 ejects (gating wrong).

## 6. Cost / risk estimate

- **M0:** ~1–2 days, low risk (scaffolding, dead-elim-pruned).
- **M1:** ~1–2 days impl, **high regression risk** on the hot `.length` path —
  the full-gate canary. The #1868 eject says budget a fix-iterate cycle.
- **M2:** ~3–5 days, medium-high — the array-method-on-arraylike rewrite +
  #983d coordination; biggest payoff (~640 rows) and biggest surface.
- **M3:** ~3–5 days, high — prototype-chain modeling is the part the dense vec
  fundamentally lacks; re-lands #2001 S2.
- **M4:** ~2 days, medium — `delete`/`in` over the dynamic read.
- **Total:** ~2–3 weeks of senior-dev (value-rep lane) for ~1,000 rows, **if
  taken incrementally with a full-gate canary at M1**. A big-bang is
  contraindicated (#1844). Each slice is independently landable, so partial
  progress banks rows.

## 7. GENERALIZATION ASSESSMENT (the key sizing question)

**Question (per the task spec):** does the uniform-externref + `__dyn_has`/
`__dyn_get` rep that fixes `any`-receiver `.length` ALSO unblock the rest of the
parked tail? This decides whether #2580 is THE big lever (~1,000 rows) or a
small one (~12 rows). **Honest answer: it GENERALIZES to the READ clusters (the
bulk) but NOT to the two type-INFERENCE axes (S3/S4).** Verified by reading the
actual test bodies (e.g. `reduce/15.4.4.21-2-1`: `obj={0:12,1:11,2:9,length:2};
Array.prototype.reduce.call(obj,cb,1)` — a runtime read of `obj.length` +
`obj[i]` from a plain object).

| Cluster | Rows | Substrate fixes it? | Why / milestone |
|---|---|---|---|
| `Array.prototype.X.call(arrayLike, cb)` — `{0:..,length:N}` | **~640** | **YES — substrate IS the fix** | reads `obj.length` (own/inherited) + `obj[i]` at runtime = `__dyn_get`/`__dyn_has`. M2. |
| inherited/accessor/sparse element-retrieval (`-c-i-`/`-b-i-`) | **350** | **YES — `__dyn_has` prototype-chain arm** | HasProperty walks the proto chain (the #2001 S2 ejection family). M3 re-lands S2 *driven by `__dyn_has`*. |
| `any`-receiver `.length` → undefined (#2580 core) | **~12** | **YES — direct** | `recv.length` = `__dyn_get(recv,"length")`. M1. |
| `Object.prototype.{hasOwnProperty,propertyIsEnumerable}` | **17** | **YES — `__dyn_has` own-arm** | own-property presence on `$Object`. M4-adjacent. |
| `delete arr[i]` sparseness (`in`/HOF skip) | **11** | **YES — `__dyn_has` vec-arm honours `$Hole`** | M4 re-lands #2001 S3's `join` payoff via `in`. |
| #983d host-method dispatch | (overlap) | **PARTIAL — necessary, not sufficient** | `__dyn_get(recv,"method")` gives the *typed* dispatch surface #983d's over-broad fallback lacked; the generic-method *body* + a standalone-ToPrimitive throw are separate. M2 coordinates. |
| **#2001 S3 — `var a=[1]; a[5]=9` target → f64** | (0) | **NO — separate axis (WRITE-target type inference)** | the array-LITERAL element heuristic picks f64 for `[1]`, so the assignment *target* `a[5]` resolves f64. The substrate is dynamic *reads* on `any` *receivers*; it never touches a typed-write-target resolution. S3's externref grow-fill (`ba634ef44`) is correct for genuine-externref vecs but its headline needs a *literal-inference* fix, not this substrate. |
| **#2001 S4 — `const [p,q]=[1]` binding → numeric** | (0) | **NO — separate axis (binding-type inference)** | S4's fix (`779e98fa5`) re-types an OOB tuple-binding to externref — destructuring binding-local inference, orthogonal to dynamic receiver reads. |

**Verdict: GENERALIZES to ~1,030 READ rows (640+350+12+17+11) — the big lever.**
The two NON-generalizing axes (S3 headline, S4) are *type-inference* problems,
not dynamic-read problems; they were correctly parked but are NOT what #2580
unblocks (they'd need their own smaller literal/binding-inference fixes).

**Floor vs. ceiling (honest):** M1 (12) and M3 (350) are *substrate-pure*. M2's
640 *also* needs the #983d generic-method body (task #20) + a standalone-
ToPrimitive fix to fully flip, so M2 is "substrate + #983d", not substrate
alone. **Substrate-pure floor ≈ 390 rows (M1 12 + M3 350 + M4 28); ceiling
≈ 1,030 with #983d coordination.**

## 8. Recommendation

The value-rep dynamic-read substrate is **the single highest-leverage open
conformance lever** — a **~390-row substrate-pure floor / ~1,030-row ceiling
(with #983d)** vs. the point-fixes' single digits — and the common blocker
behind the dynamic/sparse READ tail (S2, #2573, #983d, the S15.4.4 generic-method
cluster). It does NOT generalize to the S3/S4 type-inference axes (separate,
smaller, already parked on their own merits).

Recommend **M0→M1 first**: M0 is 0-risk scaffolding (dead-elim-pruned), M1 is the
smallest-row (12) substrate-pure canary that sizes the hot-`.length` regression
reality. Hold M2–M4 behind M1's full-gate result; M2 additionally gates on #983d
coordination. **The investment decision — a ~2–3-week senior-dev/value-rep
commitment — is the USER's call.** This spec sizes the payoff (390 floor / 1,030
ceiling), the cost (~2–3 weeks), and the risk (hot-`.length` path, mitigated by
the M1 canary + per-slice full-gate validation, never a #1844 big-bang) for that
decision.

---

# Implementation log

## M0 — `__dyn_has`/`__dyn_get` scaffold (LANDED, PR #1880, 2026-06-21)

The two Wasm-native read primitives + a `ctx.usesDynRead` gate + finalize-phase
wiring (`src/codegen/dyn-read.ts`). **Provably inert / 0-risk**: the helpers are
gated on `usesDynRead`, which M0 sets nowhere, so they are never emitted and every
module is byte-identical (the *gate*, not dead-elim, is the guarantee — an
uncalled *defined* function is not import-pruned). Validated three ways: inert for
normal programs (incl. `any[].length`, `o.length===undefined`); valid when
force-emitted (`JS2WASM_FORCE_DYN_READ=1`, host + standalone — the bodies-are-sound
self-test); 0 regression on the array/object suites. Merged clean through the
merge_group (no eject), exactly as the byte-identity proof predicted.

## M1 — `any`-receiver `.length` canary (CANARY VERDICT: REPRESENTATION CALL, NOT landed)

The canary did its job — it surfaced the return-type-change as a **representation
decision before M2 sank any effort**, with the typed-`.length` safety property
cleanly bounded. Branch `issue-2580-m1-length-canary` (WIP, NOT pushed).

- **SOLVED — the #2043 `-1` type-index desync.** In HOST mode `__extern_get` is a
  JS *import*, not the native `$Object` runtime; the call-site helper called
  `ensureObjectRuntime`, which in host mode registers `$PropEntry` with
  `key: ref $AnyString` where `anyStrTypeIdx === -1` → a struct field referencing
  typeidx -1 → binary-emit fail. Fix: host uses `ensureLateImport("__extern_get")`,
  `ensureObjectRuntime` only in standalone. (Same family as
  `project_type_index_shift_and_deadelim`.)
- **SOLID — the typed safety property HOLDS.** `number[]`/`string`/`arguments`/
  `rest` `.length` are byte-identical: they return from the typed arms *above* the
  new `any`-gated arm and never reach it. The substrate's hot-path risk is bounded.
- **THE FINDING (the re-assessment).** `.length` on an `any` receiver returning a
  uniform externref fights every downstream *numeric* consumer. Scouting the five
  `obj.length` consumer contexts (`const x = obj.length` inference, `===`,
  arithmetic `+`, `String()`, `if`-truthiness) shows **none route through the
  `compilePropertyAccess` arm** — `obj.length`-on-`any` is lowered *independently*
  by multiple expression handlers (the `===` HasProperty fold, the arithmetic
  numeric-coercion path, …), each with its own `.length` handling. So the
  uniform-externref `.length` representation is **not one front-end change** but
  either (a2) a refactor making `compilePropertyAccess` the single `.length`-on-any
  chokepoint all consumers defer to, (a1) a per-handler patch, or (b) a narrower
  absent-sentinel that keeps `.length` numeric (smaller, but does not generalize to
  M2/M3's arbitrary `obj[i]` reads). **The canary proved the rep has
  distributed-lowering integration cost the scoping doc under-estimated** — a
  scope/investment decision (escalated to the user).

### Known follow-ups (track for M2/M3)

- **M0 `__dyn_has` semantic bug** — the M0 form returns "present" iff
  `__extern_get` is non-null, which **conflates "present with value `undefined`"
  vs "absent"** (`{}.x === undefined` own-property edge, and a real `undefined`
  value). HasProperty-proper (own + prototype-chain presence, independent of the
  *value*) is needed in M2/M3 where the distinction matters. M1's `.length` /
  the array-like cluster only need non-null-Get ⇔ present, so this is deferred,
  not a blocker for M0/M1.
- **`__dyn_get` standalone arm** — M0 delegates to `__extern_get`; the
  native-string indexed/`length` arm + the `$Vec` `$Hole→undefined` arm are M2/M3.

---

# M1 (a2) chokepoint-refactor plan — APPROVED path (a); CONFIRM before deep work

User greenlit path (a) end-to-end any-typing via the (a2) chokepoint refactor.
Scoped here as **its own bounded slice** (guardrail 1) for lead review BEFORE the
days go in; each step **full-gate validated** (guardrail 2).

## Re-scoping finding (good news — smaller than the M1 verdict feared)

A read-only map of EVERY `.length`-on-`any` consumer (`===`, arithmetic `+`,
truthiness, `const x = obj.length` inference, `String()`/template) found
**`compilePropertyAccess` is ALREADY the universal chokepoint**:
`compileExpression` (expressions.ts:~1171) routes every `PropertyAccessExpression`
through it with no exceptions, and **no consumer structurally special-cases
`.length`** before `compileExpression`. The apparent "bypass" (M1's first read)
is an *illusion of type coercion*: my arm returns externref, then each consumer's
existing coercion converts it — sometimes WRONGLY (unboxing the externref back to
numeric, losing `undefined`).

**So (a2) is NOT a multi-handler rewrite.** It is: (i) make the
`compilePropertyAccess` `.length`-on-`any` arm return externref cleanly (done in
the WIP, gated on static `any`/`unknown`), and (ii) fix the FEW consumer-coercion
sites that mishandle the externref. The hot-path (typed `.length`) never enters
this arm → byte-identical (verified: number[]/string/arguments/rest return from
the typed arms above).

## Consumer-coercion sites to audit + fix (the actual work)

Audit each `compileExpression(obj.length)` → my externref arm → consumer
coercion; fix only where the externref is mishandled:

1. **`x === undefined`** — binary-ops.ts:420-440 has a correct externref arm
   (`__extern_is_undefined`). The WIP showed a `__dyn_has`-flavored fold for the
   `propaccess === undefined` shape — INVESTIGATE whether the `===` path
   const-folds `.length === undefined` into a presence check and, if so, route it
   to the externref-from-`__dyn_get` (not a separate `__dyn_has`). PRIMARY canary
   assertion: `var obj={}; obj.length === undefined` → true.
2. **`const x = obj.length` inference** — variables.ts:~563/648/837. For
   `obj: any`, TS types `obj.length` as `any` → externref; the binding local
   SHOULD be externref. The WIP showed `typeof x === "number"`, so the local got
   a numeric ValType — fix the `.length`-on-any initializer's binding local to
   externref.
3. **Truthiness `if (obj.length)`** — control-flow.ts:568 + externref `__is_truthy`
   (index.ts:~13551). Likely already coerces; VERIFY (`if ({}.length)` falsy,
   `if ([1].length)` truthy).
4. **Arithmetic `obj.length + 1`** — binary-ops.ts:929/935. externref→f64 via
   `__unbox_number`; absent → NaN, spec-correct. VERIFY `[1,2].length + 1 === 3`,
   `({}).length + 1` is NaN.
5. **`String(obj.length)` / template** — calls.ts:~10427 / string-ops.ts:~363.
   externref→string via `__extern_toString`. VERIFY `String([1,2].length)==="2"`,
   `String({}.length)==="undefined"`.

Expect **2–4 small consumer fixes + the arm**, not a sweeping refactor.

## Staging (each its own full-gated PR; stop-the-line on a typed-`.length` eject)

- **M1a — the arm + `=== undefined` canary** (smallest, highest-signal). Land the
  externref arm + whatever the `=== undefined` path needs so `var obj={};
  obj.length === undefined` → true and the S15.4.4 `.length`-property rows flip.
  Full-gate. **The viability proof.**
- **M1b — binding-inference + truthiness + arithmetic + String** consumer fixes
  (only the ones M1a's audit flags). Full-gate.
- Each PR: typed-`.length` byte-identity guard + determinism guard.
  STOP-THE-LINE if either ejects.

## Cost / risk (revised DOWN from the M1 pessimistic estimate)

The chokepoint already exists; the work is the arm (done) + 2–4 consumer-coercion
fixes. **~2–4 days** (M1a ~1–2d incl. the `=== undefined` fold investigation,
M1b ~1–2d), each full-gated. Risk bounded by the static-`any` gate (hot-path
untouched) + per-PR full-gate. The M1 WIP (`d9956bfa3`, branch
`issue-2580-m1-length-canary`) is the starting point — the arm + the
host/standalone `__extern_get` #2043 fix already land.

**CONFIRM-WITH-LEAD checkpoint (guardrail 1):** posted for review BEFORE the deep
work. The material change from the M1 verdict: the chokepoint already exists, so
(a2) is a ~2–4-day arm+consumer-coercion slice, not a multi-handler refactor —
which de-risks the whole substrate's M1 cost. Awaiting go-ahead to execute M1a.

## Concurrency seam — vs. the parallel tag-5 equality wave (#1888/#1864/#1883)

A parallel value-rep wave rewrites the **tag-5 content-equality classifier**
(#2040 field-4 / #2579 any-str strict-eq / #2583 any-array search). My (a2)
`.length`-externref result flows into the `===` consumer, which meets their
classifier — so the question is collision vs. clean layering.

**VERDICT: CLEAN LAYERING — zero overlapping lines** (read-only `binary-ops.ts`
trace). My canary's `===` shapes land in arms DISJOINT from theirs:
- `obj.length === undefined` (my PRIMARY assertion) → the **presence arm**,
  `binary-ops.ts:429-435` (`__extern_is_undefined`). Not the classifier.
- `obj.length === <number>` → the **numeric-fallback arm**, `binary-ops.ts:
  2853-2876` (`__unbox_number` + `f64.eq`). Not the classifier.
- Their tag-5 content-equality rewrite lives at `binary-ops.ts:2804-2823`
  (`__any_from_extern` → `__any_eq` tag-dispatch), and is **strict-vs-loose
  disjoint** from mine: that arm is the LOOSE-equality (`==`/`!=`) + standalone
  branch; my shapes are STRICT (`===`/`!==`). They never execute the same code.

**No DIRECT collision.** My `.length`-externref just lands in the
presence/numeric arms unchanged; their classifier overhauls a different arm. So
the two waves can proceed **in parallel** with no sequencing dependency on the
`===` seam — my externref does NOT feed their classifier (it takes the
`=== undefined` / numeric arms before reaching tag-5 content comparison). If a
future (a2) shape compared two `any` VALUES for content (e.g. `obj.length ===
otherObj.prop`, both externref), THAT would route into their classifier and want
their base first — but the M1 `.length` canary (`=== undefined` / `=== <number>`)
does not. Flagged for the lead's wave-sequencing: **parallel-safe at the `===`
seam.**

## M1a — IMPLEMENTED (this PR)

The `.length`-on-`any` HOST arm landed as a clean **2-file** change
(`src/codegen/dyn-read.ts` + `src/codegen/property-access.ts`); the M0 scaffold,
#1899, and the typed `.length` hot-path are all untouched.

**Where the arm sits (the key root-cause fix).** It is NOT a new `propName ===
"length"` block placed ahead of the existing ones — that was the first (wrong)
attempt and it *clobbered the working array path*. Origin already reads
`const o: any = [1,2,3]; o.length` correctly as `3` because `o`'s value is an
externref wrapping a WasmGC vec; the existing handler eventually reaches a generic
externref reader that ref.test-dispatches the vec. Intercepting `any`-`.length`
BEFORE the vec detection forced every array through `__extern_get(vec,"length")`,
which the host evaluates to `undefined` (V8 sees an opaque struct). So the arm is
folded into the **`savedLen` fallback block** (`property-access.ts` ~3644): it
runs only AFTER the length-bearing-vec-struct detection misses, i.e. the genuinely
non-vec dynamic receiver.

**`emitDynGet` host path = runtime receiver-kind dispatch (no funcidx hazard).**
For the `length` key it emits, inline:
```
ref.test $vec_i  → if hit:  box_number(f64(struct.get $vec_i 0))   // the array length
                   else:    __extern_get(recv, "length")            // value or undefined
```
nested as one if/else chain over every registered `{length,data}` vec type in
`ctx.vecTypeMap`. `ref.test typeIdx` uses **type** indices (append-only /
dead-elim-stable via the rec-group), so unlike a `call __is_vec` it carries no
funcidx-ordering / late-import-shift hazard — which is what derailed the earlier
`__dyn_get`-wrapper attempt (a DEFINED-func `call` whose index floated when a
consumer added a late import). `__extern_get` + `__box_number` are host IMPORTS
(stable), ensured up-front before any baked index is resolved. Non-`length` keys
skip the vec arm and go straight to `__extern_get` (vec indexed reads are a later
slice). Standalone is unchanged (M1a is host-scoped; it still routes through the
`__dyn_get` wrapper, which is correct there because `__extern_get` is a defined
native helper).

**Representation = uniform externref, and consumers coerce for free.** The arm
returns `{ kind: "externref" }` (a boxed number for an array length, JS
`undefined` for an absent property). Every numeric consumer tested
(`+`/`*`/`<`/`for`-bound) unboxes it via the existing externref→f64 coercion;
`=== undefined` hits the presence arm; `typeof`/`String()`/truthiness all correct.
So M1a needed **no** separate M1b consumer-coercion work for these shapes — the
pessimistic M1 verdict over-scoped it.

**Validation.** New regression suite `tests/issue-2580-any-length.test.ts` (13
cases) green; `tsc`/`prettier` clean; the 3 pre-existing `strings.test.ts`
failures are an unrelated worktree test-infra artifact (identical on origin/main).
Conformance is the merge_group full-Test262 gate's call (this is a value-rep /
chokepoint touch → authoritative gate per `project_broad_impact_validate_full_ci`,
NOT a scoped sweep). Stop-the-line on any typed-`.length` eject.

## M1a — MERGE_GROUP EJECT (PR #1894 v1, 13 regressions) + ROOT CAUSE

PR #1894 v1 (the `ctx.vecTypeMap`-dispatch arm above) passed every PR check and
all 117 merge_group test262 shards, but the merge_group **net-regression gate**
ejected it: **13 regressions** (pass→fail), all `assertion_fail`, all with a
wasm-hash change, **0 improvements** (fails net AND ratio). `auto-park` applied
the `hold` label. Confirmed NOT cross-PR drift (only #1894's merge_group shows
bucket `964d9207`). Pulled the merged-report artifact + diffed vs baseline → the
exact 13 split into two clusters, BOTH the `.length`-on-any arm firing on a
receiver the prior numeric path handled correctly:

- **A (5): function/closure `.length` = ARITY.** `verifyProperty(IteratorProto[
  Symbol.iterator], 'length', {value:0})` etc. `(fn as any).length`: origin = `0`
  (matches the arity the tests assert), my arm = **NaN** (a closure externref →
  `__extern_get(closure,"length")` → undefined → NaN coercion).
- **B (8): for-await-of array-rest destructuring `.length`.** `for ([x, ...y] of
  …)` then `y.length`. The rest binding `y` is `let`-declared → `any`, and in the
  loop-head-destructuring desugaring it ends up as a boxed/wrapped externref that
  is NEITHER a directly-`ref.test`-able vec NOR a plain host object — so my vec
  chain misses and `__extern_get` returns undefined → **NaN** (origin returned the
  correct count). (A reduced `for ([x,...y] of [[1,2,3]]) {}; return y.length`
  reproduces NaN locally; note `typeof y` is `"undefined"` / `Array.isArray(y)`
  false in this reduced shape — there is a *separate* for-of-rest-binding
  representation quirk here, orthogonal to M1a, that the prior numeric `.length`
  path happened to read correctly.)

**Unified root cause:** the gate `objType.flags & (Any|Unknown)` is too broad. My
arm intercepts `.length` for ANY boxed/wrapped non-plain-object receiver (closure,
loop-destructured rest array, …) and emits a uniform-externref `undefined` →` NaN`
where the prior numeric path returned a usable value. The substrate CORE is sound
(the `{}.length === undefined` canary still passes); the gate just over-reached.

**FIX — option 2 (positive `$Object` gate) is NOT VIABLE in host mode; use
option 3 (decline-for-struct).** Option 2 fails twice: (a) `objectTypeIdx` only
exists when `ensureObjectRuntime` runs, and that registers `$PropEntry` with
`key: ref $anyStrTypeIdx` — host mode `anyStrTypeIdx = -1` → the original −1
type-index crash; (b) more fundamentally, in HOST mode a plain `{}` is NOT a
WasmGC `$Object` struct — it's a host JS object (externref). There is no struct to
`ref.test`. So a positive `$Object` gate can't work host-side.

The host-mode picture (confirmed by probing): plain `{}` is a host externref that
`ref.test`-misses ALL structs (→ `__extern_get` → undefined, the canary —
*already* works via the current vec-MISS branch); array/closure are WasmGC
structs; the for-of/await rest binding points at a vec (the v1 arm matched it and
read the SOURCE array's length 3, hence "returned 3" for expected 2).

**Option 3 — decline-for-struct:** the dyn-read `.length` arm DECLINES (return
false → caller falls through to the prior numeric `.length` path) when the
receiver `ref.test`s as a VEC **or** a CLOSURE base type
(`collectClosureBaseWrapperTypeIdxs(ctx)`, same body-compile mechanism as the vec
types); it fires `__extern_get(recv,"length")` ONLY for the residual genuine host
externref. Effect: array → declines → prior path reads vec field-0 = 3 ✓ (this
also DROPS the v1 box-number vec arm, eliminating the Cluster-B wrong-vec-match);
`{}` → all struct-tests miss → `__extern_get` → undefined ✓ (canary); closure →
declines → prior path → 0 ✓ (Cluster A); rest binding (vec) → declines → prior
path → correct count ✓ (Cluster B). SIMPLER than v1 (removes the box-number arm —
the prior path already read array `.length` correctly). Arm shrinks to
"`ref.test` vec OR closure → decline; else `__extern_get(recv,'length')`". One
gate, all 13 fixed, canary preserved, no `$Object` struct needed. **Validate
against the REAL async-generator rest test262 file** (the reduced
`for ([x,...y] of …)` probe is unfaithful — origin ALSO returns 0 there).
Re-validate via merge_group (one-shot); stop-the-line on re-eject.

## M1a — FINAL VERDICT (faithful runner): NOT a surgical slice; defer to M2

Built a faithful local gate — call the REAL `runTest262File` (tests/test262-runner.ts)
on all 13 regressed files directly (`.tmp/run13.mjs`). Reduced `compile()`+probe
shapes repeatedly MISLED (a user closure ≠ a host builtin; `for([x,...y]of)` ≠ the
async-gen harness). Results:

- **Arm OFF → 12/13 pass** (the 13th `[skip]`s on Temporal). ZERO regression,
  identical to origin — the prior path is correct for every one of the 13.
- Arm ON v1 → 0/13. Closure-arm v2 → STILL 0/13 (the real Cluster-A receivers are
  host-builtin functions reached via Symbol-keyed prototype walks, NOT user
  closures the `ref.test` catches). Receiver-`ref.is_null` guard → STILL 0/13 (the
  13's receivers are NON-null wrapped externrefs). Decline-for-struct → can't
  separate them (the 13 `ref.test`-MISS all structs, exactly like the canary `{}`).

**Root cause = TOTAL ENTANGLEMENT.** Every one of the 13 reaches
`__extern_get(recv,"length")` → undefined → NaN, where the prior numeric path
returned a usable value (0 via `__extern_length`'s null-guard, or the real count).
The canary (`{}.length` → undefined) needs that SAME `__extern_get`-undefined
result to STAY undefined. A non-null `{}` lacking `length` and a non-null wrapped
builtin / rest-binding are the SAME externref shape — **no `ref.test` /
`ref.is_null` / `__extern_has` predicate separates them.** The distinction lives in
the boxed `$AnyValue` tag, which only a TAG-AWARE reader (M2's job) can inspect; a
bare-externref runtime test cannot. So options (a)/(3) are dead — there is no
surgical gate.

**RESOLUTION = turn the arm OFF (option c).** The `.length`-on-any value-semantics
is not a surgical M1 slice; it requires M2's tag-aware dynamic reader to
disambiguate the receiver. Turning the arm off reverts the canary to the
PRE-EXISTING #2580 bug (NOT a new regression), keeps M0 inert, and is zero-regression
(validated 12/13 + skip). The `{}.length`→undefined fix folds into M2's acceptance.
M1 over-scoped the value-semantics; M0 (the inert scaffold) is the landable M1.

## M2.2c — reduce/reduceRight-no-init un-refuse: WONT-FIX (A/B proven net-negative, 2026-06-22, sd-2611)

**Do not re-attempt the un-refuse without first landing the parked native
no-init arm.** M2.2c was framed as "un-refuse `reduce`/`reduceRight` no-init on
array-likes by fixing the #2043 funcidx desync (re-resolve-by-name) at the
hole-scan's baked `__extern_has_idx`/`__extern_get_idx`." Measured against
CURRENT main, all three premises are stale:

1. **The funcidx desync is ALREADY fixed.** The native no-init arm already
   re-resolves by name (`getIdxFnNow`/`hasIdxFnNow`, array-methods.ts ~L867, the
   #16 fix) and #2611's `flushLateImportShifts` hardening closed the remaining
   leak. Instrumented build + A/B over the whole corpus: compile-validity is
   IDENTICAL refusal-ON vs OFF (450/520 valid both ways), ZERO invalid-Wasm from
   the no-init path. There is nothing left for the re-resolve-by-name pattern to
   fix here.
2. **The refusal is ROW-PROTECTIVE, not a graceful CE.** Its `reportError` fires
   only in a SPECULATIVE compile pass; the final emit routes the no-init shape to
   the WORKING host `__proto_method_call` path. So removing the refusal does not
   "un-block a graceful CE" — it diverts working rows to the incomplete native arm.
3. **Un-refusing REGRESSES rows.** A/B harness = compile + instantiate + run every
   `built-ins/Array/prototype/{reduce,reduceRight}` test262 file standalone:
   - **refusal ON (current main): PASS 363, FAIL 8, CE 68** (520 files)
   - **refusal OFF (the un-refuse): PASS 306 (−57), FAIL 57 (+49)**
   The native no-init arm returns WRONG results for the real corpus shapes
   (defineProperty-getter array-likes, sparse holes, proto-chain receivers,
   `arguments`); a bare object-literal array-like (`{0:..,1:..,length:n}`) is the
   only best-case shape that returns correctly, and it is not representative.

**A genuine un-refuse requires a CORRECT native no-init arm** (handle
defineProperty getters / holes / proto-chain / `arguments`) — that is the M2
value-rep / tag-aware-reader substrate (this issue's parked work; see the
S15.4.4 cluster row in the scoping doc above, and the M2 slices). It is NOT an
index-shift point-fix. Until that lands, the `arguments.length < 3` refusal in
`standaloneArrayLikeMethodRefused` (array-methods.ts) stays — it is strictly
better than the alternatives (working host path > incomplete native arm).
Tracking task #74 set WONT-FIX on this basis.

## M3/M4 follow-up: tag-5 boxed-VALUE equality (#2626)

The tag-5 boxed-VALUE equality arms (numeric `f64.eq` for two `$BoxedNumber`,
object `ref.eq` for two boxed eqref objects) are blocked on this same value-rep
substrate. They shipped in #1888's classifier but EJECTED the merge_group floor
(−162, class/dstr): the destructuring / generator-iterator lowering relies on the
legacy always-false tag-5 non-string equality, so making those arms correct
regresses the dstr cluster. The string arm (guarded #2579/#2583) landed; the
numeric+object arms are tracked by **#2626** for the M3/M4 substrate, where the
dstr-iterator-protocol dependency is owned. See
`plan/issues/2626-tag5-boxed-value-equality-classifier-substrate.md`.

---

# M3 — RE-GROUNDING (2026-06-22, sd-value-rep-m3): root cause is a DYNAMIC `[[Prototype]]`-link gap, NOT a runtime-read-protocol slice. ARCHITECT-SPEC-FIRST.

Re-grounded the M3 target (the `-c-i-`/`-b-i-` "inherited/accessor/sparse
element-retrieval" cluster) against CURRENT main with the REAL `runTest262File`
runner, then bisected the failing read down to its smallest in-Wasm form. The
scoping doc framed M3 as "prototype-chain HasProperty over indexed reads, driven
by `__dyn_has`" (~350 rows, an incremental slice on the M0 primitives). **The
actual root cause is broader and deeper: the compiled dynamic-object
representation carries NO runtime `[[Prototype]]` link for dynamically-built
objects, so NO inherited read (named OR indexed) resolves, in EITHER mode.**

## What the cluster actually is (verified row counts)

The cached host baseline has **170** `built-ins/Array/prototype/*-[cb]-i-` rows
(`-c-i-` 132 + `-b-i-` 38; the scoping doc's "350" over-counted). Running ALL 170
through `runTest262File` **one-test-per-fresh-process**: **168 genuine `fail`**,
1 real invalid-Wasm, 1 parse glitch — i.e. essentially the whole cluster is a
runtime value gap, as the scoping doc predicted at the headline level.

> ⚠️ RUNNER ARTIFACT (warn the next agent): running these 170 IN ONE in-process
> `runTest262File` loop reports ~42/43 as `compile_error: Cannot read properties
> of undefined (reading 'kind')` — a TS-parser (`createSourceFile` →
> `canHaveModifiers`) crash from cross-compile state bleed in the in-process
> runner. It is FALSE: each test in a FRESH process is a clean `fail`. The
> sharded `compiler-fork-worker.mjs` (one fork per test, the path that records
> the committed JSONL) is unaffected. Always isolate per-process when bucketing
> this cluster.

## The bisected root cause (smallest in-Wasm repros, host + standalone IDENTICAL)

The test shape is `Con.prototype = proto; child = new Con()` (or `.call(child,cb)`)
where the visited element lives on `proto` (the chain), not on `child`. Reduced:

```
proto = { 5: 99, length: 10 }; Con.prototype = proto; child = new Con();
child[5]            // → NaN   (spec 99)   ← indexed inherited read broken
(5 in child)        // → 0     (spec 1)    ← HasProperty broken
forEach.call(child) // count 0 (spec 1)    ← so the generic method visits nothing
```

And it is NOT limited to `new F()` or to indexed keys — EVERY dynamic-prototype
mechanism + a plain NAMED inherited read fails identically:

```
function Con(){}; Con.prototype = {foo:7}; new Con().foo   // → NaN (spec 7)
Object.create({5:99})[5]                                   // → NaN (spec 99)
o={}; Object.setPrototypeOf(o,{5:99}); o[5]                // → NaN (spec 99)
```

Own properties work fine (`forEach.call` over OWN indices → correct count;
`child.length` own read → 2). The gap is purely the **inherited** tier: a
dynamically-constructed object's `[[Prototype]]` link to another runtime object is
never established/walked. Host mode's `__proto_method_call` (V8 native via the
`_wrapForHost` live-mirror Proxy) AND standalone's native `$Object`/`__extern_get`
walk BOTH fail — so this is a representation gap, not a host-glue or a
standalone-only gap. (#1712's vivified-prototype hook resolves CLASS-instance and
fnctor-ctor chains; it does NOT cover `F.prototype = plainObj` reassignment /
`Object.create` / `setPrototypeOf` — those produce a runtime `[[Prototype]]` that
the dense rep drops.)

## Why this is NOT the planned incremental M3 slice

The scoping doc's M3 assumed the prototype-chain piece was "wire `__dyn_has` to
walk the proto link that already exists." It doesn't exist. Making inherited
reads correct requires the dynamic `$Object` rep to **carry a `[[Prototype]]`
field** and EVERY dynamic read/HasProperty/`in`/`for-in`/host-mirror path to walk
it, plus the allocation + prototype-assignment sites (`{}`, `Object.create`,
`new F()`, `F.prototype = x`, `setPrototypeOf`) to populate it. That is the
substrate's core object-model change — broad blast radius (touches object
identity, `in`, `for-in` (#2572/#2575 lane), the host-mirror Proxy, dynamic
get/set), and exactly the `~3–5 day, high-risk` M3 the scoping doc estimated, but
with the realization that there is no smaller pre-existing-link slice underneath
it. **No surgical sub-slice lands rows without the `[[Prototype]]` field.**

## VERDICT: STOP — architect-spec-first (flagged to lead 2026-06-22)

Per the M3 dispatch guardrail ("if M3 needs an architect spec, STOP and flag
rather than rabbit-hole"), M3 is genuinely architecture-scale: a dynamic
`[[Prototype]]`-link object-model change, not an incremental `__dyn_has` wiring.
Recommend an architect spec that decides (1) where the `[[Prototype]]` link lives
on the `$Object` rep (field vs sidecar), (2) the walk protocol shared by
indexed/named/`in`/`for-in`/host-mirror reads, (3) the populate sites + their
interaction with #1712's existing class/fnctor vivified-prototype hook (avoid
double-walking), (4) staging that banks rows full-gate-validated (the named-read
canary `new Con().foo` first, then indexed, then the generic-method cluster).
No code landed this session — read-only re-grounding only; branch carries this
finding doc.

---

# M3 — Implementation Plan (architect spec, 2026-06-23)

> SPEC-ONLY. Read-only re-ground against current `main` confirmed the re-grounding
> verdict and refined it: **the standalone walk machinery already exists; the gap
> is POPULATE + a few non-walking arms. The host side has THREE inconsistent
> half-mechanisms and one outright STUB.** The plan unifies both onto a single
> canonical `[[Prototype]]` link + one shared walk, staged so the first
> merge_group-floor-validatable PR is the `new Con().foo` named-read canary.

## Re-ground delta vs. the re-grounding section above (what changed under inspection)

The re-grounding said "the compiled object rep carries NO runtime `[[Prototype]]`
link." Reading the source, that is true **end-to-end** but the pieces are
asymmetric, and naming them precisely is what makes the staging tractable:

**Standalone (`--target standalone`)** — the substrate is *mostly built*:
- `$Object` **already has** `(field $proto (mut (ref null $Object)))` at field
  index 0 (`object-runtime.ts:239`, struct def ~262).
- `__extern_get` (`object-runtime.ts:746`, body ~761) **already walks** the
  `$proto` chain (the `o = o.$proto` loop at ~844-848, `struct.get $Object 0`),
  including the §6.2.5.5 accessor-`Get`-on-original-receiver arm.
- `__extern_has` (`object-runtime.ts:~1932`) **already walks** the chain (mirror
  of `__extern_get`). So the `in` operator's standalone arm is *already*
  proto-aware once the link is populated.
- `__object_create` (`object-runtime.ts:~2348`) and `__object_setPrototypeOf`
  (`~2394`) **already write** `$Object.$proto` correctly (with the
  extensibility + cycle checks).
- `__getPrototypeOf` / `__object_isPrototypeOf` (`~2319`, `~2544`) already read
  the chain.

So in standalone the inherited-NAMED read should *already* resolve **for objects
that are native `$Object`s with a populated `$proto`**. It fails because:
  (S-a) **`{}`/object-literal alloc sets `$proto: null`** (`__new_plain_object`
  body, `object-runtime.ts:621`; the inline `struct.new $Object` at ~1058) — so
  `Object.create(proto)` is fine (it writes `$proto`) but the *common* literal
  path leaves a null chain.
  (S-b) **`new F()` (fnctor) construction does not link `instance.$proto` to
  `F.prototype`** — standalone construction is "pure Wasm" (per the #1712 comment
  at `new-super.ts:1110`, the host bridge is JS-host-only) and never writes the
  instance's `$proto`.
  (S-c) **`F.prototype = plainObj` reassignment is not modeled** — there is no
  standalone notion of a per-constructor `.prototype` object that `new F()` reads
  to seed `instance.$proto`.
  (S-d) **INDEXED reads do NOT proto-walk.** `__extern_get_idx`
  (`object-runtime.ts:3351`) array-like arm reads `obj.length` + `obj[i]` via
  `__extern_get` on the *string* key — but its `$Object` arm only handles the
  array-like-with-own-`length` shape; an inherited indexed element
  (`Object.create({5:99})[5]`) needs the index→string-key read to go through the
  proto-walking `__extern_get`, which it can once (S-a/b/c) populate `$proto`.

**Host / GC mode (`!standalone && !wasi`)** — the substrate is *three
half-mechanisms and a stub*, and this is why the re-grounding saw host fail too:
- (H-a) `new F()` instances link to their ctor via `_fnctorInstanceCtor`
  (`runtime.ts:71`), and a property MISS resolves through
  `_fnctorProtoLookup` (`runtime.ts:74`) → `_sidecarGet(ctor, "prototype")` →
  walks that vivified object. **BUT** `_fnctorProtoLookup` reads the ctor's
  vivified-`prototype` *sidecar slot* (`_getOrVivifyFnPrototype`, `runtime.ts:96`,
  writes `_sidecarSet(obj,"prototype",{})`). A WHOLE-prototype reassignment
  `F.prototype = {foo:7}` only resolves IF that write lands in the SAME sidecar
  slot the vivify/read path uses — and if the `{foo:7}` literal is reachable as a
  real readable object (a closed WasmGC struct read by `_fnctorProtoLookup`'s
  `Object.getOwnPropertyDescriptor` returns nothing).
- (H-b) `Object.create(proto)` → real JS `Object.create` (`runtime.ts:7463`:
  `(proto)=>Object.create(proto)`). Native JS proto-walk works **only if `proto`
  is a real readable JS object**. A `{x:99}` literal that compiled to an opaque
  WasmGC struct is NOT walkable by V8's native `Object.getPrototypeOf` →
  `child.x` misses.
- (H-c) **`Object.setPrototypeOf` is a STUB in host/GC mode** (`calls.ts:5562`):
  it compiles both args, **`drop`s the proto**, and returns obj. So
  `o={}; Object.setPrototypeOf(o,{y:99}); o.y` *cannot* work host-side — the link
  is literally discarded at compile time. (Standalone routes to the native
  helper; host drops it.)
- (H-d) **`in` / HasProperty is OWN-only host-side.** `_wasmStructHasOwn`
  (`runtime.ts:2900`) consults sidecar + descriptors + registered class-proto
  method-names + static struct fields — it **never calls `_fnctorProtoLookup`**,
  so `(5 in child)` and `("foo" in new Con())` return false even when `child.foo`
  *would* resolve via the read path. The read path and the has path **disagree**.

**Unified root cause (sharpened):** there is no single canonical `[[Prototype]]`
link nor one shared walk. Standalone has ONE correct walk (`__extern_get`/
`__extern_has`) but no populate; host has THREE partial links (vivified-sidecar,
real-JS-create, dropped-setPrototypeOf) and a separate OWN-only `has`. M3's job is
to (1) pick the single link location, (2) make ONE walk that read/has/in/for-in/
host-mirror all call, (3) populate it at all five sites, in both modes.

## DECISION 1 — WHERE the `[[Prototype]]` link lives

**Standalone: the existing `$Object.$proto` field (field 0). Keep it. Do NOT add
a sidecar.**

Rationale:
- The field already exists, is already walked by `__extern_get`/`__extern_has`,
  and is already written by `__object_create`/`__object_setPrototypeOf`. A
  sidecar map would *duplicate* a working field and force every walk to consult
  two sources (the exact "N walks not one" anti-pattern the task warns against).
- **Object identity is preserved** — `$proto` is a `(ref null $Object)`, an
  intrusive link on the object itself; no external WeakMap keyed by object
  identity, no GC-liveness coupling, no canonicalization hazard (the field was
  added when `$Object` was first defined; it does NOT reopen the closed-struct /
  iso-recursive-canonicalization risk that #1100/#2009 flagged — we are *using* an
  existing field, not changing the struct shape).
- **Size**: one `ref null` slot already allocated. Zero new per-object cost.
- **The link target is always another `$Object`** (`ref null $Object`). A
  non-`$Object` proto (e.g. `Object.create(someClassInstanceExternref)`) is
  coerced to null at the write site exactly as `__object_create`/
  `__object_setPrototypeOf` already do (`ref.test $Object ? cast : null`). This is
  a known, already-shipped limitation of the standalone object model; M3 does NOT
  expand it (cross-rep proto chains — `$Object` → class-struct → `$Vec` — are a
  separate future lap, out of scope; the reachable test262 cluster is `$Object`
  → `$Object`).

**Host/GC: a single canonical link via the `_fnctorInstanceCtor` +
vivified-`prototype`-sidecar mechanism (#1712), GENERALIZED.** Do NOT add a new
parallel WeakMap; do NOT try to make the closed-struct literals natively
JS-walkable. Instead:
- Treat the **vivified `.prototype` sidecar object** (`runtime.ts:96-121`) as the
  canonical per-constructor prototype OBJECT, and the **`_fnctorInstanceCtor`
  WeakMap** (`runtime.ts:71`) as the canonical per-instance `[[Prototype]]` link.
- Add ONE new instance→proto WeakMap **`_objProto`** keyed by the instance, for
  the two host sites that today bypass the fnctor mechanism entirely
  (`Object.create`, `Object.setPrototypeOf`). `_safeGet`/`__extern_has`'s walk
  consults `_objProto` first, then falls through to `_fnctorProtoLookup`. This is
  the host analogue of `$Object.$proto`: an intrusive-by-WeakMap link the single
  shared walk reads. (A WeakMap, not a real `Object.setPrototypeOf` on the JS
  object, because the instance is an opaque WasmGC struct on which V8's native
  proto chain is unreadable for our keys — H-b's failure mode.)

**Why host can't just reuse standalone's field:** host-mode `{}` / `new F()`
instances are **host JS objects / opaque WasmGC structs (externref)**, NOT native
`$Object` structs (the native object runtime is standalone-only — `literals.ts`
#1901/#2542 gate is `ctx.standalone`). There is no `$Object.$proto` field to write
host-side. So the two modes necessarily use two link *substrates* (Wasm field vs
WeakMap) but expose ONE walk protocol (Decision 2) so call sites are mode-agnostic.

## DECISION 2 — the SHARED walk protocol (one walk, not N)

Define a single logical operation per mode that read / `in` / for-in / host-mirror
all funnel through. **Do not write a fourth walk.**

**Standalone — the walk already exists; the rule is "every dynamic op routes
through `__extern_get` / `__extern_has`, never a bespoke own-only scan":**
- Inherited NAMED read → `__extern_get(recv, key)` (walks `$proto`). ✓ exists.
- `in` / HasProperty → `__extern_has(recv, key)` (walks `$proto`). ✓ exists.
- Inherited INDEXED read `recv[i]` → `__extern_get_idx(recv, i)`
  (`object-runtime.ts:3351`). **CHANGE (M3-S):** its `$Object` array-like arm must
  reduce the index to a string key and call the proto-walking `__extern_get`
  (`number_toString(i)` → `__extern_get(recv, key)`), NOT an own-table-only
  `__obj_find`. The helper already imports `__extern_get` for the array-like arm
  (`object-runtime.ts:3347`); the change is to route the inherited-index case
  through it. Indexed HasProperty `i in recv` → `__extern_has_idx`
  (`object-runtime.ts:3623`) similarly delegates to `__extern_has`.
- for-in (#2572/#2575 lane) → enumerate own keys, then walk `$proto` and append
  each proto object's enumerable keys not already shadowed. **CHANGE (M3-D, M4):**
  `__object_keys`/the for-in key-collector currently scans own-only
  (`object-runtime.ts:~1837` `__hasOwnProperty` is explicitly own-only); for-in
  must walk `$proto`. Stage this in the for-in/`in`-cluster step, NOT the canary
  (the canary `new Con().foo` is a named read, not enumeration).

**Host — define ONE resolver `_protoChainLookup(obj, key) -> PropertyDescriptor |
undefined` that supersedes `_fnctorProtoLookup` and is the SINGLE walk:**
```
_protoChainLookup(obj, key):
  # canonical link 1: the new _objProto WeakMap (Object.create / setPrototypeOf)
  let p = _objProto.get(obj)
  while p != null (guard 16):
     desc = _readOwn(p, key)        # sidecar | wasm-struct field | native own
     if desc: return desc
     p = _objProto.get(p) ?? _nativeProtoOf(p)
  # canonical link 2: fnctor instance → ctor vivified .prototype (#1712, reused)
  return _fnctorProtoLookup(obj, key)   # unchanged body, now the TAIL of one walk
```
- `_safeGet` (`runtime.ts:~3817`) replaces its direct `_fnctorProtoLookup` call
  with `_protoChainLookup` (which still ends in `_fnctorProtoLookup`, so the #1712
  class/fnctor path is preserved verbatim — **no double-walk**: it is ONE call
  that internally tries the WeakMap chain then the fnctor tail).
- `__extern_has` host arm / `_wasmStructHasOwn`'s caller: add a proto tier so
  `in` agrees with read. **CHANGE (M3-H-has):** the `in` host path must call
  `_protoChainLookup(obj,key) !== undefined` AFTER the own-only
  `_wasmStructHasOwn` returns false — closing the read/has disagreement (H-d).
  Keep `__hasOwnProperty` own-only (it must NOT walk — §20.1.3.2).
- host-mirror Proxy (`_wrapForHost`): its `get`/`has` traps already delegate to
  `_safeGet` / the has path (`runtime.ts:~3257`, ~3979), so once those route
  through `_protoChainLookup` the mirror inherits the fix **for free** — verify,
  do not duplicate.

**Invariant for both modes:** read, `in`, for-in, and the host-mirror Proxy each
call the ONE walk for their mode (`__extern_get`/`__extern_has` standalone;
`_protoChainLookup` host). No call site re-implements a proto scan.

## DECISION 3 — the POPULATE sites (compose with #1712, no double-walk)

Five sites set the link. Each writes the canonical location from Decision 1.

| Site | Standalone (`$Object.$proto`) | Host (`_objProto` / fnctor sidecar) |
|---|---|---|
| **`{}` / object literal** | leave `$proto: null` (correct — plain objects inherit `Object.prototype`, which the native runtime models as the null-terminated chain end). NO CHANGE. | host JS `{}` already inherits `Object.prototype` natively. NO CHANGE. |
| **`Object.create(p)`** | ✓ already writes `$proto` (`__object_create`). NO CHANGE. | **CHANGE:** the host `__object_create` import (`runtime.ts:7463`) must ALSO record `_objProto.set(result, p)` when `p` is one of our opaque structs, so the shared walk can read `p`'s keys (V8's native `Object.create(opaqueStruct)` can't). Keep the real `Object.create` for the plain-JS-`p` fast path. |
| **`new F()` (fnctor)** | **CHANGE (M3-S-new, the canary):** after constructing the instance struct, set `instance.$proto = F's prototype $Object`. Requires F's `.prototype` to be a native `$Object` (Decision: synthesize a per-fnctor prototype `$Object` global, seeded from `F.prototype = …` writes; see below). | ✓ `_fnctorInstanceCtor.set(inst, ctor)` already linked (`new-super.ts:1104-1138`, `__register_fnctor_instance`). NO new link — the canary's host fix is making the *vivified-prototype write* (next row) land where `_fnctorProtoLookup` reads. |
| **`F.prototype = x`** | **CHANGE (M3-S-protoassign):** model a per-constructor prototype `$Object`. When `F.prototype = plainObjLiteral` is assigned, build that literal as an `$Object` and record it as F's prototype (a compile-time map `ctx.fnctorPrototypeObject` keyed by the fnctor name → its prototype `$Object` global), so `new F()` seeds `instance.$proto` from it. | **CHANGE (M3-H-protoassign):** route `F.prototype = x` to `_sidecarSet(ctorClosure, "prototype", x)` — the SAME slot `_getOrVivifyFnPrototype`/`_fnctorProtoLookup` read. Today a whole-prototype reassignment may not land there; make it land there, and make `x` (if an opaque struct) readable by `_fnctorProtoLookup` (it uses `Object.getOwnPropertyDescriptor`, which misses struct fields — so either build `x` as a host-readable object or have `_readOwn` consult the sidecar/struct getters). |
| **`Object.setPrototypeOf(o,p)`** | ✓ already writes `$proto` (`__object_setPrototypeOf`). NO CHANGE. | **CHANGE (the host stub fix, H-c):** `calls.ts:5562` must STOP dropping the proto. Route host/GC `setPrototypeOf` to a real host import `__object_setPrototypeOf` (host impl: `_objProto.set(o, p)` with the §10.1.2.1 cycle/extensibility check) instead of `drop`. This is the single highest-leverage host change. |

**Composition with #1712 (no double-walk):** the #1712 fnctor mechanism is
**reused as the TAIL of the one host walk**, never run in addition to it.
`_protoChainLookup` tries the `_objProto` WeakMap chain first (Object.create /
setPrototypeOf sites) and falls through to `_fnctorProtoLookup` (new F() + ctor
vivified prototype). An instance is in AT MOST one of the two link tiers
(`Object.create` result is not a fnctor instance; a `new F()` instance has no
`_objProto` entry), so the walk reads exactly one chain — no node is visited
twice. Standalone composes by construction: there is one field, one walk.

## DECISION 4 — STAGING (each independently merge_group-floor-validatable)

Gated on the static receiver mode + the static populate site so the typed/closed-
shape hot paths stay byte-identical. **Every step full-gate (merge_group /
local-ci), NEVER a scoped sweep** — this is value-rep / object-model substrate,
the `project_broad_impact_validate_full_ci` rule applies (the session's three
scoped-sweep ejects are the precedent). Stop-the-line on any eject.

- **Stage A — NAMED-read canary `new Con().foo` (smallest, highest-signal).**
  Both modes. Standalone: M3-S-new + M3-S-protoassign (per-fnctor prototype
  `$Object`, seed `instance.$proto`). Host: M3-H-protoassign (land
  `F.prototype = x` in the vivified sidecar slot `_fnctorProtoLookup` reads +
  make `x` readable). Canary assertion:
  `function Con(){}; Con.prototype={foo:7}; new Con().foo === 7` (host AND
  standalone). This is the re-grounding's first canary. **If Stage A ejects on a
  hidden typed-`.prototype`/typed-instance case, the gating is wrong — STOP**
  (mirrors the M1 stop-the-line discipline). Lands the `new F()` + `F.prototype=x`
  link; banks the named-inherited-read subset.
- **Stage B — `Object.create` + `setPrototypeOf` named reads.** Host: the
  `setPrototypeOf` stub→real-import fix (H-c) + `Object.create` `_objProto` record
  (H-b). Standalone: already works for native `$Object` `p` (verify, likely
  0-delta) — the change is ensuring the `{x:99}`/`{5:99}` literal `p` is built as
  an `$Object` so its keys are present. Canaries:
  `Object.create({x:99}).x === 99`; `o={}; Object.setPrototypeOf(o,{y:99}); o.y
  === 99`. Banks the create/setPrototypeOf reproducers.
- **Stage C — INDEXED inherited reads + `in`.** Standalone M3-S
  (`__extern_get_idx`/`__extern_has_idx` route inherited indices through the
  proto-walking `__extern_get`/`__extern_has`). Host M3-H-has (the `in` path calls
  `_protoChainLookup`, closing the read/has disagreement). Canaries:
  `proto={5:99,length:10}; Con.prototype=proto; child=new Con(); child[5]===99`;
  `(5 in child)===1`. Banks the `Object.create({5:99})[5]` indexed reproducer +
  the `in` reproducer.
- **Stage D — the generic-method cluster (`-c-i-`/`-b-i-`).** With reads + `in`
  proto-aware, `Array.prototype.forEach.call(child, cb)` etc. visit inherited
  indices correctly. Standalone: the array-method-on-arraylike path
  (`array-methods.ts`) already reads via `__extern_length`/`__extern_get_idx` →
  now proto-aware from Stage C. Host: `__proto_method_call` reads via `_safeGet` →
  now proto-aware from Stage A/B. Canary: `forEach.call(child,cb)` visits index 5
  (count 1, not 0). This is the bulk of the **168-row** cluster; expect it to flip
  largely from C's substrate, with a residual subset still needing the #983d
  method-dispatch body (track separately — do NOT block D on #983d).
- **(Deferred to M4, not M3) — for-in proto enumeration + `delete`/`hasOwnProperty`
  honoring the chain.** for-in walks `$proto` for enumerable inherited keys
  (the #2572/#2575 lane). Out of M3 scope; M3 is read + `in` + indexed +
  generic-method. Flag for M4 so the for-in lane sequences after M3's walk lands.

Order rationale: A (named, the existing-link-populate proof, both modes) → B
(create/setPrototypeOf, the host stub fix) → C (indexed + `in`, the
read/has-agreement fix) → D (generic-method, the row bulk). Each banks a distinct
reproducer; A is the canary that proves the populate+walk wiring before C/D scale
it.

## TDD canaries (the 4 reproducers from the Suspended Work resume steps)

Drive each stage with these (all wrong on current main, host AND standalone
identical — see the re-grounding bisection). Add as a dedicated regression suite
`tests/issue-2580-m3-protochain.test.ts`, run BOTH modes:
1. `function Con(){}; Con.prototype={foo:7}; new Con().foo` → want 7 (Stage A)
2. `Object.create({x:99}).x` → want 99; `Object.create({5:99})[5]` → want 99
   (Stage B named / Stage C indexed)
3. `o={}; Object.setPrototypeOf(o,{y:99}); o.y` → want 99 (Stage B)
4. `proto={5:99,length:10}; Con.prototype=proto; child=new Con();`
   `(5 in child)` → want 1; `Array.prototype.forEach.call(child,cb)` visits index
   5 → want count 1 (Stage C / D)

## RUNNER TRAP — flag prominently for the implementing dev

> ⚠️ **VALIDATE PER-PROCESS, NOT an in-process `runTest262File` loop.** Bucketing
> the 170 `-c-i-`/`-b-i-` rows IN ONE in-process loop falsely reports ~42 as
> `compile_error: Cannot read properties of undefined (reading 'kind')` — a
> TS-parser (`createSourceFile` → `canHaveModifiers`) crash from cross-compile
> state bleed in the in-process runner. It is FALSE: each test in a FRESH process
> is a clean result. Use the sharded `compiler-fork-worker.mjs` (one fork per
> test, the path that records the committed JSONL) — it is unaffected. Always
> isolate per-process when measuring this cluster, and treat the FULL merge_group
> floor as the only authoritative conformance signal (never a scoped sweep).

## Risk register

- **Hot-path byte-identity (prime directive).** Gate every change on the dynamic
  receiver mode + populate site. Typed/closed-shape instances (`class C` with a
  static struct, `number[]`, typed `new TypedClass()`) must NOT enter the new
  arms — they have a compile-time-known shape and their `.foo`/`[i]` reads are
  struct.get/vec.get, untouched. Stage A's canary is the regression tripwire.
- **The standalone non-`$Object` proto target** (a class-struct or `$Vec` as a
  proto) is coerced to null at the write site (existing `__object_create`/
  `__object_setPrototypeOf` behavior). M3 does NOT add cross-rep proto chains;
  if a reachable test needs `$Object`→class-struct inheritance, that is a tracked
  follow-on, not an M3 eject.
- **Host `setPrototypeOf` cycle check** (§10.1.2.1) — port the standalone helper's
  cycle/extensibility logic into the new host import; do NOT ship a host
  `_objProto.set` without it (a cyclic chain would loop the 16-guard walk; keep
  the guard AND refuse cycles).
- **`__hasOwnProperty` / `propertyIsEnumerable` must stay own-only** (§20.1.3.2/4)
  even after `in` becomes proto-aware — they are separate predicates; do not route
  them through the proto walk.
- **for-in is M4, not M3** — keep it out of scope so the M3 walk lands without the
  enumeration-shadowing complexity; sequence the #2572/#2575 for-in lane after.

## Files / functions to touch (precise sites)

- **Standalone link + walk (mostly exists):** `src/codegen/object-runtime.ts` —
  `__extern_get_idx` (`:3351`, body `buildExternGetIdxBody`) and `__extern_has_idx`
  (`:3623`): route inherited indices through `__extern_get`/`__extern_has`
  (Stage C). `__new_plain_object` (`:631`) stays `$proto: null` (no change).
- **Standalone populate:** `src/codegen/expressions/new-super.ts`
  `compileFnctorNew` (the `__fnctor_<name>` ctor builder, ~`:998`-1166): after
  constructing the instance, set `instance.$proto` to F's prototype `$Object`
  (Stage A). New compile-time map `ctx.fnctorPrototypeObject` (add to
  `src/codegen/context/types.ts`) keyed by fnctor name → prototype `$Object`
  global; seeded by the `F.prototype = x` assignment site
  (`src/codegen/object-ops.ts` / the property-write path).
- **Host link + walk:** `src/runtime.ts` — add `_objProto` WeakMap (near
  `_fnctorInstanceCtor`, `:71`); add `_protoChainLookup` (supersede the direct
  `_fnctorProtoLookup` call in `_safeGet`, `:~3817`); add the proto tier to the
  `in`/HasProperty host path (after `_wasmStructHasOwn`, `:2900`). `__object_create`
  import (`:7463`): record `_objProto` for opaque-struct protos.
- **Host setPrototypeOf stub fix:** `src/codegen/expressions/calls.ts` `:5562`
  (the GC/host arm) — replace the `drop` with a real `__object_setPrototypeOf`
  host import; implement that import in `src/runtime.ts` (`_objProto.set` + cycle
  check) (Stage B).
- **Host `F.prototype = x`:** the property-write path for a `.prototype` LHS on a
  fnctor — land the assignment in `_sidecarSet(ctor,"prototype",x)` and ensure
  `_fnctorProtoLookup`'s `_readOwn` can read `x`'s keys when `x` is an opaque
  struct (Stage A).
- **Tests:** `tests/issue-2580-m3-protochain.test.ts` (new), both modes.

## Estimate / sequencing note

~3–5 senior-dev days as the re-grounding sized, but **Stage A is a ~1–2 day
landable canary** (the standalone walk + host fnctor mechanism already exist; A is
populate-wiring + the host vivified-slot fix). B is the host `setPrototypeOf`
stub→import fix (~1 day, the single highest-host-leverage change). C is the
indexed + `in` agreement (~1–2 days). D rides on A–C's substrate plus #983d
coordination for the residual. **Hold B–D behind Stage A's full-gate result.**
This is senior-dev / value-rep lane (coordinate `project_standalone_any_string_
value_read_substrate`); NOT dev-claimable until Stage A's gating is proven.

---

# M3 — STAGE A: SPEC MIS-ATTRIBUTED — DEFER (verified 2026-06-23, sd-value-rep, max-reasoning)

> Per the implementer's verify-before-commit guardrail (architect specs this
> session proved fallible — the #2623 Slice-A spec mis-attributed its mechanism
> end-to-end). I drove the 4 TDD canaries against CURRENT main with a faithful
> **per-process** harness (`.tmp/repro.mjs` — one snippet, one mode, one fresh
> `WebAssembly.instantiate`, both host + standalone). The fault reproduces, but
> **Stage A's specified mechanism does not match the actual fault** — the same
> failure class as #2623-A. NO code landed; this is a clean docs-only stop.

## What I verified (faithful per-process, NOT the in-process loop trap)

The canary `function Con(){}; Con.prototype = {foo:7}; new Con().foo`:
- **HOST** → `undefined` (spec said "NaN"; the NaN was the test262 runner's numeric
  coercion of the `undefined` miss — confirmed: the raw `.foo` value is `undefined`).
- **STANDALONE** → numeric `0` (the inherited read misses; `typeof v === "number"`).

Both wrong, both modes — consistent with the re-grounding's headline. So the
*symptom* is real. But bisecting the *mechanism* contradicts the spec's
link-location decision in BOTH modes:

### STANDALONE — the spec's "seed `instance.$proto`" is NOT IMPLEMENTABLE as written

The spec (Decision 1 + M3-S-new) says: reuse the existing `$Object.$proto` field
(field 0), and `new F()` should "set `instance.$proto = F's prototype $Object`."
**But a standalone `new Con()` instance is NOT an `$Object`** — it is a bespoke
`$__fnctor_Con` struct built field-by-field from the ctor's `this.x=` assignments
(`new-super.ts:998` `struct.new ${structName}`, fields collected at ~981). For the
canary `function Con(){}` (empty body) the struct is literally `(struct )` — **no
fields, and crucially NO `$proto` field to seed.** Verified from the emitted WAT:
`(type $__fnctor_Con (struct ))`. The `c.foo` read routes through the M2 reader
`emitDynGet` → `__dyn_get` → `__extern_get`, whose `$proto` walk only knows
`$Object` (`object-runtime.ts:844` `struct.get $Object 0`); it `ref.test $Object`
MISSES the `$__fnctor_Con` struct and returns absent.

So "seed `instance.$proto`" has no field to write. Closing the standalone canary
requires one of (all object-model-substrate, NOT the ~1–2-day populate-wiring the
spec promised, and all with the broad blast radius Stage A was meant to AVOID):
1. **Add a `$proto` field to every `$__fnctor_<name>` struct** — shifts every
   fnctor own-field index, the `this.x=` write paths, and the own-field
   `struct.get`; AND teach `__extern_get`/`__extern_has`'s walk a new arm that
   recognizes fnctor structs and reads *their* `$proto` (today it only walks
   `$Object`). Two walks, the anti-pattern the spec itself warns against.
2. **Construct fnctor instances as `$Object`s** — changes object identity for
   every `new F()` (Decision 1's explicitly-rejected option (b), "far larger
   blast radius").
3. A per-fnctor compile-time prototype-`$Object` map + a NEW fnctor-struct read
   arm in `__extern_get` — still a new walk + a struct-shape interaction.

The spec's premise "the standalone walk machinery already exists; the gap is
purely POPULATE" is the mis-attribution: the walk exists **only for `$Object`**,
and the canary's receiver is never an `$Object`. There is no `$proto` to populate.

> **Counter-evidence the spec missed (and the actually-tractable seam):** the
> standalone `$proto` walk *does* work when the receiver IS a real `$Object` with
> a materialized `$Object` proto — `const p:any={foo:7}; const c:any=Object.create(p);
> c.foo` → **7** ✓, and `const p:any={foo:7}; const o:any={}; Object.setPrototypeOf(o,p);
> o.foo` → **7** ✓ (both verified). Only the **inline-literal** proto arg
> (`Object.create({foo:7})`) regresses to `0` — a literal-materialization gap, not
> a walk gap. So the genuinely landable standalone first-canary is NOT the fnctor
> `new Con()` (Stage A) but the **`Object.create`/`setPrototypeOf` named-proto
> path, already green**, with a narrow inline-literal-as-`$Object` fix — i.e. the
> spec's Stage B is *more* tractable standalone than its Stage A.

### HOST — the spec's H-a link is ABSENT for the canary's exact shape, + the write is dropped

Spec H-a: "`new F()` instances link to their ctor via `_fnctorInstanceCtor`;
a miss resolves through `_fnctorProtoLookup`." Verified FALSE for the canary:
- For a **plain `function Con(){}` declaration**, there is NO closure global, so
  the `__register_fnctor_instance` emission is gated OFF (`new-super.ts:1118-1138`
  requires `ctx.moduleGlobals.get(funcName) ?? ctx.funcClosureGlobals.get(funcName)`,
  which is `undefined` for a hoisted decl). Confirmed from the emitted imports:
  the canary module imports only `__extern_get`/`__box_number`/`__unbox_number` —
  **no `__register_fnctor_instance`** — so the instance→ctor link is never
  established. `_fnctorProtoLookup` returns `undefined` for the canary instance.
  (The #1712 mechanism the spec leans on fires only for a *closure-valued*
  `const Con = function(){}` — verified: `const Con=function(){}; Con.prototype.foo=7;
  new Con().foo` → **7** ✓. The canary uses a declaration, which the link skips.)
- The whole-object write `Con.prototype = {foo:7}` is **dropped entirely** — no
  host call is emitted for it (verified in WAT: no `__extern_set`, no sidecar
  write). Even `(Con as any).prototype.foo` reads `undefined` directly.
- `Object.create(namedProtoVar)` host → `undefined`/NaN too (H-b: V8's native
  `Object.create(opaqueStruct)` can't walk our struct's keys).

So host Stage A is THREE gaps stacked (no link for declarations · dropped write ·
unreadable opaque-struct proto), not the single "land the write in the vivified
slot" the spec scoped.

## VERDICT: Stage A as specified is mis-attributed — DEFER, do not force

This is the #2623-A failure class the task flagged: the spec's central mechanism
("populate the existing `$proto`/vivified-slot — ~1–2 days") does not match the
fault. The standalone canary has **no `$proto` field on the fnctor instance to
populate** (the receiver is never an `$Object`); the host canary has **no
instance→ctor link for a function declaration** plus a **dropped prototype write**.
Forcing it means an object-model struct-shape change (add `$proto` to every fnctor
struct, or reconstruct fnctor instances as `$Object`s) + a second walk arm — the
exact broad-blast-radius, hot-path-regression-prone substrate change Stage A's
"smallest, highest-signal canary" framing was designed to avoid, and the
stop-the-line tripwire ("if Stage A ejects on a typed-instance case, gating is
wrong → STOP") would almost certainly fire.

**Recommended re-spec (flagged to lead):**
1. **Re-pick the standalone canary**: the fnctor `new Con()` is the *hardest*
   standalone shape, not the easiest — its instance isn't an `$Object`. The
   genuinely-landable standalone first canary is the **`Object.create` /
   `setPrototypeOf` named-proto path (already green)** + a narrow
   inline-literal-proto-as-`$Object` materialization fix. Make that the new Stage A.
2. **Decide the fnctor-instance representation explicitly** (the real Decision 1
   the spec skipped): does a standalone `new F()` instance carry a `$proto` (struct
   field, with the index-shift + walk-arm cost), or is it reconstructed as an
   `$Object`? This is an architect call, not a populate-wiring task — and it is
   the precondition for the fnctor named-read AND the indexed/`in`/generic-method
   stages (C/D) that all assume the instance participates in the `$proto` walk.
3. **Host**: emit `__register_fnctor_instance` for **function-declaration** ctors
   too (not only closure-valued ones), and land `F.prototype = x` in the
   `_fnctorProtoLookup`-read sidecar slot AND make an opaque-struct `x` readable —
   three concrete sub-fixes, each its own small gated PR, none of which is the
   single "vivified-slot write" the spec named.

No source changed. Per-process harness was in `.tmp/` (gitignored). Issue stays
`in-progress`; claim released. This finding is the durable deliverable — the spec
needs the fnctor-instance-representation decision before Stage A is implementable.

---

# M3 — CORRECTED Implementation Plan + Stage A LANDED (2026-06-23, sd-value-rep-m3, max-reasoning)

> Verify-first. Re-ran the 4 TDD canaries + a 6-shape seam matrix
> **per-process** (one snippet · one mode · one fresh `WebAssembly.instantiate`)
> against current `main`, then bisected the standalone failure to the emitted WAT.
> This confirms the prior session's DEFER verdict AND finds the genuinely-landable
> first slice the brief pointed at. **Stage A (inline-literal proto
> materialization) is implemented in this PR.**

## THE ARCHITECTURE DECISION (fnctor-instance `[[Prototype]]` representation)

The prior session asked the right question and stopped at it: a standalone
`new Con()` instance is a bespoke `$__fnctor_<Name>` struct (empty ctor body →
`(struct )`, no `$proto` field), NOT an `$Object`, so the `$proto` walk in
`__extern_get`/`__extern_has` misses it. There is **nothing to populate** on a
fnctor struct. Decided:

**DECISION (fnctor instances): reconstruct/route fnctor `new F()` instances so
they participate in the `$Object.$proto` walk — option (ii) over option (i).**
Rationale, weighed:

- **Option (i) — add a `$proto` field to every `$__fnctor_<Name>` struct + a 2nd
  walk arm.** REJECTED for the fnctor lap. It is the broad-blast-radius change the
  task warns against: it shifts every fnctor own-field index (the `this.x=` write
  paths + own-field `struct.get`), AND forces `__extern_get`/`__extern_has` to
  carry a SECOND walk arm that recognizes fnctor structs and reads *their*
  `$proto` (today the walk is `$Object`-only, `object-runtime.ts:844`
  `struct.get $Object 0`). Two walks is exactly the "N walks not one" anti-pattern
  the spec itself forbids. It also re-enters the iso-recursive-canonicalization
  hazard zone (#1100/#2009) by changing a closed struct's shape.
- **Option (ii) — make fnctor instances `$Object`-participating (one walk).**
  CHOSEN. The single canonical link stays `$Object.$proto` (field 0, already
  walked by `__extern_get`/`__extern_has`, already written by
  `__object_create`/`__object_setPrototypeOf`). The fnctor lap's job is to make a
  `new F()` instance's reads resolve through that ONE walk — either by allocating
  the instance as an `$Object` (when it has no typed-struct consumers) or by
  synthesizing a per-fnctor prototype `$Object` global the instance's dynamic
  reads consult. This is bigger than Stage A and is the **fnctor lap** below; it
  does NOT block the inline-literal slice, which needs no fnctor change at all.

This keeps the invariant: **ONE link location (`$Object.$proto`), ONE walk
(`__extern_get`/`__extern_has`).** No second walk arm, no struct-shape change to
closed types.

## STAGING — re-ordered so the genuinely-landable slice goes FIRST

The prior spec's Stage A (the fnctor `new Con().foo` canary) is the **hardest**
standalone shape, not the easiest (its receiver is never an `$Object`). The brief's
guidance is correct and verified: **`Object.create(namedProtoVar)` /
`setPrototypeOf(o, namedProtoVar)` ALREADY work standalone; only INLINE-LITERAL
protos regress.** So the new staging:

- **Stage A (THIS PR) — inline-literal-proto materialization, standalone.** Narrow,
  no struct-shape change, no fnctor change. Build the inline-literal proto operand
  of `Object.create({…})` / `Object.setPrototypeOf(o,{…})` as a native `$Object`
  so `ref.test $Object` succeeds and `__object_create`/`__object_setPrototypeOf`
  record the link. The existing `$proto` walk then resolves inherited NAMED and
  INDEXED reads. **Landed below.**
- **Stage B (next) — the fnctor lap (option ii), standalone.** `new F()` /
  `F.prototype = x` participate in the `$Object` walk. The architecture decision
  above. ~3–5 days, the real object-model substrate.
- **Stage C — host/GC `[[Prototype]]`.** ALL host shapes currently → NaN (even
  named-var `Object.create`/`setPrototypeOf` — verified). Host needs the
  `_objProto` WeakMap + the `setPrototypeOf`-stub→real-import fix (calls.ts:5562
  still `drop`s the proto in host mode) + `Object.create` recording opaque-struct
  protos. Separate, larger; do NOT block on it.
- **Stage D — generic-method cluster (`-c-i-`/`-b-i-`, the 168-row bulk)** rides on
  B/C once `new F()`-instance + host reads are proto-aware.

## Stage A — ROOT CAUSE (bisected from the emitted WAT, standalone)

`const c:any = Object.create(p)` where `p` is a **named var** `const p:any={foo:7}`
emits: `call __new_plain_object` + `call __extern_set` (a real `$Object`) → stored
in `$p` → `call __object_create` on that `$Object` externref. `__object_create`'s
`ref.test $Object` SUCCEEDS → writes `$proto` → `c.foo` walks the chain → **7**. ✓

`const c:any = Object.create({foo:7})` (INLINE literal) emits instead:
```
f64.const 7
struct.new 82          ;; CLOSED-shape literal struct (the literal's own type), NOT $Object
extern.convert_any
call __object_create    ;; proto is a closed struct → ref.test $Object FAILS → coerced to null
```
The inline literal's TS contextual type is a CONCRETE object type (not `any`), so
`compileObjectLiteral` picks the closed-shape struct path (`struct.new <typeIdx>`),
which `ref.test $Object` MISSES. `__object_create` coerces a non-`$Object` proto to
null (by design) → `c.foo` walks a null `$proto` → absent → **0**. ✗

This is the **same bug class as the merged #2076 `Object.assign` fix**:
`__object_assign` also reads operands via `ref.test $Object`, and a closed-struct
literal silently dropped its props. The fix template already exists in-tree
(`compileObjectAssignArg`, calls.ts).

## Stage A — THE FIX (implemented, 2-site + 1 shared helper, standalone-gated)

`src/codegen/expressions/calls.ts`:
- New helper `compileProtoArg(ctx, fctx, arg)` — mirrors `compileObjectAssignArg`:
  when `arg` is a plain data-property / spread object literal (the same shapes the
  `$Object` builder accepts) AND `ctx.standalone`, build it via
  `compileObjectLiteralAsExternref` (a real `$Object`); else fall through to the
  ordinary `compileExpression(arg, externref)`. Pushes `ref.null.extern` when the
  expression yields no value (stack-balance for the consuming call).
- `Object.create(proto)` standalone arm (~5757): the non-`null` proto compile now
  routes through `compileProtoArg`. `null`, `Foo.prototype` fast path, and the
  descriptor 2nd-arg static-expansion are all unchanged.
- `Object.setPrototypeOf(obj, proto)` standalone arm (~5540): the proto compile now
  routes through `compileProtoArg` (it already null-guards via the helper).

**Hot-path byte-identity:** the change is gated on `ctx.standalone` AND
`ts.isObjectLiteralExpression(arg)`. Host/GC mode is untouched (the entire host
`__object_create`/`setPrototypeOf`-stub path is byte-identical). Non-literal protos
(identifiers, calls, `Foo.prototype`, `null`) take the unchanged ordinary path.
Typed `.length` / array hot paths never enter these arms.

## Stage A — VERIFICATION (per-process, both modes; the runner-trap avoided)

Seam matrix, standalone, BEFORE → AFTER:
- `Object.create({foo:7}).foo`            0 → **7** ✓
- `Object.setPrototypeOf(o,{foo:7}); o.foo` 0 → **7** ✓
- `Object.create({5:99})[5]` (indexed)    0 → **99** ✓ (indexed inherited read also
  fixed — `__extern_get_idx` routes through the now-populated `$proto` walk)
- `Object.create({foo:7}).foo` with own shadow `c.foo=9` → **9** ✓
- named-var proto (regression guard)      7 → **7** ✓ (unchanged)
- `Object.create(null)` absent read → undefined ✓; `Object.create(Foo.prototype)`
  class fast path ✓; `setPrototypeOf(o,null)` ✓; array `.length` → 3 ✓.

Regression suite `tests/issue-2580-m3-protochain.test.ts` (11 cases) green; `tsc`
+ `prettier` clean. Sibling 2580 suites green. `prototype-chain.test.ts` (6/11) and
`object-create.test.ts` (missing `./helpers.js`) fail IDENTICALLY on clean
origin/main — **pre-existing test-harness artifacts, not this change** (verified
against `/workspace`).

## KNOWN-ORTHOGONAL (NOT this slice; do not chase in Stage A)

`c.a + c.b` reading TWO inherited `any`-typed props in one `+` expression returns
0 — but so does `p.a + p.b` reading two OWN props of a plain `any` object **on
clean origin/main** (verified). It is a pre-existing `any + any` arithmetic-add bug
(the #2580 M1/core uniform-externref *consumer* issue, NOT the proto LINK). My
slice fixes the link; single-read inherited access is fully correct. Stored-to-local
sums (`const x=c.a; const y=c.b; return x+y`) → 30 ✓, proving the values resolve.
Track the add-path bug with M1/core, not M3.

## Files changed (Stage A)

- `src/codegen/expressions/calls.ts` — `compileProtoArg` helper + 2 standalone
  call-site routings (Object.create proto, Object.setPrototypeOf proto).
- `tests/issue-2580-m3-protochain.test.ts` — new standalone regression suite.

This is value-rep / object-model substrate → the merge_group standalone floor
(#2097, runs only in merge_group) is the authoritative gate. Stop-the-line on any
eject (broad-impact value-rep) and escalate; fix-forward once, never re-enqueue,
never force-push public main.

---

# M3 — STAGE B SCOPING + CONTINUATION HANDOFF (2026-06-23, sd-value-rep-m3, max-reasoning)

> Verify-first re-ground of the fnctor `new F()` lap against current main (with
> Stage A landed). Per-process probes (NOT in-process loops — the runner trap).
> **Conclusion: Stage B has NO small, safe, bankable sub-slice that lands in one
> verified pass.** Every entry point needs populate + link machinery together,
> and it is broad-impact value-rep where a floor eject is the documented risk
> (#1888 −162). Recording the representation decision + the precisely-scoped
> sub-slice breakdown as a continuation handoff rather than rushing a half-built
> broad change into the queue. NO Stage B code landed this pass.

## Re-ground (per-process, both modes, current main + Stage A)

| reproducer | standalone | host (gc) |
|---|---|---|
| `function Con(){}; Con.prototype={foo:7}; new Con().foo` (canary) | **0** ✗ | **NaN** ✗ |
| `function Con(){}; Con.prototype.foo=7; new Con().foo` | **0** ✗ | **NaN** ✗ |
| `const Con=function(){}; Con.prototype.foo=7; new Con().foo` | **0** ✗ | **7** ✓ |
| `const Con=function(){}; Con.prototype={foo:7}; new Con().foo` | **0** ✗ | **0** ✗ |
| `function Con(this:any){this.x=3;} new Con().x` (OWN field) | **3** ✓ | **3** ✓ |

Read-path bisected from emitted WAT (standalone canary): `new Con()` →
`call $__fnctor_Con_new` → `extern.convert_any` (box) → `c.foo` lowers to
`call __extern_get(instance, "foo")`. `__extern_get` does `ref.test $Object`
(object-runtime.ts:767) and **returns null immediately** for the non-`$Object`
`$__fnctor_Con` struct — the proto walk (`struct.get $Object 0`, :844-848) only
knows `$Object`. So the receiver dead-ends before any walk. OWN fields work
because they read through the typed `struct.get` path, not `__extern_get`.

## DECISION 1 (confirmed concrete): fnctor-instance representation = option (ii)

Route `new F()` instances through the ONE `$Object.$proto` walk; do NOT add a
`$proto` field to the bespoke `$__fnctor_<Name>` struct (option (i) — rejected:
shifts every fnctor own-field index, forces a SECOND walk arm = "N walks not one"
anti-pattern, re-enters the iso-recursive-canonicalization hazard #1100/#2009 by
changing a closed struct's shape). Two concrete realizations of (ii), both require
the SAME two pieces (populate F's prototype as an `$Object` + link the instance to
the walk):

- **(ii-a) Reconstruct the dynamically-used instance AS an `$Object`** — at
  `new F()`, when F is used dynamically (any-typed reads, the test262 cluster
  shape), build an `$Object` whose own props are the `this.x=` fields and whose
  `$proto` is F's prototype `$Object`. Own-field reads then go through
  `__extern_get` (already how the cluster reads them — these instances are passed
  to `Array.prototype.forEach.call(child, cb)` as `any`, never read via typed
  `struct.get`). Empty-body fnctors (`function Con(){}`, the canary) have NO own
  fields → trivially an empty `$Object` + `$proto`. **This is the chosen
  realization** — it keeps ONE walk and one link, and the cluster's instances are
  already consumed dynamically.
- (ii-b) Keep the `$__fnctor_<Name>` struct + teach the walk a fnctor→prototype
  sidecar — rejected: needs a sidecar (contradicts "one link") and a fnctor-arm in
  the walk (contradicts "one walk").

## DECISION 2: the missing machinery (what Stage B must BUILD — not just wire)

There is no pre-existing per-fnctor prototype `$Object` standalone, and the
host declaration-ctor has no closure global. Stage B must build, IN BOTH MODES:

1. **A per-fnctor prototype object** (standalone: an `$Object` global per fnctor
   name; host: the vivified-`.prototype` sidecar #1712 already exists for
   closure-valued fns — extend to declarations).
2. **Populate it** from `F.prototype = x` (whole reassign) AND `F.prototype.p = v`
   (per-prop) writes — neither lands today (the writes are effectively dropped:
   standalone canary `c.foo`→0, host `cfe-whole`→0).
3. **Link `new F()` to it** — standalone (ii-a): build the instance as an `$Object`
   with `$proto` = the per-fnctor prototype `$Object`. Host: emit
   `__register_fnctor_instance` for DECLARATION ctors too (today gated off at
   new-super.ts:1118-1138 because a declaration has no `moduleGlobals`/
   `funcClosureGlobals` entry — confirmed from WAT: no `__register_fnctor_instance`
   import for `function Con(){}`).

## Why NO sub-slice banks rows alone (the honest blocker)

The canary needs populate (#2) AND link (#3) together — neither alone resolves
`c.foo`. The narrowest host sub-slice (B-host-1: register declaration-ctors) is
NOT a one-line gate-widen: a declaration lacks the closure global that BOTH the
link and the prototype-write vivify-slot key against, so it must first MINT a
closure global for declaration-ctors and route the prototype-write to it. The
narrowest standalone sub-slice (empty-body fnctor as `$Object`) still needs the
prototype-write→`$Object` populate, which does not exist. So the smallest
bankable unit IS the full populate+link lap — ~3-5 days, broad-impact value-rep.

## PRECISE CONTINUATION (next senior-dev session, value-rep lane)

Implement realization (ii-a), staged; each step full-gate (merge_group floor
#2097 authoritative), stop-the-line on any eject. Start STANDALONE (the walk
already exists; host adds the declaration-global complexity):

- **B1 (standalone populate) — per-fnctor prototype `$Object`.** Add
  `ctx.fnctorPrototypeObject: Map<string, globalIdx>` (context/types.ts). On
  `F.prototype = {literal}` / `F.prototype.p = v` for a fnctor `F` (NOT a class),
  build/extend an `$Object` global (via `compileObjectLiteralAsExternref` for the
  whole-reassign case; `__extern_set` on the global for per-prop). Gate: `F` is in
  `funcConstructorMap` and NOT in `classSet`. Standalone-only. NO rows yet (no
  reader) — validates the global builds + is dead-elim-safe. Low risk.
- **B2 (standalone link) — `new F()` builds an `$Object` with `$proto`.** At
  compileFnctorNew (new-super.ts:998-1166), when F has a `fnctorPrototypeObject`
  entry AND the instance is used dynamically, emit an `$Object`
  (`__new_plain_object`) with own props = the `this.x=` fields (via `__extern_set`)
  and `$proto` = the fnctor prototype `$Object` global, INSTEAD of the bespoke
  struct. Gate strictly so typed class instances + non-dynamic fnctors are
  byte-identical (the hot-path tripwire — if B2 ejects on a typed-instance case the
  gate is wrong → STOP). Banks the standalone canary + indexed/`in` (Stage C reads
  ride free once `$proto` is populated). **The row-banking slice; highest risk.**
- **B3 (host) — declaration-ctor link + whole-prototype-reassign vivify-slot.**
  Mint a closure global for declaration-ctors; widen the new-super.ts:1118 gate to
  register them; route `F.prototype = x` whole-reassign into the
  `_fnctorProtoLookup`-read sidecar slot (today only per-prop on closures lands).
  Reuses #1712 verbatim. Banks the host canary.
- **B4 (Stage C/D ride) — indexed inherited + generic-method cluster.** Once B2/B3
  populate `$proto`, the indexed `__extern_get_idx` arm + `forEach.call(child,cb)`
  visit inherited indices (the 168-row `-c-i-`/`-b-i-` bulk). Largely free from
  the substrate; residual needs #983d method-dispatch (track separately).

TDD canaries (all in `tests/issue-2580-m3-protochain.test.ts`, extend it):
`function Con(){}; Con.prototype={foo:7}; new Con().foo` → 7 (B2 standalone / B3
host); `Con.prototype.foo=7` variant; `new Con().x` own field stays 3 (regression
guard); the indexed + `forEach.call` cluster (B4).

RUNNER TRAP: validate per-process (one snippet, one mode, fresh instantiate), NOT
an in-process `runTest262File` loop (false `compile_error reading 'kind'` from
cross-compile state bleed). Full merge_group floor is the only authoritative
conformance signal.

## Status

NO Stage B code landed (correctly — no bankable one-pass sub-slice; rushing
broad value-rep risks the #1888-class floor eject). Stage A (PR #1975) is the
banked deliverable. Representation decision (option ii / realization ii-a) +
the B1→B4 staging is the durable handoff. Issue stays `in-progress`.

---

# M3 — STAGE B DEDICATED SESSION: independent verify-first re-ground + cluster-composition CORRECTION (2026-06-24, sd-value-rep-m3-stageB, max-reasoning)

> Dedicated Stage-B session off current main (Stage A + handoff landed). Drove the
> canaries AND the REAL cluster test262 files **per-process** (one snippet/file ·
> one mode · fresh instantiate; the in-process-loop trap avoided) + decoded the
> emitted WAT. Two outcomes: (1) the prior session's "no bankable one-pass Stage-B
> sub-slice" verdict is **independently CONFIRMED** — and the closure-isn't-an-
> `$Object` mechanism nailed down precisely; (2) a **material correction to the
> cluster composition** that re-frames where the 168 rows actually live. **NO Stage
> B code landed** — there is no small, verified-safe, row-banking increment, and
> the handoff's B1 scaffold banks 0 rows with no de-risking value (it is not a
> reusable primitive like M0's `__dyn_has`; its only consumer is the high-risk B2).

## CORRECTION 1 — the 168-row `-c-i-`/`-b-i-` cluster is NOT primarily the fnctor `new F()` lap

The handoff (and the Stage-B brief) framed the 168-row bulk as the fnctor
`new F()` `[[Prototype]]` lap (Decision ii-a, the `Con.prototype = proto; new Con()`
shape). **Measured against the actual test262 bodies, that shape is a MINORITY.**
Counts over the 266 `-c-i-`/`-b-i-` files under `Array/prototype/`:

| construction mechanism | files | what it needs |
|---|---|---|
| **`Object.defineProperty`** (own/inherited ACCESSOR props on `{length:N}`) | **181** | `$Object` accessor-`Get` arm + generic-method HasProperty-visit |
| `.prototype =` assignment (the fnctor lap) | 51 | the fnctor `new F()` `$proto` link (ii-a) |
| `.prototype[idx]` / `Object.prototype[i]=v` | 41 | inherited read on a plain receiver via `Object.prototype` (the built-in) |
| `arguments` object | 27 | `arguments`-as-array-like generic-method read |
| `new <ctor>` (incl. `new Boolean()` etc., not only user fnctors) | 71 | mixed |

So the dominant lever is **`Object.defineProperty` accessor reads on array-like
`{length:N}` objects passed to `Array.prototype.X.call(obj, cb)`** — the `$Object`
accessor + generic-method-HasProperty path, **independent of any fnctor**. The
fnctor lap (Decision ii-a) addresses ~51 files, not the 168 bulk.

Representative bodies (verified, real test262):
- `forEach/15.4.4.18-7-c-i-17`: `obj={length:2}; Object.defineProperty(obj,"1",{set:fn});
  forEach.call(obj,cb)` — visit index 1 (accessor present, get→undefined). NO fnctor.
- `indexOf/15.4.4.14-9-b-i-8`: `Object.prototype[0]=true; indexOf.call({length:3},true)`
  — inherited-from-`Object.prototype` data read on a plain literal. NO fnctor.
- `some/15.4.4.17-7-c-i-15`: `proto={}; Object.defineProperty(proto,"1",{get});
  var Con=function(){}; Con.prototype=proto; child=new Con(); child.length=20;
  some.call(child,cb)` — THIS is the fnctor lap (the `.prototype=` subset). Verified
  `fail` via `runTest262File` in BOTH host AND standalone (one fresh process each).

## CORRECTION 2 — the shared standalone blocker is the generic-method host-import leak, BELOW the proto substrate

The whole standalone array-like-method cluster is blocked by a more basic gap than
proto-walking: **`Array.prototype.X.call(arrayLike, cb)` emits a host import even
in standalone mode** and cannot instantiate at all. Verified per-process (WAT):

```
forEach.call({0:5,1:6,length:2}, cb)  --target standalone
→ (import "env" "__make_callback" (func ... ))   ;; host-callback bridge
→ WebAssembly.instantiate(binary, {}) → "Import #0 env: module is not an object"
```

This is the generic-method *dispatch* not being standalone-native (the #983d /
`__make_callback` lane), NOT the `$proto` substrate. It blocks **even the simplest
own-data array-like** (`{0:5,1:6,length:2}`) standalone — no inheritance, no
accessor, no fnctor involved. So a proto-walk fix banks **zero standalone cluster
rows** until this host-import leak is closed first. (Host mode HAS the
generic-method machinery — `forEach.call({0:5,1:6,length:2})` → 11 ✓ host — but
its accessor/inherited HasProperty-visit is incomplete, so the cluster fails host
too: all three real files above → `fail` host AND standalone via `runTest262File`.)

## CONFIRMED — the fnctor lap is genuinely blocked (closure is not an `$Object`)

Independently reproduced the handoff's blocker and pinned the exact mechanism from
the WAT. For `const Con=function(){}; Con.prototype={foo:7}`:
- `Con.prototype = {foo:7}` compiles to: build the proto as a real `$Object`
  (`__new_plain_object` + `__extern_set($proto,"foo",...)`), then
  `__extern_set($closure, "prototype", $proto)` where `$closure` is the
  **`$6` trampoline struct** (`struct.new $6 (ref.func $__fn_tramp_Con_cached)`),
  NOT an `$Object`. `__extern_set`'s `ref.test $Object` MISSES the `$6` closure →
  **the prototype write lands nowhere readable.**
- Read-back `Con.prototype` → `__extern_get($closure,"prototype")` → `ref.test
  $Object` misses `$6` → null → `RUN_FAIL`/absent. Verified: reading
  `(Con as any).prototype` back standalone traps/returns non-`$Object`;
  `Object.create((Con as any).prototype).foo` → 0 (the proto arg isn't a readable
  `$Object`).
- `new Con()` → `$__fnctor_Con_new` returns a bespoke `$__fnctor_Con` struct
  (empty body → `(struct )`), NOT an `$Object`; the `c.foo` read dead-ends at
  `__extern_get`'s `ref.test $Object` miss. (The earlier session's bisection,
  re-confirmed.)

So the fnctor lap needs BOTH a readable per-fnctor prototype location (the closure
`$6` cannot hold it) AND the `new F()` instance to participate in the `$Object.$proto`
walk — exactly the two pieces the handoff identified, both absent, both object-model
substrate.

## Why realization (ii-a) cannot land safely in one verified pass

(ii-a) "reconstruct the dynamically-used instance AS an `$Object`" requires gating
on *"this `new F()` instance is consumed dynamically AND has no typed `struct.get`
own-field consumer"* — a whole-program escape analysis. The `$__fnctor_<Name>`
struct type is woven through the new-super lowering: inheritance ancestors
(new-super.ts:602/747), the ctor result type (:1019), and the typed own-field read
arm (the `ref.test $23 → struct.get $23 0` the WAT shows for `new Con(){this.x=3}`,
which makes `c.x` → 3 work). Reconstructing the instance as an `$Object`
*unconditionally* would move own-field reads to `__extern_set`/`__extern_get` and
regress every `new F()` with a typed field read (the hot path). Gating it correctly
needs the escape-analysis infrastructure that does not exist. **A wrong gate is the
#1888-class floor-eject — the documented stop-the-line risk.** This is why there is
no narrowly-gated one-pass B2.

## VERDICT (this session): NO Stage-B code landed — no small safe bankable unit

Per the dedicated-session brief ("if a B-slice has no small safe bankable unit, say
so explicitly with the WAT evidence rather than forcing it"): **Stage B has no
verified-safe, row-banking, one-pass increment, and the inert B1 scaffold banks 0
rows with no reusable-primitive de-risking value.** Forcing the inert scaffold, or
rushing the escape-analysis-gated (ii-a) reconstruct, both violate the verify-first
/ full-gate / stop-the-line discipline this lap demands. NO source changed; the
per-process harness lived in `.tmp/` (gitignored). This finding doc is the durable
deliverable.

## RE-SEQUENCED CONTINUATION (next value-rep session) — corrects the B1→B4 order

The cluster-composition correction re-prioritises the substrate work AWAY from the
fnctor lap and ONTO the two higher-leverage, more-tractable gaps:

- **B-pre (standalone generic-method host-import leak) — DO THIS FIRST, separate
  issue.** Make `Array.prototype.X.call(arrayLike, cb)` standalone-native (remove
  the `__make_callback`/`env` dependency, the #983d / `array-methods.ts` lane). It
  blocks EVERY standalone array-like-method row (even own-data, no proto needed).
  This is the precondition for ANY standalone cluster row and is independent of the
  proto substrate — likely the single highest-leverage standalone unblock. Size it
  as its own issue; it is not value-rep object-model, it is standalone-completeness.
- **B-acc (host generic-method HasProperty-visit + accessor `Get`) — the 181-file
  bulk.** Host already runs the own-data generic method (`forEach.call` own-data →
  11 ✓) but mis-visits accessor/inherited indices. Make the host generic-method
  HasProperty-visit consult the full `[[HasProperty]]` (own accessor + inherited)
  and the element `Get` invoke the accessor. This is the **dominant 181-file**
  `Object.defineProperty` lever and does NOT need the fnctor lap. (Coordinates with
  the host `_protoChainLookup` walk the M3 architect spec scoped — Decision 2/3.)
- **B-fnctor (the ii-a fnctor lap) — the ~51-file `.prototype=` subset, LAST.** Only
  after B-pre + B-acc. Needs the escape-analysis gate to reconstruct dynamically-used
  `new F()` instances as `$Object`s (or a contained alternative an architect decides).
  Broad-impact value-rep; full-gate, stop-the-line. This is the part with no
  one-pass safe slice today — it should wait until the escape-analysis (or a
  per-fnctor prototype-`$Object` global keyed off the *closure-global*, not the
  unreadable closure-struct slot) infrastructure is specced.
- **B-protoextend (`Object.prototype[i]=v` inherited on plain receivers) — the
  `-b-i-` data subset.** Make a plain `{length:N}` literal's `$proto` terminate at a
  walkable `Object.prototype` `$Object` so inherited indices resolve. Shares the
  walk with B-acc.

Order rationale: B-pre (unblocks all standalone rows, no proto needed) → B-acc
(181-file host bulk, accessor/HasProperty) → B-protoextend (`Object.prototype`
chain) → B-fnctor (51-file fnctor lap, last + hardest, needs escape analysis). The
handoff's B1→B4 (fnctor-first) is **de-prioritised**: the fnctor lap is the
smallest AND hardest slice, not the lever.

RUNNER TRAP (re-confirmed): validate per-process (one snippet/file · one mode ·
fresh instantiate), NEVER an in-process `runTest262File` loop. Reduced `compile()`
probes MISLEAD — this session found its own reduced host probe (`forEach.call`
accessor → 1) disagreed with the REAL `c-i-17` file (`fail`); ALWAYS confirm the
authoritative signal with the real test262 file via `runTest262File` in a fresh
process, and the full merge_group floor (#2097) for conformance. Issue stays
`in-progress`; claim released.
