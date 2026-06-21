---
id: 2580
title: "`.length` on an any/dynamically-mutated receiver returns numeric 0, not undefined (runtime property-presence)"
status: ready
sprint: Backlog
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
