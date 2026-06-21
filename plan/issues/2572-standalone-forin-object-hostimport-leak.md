---
id: 2572
title: "standalone: statement-form for-in over a dynamic object leaks env.__for_in_* host imports (no native $ObjVec walk)"
status: ready
sprint: Backlog
created: 2026-06-21
updated: 2026-06-21
priority: high
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen, runtime
language_feature: for-in, objects
goal: standalone-mode
related: [2186, 1472, 1837, 2066, 2542]
test262_bucket: standalone-forin-hostimport-leak
es_edition: es5
origin: "Carved from #2186 (sd-5 reproduction, 2026-06-21). #2186's post-delete READ is already fixed (any/dynamic literals lower to tombstone-aware $Object); the only failing #2186 acceptance line is `for (const k in o)`, which fails because statement-form for-in leaks env.__for_in_* host imports in standalone — a general for-in-over-$Object gap, NOT delete-specific."
---

# #2572 — standalone for-in over a dynamic object: host-import leak

## Problem

`for (const k in o)` over a dynamic / `any`-typed (`$Object`) receiver compiles
to a module that **validates** but **cannot instantiate** under
`--target standalone` / WASI:

```ts
const o: any = { a: 1, b: 2 };
let s = "";
for (const k in o) s += k;   // standalone: imports env.__for_in_keys/_len/_get/_has
```

```
WebAssembly.instantiate(): Import #0 "env": module is not an object or function
```

Imports leaked: `env.__for_in_keys`, `env.__for_in_len`, `env.__for_in_get`,
`env.__for_in_has`. The leak is **independent of `delete`** — it fires for any
dynamic-object for-in. `Object.keys(o)` over the same receiver is already
host-free (native `$ObjVec` walk), so the enumeration primitive exists; only
the statement-form for-in is not routed through it.

## Root cause

1. `src/codegen/declarations.ts:1438` registers the for-in host imports
   **unconditionally**:
   ```ts
   if (state.forInFound) { addForInImports(ctx); }
   ```
   — with **no `!ctx.standalone && !ctx.wasi` guard**, unlike the array-iterator
   registration 9 lines above (`:1429`). So in a no-JS-host target the
   `__for_in_*` imports get registered, `ctx.funcMap.has("__for_in_keys")` is
   true, and `compileForInStatement` takes the host path.
2. `compileForInStatement` (`src/codegen/statements/loops.ts:4707-4742`) only
   falls to its standalone branch when `keysIdx === undefined`. Because of (1)
   that never happens in standalone, so the host calls are always emitted.
3. The existing standalone fallback (`loops.ts:4712-4742`) is also **wrong for a
   dynamic `$Object`**: it statically unrolls the **static type's**
   `getProperties()`, which ignores runtime-added/deleted keys and tombstones.
   A `$Object` whose keys change at runtime (delete/add) must enumerate its
   **runtime** key vector, not the static shape.

## Fix direction

- Gate `addForInImports` at `declarations.ts:1438` behind
  `!ctx.standalone && !ctx.wasi` (mirror `:1429`).
- In `compileForInStatement`, when the receiver lowers to a `$Object` (dynamic
  representation) under a no-JS-host target, emit a runtime walk over the same
  `$ObjVec` key vector that standalone `Object.keys/values/entries` already use
  (`src/codegen/object-runtime.ts`), honouring `FLAG_TOMBSTONE` (skip deleted)
  and `FLAG_ENUMERABLE`, in OrdinaryOwnPropertyKeys insertion order (#1837), and
  applying the per-visit liveness check (#2066) so a key deleted mid-loop is
  skipped.
- Keep the static-unroll path only for receivers whose shape is a **closed
  WasmGC struct with no `delete` reachability** (where the static key set is
  exact) — or drop it in favour of the runtime walk for uniformity.

## Acceptance criteria

- `const o:any={a:1,b:2}; for (const k in o) …` compiles to a standalone module
  with **zero `env.__for_in_*` imports**, instantiates, and enumerates `a`,`b`.
- After `delete o.a`, the standalone for-in omits `a` (already true for
  `Object.keys`; bring statement-for-in to parity).
- Runtime-added keys (`o.c = 3`) appear; insertion order preserved (#1837).
- A key deleted during the loop body is skipped (#2066 parity).
- JS-host for-in behaviour unchanged (no regression); no new host imports.
- Closed-struct (non-dynamic) for-in keeps working.

## Notes

Carved from #2186, whose post-delete READ path is already fixed and is being
closed `done` separately. This is the residual that blocked #2186's
`for (const k in o)` acceptance line. Distinct from #1472 (general standalone
object/property host-import elimination, `done`) which did not cover the
`__for_in_*` family.
