---
id: 2582
title: "compiled-acorn module-init: null receiver into wordsRegexp from a numeric-keyed module-object read"
status: done
assignee: sd-acorn
completed: 2026-06-21
created: 2026-06-21
updated: 2026-06-21
priority: high
feasibility: hard
reasoning_effort: high
task_type: fix
area: codegen, runtime
language_feature: computed-member-access
goal: self-hosting-dogfood
sprint: Backlog
model: opus
depends_on: [1712]
related: [1712, 2542]
---

# #2582 — compiled-acorn `buildUnicodeData` throws: `Cannot read properties of null (reading 'replace')`

## Context

This is the **third** independent blocker on the compiled-acorn dogfood
(`self-hosting-dogfood` / #1712), surfaced once the tokenizer **identity loop**
was fixed (#1712 slice 2026-06-21, PR #1874). With the identity loop gone,
compiled acorn now executes far past the loop — into module-init
`buildUnicodeData` — and throws there during `WebAssembly.instantiate`'s start
function:

```
TypeError: Cannot read properties of null (reading 'replace')
    at __extern_method_call (src/runtime.ts) — method="replace", receiver=null
    at wordsRegexp (wasm)            — words.replace(/ /g, "|")
    at buildUnicodeData (wasm)
    at __module_init (wasm)
```

## The defect

acorn's `buildUnicodeData` (acorn dist ~3974) builds Unicode property
alternation regexes:

```js
function wordsRegexp(words) {
  return regexpCache[words] || (regexpCache[words] =
    new RegExp("^(?:" + words.replace(/ /g, "|") + ")$"));
}
function buildUnicodeData(ecmaVersion) {
  var d = data[ecmaVersion] = {
    binary:          wordsRegexp(unicodeBinaryProperties[ecmaVersion] + " " + unicodeGeneralCategoryValues),
    binaryOfStrings: wordsRegexp(unicodeBinaryPropertiesOfStrings[ecmaVersion]),
    nonBinary: {
      General_Category: wordsRegexp(unicodeGeneralCategoryValues),
      Script:           wordsRegexp(unicodeScriptValues[ecmaVersion]),
    },
  };
  …
}
```

`unicodeBinaryPropertiesOfStrings` is a module-level object literal keyed by
numeric ecmaVersion: `{ 9: "", 10: "", 11: "", 12: "", 13: "",
14: ecma14BinaryPropertiesOfStrings }`. For `ecmaVersion === 9`, real JS reads
`""` (empty string) and `wordsRegexp("")` returns `/^(?:)$/`. In the **compiled**
module the read `unicodeBinaryPropertiesOfStrings[ecmaVersion]` yields **null**,
so `wordsRegexp(null)` → `null.replace(...)` throws via the host bridge
(`__extern_method_call(null, "replace", …)`).

So the root cause is a **computed numeric-key member read on a module-level
object literal returning `null` instead of the stored value** — specifically
the `""` (empty-string) entries (the `14:` entry is a real identifier so it may
read fine; the `9..13: ""` entries are the ones that come back null). The
distinguishing factors vs. the simple case (which works) are some combination
of:
- the object is a **module-level global** (not a local),
- read by a **dynamic numeric key** (`obj[ecmaVersion]` where `ecmaVersion` is a
  loop var, not a literal),
- inside a `data[ecmaVersion] = { …: wordsRegexp(obj[k]), … }`
  **assignment-as-expression with a nested object literal**,
- the stored value is the **empty string `""`** (possibly mis-modeled as
  null/undefined at the boundary).

## Reproduction status (from the #1712 slice)

Minimal probes that **DID NOT** reproduce (all returned correct values, so the
trigger is more specific than each alone):
- `obj[numKey]` on a numeric-keyed object via a local key → correct.
- `obj[9]` returning `""` (empty-string value) → `=== ""` was `1`.
- a `for` loop reading `obj[ec]` and concatenating → correct.
- `wordsRegexp("")` and `wordsRegexp(props[9])` and the nested-object-literal
  `{ binaryOfStrings: wordsRegexp(props[k]), other: … }` shape → all correct.

So the next investigator must reproduce with the FULL acorn-ish shape: a
**module-global** object literal with numeric `""` entries, read by a dynamic
key inside a `data[ver] = { … }` assignment whose values are nested
`wordsRegexp(obj[ver])` calls, possibly with a sibling entry that references
another module global (`14: ecma14BinaryPropertiesOfStrings`) — the mixed
string/identifier value types in one object literal may be the trigger (the
object's inferred element type or the WasmGC field representation for a
heterogeneous numeric-keyed literal).

## Suggested approach

1. Build the full repro (module-global numeric-keyed literal with mixed
   `""`/identifier values + dynamic-key read in an assignment-expression). Probe
   driver pattern: `.tmp/drive.mjs` from the #1712 branch
   (`/workspace/.claude/worktrees/issue-1712-acorn-identity/.tmp/`).
2. Emit WAT (`compileToWat`) and inspect how the numeric-keyed module-global
   object is built and how `obj[ver]` reads — does the `""` entry get a struct
   field at all, or does the read take a fallback that returns `ref.null`?
3. Likely fixes to weigh: ensure empty-string values in a numeric-keyed object
   literal are stored (not elided as a falsy default), and that the dynamic
   numeric-key read resolves the stored field rather than falling through to a
   `null`-returning `__extern_get` arm. Cross-check against #2542 (standalone
   dynamic computed-key read/write) — this is the JS-host analog.

## Acceptance

- The full-shape repro reads `obj[ver]` as `""` (not null), and
  `wordsRegexp(obj[ver])` returns `/^(?:)$/` without throwing.
- Compiled acorn's module-init `buildUnicodeData` completes (no
  `Cannot read properties of null` during instantiate).
