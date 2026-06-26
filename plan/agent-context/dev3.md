# dev3 — session context (sprint 67, 2026-06-26)

- **#2704 / PR #2149 (MERGED)**: owned the parked merge_group regression root-cause — the post-dispatch `buildArgcExtrasReset` lazily registered `__extras_argv`'s vec heap type mid-body (first use), desyncing codegen so `new Map/WeakMap(iterable)` inside an `assert.throws` callback stopped throwing. Fix: `buildArgcResetNoLazyExtras` (reset `__argc` always, `__extras_argv` only if already registered).
- **#2707 sub-bug (c) / PR #2159 (open, handed to lead for CI+enqueue)**: TCO through `?:`/`&&`/`||`/comma/labeled — three stacked layers (recursive named-fn-expr IIFE inlined→no-recursion; IR tail call buried in `(if result)` arm; #1511 argc-reset emitted between tail call and return). +6 tests, 67→73, zero regressions. #2707 narrowed to (c) + set done-on-merge.
- **#2732 (new, ready)**: split-out follow-up for #2707 (a) unary ToPrimitive(object) trap + (b) strict-equals boxed-wrapper/funcref trap — runtime traps, value-rep substrate, **architect-routed / feasibility:hard**. Do NOT take as a plain dev task.
- **Stood down** after #2159 enqueue per lead (clean dev wins exhausted).
