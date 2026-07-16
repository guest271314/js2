---
id: 3325
title: "declare function host-dep call is silently dropped (env import bound but never called)"
status: ready
sprint: Backlog
goal: npm-library-support
feasibility: medium
depends_on: []
priority: medium
es_edition: ES2015
language_feature: host-interop
task_type: bug
horizon: s
created: 2026-07-16
updated: 2026-07-16
---

# #3325 — `declare function` host-dep call silently dropped

## Problem

Found while validating #1793 (Buffer host class). A user-level ambient host
function is imported but the call site never invokes it:

```ts
declare function inspect(u: any): void;
export function test(): number {
  inspect(7);   // <- never reaches the JS dep
  return 5;
}
```

Compiled with default JS-host config and instantiated via
`buildImports(r.imports, { inspect: (v) => console.log("DEP", v) }, r.stringPool)`
(+ `setExports`): `test()` returns 5 and the dep NEVER runs — no throw, no
log. The module manifest DOES contain `env.inspect` and the WAT has
`(import "env" "inspect" (func $inspect_import ...))` plus a
`string_constants.inspect` global, so the import is declared and bound; the
CALL is what goes missing (dropped, or routed through a dynamic-dispatch path
that resolves something else, e.g. the string-constant global).

## Impact

Host-dep injection via ambient function declarations is a documented
test-injection route (`compileAndRunRuntimeDeps`, cluster I) and the natural
FFI for embedders. A silently dropped call is worse than a compile error.
Note `tests/issue-1042.test.ts` already records that `declare function`
returning `number` marshals NaN — this is the void/any-arg variant of the
same neglected path.

## Repro

`.tmp/probe-dep.mts` shape above; also `declare function inspect(u: any): void`
with a `Uint8Array` arg (the #1793 zero-copy probe).

## Acceptance criteria

- `declare function f(x: any): void` + `deps: { f }` → the dep runs with the
  marshaled arg.
- A missing dep at instantiation produces a clear link/runtime error, not a
  silent no-op.
