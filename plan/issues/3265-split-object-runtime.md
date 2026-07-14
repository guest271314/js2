---
id: 3265
title: "Split object-runtime.ts — extract standalone Proxy dispatch subsystem into object-runtime-proxy.ts"
status: ready
sprint: current
priority: high
feasibility: medium
model: opus
task_type: refactor
subtask_of: 3182
area: codegen
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
