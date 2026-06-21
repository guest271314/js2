---
id: 2186
title: "standalone: post-delete struct read returns stale value — steer delete-touched object literals to $Object"
status: done
sprint: 64
created: 2026-06-17
updated: 2026-06-21
completed: 2026-06-21
assignee: sd-5
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: object-literals
goal: property-model
related: [2179, 2130, 2542, 2572]
origin: "2026-06-17 — A7 standalone half split out of #2179 (A6 JS-host landed)"
resolution: "2026-06-21 reproduction (sd-5): the post-delete READ is already fixed on origin/main. `any`/dynamic and index-signature object literals — and even optional-field interface literals — lower to the tombstone-aware $Object representation (the #2542 dynamic-property work), whose FLAG_TOMBSTONE makes `delete o.a; o.a===undefined` → true with NO host import. The A7 struct→$Object representation-steering this issue proposed turned out unnecessary (the literals already go to $Object). All acceptance criteria pass standalone EXCEPT `for (const k in o)`, which fails only because statement-form for-in leaks env.__for_in_* host imports — a general for-in-over-$Object gap, not delete-specific — carved to #2572. Closing #2186 done (read core fixed); #2572 owns the for-in leak."
---

# #2186 — standalone post-delete read: $Object representation steering

## Problem

`#2179` fixed the post-delete struct READ for `any` receivers in **JS-host**
mode by routing reads through the tombstone-aware `__extern_get` host helper.
That helper is a JS host import and is unavailable under `--target standalone` /
WASI, so the fix is gated `!ctx.standalone` and standalone still returns the
stale value:

```ts
const o: any = { a: 1, b: 2 };
delete o.a;
o.a               // standalone wasm: 1   node: undefined
o.a === undefined // standalone wasm: false
```

## Root cause

In standalone mode an object literal with a resolvable shape is lowered to a
WasmGC struct. `delete o.a` sets a runtime tombstone but cannot clear the struct
field, and the read fast-path (`struct.get`) reads the live field. There is no
host `__extern_get` to reroute through, and a wasm-side `(obj,key)` tombstone
registry is rejected (architect addendum A7): WasmGC has no weak refs, so it
would strongly retain every deleted-from object.

## Fix direction (architect addendum A7, from #2130)

**Representation steering.** Reuse the `moduleUsesDelete` pre-scan
(`ctx.moduleUsesDelete`, `src/codegen/index.ts`, landed in #2179) to find the
object-literal struct types that are targeted by `delete`, and in standalone
mode lower **those** literals to the dynamic `$Object` representation
(`src/codegen/object-runtime.ts`) instead of a WasmGC struct. `$Object` already
has spec-correct `FLAG_TOMBSTONE` tombstones, proto-walk `in`, and #1837
insertion-order enumeration. Zero overhead for untouched objects; full fidelity
for delete-touched ones.

Likely scope: a per-literal "is a delete target?" analysis (which object
literals flow into a `delete <member>` whose base resolves to that literal),
then steer those literals' lowering to `$Object` in standalone; the read/`in`/
keys paths then go through the existing `$Object` ops.

## Acceptance criteria

- `const o:any={a:1,b:2}; delete o.a; o.a` → `undefined` under `--target standalone`.
- `o.a === undefined` after delete → `true` (standalone).
- `delete o.a; o.a = 5; o.a` → `5`; `"a" in o` → `true` (standalone re-add).
- `Object.keys(o)` / `for (const k in o)` omit the deleted key (standalone).
- Non-delete-touched object literals keep their WasmGC struct lowering (no
  perf/representation change); JS-host behavior (#2179) unregressed.

## Reproduction (sd-5, 2026-06-21, origin/main @ d619ce2a9)

Compiled with `target: "standalone"`, instantiated with `{}`, validated. The
post-delete read is **already fixed** — these all return the spec-correct value:

| Case | Result | Expected |
| --- | --- | --- |
| `const o:any={a:1,b:2}; delete o.a; o.a===undefined` | `true` | true ✔ |
| `delete o.a; (o.a as number)` | undefined/falsy (not stale `1`) | undefined ✔ |
| `delete o.a; o.a=5; o.a===5` | `true` | true ✔ |
| `delete o.a; "a" in o` | `false` | false ✔ |
| `delete o.a; o.b===2` | `true` | true ✔ |
| `const k="a"; delete o[k]; o.a===undefined` (computed) | `true` | true ✔ |
| `Object.keys(o)` after delete → `["b"]` | len 1, `"b"` | ✔ |
| `interface O{a?:number;b:number}` optional-field delete | `true` | true ✔ |
| `{[k:string]:number}` index-sig delete | `true` | true ✔ |

**Why the A7 steering wasn't needed:** the issue assumed delete-touched literals
stay WasmGC structs (stale `struct.get`). In fact `any` / index-signature /
optional-field literals already lower to the dynamic `$Object` representation
(the #2542 dynamic-property landing), and `$Object` carries `FLAG_TOMBSTONE`, so
`delete` + read is spec-correct with no host import and no struct→$Object
steering pass. `ctx.moduleUsesDelete` is consumed only at
`property-access.ts:1862`, which is gated OFF for standalone — confirming no
standalone delete-aware read path runs, yet the result is correct because the
representation is already `$Object`.

**The one failing acceptance line → #2572:** `for (const k in o)` fails in
standalone — but because **statement-form for-in leaks `env.__for_in_*` host
imports** (validates, can't instantiate), independent of `delete`
(`for-in` over a plain `{a,b}` with no delete leaks identically; `Object.keys`
does not). Root cause: `declarations.ts:1438` registers the for-in host imports
with no standalone guard. Carved to **#2572** with the full fix direction.

## Notes

Split from #2179 (A6 JS-host read-path fix is `done`). See #2179's
`## Resolution` and #2130's architect addendum A7. Read core fixed by #2542;
for-in leak tracked by #2572.
