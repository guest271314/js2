---
id: 3235
title: "standalone: spurious `env::__make_callback` import leak — coarse callbackFound scan declares an unsatisfiable host import that is never called"
status: done
completed: 2026-07-13
sprint: 71
priority: high
feasibility: medium
reasoning_effort: max
task_type: bugfix
area: codegen
language_feature: closures, callbacks, iterator-helpers, standalone
goal: host-independence
assignee: ttraenkler/opus-leak
related: [2940, 3098, 3016, 2903]
loc-budget-allow:
  - src/codegen/closures.ts
  - src/codegen/declarations.ts
origin: "2026-07-13 standalone sole-import leak ranking (opus-leak). test262-standalone-current.jsonl @ 13.7.2026 11:39; 25 sole-`__make_callback` leaky-pass entries + ~2.3k multi-import de-leaks."
---

# #3235 — standalone spurious `env::__make_callback` import leak

## Problem

In standalone (no-JS-host) / WASI mode the compiled module **declares**
`env::__make_callback` as a host import but **never calls it**, which fails the
host-free-pass metric even though the code runs host-free. Ranked #1 bounded
sole-import leak in the 2026-07-13 standalone baseline:

- **25** leaky-*pass* entries have `__make_callback` as their **sole** import
  (Iterator-helper `next-method-returns-throwing-value-done` tails for
  find/every/reduce/map/filter/forEach, `Function.prototype.toString` proxy
  cases, `String.prototype.at` ToInteger, etc.). Every one flips to host-free.
- `__make_callback` also appears in **~2,356** total leaky-pass entries; this
  removes it from the ~2,331 multi-import ones too, de-leaking them (each moves
  one import closer to a future host-free flip).

### Root cause

`src/codegen/declarations.ts` `collectCallbackImports` sets
`state.callbackFound = true` for **any** `ArrowFunction` / `FunctionExpression`
anywhere in the module — an extremely coarse trigger. The finalize step then
registers `env::__make_callback` **unconditionally** (no standalone gate),
unlike the JSON imports right above it (`jsonHostUnavailable`) and the
async-CPS detector right below it (`!ctx.standalone && !ctx.wasi`).

The **call site** (`compileArrowAsCallback`, gated by `isHostCallbackArgument`)
already correctly routes standalone callbacks to the native closure path — the
`#3098` dispatch substrate (`__apply_closure` / `__hof_*` / `__iter_hof_*`)
services every *exercised* callback host-free. So the eager registration only
ever declares a **never-called** import.

Verified by compiling `iterator.find(() => {})` standalone: the `.wat` contains
the `(import "env" "__make_callback" …)` declaration at exactly one line and
**zero** `call $__make_callback` sites.

Why this is safe for pass-count: a genuinely-*called* `__make_callback` in
standalone is an unsatisfiable import → the module can't instantiate → it can't
be `pass`. So every standalone leaky-*pass* with `__make_callback` has it
declared-but-uncalled. (#2940 previously warned that naively dropping the import
yields "dishonest vacuous passes"; #3098 has since landed the real native
callback-dispatch substrate, so exercised callbacks now dispatch natively and
the residual is purely the spurious declaration.)

## Fix

Two-file, standalone/WASI-gated, JS-host lane byte-identical:

1. **`src/codegen/declarations.ts`** — gate the `__make_callback` registration
   on `!(ctx.standalone || ctx.wasi)` (mirrors the async-CPS detector). The
   JS-host lane is unchanged.
2. **`src/codegen/closures.ts`** (`compileArrowAsCallback`) — belt-and-
   suspenders: when `__make_callback` is unavailable AND standalone/WASI, degrade
   to `compileArrowAsClosure` (native first-class closure struct) instead of
   `reportError`. Guarantees no dangling `call __make_callback` if any residual
   host-bridge site is reached; the callback becomes a valid host-free function
   object dispatched via `__call_fn_N` / `__apply_closure` where exercised.

## Acceptance

- `iterator.find(() => {})` compiles standalone with **no** `__make_callback`
  import (host-free).
- The 25 sole-`__make_callback` standalone leaky-pass entries flip host-free.
- No standalone regression: genuinely-exercised callbacks still dispatch via the
  native substrate; JS-host lane byte-identical.
