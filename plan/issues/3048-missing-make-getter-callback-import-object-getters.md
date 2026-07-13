---
id: 3048
title: "codegen: 'Missing __make_getter_callback import' CE on object-literal getters / computed-property methods (#1027 resurgence, ~22 files)"
status: done
completed: 2026-07-05
sprint: 71
priority: high
horizon: m
feasibility: medium
created: 2026-07-05
assignee: ttraenkler/dev-3044
task_type: bugfix
area: codegen
language_feature: object-literals, accessors, computed-property-names
goal: spec-completeness
test262_category: language/expressions/object, language/computed-property-names
related: [1027, 1239]
---

# #3048 — Missing `__make_getter_callback` late-import on object-literal getter / computed-method paths

## Source

Fresh default-lane test262 harvest of current main
(`.test262-cache/test262-current.jsonl`, 2026-07-02). **22** `compile_error`
files failing with `L#:# Missing __make_getter_callback import`.

## Root cause hypothesis (#1027 resurgence)

`#1027` (done, sprint 40) fixed a *missing `__make_getter_callback` late-import*
in the PR-#43 accessor paths. The same class of failure has **resurged** on
current main for a distinct set of object-literal getter / computed-property
method paths: a code path emits a `call __make_getter_callback` (the accessor /
method-value closure maker) without first registering the import, so the module
references an import index that was never added → hard CE at emit/validate time.

This is a **late-import registration miss** (the `*_funcidx_desync` /
`ensure*-before-emit` family): the import must be registered — and its funcIdx
resolved by name at emit time — on every path that lowers an object getter or a
computed-property method value.

## Sample failing files (22 total)

- `language/expressions/object/11.1.5_6-3-1.js` (`o = {get foo(){return 1;}}`)
- `language/expressions/object/11.1.5-0-1.js`, `11.1.5-0-2.js`, `11.1.5_4-4-b-1.js`
- `language/computed-property-names/object/method/number.js` (+ `string.js`, `symbol.js`, `super.js`)
- `language/computed-property-names/to-name-side-effects/object.js`
- `built-ins/Function/prototype/toString/method-computed-property-name.js`

## Suggested approach

1. Grep `__make_getter_callback` (emit site + the `ensureLateImport`/registration
   site) and identify which lowering path emits the `call` without the matching
   registration. The computed-property-method and object-getter arms are the
   prime suspects (the plain object-getter top-level path already works per
   #1027, so this is a sibling arm the #1027 fix didn't cover).
2. Register the import on that arm and resolve its funcIdx **by name at emit /
   finalize** (never cache an index across an `ensure*` that adds a late import —
   the funcIdx-shift hazard).

## Acceptance criteria

- The 22 files no longer `compile_error` with the missing-import message.
- A focused test: `o = { get foo(){return 1;} }` and
  `({ [Symbol.iterator]() {} })` compile and round-trip.
- No test262 regression.

## Resolution (2026-07-05, dev-3044)

Root cause confirmed as a **pre-pass detection gap**, not a funcidx-shift bug.
The `__make_getter_callback` late-import is registered by the AST pre-pass
`collectCallbackImports` (`src/codegen/declarations.ts`) — which walks the outer
file. Two families of bridge-routed object shapes were invisible to it:

1. **Non-plain-literal computed-property methods** — the well-known-`Symbol`
   arm (`{ [Symbol.iterator]() {} }`) and the runtime-key arm
   (`{ [ID(2)]() {} }`), both of which install the method value via the
   `__make_getter_callback` bridge in host/GC mode (`literals.ts`). The pre-pass
   only registered the bridge for the `dispose`/`asyncDispose` arm. A plain
   numeric/string-literal key (`{ [1]() {} }`) resolves to a static method name
   and takes the bridge-free struct path (correctly no registration). Fixed by
   broadening the computed-method detection in `declarations.ts`.
2. **Accessors inside a compiled `eval("o = {get foo(){…}}")` constant string**
   — the getter lives inside the eval SOURCE STRING, invisible to the outer-file
   pre-pass. Fixed in the static-eval-inline path (`eval-inline.ts`): scan the
   parsed eval AST and `ensureLateImport` + `flushLateImportShifts` the bridge
   before compiling the spliced statements (same ensure-then-flush discipline as
   the `literals.ts` well-known-symbol arm — this is the correct way to add the
   import at emit without the funcIdx desync).

Both fixes are **host/GC-only**: under standalone/WASI the accessor/method lowers
to a host-free closure (#1888 S5b / #2194); the unsatisfiable `env::` bridge
import is never declared there (verified — standalone binaries carry no
`env::__make_getter_callback`).

**Result:** the missing-import `compile_error` is eliminated for every sampled
file. `11.1.5_6-3-1.js`, `11.1.5_4-4-b-1.js`, and
`built-ins/Function/prototype/toString/method-computed-property-name.js` flip
compile_error → **pass**. Regression test: `tests/issue-3048.test.ts` (12 cases,
both lanes). 0 test262 regressions (host-gated, additive; 8 related suites stay
green).

### Remaining — separate follow-ups (NOT the missing-import CE)

Fixing the import unmasks two pre-existing deeper gaps on the SAME files (now
runtime `fail`, no longer CE — so acceptance is met, but these want their own
issues):

- **Runtime null-deref calling a runtime/well-known-symbol computed method**
  (`number.js`, `string.js`, `symbol.js`, `super.js`, `object.js` →
  "dereferencing a null pointer" / "Cannot convert null to object"). The method
  value is installed but not callable via the dynamic member read — the
  `__extern_set` key/value install for the runtime-computed-method arm is
  incomplete.
- **`11.1.5-0-1.js` / `-0-2.js`** now compile+run but fail an assertion
  (`assert #1 at L18`) — an eval/getter descriptor-semantics matter, not codegen.
