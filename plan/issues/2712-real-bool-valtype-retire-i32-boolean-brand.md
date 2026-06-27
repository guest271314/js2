---
id: 2712
title: "Introduce a real bool ValType; retire the optional i32 boolean brand"
status: blocked
blocked_on: "architect ValType-registration decision — the boolean analog of #2044's BigInt i64-brand decision (see Senior dev note + Architect hand-off below)"
sprint: current
created: 2026-06-26
updated: 2026-06-27
priority: high
feasibility: hard
reasoning_effort: max
task_type: refactor
area: codegen
language_feature: value-representation
goal: value-rep-substrate
related: [1788, 1917, 2044, 2580, 2660]
---
# #2712 — Real bool ValType; retire the optional i32 boolean brand

**Source:** 2026-06-26 audit. Recurring "bug factory" #2: representation
collision. `{kind:"i32"}` simultaneously means **number**, **boolean**, and
**char-code**. Booleanness is carried as an *optional* side-channel brand
(`{kind:"i32", boolean:true}`, `src/checker/type-mapper.ts`) that **every boxing
site must remember to consult** — and several don't.

## Problem

#1788 (done) added `__box_boolean` and the brand for the dynamic-getter path, but
the brand is dropped at multiple boxing sites, so a boolean reifies as the
*number* 1/0:

- `Object.values`/`Object.entries` box a boolean field as `1`/`0`
  (`object-ops.ts:4000-4003`, `:4059-4063`) → `Object.values({a:true})[0]===true`
  is false; `typeof` is `"number"`.
- Map/Set key coercion boxes boolean keys as numbers (`map-runtime.ts:1204-1212`);
  `__same_value_zero` has no boolean arm → `new Set([true]).has(1)` wrongly true.
- `__to_property_key` has no boolean arm (`object-runtime.ts:459-502`) → `o[true]`
  keys `"1"` not `"true"`; a null/undefined computed key hits a non-null
  `ref.cast $AnyString` and **traps**.
- `coerceType` i32→externref drops the brand (`type-coercion.ts:1525-1537`) even
  though the adjacent i64→externref arm honours the analogous `bigint` brand.

Any *new* i32→externref site is a latent boolean-as-number bug. The brand is the
wrong shape: optionality means correctness depends on memory, not on types.

## Recommendation

Promote boolean to a **first-class ValType** (`{kind:"bool"}`), the way `bigint`
already has a typed i64 lane. Then:

- boxing dispatches on the ValType (`bool` → `__box_boolean`) — unrepresentable to
  "forget the brand";
- `__same_value_zero`, `__to_property_key`, `Object.values/entries`,
  `coerceType`, and the descriptor reify path each gain a `bool` arm by
  construction (the type forces the switch to be exhaustive);
- the i32 lane reverts to meaning *number/char-code* only.

This is value-rep substrate work — coordinate with #1917 (single coercion engine)
and the #2580 substrate spine so the bool lane lands once, centrally.

## Acceptance criteria

- [ ] A `bool` ValType exists; the checker emits it where it currently emits
      `{kind:"i32", boolean:true}`.
- [ ] All boxing/coercion/property-key/SameValueZero sites dispatch on `bool`;
      the optional `boolean:true` brand is removed.
- [ ] `Object.values({a:true})[0]===true`, `new Set([true]).has(1)===false`,
      `o[true]` keys `"true"`, `o[null]` keys `"null"` (no trap) — all in both
      host and standalone modes.
- [ ] Equivalence + test262 non-regressing; full-CI / merge_group (broad impact).

---

## Senior dev note (Esch, 2026-06-27) — VERIFY-FIRST verdict: architect-gated

VERIFY-FIRST done on `origin/main` `f515906`. **Verdict: this is NOT a clean
senior slice — it is an architect-class ValType-registration decision, the exact
boolean analog of #2044** (BigInt i64-brand ValType), which the project has
already gated on an architect decision and marked `status: blocked`. #2712 is
therefore set `status: blocked`, `blocked_on` the same architect gate. No code was
changed. The analysis below is the implementation-note (the WHY) for whoever
specs/implements it next.

### Root cause — the brand is leaky *by design*, not by oversight

The issue frames the bug as "boxing sites *forget* to consult the brand." The
deeper truth found by tracing: **the brand is usually ABSENT at the boxing site
for the exact values that fail**, so there is nothing to consult.

