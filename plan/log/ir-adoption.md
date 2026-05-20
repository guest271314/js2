# IR adoption log

Living document tracking the AST → IR front-end adoption (see #1527 for
the orthogonality framing and #1530 for the fallback-budget phase-out).

The IR replaces the legacy direct-AST→Wasm codegen for the node kinds it
claims. Until the IR claims a node kind end-to-end, that kind keeps
flowing through the legacy `src/codegen/expressions.ts` /
`statements.ts` path. The "IR Fallback Budget" in `CLAUDE.md` plus the
gate at `pnpm run check:ir-fallbacks` measure how far we are from full
adoption per node kind.

This file is the human-readable companion to
`scripts/ir-fallback-baseline.json`. The baseline is machine-truth for
CI; this file is the planning artifact for which issue owns each
bucket, what its target date is, and what STRICT mode it currently sits
in.

## Per-bucket ownership (#1530)

Snapshot of `scripts/ir-fallback-baseline.json` as of 2026-05-20.

| Bucket                       | Count | Owner issues             | Target              | Strict? |
|------------------------------|-------|--------------------------|---------------------|---------|
| `body-shape-rejected`        | 22    | #1370, #1373             | 0 within 4 sprints  | no      |
| `call-graph-closure`         | 6     | #1370, #1373             | 0 within 2 sprints  | no      |
| `param-type-not-resolvable`  | 1     | quick fix (see below)    | 0 within 1 week     | no      |

"Strict?" tracks whether the rejection reason is in
`STRICT_IR_REASONS` (`src/codegen/index.ts`). When `yes`, the selector
rejects this reason as a hard compile error rather than letting the
legacy path silently take over. Flip a row from `no` to `yes` in the PR
that drops the bucket to zero — the rejection then becomes an
enforcement gate against future regressions.

### `param-type-not-resolvable` (count: 1)

Single site, identified by `pnpm run check:ir-fallbacks -- --verbose`:

```
playground/examples/benchmarks/helpers.ts: body-shape-rejected=1,
                                           param-type-not-resolvable=1,
                                           call-graph-closure=1
```

The offending function is `addBenchCard`:

```ts
export function addBenchCard(
  wrap: HTMLElement,
  title: string,
  desc: string,
  fn: () => number,        // <-- FunctionTypeNode param
): void { ... }
```

`resolveParamType` in `src/ir/select.ts` accepts `KeywordTypeNode` (for
`number` / `boolean` / `string` / `any`), `TypeLiteralNode`,
`TypeReferenceNode`, and `ArrayTypeNode`. It rejects everything else,
including `FunctionTypeNode` — that's the rejection for the `fn` param
above.

To drive this bucket to zero we need to either:

1. Accept `FunctionTypeNode` at the selector level and lower it to an
   `IrType.closure` via the existing closure shape registry. The
   closure machinery is already in place for nested function lifting
   (#1169c); the gap is the entry path from a direct annotation rather
   than a captured variable. This is the principled fix but a multi-
   slice effort — defer to a follow-up issue, NOT in #1530's scope.

2. Mark the specific example function as IR-deferred (e.g. by widening
   `addBenchCard`'s `fn` param to `any` in the playground source).
   Quick, but masks the underlying limitation and is a playground-only
   hack.

Neither is forced in #1530 — the issue calls out "small-and-correct
beats large-and-wrong" and lets this bucket carry the documented
location forward. The ratchet still applies: any future PR that fixes
the underlying limitation drops the bucket to zero, the ratchet writes
the new baseline back, and a follow-up PR adds
`"param-type-not-resolvable"` to `STRICT_IR_REASONS`.

### `body-shape-rejected` (count: 22)

Spread across the playground corpus — most occurrences are functions
that exercise class methods (#1370 Phase E — inheritance / accessors /
static methods) or async / await chains (#1373 Phase C — lowering).
The bucket drops as those slices land.

Re-run `pnpm run check:ir-fallbacks -- --verbose` for the current
per-file breakdown when starting a slice. Don't add to the
`STRICT_IR_REASONS` set until ALL sites are gone — the strict mode is
all-or-nothing per rejection reason.

### `call-graph-closure` (count: 6)

Caller / callee pairs where one side falls back to legacy and the
closure pass refuses to claim the other. Tracks #1370 and #1373
because the most common pattern today is "class method calls function
that calls class method" — the inner-most legacy fallback bubbles up.

## Ratchet mechanism (#1530)

`pnpm run check:ir-fallbacks` gates against
`scripts/ir-fallback-baseline.json`:

- **Growth** in any `unintended` bucket fails the run. PR author must
  either revert the growth or run `pnpm run check:ir-fallbacks --
  --update` and explain the new baseline in the PR body.
- **Decrease** under default mode is informational only. The local
  working tree is not modified.
- **Decrease** under `pnpm run check:ir-fallbacks -- --update-on-decrease`
  rewrites `scripts/ir-fallback-baseline.json` to the new (lower)
  counts. The script does not run `git add`; the contributor stages
  the diff explicitly so a clean run from a fresh tree never leaves
  surprise changes.

The intent is for the CI job that runs on the merged result (post-PR,
on `main`) to invoke the `--update-on-decrease` mode, so every PR that
shrinks a bucket auto-ratchets the floor without manual intervention.

## Strict-mode promotion path (#1530)

When a bucket reaches zero, the corresponding rejection reason is
added to `STRICT_IR_REASONS` in `src/codegen/index.ts`. The selector
then errors on any future regression rather than silently falling
back. Build-error patterns get a parallel treatment via
`STRICT_IR_BUILD_ERRORS` (substring match against the per-function
build-error message) — empty as of #1530, populated PR-by-PR as build
errors are known to be permanently fixed.

Both sets start empty, so #1530 is a non-behavioural change for the
existing buckets. The change is the gate plus the explicit
integration point for the next PR to wire its retirement into.
