---
id: 3063
title: "codegen: implement legacy global escape() / unescape() (§B.2.1/.2) — JS-host lowering"
status: done
completed: 2026-07-06
sprint: 71
priority: medium
horizon: s
feasibility: easy
reasoning_effort: low
task_type: feature
area: codegen
language_feature: annexb, string-builtins
goal: spec-completeness
related: [1436]
test262_bucket: annexb-escape-unescape
test262_count: 33
assignee: ttraenkler/dev-cycleC
origin: "2026-07-06 harvest (dev-cycleC). origin/main; default (JS-host) lane. AnnexB self-contained builtin."
---

# #3063 — legacy `escape` / `unescape` return `undefined` (unimplemented)

## Problem

The legacy global functions `escape(string)` (§B.2.1) and `unescape(string)`
(§B.2.2) resolve as identifiers (they exist in the TS lib) but have **no
codegen lowering**, so every call silently returns `undefined`/`null`:

```ts
export function test(): string {
  return escape("a b");   // spec: "a%20b"; was null
}
```

~33 `annexB/built-ins/{escape,unescape}/*` test262 files fail on this
(`assertion_fail` — comparing `null` to the expected escaped string), plus
`escape`/`unescape` value assertions scattered elsewhere.

## Fix

Mirror the existing `encodeURI` / `encodeURIComponent` machinery (which already
does host-import + call-site ToString-coercion, and has a pure-Wasm standalone
lowering in `uri-encoding-native.ts`):

1. **Collection** (`declarations.ts`, `collectParseImports`): recognise the
   direct-call callees `escape` / `unescape` → `state.escapeNeeded`.
2. **Emit** (`declarations.ts`): JS-host mode only — register an
   `(externref) -> externref` `env.escape` / `env.unescape` host import (skipped
   if a user already declared the name). The generic call-site routing
   (`calls.ts` `funcMap.get(name)`) dispatches it and ToString-coerces the arg,
   exactly like the URI globals — no `calls.ts` change needed.
3. **Runtime host impl** (`runtime.ts`): `(s) => escape(s)` / `(s) => unescape(s)`
   — direct pass-through so ToString throws TypeError on a Symbol arg per spec
   step 1 (matches the URI globals' `#1436` discipline).

Gated `!ctx.standalone && !ctx.wasi`, so the host-free lanes emit **no**
unsatisfiable `env::escape` import (they keep the pre-existing behaviour). A
pure-Wasm standalone `escape`/`unescape` (mirroring `uri-encoding-native.ts`) is
a documented follow-up.

## Acceptance criteria

1. `escape("a b")` → `"a%20b"`; `escape("Ā")` → `"%u0100"` (host mode).
2. `unescape("%41")` → `"A"`; `unescape("%u0041")` → `"A"`;
   `unescape("%zz")` → `"%zz"` (non-hex left literal).
3. Round-trip `unescape(escape(s)) === s` for representative strings.
4. No regression for `encodeURI`/`encodeURIComponent` or a user-declared
   `escape`/`unescape`.
5. Regression test: `tests/issue-3063-escape-unescape-host.test.ts`.

Flips `annexB/built-ins/escape/*` and `annexB/built-ins/unescape/*` value tests
(`two.js`, `four.js`, `escape-below.js`, `argument_types.js`, …).