`mapTsTypeToWasm` (`src/checker/type-mapper.ts:50-57`) only attaches
`{kind:"i32", boolean:true}` for a TS type that *is* `boolean`/`BooleanLiteral` —
i.e. **declared** boolean storage (struct fields, params, returns, annotated
locals). But **computed** booleans are produced as **bare `{kind:"i32"}` with no
brand**:

- boolean literals — `src/codegen/literals.ts:1142` (`TrueKeyword`→1,
  `FalseKeyword`→0) return bare i32;
- every comparison / equality / predicate op — e.g. `src/codegen/binary-ops.ts`
  `return { kind: "i32" }` at :300, :303, :313, :318, :394, :398, :419, :428,
  :436, :441 …;
- logical / `!` results likewise.

So `o[true as any]` and `new Set([true])` push a **brandless** i32 into the
boxing path. `coerceType` i32→externref (`src/codegen/type-coercion.ts:1525-1537`)
then `__box_number`s it to the *number* `1` — and no brand-consulting patch can
fix that, because the brand was never set. (Contrast the adjacent i64→externref
arm at `:1538-1552`, which honours `from.bigint` — but bigint shares the i64 lane
that numbers do NOT use, while boolean shares i32 with number/char-code, the
"representation collision" this issue names.)

**Consequence:** the robust fix REQUIRES typing boolean *values* (literals,
predicates, logical results) as a first-class lane, not just declared storage.
That is precisely the `{kind:"bool"}` promotion the Recommendation asks for — and
it is structurally disruptive, see below.

### Blast radius — why a separate `bool` kind is architect-scale

