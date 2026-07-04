---
id: 3000
title: "IR: class-member residual — private fields, accessors, inheritance/super (class-method → 0)"
status: in-progress
assignee: opus-3000b
sprint: current
created: 2026-07-02
updated: 2026-07-04
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

**Landed (this PR):** the private-field *shape gate + lowering* — the smallest
independently-shippable slice of Phase 1. Clears the two class-member
`body-shape-rejected` attributions on `classes.ts` (`Animal_new`,
`Animal_speak`); `body-shape-rejected` corpus total 25 → 23.

**Root cause of the rejection (verified on `upstream/main` @ bc8a1d4ca):** IR's
Phase-1 shape gate and AST→IR lowerer both gated field access on
`ts.isIdentifier(name)`. A `#x` name is a `ts.PrivateIdentifier`, *not* an
`Identifier`, so `this.#x` read/write fell into `body-shape-rejected` *before*
any `class.get`/`class.set` logic ran. Everything downstream was already in
place: `buildIrClassShapes` (`src/codegen/index.ts`) reads fields straight from
`ctx.structFields`, which *already includes* private slots, and
`ClassRegistry.fieldIdx` (`src/ir/integration.ts`) resolves by the same
`structFields` name → identical index. So the fix is purely at the gate + lower
entry points.

**The load-bearing detail — name mangling.** The legacy `resolveClassMemberName`
(`src/codegen/class-bodies.ts:522`) stores a private field `#name` as
`"__priv_name"` (strip `#`, prefix `__priv_`). The IR shape and `fieldIdx` both
read that mangled name from `structFields`, so from-ast MUST mangle the
`PrivateIdentifier` the *same* way (`irPrivateFieldName` in `from-ast.ts`) or the
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
   `ConstructorDeclaration`. So even though the selector now *claims* `Animal_new`
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
   #3000 has *no* byte-inert reduction; every metric drop that reaches Phase B
   is a real emission change gated by test262.

3. **Private-field *write* as a void-method tail is a pre-existing, non-private
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

- **#3000-B — Accessors (get/set over the private slot)** [M].
  Members: `Animal_name` (get+set), `Animal_age` (get), `Dog_breed` (get).
  Needs: (a) selector — stop bucketing `GetAccessorDeclaration` /
  `SetAccessorDeclaration` as `class-method` (`select.ts:411`) and claim them
  like no-arg / one-arg methods over the (now-supported) private slot; note
  get+set collapse to one `${Class}_${name}` funcMap key today. (b) Phase B
  integration walk (`integration.ts:303`) currently only iterates
  `MethodDeclaration`s — extend to accessor declarations, mapping to the legacy
  accessor funcMap key. (c) the void-tail-assignment gap (finding 3 above) blocks
  the *setter* body `set name(v){ this.#name = v }` — either lift the setter’s
  lone assignment out of tail position in the gate, or land the general
  void-tail-assignment slice first. **Depends on Phase 1a (this PR).**
  `Dog_breed` additionally needs Phase E (it’s on the `extends` subclass).

- **#3000-C — Constructor IR emission (Phase C)** [L]. Build
  `ConstructorDeclaration`s in Phase B: allocate the struct, run field
  initialisers + ctor body private/public writes, synthesise the `return this`
  epilogue, and register under the `${Class}_new` funcMap key. Only after this
  does `Animal_new`'s claim become a *real* IR emission (today byte-inert).
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
