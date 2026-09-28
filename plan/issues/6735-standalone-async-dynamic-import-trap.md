---
id: 6735
title: "standalone: `import()` inside an async function body is a hard compile error — jest-util/jest-config, eslint, stylelint, jsdom stop at it; lower it as a rejection"
status: ready
sprint: Backlog
created: 2026-09-28
updated: 2026-09-28
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: standalone
requested_by: ttraenkler/sendev-standalone
related: [3494, 3509, 6725]
---

# #6735 — async-body `import()` blocks whole standalone graphs

## Problem

`detectStandaloneDynamicImports` (`src/compiler.ts`, #3494/#3509) reports

    Standalone dynamic import is unsupported until compileMulti provides internal module records and namespace objects

for every `import()` that is not inside a plain (non-async, non-generator)
function body. #3509 made the plain-function case a run-time TypeError trap;
async bodies stayed fatal because "a direct synchronous throw would not
preserve their rejection semantics".

That keeps whole package graphs from compiling even though the `import()` only
runs on a path the program may never take. After #6725 linked jest's lazy
`require` edges, jest's standalone-dynamic lane stops here:

- `jest-util/build/index.js:1045` — `async function importModule(...) { … await import(moduleUrl.href) … }` (inside `try`)
- `jest-config/build/index.js:2426`, `2437` — `registerTsLoader`: `await import('ts-node')` / `await import('esbuild-register/dist/node')`

eslint, stylelint and jsdom report the same diagnostic.

## Root dependency

Measured 2026-09-28 (standalone, `compileMulti`, allowJs):

```js
async function f(x) { const m = await g(x); return m; }
function g(x) { throw new TypeError("sync"); }
export function run() { const p = f(1); /* … */ return 1; }
```

`run()` throws `TypeError: sync` synchronously; per spec `f(1)` returns a
rejected promise. So a standalone async function does not convert a throw in
its body into a rejection, and the #3509 trap cannot simply be extended.

## Acceptance criteria

- A throw inside a standalone async function body (before or after its first
  `await`) rejects the returned promise instead of escaping the call.
- `import(x)` inside an async function (declaration, expression, arrow, method)
  compiles under `--target standalone` and rejects with a TypeError naming the
  missing module loader (#3494) when reached.
- jest's standalone-dynamic lane moves past this diagnostic (next blocker
  recorded here); eslint/stylelint/jsdom re-measured.