- **524 `=== "i32"` sites across 49 source files.** The brand was deliberately
  made **structurally inert** (#1788): every `.kind === "i32"` check still matches
  a branded boolean, so boolean locals/arithmetic/branch/`local.alloc` codegen is
  unchanged. A *separate* `{kind:"bool"}` kind inverts that guarantee — each of
  those 524 sites must be audited to also accept `bool` for i32-style storage,
  branching, and arithmetic, or boolean codegen breaks. This is the reason the
  inert brand exists.
- **Type-identity ripple (auto-park-prone).** `src/emit/canonical-recgroup.ts:132`
  already canonicalizes a boolean-branded i32 field as token `i32b`, *distinct*
  from `i32`. So booleanness already participates in struct type identity: two
  structs differing only in bool-vs-number get different type indices though they
  encode byte-identically. Widening which values are bool-typed shifts struct
  type-index assignment → validation/index churn that only surfaces in
  `merge_group` (broad value-rep ⇒ validate on the full floor, never a scoped
  sweep). Cf. memory `project_type_index_shift_and_deadelim` /
  `reference_subview_type_idx_stability`.
- **Emit seam.** `src/emit/binary.ts` (`encodeValType`, switch at :40/:623/:698)
  has no `bool` arm; a `{kind:"bool"}` must encode as the i32 byte `0x7F` there
  (Wasm has no bool valtype). One-line, but it is a required seam.

### Re-grounding (the issue is partly stale on current main)

Tested in **host mode** on `f515906` (`__box_boolean` host path):

| Case | issue claim | current main (host) |
|------|-------------|---------------------|
| `Object.values({a:true})[0]===true` | false (boxes 1) | **already true** ✓ (getter-extract honours brand) |
| `typeof Object.values({a:true})[0]` | `"number"` | **already `"boolean"`** ✓ |
| `o[null]` computed key | **traps** | **no trap**, keys `"null"` ✓ |
| `new Set([true]).has(1)` | wrongly true | **still wrongly true** ✗ (repro) |
| `o[true]` key | `"1"` | **still `"1"`** ✗ (repro) |

Both remaining repros share the single brandless-literal root cause above. The
issue's Problem list should be re-grounded against this table; the
`Object.values`/`typeof`/`o[null]` items are already fixed in host mode
(standalone mode is where the `$Object` dynamic reader gaps remain — see memory
`project_standalone_any_string_value_read_substrate`, and they coordinate with the
in-flight #2580/#2660 spine).

### Why NOT a quick brand-patch sub-slice

A tempting incremental sub-slice (brand boolean literals + predicate results, then
honour the brand in `coerceType`) was considered and **declined**: it is itself a
broad value-rep change (it widens what flows as `i32b` → the canonical-recgroup
type-identity ripple above → auto-park-prone), it is partially redundant with the
eventual `{kind:"bool"}` (same boxing-decision logic, different discriminant), and
it would collide with the in-flight #2580/#2660 substrate spine. The Recommendation
is right that the bool lane must land **once, centrally** with #1917 + the #2580
spine — a throwaway partial is not worth the merge-queue risk.

---

## Architect hand-off — ValType-registration problem statement

**Decision required (mirror #2044's i64-bigint decision):** should booleanness be
a first-class ValType lane `{kind:"bool"}` (storage = i32 at the emit seam), or
stay a TS-type-driven boxing decision threaded at coercion sites? Recommended:
the `bool` lane, because the brand is unreachable on computed booleans (see Root
cause) — but the registration cost is real and must be sequenced with #1917 /
#2580.

**If `{kind:"bool"}` is chosen, the spec must cover:**

1. **Union + emit seam.** Add `{ kind: "bool" }` to `ValType`
   (`src/ir/types.ts:146-160`). Add a `bool` arm to `encodeValType`
   (`src/emit/binary.ts`) emitting the i32 byte `0x7F`. Add a `bool` token to
   `canonical-recgroup.ts:122` `valTypeToken` — decide deliberately whether `bool`
   canonicalizes as today's `i32b` (preserve current struct identities → fewer
   type-index shifts) or its own token.
2. **Producers (where `bool` is born).** `mapTsTypeToWasm` boolean arm →
   `{kind:"bool"}`; boolean literals (`literals.ts:1142`); all comparison /
   equality / predicate / logical / `!` results in `binary-ops.ts` and
   `expressions/unary.ts`, `expressions/logical-ops.ts`. This is the part that
   actually fixes `o[true]` / `Set([true])`.
3. **Consumers — the 524 `=== "i32"` audit.** Produce the audit plan: which sites
   must treat `bool` *exactly* as i32 (arithmetic, branch conditions, `local`
   alloc/get/set, `select`, `i32.eqz`, switch lowering, IR `from-ast`/`lower`/
   `verify`/`propagate`, linear backend `codegen-linear/*`) vs. which must
   *dispatch* on `bool` (the boxing/coercion matrix). Recommended mechanics: a
   single `isI32Like(t)` helper (`t.kind==="i32" || t.kind==="bool"`) applied at
   the storage/arithmetic/branch sites, so the audit is a mechanical sweep rather
   than 524 bespoke edits; reserve true `=== "bool"` dispatch for the boxing seam.
4. **Boxing / coercion dispatch (the payoff — exhaustive by construction).**
   `coerceType` i32→externref (`type-coercion.ts:1525`) and the #1917 engine
   (`coercion-engine.ts:138`, already brand-aware) → `bool` ⇒ `__box_boolean`;
   `__same_value_zero` (`any-helpers.ts:377+`) gains a bool arm
   (fixes `Set([true]).has(1)`); `__to_property_key`
   (`object-runtime.ts:433-513`, standalone) + the host `__extern_*` path gain a
   bool arm (fixes `o[true]`→`"true"`); `Object.values/entries` + descriptor
   reify (`object-ops.ts:4120/4232/4305/4337/4385/4400`) dispatch on `bool`;
   then **delete the `boolean?: true` brand** from the `i32` arm and let `tsc`
   enumerate every remaining positional read.
5. **Sequencing.** Land with / behind #1917 (single coercion engine) and the
   in-flight #2580/#2660 substrate spine so the lane lands once. Validate on the
   **full merge_group floor** (host + standalone), not a scoped sweep — broad
   value-rep + type-identity ripple is auto-park-prone.

**Acceptance (unchanged from above), both host and standalone:**
`Object.values({a:true})[0]===true`, `new Set([true]).has(1)===false`, `o[true]`
keys `"true"`, `o[null]` keys `"null"` (no trap); equivalence + test262
non-regressing on full CI.

**Sequencing cross-link (architect, esch 2026-06-27):** #2732(b) — strict-equality
between a primitive boolean and a number returning the wrong answer (`true === 1`
should be `false`; verified `false === 0` evaluates EQ on current main) — is
downstream of this same boolean-as-i32 representation collision and is
**unrepresentable to fix cleanly until the `bool` lane exists**. Sequence #2732(b)
behind #2712; #2732(a) (unary `+/-/~/>>>` ToPrimitive trap) is independent and
ships on its own.
