---
id: 2181
title: "defineBuiltin(name, {elementKinds, lower}) scaffold — unify per-representation element-load/ToString/null handling"
status: done
sprint: 69
created: 2026-06-16
updated: 2026-07-03
completed: 2026-06-28
assignee: ttraenkler/agent-a20aa13da21b8d592
priority: medium
feasibility: hard
reasoning_effort: high
task_type: refactor
area: codegen
language_feature: compiler-internals
goal: core-semantics
related: [2088, 2074, 2122, 1968, 1998, 2075]
origin: "Sprint-62 follow-up: #2088 deferred off the dev line (multi-file scaffold of fragile builtin-registration code); route to senior-dev for s63"
---

# #2181 — per-builtin representation scaffold (carried over from #2088)

## Why this is its own (s63, senior-dev) issue

#2088 proposed a `defineBuiltin(name, {elementKinds, lower})` scaffold that
supplies the element-load / ToString / null-handling matrix ONCE, so each
builtin stops re-deriving it per representation (host vec / native string /
standalone any). During sprint 62 it was assessed as **over the dev line**:
`reasoning_effort: high`, a multi-file refactor of fragile builtin-registration
code scattered across three scanner sites
(`declarations.ts:545/1164`, `index.ts:1035/7258`) plus `registry/imports.ts`.
The seniors were CPU-bound on async/Proxy and the box was at its load cap, so a
big risky refactor wasn't worth a slot mid-sprint. #2088 was released; this
carries the scaffold forward as a planned sprint-63 item.

## Problem (from #2088)

Each builtin re-implements element access and coercion for each representation.
`join` alone bred 4 issues (#1968, #1998, #2074, #2075); `fromCharCode` bred
#2122 with the single-arg bug copied independently into each of its 4 paths.
No shared scaffold is parameterized by representation.

## Fix direction

A `defineBuiltin(name, {elementKinds, lower})` scaffold supplying the
element-load/ToString/null-handling matrix once; migrate `join` +
`fromCharCode` first (highest bred-bug density), then repeatable per builtin.
Full analysis: `plan/log/analysis-2026-06/05-structure-review.md` §2c.

## Acceptance criteria (from #2088)

- `join` + `fromCharCode` served by one definition each across
  host/native/standalone; their historical issue test suites
  (#1968/#1998/#2074/#2075 join, #2122 fromCharCode) stay green.
- Adding a deliberate bug to the shared lowering fails ALL lanes (the
  cross-lane guard #2088 acceptance-(2) asked for).

## Note on acceptance-(2) coverage

The "deliberate bug fails all lanes" guard is already PARTIALLY covered by the
existing multi-lane suites: #2074 (join, 3 lanes) + #2122 (fromCharCode, 4
backends). The scaffold should preserve/extend those rather than replace them.

## Routing

Senior-dev — touches core builtin-registration code with broad blast radius.
Spec the migration of `join` + `fromCharCode` first as a bounded first slice
before generalizing.

## Remaining work (2026-06-17, PO reconcile — NOT started)

The s63 reconciler flagged this issue because merged PR #1550
(`test(#2181): inject proxyTrapsHelper.js …`) carries `#2181` in its title.
That is a **title misattribution** — PR #1550 is a test262-runner harness change
that actually belongs to issue **#2183** (it touches `tests/test262-runner.ts`,
`tests/issue-2183.test.ts`, and `plan/issues/2183-…`, not any builtin-registration
code). It implements **none** of this issue's `defineBuiltin` scaffold.

The entire scope is therefore still open: the `defineBuiltin(name, {elementKinds,
lower})` scaffold, the `join` + `fromCharCode` migration onto it across
host/native/standalone, and the cross-lane "deliberate bug fails all lanes" guard
(acceptance-2). Status stays `ready` for senior-dev pickup.

## Resolution (2026-06-28, verify-first)

**Done — already implemented on `main` via #2088, commit `563e2fe2`
(`refactor(#2088): per-builtin representation scaffold for join + fromCharCode`,
2026-06-17).** The 2026-06-17 "Remaining work" note above was a misattribution
analysis of PR #1550 (a test262-runner harness change for #2183) and was written
without awareness of the _real_ #2088 PR, which landed the scaffold the same day.

The scaffold lives in `src/codegen/builtin-scaffold.ts`:

- `StringRepr` strategy — the minimal per-representation seam (`literal`,
  `concat`, `resultType`), with concrete `hostStringRepr` (JS-string / externref,
  `wasm:js-string` `concat`) and `nativeStringRepr` (standalone / `$AnyString`,
  pure-Wasm `__str_concat`).
- `emitStringJoinFold` + `allocJoinFoldLocals` — the shared `join` loop owning
  the separator placement and the empty-array→`""` (not `"null"`, the #1968 bug)
  fallback **once**. Both `join` lanes route through it:
  `array-methods.ts` native lane (≈5309) and host lane (≈5558).
- `emitVariadicStringConcat` — the shared `fromCharCode`/`fromCodePoint` variadic
  fold. `compileFromCharCodeFamily` (`expressions/calls.ts` ≈3043) serves all
  four lanes (native helper × host import) from one definition, killing the
  single-argument-drop (#2122 / #1955) at the source.

Acceptance criteria met:

- **AC1** — `join` + `fromCharCode` are each served by one shared definition of
  the element-load/ToString/null-handling matrix across host + native lanes (the
  per-element load is the intentional, genuinely-per-rep `elemToStr` seam; the
  externref-receiver `__array_join_any` fallback is intentionally excluded — a
  single host delegation with nothing to drift).
- **AC2** — a deliberate bug in the shared `emitStringJoinFold` /
  `emitVariadicStringConcat` regresses every lane at once; covered by the
  multi-lane suites `tests/issue-2074.test.ts` (join, 3 lanes),
  `tests/issue-2122.test.ts` (fromCharCode, 4 backends), and
  `tests/issue-2088.test.ts`.

Verified green on current main (`bf56e30`): 30 tests across
`issue-2088` + `issue-2074` + `issue-2122`, plus this issue's named anchor
`tests/issue-2181.test.ts` (cross-lane parity guard).

Closing as `done`. No source change is warranted: the bounded first slice the
issue prescribed (`join` + `fromCharCode` first, "then repeatable per builtin")
has landed, and manufacturing a broader `defineBuiltin()` _registration_ registry
across the fragile scanner sites — beyond what the acceptance criteria require —
is exactly the speculative blast-radius the issue itself flagged as over the line.
