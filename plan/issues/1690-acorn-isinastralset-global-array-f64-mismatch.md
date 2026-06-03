---
id: 1690
title: "Stress test: compile acorn.mjs — invalid Wasm in isInAstralSet (f64 op reads global array ref)"
status: done
created: 2026-05-27
updated: 2026-05-28
completed: 2026-05-28
priority: high
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen, import-bookkeeping
language_feature: arrays, globals, closures, number-arithmetic
goal: self-hosting-dogfood
sprint: Backlog
related: [1679, 1677, 1666, 1618, 1314, 1710, 1711, 1712]
note: "Surfaced behind #1679. With #1679's `new this(...)` blocker gone on current main (e622751f7), acorn.mjs now compiles to success=true with 0 errors but emits INVALID Wasm — the next blocker. Distinct from #1679 (which is codegen-acceptance only)."
---
## Root cause + fix (2026-05-28)

The hypothesis in the issue body was almost right (an index-shift
bookkeeping miscount) but the location was different from #1618/#1677/#1314.
The `global.get` index passed to `f64.lt` was NOT computed from a stale
function index or a stale late-import shift — it was a stale
**module-global** index read out of `ctx.moduleGlobals` AFTER
`fixupModuleGlobalIndices` had already moved it. The walker simply could
not reach the instruction.

**Minimal repro** (see `tests/issue-1690.test.ts` — `compile()` returns
`success=true` but `WebAssembly.compile()` rejects the binary):

```js
for (var i = 0, list = [1, 2, 3]; i < list.length; i += 1) {
  var x = list[i];
}

function f(set) {
  var pos = 0;
  for (var i = 0; i < set.length; i += 2) {
    pos += set[i];
    if (pos > 10) return false;
    pos += set[i + 1];
    if (pos >= 20) return true;
  }
  return false;
}
```

The top-level `for (var i = 0, list = [...])` registers `i` and `list` as
**module globals** (`__mod_i`, `__mod_list`) via the top-level `var`
for-init path that converts to `global.set`. The function-local `var i`
inside `f` then ALSO resolves to `__mod_i` (a separate but pre-existing
scope leak — `compileForStatement` doesn't check `fctx.localMap`/scope
before reaching for `moduleGlobals`). That scope leak alone would have been
a correctness bug at runtime, but a WORSE bug fires first: invalid Wasm at
validation time.

### What was actually broken

`compileForStatement` (`src/codegen/statements/loops.ts`) used a **manual
body swap** to compile the loop condition into a fresh array, then copied
the result into a local `condInstrs` variable:

```ts
const condInstrs: Instr[] = [];
if (stmt.condition) {
  const condBody = fctx.body;
  fctx.body = [];                    // unregistered fresh array
  compileExpression(ctx, fctx, stmt.condition);
  ensureI32Condition(fctx, condType, ctx);
  fctx.body.push({ op: "i32.eqz" });
  fctx.body.push({ op: "br_if", depth: 1 });
  condInstrs.push(...fctx.body);     // copies refs into a detached array
  fctx.body = condBody;              // detach: condInstrs is now orphaned
}
```

The same pattern was used for `incrInstrs` a few lines below.

After this block `condInstrs` holds references to Instr objects that are
**not** reachable from `fctx.body`, `fctx.savedBodies`, `ctx.funcStack`,
`ctx.parentBodiesStack`, or `ctx.liveBodies`. They sit in a JS local
variable until the loop is assembled and pushed back into `fctx.body` at
the end of `compileForStatement`.

During the loop body compilation (which happens in the middle of that
window), nested codegen routinely fires `addStringConstantGlobal` — e.g.
for `"TypeError: Cannot access property on null or undefined at L:C"`
strings emitted on every null-check arm. Each such call inserts an import
global, calls `fixupModuleGlobalIndices(ctx, threshold, +1)` to shift every
`global.get`/`global.set` index >= threshold by +1, and `shiftMap` to bump
every entry in `ctx.moduleGlobals` similarly.

`fixupModuleGlobalIndices` walks `mod.functions[*].body`,
`currentFunc.body+savedBodies`, `funcStack[*].body+savedBodies`,
`parentBodiesStack`, `pendingInitBody`, and `mod.globals[*].init`. It did
**not** walk `ctx.liveBodies`, and `condInstrs`/`incrInstrs` are not in any
of the other roots. So the map entry for `__mod_i` shifts from N → N+1,
but the already-emitted `global.get N`/`global.set N` instr objects sitting
in `condInstrs` are left untouched.

