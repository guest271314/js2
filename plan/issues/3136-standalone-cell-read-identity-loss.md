---
id: 3136
title: "Standalone: object read back through a boxed-capture cell loses `===` identity with the outer variable"
status: ready
sprint: Backlog
created: 2026-07-10
updated: 2026-07-10
priority: medium
horizon: s
feasibility: medium
task_type: bug
area: codegen
language_feature: closures, strict-equality
goal: standalone-mode
related: [3128, 2583, 3130]
origin: "#3128 rescue (fable-18th) — surfaced when the issue-3128 test suite was moved from the vacuous `{standalone:true}` compile option (silently gc-host) to the real `target: 'standalone'` lane"
---

# #3136 — standalone cell-read object identity loss

## Problem (minimal repro, `--target standalone`, main 32bae1f48f + #3128 rescue)

```ts
export function test(): number {
  var p2: any;
  var f = function () {
    return p2;
  };
  p2 = { a: 1 };
  if (f() !== p2) return 8; // ← returns 8 in standalone; host returns 1
  return 1;
}
```

No inlined IIFE, no self-capturing RHS — this is NOT #3128 (whose write path
is correct: the VALUE flows, `f().a === 1` passes). When `p2` is promoted to a
ref-cell capture and the closure reads it back, the strict-equality of the
cell-read result against the outer read of the same variable answers FALSE for
the SAME object.

Controls (all pass):

- no write after capture (`var p2: any = {a:1}; var f = () => p2;`) → `f() === p2` true.
- direct aliasing (`var q: any = p2`) → `q === p2` true.
- value flow through the cell (`f().a === 1`) → true.

## Suspect

One side of the comparison goes through a different boxing/conversion than the
other (cell-read → anyref → externref round-trip vs the outer local's
representation) and the `===` lands in the tag-5 host-only arm — same family
as `reference_2583_any_strict_eq_tag5_host_only` and the #3130 note
("identity on $Promise values routed through any-typed vars fails standalone
— seen === p1 false even with no self-capture").

## Impact

- The identity assertions in `tests/issue-3128.test.ts` had to be relaxed to
  value assertions on the standalone lane (`standaloneSrc` variants — grep
  `#3136` there); restore them when this is fixed.
- test262 Promise `resolve-settled-*-self.js` acceptance on the widened
  standalone lane compares self-captured promise identity.

## Acceptance

- The repro above returns 1 under `target: "standalone"`.
- The two `standaloneSrc` variants in `tests/issue-3128.test.ts` are removed
  (identity asserts run on both lanes).
- No host-lane byte diffs.
