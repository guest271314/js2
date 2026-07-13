---
id: 3000
title: "IR: class-member residual — private fields, accessors, inheritance/super (class-method → 0)"
status: done
assignee: opus-3000e-impl
completed: 2026-07-05
sprint: 71
created: 2026-07-02
updated: 2026-07-13
priority: medium
horizon: xl
feasibility: hard
reasoning_effort: max
task_type: feature
area: ir, codegen
language_feature: classes
goal: ir-full-coverage
parent: 2855
related: [1370, 2857]
---

# #3000 — IR class-member residual: private fields, accessors, inheritance/`super`

Split out of **#2857** after a measure-first scoping pass. #2857 landed the one
cleanly-bounded win (static methods under `extends`, 6 → 5). This issue owns the
remaining, genuinely-XL class-member surface that drives the `class-method`
bucket (and the co-located `body-shape-rejected` class members) to **zero**.

## Live snapshot (verified `upstream/main` @ 3ef85411a, 2026-07-02)

`pnpm run check:ir-fallbacks -- --verbose` on
`website/playground/examples/js/classes.ts`, per-member
(`planIrCompilation(..., trackFallbacks)` probe):

| Member         | Reason                | Sub-feature needed                                       |
| -------------- | --------------------- | -------------------------------------------------------- |
| `Animal_name`  | `class-method`        | get/set **accessor** lowering + private-field read/write |
| `Animal_age`   | `class-method`        | get accessor + private-field read                        |
| `Dog_breed`    | `class-method`        | get accessor + private-field read                        |
| `Dog_new`      | `class-method`        | **inheritance**: `super(...)` ctor chain                 |
| `Dog_speak`    | `class-method`        | **inheritance**: `super.method()` dispatch               |
| `Animal_new`   | `body-shape-rejected` | **private field** write (`this.#x = …`) in ctor body     |
| `Animal_speak` | `body-shape-rejected` | **private field** read (`this.#name`) in method body     |

So the residual is **three substrates**, roughly ordered by dependency:

1. **Private fields (`#x`)** — the common blocker. Both the two
   `body-shape-rejected` members and all three accessors read/write `this.#x`.
   IR's Phase-1 shape gate does not model private-name struct slots at all, so
   these currently reject before any accessor/inheritance logic is reached.
   Needs: IR `class.get` / `class.set` resolving the private-name field index
   against the (non-exported) struct slot. This is the prerequisite for the
   accessor work — do it first.
2. **Accessors (get/set)** — once private-field read/write exists, `get name()`
   / `set name(v)` lower as ordinary no-arg / one-arg methods over the private
   slot. Selector currently buckets every `GetAccessorDeclaration` /
   `SetAccessorDeclaration` as `class-method` (see `src/ir/select.ts` ~L411);
   relax once the lowering exists. Note get+set on the same name collapse to a
   single funcMap key `${Class}_${name}` in the selector today.
3. **Inheritance / `super` (Phase E)** — the largest piece. `Dog extends
Animal` needs parent-prefixed struct field layout, `super(...)` constructor
   chaining, and `super.method()` dispatch to the parent's method slot. The
   integration guard at `src/ir/integration.ts:294` currently skips **any**
   `extends` class wholesale; that guard and the selector's `hasParent`
   auto-reject (`src/ir/select.ts`, the `class-method` arm — note #2857 already
   carved out the no-`super` static exception there) both need the Phase E
   substrate before they can loosen. May warrant its own follow-up slice.

## Approach (phased)

1. **Private-field substrate** — IR `class.get`/`class.set` for `#name` slots;
   retire the `body-shape-rejected` on `Animal_new` / `Animal_speak`.
2. **Accessors** — claim get/set over the private slot; retire `Animal_name`,
   `Animal_age`, `Dog_breed`.
3. **Inheritance / `super`** — parent struct prefix + `super(...)` /
   `super.method()`; retire `Dog_new`, `Dog_speak`. Consider splitting.
4. After each slice: `pnpm run check:ir-fallbacks -- --update-on-decrease`.
5. At `class-method: 0` **and** the two class-member `body-shape-rejected`
   attributions cleared, add `"class-method"` to `STRICT_IR_REASONS`
   (`src/codegen/index.ts`) and promote the accessor / private-field /
   inheritance rows in `plan/log/ir-adoption.md`.

## Acceptance criteria

1. `class-method` count in `scripts/ir-fallback-baseline.json` is `0`.
2. The two class-member `body-shape-rejected` attributions in `classes.ts`
   (`Animal_new`, `Animal_speak`) are cleared (private-field substrate).
3. `website/playground/examples/js/classes.ts` compiles fully via IR for every
   class member (no `class-method` fallback for any member).
4. Equivalence tests for private fields, accessors, and inheritance/`super`
   pass (legacy/IR parity) — reuse the #1370 probes.
5. `"class-method"` added to `STRICT_IR_REASONS` once the bucket is zero.
6. No regression in `tests/ir-*.test.ts` or class equivalence suites.

## Files

- `src/ir/from-ast.ts` — private-field read/write, accessor / `super` lowering.
- `src/ir/integration.ts` — the `extends`-class skip (L294) + static/instance
  member walk (L303-L364); loosen as each substrate lands.
