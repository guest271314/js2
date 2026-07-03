---
id: 3000
title: "IR: class-member residual — private fields, accessors, inheritance/super (class-method → 0)"
status: ready
sprint: current
created: 2026-07-02
updated: 2026-07-02
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
