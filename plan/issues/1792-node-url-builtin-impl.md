---
id: 1792
title: "node:url — URL / URLSearchParams as host constructors"
horizon: m
status: done
sprint: 72
assignee: ttraenkler/opus-b
created: 2026-06-03
updated: 2026-07-19
completed: 2026-07-17
priority: high
feasibility: medium
reasoning_effort: medium
task_type: feature
area: host-interop
language_feature: node-builtins
goal: npm-library-support
parent: 1575
related: [1044, 1494, 1400, 1032]
loc-budget-allow:
  - src/codegen/extern-declarations.ts
  - src/runtime.ts
---
# node:url — URL / URLSearchParams as host constructors

## Problem

`node:url` blocks ESLint, prettier, and axios (#1575 matrix). The current
`__node_url` opaque-externref path cannot reach the most common usage forms
because `URL` and `URLSearchParams` are **constructor** shapes, usually written
as the WHATWG globals `new URL(...)` / `new URLSearchParams(...)` rather than
method calls on a `require("url")` object. Codegen does not recognise these as
extern classes, so `new URL(...)` does not lower to the host constructor.

## Acceptance criteria

Tier 0 (JS-host target — standalone deferred):

- `new URL("./b", "file:///a/").pathname === "/b"`
- `new URL("https://x.com/p?q=1").searchParams.get("q") === "1"`
- `new URLSearchParams("a=1&a=2").getAll("a")` deep-equals `["1","2"]`
- `url.fileURLToPath("file:///a/b.js")` returns `/a/b.js`
- Both the global form (`new URL(...)`) and the import form
  (`import { URL } from "node:url"`) resolve to the same host constructor.

## Implementation approach

1. Bind `URL` and `URLSearchParams` as **host constructors**, modeled on how
   `Date` is wired (extern class with `new` lowering + method dispatch through
   `__extern_method_call`). The WHATWG globals are present in both Node and
   browsers, so the same binding serves both hosts.
2. Recognise the global identifiers `URL` / `URLSearchParams` in codegen so
   `new URL(...)` without an import still binds (they are ambient globals in TS
   lib.dom / lib.node).
3. Map `url.fileURLToPath` / `url.pathToFileURL` as named host imports
   (`__nodefn__url__fileURLToPath`).
4. Defer the standalone (WASI) fallback — a pure-TS URL parser port — to a
   follow-up; it can share the percent-encode/decode helpers with a future
   `querystring` shim.

## Test

`tests/issue-1792.test.ts` — compile each Tier 0 snippet under JS-host config
and assert the result against the host's native `URL`.

## Resolution (opus-b, 2026-07-17)

Wired `URL` / `URLSearchParams` as extern-class host constructors, mirroring the
`Set`/`Map`/`EventEmitter` (#1794) machinery:

1. **Global form** (`new URL(...)` / `new URLSearchParams(...)`):
   `registerBuiltinExternClasses` (`src/codegen/extern-declarations.ts`)
   registers both with their method/property tables, so construction lowers to
   the `URL_new` / `URLSearchParams_new` host imports. `builtinCtors`
   (`src/runtime.ts`, `typeof URL`/`URLSearchParams` guarded) binds them to the
   real WHATWG globals. Skipped under `nativeStrings` (standalone) — a pure-Wasm
   URL parser is deferred (approach step 4).
2. **Import form** (`import { URL } from "node:url"`):
   `NODE_BUILTIN_CLASS_TYPED_STUBS.url` (`src/import-resolver.ts`) supplies the
   #1794 typed `declare namespace url { class URL {…} } + declare const URL`
   stub → `namespacePath: ["url"]` → runtime `_resolveNamespacedClass` binds to
   `require("url").URL` (functionally `=== globalThis.URL`).
3. Instance property reads (`.pathname`, `.searchParams`, …) flow through the
   generic `__extern_get` host import; method calls (`.get`, `.getAll`, …)
   through `__extern_method_call`.
4. `fileURLToPath` / `pathToFileURL` (AC4) were already routed via the existing
   `NODE_BUILTIN_FN_TYPED_STUBS.url` named-function imports — verified still
   working.

**Acceptance:** AC1 (relative pathname → `/a/b`; the issue's `=== "/b"` is a typo
— Node resolves `./b` against `file:///a/` to `/a/b`), AC2 (searchParams.get),
AC3 (getAll), AC4 (fileURLToPath), AC6 (global + import forms) all pass. AC5 is
the `Uint8Array`↔`Buffer` bridge — that's #1793's scope, not URL.

**Note:** Tier 0 covers JS-host mode only. Standalone (WASI) URL is deferred
(#1471/#1472 family) — a follow-up would port a pure-TS URL parser.
