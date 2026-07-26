---
id: 3668
title: "compiled Acorn Test262 differential: valid programs overflow the host call stack during parse/AST return"
status: in-progress
assignee: ttraenkler/codex-acorn
created: 2026-07-26
updated: 2026-07-26
func-budget-allow:
  - src/runtime.ts::resolveImport
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

Keep the safer 512 ceiling. The final residual is fixed by splitting method
lookup from method invocation for a statically pinned fnctor receiver:

1. `__extern_get_raw_callable(receiver, name)` performs the live prototype
   lookup and returns the raw Wasm closure before its host frame returns.
2. A private stable-handle driver invokes that closure through the existing
   `__call_fn_method_N` surface inside Wasm.
3. Under-applied calls widen to the closure's declared arity while padding with
   the host's real `undefined` carrier and preserving the actual `__argc`.
4. If a live method has been replaced with a genuine JavaScript callable, the
   driver detects the non-closure and takes a host fallback. Prototype
   monkeypatching therefore remains observable.

The route is limited to receivers proven by fnctor escape analysis. Dynamic and
unresolved receivers keep the generic host MOP path.

## Reproduction

Run the full gate or one known file:

```text
pnpm run dogfood:acorn-test262 -- \
  --path=built-ins/AsyncGeneratorPrototype/throw/throw-suspendedYield-try-finally.js
```

The runner compiles pinned `acorn@8.16.0` once, parses the same sloppy and strict
source variants with node-acorn and compiled Acorn, and compares exact ESTree
output including positions.

## Measured acceptance

- The exact residual
  `language/statements/function/S13.2.1_A1_T1.js` now parses in **325 ms** after
  compilation with **2/2 sloppy+strict variants exact**, rather than
  overflowing or returning a null AST.
- A focused aliased-prototype regression performs 600 recursive method calls
  and returns 601. The same test replaces the method with host `Math.abs` and
  observes the live override.
- The required Acorn corpus is **22/22 exact** with zero compiled throws after
  the raw-driver and real-undefined padding changes.
- The prior final two-file Test262 mismatch report replays **2/2 files, 4/4
  variants exact**.
- The full 53,259-file post-fix differential is the final running gate.

## Acceptance

- A reduced representative from this family parses without a host stack
  overflow and its exact ESTree matches node-acorn.
- The full pinned-Acorn/Test262 differential reports zero
  `compiled-rejected-oracle-accepted` variants with this signature.
- The zero-import standalone FunctionDeclaration/ReturnStatement canary remains
  green; no parser, callable, rec-group, or interpreter ABI change is introduced
  without coordination with #2928.
