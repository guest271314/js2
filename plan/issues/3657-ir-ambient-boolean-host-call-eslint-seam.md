---
id: 3657
title: "IR: ambient boolean host call rejected in ESLint Linter class method"
status: ready
created: 2026-07-26
updated: 2026-07-26
priority: critical
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: ir, host-interop
language_feature: ambient-functions
goal: npm-library-support
sprint: 76
es_edition: ES2015
related: [1371, 2693, 3325, 3518, 3653]
---
# #3657 — IR ambient host call with a boolean result

## Problem

The real-`espree`/real-`esquery` host-delegation seam in
`tests/issue-2693-host-delegated-select.test.ts` contains:

```ts
declare function __host_is_statement(code: string): boolean;

class Linter {
  verify(code: string): string {
    if (__host_is_statement(code)) {
      // rule logic
    }
    return "";
  }
}
```

When the test is allowed to execute (its path-vacuity defect is #3653), current
`origin/main` fails before Wasm:

```text
Codegen error: IR path failed for Linter_verify:
ir/from-ast: call to unknown function "__host_is_statement"
in Linter_verify [IR-FALLBACK]
```

The simpler #2693 demo still passes with ambient imports returning numbers and
strings. #3325 also proves runtime dependency wiring for ambient functions.
This issue is the IR call-graph/lowering gap before that runtime path.

## Scope

- Recognize a referenced ambient `declare function` as a typed external/host
  call when lowering a class method.
- Preserve its declared parameter and boolean result types.
- Record the host capability in the prepared import manifest before lowering.
- Keep unknown undeclared functions fatal; this is not a general
  string-whitelist escape hatch.

## Acceptance criteria

- A reduced class-method fixture calling
  `declare function predicate(s: string): boolean` compiles and validates.
- Injected host predicates returning true and false both produce the expected
  Wasm-visible branch result.
- Missing dependencies retain the documented #3325 behavior; this issue does
  not silently invent a predicate result.
- `tests/issue-2693-host-delegated-select.test.ts`, after #3653, loads real
  `espree`/`esquery`, compiles, instantiates, and passes its four runtime cases.
- Numeric/string ambient-call fixtures from #2693 and #3325 remain green.