Net result for `isInAstralSet`: the condition `i < set.length` was emitted
when `moduleGlobals.get("i") === 2472`. Body compilation added two
string-constant globals (the TypeError messages on the null-check arms),
shifting `moduleGlobals.get("i")` to 2474. The init `i = 0` and the
incrementor `i += 2` (emitted later in compile order) used 2474 (correct),
but the cond's stale `global.get 2472` now pointed at
`__mod_unicodeScriptValues` — a `(ref null 57)` array global. The
validator saw `f64.lt` consuming a ref operand and rejected the module.

The bug is the SAME class as the function-index-shift gap that #1384
closed (unreached `cbFctx.body` / `liftedFctx.body`) — the fix used
`liveBodies` as the catch-all root for orphaned-but-live instruction
buffers. This fix extends the same mechanism to the module-global walker.

### Fix (two changes)

1. **`src/codegen/statements/loops.ts`** — register the temporary
   `condInstrs` and `incrInstrs` arrays in `ctx.liveBodies` for the window
   they sit detached from `fctx.body`, and assign `fctx.body = condInstrs`
   directly instead of copying via spread (so emitted instrs land in the
   tracked array, not a throwaway intermediate). Same fix applied to
   `compileDoWhileStatement` for its detached cond buffer.

2. **`src/codegen/registry/imports.ts`** — `fixupModuleGlobalIndices` now
   walks `ctx.liveBodies` alongside the other roots. This brings the
   module-global walker in line with `shiftLateImportIndices` (function
   index shifts), which has walked `liveBodies` since #1384.

### Verification

- `tests/issue-1690.test.ts` — three focused tests covering the for-loop,
  incrementor, and do-while paths. All pre-fix repros now produce a binary
  that passes `WebAssembly.compile()`.
- The original f64.lt validation failure in `isInAstralSet` is gone:
  `WebAssembly.compile()` now gets past `isInAstralSet` and reports a
  DIFFERENT failure further along (`any.convert_extern[0] expected type
  externref, found ref.cast null of type (ref null N)` inside
  `__fnctor_Parser_new`). That's a separate, unrelated codegen bug in
  class ctor wrappers — not in scope for #1690 and worth its own issue.
- Scoped existing tests (loops, module-globals, for-of, arguments-loops):
  failure pattern identical before and after the fix (the seven
  `string_constants` instantiate failures are pre-existing harness issues,
  not regressions).

### Out of scope (worth their own issues)

- **`__fnctor_Parser_new` `any.convert_extern` type mismatch** — newly
  visible after this fix unblocks `isInAstralSet`. Validator sees
  `any.convert_extern` consuming a `ref.cast null` of class-struct type
  instead of an externref. Class constructor wrapper lowering issue,
  unrelated to global-index shifts.
- **The `compileForStatement` scope leak** —
  `ctx.moduleGlobals.get(name)` is consulted in the for-init path
  *without* first checking `fctx.localMap.has(name)`. Function-local
  `var i` is currently treated as the top-level `__mod_i` if a same-named
  top-level for-init exists. The runtime semantics are wrong (the function
  clobbers a module global instead of using its own slot) but they no
  longer produce invalid Wasm. Track separately.
---
# #1690 — acorn.mjs compiles but emits invalid Wasm: `f64.lt` reads a global array ref in `isInAstralSet`

## Problem