- `src/ir/select.ts` — accessor arm (~L411) and the `hasParent` `class-method`
  arm (the #2857 no-`super`-static carve-out lives here); relax per substrate.
- `scripts/ir-fallback-baseline.json` — ratchet down.
- `src/codegen/index.ts` — `STRICT_IR_REASONS` once at zero.
- `plan/log/ir-adoption.md` — promote rows.

## Provenance

Scoped out of #2857 (2026-07-02). #2857's original "drive class-method to zero"
framing was mis-sized as `M`; the measure-first pass found only static-methods
was a bounded win. This carries the XL remainder.

## Implementation Notes — Phase 1a: private-field read/write substrate (2026-07-03, PR TBD)

**Landed (this PR):** the private-field _shape gate + lowering_ — the smallest
independently-shippable slice of Phase 1. Clears the two class-member
`body-shape-rejected` attributions on `classes.ts` (`Animal_new`,
`Animal_speak`); `body-shape-rejected` corpus total 25 → 23.

**Root cause of the rejection (verified on `upstream/main` @ bc8a1d4ca):** IR's
Phase-1 shape gate and AST→IR lowerer both gated field access on
`ts.isIdentifier(name)`. A `#x` name is a `ts.PrivateIdentifier`, _not_ an
`Identifier`, so `this.#x` read/write fell into `body-shape-rejected` _before_
any `class.get`/`class.set` logic ran. Everything downstream was already in
place: `buildIrClassShapes` (`src/codegen/index.ts`) reads fields straight from
`ctx.structFields`, which _already includes_ private slots, and
`ClassRegistry.fieldIdx` (`src/ir/integration.ts`) resolves by the same
`structFields` name → identical index. So the fix is purely at the gate + lower
entry points.

**The load-bearing detail — name mangling.** The legacy `resolveClassMemberName`
(`src/codegen/class-bodies.ts:522`) stores a private field `#name` as
`"__priv_name"` (strip `#`, prefix `__priv_`). The IR shape and `fieldIdx` both
read that mangled name from `structFields`, so from-ast MUST mangle the
`PrivateIdentifier` the _same_ way (`irPrivateFieldName` in `from-ast.ts`) or the
field lookup misses. Plain `Identifier` passes through unchanged.

**Edits (5, all narrow):**

- `src/ir/from-ast.ts` — `irPrivateFieldName` helper; `lowerPropertyAccess`
  (read) and `lowerPropertyAssignment` (write) accept `PrivateIdentifier` +
  mangle.
- `src/ir/select.ts` — accept `PrivateIdentifier` in the `isPhase1Expr`
  property-access read arm, the `isPhase1StatementList` non-tail assignment arm,
  and the `isPhase1BodyStatement` (ctor/for-of body) assignment arm.
- `scripts/ir-fallback-baseline.json` — ratchet body-shape-rejected 25 → 23.
- `tests/issue-3000.test.ts` — selector + runtime (incl. super-dispatch) parity.

**Key architectural findings (correct the issue's original phasing):**

1. **Constructors are NOT emitted by Phase B integration.** `compileIrPathFunctions`
   only builds `MethodDeclaration`s (`integration.ts:304`); it never builds a
   `ConstructorDeclaration`. So even though the selector now _claims_ `Animal_new`
   (clearing its `body-shape-rejected`), Phase B skips it → the **legacy ctor
   body still emits, byte-inert**. Real IR constructor emission (`struct.new` +
   `__self` epilogue + field-init) is a **separate substrate = the issue's
   "Phase C"**, independent of and larger than the private-field gate. The
   issue's Phase 1 lumped "ctor private write" with "method private read"; in
   the code they are two different integration paths.

2. **`Animal_speak` (private read in a flat-class instance method) IS a real,
   non-byte-inert codegen change** — it flows through Phase B, gets its body
   replaced by IR-lowered Wasm (subject to the typeIdx parity guard at
   `integration.ts:715`). Validated: `classes.ts`'s `Dog.speak()` override calls
   `super.speak()` → the IR-emitted `Animal_speak` with a **Dog** receiver
   (WasmGC subtype of Animal); `class.get __priv_name` reads the correct
   parent-prefixed slot across the subtype boundary. Output matches legacy
   exactly. **Contrast with #2857**, whose static-method claim was byte-inert —
   #3000 has _no_ byte-inert reduction; every metric drop that reaches Phase B
   is a real emission change gated by test262.

3. **Private-field _write_ as a void-method tail is a pre-existing, non-private
   gap.** `set(v){ this.#x = v }` is rejected at `isPhase1Tail` → `isPhase1Expr`
   (`select.ts:~1821`), which rejects **all** `=` expressions (public or
   private). Out of scope for this substrate; belongs to a general
   "assignment-expression-statement as void tail" slice.

**Validation:** `tests/issue-3000.test.ts` (5, pass); `private-class-members` +
`ir-slice4-classes` + 3 other class equivalence files (22, pass); `tests/ir/*`
and the class test files show **zero new failures vs base** (the `classes.ts` /
`abstract-classes` / `issue-private-access-brand` / `ir/passes` / `inline-small`
failures observed locally are **pre-existing** — stale `{ env: {} }` harnesses
and unrelated inline/CF tests, identical with and without this change). Full
test262 conformance is the CI gate.

## Remaining surface — decomposition for future windows

`class-method` is still **5** on `classes.ts`; the two class-member
`body-shape-rejected` are cleared. The remainder splits into three
independently-dispatchable slices, in dependency order:

- **#3000-B — Accessors (get/set over the private slot)** [M]. **LANDED
  (2026-07-04, opus-3000b)** — see the "#3000-B: accessors" Implementation Notes
  below. Claimed `Animal_name` (get+set) + `Animal_age` (get); `class-method`
  5 → 3. Correction to the original note: get and set do **not** collapse to one
  funcMap key — the legacy path registers DISTINCT `${Class}_get_${prop}` /
  `${Class}_set_${prop}` slots, and this PR claims each independently. The
  void-tail-assignment gap (finding 3) is closed. `Dog_breed` stays Phase E.
  **Caveat:** on `classes.ts` the claimed Animal accessors are byte-inert
  (Animal's `string` field blocks `buildIrClassShapes` — see the notes' KEY
  BLOCKER); genuine IR emission is proven on numeric-field classes and gated on
  the banked string-field-shape follow-up.

- **#3000-C — Constructor IR emission (Phase C)** [L]. Build
  `ConstructorDeclaration`s in Phase B: allocate the struct, run field
  initialisers + ctor body private/public writes, synthesise the `return this`
  epilogue, and register under the `${Class}_new` funcMap key. Only after this
  does `Animal_new`'s claim become a _real_ IR emission (today byte-inert).
  Prerequisite for making the ctor claim honest and for Phase E's `super(...)`.

- **#3000-E — Inheritance / `super` (Phase E)** [XL, the big rock]. `Dog extends
Animal`. Needs: parent-prefixed `IrClassShape` (today `buildIrClassShapes`
  skips any `extends` class — `index.ts:874`; and Phase B integration skips them
  wholesale — `integration.ts:294`), `super(...)` ctor chaining (on top of
  Phase C), and `super.method()` dispatch to the parent slot. Members:
  `Dog_new`, `Dog_speak`. Loosen the selector `hasParent` arm (`select.ts:430`)
  and both skip guards once the substrate exists. **Consider its own issue.**

`"class-method"` joins `STRICT_IR_REASONS` (`src/codegen/index.ts`) only once
B + C + E all land and the bucket is 0.

## Implementation Notes — Phase 1b: string-field-shape projection (2026-07-04, PR TBD)

**The blocker this closes.** #3000-B (accessors) and Phase-1a (private field
read/write) both landed the selector claim + AST→IR lowering for string-field
class members, but `buildIrClassShapes` (`src/codegen/index.ts`) still rejected
the whole class: it projected each field's IR type from the *legacy struct
ValType* via `valTypeToIrField`, which returned `null` for a `string` field.
One string field ⇒ no `IrClassShape` ⇒ Phase-B integration skipped **every**
member (`integration.ts:312` `if (!classShape) continue;`) ⇒ accessors +
methods stayed **byte-inert on legacy**. classes.ts's `Animal` (`#name: string`)
was blocked exactly this way. This is the "string-field-shape" gap the #3000-B
author documented (and its test header called out).

**Root cause of the null (verified).** The legacy struct ValType is *lossy*: a
string field lowers to `externref` in host mode — indistinguishable from `any`
/ object — so string recovery cannot be done from the ValType alone. Fix:
re-derive each field's IR type from the **AST/checker** (mirroring the exact
`getTypeAtLocation` sources the legacy `collectClassDeclaration` uses:
`PropertyDeclaration` members + ctor-body `this.x = …` introductions), keyed by
the SAME mangled name legacy stores in `structFields` (`#x` → `__priv_x`). A
`string` field projects to `IrType.string`, which `lowerIrTypeToValType` →
`resolveString()` lowers to the exact per-lane carrier the struct already holds
(host → `externref`; native → `(ref $AnyString)`). Parity is enforced, not
assumed: `irFieldTypeMatchesLegacyValType` adopts the AST-derived type **only**
when it is byte-compatible with the legacy struct slot (a *field-level* parity
guard, mirroring the string arm of `resolveWasmType` + the `ref`→`ref_null`
field widening). Anything the AST can't resolve, or that disagrees with the
slot, falls back to the ValType path → worst case a clean legacy fallback.

**Genuine emission proven (non-vacuity).** Added `CompileResult.irCompiledFuncs`
(the integration pass's `report.compiled` — the members whose slots were
*actually patched* with an IR body; a selector claim alone does NOT imply
this). Differential proof: with the string arm disabled, `Animal_get_name`,
`Animal_set_name`, `Animal_get_age`, `Animal_speak` are **byte-inert/missing**
from `irCompiledFuncs`; with it, all four are **IR-emitted in BOTH lanes**
(host externref + native `$AnyString`), zero post-claim demotions, correct
string round-trips through the production runtime. Corpus `check:ir-fallbacks`:
**zero** post-claim demotions across all playground examples.

**Metric.** The `class-method` bucket on classes.ts was already `5 → 3` from
#3000-B's *selector* relaxation (the count is selector-level). Phase-1b does not
move the count — it makes the already-claimed `Animal` accessors + method
**genuinely non-byte-inert**. The remaining `class-method: 3` are all `Dog_*`
(`Dog_new`, `Dog_speak`, `Dog_breed`) — the `extends` subclass, deferred to
Phase E. **Criterion #3 (classes.ts fully IR) is NOT yet reachable**: it still
needs Phase C (ctor emission) + Phase E (inheritance/`super`).

**Edits.**
- `src/codegen/index.ts` — `buildIrClassShapes` field loop re-derives field IR
  types from AST/checker; new `irFieldTypeMatchesLegacyValType` parity guard;
  `valTypeToIrField` comment updated (strings now handled by the AST path);
  `ctx.irCompiledFuncs = report.compiled` + threaded onto both codegen return
  sites.
- `src/codegen/context/types.ts`, `src/index.ts`, `src/compiler.ts` —
  `irCompiledFuncs` telemetry field (the durable genuine-emission signal).
- `tests/issue-3000-1b.test.ts` — genuine-emission proof (both lanes) + runtime
  round-trip + numeric/string co-emission.
- `tests/issue-3000.test.ts` — `runString` now instantiates via the PRODUCTION
  runtime (`compileAndInstantiate` → native `wasm:js-string` builtins). The old
  raw `WebAssembly.instantiate(binary, importObject)` harness could not resolve
  `wasm:js-string`: IR expresses string ops as native js-string *builtin*
  imports (not tracked host imports), so `importObject` (keyed off
  `result.imports`) is empty for an all-builtin module. This is a general IR
  property, not class-specific.

**DISCOVERED PRE-EXISTING GAP — banked for a follow-up (not this slice).**
An IR-emitted class method invoked as a *method-value* with a foreign receiver
(`(c.method as any).call({})`) null-dereferences instead of throwing a catchable
`TypeError` — the brand-check `ref.test` guard legacy emits in the method-value
`.call` dispatch is not applied for IR-claimed methods. **This is pre-existing
and independent of Phase-1b**: a *numeric*-field class (which IR-emits via
#3000-B, with Phase-1b fully disabled) reproduces the identical null-deref on
`main`. `tests/issue-private-access-brand.test.ts` is already 2/4 red on `main`
from it (the getter + private-method cases); Phase-1b makes the string-field
case (Test 1) join them (2→3 red). That file is **not run by any blocking CI
gate** (`quality` runs a fixed file list; the equivalence shards only run
`tests/equivalence/`). The gated class-equivalence suites are **45/45 green**
with Phase-1b. Fixing the brand check belongs to the method-value dispatch
machinery (`__call_fn_method_*` / #2175 area) — shared across ALL IR class
methods (numeric + string), architect-scale, and orthogonal to string-field
shape. **Recommend a dedicated follow-up issue: "IR class-method-value `.call`
brand-check guard".**

## Implementation Notes — #3000-B: accessors (get/set) (2026-07-04, opus-3000b)

**Landed (this PR):** get/set accessor claiming + lowering in the IR class-member
path. `class-method` on `classes.ts` drops **5 → 3** (baseline ratcheted):
`Animal_name` (get+set) and `Animal_age` (get) are now claimed; `Dog_breed`,
`Dog_new`, `Dog_speak` stay `class-method` (all three are Phase E / `extends`).

**Edits (5, narrow):**

- `src/ir/select.ts` — widen `IrClaimableSubject` + `resolveReturnType` to accept
  accessors; a set accessor resolves as **void**; a new class-member arm claims
  instance getters/setters under DISTINCT `${Class}_get_${prop}` /
  `${Class}_set_${prop}` keys (static accessors + `extends`-subclass accessors
  stay `class-method`); `isPhase1Tail` accepts a **void-tail property/element
  store** (the setter body shape) — this closes Phase-1a "finding 3".
- `src/ir/from-ast.ts` — `lowerFunctionAstToIr` accepts accessor nodes (setter
  forced void); `lowerTail`'s void arm routes a tail `this.#x = v;` /
  `arr[i] = v;` through the SAME `lowerPropertyAssignment` / `lowerElementStore`
  the non-tail path uses (select↔build parity).
- `src/ir/integration.ts` — the Phase B member walk builds accessor declarations
  alongside methods, mapping to the legacy `_get_`/`_set_` funcMap key and
  passing `returnTypeOverride: null` for setters.
- `scripts/ir-fallback-baseline.json` — `class-method` 5 → 3.
- `tests/issue-3000-b.test.ts` — selector claims (distinct keys, static/subclass
  deferral), a **no-post-claim-demotion** emission assertion, and runtime get/set
  round-trip + void-tail setter over a numeric class.

**Non-vacuity (verified empirically).** For a class whose fields PROJECT into an
`IrClassShape` (numeric / boolean / object), the accessor bodies genuinely
IR-emit: instrumenting `compileIrPathFunctions` shows
`Counter_get_value | Counter_set_value` in `report.compiled` (the patched-slot
list), post-claim demotions are `(none)`, and the runtime tests exercise those
patched slots (getter → 10, setter void-tail → 25, method private read → 42).

**KEY BLOCKER FOUND — `classes.ts` accessors are byte-inert, and so was
Phase-1a's `Animal_speak`.** `buildIrClassShapes` (`src/codegen/index.ts`) rejects
a class if ANY field fails `valTypeToIrField`, which **returns `null` for every
`string` field** ("Slice 4 defers string-typed class fields"). `Animal` has
`#name: string`, so it gets **no `IrClassShape`** → the Phase B walk's
`if (!classShape) continue;` (`integration.ts`) skips **every** Animal member
(methods, ctor, AND accessors). So on `classes.ts`:

- The three claimed Animal accessors are removed from the `class-method` bucket
  (real selector progress) but their bodies stay on **legacy** — byte-inert, exactly
  like the already-merged `Animal_new` ctor claim.
- Phase-1a's stated "`Animal_speak` is a real IR emission" does **not** hold for
  `classes.ts` — Animal never gets a shape there. (Phase-1a's runtime test passed
  because the output is correct via legacy; the test asserts behaviour, not that IR
  owned the slot. The vacuity is invisible to a behaviour-only test.)

Projecting string fields is **not accessor-specific** — it blocks methods, the
ctor, and accessors of every string-field class equally, and it is genuinely
non-trivial: a string field is `externref` in JS-host (indistinguishable from any
other `externref` field at the `ValType` level — which is _why_ it was deferred),
so `buildIrClassShapes` must re-derive field IR types from the **AST/checker**
(as it already does for method params) rather than from the legacy `structFields`
`ValType`s, and the resulting `class.get`/`class.set` must preserve ValType parity
across the JS-host (externref) and standalone (`ref $AnyString`) lanes. **Banked as
a prerequisite follow-up** (call it Phase 1b / string-field-shape): it must land
before `classes.ts` members — accessors, methods, or ctor — genuinely IR-emit, and
before acceptance criterion #3 ("classes.ts compiles fully via IR") is reachable.
The typeIdx parity guard (`integration.ts`) makes it safe: a mis-projected field
type can only cause a byte-inert skip, never a miscompile.

**Separate pre-existing gap — accessor CALL SITES.** A `c.value` read / `c.value =
x` write inside an IR-claimed caller is lowered by `from-ast`'s
`lowerPropertyAccess` / `lowerPropertyAssignment` as a **field** access, throwing
`class ... has no field "value"` → the caller demotes to legacy (byte-inert, no
miscompile). Unrelated to accessor DECLARATIONS (this PR) and harmless for
`classes.ts` (its accessor call sites live in the unclaimed `main`). A future slice
should teach the caller-side member lowering to emit an accessor CALL when the name
resolves to a get/set accessor.

## #3000-C re-grounding (dev-selfserve-1, 2026-07-04) — measure-first baseline + exact integration points

Branch `issue-3000-c-ctor` (pushed). Re-grounded against current `origin/main`
(@386be684e). Turnkey findings for the implementation pass:

### Measure-first (the byte-inert trap the telemetry solves)
`irCompiledFuncs` on a flat class `class Animal { #name; age; constructor(n,a){…} speak(){…} }`:
- `["test", "Animal_speak"]` — `Animal_speak` (method w/ private read) IS genuinely
  IR-emitted (Phase-1a landed it).
- **`Animal_new` is ABSENT** → the selector's ctor claim is byte-inert today; the
  legacy ctor body still emits. **#3000-C's acceptance = `Animal_new` appears in
  `irCompiledFuncs`** (genuine IR emission), not merely a metric/claim drop.

### The two exact integration points
1. **`src/ir/from-ast.ts:368` — `lowerFunctionAstToIr` currently THROWS on a
   `ConstructorDeclaration`**: `throw new Error("constructor body lowering is
   Phase C, not B")`. The signature already accepts `ts.ConstructorDeclaration`
   (L336) and the scaffolding anticipates it (L255-258, L349, L359-370). Phase C =
   replace that throw with real ctor lowering:
   - NO `options.selfParam` (a ctor is not passed `__self`); instead synthesise
     `this` = a freshly-**allocated struct** at body entry. Needs an IR
     "allocate class instance" op (or reuse the legacy `struct.new` shape) whose
     typeIdx is the class's pre-allocated struct (parity with the legacy
     `${Class}_new` slot — see the `integration.ts:715` typeIdx parity guard).
   - Run **field initialisers** (`age: number` property defaults + declared
     field inits) then the **ctor body** statements (public/private `this.x = …`
     writes — the private-write path is the void-tail-assignment gap noted in
     Phase-1a finding 3; a ctor body assignment is a STATEMENT, not a tail, so it
     may already pass `isPhase1BodyStatement` — verify).
   - Synthesise the **`return this`** epilogue (result type = the class struct
     ref).
   - Bind `this` in `scope` to the allocated-struct SSA value so `this.field`
     routes through the existing `class.get`/`class.set` lowerings.
2. **`src/ir/integration.ts:314` — the Phase B walk only iterates
   `MethodDeclaration`s** (`if (!ts.isMethodDeclaration(member)) continue`). Extend
   to `ConstructorDeclaration`: funcName = `${className}_new`, no `selfParam`,
   gate on `selected.classMembers.has(`${className}_new`)`, then verify + push to
   `built` with `classMember: true` (the Phase-3 slot patch's typeIdx parity check
   at `integration.ts:715` guards the overwrite).

### Scope guards (keep it flat-class)
- The `integration.ts:305` `extends`-skip and `buildIrClassShapes` non-extends-only
  seeding already confine this to FLAT classes — `super(...)` ctor chaining is
  Phase E (#3000-E), which builds ON this. Keep both guards; do NOT loosen them.
- Proof harness: `irCompiledFuncs.includes("Animal_new")` for the genuine-emission
  claim; byte-for-byte runtime parity of `new Animal(...)` field reads vs legacy;
  ir-fallback baseline `class-method` decrement only if a member actually clears;
  full test262 CI (this is a NON-byte-inert emission change — every metric drop
  that reaches Phase B is real, gated by test262, per Phase-1a finding 2).

### Status
Set up + measure-first-baselined + fully scoped. The constructor-IR-emission
substrate (from-ast ctor lowering + the struct-alloc/return-this shape + emitter
support) is genuine XL/hard work best landed as its own focused pass on this
branch. NOT started beyond re-grounding.

## Implementation Notes — #3000-C: constructor IR emission LANDED (opus-3000c, 2026-07-04)

**Acceptance met (genuine, non-vacuous emission).** `Animal_new` now APPEARS in
`irCompiledFuncs` in BOTH lanes (host externref + native `$AnyString`), with
ZERO post-claim demotions, and `new Animal("Rex",4)` round-trips exactly
(`Rex Jr.|Rex Jr. makes a sound|4`). The re-grounding measured `Animal_new`
ABSENT (byte-inert selector claim); it is now a real IR body. `check:ir-fallbacks`
corpus unchanged (`class-method` 3, `body-shape-rejected` 18, post-claim
demotions **none**). Byte-inert proven: a non-ctor program's wasm sha256 is
identical to base (`94a0357…` / `177a858…`) — `class.alloc` is emitted ONLY by
ctor lowering, so every non-ctor program is untouched.

**The core design decision — a new `class.alloc` IR instr, NOT reuse of
`class.new`.** `class.new` lowers to `call $<Class>_new` — the very function the
ctor body is being compiled INTO, so reusing it recurses. The constructor body
must ALLOCATE its own `this`. I added `class.alloc` (nodes/builder/lower/effects/
verify/passes), a pure, operand-less allocation whose lowering replays the
resolver's precomputed default-field + `__tag` + `struct.new` prefix. That prefix
(`IrClassLowering.allocInstrs`, built in `ClassRegistry.resolve` via
`defaultFieldAllocInstr`) mirrors the legacy `<Class>_new` `newBody` default
switch (`class-bodies.ts`) EXACTLY, keyed off the SAME `ctx.structFields` /
`ctx.classTagMap` — so the emitted allocation is byte-compatible with the struct
the legacy path builds. This is why the ctor emission is provably a clean
allocation, not a heuristic.

**Why patching `<Class>_new` is safe under an existing subclass.** The legacy
splits every non-externref class into `<Class>_new` (alloc + tail-call
`<Class>_init`) and `<Class>_init` (field inits + ctor body). A derived class's
`super(...)` calls the PARENT's `_init`, never `_new`. So making `Animal_new` a
self-contained IR body (alloc + field writes + `return this`) leaves `Animal_init`
untouched — `Dog`'s `super(name,age)` still routes to legacy `Animal_init`. The
IR `_new` is only reached by a direct `new Animal(...)`. No inheritance breakage;
`extends` classes stay Phase E (guards at `integration.ts` + `buildIrClassShapes`
are unchanged).

**Two integration points (as scoped).** (a) `from-ast.ts` `lowerFunctionAstToIr`
ctor arm: NO `selfParam`; synthesise `this = class.alloc(shape)` at body entry,
bind it, lower ctor body statements via the non-tail `lowerStmt` dispatcher (the
SAME shapes the selector's `isPhase1BodyStatement` admits), then
`terminate(return [this])`. Result type forced to `{kind:"class",shape}` →
`(ref $struct)`, so the Phase-3 typeIdx-parity guard (`integration.ts`) sees the
IR body's signature matching the legacy `<Class>_new` slot — a mismatch keeps
legacy (worst case byte-inert, never miscompile). (b) `integration.ts` Phase-B
walk extended from methods/accessors to `ConstructorDeclaration` under
`${className}_new` with `constructorClassShape` (no `selfParam`).

**Construction-effect guards (correctness, `select.ts` ctor arm).** The IR ctor
path runs ONLY the ctor body. Two construction-time effects it does NOT lower are
now rejected to legacy so a claimed-but-wrong ctor can't slip through (the
typeIdx guard can't catch these — same signature): (a) **parameter properties**
(`constructor(private x)`) declare+assign a field; (b) **PropertyDeclaration
initialisers** (`x = 5`) run at construction. Both keep the field at its struct
default under the IR path → wrong. Guarded → legacy → correct. Flat classes whose
fields are declared (no initialiser) and assigned in the body — the common shape,
incl. classes.ts's `Animal` — are unaffected. A field declared-but-never-assigned
is fine: both IR and legacy leave it at the struct default (no divergence).

**Banked follow-up (pre-existing, NOT this slice): void `this.method()` in
statement position.** A ctor (or any method) body calling a VOID instance method
as a statement (`this.add(a);`) demotes post-claim with
`void method ... used in expression position` — the `class.call` void path does
not honour statement position. Verified pre-existing: a plain method `M_run`
calling `this.add()` demotes identically on base. Clean fallback (byte-inert,
correct runtime), not ctor-specific, orthogonal to #3000-C — a shared
`class.call` fix. Recommend a dedicated issue: "IR `class.call` void method in
statement position".

**Edits.**
- `src/ir/nodes.ts` — `IrInstrClassAlloc` interface + union member + the three
  instr-traversal switches (`forEachNestedBuffer`/`mapNestedBuffers` no-op group,
  `directUses` → `[]`).
- `src/ir/builder.ts` — `emitClassAlloc(shape)` (object alloc namespace).
- `src/ir/backend/handles.ts` — `IrClassLowering.allocInstrs`.
- `src/ir/integration.ts` — `defaultFieldAllocInstr` helper + `allocInstrs`
  population in `ClassRegistry.resolve`; Phase-B walk extended to
  `ConstructorDeclaration`.
- `src/ir/lower.ts` — `class.alloc` emit (replay `allocInstrs`) + `collectIrUses`.
- `src/ir/effects.ts` (pure group), `verify.ts`, `verify-alloc.ts` (map),
  `passes/inline-small.ts`, `passes/monomorphize.ts`, `analysis/stack-alloc.ts`,
  `backend/legality.ts` — `class.alloc` cases (mostly TS-exhaustiveness-forced).
- `src/ir/from-ast.ts` — `constructorClassShape` option + ctor lowering branch.
- `src/ir/select.ts` — ctor construction-effect guards.
- `tests/issue-3000-c.test.ts` — genuine-emission proof (both lanes) + runtime
  round-trip + numeric/empty-ctor + the two guard rejections.

**Unblocks #3000-E** (inheritance / `super`), which builds `super(...)` ctor
chaining on top of this ctor-emission substrate.

## Implementation Notes — #3000-E: inheritance / `super` emission LANDED (opus-3000e, 2026-07-05)

**Acceptance MET — criterion #3 (classes.ts fully IR) is now TRUE.** On
`classes.ts`, `irCompiledFuncs` now lists **every class member of both classes**
in BOTH lanes (host externref + native `$AnyString`): `Animal_new`,
`Animal_get_name`, `Animal_set_name`, `Animal_get_age`, `Animal_speak`,
**`Dog_new`, `Dog_speak`, `Dog_get_breed`** — with `irPostClaimErrors: []` (zero
post-claim demotions). The three `Dog_*` were the last IR-uncovered members.
`check:ir-fallbacks` **`class-method` bucket: 3 → 0** (baseline ratcheted); the
residual `body-shape-rejected=1` on classes.ts is `main` (accessor call sites +
`console.log`/`instanceof`), NOT a class member. Runtime parity: legacy and IR
both emit `Rex/4|Rex makes a sound woof|Lab|AD` — `super(...)` runs the parent
init exactly once (inherited `#name`/`#age` correct), `super.speak()` dispatches
to `Animal_speak` (Dog receiver), Dog's own `#breed` reads, and `instanceof`
Animal+Dog both hold.

**Non-vacuity — inject-throw proof.** Injecting `throw` into the `class.super_init`
lowering demotes `Dog_new` with `{kind:"lower", func:"Dog_new",
message:"INJECT-3000E-super-init"}` — proving `Dog_new`'s IR body genuinely emits
the new instr (a byte-inert/legacy body would be unaffected). The pre-change
baseline measured all three `Dog_*` ABSENT from `irCompiledFuncs`; post-change all
three present. Byte-inert for non-subclass programs: `super_init`/`super_call` are
emitted ONLY by subclass lowering, and `buildIrClassShapes` projects subclasses
only — flat-class codegen is untouched (the #3000-C byte-inert sha256 test still
passes on this branch).

**The design — two dedicated IR instrs mirroring the legacy `_new`/`_init` split.**
The legacy backend splits every WasmGC-struct class into `<Class>_new` (alloc +
tail-call `<Class>_init`) and `<Class>_init` (`(...ctorParams, self) -> (ref
$struct)`, self LAST — field inits + ctor body), lowering a derived `super(...)`
to `call <Parent>_init(args..., self)`. #3000-E adds two instrs that mirror this
EXACTLY, so the emitted calls are byte-compatible with the slots legacy builds:

- **`class.super_init`** (`super(args)`): runs the PARENT's `<parent>_init` on the
  already-`class.alloc`'d `self` (from #3000-C) — NOT the parent's `_new` (which
  would allocate a second, wrong-typed instance). Statement-only; the parent
  init's `(ref $struct)` return is dropped. `self` is a `(ref $SubStruct)` passed
  where `_init` expects `(ref $ParentStruct)` — valid WasmGC subtyping. `_init`
  writes the parent's fields onto the shared `self`, so a single alloc + parent
  init + own field writes reconstructs the exact legacy object.
- **`class.super_call`** (`super.method(args)`): static-dispatches to the PARENT's
  `<parent>_<method>` slot with the subclass receiver, resolving against the
  parent shape so a subclass override is bypassed. Result = the parent method's
  return type. `Animal_speak` (whichever body — IR or legacy — is installed) runs
  with a Dog receiver; `class.get __priv_name` reads the parent-prefixed slot
  across the subtype boundary.

Both resolve their func-key through `resolver.resolveClass(parentShape)` — a new
`IrClassLowering.initFuncName` (`<parent>_init`) plus the existing
`methodFuncName` — so the collision-safe `classMemberFuncKey` mangling is honored.

**Subclass shape projection (`buildIrClassShapes`, `src/codegen/index.ts`).** The
old wholesale `extends`-skip is replaced by a single-level gate: a subclass whose
`extends` parent is a LOCAL user class already in `out` projects, carrying the
parent as `IrClassShape.parent` (drives both super instrs). The KEY subtlety: a
subclass's legacy `structFields` is `[...parentFields, ...ownFields]`, so it
includes fields DECLARED on ancestors (Dog's `__priv_name` is Animal's *string*
field). The AST field re-derivation (#3000-1b, which recovers string fields the
lossy ValType can't) therefore walks the **whole ancestor chain** (self + every
local parent's PropertyDeclarations + ctor-body `this.x =` writes) — else an
inherited string field has no `astFieldIr` entry and the null-returning ValType
path rejects the whole subclass. A subclass of a builtin/externref-backed parent
gets no shape → stays on legacy (the selector's `parentIsLocalClass` gate mirrors
this exactly, so a claim always finds a shape → no post-claim demotion; a dedicated
test asserts `class MyErr extends Error` members are NOT claimed).

**typeIdx-parity safety.** The Phase-3 slot patch's typeIdx-parity guard
(`integration.ts`) still gates every overwrite: a mis-projected subclass signature
can only keep the legacy body (worst case byte-inert), never miscompile — the
#3000-C/1b precedent holds.

**Criterion #5 (`class-method` → `STRICT_IR_REASONS`) DEFERRED — deliberate.**
`STRICT_IR_REASONS` promotes a rejection reason to a HARD compile error for
**every** compilation (test262 included), not just the playground corpus. The
`class-method` reason still legitimately covers out-of-corpus deferred shapes —
computed/generator/abstract method names, static `super`, subclass-of-builtin
members — that B/C/E do not cover. A `class X extends Array { m(){} }` in test262
would become a CE regression. The corpus bucket being 0 does NOT make the reason
universally retired. `STRICT_IR_REASONS` is still empty for exactly this reason
(no bucket has been flipped yet). Recommend flipping only after the deferred
sub-shapes are separately handled or carved into distinct reasons.

**Banked follow-ups (not this slice).**
1. **Accessor CALL SITES** (`d.breed` read in an IR-claimed caller) still lower as
   a field access → `class ... has no field` → the CALLER demotes cleanly (byte-
   inert). This is why classes.ts's `main` stays legacy. Pre-existing from #3000-B;
   a caller-side "member resolves to a get/set accessor → emit accessor CALL" slice.
2. **Multi-level `super` to a grandparent-defined method** (`super.m()` where `m`
   is on the grandparent, not the immediate parent): the immediate parent shape's
   `methods` lacks it → from-ast throws → clean demotion. Single-level `extends`
   and multi-level with own/immediate-parent members work; grandparent-method
   super is banked. Field collection already walks the full chain.

**Edits.**
- `src/ir/nodes.ts` — `IrClassShape.parent`; `IrInstrClassSuperInit` /
  `IrInstrClassSuperCall` interfaces + union + the three traversal switches
  (no-op nested-buffer ×2, `directUses`).
- `src/ir/builder.ts` — `emitClassSuperInit` / `emitClassSuperCall`.
- `src/ir/backend/handles.ts` — `IrClassLowering.initFuncName`.
- `src/ir/integration.ts` — populate `initFuncName`; drop the wholesale
  `extends`-skip (shape presence is the gate).
- `src/ir/lower.ts` — `class.super_init` (args, self, call `_init`, drop) +
  `class.super_call` (receiver, args, call parent method); use-count switch.
- `src/ir/from-ast.ts` — `super(...)` in `lowerCall`, `super.method()` in
  `lowerMethodCall`; `requireThisValue` / `requireSuperParentShape` helpers.
- `src/ir/select.ts` — `extendsParentName`; `parentIsLocalClass` loosens the
  `hasParent` instance-member arm; `super(...)` / `super.method()` in `isPhase1Expr`.
- `src/ir/effects.ts`, `verify.ts`, `passes/inline-small.ts`, `passes/monomorphize.ts`
  — the two new instrs (call-like effects; use lists; operand renaming).
- `src/codegen/index.ts` — `buildIrClassShapes` single-level subclass projection +
  ancestor-chain field walk + `parent`; `extendsParentClassName` helper.
- `scripts/ir-fallback-baseline.json` — `class-method` 3 → 0 (removed).
- `plan/log/ir-adoption.md` — ctor/accessor/method rows → `mixed`; class-method note.
- `tests/issue-3000-e.test.ts` — genuine emission (both lanes) + runtime parity +
  builtin-parent clean-fallback guard.
- `tests/issue-3000.test.ts`, `tests/issue-3000-b.test.ts` — updated the two
  assertions that pinned subclass members to `class-method` "until Phase E".
