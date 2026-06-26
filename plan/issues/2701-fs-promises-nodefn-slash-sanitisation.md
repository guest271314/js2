---
id: 2701
title: "node:fs/promises destructured-import host-glue — sanitise the `/` in the __nodefn__ identifier"
status: done
completed: 2026-06-26
assignee: ttraenkler/agent-ae565d4893a5783d7
created: 2026-06-26
updated: 2026-06-26
priority: high
feasibility: easy
reasoning_effort: medium
task_type: feature
area: host-interop
language_feature: node-builtins
goal: npm-library-support
related: [2699, 1791, 1491, 1492, 2693]
depends_on: [2699]
---
# #2701 — node:fs/promises destructured-import host-glue (slash sanitisation)

## Problem

Follow-up to #2699. ESLint's CLI/config layers import `node:fs/promises`
destructured: `const { mkdir, stat, writeFile } = require("node:fs/promises")`
(cli.js, config-loader.js, eslint.js). The #2699 `__nodefn__<module>__<fn>`
host-glue route could not be applied because the `/` in `fs/promises` is not a
valid TypeScript identifier character — the generated declaration
`__nodefn__fs/promises__readFile` was a syntax error (`'(' expected` at compile).

## Fix

Encode `/` → `$` (a valid identifier char that never appears in a Node
module/fn name) in the `__nodefn__` host-import name, and decode it back in the
import-manifest classifier so the runtime resolves the real
`require("fs/promises")`:

- `src/import-resolver.ts`:
  - add `node:fs/promises` to `NODE_BUILTIN_MODULES`
  - add `NODE_BUILTIN_FN_TYPED_STUBS["fs/promises"]` = `{ readFile, writeFile,
    unlink, stat, mkdir }`
  - `nodeBuiltinFnTypedStub`: `hostName = \`__nodefn__${moduleName.replace(/\//g,"$")}__${name}\``
- `src/compiler/import-manifest.ts`: decode the module token `$` → `/` when
  classifying `__nodefn__` → `node_builtin_fn`.

The runtime `node_builtin_fn` resolver already does `require(moduleName)[fn]`
and passes the returned Promise through unchanged (verified).

## Verified (host, real `node:fs/promises` via `buildImports(..., deps, stringPool)`)

```
const { stat, readFile } = require("node:fs/promises");
await stat("/etc/hostname").isFile()      → 1
await readFile("/etc/hostname","utf8")    → non-empty string
```
Imports emitted: `__nodefn__fs$promises__stat`, `__nodefn__fs$promises__readFile`.
`tests/issue-2701.test.ts` covers classification (decoded moduleName ===
`fs/promises`) + the Promise round-trip.

## Notes

- Stacked on #2699 (shares `NODE_BUILTIN_FN_TYPED_STUBS` / `NODE_BUILTIN_MODULES`).
- The runner must pass `stringPool` as the 3rd arg to `buildImports` for
  string-literal args (e.g. `readFile("/path")`) to marshal at the host boundary
  (the #2699 finding).
- Deferred (next-sprint carve): `node:worker_threads` (value/class-shaped),
  `url` `URL` class, `util.styleText`/`stripVTControlCharacters`. The namespace
  form of fs/promises (`const fsp = require("node:fs/promises"); fsp.writeFile`)
  would hit the same slash in `__node_fs/promises` — a separate module-route
  sanitisation; eslint's destructured form (covered here) is the common one.
