---
id: 3218
title: "Standalone: native `__extern_rest_object` — object-rest `{a, ...rest}` leaks env host import (leaky→host-free de-leak, ~234–417 test262 files)"
status: in-progress
assignee: ttraenkler/opus-substrate
sprint: current
model: opus
created: 2026-07-13
updated: 2026-07-13
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen, runtime
language_feature: destructuring, object-rest
goal: standalone-mode
related: [2075, 2620, 2515, 3053, 1552, 2714]
test262_bucket: standalone-object-rest-de-leak
---

# #3218 — native standalone `__extern_rest_object` (object-rest de-leak)

## Problem (verified on current main, target standalone)

Object-rest destructuring `const {a, ...rest} = o` compiles to a call to the
**host import** `env.__extern_rest_object(obj: externref, excludedKeysStr:
externref) -> externref` (registered unconditionally in
`src/codegen/destructuring-params.ts:509`). Under `--target standalone` there is
no JS runtime to satisfy the import, so the module **fails to instantiate
host-free** — a leaky pass (passes only with a host shim). Minimal repro
(instantiate with `{}`):

```ts
const o: any = { a: 1, b: 2, c: 3 };
const { a, ...rest } = o;   // needs env.__extern_rest_object
```

→ `WebAssembly.instantiate(): Import #0 "env" ... (needs __extern_rest_object)`.

This is the object-rest gap named in the value-rep substrate memory cluster
(`{a, ...rest}` under the `$Object` dynamic-read residuals). Object-rest appears
in **~234–417 test262 files** (`grep -rlE "\.\.\.[ident]\s*\}" test262/test`),
each currently a leaky pass — so this is a direct **leaky → host_free_pass**
conversion, the gap map's #1 lever class.

## Root cause

`destructuring-params.ts` (and `statements/destructuring.ts`) always route the
object-rest binding through `addImport(ctx, "env", "__extern_rest_object", …)`.
There is **no native (defined-func) implementation** for standalone — unlike
`__object_keys` / `__extern_get` / `__extern_set` / `__object_create`, which all
have host-free native bodies (probe-confirmed: `Object.keys`, dynamic reads,
`defineProperty` all instantiate with `{}`).

## Fix — native `__extern_rest_object` (ES §14.7.4 CopyDataProperties)

Register a **defined** `__extern_rest_object(obj, excludedKeysStr) -> externref`
in standalone (`ctx.standalone || ctx.wasi`), same ABI, so the call site in
`destructuring-params.ts` is **byte-identical** for host/gc — only the funcMap
entry changes from an `env` import to a defined func. Host/gc lane stays on the
existing import (byte-identical).

Native body composes existing host-free primitives:
1. `new = __object_create(...)` — fresh empty `$Object`.
2. `keys = __object_keys(obj)` — own-**enumerable** string keys (the enumerable-
   respecting variant; matches CopyDataProperties' own+enumerable requirement).
3. for each `key` in `keys`: if `key` is NOT in the excluded set →
   `__extern_set(new, key, __extern_get(obj, key))`.
4. return `new`.

**Excluded-key matching (the one non-trivial bit):** the ABI passes the excluded
keys comma-joined (`"a,b"`). The host impl splits on `,` (runtime.ts:10650), a
known simplification; the native impl matches the same behaviour via native
string token comparison. Default first slice keeps the comma-string ABI (call
site unchanged); if native comma-tokenised compare proves fiddly/fragile, the
fallback is to pass excluded keys as a native string array (changes the
standalone call site + helper ABI only, host untouched).

### Registration / funcidx-shift safety

Mint as a stable-handle defined func in an `ensureExternRestObject(ctx)` ensure
pass (mirroring the other object-runtime native helpers). It must be resolvable
when `destructuring-params.ts` looks up `ctx.funcMap.get("__extern_rest_object")`
mid-body: either pre-register in the standalone finalize/ensure pass so the
lookup hits before the `addImport` branch, or gate the `addImport` branch on
`!standalone` and call `ensureExternRestObject` on the standalone branch. No new
struct types registered at finalize (only `addFuncType`); reuse the struct types
of the composed primitives.

## Scope discipline

- `ctx.standalone`/`ctx.wasi`-gated; host/gc lane byte-identical (verify via
  `scripts/prove-emit-identity.mjs` — the non-standalone targets must be
  IDENTICAL; the standalone/wasi targets change ONLY by replacing the import with
  the defined body + swapping the call immediate).
- Validate host-free instantiation (`{}` imports) + CopyDataProperties semantics
  (own-enumerable only, excluded skipped, insertion order, string + numeric-key
  values, nested rest `{a, ...{b, ...r2}}`).
- Broad-impact → validate on the merge_group standalone floor
  (`check-standalone-highwater.mjs`); `hold` the SHA until green.

## Expected delta

Conservative: ~100–250 object-rest test262 files flip leaky → host-free (the
subset that currently passes-with-host and fails only on the missing import).
NET ≥ 0 by construction — host/gc unchanged; standalone gains a valid native
body where it previously leaked.
