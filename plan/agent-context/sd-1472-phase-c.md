# Context Summary — sd-1472-phase-c

_Written 2026-06-03._

## Role
Senior developer (Opus), handling hard codegen/type-system/runtime issues and architect specs for hard work in my lane.

## Final session output

### #1632b architect spec (PR #1121) — doc-only, self-merged
Wrote the **host-callable + constructible compiled-fn representation** spec — the
central blocker behind `Promise.all.call(wasmFn)`, `Function.prototype.bind`
`[[Construct]]`, `__construct`/`__reflect_construct` on compiled callees, and
several other host call sites that route a WasmGC closure/class through a JS host
proxy.

- **Spec location**: appended as `# #1632b — host-callable/constructible compiled-fn
  representation (architect spec)` to
  `plan/issues/1632-spec-gap-function-bind-tostring-internals.md` (NOT a new file —
  the existing #1632 file is the natural home; team-lead approved folding in).
- **Cross-reference note** added to `plan/issues/1694-promise-subclass-capability.md`
  ("Architect spec written" section) so the Promise A.i consumer points at the spec.
- **PR #1121**: `issue-1632b-host-fn-construct-trap` branch. All required checks green;
  enqueued via GraphQL `enqueuePullRequest`.

### Root cause (the spec's thesis)
`_wrapForHost` (`src/runtime.ts:3592`) wraps a WasmGC struct as a JS `Proxy` whose
**target is `Object.create(null)`** — a plain non-callable object. A Proxy is
callable/constructible **iff its target is**; a plain-object target can carry no
`apply`/`construct` trap and reports `typeof proxy === "object"`. So when V8 runs
`NewPromiseCapability(C)` → `Construct(C, [executor])` with `C` a compiled Wasm
function, `IsConstructor(C)` is false and V8 throws "not a constructor". The
`[[Call]]` path for closures is already solved by `_wrapWasmClosure`
(`src/runtime.ts:1436`, bridges into `__call_fn_${arity}` exports); only
`[[Construct]]` is the gap.

### The fix the spec prescribes
A sibling `_wrapCallableForHost(closure, exports)` that uses a **real `function`** as
the Proxy target (so `typeof === "function"`, `IsCallable`/`IsConstructor` true),
installing `apply` + `construct` traps that dispatch through the `__call_fn_N`
exports (and a future `__construct_closure` export for the true `[[Construct]]`
path). Route the three struct-callee sites to it when `exports.__is_closure(val)`:
- `_resolveCtor` (`src/runtime.ts:7822`) — the Promise-combinator `.call(C, iter)` hook
- `__construct` (`src/runtime.ts:7078`)
- `__reflect_construct` (`src/runtime.ts:7058`)

Spec suggests a split: **#1632b-1** runtime-only (extract shared read/has logic from
`_wrapForHost`, add `_wrapCallableForHost` + `_hostCallableCache` WeakMap, route the
three sites) and **#1632b-2** codegen (`__construct_closure` export for real
`[[Construct]]` semantics). #1632b-1 is dev-claimable now; it's the natural next task.

### ctx-non-object guard (task #68) — NO WORK NEEDED
Verified already resolved/WONT-FIX: `Promise.all.call(undefined, [])` already throws
TypeError correctly on main. The earlier "returns 1 instead of throwing" reading was a
probe-harness artifact — the `1` was the in-Wasm catch sentinel for the TypeError, not
a resolved value. Confirmed by dev-1599-parse and the #1694 re-validation table.

## Two independent #1694 re-validations converge
My re-validation #1 (task #283) and sd-846-slice3's re-validation #2 (PR #1120, merged
mid-session) **both** point to `_wrapForHost`'s `Object.create(null)` target as the
root cause and **#1632b** as the owner. PR #1121's conflict resolution preserved both
sets of findings in `1694-promise-subclass-capability.md`.

## Earlier-session work (delivered, per team-lead recap)
#1081 Phase C, #1629 S6 (standalone/WASI descriptor parity), #1116 vec.new_fixed spec,
#1117/#1694 re-val, IR null/?? (tasks #278/#279/#280), #1270/#280 recon.

## Worktree
- `/workspace/.claude/worktrees/issue-1632b-host-fn-construct-trap` — branch
  `issue-1632b-host-fn-construct-trap`. To be removed after PR #1121 lands and
  `/workspace` is synced to origin/main.

## Resume notes
- Next natural task: **#1632b-1** (runtime-only A.i fix). Dev-claimable once #1121 lands.
  When the closure-struct callee reaches `_resolveCtor`/`__construct`/`__reflect_construct`,
  return `_wrapCallableForHost(thisArg, exports)` instead of the plain `_wrapForHost`
  proxy (or `thisArg` unchanged).
- The full step-by-step plan, edge cases, and test262 buckets to re-run are in the
  #1632b spec section of `plan/issues/1632-spec-gap-function-bind-tostring-internals.md`.
