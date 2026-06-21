---
id: 2584
title: "standalone: dot-assign vs bracket-read dual-storage — widened struct invisible to $Object hash (in/keys/bracket)"
status: done
sprint: 65
assignee: ttraenkler/sdev-vrep
created: 2026-06-21
updated: 2026-06-21
completed: 2026-06-21
priority: high
feasibility: hard
reasoning_effort: high
model: opus
task_type: bugfix
area: codegen
language_feature: object-literals, property model, any-typed receivers
goal: property-model
related: [2186, 2372, 2542, 2179]
origin: "2026-06-21 — surfaced during s64 value-rep keystone work; widened-struct ↔ $Object reconciliation gap."
---

## Problem

Standalone, an `any`-typed object written via **dot-access** but read via
**bracket / `in` / Object.keys / getOwnPropertyDescriptor** returned the wrong
value, because the two sides target different representations of the same
variable:

```ts
const o: any = {};
o.a = 7;
o["a"]; // → 0   (expected 7)
"a" in o; // → false (expected true)
```

Repro confirmed failing on main HEAD (04ef72a7c), `--target standalone`.

### The exact asymmetry (measured, before fix)

| program            | result   | path                              |
| ------------------ | -------- | --------------------------------- |
| `o.a=7; o.a`       | 7 ✅     | struct.set → struct.get           |
| `o["a"]=7; o["a"]` | 7 ✅     | (bracket-write poisons → $Object) |
| `o["a"]=7; o.a`    | 7 ✅     | $Object both sides                |
| `o.a=7; o["a"]`    | 0 ❌     | struct.set → \_\_extern_get       |
| `o.a=7; "a" in o`  | false ❌ | struct.set → $Object `in`         |

The break is NOT "bracket reads are broken." It is: a var written **only via
dot-access** gets **widened to a closed WasmGC struct**, but the
`$Object`-hash-runtime consumers (bracket-read, `in`, `Object.keys`,
`Object.getOwnPropertyDescriptor`, `Object.entries`/`values`, `Object.assign`,
`for-in`) can't see a widened struct.

### Root cause (WAT-confirmed)

`const o: any = {}` with later `o.a = 7` triggers the empty-object widening
pre-pass (`collectEmptyObjectWidening` → `collectPropsFromStatements`,
`src/codegen/declarations.ts`): it scans the dot-assign, registers an `__anon_N`
struct, records `widenedVarStructMap.set("o", structName)`. So the initializer
`{}` lowers to `struct.new <__anon>`, `o.a = 7` to `struct.set`, but `o["a"]`
lowers via the externref arm → `__extern_get(o, "a")` whose `ref.test $Object`
does NOT match the `__anon` struct → null → `__unbox_number(null)` → 0. `in` /
`Object.keys` / GOPD all consult the same `$Object` runtime → all miss.

## Fix — poison widening when a $Object-only consumer is present

The codebase already has the exact mechanism: `dynamicDescriptorWidenVars`
(#2372) suppresses widening for a var whose `Object.defineProperty` uses a
dynamic descriptor, so the var stays a pure `$Object` and BOTH write and read
route through the native runtime. This change extends the same poison pattern to
the dot-vs-bracket gap.

**Decision: poison (steer to `$Object`), do NOT teach bracket-read to resolve
the struct field** — `in`/keys/entries/GOPD/assign/for-in all require the
`$Object` hash and have no struct equivalent for enumeration, so one
representation fixes the whole family; teaching only bracket-read would leave the
rest broken.

### Changes

- **`src/codegen/context/types.ts`** — new field
  `objectHashConsumerVars: Set<string>` (mirrors `dynamicDescriptorWidenVars`,
  with doc-comment).
- **`src/codegen/context/create-context.ts`** — initialize it to `new Set()`.
- **`src/codegen/declarations.ts`**:
  - New recursive scanner `markObjectHashConsumers(node, varName, poisonSet)`
    that poisons `varName` when it appears as the subject of any `$Object`-only
    op: `varName[<expr>]` (bracket read/write), `<key> in varName`,
    `Object.{keys,values,entries,getOwnPropertyDescriptor,getOwnPropertyDescriptors,getOwnPropertyNames,assign}(… varName …)`,
    and `for (… in varName)`.
  - In `collectEmptyObjectWidening`, after `collectPropsFromStatements`, run the
    scanner over the enclosing statement list (standalone-gated).
  - At the widening decision point, alongside the existing
    `dynamicDescriptorWidenVars` skip, add
    `if (ctx.objectHashConsumerVars.has(varName)) continue;`.

Once `o` is not widened, the empty-`{}` any-context arm builds it via
`__new_plain_object` → a real `$Object`; `o.a = 7` no longer resolves a struct
name and routes through `__extern_set`; every access form reads the same hash.

Standalone-gated only — host keeps the struct fast path via the live-mirror
Proxy; wasi unaffected. Two poison sets are additive (a var already in
`dynamicDescriptorWidenVars` stays poisoned regardless).

## Test Results

`tests/issue-2584-dual-storage.test.ts` — 12 tests, all green:
dot→bracket / dot→`in` / dot→keys / dot→GOPD / dot→values / dot→for-in /
dot→Object.assign-source / mixed dot+bracket / numeric-bracket-poison; plus
regression guards (dot-only var keeps struct fast path → 24; typed struct var
unaffected → 7; bracket-only var → 7).

Repro matrix on `--target standalone`, before → after:
`o.a=7; o["a"]` 0→7 · `"a" in o` false→true · `Object.keys().length` 0→2 ·
`Object.values()` sum 0→15 · `Object.getOwnPropertyDescriptor().value` 0→7 ·
`Object.entries().length` 0→2 · `for-in` count 0→2 · `Object.assign` copy 0→7.

WAT-verified: a dot-only var still lowers to `struct.new`/`struct.set` (fast path
preserved); a poisoned var no longer emits `struct.set` (stays `$Object`). Host
mode (`o.a=7; o["a"]`) returns 7 unchanged.

Related suites re-run: `issue-2372` (dynamic-descriptor poison) +
`object-literals` green (32 assertions). `tsc --noEmit` clean.
(`empty-object-widening.test.ts` fails to LOAD on a pre-existing missing
`./helpers.js` import — present on origin/main, untouched here, not a
regression.)

## Deferred

- Aliased receivers (`const p = o; p[k]`) — name-based scanner limitation,
  shared with the existing widening pre-pass.
- A future unification could make a single representation serve both fast struct
  access and dynamic keys (a struct with an attached overflow `$Object`), but
  that is a larger property-model redesign; out of scope here.
