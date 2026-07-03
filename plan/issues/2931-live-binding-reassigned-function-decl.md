---
id: 2931
title: "codegen: reassigned function declaration is not a live binding (fn = 2 is lost)"
status: done
priority: high
sprint: 69
created: 2026-07-02
completed: 2026-07-02
assignee: ttraenkler/dev-2900b
feasibility: medium
task_type: bug
area: codegen
goal: spec-completeness
related: [2900, 2930, 2932]
parent: 2900
---

# #2931 — reassigned function declaration is not a live binding

Split from #2900 (RC3). Root-caused by dev-2900 — see #2900's Implementation Plan.

## Problem

A function declaration whose name is **assigned to** (`fn = 2`) is bound to an
immutable Wasm func index, not a mutable slot. In `emitIdentifierWriteFromLocal`
(`src/codegen/expressions/assignment.ts`) the LHS `fn` is not in `localMap`,
`capturedGlobals`, or `moduleGlobals` (function decls live in `funcMap`), so the
write falls through to the **"undeclared sloppy implicit global → auto-allocate a
throwaway local"** arm — the assigned value is written to a discarded local and
never observed. Reads of `fn` emit a cached closure struct, disconnected from that
write.

Proven single-module (name-matching, so #2930 does not apply):
`function fn(){ fn = 2; return 1; } … fn(); (fn as any) === 2` → returns **200**
(the read still sees the function, not `2`).

Per ES semantics module bindings are live: the #2900 test
(`test/language/module-code/eval-gtbndng-indirect-update-dflt.js`) reassigns the
default-exported function and asserts the indirect import observes the new value.

## Fix (planned)

1. Static scan (between `collectDeclarations` and body compilation): collect
   function-declaration names that appear as an assignment **target** anywhere in
   the realm (rare pattern) — `ts.isBinaryExpression` with `=` whose LHS resolves
   to a `FunctionDeclaration`.
2. For each, register a **mutable** `externref` module global (bypassing
   `registerModuleGlobal`'s function-shadow skip) and record the name in a new
   `ctx.liveFuncBindingGlobals: Set<string>`.
3. **Read** path (`identifiers.ts`): early arm — if `name ∈ liveFuncBindingGlobals`,
   `global.get moduleGlobals[name]`.
4. **Write** path already routes an identifier assignment to `moduleGlobals` via
   `global.set` once the global exists — no change needed.
5. **Init**: in `__module_init`, initialize each live global to the function's
   closure value (`emitCachedFuncClosureAccess` — NOT via the identifier read
   path, which would recurse into the new global.get arm) so reading the name
   **before** any reassignment still yields the function (avoids regressing
   `const g = fn; fn = 2`).
6. **#2930 interplay**: extend `registerImportBindingAliases` to propagate
   `liveFuncBindingGlobals` membership to aliased local names, so a cross-module
   `import val from` reads module A's live global (`moduleGlobals[val]` copied from
   `moduleGlobals[fn]`).
7. **Calls** keep the direct `funcMap` call (valid: the test calls before the
   reassignment). Calling a reassigned name _after_ reassignment (would throw in
   real JS) is out of scope — noted as a known narrow limitation.

Index-shift discipline: register the live globals in the same Phase-2.5 window as
other module globals (reserve up-front, avoid late-global index desync).

## Acceptance

- Single-module: `function fn(){fn=2;return 1} fn(); fn===2` observes `2`.
- No regression in `module-code/` or existing tests (CI).

## Implemented (dev-2900, 2026-07-02)

`registerReassignedFunctionGlobals` in `src/codegen/index.ts`, wired into BOTH the
single-source (`generateModule`) and multi-source (`generateMultiModule`) phases
after `collectDeclarations`. Read arm in `identifiers.ts`; `__module_init` closure
seed in `declarations.ts` (`compileModuleInitBody`, gated so it runs even with no
other init statements); `ctx.liveFuncBindingGlobals` field on the context.
`registerImportBindingAliases` (#2930) propagates set membership to import aliases.
Tests: `tests/issue-2931.test.ts` (4/4). All behaviour gated on the normally-empty
set — byte-identical for programs that never reassign a function declaration.

**End-to-end proof:** with #2930 + #2931 + `allowJs` + a **top-level** import, the
real test262 fixture `eval-gtbndng-indirect-update-dflt.js` returns `1` (PASS). The
two remaining gaps are runner-side and belong to #2932/RC1 — see that issue.
