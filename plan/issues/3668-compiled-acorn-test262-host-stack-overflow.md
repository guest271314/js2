---
id: 3668
title: "compiled Acorn Test262 differential: valid programs overflow the host call stack during parse/AST return"
status: in-progress
assignee: ttraenkler/codex-acorn
created: 2026-07-26
updated: 2026-07-26
priority: high
horizon: m
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: runtime, codegen
language_feature: parser, value-representation
goal: acorn-dogfood
umbrella: 1712
related: [1712, 2801, 3308, 3343, 3445]
---

# #3668 — compiled Acorn valid-input host stack overflow

## Problem

The full pinned-Acorn/Test262 differential introduced under #1712 found a
concentrated family where node-acorn 8.16.0 accepts the input but the identically
pinned compiled parser raises:

```text
host-error: Maximum call stack size exceeded
```

This is not a matching Acorn syntax rejection and therefore counts as an
incorrect parser result. The completed four-shard baseline contains **90
affected files / 180 sloppy+strict variants**. After the nullable-return and
vec-mutation fixes removed the lexical-error family, the same recorded set
reproduces 89 files / 178 variants at the original depth-100 guard.

The failures are not explained by source size alone. Examples range from roughly
1 KiB to 26 KiB and include:

- async-generator `yield*` completion cases;
- `Temporal` tests containing infinities;
- RegExp legacy/exec tests;
- proxy/iterator abrupt-completion tests; and
- older staging/destructuring regressions.

## Boundary arbitration 2026-07-26

An in-module Acorn consumer now parses the representative async-generator file
and returns only `ast.body.length`. It reaches the same RangeError before the
scalar returns, so the failure is **not** recursive host AST materialization.

The captured stack lands on `buildImports`' `hostCallDepth` guard and alternates
compiled Acorn closures through `__extern_method_call`. The guard rejected the
101st nested Wasm→host→Wasm crossing even though Acorn was making forward
progress through a valid nested expression. Its fixed depth of 100 was lower
than valid parser workloads require.

The working fix raises that defensive cycle limit to 512, clearing 89 of the 90
baseline files. Test262's explicit 32-deep nested-function stress case still
reaches that ceiling. Raising the guard again to 1024 is not a solution: the
same case then exhausts V8's native stack inside the alternating
Wasm→host→Wasm method bridges before the explicit guard fires.

Keep the safer 512 ceiling. The final residual needs an in-module prototype
method-dispatch path (or equivalent stack-flattening), not a larger host stack
allowance.

## Reproduction

Run the full gate or one known file:

```text
pnpm run dogfood:acorn-test262 -- \
  --path=built-ins/AsyncGeneratorPrototype/throw/throw-suspendedYield-try-finally.js
```

The runner compiles pinned `acorn@8.16.0` once, parses the same sloppy and strict
source variants with node-acorn and compiled Acorn, and compares exact ESTree
output including positions.

## Work plan

1. Re-run the representative scalar consumer at the widened depth.
2. Replay all recorded stack-family files, not only the first representative.
3. Add a focused guard regression that exceeds 100 legitimate host crossings
   and a deliberate recursion case that still terminates at the new ceiling.
4. Retain the broad Test262 census as the final manual gate.

## Acceptance

- A reduced representative from this family parses without a host stack
  overflow and its exact ESTree matches node-acorn.
- The full pinned-Acorn/Test262 differential reports zero
  `compiled-rejected-oracle-accepted` variants with this signature.
- The zero-import standalone FunctionDeclaration/ReturnStatement canary remains
  green; no parser, callable, rec-group, or interpreter ABI change is introduced
  without coordination with #2928.
