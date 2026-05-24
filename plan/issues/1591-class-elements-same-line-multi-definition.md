---
id: 1591
title: "class/elements: same-line / stacked member definitions lost or reordered (~294 fails)"
status: backlog
created: 2026-05-24
updated: 2026-05-24
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: classes, class-elements
goal: spec-completeness
sprint: Backlog
renumbered_from: 779b
parent: 779
test262_fail: 294
test262_category: language/statements/class/elements, language/expressions/class/elements
---
# #1591 — `class/elements` same-line / stacked class-member definitions lost or reordered

## Problem

**294 test262 failures** in `class/elements` subtests where multiple class members appear on the same source line, are separated by a semicolon inside the class body, or follow a "new-sc-line" / "after-same-line" layout. `verifyProperty` calls fail because the methods are absent, have wrong descriptor flags, or are emitted in the wrong order.

### File-name patterns and counts (2026-05-24 run)

| Pattern | ~Count |
|---------|--------|
| `after-same-line-*` | ~90 |
| `multiple-stacked-definitions-*` | ~79 |
| `multiple-definitions-rs-*` | ~54 |
| `new-sc-line-*` | ~46 |
| `wrapped-in-sc-*` | ~22 |

### Sample failures

```
test/language/statements/class/elements/after-same-line-method-computed-symbol-names.js
  returned N — verifyProperty(C.prototype, "m", { enumerable: false, configurable: true, ... })

test/language/statements/class/elements/multiple-stacked-definitions-rs-field-identifier-initializer.js
  returned 4 — assert(!Object.prototype.hasOwnProperty.call(C, "field"))

test/language/statements/class/elements/multiple-definitions-rs-static-privatename-identifier-initializer-alt.js
  returned 10 — assert.sameValue(c.foo, "foobar")

test/language/statements/class/elements/new-sc-line-gen-rs-private-setter-alt.js
  returned 5 — verifyProperty(C.prototype, "method", ...)
```

### Root cause hypothesis

The class-body emitter in `src/codegen/index.ts` (class-element pipeline) silently drops or reorders consecutive class members when:
1. They appear on the same source line (`after-same-line`, `new-sc-line`)
2. They are separated by semicolons inside the class body (`multiple-stacked-definitions`, `wrapped-in-sc`)
3. Alternating static/instance members appear with RS (random-selection) interleaving (`multiple-definitions-rs`)

The `rs` suffix means the test generator permuted the order of class-element kinds — the bug likely manifests as a dropped member when two adjacent definitions share some internal state that resets on the next element.

## Acceptance criteria

- All ~294 test262 files in the `class/elements/{after-same-line,multiple-stacked-definitions,multiple-definitions-rs,new-sc-line,wrapped-in-sc}*` groups pass
- No regressions in equivalence tests

## Notes

- Identified in the #779 bucket decomposition (`plan/issues/1569-779-bucket-decomposition.md`, 2026-05-21) as sub-issue "779b"; formally filed 2026-05-24 after harvest
- The 1569 decomposition estimated ~290 fails — current measurement 294, consistent
- Cross-check the TypeScript parser output for these forms first; the bug may be in class-body lowering rather than parsing
