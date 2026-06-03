---
id: 1680
title: "Private setter write falls through to struct-field write — stacked private accessors cross-talk (~132 fails)"
status: done
created: 2026-05-27
updated: 2026-05-28
completed: 2026-05-28
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: class, class-fields-private, private-accessors
goal: spec-completeness
sprint: Backlog
fix_commit: 9ffbb1a52
related: [1456, 1365, 1591]
test262_fail: 132
---
# #1680 — Private setter write falls through to field-write (stacked private accessors cross-talk)

## Problem

Writing to a private **accessor** (`this.#x = v` where `#x` has a `set #x()`)
does not invoke the setter function. The classifier recognises the member as
an accessor but the assignment path has no branch that calls
`<Class>_set_<field>`, so control falls through to the generic
private-field write, which targets a `__priv_x` struct slot that the
getter never reads. With **multiple** private accessors the writes land in the
wrong slots and cross-talk.

Found while investigating `language/class/elements` residual test262
failures (task #108, sprint 56 follow-up). It is the dominant *fixable*,
not-yet-covered cluster in `elements` (the bigger `dstr` bucket is already
owned by the #1553/#779/#821/#1529 destructuring family).

### Minimal reproduction (runs through the test262 runner)

```js
class C {
  #a_; #b_;
  set #a(v) { this.#a_ = v; }
  set #b(v) { this.#b_ = v; }
  a(v) { this.#a = v; return this.#a_; }  // write via private setter, read backing field
  b(v) { this.#b = v; return this.#b_; }
}
var c = new C();
assert.sameValue(c.a(1), 1);  // ACTUAL: returns 2 — #a setter wrote the wrong slot
assert.sameValue(c.b(2), 2);
```

Isolation:
- **setters-only** (above): FAIL — `c.a(1)` returns `2`.
- **getters-only** (`get #a()`/`get #b()`, read via `this.#a`): PASS.

So **getter dispatch is correct; setter dispatch is broken.** Single-accessor
get/set roundtrips happen to pass in trivial cases; the failure surfaces
whenever a private setter's backing storage differs from the `__priv_<name>`
slot the field-write path assumes (which is *always* for a real accessor) and
is observable as cross-talk once ≥2 accessors share the class.

## Root cause

`src/codegen/expressions/assignment.ts:1906`:

```ts
const privateMember = classifyPrivateMember(ctx, target.name);
if (privateMember?.kind === "method" || privateMember?.kind === "accessor-readonly") {
  // ... evaluate RHS, throw TypeError ...
  return { kind: "externref" };
}
// NO branch for kind === "accessor" / "accessor-writeonly"
```

The classifier (`classifyPrivateMember`, `src/codegen/expressions/helpers.ts:188`)
correctly returns `accessor` / `accessor-writeonly` and knows the setter
function name is `<Class>_set_<fieldName>` (it checks
`ctx.funcMap.has(\`${className}_set_${fieldName}\`)`, helpers.ts:210). But the
assignment site only consumes the *throw* kinds. For `accessor` /
`accessor-writeonly` it does nothing and falls through to the static-prop /
struct-field write code below (assignment.ts:1928+), which mangles the
private name to `__priv_<name>` and writes it as a **data field** — bypassing
the setter entirely.

## Fix sketch

In the `classifyPrivateMember` block at assignment.ts:1906, add a branch for
`kind === "accessor" || kind === "accessor-writeonly"`:

1. Compile the receiver (`target.expression`) to the class struct ref.
2. Compile the RHS `value` to the setter's parameter type.
3. Emit `call <Class>_set_<fieldName>` (look up funcIdx via
   `ctx.funcMap.get(\`${className}_set_${fieldName}\`)`), mirroring how the
   public-accessor setter path at assignment.ts:2305/2371 already does it.
4. The assignment expression value is the RHS (per spec, `=` evaluates to RHS,
   not the setter's return) — `local.tee` the RHS before the call and re-push.

This is the same dispatch pattern already used for *public* accessors a few
hundred lines down; it just needs to be reached for the private-accessor case
before the field-write fallthrough.

## Acceptance criteria

1. The minimal reproduction above passes (`c.a(1)===1`, `c.b(2)===2`).
2. `language/class/elements/multiple-definitions-*` and
   `multiple-stacked-definitions-*` private-setter/getter families improve
   (≈132 tests across `language/statements/class/elements` +
   `language/expressions/class/elements`; the setter-write fix is the
   load-bearing change for the `-rs-private-setter-*` variants and the mixed
   getter+setter `-rs-private-getter-*` roundtrip variants).
3. A focused equivalence test (`tests/issue-1680.test.ts`) covering: single
   private setter, two stacked private setters (cross-talk), and a get/set
   pair roundtrip.
4. No regression in existing private-field / private-method test262 buckets.

## Out of scope (separate, smaller cluster)

`privatefield(get|set)-typeerror-*` (11 tests) — `assert.throws(TypeError,
() => new C())` for private access on a non-brand receiver. The compiler does
not throw the spec-mandated TypeError (`[[PrivateFieldGet]]`/`Set` on an
object lacking the brand). Distinct from setter dispatch; relates to #1365
brand-checks and #1456 private read-only TypeError. Track separately if
pursued.

## Investigation artifacts

- Baseline analysis: `language/class` = 6,217 pass / 2,240 bad. Within
  `/class/elements/`: `private` = 533 bad (largest sub-bucket after `dstr`).
- Repro scripts under `.tmp/` (`stacked-test.js`, `stacked2.js`, `stacked3.js`,
  `run2.mts`) — run via `runTest262File` from `tests/test262-runner.ts`.
