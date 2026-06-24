---
id: 2634
title: "@types/node → capability-map extraction for node:fs (Phase 2 of #1772)"
status: done
created: 2026-06-24
updated: 2026-06-24
completed: 2026-06-24
assignee: ttraenkler/agent-a921399b87f4505a7
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: feature
area: host-interop
language_feature: node-api-compat
goal: platform
sprint: 65
es_edition: n/a
related: [1772, 2624, 2625, 2631, 2528, 2083, 2181, 2527]
origin: "Phase 2 split out of #1772 once Phase 0 (ABI) + Phase 1 (edge.js dual-provider proof) landed"
---
# #2634 — @types/node → capability-map extraction (node:fs)

Phase 2 of #1772. Phases 0 (the `node:fs` pointer-ABI, `docs/architecture/node-fs-abi.md`)
and 1 (the `edge.js` provider + same-binary dual-provider proof,
`examples/native-messaging/edge.js`, `tests/issue-1772-edge-dual-provider.test.ts`)
are done. This issue replaces the hand-written minimal typings with extraction
from `@types/node`, gated by a capability map.

## Problem

The compiler today recognizes a hand-written minimal set of `node:fs` members
(`buildNodeEnvDts` / `scanNodeEmuUsage`, #2624). The type surface of
`@types/node` is thousands of members, but only the subset with a runtime
provider (a `.wat` shim, an `edge.js` adapter, or a WASI mapping) is *linkable*.

Without a capability gate, a program type-checks against the full `@types/node`
surface then fails to **link** with an opaque error when it calls a member no
provider satisfies.

## Scope

- Drive the importable surface + types from `@types/node` (compose with #2528
  `--platform node`), replacing/extending the hand-written `buildNodeEnvDts`.
- Gate against a **capability map**: `@types/node` member → provider fn → host
  classes that can provide it. Only runtime-satisfiable members type-check clean.
- An **unsatisfiable** member (typed in `@types/node`, no provider) must produce
  a precise, deliberate compile error ("no provider for `node:fs.openSync` under
  `--target wasi`"), never a silent link failure.
- Anchor members: `node:fs` `readSync`/`writeSync` (already linkable per the
  Phase 0 ABI). Extend the map structure so adding `node:process`/`node:os`
  members later is a data change, not a code change.

## Acceptance

- A working `@types/node` → capability-map extraction for the anchor `node:fs`
  members, with the deliberate-error path for unsatisfiable members.
- Follow-up issues filed for further surfaces (process/os/path tiers).
- This is #1772 Phase 2; #2635 covers Phase 3 (async members, gated on #2632).

## Resolution (2026-06-24)

New module `src/checker/node-capability-map.ts` is the single source of truth for
the importable `node:<mod>` surface. `buildNodeEnvDts` (`src/checker/index.ts`)
now drives the `node:fs` type surface from it, retiring the hand-rolled
approximate signatures.

### The allowJs / TS8017 overload constraint — how it's solved

Real `@types/node` uses overloaded `export function` declarations. Bodiless
overloads are illegal (TS8017) in a `.ts`/`.js` NON-declaration file, which is
why the #2631 hand-roll collapsed everything into a single `export const`
call-type. The fix: the synthetic surface is injected under the name
`__js2wasm_node_env.d.ts` — a `.d.ts`-named source whose `SourceFile` has
`isDeclarationFile === true` (verified directly). **Overloads ARE legal in a
declaration file.** The user's import site only *references* the imported names,
never the overload bodies, so TS8017 never fires there. Confirmed by the existing
allowJs `.js`-host test (#1768 `linkNodeShims` case) staying green plus a new
explicit assertion (zero TS8017 diagnostics for an overloaded `node:fs` surface
imported from a `.js` file).

### Capability map — satisfiable vs deliberate-error

`node:fs` members, gated by `(wasi, allowFs)` target:
- **`readSync` / `writeSync`** — fd-based (Phase-0 ABI, `docs/architecture/node-fs-abi.md`):
  *satisfiable everywhere* (`wasi-fd` shim under `--target wasi`; the JS host's
  real `node:fs` otherwise). Faithful overloaded signatures injected.
- **Path-based family** (`openSync`, `readFileSync`, `writeFile`, `mkdirSync`,
  `statSync`, …) — needs a real filesystem: *satisfiable only with `--allow-fs`*
  (JS host); **unsatisfiable under standalone `--target wasi`** → the existing
  precise codegen error ("`openSync` … not available under `--target wasi` …
  no filesystem", #2631), not a silent link failure. The map records these as
  no-provider-under-wasi so the deliberate-error class is explicit and data-driven.

Adding `node:process` / `node:os` members later is a new entry in
`NODE_CAPABILITY_MAP` (data), not a checker code change.

### 3 fidelity gaps closed (vs `@types/node`)
1. **Collapsed overloads** — `readSync` now has its TWO real overloads (positional
   `(fd,buf,offset,length,position)` + options `(fd,buf,opts?)`); `writeSync` now
   has both the buffer overload AND the **string** overload
   (`writeSync(fd, string, position?, encoding?)`). Nonsensical mixes the old
   single signature accepted (e.g. options object followed by positional length)
   are now rejected.
2. **Buffer type widened** `Uint8Array` → `NodeJS.ArrayBufferView`
   (`= TypedArray | DataView`), so `DataView` and every TypedArray are accepted.
3. Signatures mirror `@types/node` (`ReadPosition = number | bigint`,
   `BufferEncoding` union) rather than approximating.

### Validation
- `npx tsc --noEmit` clean; new `tests/issue-2634-node-capability-map.test.ts`
  (10 tests) green; #2631 / #2603 / #2524 node-emulation suites green
  (the one pre-existing #1768 failure — a `process.stdout.write` codegen
  packed-type leak — is red on origin/main too, unrelated to this change).
- **Batch byte-neutrality (#1968 lesson):** 165 test262 files (eval-code/direct,
  global-code strict-mode/SyntaxError negatives, for/addition/assignment/map)
  compiled with `emulateNode: true` ON, branch vs origin/main — **165/165
  byte-identical, 0 different**. Non-`node:fs` programs see zero perturbation.
- **`runTest262File` status (#1968 lesson):** 210 files across eval-code/direct,
  eval-code/indirect, global-code, built-ins/eval, const, object expressions,
  branch vs origin/main — **0 status flips** (the eval child-compile /
  SyntaxError-detection class is untouched).

### Follow-ups
- Phase 3 (#2635) — async members, gated on #2632.
- A `node:process` / `node:os` capability tier is now a data extension of the map.