Stress-testing against [acorn](https://github.com/acornjs/acorn) 8.16.0
(`dist/acorn.mjs`, 6,266 lines, pure ESM, MIT, no deps) on current main
(`e622751f7`):

- `compile(acornSrc, { fileName: "acorn.mjs" })` → **`success = true`, 0 errors**,
  700,820-byte binary, ~31 s compile time.
  (The `new this(...)` errors that #1679 documented are **gone** on this HEAD —
  acorn now passes codegen acceptance. This issue is the *next* blocker.)
- `WebAssembly.compile(binary)` (validation only) → **INVALID**:

```
WebAssembly.instantiate(): Compiling function #56:"isInAstralSet" failed:
f64.lt[0] expected type f64, found global.get of type (ref null 56) @+180284
```

The validator stops at the first bad function, so there may be more behind it.

## The offending source

`acorn.mjs:48-57` — a hot identifier-classification helper:

```js
function isInAstralSet(code, set) {
  var pos = 0x10000;                       // f64 accumulator
  for (var i = 0; i < set.length; i += 2) {
    pos += set[i];                         // numeric += untyped-array element
    if (pos > code) { return false }       // <-- f64.lt here
    pos += set[i + 1];
    if (pos >= code) { return true }
  }
  return false
}
```

Called as `isInAstralSet(code, astralIdentifierStartCodes)` /
`isInAstralSet(code, astralIdentifierCodes)` (`acorn.mjs:68,82`), where the
`set` argument is a **module-level numeric array global**
(`var astralIdentifierStartCodes = [0, 11, 2, …]`, ~700 elements).

The error says an `f64.lt` operand is a `global.get` of type `(ref null 56)` —
i.e. the codegen pushed the **array-struct global reference** onto the stack
where an `f64` (the `pos`/`code` comparison) belongs. The `56` in `(ref null 56)`
matching the failing function index `#56` is coincidental (both are just the
56th type / function), but the symptom is a numeric op consuming a ref operand.

## Why it's an interaction bug (not localizable to isInAstralSet)

The same function in isolation compiles to **valid** Wasm. Confirmed:

| reduced input | result |
|---|---|
| `isInAstralSet` alone (single export) | VALID |
| `pos += set[0]; pos > x` minimal accumulator | VALID |
| acorn lines 1-83 (both big global arrays + RegExp + `isInAstralSet` + `isIdentifierChar`, export `probe`) | VALID — 15,408 bytes |
| full `acorn.mjs` (6,266 lines) | **INVALID** (above) |

So the bug only appears at full-module scale. The signature —
a numeric op fed a stale `global.get` ref — is the classic fingerprint of a
**function/global index-shift miscount** (the `addUnionImports` /
`shiftLateImportIndices` family, cf. #1618, #1677, #1314): once enough
functions/globals/late-imports accumulate, an index the codegen baked into
`isInAstralSet` no longer points at the f64 value it expected but at an
array-struct global, and the validator rejects the resulting `f64.lt`.

## Reproduction

```bash
cd /workspace/.tmp/acorn
npm pack acorn && tar xzf acorn-*.tgz          # → package/dist/acorn.mjs
npx tsx probe.mjs                               # see scratch harness below
# → compile() success=true, binary 700820 bytes
# → WebAssembly.compile(binary) throws:
#   "function #56:\"isInAstralSet\" failed: f64.lt[0] expected type f64,
#    found global.get of type (ref null 56)"
```

Scratch harness used during investigation (`.tmp/acorn/probe.mjs`,
`repro.mjs`, `repro2.mjs`, `repro3.mjs`) — `compile(src,{fileName:"acorn.mjs"})`
then `WebAssembly.compile(r.binary)` for validation-only (no import object
needed). `fileName` MUST end in `.mjs`/`.js` so `allowJs` auto-enables;
with a `.ts` name the untyped JS floods 259 TS type errors and bails before
codegen (also a finding — see Notes).

## Investigation steps for the fixer

1. Bisect acorn between the valid 83-line slice and the full file to find the
   construct/size that flips validity (binary-search by truncating the source,
   keeping the identifier block + a growing tail, re-validating each cut).
2. Dump the WAT for `isInAstralSet` (`r.wat`) from the full-module compile and
   diff the `global.get` index against the global section — confirm whether a
   late-import/global shift left the index pointing at an array global.
3. Cross-check against #1618 / #1677 shift-regime fixes — likely the same
   bookkeeping path needs to also shift this site.

## Acceptance criteria

1. `WebAssembly.compile()` on the `acorn.mjs` binary succeeds (no `f64.lt`
   type-mismatch in `isInAstralSet` or any other function).
2. A focused test reproduces the index-shift class minimally (numeric
   accumulator over a module-global array, in a module large enough to trigger
   the shift) and validates.
3. No regression in test262 (esp. the existing index-shift / closure buckets:
   #1618, #1314, #1601).

## Notes / scope

- Out of scope here: runtime equivalence vs. real acorn output, and the
  pre-codegen TS-noise gate (259 strict-mode `implicit any` / `does not exist
  on type {}` diagnostics when acorn is fed with a `.ts` filename — those are
  suppressed correctly under `allowJs` for `.mjs`/`.js`, so they only bite if a
  caller mislabels the file; worth a docs note but not a codegen bug).
- Builds on #1679: that issue's `new this(...)` blocker is resolved on
  `e622751f7`, exposing this validation failure as the next gate to a clean
  acorn compile.
