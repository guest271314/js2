---
id: 2937
title: "Regression: host-mode $Object-hash poison (#2849) makes compiled-acorn parse null-deref on every input"
status: ready
created: 2026-07-02
updated: 2026-07-02
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
language_feature: object
goal: runtime-eval
sprint: current
parent: 2927
depends_on: []
related: [2849, 2584, 2432, 1712, 1710, 2850, 2853]
---

# #2937 — host-mode `$Object`-hash poison regresses compiled-acorn to a uniform null-deref

**Blocker for #2927** (Acorn-via-js2wasm interpreter foundation) and for the
prior acorn self-host work (#2850 / #2853), which this regression **masks**.

## Symptom

On current `main` (`c26fc059a3422`), the compiled-Acorn parser throws at
runtime for **every** input — including the empty program `""`:

```
parse("")            => TypeError: Cannot access property on null or undefined
parse("1")           => TypeError: Cannot access property on null or undefined
parse("var x = 1;")  => TypeError: Cannot access property on null or undefined
```

The `#1712` differential corpus harness went from **13 equal±quirks / 8 real / 1
threw** (documented in `tests/dogfood/CORPUS-GAP-MAP.md`, re-run 2026-06-30) to
**22 / 22 `compiled-parse-threw`**. The throw fires on `""` too, so it happens
during **parser setup** (the `Parser` constructor / `getOptions`), before any
real parsing — i.e. it is upstream of the input-specific gaps #2850/#2853, which
can no longer be observed until this is fixed.

The compile itself still succeeds and the binary still validates — this is a
pure **runtime** null-deref (`typeErrorThrowInstrs` in
`src/codegen/property-access.ts`), a member access on a receiver that is null at
runtime when it should be a live object.

## Root cause — bisected

`git bisect` (compile Acorn → `parse("1")`; GOOD = returns a `Program`, BAD =
null-deref) over the 2026-07-01 evening merge batch pins the first bad commit:

```
4173306a9b29f3d1884cebf6e1972dea32508c75
fix(#2849): extend $Object-hash poison to host so static writes don't shadow the sidecar
(landed via PR #2432 — issue-2849-acorn-ecmaversion-normalize)
```

That commit, in `src/codegen/declarations.ts` (`collectEmptyObjectWidening`),
**dropped the `if (ctx.standalone)` gate** around the `markObjectHashConsumers`
loop so the `#2584` `objectHashConsumerVars` **poison applies in host mode too**:

```ts
// BEFORE (standalone-only):
if (ctx.standalone) {
  for (const s of stmts) markObjectHashConsumers(s, varName, ctx.objectHashConsumerVars);
}
// AFTER (#2849 — host too):
for (const s of stmts) markObjectHashConsumers(s, varName, ctx.objectHashConsumerVars);
```

The poison keeps a `{}` var that has **both** dynamic-key access (`o[k]=`, for-in,
`in`, `Object.keys/values/entries`) **and** static-named access on the `$Object`
sidecar, suppressing widening into a closed WasmGC struct. #2849 needed this in
host mode to fix the acorn `getOptions` for-in-copy shape (ecmaVersion `2022`
read back as `0` instead of `13`). But extending the poison to host mode makes
some access shape Acorn uses read back a **null receiver**, and the null guard
throws.

## Fix direction (confirmed) — and why a plain revert is NOT acceptable

Re-adding the `ctx.standalone` gate makes compiled-Acorn parse again (verified —
the bisect probe returns GOOD with the gate restored). **But** re-gating
reintroduces the exact #2849 host bug (getOptions `2022 → 0`) and breaks the host
assertion in `tests/issue-2849.test.ts`. So the fix must **preserve #2849 while
not regressing the broader host-mode `$Object` read path** — either:

1. Fix the host-mode `$Object` read path so a poisoned object reads correctly for
   **all** access shapes (not just the for-in-copy shape #2849 tested), or
2. Narrow the host-mode poison trigger to the precise for-in-write→static-widen
   divergence #2849 needs, leaving Acorn's shape on the (working) struct/Proxy
   fast path.

`(1)` is the principled fix. `(2)` risks reintroducing #2849 for the narrowed-out
shapes and needs the exact Acorn trigger to draw the line safely.

## Reduction status

Seven reduced shapes did **NOT** reproduce (they return the correct value in host
mode on current main): for-in-copy of a primitive with a poisoning static write
(`o.extra=1`); object-valued copy + chained read; bracket-write of an object +
member access; copy-then-local + member access; **object escape** (poisoned
object returned from a function and read chained by the caller); poisoned object
stored on `this.options` and read by a method; and a `getOptions`-exact
default-copy + `in`-guard + `ecmaVersion` normalise (returns `13` correctly). So
the trigger is a **larger / class-shaped** Acorn pattern, not a trivial one.

**Recommended next reduction step:** instrument `typeErrorThrowInstrs` /
`emitNullCheckThrow` to emit a **per-call-site-unique** message (the current
throw has line/col `0`, so it can't be located from the payload), recompile
Acorn, and read which member-access site fires — then reduce from that site.

## Repro

Deterministic, committed, one command (the #1710 dogfood harness):

```bash
# in a worktree off current main:
ln -s /workspace/node_modules node_modules
npx tsx tests/dogfood/acorn-corpus.mjs        # 22/22 compiled-parse-threw
```

Minimal throw-payload probe (extracts the real thrown value via the exported
`__exn_tag`): compile pinned acorn (`skipSemanticDiagnostics: true`),
instantiate, `wrapExports`, call `parse("")` — throws `TypeError: Cannot access
property on null or undefined`.

## Impact

- **Invisible to test262** (Acorn is not in the suite; the baseline stayed
  33,147 across the #2432 merge), so no conformance gate caught it — the dogfood
  harness is the only thing that did. This is the case for wiring the corpus
  harness into a CI signal (follow-up).
- **Blocks the entire #2927 critical path** ("Acorn source → valid Wasm that
  parses hello-world") and **masks** #2850 / #2853 (they cannot be re-verified
  until the parser survives setup).
- Likely regresses other **host-mode** programs with the same
  dynamic-key-write + static-named-access `{}` shape at scale.

## Acceptance criteria

- [ ] Compiled-Acorn `parse("")` / `parse("1")` return a `Program` in host mode
      (dogfood corpus back to ≥ the 2026-06-30 baseline: ≥13 equal±quirks).
- [ ] `tests/issue-2849.test.ts` still passes (host `2022 → 13` preserved).
- [ ] Standalone codegen byte-identical (poison was already on there — no change).
- [ ] A regression test captures the Acorn-shaped null-deref (reduced repro, or a
      guarded compiled-Acorn smoke assertion in `tests/`).
