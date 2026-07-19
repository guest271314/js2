---
id: 3265
title: "Split object-runtime.ts — extract standalone Proxy dispatch subsystem into object-runtime-proxy.ts"
status: done
completed: 2026-07-14
assignee: ttraenkler/senior-dev-splitproxy
sprint: 72
priority: high
feasibility: medium
model: opus
task_type: refactor
subtask_of: 3182
area: codegen
# (#3265) Relocation-shift allowance: the 3 `__is_truthy` coercion-vocabulary
# sites moved VERBATIM out of object-runtime.ts into the new sibling module as
# part of the Proxy-subsystem extraction. Total repo usage is CONSERVED (proven
# by byte-identity IDENTICAL, 39/39). This is not new hand-rolled coercion — it
# is the same code at a new path. Per #3131, allow the destination file here
# rather than editing the whole-tree scripts/coercion-sites-baseline.json.
coercion-sites-allow:
  - src/codegen/object-runtime-proxy.ts
---

# Split `src/codegen/object-runtime.ts` — extract the Proxy dispatch subsystem

## Scope

Behaviour-preserving god-file split (subtask of #3182). `src/codegen/object-runtime.ts`
(~11,609 LOC) hosts the standalone Proxy meta-object dispatch subsystem, which is a
self-contained, pre-parameterized sub-area — the ideal first cut.

Move the following cohesive group **verbatim** into a NEW sibling module
`src/codegen/object-runtime-proxy.ts`:

- `ensureProxyRuntime` (top-level fn, invoked via explicit `(ctx, types, registerNative)`
  signature — never reaches into `ensureObjectRuntime`'s locals)
- `fillProxyDispatch` (exported FINALIZE filler)
- the 12 `PROXY_CALL_*` driver-name consts
  (`GET/SET/HAS/DELETE/GOPD/GPO/SPO/ISEXT/PREVEXT/OWNKEYS/DEFINE/APPLY`)

The 12 consts are referenced ONLY inside the group (reserve sites in
`ensureProxyRuntime`; fill sites in `fillProxyDispatch`) — nothing else in the repo
touches them, so they migrate as part of the unit. `object-runtime.ts` re-exports
`fillProxyDispatch` (so `index.ts`'s `from "./object-runtime.js"` keeps resolving) and
imports back `ensureProxyRuntime` (still called from `ensureObjectRuntime`). The giant
`ensureObjectRuntime` stays intact.

## Acceptance

- `npx tsc --noEmit` → 0 errors.
- `npx tsx scripts/prove-emit-identity.mjs check` → **IDENTICAL** (39/39 file,target
  emits across gc/standalone/wasi). This is a pure move: zero logic changes.
- Relocation-shift ratchets green locally (per-issue frontmatter allowances below,
  NOT whole-tree baseline edits — #3131).
- Smoke test `tests/issue-3265.test.ts` compiles a program exercising standalone Proxy.

## Notes

Method proven on #808 (index.ts→registry/imports.ts, byte-identity IDENTICAL). Byte-identity
IDENTICAL is the proof that any ratchet trips are false-positive relocation shifts (total
usage conserved), so the per-issue allowances are the sanctioned fix.

## Result

- Moved: `ensureProxyRuntime`, `fillProxyDispatch`, and the 12 `PROXY_CALL_*` consts —
  verbatim (worktree lines 7785–9249, 1465 LOC) into `src/codegen/object-runtime-proxy.ts`.
  The new module is same-dir, so all relocated relative import paths are byte-identical (no
  rebasing). `ensureProxyRuntime` gained an `export` keyword (the only wiring edit to the
  moved code); `fillProxyDispatch` was already exported.
- `object-runtime.ts` rewiring: `import { ensureProxyRuntime } from "./object-runtime-proxy.js"`
  (still called from `ensureObjectRuntime`) + `export { fillProxyDispatch } from
  "./object-runtime-proxy.js"` (so `index.ts`'s `from "./object-runtime.js"` import keeps
  resolving). `ObjectRuntimeTypes` (type) and `reserveApplyClosure` (value) are imported into
  the new module from `./object-runtime.js` — a function-level cycle of the same tolerated
  shape as native-strings ↔ any-helpers.
- `src/codegen/object-runtime.ts`: 11,609 → 10,149 LOC (`object-runtime-proxy.ts`: 1,487 LOC).
- `npx tsc --noEmit` → 0 errors.
- `npx tsx scripts/prove-emit-identity.mjs check` → **IDENTICAL** (39/39: 29 ok-sha + 10
  stable-CE, gc/standalone/wasi).
- Ratchets: loc-budget OK (net +27), oracle-ratchet OK, dead-exports OK, verdict-oracle-bump
  OK. Only `check:coercion-sites` tripped (`object-runtime-proxy.ts: 0 → 3 __is_truthy`, a
  pure relocation) — granted via the `coercion-sites-allow` frontmatter block above.
- Smoke: `tests/issue-3265.test.ts` (get trap / has trap / absent-trap forward / gc lane) — 4/4 pass.

## Test Results

`npx vitest run tests/issue-3265.test.ts` → 4 passed. tsc 0. format/lint/godfiles/issue-ids/spec-coverage green locally.
