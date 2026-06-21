---
name: project_2026_pr1_and_28_already_landed
metadata: 
  node_type: memory
  type: project
  originSessionId: 9b7877fc-6699-40e1-b5cf-8f2f65bfd493
---

As of upstream/main @ f1232bcee (2026-06-18), the #2026 dynamic-`new` uniform
constructor ABI is **already landed** and the #28 Promise blocker is **already
fixed** — despite TaskList #28 still reading "[BLOCKED on #2026]" and the #2026
issue file still at `status: in-progress`.

- **#2026 PR-1** = commit `4748db5cd` (PR #1647 issue-2026-class-first-class):
  `emitDynamicNewFallback` + `getFuncResultType` in
  `src/codegen/expressions/new-super.ts` — pure-Wasm tag-dispatch for
  `new K()` on a value-bound class. Discriminates by class `__tag` (field 0),
  NOT struct type (WasmGC canonicalization merges shape-identical class structs,
  so `ref.test $A` also matches a `$B` of the same shape — verified mis-construct).
- **#2026 PR-1b** = commit `e0c130d94` (PR #1672 issue-2026-standalone-ctor-abi):
  standalone/WASI parity — skip the `__new_<name>` host import in no-JS-host mode
  (`declarations.ts`) AND extend the `__register_class_object` skip to `wasi`
  (`index.ts`, guard `!(ctx.standalone || ctx.wasi)`).
- Tests live + green: `tests/issue-2026-dynamic-new.test.ts` (7),
  `tests/issue-2026-standalone-dynamic-new.test.ts` (6).

**#28 was NOT actually blocked on the #2026 ABI.** Its real root cause
(per the #28 impl log, fixed in commit `4f1337f3e` / PR #1675) was
`isHostCallbackArgument` in `src/codegen/closures.ts` routing an INLINE
`new Promise((res,rej)=>…)` executor through the `__make_callback` host-callback
path, which emitted no `__call_fn_2` dispatcher, so the executor was never
invoked. Fix: return `false` for the Promise ctor so the executor compiles as a
first-class closure. Test: `tests/issue-28-promise-executor-invocation.test.ts` (6).

**Still genuinely open** (do NOT re-implement PR-1 / PR-A):
- #2026 PR-2 (`.constructor === A` for an externref/`any`-typed receiver — the
  static-typed receiver already works) and PR-3 (spread/arity/new.target/
  non-ctor+null TypeError edges). Additive follow-ups; neither blocks #28.
- #28 senior-scale body: `NewPromiseCapability(C)` for custom constructors +
  resolver-element-function object semantics (~163 `built-ins/Promise` fails),
  explicitly folded into the #1042 async epic — async state-machine ↔
  host-microtask wiring (#1326), independent of the #2026 ctor ABI.

Lesson: re-establishing state caught this. "task in_progress" + "a branch
exists" ≠ "not landed" — the branch (issue-2026-standalone-ctor-abi) had been
extracted into merged PRs while the issue frontmatter went stale. See
[[feedback_verify_fix_in_git_not_narrative]].