- No test262 / equivalence regression (this touches computed member access +
  object-literal codegen — validate broadly).
- This unblocks the next acorn dogfood step; #1712 stays open until the full
  parse + AST-match acceptance is met.

## Resolution (2026-06-21, sd-acorn) — TRUE root cause + fix

The "empty-string value elided" hypothesis above was WRONG. Bisected the real
trigger to a **6-line repro** and pinned a precise two-part root cause.

### True root cause

A **non-literal numeric key** read on a statically-typed numeric-keyed object
literal (`{ 9: …, 10: … }`) returns `undefined` when executed in
**module-init / top-level** code:

```ts
var props = { 9: "a", 10: "b" };
var arr = [9, 10];
var tlPlain = props[9];        // literal key  → "a"   (always worked)
var tlArr   = props[arr[0]];   // RUNTIME key  → undefined (BUG)
// the same `props[arr[0]]` read INSIDE a function → "a" (worked)
```

Mechanism (two compounding defects):

1. **Codegen split** (`src/codegen/property-access.ts`,
   `compileStructOrExternElementAccess`): a LITERAL/const numeric key lowers to
   a static `struct.get $type fieldIdx` (exports-independent, works anytime). A
   NON-literal key (`arr[0]`, a `var` loop counter, an `any` param) yields
   `fieldName === undefined` and falls to the DYNAMIC path
   `__extern_get(extern.convert_any(props), __box_number(key))`.

2. **Module-init timing + symbol-ID swallow** (`src/runtime.ts` `_safeGet`):
   `__extern_get` → `_safeGet(struct, 9)` reads the field via the
   `exports["__sget_9"]` getter. But the module-init top-level
   `for (…) buildUnicodeData(list[i])` loop runs inside the Wasm **START
   function**, BEFORE `__setExports` wires the exports — so `__sget_9` is
   unavailable, the fast-path is skipped, and `_safeGet` falls into the
   well-known-symbol-ID branch (`key >= 1 && key <= 15`; key 9 ∈ [1,15]),
   treats 9 as Symbol-ID 9, finds nothing, and `return undefined`. Confirmed
   via instrumentation: `[INTENT eget key=9 (number)] objStruct=true
   sget?=undefined`.

acorn's `wordsRegexp(unicodeBinaryPropertiesOfStrings[ecmaVersion])` (ecmaVersion
from `list[i]` in the module-level loop) hits exactly this → `undefined` →
`wordsRegexp(undefined)` → `undefined.replace` → instantiation throws.

### Fix

`src/codegen/property-access.ts`: when the element-access receiver is a struct
whose fields are **ALL numeric-named externref slots** (a plain numeric-keyed
object literal) and the key is switch-eligible (number / `any` / `unknown`, but
NOT statically string-typed), emit a static `struct.get` **key-switch**
(`if key===N0 then struct.get F0 else if key===N1 … else ref.null.extern`)
instead of `__extern_get`. This is exports- and host-independent, so it reads
correctly at module-init AND at runtime — generalising the existing literal-key
`struct.get` lowering to a runtime numeric key. A statically string-typed key,
or a mixed-shape struct, falls through to the dynamic `__extern_get` path
unchanged.

### Validation

- Regression pin `tests/issue-2582-numeric-key-struct-read.test.ts` (3 tests:
  top-level runtime-key read, module-level loop driving the read does not throw,
  string-key read still resolves the field). All green.
- The full extracted acorn unicode-data section (`buildUnicodeData` +
  numeric-keyed objects + module loop) went throws-on-instantiate → returns 6.
- **Real compiled acorn now INSTANTIATES** (`instantiated OK; parse=function`) —
  the `__module_init` `buildUnicodeData` throw is gone. Before this fix,
  instantiation rejected.
- No regression: scoped computed-property / element-access / #2542 dynamic-key
  suites all pass (the `./helpers.js` "Failed Suites" are a pre-existing
  worktree test-infra gap, not introduced here).

### NEXT acorn blocker (4th, NOT this issue)

With acorn now instantiating, `parse("var x = 1;")` **infinite-loops** again —
a TIGHT Wasm loop (it never yields to the JS event loop, so a `setTimeout`
watchdog can't fire; only an OS-level `timeout` kills it). This is forward
progress (parse is now REACHABLE; before, instantiation itself threw), but a
fresh, deeper blocker past module-init — a separate slice. Filed as a follow-up;
#1712 stays open until the full acorn parse + AST-match acceptance is met.
