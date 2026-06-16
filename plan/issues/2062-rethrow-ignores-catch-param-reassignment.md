---
id: 2062
title: "throw e after reassigning the catch parameter rethrows the ORIGINAL exception (rethrow optimization ignores writes)"
status: done
sprint: 61
created: 2026-06-10
updated: 2026-06-11
completed: 2026-06-11
priority: high
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: exceptions
goal: error-model
related: [1124, 1131]
origin: "2026-06-10 deep-audit sweep (control-flow agent): verified miscompile on main"
---

# #1942 — `catch (e) { e = wrap(e); throw e; }` rethrows the original

## Problem

The common error-normalization pattern — reassign the catch parameter, then
`throw e` — silently propagates the **originally-caught** exception instead of
the reassigned value.

## Repro (verified on main)

```ts
export function t1(): number {
  try {
    try { throw 1; }
    catch (e) { e = 2; throw e; }
  } catch (e2) { return (e2 as number) * 10; }
  return -1;
}
```

wasm: `10` (caught original `1`) — node: `20` (must catch reassigned `2`).

## Root cause

`src/codegen/statements/exceptions.ts:142-161` (`compileThrowStatement`): any
`throw <identifier>` where the identifier names an enclosing catch variable is
compiled to Wasm `rethrow`, unconditionally — purely by name match against
`catchRethrowStack`, ignoring whether the binding was reassigned between catch
entry and the throw. `rethrow` re-raises the originally-caught exception, not
the local's current value.

## Fix direction

Before applying the rethrow optimization, scan the catch block for any
assignment to the catch parameter (compound assignments, `++`, destructuring
writes, capture-by-closure-with-write included); if found, fall back to `throw`
of the local's current value. Alternatively clear the `catchRethrowStack` entry
the moment an assignment to that name is compiled.

## Acceptance criteria

- Repro matches Node (`20`)
- Plain `catch (e) { throw e; }` keeps the rethrow fast path (preserves
  exception identity for foreign/host exceptions)
- Closure-mutation variant covered (`catch (e) { const f = () => { e = 2; }; f(); throw e; }`)

## Dupe check

Grepped `rethrow`, `catchRethrowStack`, `reassign` — hits are IR-port plumbing
notes (#1124, #1131, #1169h) and unrelated async issues. Not covered.

## Resolution (2026-06-11)

Fixed in `src/codegen/statements/exceptions.ts`. Added `catchVarIsReassigned`,
which walks the catch block AST (including nested functions/arrows) for any
write to the catch parameter: plain/compound assignment, `++`/`--`, and
identifiers appearing in array/object destructuring assignment targets. The
`catchRethrowStack` entry is now pushed only when the parameter is NOT
reassigned, so `throw e` after a write compiles `throw` of the local's current
value (`compileExpression` + `throw $tag`) instead of Wasm `rethrow`. The pop is
gated on the same condition. Plain `catch (e) { throw e; }` keeps the `rethrow`
fast path (preserving exception identity for foreign/host exceptions).

### Test Results

`tests/issue-2062.test.ts` (6 cases, all PASS):

| case | result |
|------|--------|
| `e = 2; throw e` | 20 ✓ |
| `e = e + 7; throw e` (compound) | 10 ✓ |
| closure mutation `()=>{e=2}; throw e` | 20 ✓ |
| reassign then rethrow from nested `if` | 99 ✓ |
| plain `throw e` (unregressed) | 42 ✓ |
| plain rethrow from nested `if` (unregressed) | 8 ✓ |

`tsc --noEmit` clean; `tests/try-catch.test.ts` green. Pre-existing failures in
`tests/finally-block.test.ts` (minimal import object missing `string_constants`)
are unrelated — they fail identically on baseline with this change reverted.
