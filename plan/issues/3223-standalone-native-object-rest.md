---
id: 3223
title: "Standalone: native `__extern_rest_object` — object-rest `{a, ...rest}` leaks env host import (leaky→host-free de-leak, ~234–417 test262 files)"
status: done
assignee: ttraenkler/opus-substrate
sprint: 71
model: opus
created: 2026-07-13
updated: 2026-07-13
completed: 2026-07-13
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
# (#3102/#3131) Intended growth: the native standalone __extern_rest_object
# helper (ensureExternRestObject) lives in the object-runtime subsystem module
# beside its sibling native helpers (ensureObjectGroupBy), and the call-site
# standalone branch is in the destructuring-params module. Both are the correct
# homes for this feature code.
loc-budget-allow:
  - src/codegen/object-runtime.ts
  - src/codegen/destructuring-params.ts
---

# #3223 — native standalone `__extern_rest_object` (object-rest de-leak)

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

NET ≥ 0 by construction — host/gc unchanged (call site byte-identical, helper
only registered on the standalone/wasi branch); standalone gains a valid native
body where it previously leaked. The de-leak fully fixes object-rest for
OPEN-`$Object` (`any`-typed) sources and removes the `env` import leak for every
object-rest module (so a module whose *only* host-free blocker was this import
now instantiates). See the limitation below for why the immediate flip count is
smaller than a raw object-rest test count.

## Findings — closed-shape struct sources are blocked by a SEPARATE, broader gap

During validation (verified on this branch vs current main) the native helper is
CORRECT for open-`$Object` sources (11/11 CopyDataProperties cases green:
exclusion, empty rest, undefined-value-copied, numeric keys, non-enumerable-skip,
insertion order, string values, nested, arrow-param). But the DOMINANT test262
object-rest pattern destructures an object LITERAL directly
(`var {a,b,...rest} = {x:1,y:2,a:5,b:3}`), whose source compiles to a
CLOSED-SHAPE struct. In standalone, native enumeration of closed structs is
broken across the board — **not just rest**:

- `Object.keys({a:1,b:2,c:3}).length` → **0** standalone (host: 3)
- `{...closedStruct}` spread → **empty** standalone (host: 3)
- closed-struct object-rest → **empty** standalone (host: correct)

`__object_keys(externref)` only walks the open-`$Object` hash; it has **no
closed-struct arm**. The host import enumerates closed structs via
`__sget_<field>` reflection. So a closed-struct source yields an empty rest in
standalone — **no crash, NET ≥ 0** (these always failed host-free before, since
the import leaked). This de-leak is a correct, safe PREREQUISITE: once native
closed-struct enumeration lands, `__extern_rest_object` handles those sources
automatically (it delegates to `__object_keys`).

**Follow-up (higher leverage, tracked separately):** native closed-struct field
enumeration for standalone — fixes `Object.keys`/`values`/`entries`/spread/rest
uniformly for typed objects. Two candidate approaches: (a) make typed object
literals compile to an open `$Object` in standalone (enumeration Just Works via
the open-hash path); (b) a runtime struct-type→fieldnames table + a
closed-struct arm in `__object_keys`.

## Implementation notes (WHY)

- **Membership via `__extern_has`, NOT `__extern_get` + `ref.is_null`.** The
  first cut used `ref.is_null(__extern_get(excl, key))` to mean "not excluded".
  Under the #2106 S1 undefined-singleton regime an absent key reads back as the
  **non-null** undefined singleton, so `ref.is_null` was false for every
  non-excluded key → the helper silently DROPPED all of them (only visible once
  S1 was active in the module — which is why some literal cases appeared to work
  and dynamic cases did not). `__extern_has` returns i32 1/0 with no such
  ambiguity and is the correct membership predicate.
- **Exclusion OBJECT, not a comma-string.** The call site builds a plain
  `$Object` whose own keys are the excluded names and passes it as the second
  arg; membership is the proven open-object hash lookup. This keeps the helper
  100% in externref land (no trap-prone `$AnyString`/`$NativeString` casts, no
  runtime string tokenising, no delimiter false-match) — the same discipline as
  `ensureObjectGroupBy`.
- **Host/gc byte-identical.** The call site branches on `ctx.standalone ||
  ctx.wasi`; the host/gc path keeps the prior `env.__extern_rest_object` import +
  comma-string emit unchanged, and `ensureExternRestObject` is only reachable
  from the standalone branch, so no gc/host emitted byte changes.
